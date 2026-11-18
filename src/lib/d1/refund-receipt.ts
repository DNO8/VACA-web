import { Asset } from '@stellar/stellar-sdk';
import type { RefundCommand } from './refund-commands';
import { receiptAssert, receiptRecord, receiptString, receiptAccount, receiptId, receiptStroops, type D1Asset } from './receipt-context';

type Correlation<T> = T extends RefundCommand
  ? Pick<T, 'version' | 'action' | 'network' | 'namespace' | 'pool' | 'request_id'> : never;
export type RefundReceiptContext = Correlation<RefundCommand>;
type RefundAction = RefundCommand['action'];
type Verification = 'unverified' | 'persisted_sdk_observation';
type Reason = null | 'deadline_not_reached' | 'financial_precondition_unavailable' | 'remainder_protected' | 'outcome_unresolved' | 'refund_failed';
type Refund = Readonly<{ transactionHash: string; amount: string; claimableBalanceId: string | null }>;
type CommonReceipt = Readonly<{
  network: 'TESTNET'; namespace: string; pool: string; requestId: string;
  state: RefundState; verification: Verification; deadline: string;
  donation: Readonly<{ paymentOperationId: string; paymentTransactionHash: string; donor: string; asset: D1Asset; grossAmount: string }>;
  settlement: Readonly<{ beneficiaryClaimedAmount: string | null; donorRefundedAmount: string | null; remainingPrincipalAmount: string | null }>;
  safeActions: readonly RefundAction[]; reason: Reason;
}>;
export type RefundReceipt = CommonReceipt & (
  Readonly<{ version: 1; refund: Refund | null }> |
  Readonly<{ version: 2; refund: (Omit<Refund, 'claimableBalanceId'> & { readonly claimableBalanceId: null }) | null }>
);
const lanes = {
  1: { status: 'refund_status', execute: 'refund', reconcile: 'refund_reconcile' },
  2: { status: 'refund_remainder_status', execute: 'refund_remainder', reconcile: 'refund_remainder_reconcile' },
} as const;
const rules = {
  not_due: { verification: 'unverified', reasons: ['deadline_not_reached'], actions: ['status'] },
  not_started: { verification: 'unverified', reasons: [null], actions: ['execute', 'status'] },
  blocked: { verification: 'unverified', reasons: ['financial_precondition_unavailable', 'remainder_protected'], actions: ['status', 'reconcile'] },
  pending: { verification: 'unverified', reasons: [null], actions: ['status', 'reconcile'] },
  unknown: { verification: 'unverified', reasons: ['outcome_unresolved'], actions: ['status', 'reconcile'] },
  refund_observed: { verification: 'persisted_sdk_observation', reasons: [null], actions: ['status', 'reconcile'] },
  refund_failed_observed: { verification: 'persisted_sdk_observation', reasons: ['refund_failed'], actions: ['status', 'reconcile'] },
  settled: { verification: 'persisted_sdk_observation', reasons: [null], actions: ['status'] },
} as const;
export type RefundState = keyof typeof rules;
const rootKeys = ['version', 'network', 'namespace', 'pool', 'requestId', 'state', 'verification', 'deadline', 'donation', 'refund', 'settlement', 'safeActions', 'reason'];
const hashPattern = /^[0-9a-f]{64}$/;
const maxStroops = BigInt('9223372036854775807');

