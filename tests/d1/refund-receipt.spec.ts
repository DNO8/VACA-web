import { test, expect } from '@playwright/test';
import { Keypair } from '@stellar/stellar-sdk';
import { parseRefundReceipt } from '../../src/lib/d1/refund-receipt';

const pool = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 101)).publicKey();
const donor = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 102)).publicKey();
const id = '01234567-89ab-cdef-0123-456789abcdef';
const namespace = 'fedcba98-7654-3210-fedc-ba9876543210';
const lanes = {
  1: { status: 'refund_status', execute: 'refund', reconcile: 'refund_reconcile' },
  2: { status: 'refund_remainder_status', execute: 'refund_remainder', reconcile: 'refund_remainder_reconcile' },
} as const;
const states = ['not_due', 'not_started', 'blocked', 'pending', 'unknown', 'refund_observed', 'refund_failed_observed', 'settled'] as const;
type State = typeof states[number];
type Lane = 1 | 2;
type Role = keyof typeof lanes[1];
const context = (version: Lane = 1, role: Role = 'status') => ({ version, action: lanes[version][role], network: 'TESTNET', namespace, pool, request_id: id });
function receipt(version: Lane = 1, state: State = 'unknown') {
  const actions = lanes[version];
  return {
    version, network: 'TESTNET', namespace, pool, requestId: id, state,
    verification: ['refund_observed', 'refund_failed_observed', 'settled'].includes(state) ? 'persisted_sdk_observation' : 'unverified',
    deadline: '2026-11-01T12:05:00Z',
    donation: { paymentOperationId: '18446744073709551615', paymentTransactionHash: 'a'.repeat(64), donor, asset: { type: 'native' }, grossAmount: '10.0000000' },
    refund: ['pending', 'refund_observed', 'refund_failed_observed', 'settled'].includes(state)
      ? { transactionHash: 'b'.repeat(64), amount: version === 1 ? '10.0000000' : '9.0000000', claimableBalanceId: version === 1 ? '00000000' + 'c'.repeat(64) : null } : null,
    settlement: { beneficiaryClaimedAmount: state === 'settled' ? (version === 1 ? '0.0000000' : '1.0000000') : null,
      donorRefundedAmount: state === 'settled' ? (version === 1 ? '10.0000000' : '9.0000000') : null,
      remainingPrincipalAmount: state === 'settled' ? '0.0000000' : null },
    safeActions: state === 'not_started' ? [actions.execute, actions.status]
      : ['not_due', 'settled'].includes(state) ? [actions.status] : [actions.status, actions.reconcile],
    reason: state === 'not_due' ? 'deadline_not_reached' : state === 'blocked' ? 'financial_precondition_unavailable'
      : state === 'unknown' ? 'outcome_unresolved' : state === 'refund_failed_observed' ? 'refund_failed' : null,
  };
}
function frozen(value: unknown): void {
  if (value && typeof value === 'object') {
    expect(Object.isFrozen(value)).toBe(true);
    for (const child of Object.values(value)) frozen(child);
  }
}
const invalid = (body: unknown, expected: unknown = context(), status: unknown = 200) =>
  expect(() => parseRefundReceipt(status, body, expected)).toThrow(/^d1_invalid_refund_receipt$/);

for (const version of [1, 2] as const) for (const role of ['status', 'execute', 'reconcile'] as const) for (const state of states) {
  test(`retains ${version}/${role}/${state} with the exact backend HTTP mapping`, () => {
    const raw = receipt(version, state); const expected = context(version, role); const before = structuredClone(raw);
    const status = role === 'status' ? 200 : ['pending', 'unknown'].includes(state) ? 202
      : role === 'execute' && ['not_due', 'blocked'].includes(state) ? 409 : 200;
    const result = parseRefundReceipt(status, raw, expected);
    expect(result).toEqual(before); frozen(result);
    expect(raw).toEqual(before); expect(Object.isFrozen(raw)).toBe(false);
    raw.donation.grossAmount = '999.0000000'; raw.safeActions.length = 0;
    expect(result).toEqual(before);
    for (const wrongStatus of [200, 202, 409, 201, 400, 503, '200', NaN].filter(value => value !== status)) invalid(before, expected, wrongStatus);
  });
}

test('context is exact explicit correlation, never a signed command or a freshness check', () => {
  const raw = receipt();
  for (const bad of [{ ...context(), version: 3 }, { ...context(), action: 'refund-reconcile' },
    { ...context(), version: 2 }, { ...context(), network: 'PUBLIC' }, { ...context(), namespace: id + '\n' },
    { ...context(), pool: 'S'.repeat(56) }, { ...context(), request_id: 'incident-1' },
    { ...context(), timestamp: 1 }, { ...context(), wallet: donor }, { ...context(), signature: 'x' }]) {
    const before = JSON.stringify(bad);
    expect(() => parseRefundReceipt(200, raw, bad)).toThrow(/^d1_invalid_refund_receipt_context$/);
    expect(JSON.stringify(bad)).toBe(before);
  }
});

