import { test, expect } from '@playwright/test';
import { Keypair } from '@stellar/stellar-sdk';
import { validateReceiptContext } from '../../src/lib/d1/receipt-context';
import { parsePreparationReceipt } from '../../src/lib/d1/preparation-receipt';

// Deterministic public fixtures only; no funds or network calls.
const [admin, donor, beneficiary, pool, issuer] = [1, 2, 3, 4, 5].map(seed =>
  Keypair.fromRawEd25519Seed(Buffer.alloc(32, seed)).publicKey());
const id = 'abcdef01-2345-6789-abcd-0123456789ab';
const otherId = '00000000-0000-0000-0000-000000000000';
const issued = { type: 'issued', code: 'USD', issuer };
function fixture(asset: { type: string; code?: string; issuer?: string } = { type: 'native' }) {
  const payment = { transaction_hash: 'ab'.repeat(32), operation_id: '9999999999999999999', donor, pool, asset, amount: '10.0000000' };
  const context = {
    config: { network: 'TESTNET', pool_public_key: pool, namespace: otherId, donation_ttl_seconds: 300 },
    request_id: id, admin, incident_id: 'incident: not a UUID', beneficiary, amount: '1.0000000',
    payment: { ...payment, confirmedAt: 1700000000 },
  };
  const receipt = {
    revision: 1, state: 'allocated', request_id: id,
    allocation: {
      reservation: {
        request_id: id, authorized_by: admin, state: 'reserved', reserved_at: '2023-11-14T22:13:21.123Z',
        request: { version: 1, incident_id: context.incident_id, donor, beneficiary, asset: { ...asset }, amount: context.amount, deadline: '2023-11-14T22:18:20Z' },
      },
      payment: { ...payment, asset: { ...asset } }, allocated_amount: context.amount, state: 'allocated', allocated_at: '2023-11-14T22:13:22.456Z',
    },
  };
  return { context, receipt };
}
function immutableCopy(actual: unknown, original: unknown) {
  expect(actual).toEqual(original);
  if (actual && typeof actual === 'object') {
    expect(actual).not.toBe(original);
    expect(Object.isFrozen(actual)).toBe(true);
    for (const key of Object.keys(actual)) immutableCopy(Reflect.get(actual, key), Reflect.get(original as object, key));
  }
}
function rejects(receipt: unknown, context: unknown, error: string) {
  const beforeReceipt = Object.getOwnPropertyDescriptors(receipt as object);
  const beforeContext = JSON.stringify(context);
  expect(() => parsePreparationReceipt(receipt, context)).toThrow(new RegExp(`^${error}$`));
  expect(Object.getOwnPropertyDescriptors(receipt as object)).toEqual(beforeReceipt);
  expect(JSON.stringify(context)).toBe(beforeContext);
}

for (const asset of [{ type: 'native' }, issued]) {
  test(`${asset.type}: retains original identity and accepts 10 -> 1 without settlement inference`, () => {
    const { context, receipt } = fixture(asset);
    const before = JSON.stringify({ context, receipt });
    const retained = validateReceiptContext(context);
    const parsed = parsePreparationReceipt(receipt, retained);
    immutableCopy(retained, context);
    immutableCopy(parsed, receipt);
    expect(JSON.stringify({ context, receipt })).toBe(before);
    expect(Object.isFrozen(context.payment.asset)).toBe(false);
    context.payment.asset = { type: 'changed' };
    receipt.allocation.reservation.request.amount = '2.0000000';
    expect(retained.payment.asset.type).toBe(asset === issued ? 'issued' : 'native');
    expect(parsed.allocation.allocated_amount).toBe('1.0000000');
  });
}

test('rejects every original binding family independently without changing inputs', () => {
  const changes: [string, unknown][] = [
    ['request_id', otherId], ['allocation.reservation.request_id', otherId],
    ['allocation.reservation.authorized_by', donor], ['allocation.reservation.request.incident_id', 'other'],
    ['allocation.reservation.request.beneficiary', admin], ['allocation.reservation.request.donor', admin],
    ['allocation.reservation.request.asset', issued], ['allocation.reservation.request.amount', '2.0000000'],
    ['allocation.payment.transaction_hash', 'cd'.repeat(32)], ['allocation.payment.operation_id', '1'],
    ['allocation.payment.donor', admin], ['allocation.payment.pool', donor], ['allocation.payment.asset', issued],
    ['allocation.payment.amount', '11.0000000'], ['allocation.allocated_amount', '2.0000000'],
    ['allocation.reservation.request.deadline', '2023-11-14T22:18:21Z'],
  ];
  for (const [path, value] of changes) {
    const { context, receipt } = fixture();
    const keys = path.split('.');
    const target = keys.slice(0, -1).reduce((object, key) => Reflect.get(object, key), receipt as object);
    Reflect.set(target, keys[keys.length - 1], value);
    const before = JSON.stringify(receipt);
    rejects(receipt, context, 'd1_receipt_binding_mismatch');
    expect(JSON.stringify(receipt)).toBe(before);
  }
  for (const asset of [{ ...issued, code: 'EUR' }, { ...issued, issuer: donor }]) {
    const { context, receipt } = fixture(issued);
    receipt.allocation.payment.asset = asset;
    rejects(receipt, context, 'd1_receipt_binding_mismatch');
  }
});

