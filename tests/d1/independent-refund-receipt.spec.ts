import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { StrKey } from '@stellar/stellar-sdk';
import { parseRefundReceipt as parse } from '../../src/lib/d1/refund-receipt';

let clockCalls = 0;
function parseRefundReceipt(...args: Parameters<typeof parse>) {
  const now = Date.now;
  Date.now = () => { clockCalls++; throw new Error('unexpected clock'); };
  try { return parse(...args); } finally { Date.now = now; }
}

// S1-S3, S17: offline report consistency only, not execution authority.
const account = (byte: number) => StrKey.encodeEd25519PublicKey(Buffer.alloc(32, byte));
const id = '12345678-1234-1234-1234-123456789abc';
const otherId = '12345678-1234-1234-1234-123456789abd';
function fixture(version = 1, action = version === 1 ? 'refund_status' : 'refund_remainder_status') {
  const status = version === 1 ? 'refund_status' : 'refund_remainder_status';
  return {
    context: { version, action, network: 'TESTNET', namespace: id, pool: account(1), request_id: id },
    raw: {
      version, network: 'TESTNET', namespace: id, pool: account(1), requestId: id,
      state: 'unknown', verification: 'unverified', deadline: '+010000-01-01T00:00:00Z',
      donation: { paymentOperationId: '18446744073709551615', paymentTransactionHash: 'a'.repeat(64),
        donor: account(2), asset: { type: 'issued', code: 'XLM', issuer: account(3) }, grossAmount: '10.0000000' },
      refund: { transactionHash: 'b'.repeat(64), amount: '9.0000000', claimableBalanceId: null as string | null },
      settlement: { beneficiaryClaimedAmount: '1.0000000' as string | null,
        donorRefundedAmount: null as string | null, remainingPrincipalAmount: '9.0000000' as string | null },
      safeActions: [status, version === 1 ? 'refund_reconcile' : 'refund_remainder_reconcile'],
      reason: 'outcome_unresolved' as string | null,
    },
  };
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function reject(status: unknown, raw: unknown, context: unknown, message = 'd1_invalid_refund_receipt') {
  const before = digest([raw, context]);
  expect(() => parseRefundReceipt(status, raw, context)).toThrow(new Error(message));
  expect(digest([raw, context])).toBe(before);
}
function frozen(value: unknown) {
  if (value && typeof value === 'object') {
    expect(Object.isFrozen(value)).toBe(true);
    Object.values(value).forEach(frozen);
  }
}

test('S1-S3/S17 original identity and explicit lane cannot be replaced by safe actions', () => {
  const { raw, context } = fixture();
  for (const delta of [{ requestId: otherId }, { namespace: otherId }, { pool: account(4) }]) {
    reject(200, { ...raw, ...delta }, context, 'd1_refund_receipt_binding_mismatch');
  }
  reject(200, fixture(2).raw, context, 'd1_refund_receipt_binding_mismatch');
  for (const delta of [{ action: 'refund_remainder' }, { network: 'PUBLIC' }, { request_id: '' }, { timestamp: 0 }]) {
    reject(200, raw, { ...context, ...delta }, 'd1_invalid_refund_receipt_context');
  }
  reject(200, { ...raw, safeActions: [...raw.safeActions].reverse() }, context);
  reject(200, { ...raw, safeActions: ['refund_remainder_status', 'refund_remainder_reconcile'] }, context);
  reject(200, { ...raw, extra: true }, context);
  reject(200, null, context);
});

test('S17 unknown, null and terminal principal accounting remain distinct', () => {
  for (const version of [1, 2]) {
    const { raw, context } = fixture(version);
    const before = digest([raw, context]);
    const unknown = parseRefundReceipt(200, raw, context);
    expect(unknown).toEqual(raw); frozen(unknown);
    expect(digest([raw, context])).toBe(before);
    raw.refund.amount = '8.0000000';
    expect(unknown.refund?.amount).toBe('9.0000000');
    const settled = { ...raw, state: 'settled', verification: 'persisted_sdk_observation', reason: null,
      safeActions: [raw.safeActions[0]], refund: null,
      settlement: { beneficiaryClaimedAmount: '10.0000000', donorRefundedAmount: '0.0000000', remainingPrincipalAmount: '0.0000000' } };
    expect(parseRefundReceipt(200, settled, context)).toEqual(settled);
    for (const delta of [{ beneficiaryClaimedAmount: '1.0000000' }, { donorRefundedAmount: null }, { remainingPrincipalAmount: '0.0000001' }]) {
      reject(200, { ...settled, settlement: { ...settled.settlement, ...delta } }, context);
    }
    const balancedUnknown = { ...raw, settlement: settled.settlement };
    expect(parseRefundReceipt(200, balancedUnknown, context).state).toBe('unknown');
    for (const [state, verification, reason] of [
      ['pending', 'unverified', null], ['refund_observed', 'persisted_sdk_observation', null],
      ['refund_failed_observed', 'persisted_sdk_observation', 'refund_failed'],
    ]) reject(200, { ...raw, state, verification, reason, refund: null }, context);
    if (version === 2) reject(200, { ...raw, refund: { ...raw.refund, claimableBalanceId: '00000000' + 'c'.repeat(64) } }, context);
  }
});

test('S17 HTTP acceptance does not promote not_started or trigger IO/getters', () => {
  let calls = 0;
  const oldFetch = globalThis.fetch;
  globalThis.fetch = (() => { calls++; throw new Error('unexpected fetch'); }) as typeof fetch;
  try {
    for (const version of [1, 2]) {
      const execute = version === 1 ? 'refund' : 'refund_remainder';
      const { raw, context } = fixture(version, execute);
      const started = { ...raw, state: 'not_started', reason: null, safeActions: [execute, raw.safeActions[0]], refund: null };
      expect(parseRefundReceipt(200, started, context)).toEqual(started);
      reject(202, started, context);
      expect(parseRefundReceipt(202, raw, context).state).toBe('unknown');
      for (const code of [200, 409, 503, '202']) reject(code, raw, context);
      for (const reason of ['financial_precondition_unavailable', 'remainder_protected']) {
        const blocked = { ...raw, state: 'blocked', reason };
        expect(parseRefundReceipt(409, blocked, context).state).toBe('blocked');
        reject(200, blocked, context);
      }
      const hostile = { ...raw };
      Object.defineProperty(hostile, 'deadline', { enumerable: true, get() { calls++; throw new Error('getter'); } });
      const descriptors = Object.getOwnPropertyDescriptors(hostile);
      expect(() => parseRefundReceipt(202, hostile, context)).toThrow(new Error('d1_invalid_refund_receipt'));
      expect(Object.getOwnPropertyDescriptors(hostile)).toEqual(descriptors);
    }
    expect(calls).toBe(0); expect(clockCalls).toBe(0);
  } finally { globalThis.fetch = oldFetch; }
});

test('S17 canonical scalar boundaries retain full precision and SDK issued XLM', () => {
  const { raw, context } = fixture();
  raw.donation.grossAmount = '922337203685.4775807';
  expect(parseRefundReceipt(200, raw, context)).toEqual(raw);
  for (const paymentOperationId of ['0', '01', '18446744073709551616', '1\n']) {
    reject(200, { ...raw, donation: { ...raw.donation, paymentOperationId } }, context);
  }
  for (const grossAmount of ['0.0000000', '922337203685.4775808', '1.0', '-1.0000000', '01.0000000']) {
    reject(200, { ...raw, donation: { ...raw.donation, grossAmount } }, context);
  }
  for (const deadline of ['2026-02-30T00:00:00Z', '2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00+01:00', '']) {
    reject(200, { ...raw, deadline }, context);
  }
  reject(200, { ...raw, refund: { ...raw.refund, amount: '0.0000000' } }, context);
  reject(200, { ...raw, settlement: { ...raw.settlement, donorRefundedAmount: '-0.0000001' } }, context);
});