test('rejects well-formed foreign original UUID, namespace, pool and lane bindings', () => {
  for (const [raw, expected] of [[{ ...receipt(), requestId: namespace }, context()],
    [{ ...receipt(), namespace: id }, context()], [{ ...receipt(), pool: donor }, context()],
    [receipt(2), context()]] as const) {
    const before = JSON.stringify(raw);
    expect(() => parseRefundReceipt(200, raw, expected)).toThrow(/^d1_refund_receipt_binding_mismatch$/);
    expect(JSON.stringify(raw)).toBe(before);
  }
});

test('rejects missing, extra, hidden and symbol fields without invoking accessors', () => {
  const good = receipt(); const missing = { ...good } as Record<string, unknown>; delete missing.reason;
  let reads = 0;
  const getter = Object.defineProperty({ ...good }, 'deadline', { enumerable: true, get() { reads++; return good.deadline; } });
  const nested = { ...good, donation: Object.defineProperty({ ...good.donation }, 'donor', { enumerable: true, get() { reads++; return donor; } }) };
  const hidden = Object.defineProperty({ ...good }, 'private', { value: true });
  for (const bad of [null, [], missing, { ...good, extra: true }, getter, nested, hidden, { ...good, [Symbol('private')]: true },
    { ...good, donation: null }, { ...good, donation: { ...good.donation, donor: null } }, { ...good, settlement: null },
    { ...good, donation: { ...good.donation, extra: true } }, { ...good, settlement: { ...good.settlement, extra: true } }]) invalid(bad);
  const ctx = Object.defineProperty({ ...context() }, 'pool', { enumerable: true, get() { reads++; return pool; } });
  expect(() => parseRefundReceipt(200, good, ctx)).toThrow(/^d1_invalid_refund_receipt_context$/);
  expect(reads).toBe(0);
});

test('retains mixed known/null settlement and never infers settled from arithmetic', () => {
  for (const settlement of [{ beneficiaryClaimedAmount: '1.0000000', donorRefundedAmount: null, remainingPrincipalAmount: null },
    { beneficiaryClaimedAmount: null, donorRefundedAmount: '0.0000000', remainingPrincipalAmount: null },
    { beneficiaryClaimedAmount: '1.0000000', donorRefundedAmount: '9.0000000', remainingPrincipalAmount: '0.0000000' }]) {
    const raw = { ...receipt(2), settlement };
    expect(parseRefundReceipt(200, raw, context(2))).toEqual(raw);
  }
});

test('only a bound settled report with complete gross accounting is retained as settled', () => {
  for (const version of [1, 2] as const) {
    const raw = receipt(version, 'settled');
    for (const patch of [{ beneficiaryClaimedAmount: null }, { donorRefundedAmount: null }, { remainingPrincipalAmount: null },
      { beneficiaryClaimedAmount: '1.0000000', donorRefundedAmount: '0.0000000' }, { remainingPrincipalAmount: '1.0000000' },
      { beneficiaryClaimedAmount: '10.0000000', donorRefundedAmount: '1.0000000' }]) {
      invalid({ ...raw, settlement: { ...raw.settlement, ...patch } }, context(version));
    }
    const beneficiarySettled = { ...raw, refund: null, settlement: { beneficiaryClaimedAmount: '10.0000000', donorRefundedAmount: '0.0000000', remainingPrincipalAmount: '0.0000000' } };
    expect(parseRefundReceipt(200, beneficiarySettled, context(version))).toEqual(beneficiarySettled);
  }
});

test('money is canonical seven-decimal int64, positive principal versus known zero or null', () => {
  const raw = receipt();
  for (const amount of ['0.0000001', '922337203685.4775807']) {
    const value = { ...raw, donation: { ...raw.donation, grossAmount: amount } };
    expect(parseRefundReceipt(200, value, context())).toEqual(value);
  }
  for (const amount of ['0.0000000', '922337203685.4775808', '01.0000000', '1', '1.0', '-1.0000000', '1e0', '1.0000000\n', 1, null]) {
    invalid({ ...raw, donation: { ...raw.donation, grossAmount: amount } });
  }
  for (const amount of ['-0.0000001', '922337203685.4775808', '00.0000000', undefined, 0]) {
    invalid({ ...raw, settlement: { ...raw.settlement, donorRefundedAmount: amount } });
  }
  for (const amount of ['0.0000000', '922337203685.4775808', 9, null]) {
    const value = receipt(2, 'refund_observed'); invalid({ ...value, refund: { ...value.refund, amount } }, context(2));
  }
});