test('validates retained config, UUID, original accounts and payment fields', () => {
  const { context, receipt } = fixture();
  for (const change of [{ request_id: context.incident_id }, { request_id: 'ab'.repeat(36) }, { admin: 'G'.repeat(56) },
    { beneficiary: 1 }, { incident_id: ' x' }, { incident_id: 'x\n' }, { incident_id: 'x'.repeat(257) },
    { config: { ...context.config, network: 'PUBLIC' } }, { config: { ...context.config, namespace: 'id' } },
    { config: { ...context.config, donation_ttl_seconds: 301 } }, { extra: true }]) {
    const invalid = { ...context, ...change };
    expect(() => validateReceiptContext(invalid)).toThrow(/^d1_invalid_receipt_context$/);
    rejects(receipt, invalid, 'd1_invalid_receipt_context');
  }
  for (const change of [{ pool: donor }, { donor: 'bad' }, { transaction_hash: 'AB'.repeat(32) },
    { operation_id: '01' }, { operation_id: '1'.repeat(20) }, { operation_id: 1 }]) {
    expect(() => validateReceiptContext({ ...context, payment: { ...context.payment, ...change } })).toThrow(/^d1_invalid_receipt_context$/);
  }
});

test('uses positive canonical amounts and exact BigInt ordering through the 12-digit limit', () => {
  for (const amount of ['0.0000001', '999999999999.9999999']) {
    const { context, receipt } = fixture();
    context.amount = context.payment.amount = amount;
    receipt.allocation.allocated_amount = receipt.allocation.reservation.request.amount = receipt.allocation.payment.amount = amount;
    expect(parsePreparationReceipt(receipt, context)).toEqual(receipt);
  }
  for (const amount of ['0.0000000', '-1.0000000', '01.0000000', '1', '1.000000', '1.00000000', '1e2', '1.0000000\n', '1000000000000.0000000', 1]) {
    const { context, receipt } = fixture();
    expect(() => validateReceiptContext({ ...context, amount })).toThrow(/^d1_invalid_receipt_context$/);
    expect(() => validateReceiptContext({ ...context, payment: { ...context.payment, amount } })).toThrow(/^d1_invalid_receipt_context$/);
    for (const target of [receipt.allocation, receipt.allocation.reservation.request, receipt.allocation.payment]) {
      const key = target === receipt.allocation ? 'allocated_amount' : 'amount';
      const original = Reflect.get(target, key);
      Reflect.set(target, key, amount);
      rejects(receipt, context, 'd1_malformed_preparation_receipt');
      Reflect.set(target, key, original);
    }
  }
  const { context, receipt } = fixture();
  context.amount = '999999999999.9999999';
  context.payment.amount = '999999999999.9999998';
  expect(() => validateReceiptContext(context)).toThrow(/^d1_invalid_receipt_context$/);
  const valid = fixture().context;
  receipt.allocation.allocated_amount = receipt.allocation.reservation.request.amount = '11.0000000';
  rejects(receipt, valid, 'd1_receipt_binding_mismatch');
});

test('requires original epoch seconds and never renews the deadline', () => {
  const { context, receipt } = fixture();
  for (const confirmedAt of [-62167219201, 1.5, NaN, Infinity, '1700000000', Number.MAX_SAFE_INTEGER, 253402300500]) {
    expect(() => validateReceiptContext({ ...context, payment: { ...context.payment, confirmedAt } })).toThrow(/^d1_invalid_receipt_context$/);
  }
  for (const confirmedAt of [-62167219200, -1, 0, 951782400, 253402300499]) {
    const fresh = fixture();
    fresh.context.payment.confirmedAt = confirmedAt;
    fresh.receipt.allocation.reservation.request.deadline = new Date((confirmedAt + 300) * 1000).toISOString().replace('.000Z', 'Z');
    expect(parsePreparationReceipt(fresh.receipt, fresh.context)).toEqual(fresh.receipt);
  }
  receipt.allocation.reservation.request.deadline = '2023-11-14T22:23:20Z';
  rejects(receipt, context, 'd1_receipt_binding_mismatch');
});

