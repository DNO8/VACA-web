import {
  originalDeadline, receiptAccount, receiptAmount, receiptAssert, receiptAsset, receiptDate,
  receiptId, receiptRecord, receiptString, validateReceiptContext, type D1Asset,
} from './receipt-context';

type Identity = Readonly<{ requestId: string; transactionHash: string }>;
type ObservedEconomics = Identity & Readonly<{
  verification: 'persisted_sdk_observation'; donor: string; beneficiary: string;
  asset: D1Asset; amount: string; paymentTransactionHash: string; deadline: string;
}>;
export type IssuanceReceipt =
  | (Identity & Readonly<{ state: 'pending'; verification: 'unverified' }>)
  | (ObservedEconomics & Readonly<{ state: 'issuance_observed'; claimableBalanceId: string }>)
  | (ObservedEconomics & Readonly<{ state: 'issuance_failed_observed' }>);
export type ReconciliationReceipt = Identity & Readonly<
  | { state: 'reconciliation_progress'; stage: 'discovery' | 'transactions' }
  | { state: 'issuance_outcome_recorded'; outcome: 'success' | 'failed' }
>;
/** Local provenance metadata, never a field of the backend receipt. */
export type BoundReceipt<T> = Readonly<{
  receipt: T;
  transactionHashBinding: 'first_report' | 'retained_match';
}>;
const identityKeys = ['state', 'requestId', 'transactionHash'];
const observedKeys = [...identityKeys, 'verification', 'donor', 'beneficiary', 'asset', 'amount', 'paymentTransactionHash', 'deadline'];
const hashPattern = /^[0-9a-f]{64}$/;

function retained(expected: unknown, known: unknown) {
  const context = validateReceiptContext(expected);
  try {
    const transactionHash = known === undefined ? undefined : receiptString(known, hashPattern);
    return { context, transactionHash };
  } catch {
    throw new Error('d1_invalid_receipt_context');
  }
}
function identity(record: Record<string, unknown>): Identity {
  return { requestId: receiptId(record.requestId), transactionHash: receiptString(record.transactionHash, hashPattern) };
}
function bind<T extends Identity>(receipt: T, expected: ReturnType<typeof retained>): BoundReceipt<T> {
  if (receipt.requestId !== expected.context.request_id ||
      (expected.transactionHash !== undefined && receipt.transactionHash !== expected.transactionHash)) {
    throw new Error('d1_receipt_binding_mismatch');
  }
  return Object.freeze({ receipt: Object.freeze(receipt),
    transactionHashBinding: expected.transactionHash === undefined ? 'first_report' : 'retained_match' });
}

// Only success may carry availability. Copy required descriptors, never read the ignored value.
function successRecord(raw: unknown): Record<string, unknown> {
  const keys = [...observedKeys, 'claimableBalanceId'];
  receiptAssert(raw && typeof raw === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(raw)));
  const availability = Object.getOwnPropertyDescriptor(raw, 'availability');
  if (!availability) return receiptRecord(raw, keys);
  receiptAssert(availability.enumerable && Reflect.ownKeys(raw).length === keys.length + 1);
  const historical = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (descriptor) Object.defineProperty(historical, key, descriptor);
  }
  return receiptRecord(historical, keys);
}

/** Historical response binding only; no IO, current availability or retry/settlement inference. */
export function parseIssuanceReceipt(
  status: unknown, raw: unknown, expectedContext: unknown, knownTransactionHash?: unknown,
): BoundReceipt<IssuanceReceipt> {
  const expected = retained(expectedContext, knownTransactionHash);
  let receipt: IssuanceReceipt;
  try {
    receiptAssert(status === 200 || status === 202);
    if (status === 202) {
      const record = receiptRecord(raw, [...identityKeys, 'verification']);
      receiptAssert(record.state === 'pending' && record.verification === 'unverified');
      receipt = { ...identity(record), state: 'pending', verification: 'unverified' };
    } else {
      const state = raw && typeof raw === 'object' ? Object.getOwnPropertyDescriptor(raw, 'state')?.value : undefined;
      const record = state === 'issuance_observed' ? successRecord(raw) : receiptRecord(raw, observedKeys);
      receiptAssert(record.verification === 'persisted_sdk_observation');
      const economics: ObservedEconomics = {
        ...identity(record), verification: 'persisted_sdk_observation', donor: receiptAccount(record.donor),
        beneficiary: receiptAccount(record.beneficiary), asset: receiptAsset(record.asset), amount: receiptAmount(record.amount),
        paymentTransactionHash: receiptString(record.paymentTransactionHash, hashPattern), deadline: receiptDate(record.deadline, false),
      };
      if (record.state === 'issuance_observed') {
        receipt = { ...economics, state: 'issuance_observed', claimableBalanceId: receiptString(record.claimableBalanceId, /^00000000[0-9a-f]{64}$/) };
      } else {
        receiptAssert(record.state === 'issuance_failed_observed');
        receipt = { ...economics, state: 'issuance_failed_observed' };
      }
    }
  } catch {
    throw new Error('d1_malformed_issuance_receipt');
  }
  if (receipt.state !== 'pending') {
    const { context } = expected;
    const original = context.payment;
    const asset = receipt.asset;
    const sameAsset = asset.type === 'native' ? original.asset.type === 'native'
      : original.asset.type === 'issued' && asset.code === original.asset.code && asset.issuer === original.asset.issuer;
    if (receipt.donor !== original.donor || receipt.beneficiary !== context.beneficiary || !sameAsset ||
        receipt.amount !== context.amount || receipt.paymentTransactionHash !== original.transaction_hash ||
        receipt.deadline !== originalDeadline(original.confirmedAt)) throw new Error('d1_receipt_binding_mismatch');
  }
  return bind(receipt, expected);
}

/** Reconciliation has no economics: request/hash binding is not independent economic proof. */
export function parseReconciliationReceipt(
  status: unknown, raw: unknown, expectedContext: unknown, knownTransactionHash?: unknown,
): BoundReceipt<ReconciliationReceipt> {
  const expected = retained(expectedContext, knownTransactionHash);
  let receipt: ReconciliationReceipt;
  try {
    receiptAssert(status === 200 || status === 202);
    const record = receiptRecord(raw, [...identityKeys, status === 202 ? 'stage' : 'outcome']);
    const ids = identity(record);
    if (status === 202) {
      receiptAssert(record.state === 'reconciliation_progress' && (record.stage === 'discovery' || record.stage === 'transactions'));
      receipt = { ...ids, state: 'reconciliation_progress', stage: record.stage };
    } else {
      receiptAssert(record.state === 'issuance_outcome_recorded' && (record.outcome === 'success' || record.outcome === 'failed'));
      receipt = { ...ids, state: 'issuance_outcome_recorded', outcome: record.outcome };
    }
  } catch {
    throw new Error('d1_malformed_reconciliation_receipt');
  }
  return bind(receipt, expected);
}
