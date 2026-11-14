import { test, expect } from '@playwright/test';
import { Keypair } from '@stellar/stellar-sdk';
import { parseIssuanceReceipt as issue, parseReconciliationReceipt as reconcile } from '../../src/lib/d1/issuance-receipt';
const [admin, donor, beneficiary, pool] = [11, 12, 13, 14].map(n => Keypair.fromRawEd25519Seed(Buffer.alloc(32, n)).publicKey());
const id = '12345678-1234-1234-1234-123456789abc', hash = '12'.repeat(32);
const context = () => ({ config: { network: 'TESTNET', pool_public_key: pool, namespace: id, donation_ttl_seconds: 300 },
  request_id: id, admin, incident_id: 'independent', beneficiary, amount: '1.0000000',
  payment: { transaction_hash: '34'.repeat(32), operation_id: '1', donor, pool,
    asset: { type: 'native' }, amount: '10.0000000', confirmedAt: 1700000000 } });
const observed = () => ({ state: 'issuance_observed', verification: 'persisted_sdk_observation', requestId: id,
  transactionHash: hash, donor, beneficiary, asset: { type: 'native' }, amount: '1.0000000',
  paymentTransactionHash: '34'.repeat(32), deadline: '2023-11-14T22:18:20Z', claimableBalanceId: '00000000' + '56'.repeat(32) });

test('independent: context then shape then binding precedence on mixed defects', () => {
  for (const [parse, raw, malformed] of [
    [issue, observed(), 'd1_malformed_issuance_receipt'],
    [reconcile, { state: 'issuance_outcome_recorded', requestId: id, transactionHash: hash, outcome: 'success' }, 'd1_malformed_reconciliation_receipt'],
  ] as const) {
    const bad = { ...raw, requestId: '00000000-0000-0000-0000-000000000000', extra: true };
    const c = context(), before = JSON.stringify([bad, c]);
    expect(() => parse(200, bad, null, hash)).toThrow(/^d1_invalid_receipt_context$/);
    expect(() => parse(200, bad, c, null)).toThrow(/^d1_invalid_receipt_context$/);
    expect(() => parse(200, bad, c, '78'.repeat(32))).toThrow(new RegExp('^' + malformed + '$'));
    expect(() => parse(200, { ...raw, requestId: bad.requestId }, c, hash)).toThrow(/^d1_receipt_binding_mismatch$/);
    expect(JSON.stringify([bad, c])).toBe(before);
  }
});

test('independent: opaque availability descendants stay untouched, output owns frozen economics', () => {
  let touches = 0;
  const opaque = new Proxy({}, { get() { touches++; throw Error('get'); }, ownKeys() { touches++; throw Error('keys'); },
    getOwnPropertyDescriptor() { touches++; throw Error('descriptor'); }, getPrototypeOf() { touches++; throw Error('prototype'); } });
  const raw = Object.assign(Object.create(null), observed(), { availability: opaque });
  Object.freeze(raw.asset); Object.freeze(raw);
  const c = context(), before = JSON.stringify(c);
  const result = issue(200, raw, c);
  expect(touches).toBe(0); expect(Reflect.ownKeys(result.receipt)).not.toContain('availability');
  expect(result.transactionHashBinding).toBe('first_report');
  expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.receipt)).toBe(true);
  if (result.receipt.state === 'pending') throw Error('unexpected pending');
  expect(Object.isFrozen(result.receipt.asset)).toBe(true); expect(result.receipt.asset).not.toBe(raw.asset);
  expect(result.receipt.amount).toBe('1.0000000'); expect(JSON.stringify(c)).toBe(before);
  expect(issue(200, raw, c, hash).transactionHashBinding).toBe('retained_match');
});

test('independent: reconciliation cannot supply economics; issue retains exact original deadline', () => {
  const c = context(), raw = observed(), before = JSON.stringify([c, raw]);
  for (const delta of [-1, 1, 300]) {
    const deadline = new Date((c.payment.confirmedAt + 300 + delta) * 1000).toISOString().replace('.000Z', 'Z');
    expect(() => issue(200, { ...raw, deadline }, c)).toThrow(/^d1_receipt_binding_mismatch$/);
  }
  for (const amount of ['10.0000000', '0.9999999'])
    expect(() => issue(200, { ...raw, amount }, c)).toThrow(/^d1_receipt_binding_mismatch$/);
  const progress = { state: 'reconciliation_progress', requestId: id, transactionHash: hash, stage: 'transactions' };
  expect(reconcile(202, progress, c, hash).receipt).toEqual(progress);
  for (const extra of [{ amount: c.amount }, { paymentTransactionHash: c.payment.transaction_hash }, { availability: null }])
    expect(() => reconcile(202, { ...progress, ...extra }, c, hash)).toThrow(/^d1_malformed_reconciliation_receipt$/);
  expect(JSON.stringify([c, raw])).toBe(before);
});