function context(value: unknown): RefundReceiptContext {
  try {
    const c = receiptRecord(value, ['version', 'action', 'network', 'namespace', 'pool', 'request_id']);
    receiptAssert((c.version === 1 || c.version === 2) && c.network === 'TESTNET');
    receiptAssert(Object.values(lanes[c.version]).some(action => action === c.action));
    return Object.freeze({ version: c.version, action: c.action, network: c.network,
      namespace: receiptId(c.namespace), pool: receiptAccount(c.pool), request_id: receiptId(c.request_id) }) as RefundReceiptContext;
  } catch { throw new Error('d1_invalid_refund_receipt_context'); }
}
function money(value: unknown, positive: boolean): string {
  const result = receiptString(value, /^(0|[1-9][0-9]{0,11})\.[0-9]{7}$/);
  const stroops = receiptStroops(result);
  receiptAssert(stroops >= BigInt(positive ? 1 : 0) && stroops <= maxStroops);
  return result;
}
function nullableMoney(value: unknown): string | null {
  return value === null ? null : money(value, false);
}
function operationId(value: unknown): string {
  const id = receiptString(value, /^[1-9][0-9]{0,19}$/);
  receiptAssert(BigInt(id) <= BigInt('18446744073709551615'));
  return id;
}
function asset(value: unknown): D1Asset {
  const kind = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, 'type')?.value : undefined;
  const data = receiptRecord(value, kind === 'native' ? ['type'] : ['type', 'code', 'issuer']);
  if (data.type === 'native') return Object.freeze({ type: 'native' });
  receiptAssert(data.type === 'issued' && typeof data.code === 'string');
  const issuer = receiptAccount(data.issuer); const sdk = new Asset(data.code, issuer);
  receiptAssert(!sdk.isNative() && sdk.getCode() === data.code && sdk.getIssuer() === issuer);
  return Object.freeze({ type: 'issued', code: data.code, issuer });
}
function deadline(value: unknown): string {
  receiptAssert(typeof value === 'string');
  const date = new Date(value);
  receiptAssert(Number.isFinite(date.getTime()) && date.getTime() % 1000 === 0);
  receiptAssert(date.toISOString().replace('.000Z', 'Z') === value);
  return value;
}
function actions(value: unknown, expected: readonly RefundAction[]): readonly RefundAction[] {
  receiptAssert(Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype);
  receiptAssert(Object.getOwnPropertyDescriptor(value, 'length')?.value === expected.length && Reflect.ownKeys(value).length === expected.length + 1);
  expected.forEach((action, index) => {
    const field = Object.getOwnPropertyDescriptor(value, String(index));
    receiptAssert(field?.enumerable && 'value' in field && field.value === action);
  });
  return Object.freeze([...expected]);
}
function report(value: unknown): RefundReceipt {
  const r = receiptRecord(value, rootKeys);
  receiptAssert((r.version === 1 || r.version === 2) && r.network === 'TESTNET');
  receiptAssert(typeof r.state === 'string' && Object.prototype.hasOwnProperty.call(rules, r.state));
  const state = r.state as RefundState; const rule = rules[state];
  receiptAssert(r.verification === rule.verification && rule.reasons.some(reason => reason === r.reason));
  const d = receiptRecord(r.donation, ['paymentOperationId', 'paymentTransactionHash', 'donor', 'asset', 'grossAmount']);
  const donation = Object.freeze({ paymentOperationId: operationId(d.paymentOperationId),
    paymentTransactionHash: receiptString(d.paymentTransactionHash, hashPattern), donor: receiptAccount(d.donor),
    asset: asset(d.asset), grossAmount: money(d.grossAmount, true) });
  let refund: Refund | null = null;
  if (r.refund !== null) {
    const f = receiptRecord(r.refund, ['transactionHash', 'amount', 'claimableBalanceId']);
    const claimableBalanceId = f.claimableBalanceId === null ? null : receiptString(f.claimableBalanceId, /^00000000[0-9a-f]{64}$/);
    receiptAssert(r.version === 1 || claimableBalanceId === null);
    refund = Object.freeze({ transactionHash: receiptString(f.transactionHash, hashPattern), amount: money(f.amount, true), claimableBalanceId });
  }
  receiptAssert(!['pending', 'refund_observed', 'refund_failed_observed'].includes(state) || refund !== null);
  const s = receiptRecord(r.settlement, ['beneficiaryClaimedAmount', 'donorRefundedAmount', 'remainingPrincipalAmount']);
  const settlement = Object.freeze({ beneficiaryClaimedAmount: nullableMoney(s.beneficiaryClaimedAmount),
    donorRefundedAmount: nullableMoney(s.donorRefundedAmount), remainingPrincipalAmount: nullableMoney(s.remainingPrincipalAmount) });
  if (state === 'settled') {
    receiptAssert(settlement.beneficiaryClaimedAmount !== null && settlement.donorRefundedAmount !== null && settlement.remainingPrincipalAmount === '0.0000000');
    receiptAssert(receiptStroops(donation.grossAmount) === receiptStroops(settlement.beneficiaryClaimedAmount) + receiptStroops(settlement.donorRefundedAmount));
  }
  const safeActions = actions(r.safeActions, rule.actions.map(role => lanes[r.version as 1 | 2][role]));
  return Object.freeze({ version: r.version, network: r.network, namespace: receiptId(r.namespace), pool: receiptAccount(r.pool),
    requestId: receiptId(r.requestId), state, verification: rule.verification, deadline: deadline(r.deadline), donation, refund,
    settlement, safeActions, reason: r.reason as Reason }) as RefundReceipt;
}

/** Interpret a correlated backend report, never authorize execution or independently establish settlement. */
export function parseRefundReceipt(status: unknown, raw: unknown, expectedContext: unknown): RefundReceipt {
  const expected = context(expectedContext);
  let result: RefundReceipt;
  try { result = report(raw); }
  catch { throw new Error('d1_invalid_refund_receipt'); }
  if (result.version !== expected.version || result.network !== expected.network || result.namespace !== expected.namespace ||
    result.pool !== expected.pool || result.requestId !== expected.request_id) throw new Error('d1_refund_receipt_binding_mismatch');
  const lane = lanes[expected.version];
  const code = expected.action === lane.status ? 200 : ['pending', 'unknown'].includes(result.state) ? 202
    : expected.action === lane.execute && ['not_due', 'blocked'].includes(result.state) ? 409 : 200;
  if (status !== code) throw new Error('d1_invalid_refund_receipt');
  return result;
}