test('operation IDs retain all uint64 digits and hashes/CBIDs obey exact lane grammar', () => {
  const raw = receipt();
  for (const paymentOperationId of ['1', '18446744073709551615']) {
    const value = { ...raw, donation: { ...raw.donation, paymentOperationId } };
    expect(parseRefundReceipt(200, value, context())).toEqual(value);
  }
  for (const paymentOperationId of ['0', '01', '18446744073709551616', '1\n', 1]) invalid({ ...raw, donation: { ...raw.donation, paymentOperationId } });
  for (const hash of ['A'.repeat(64), 'a'.repeat(63), 'a'.repeat(64) + '\n', null]) {
    invalid({ ...raw, donation: { ...raw.donation, paymentTransactionHash: hash } });
    const observed = receipt(1, 'refund_observed'); invalid({ ...observed, refund: { ...observed.refund, transactionHash: hash } });
  }
  for (const claimableBalanceId of ['f'.repeat(72), '00000000' + 'C'.repeat(64), '00000000' + 'c'.repeat(63), 0]) {
    const observed = receipt(1, 'refund_observed'); invalid({ ...observed, refund: { ...observed.refund, claimableBalanceId } });
  }
  const v2 = receipt(2, 'refund_observed'); invalid({ ...v2, refund: { ...v2.refund, claimableBalanceId: '00000000' + 'c'.repeat(64) } }, context(2));
});

test('assets are exact SDK identities without case conversion or native/issued conflation', () => {
  const raw = receipt();
  for (const code of ['UsDc', 'XLM', 'ABCDEFGHIJKL']) {
    const value = { ...raw, donation: { ...raw.donation, asset: { type: 'issued', code, issuer: pool } } };
    expect(parseRefundReceipt(200, value, context())).toEqual(value);
  }
  for (const asset of [{ type: 'native', issuer: pool }, { type: 'issued', code: '', issuer: pool },
    { type: 'issued', code: 'USD!', issuer: pool }, { type: 'issued', code: 'ABCDEFGHIJKLM', issuer: pool },
    { type: 'issued', code: 'USD', issuer: 'S'.repeat(56) }, { type: 'issued', code: 'USD', issuer: pool, extra: true }, null]) invalid({ ...raw, donation: { ...raw.donation, asset } });
});

test('deadline is preserved canonical whole-second UTC, including expanded-year producer edge', () => {
  for (const deadline of ['2026-11-01T12:05:00Z', '+010000-01-01T00:00:00Z']) {
    const raw = { ...receipt(), deadline }; expect(parseRefundReceipt(200, raw, context())).toEqual(raw);
  }
  for (const deadline of ['2026-11-01T12:05:00.000Z', '2026-11-01T12:05:00+00:00', '2026-02-30T12:05:00Z',
    '2026-11-01t12:05:00z', '2026-11-01T12:05:00Z\n', '2026-11-01T12:05:00.001Z', '', null, 0]) invalid({ ...receipt(), deadline });
});

test('state, reason, verification and ordered safeActions must agree without authorizing execution', () => {
  for (const version of [1, 2] as const) {
    const raw = receipt(version, 'blocked');
    for (const reason of ['financial_precondition_unavailable', 'remainder_protected']) {
      const value = { ...raw, reason }; expect(parseRefundReceipt(200, value, context(version))).toEqual(value);
    }
    for (const patch of [{ reason: null }, { verification: 'persisted_sdk_observation' }, { state: 'success' },
      { safeActions: [...raw.safeActions].reverse() }, { safeActions: [lanes[version].execute] },
      { safeActions: [lanes[version === 1 ? 2 : 1].status, lanes[version === 1 ? 2 : 1].reconcile] }]) invalid({ ...raw, ...patch }, context(version));
    for (const state of ['pending', 'refund_observed', 'refund_failed_observed'] as const) invalid({ ...receipt(version, state), refund: null }, context(version));
    const unknownWithRefund = { ...receipt(version), refund: receipt(version, 'refund_observed').refund };
    expect(parseRefundReceipt(200, unknownWithRefund, context(version))).toEqual(unknownWithRefund);
  }
});

test('safeActions must be a plain dense data array; accessors never run', () => {
  let reads = 0; const raw = receipt(); const getter = [...raw.safeActions];
  Object.defineProperty(getter, '0', { enumerable: true, get() { reads++; return raw.safeActions[0]; } });
  for (const safeActions of [getter, new Array(2), Object.assign([...raw.safeActions], { extra: true }),
    Object.assign([...raw.safeActions], { [Symbol('extra')]: true }), [...raw.safeActions, raw.safeActions[0]], 'refund_status']) invalid({ ...raw, safeActions });
  expect(reads).toBe(0);
});

test('parsing never reads current time, fetches, renews a command or promotes HTTP200 to success', () => {
  const oldFetch = globalThis.fetch; const oldNow = Date.now; let calls = 0;
  const raw = receipt(2, 'not_started'); const expected = context(2, 'execute'); const before = structuredClone(expected);
  let result: unknown;
  globalThis.fetch = async () => { calls++; throw new Error('network forbidden'); };
  Date.now = () => { calls++; throw new Error('clock forbidden'); };
  try { result = parseRefundReceipt(200, raw, expected); }
  finally { globalThis.fetch = oldFetch; Date.now = oldNow; }
  expect(result).toEqual(raw); expect(expected).toEqual(before); expect(calls).toBe(0);
});