test('rejects impossible calendar dates and noncanonical precision/timezones', () => {
  for (const value of ['2023-02-29T00:00:00', '2024-02-30T00:00:00', '2023-04-31T00:00:00', '2023-11-14T24:00:00', '2023-11-14T22:13:60']) {
    const { context, receipt } = fixture();
    receipt.allocation.reservation.request.deadline = value + 'Z';
    rejects(receipt, context, 'd1_malformed_preparation_receipt');
    receipt.allocation.reservation.request.deadline = fixture().receipt.allocation.reservation.request.deadline;
    for (const target of [receipt.allocation, receipt.allocation.reservation]) {
      const key = target === receipt.allocation ? 'allocated_at' : 'reserved_at';
      const original = Reflect.get(target, key);
      Reflect.set(target, key, value + '.000Z');
      rejects(receipt, context, 'd1_malformed_preparation_receipt');
      Reflect.set(target, key, original);
    }
  }
  for (const value of ['2023-11-14T22:18:20.000Z', '2023-11-14T22:18:20+00:00', '2023-11-14T22:18:20Z\n']) {
    const { context, receipt } = fixture();
    receipt.allocation.reservation.request.deadline = value;
    rejects(receipt, context, 'd1_malformed_preparation_receipt');
  }
});

test('rejects malformed asset unions and primitive receipt identities', () => {
  for (const asset of [{ type: 'native', code: 'XLM' }, { type: 'issued', code: '', issuer },
    { type: 'issued', code: 'a'.repeat(13), issuer }, { type: 'issued', code: 'é', issuer },
    { type: 'issued', code: 'USD\n', issuer }, { type: 'issued', code: 'USD', issuer: donor.toLowerCase() }]) {
    const { context, receipt } = fixture(asset);
    expect(() => validateReceiptContext(context)).toThrow(/^d1_invalid_receipt_context$/);
    rejects(receipt, fixture().context, 'd1_malformed_preparation_receipt');
  }
  for (const code of ['A', 'a1B2c3D4e5F6']) expect(validateReceiptContext(fixture({ ...issued, code }).context)).toBeTruthy();
  const { context, receipt } = fixture();
  for (const change of [{ revision: 2 }, { state: 'pending' }, { request_id: id.toUpperCase() }]) {
    rejects({ ...receipt, ...change }, context, 'd1_malformed_preparation_receipt');
  }
});

test('all nested objects reject unknown, hidden, symbol and accessor fields without invoking getters', () => {
  const { context, receipt } = fixture(issued);
  const contextObjects: object[] = [context, context.config, context.payment, context.payment.asset];
  const objects = [...contextObjects, receipt, receipt.allocation, receipt.allocation.reservation,
    receipt.allocation.reservation.request, receipt.allocation.reservation.request.asset,
    receipt.allocation.payment, receipt.allocation.payment.asset];
  for (const object of objects) {
    for (const kind of ['extra', 'hidden', 'symbol', 'accessor']) {
      const key = kind === 'symbol' ? Symbol('extra') : kind === 'accessor' ? Object.keys(object)[0] : kind;
      const previous = Object.getOwnPropertyDescriptor(object, key);
      let calls = 0;
      Object.defineProperty(object, key, kind === 'accessor'
        ? { configurable: true, enumerable: true, get: () => { calls++; return 'unexpected'; } }
        : { configurable: true, enumerable: kind !== 'hidden', value: true });
      const error = contextObjects.includes(object) ? 'd1_invalid_receipt_context' : 'd1_malformed_preparation_receipt';
      const before = Object.getOwnPropertyDescriptors(object);
      expect(() => parsePreparationReceipt(receipt, context)).toThrow(new RegExp(`^${error}$`));
      expect(Object.getOwnPropertyDescriptors(object)).toEqual(before);
      expect(calls).toBe(0);
      expect(Object.isFrozen(object)).toBe(false);
      if (previous) Object.defineProperty(object, key, previous);
      else Reflect.deleteProperty(object, key);
    }
  }
  for (const object of objects) {
    const key = Object.keys(object)[0];
    const descriptor = Object.getOwnPropertyDescriptor(object, key)!;
    Reflect.deleteProperty(object, key);
    expect(() => parsePreparationReceipt(receipt, context)).toThrow();
    Object.defineProperty(object, key, descriptor);
  }
  for (const value of [null, [], 'receipt', Object.create({ inherited: true })]) {
    expect(() => validateReceiptContext(value)).toThrow(/^d1_invalid_receipt_context$/);
    expect(() => parsePreparationReceipt(value, context)).toThrow(/^d1_malformed_preparation_receipt$/);
  }
});
