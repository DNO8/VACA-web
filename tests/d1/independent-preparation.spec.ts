import { test, expect } from '@playwright/test';
import { Keypair } from '@stellar/stellar-sdk';
import { validateReceiptContext } from '../../src/lib/d1/receipt-context';
import { parsePreparationReceipt } from '../../src/lib/d1/preparation-receipt';

function fixture() {
  const [admin, donor, beneficiary, pool, issuer] = [11, 12, 13, 14, 15].map(n =>
    Keypair.fromRawEd25519Seed(Buffer.alloc(32, n)).publicKey());
  const id = '12345678-1234-1234-1234-123456789abc';
  const asset = { type: 'issued', code: 'uSd', issuer };
  const payment = { transaction_hash: 'cd'.repeat(32), operation_id: '9007199254740993', donor, pool, asset, amount: '10.0000000' };
  const context = { config: { network: 'TESTNET', pool_public_key: pool, namespace: id, donation_ttl_seconds: 300 },
    request_id: id, admin, incident_id: 'incident-not-uuid', beneficiary, amount: '1.0000000',
    payment: { ...payment, confirmedAt: 951868799 } };
  const receipt = { revision: 1, state: 'allocated', request_id: id, allocation: {
    reservation: { request_id: id, authorized_by: admin, state: 'reserved', reserved_at: '2000-02-29T23:59:59.001Z',
      request: { version: 1, incident_id: context.incident_id, donor, beneficiary, asset: { ...asset }, amount: context.amount, deadline: '2000-03-01T00:04:59Z' } },
    payment: { ...payment, asset: { ...asset } }, allocated_amount: context.amount, state: 'allocated', allocated_at: '2000-03-01T00:00:00.001Z' } };
  return { context, receipt };
}

test('old leap-day allocation keeps precision, external namespace and independent snapshots', () => {
  const { context, receipt } = fixture();
  const retained = validateReceiptContext(context);
  const parsed = parsePreparationReceipt(receipt, retained);
  expect(parsed).toEqual(receipt);
  expect(parsed.allocation.payment.operation_id).toBe('9007199254740993');
  context.config.namespace = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
  expect(parsePreparationReceipt(receipt, context)).toEqual(parsed);
  expect(retained.config.namespace).not.toBe(context.config.namespace);
  receipt.allocation.payment.asset.code = 'USD';
  expect(parsed.allocation.payment.asset).toEqual({ ...context.payment.asset });
  expect(Object.isFrozen(parsed.allocation.payment.asset)).toBe(true);
  expect(() => parsePreparationReceipt(receipt, context)).toThrow(/^d1_receipt_binding_mismatch$/);
  const fresh = fixture();
  fresh.receipt.request_id = '00'.repeat(36);
  expect(() => parsePreparationReceipt(fresh.receipt, fresh.context)).toThrow(/^d1_malformed_preparation_receipt$/);
});

test('null-prototype data is copied; nested arrays and hidden required fields fail without mutation', () => {
  const { context, receipt } = fixture();
  const request = receipt.allocation.reservation.request;
  Object.setPrototypeOf(request, null);
  expect(parsePreparationReceipt(receipt, context)).toEqual(receipt);
  for (const value of [[], Object.assign([], request), Object.create(request)]) {
    const raw = { ...receipt, allocation: { ...receipt.allocation, reservation: { ...receipt.allocation.reservation, request: value } } };
    const before = JSON.stringify({ raw, context });
    expect(() => parsePreparationReceipt(raw, context)).toThrow(/^d1_malformed_preparation_receipt$/);
    expect(JSON.stringify({ raw, context })).toBe(before);
  }
  Object.defineProperty(request, 'deadline', { enumerable: false });
  const before = Object.getOwnPropertyDescriptors(request);
  expect(() => parsePreparationReceipt(receipt, context)).toThrow(/^d1_malformed_preparation_receipt$/);
  expect(Object.getOwnPropertyDescriptors(request)).toEqual(before);
  let calls = 0;
  Object.defineProperty(context.payment.asset, 'type', { get() { calls++; return 'issued'; } });
  expect(() => validateReceiptContext(context)).toThrow(/^d1_invalid_receipt_context$/);
  expect(calls).toBe(0);
});

test('one-stroop ordering and calendar aliases fail closed with exact errors', () => {
  const { context, receipt } = fixture();
  context.amount = '900719925.4740993';
  context.payment.amount = '900719925.4740992';
  expect(() => validateReceiptContext(context)).toThrow(/^d1_invalid_receipt_context$/);
  context.payment.amount = context.amount;
  receipt.allocation.allocated_amount = receipt.allocation.payment.amount = receipt.allocation.reservation.request.amount = context.amount;
  expect(parsePreparationReceipt(receipt, context)).toEqual(receipt);
  for (const date of ['1900-02-29T00:00:00Z', '2000-03-01T00:04:59+00:00', '2000-03-01T00:04:59.000Z']) {
    receipt.allocation.reservation.request.deadline = date;
    const before = JSON.stringify({ context, receipt });
    expect(() => parsePreparationReceipt(receipt, context)).toThrow(/^d1_malformed_preparation_receipt$/);
    expect(JSON.stringify({ context, receipt })).toBe(before);
  }
});
