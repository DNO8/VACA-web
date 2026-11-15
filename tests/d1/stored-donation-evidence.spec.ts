import { test, expect } from '@playwright/test';
import { Keypair, Networks, Transaction, xdr } from '@stellar/stellar-sdk';
import { parseDonationEvidence } from '../../src/lib/d1/donation-evidence';
import { buildDonationTransaction, validateSignedDonation } from '../../src/lib/d1/donation-transaction';
import { originalDeadline } from '../../src/lib/d1/receipt-context';
import { validateStoredDonationEvidence } from '../../src/lib/d1/stored-donation-evidence';

// Synthetic public fixtures only: no wallet, IO, clock, journal or observer.
const donor = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1));
const pool = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 2));
const id = 'abcdef01-2345-6789-abcd-0123456789ab';
const otherId = 'abcdef01-2345-6789-abcd-0123456789ac';
const closed_at = '2023-11-14T22:13:25Z';
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function original(code?: string) {
  const built = buildDonationTransaction({
    config: { network: 'TESTNET', pool_public_key: pool.publicKey(), namespace: id, donation_ttl_seconds: 300 },
    request_id: id, donor: donor.publicKey(), incident_id: 'original incident',
    asset: code ? { type: 'issued', code, issuer: pool.publicKey() } : { type: 'native' }, amount: '12.0000001',
  }, { sequence: '9007199254740993', fee: '100', timebounds: { minTime: 1700000000, maxTime: 1700000060 } });
  const tx = new Transaction(built.unsignedXdr, Networks.TESTNET); tx.sign(donor);
  const snapshot = validateSignedDonation(built, { signedTxXdr: tx.toXDR() + '\n', signerAddress: donor.publicKey() });
  const result = new xdr.TransactionResult({ feeCharged: xdr.Int64.fromString('100'),
    result: xdr.TransactionResultResult.txSuccess([
      xdr.OperationResult.opInner(xdr.OperationResultTr.payment(xdr.PaymentResult.paymentSuccess())),
    ]), ext: xdr.TransactionResultExt.fromXDR('00000000', 'hex') }).toXDR('base64');
  const transaction = { hash: built.transactionHash, successful: true, operation_count: 1,
    source_account: donor.publicKey(), source_account_sequence: tx.sequence, ledger: 42,
    envelope_xdr: tx.toXDR(), result_xdr: result, created_at: closed_at };
  const operations = { _embedded: { records: [{ type: 'payment', type_i: 1, transaction_successful: true,
    transaction_hash: built.transactionHash, id: '9007199254740993', source_account: donor.publicKey(),
    from: donor.publicKey(), to: pool.publicKey(), amount: '12.0000001', created_at: closed_at,
    ...(code ? { asset_type: code.length <= 4 ? 'credit_alphanum4' : 'credit_alphanum12',
      asset_code: code, asset_issuer: pool.publicKey() } : { asset_type: 'native' }) }] } };
  const ledger = { sequence: 42, hash: 'ab'.repeat(32), closed_at };
  return { snapshot, transaction, operations, ledger };
}
const originals = [original(), original('USDC'), original('LONGASSET123')];
const cached = originals.map(f => ({ snapshot: f.snapshot,
  evidence: parseDonationEvidence(f.snapshot, f.transaction, f.operations, f.ledger) }));
// Deliberately mutable decoded JSON at this public unknown-input boundary.
function fixture(index = 0) { return JSON.parse(JSON.stringify(cached[index])); }
type Fixture = ReturnType<typeof fixture>;
const validate = (f: Fixture) => validateStoredDonationEvidence(f.snapshot, f.evidence);
function unchanged(f: Fixture, action: () => void) {
  const seen = new Set<object>();
  const retained: [object, PropertyDescriptorMap, boolean, object | null][] = [];
  function remember(value: unknown) {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    retained.push([value, descriptors, Object.isFrozen(value), Object.getPrototypeOf(value)]);
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = Reflect.get(descriptors, key) as PropertyDescriptor;
      if ('value' in descriptor) remember(descriptor.value);
    }
  }
  remember(f); action();
  for (const [value, descriptors, frozen, prototype] of retained) {
    expect(Object.isFrozen(value)).toBe(frozen);
    expect(Object.getPrototypeOf(value)).toBe(prototype);
    expect(Reflect.ownKeys(value)).toEqual(Reflect.ownKeys(descriptors));
    for (const key of Reflect.ownKeys(descriptors)) {
      const before = Reflect.get(descriptors, key) as PropertyDescriptor;
      const after = Object.getOwnPropertyDescriptor(value, key)!;
      for (const field of ['value', 'get', 'set', 'enumerable', 'writable', 'configurable'] as const) {
        expect(after[field]).toBe(before[field]);
      }
    }
  }
}
function reject(f: Fixture) {
  unchanged(f, () => {
    let error: unknown;
    try { validate(f); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('d1_stored_donation_evidence_invalid');
    expect((error as Error).cause).toBeUndefined();
  });
}
function frozen(value: unknown) {
  if (!value || typeof value !== 'object') return;
  expect(Object.isFrozen(value)).toBe(true);
  Object.values(value).forEach(frozen);
}
function reversed(value: any): any {
  return value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reversed(child)])) : value;
}
const targets = (f: Fixture) => [f.snapshot, f.snapshot.intent, f.snapshot.intent.config, f.snapshot.intent.asset,
  f.snapshot.parameters, f.snapshot.parameters.timebounds, f.evidence, f.evidence.config,
  f.evidence.payment, f.evidence.payment.asset, f.evidence.ledger];

test('raw parser -> JSON -> stored validator preserves native and both credit asset forms', () => {
  for (const raw of originals) {
    const evidence = parseDonationEvidence(raw.snapshot, raw.transaction, raw.operations, raw.ledger);
    const f = clone({ snapshot: raw.snapshot, evidence });
    unchanged(f, () => {
      const actual = validate(f);
      expect(actual).toEqual(evidence);
      expect(actual.payment.confirmedAt).toBe(1700000005);
      expect(actual.payment.amount).toBe('12.0000001');
      expect(originalDeadline(actual.payment.confirmedAt)).toBe('2023-11-14T22:18:25Z');
      frozen(actual);
    });
  }
});

test('fresh canonical deeply frozen output ignores input key order and later input mutation', () => {
  for (let index = 0; index < cached.length; index++) {
    const f = reversed(fixture(index));
    unchanged(f, () => validate(f));
    const actual = validate(f);
    expect(JSON.stringify(actual)).toBe(JSON.stringify(cached[index].evidence));
    const again = validate(f);
    for (const result of [actual, again]) {
      frozen(result);
      expect(result).not.toBe(f.evidence);
      expect(result.config).not.toBe(f.snapshot.intent.config);
      expect(result.config).not.toBe(f.evidence.config);
      expect(result.payment).not.toBe(f.evidence.payment);
      expect(result.payment.asset).not.toBe(f.snapshot.intent.asset);
      expect(result.payment.asset).not.toBe(f.evidence.payment.asset);
      expect(result.ledger).not.toBe(f.evidence.ledger);
    }
    expect(again).not.toBe(actual);
    expect(again.config).not.toBe(actual.config);
    expect(again.payment.asset).not.toBe(actual.payment.asset);
    f.snapshot.intent.config.namespace = otherId; f.snapshot.intent.asset.type = 'invalid';
    f.evidence.config.namespace = otherId; f.evidence.payment.amount = '1.0000000';
    f.evidence.payment.asset.type = 'invalid'; f.evidence.ledger.closed_at = 'invalid';
    expect(JSON.stringify(actual)).toBe(JSON.stringify(cached[index].evidence));
  }
});

test('accepts precise operation IDs, uint32 ledger endpoints and original time/deadline boundaries', () => {
  for (const operation_id of ['1', '9999999999999999999']) for (const sequence of [1, 4294967295]) {
    for (const date of ['1970-01-01T00:00:00Z', closed_at, '9999-12-31T23:54:59Z']) {
      const f = fixture(); f.evidence.payment.operation_id = operation_id;
      Object.assign(f.evidence.ledger, { sequence, closed_at: date });
      f.evidence.payment.confirmedAt = Date.parse(date) / 1000;
      unchanged(f, () => expect(validate(f)).toEqual(f.evidence));
    }
  }
});

test('exact fieldsets reject missing, unknown, symbol and hidden fields at every record', () => {
  for (let i = 0; i < targets(fixture(1)).length; i++) {
    for (const kind of ['missing', 'unknown', 'symbol', 'hidden']) {
      const f = fixture(1); const target = targets(f)[i];
      if (kind === 'missing') delete target[Object.keys(target)[0]];
      else Object.defineProperty(target, kind === 'symbol' ? Symbol('extra') : 'extra',
        { value: true, enumerable: kind !== 'hidden' });
      reject(f);
    }
  }
  for (const key of ['admin', 'beneficiary', 'allocation', 'resolved', 'authority', 'settled']) {
    const f = fixture(); f.evidence[key] = true; reject(f);
  }
});

test('known-field and extra accessors never run, including coercion and toJSON traps', () => {
  let calls = 0;
  const trap = () => { calls++; throw new Error('private injected detail'); };
  for (let i = 0; i < targets(fixture(1)).length; i++) {
    for (const key of [Object.keys(targets(fixture(1))[i])[0], 'extra', 'toJSON']) {
      const f = fixture(1);
      Object.defineProperty(targets(f)[i], key, { enumerable: true, get: trap });
      reject(f); expect(calls).toBe(0);
    }
  }
  for (const key of ['toJSON', 'toString', 'valueOf']) {
    const f = fixture(); f.evidence.payment.amount = { [key]: trap };
    reject(f); expect(calls).toBe(0);
  }
});

test('rejects non-record inputs, nonplain nested records, cycles and deep structures safely', () => {
  for (const key of ['snapshot', 'evidence']) for (const value of [null, undefined, [], 1, true, 'json', new Date(0)]) {
    const f = fixture(); f[key] = value; reject(f);
  }
  for (let i = 0; i < targets(fixture()).length; i++) {
    const f = fixture(); Object.setPrototypeOf(targets(f)[i], { inherited: true }); reject(f);
  }
  for (const key of ['snapshot', 'evidence']) {
    const cyclic = fixture(); cyclic[key].self = cyclic[key]; reject(cyclic);
    const deep = fixture(); let nested: object = {};
    for (let i = 0; i < 64; i++) nested = { nested };
    deep[key][key === 'snapshot' ? 'intent' : 'payment'] = nested; reject(deep);
  }
  const f = fixture(); f.evidence.payment.asset = f.evidence; reject(f);
});

test('binds every config field, original UUID and full incident without normalization', () => {
  const invalid = { network: ['PUBLIC', undefined], pool_public_key: [donor.publicKey(), 'bad'],
    namespace: [otherId, id.toUpperCase()], donation_ttl_seconds: [301, '300'] };
  for (const [key, values] of Object.entries(invalid)) for (const value of values) {
    const f = fixture(); f.evidence.config[key] = value; reject(f);
  }
  for (const [key, values] of Object.entries({ request_id: [otherId, id.toUpperCase(), undefined],
    incident_id: ['other incident', 'original', 'original incident ', undefined] })) {
    for (const value of values) { const f = fixture(); f.evidence[key] = value; reject(f); }
  }
});

test('binds transaction hash, donor, pool and full gross amount, never allocated amount', () => {
  const invalid = { transaction_hash: ['ab'.repeat(32), 'AB'.repeat(32), 'a'.repeat(63), undefined],
    donor: [pool.publicKey(), 'bad'], pool: [donor.publicKey(), 'bad'],
    amount: ['1.0000000', '12.0000002', '12.00000010', '012.0000001', '0.0000000', 12.0000001] };
  for (const [key, values] of Object.entries(invalid)) for (const value of values) {
    const f = fixture(); f.evidence.payment[key] = value; reject(f);
  }
});

test('native and credit assets require exact original type/code/issuer and union shape', () => {
  for (let index = 0; index < cached.length; index++) {
    for (const asset of [{ type: 'native', code: 'XLM' }, { type: 'issued', code: 'OTHER', issuer: pool.publicKey() },
      { type: 'issued', code: 'USDC', issuer: donor.publicKey() }, { type: 'issued' }, null, [],
      cached[index === 0 ? 1 : 0].evidence.payment.asset]) {
      const f = fixture(index); f.evidence.payment.asset = clone(asset); reject(f);
    }
  }
});

test('operation ID stays a canonical positive decimal string of at most nineteen digits', () => {
  for (const value of ['0', '01', '-1', '1.0', '1e2', '1\n', ' 1', '10000000000000000000', '', 1, null]) {
    const f = fixture(); f.evidence.payment.operation_id = value; reject(f);
  }
});

test('ledger sequence is positive uint32 and ledger hash is exactly lowercase 64-hex', () => {
  for (const [key, values] of Object.entries({ sequence: [0, -1, 1.5, '42', 4294967296, NaN, Infinity],
    hash: ['AB'.repeat(32), 'a'.repeat(63), 'g'.repeat(64), 'ab'.repeat(32) + '\n', 42] })) {
    for (const value of values) { const f = fixture(); f.evidence.ledger[key] = value; reject(f); }
  }
});

test('canonical close time derives exact nonnegative integer seconds and representable original deadline', () => {
  for (const date of ['2023-02-30T00:00:00Z', '2023-11-14T22:13:25.000Z', '2023-11-14T22:13:25+00:00',
    closed_at + '\n', '1969-12-31T23:59:59Z', '9999-12-31T23:55:00Z', undefined]) {
    const f = fixture(); f.evidence.ledger.closed_at = date;
    f.evidence.payment.confirmedAt = Date.parse(date as string) / 1000; reject(f);
  }
  for (const value of [1700000004, 1700000006, 1700000005000, 1700000005.5, '1700000005', -1, NaN, Infinity, undefined]) {
    const f = fixture(); f.evidence.payment.confirmedAt = value; reject(f);
  }
});

test('rebuilds full original snapshot and verifies retained donor signature, not matching metadata alone', () => {
  for (const [key, value] of [['transactionHash', 'ab'.repeat(32)], ['unsignedXdr', cached[0].snapshot.signedTxXdr],
    ['signedTxXdr', cached[0].snapshot.unsignedXdr], ['signedTxXdr', 'bad']] as const) {
    const f = fixture(); f.snapshot[key] = value; reject(f);
  }
  for (const mutate of [(f: Fixture) => { f.snapshot.intent.amount = f.evidence.payment.amount = '1.0000000'; },
    (f: Fixture) => { f.snapshot.intent.incident_id = f.evidence.incident_id = 'changed'; },
    (f: Fixture) => { f.snapshot.parameters.fee = '101'; },
    (f: Fixture) => { f.snapshot.parameters.sequence = '9007199254740994'; },
    (f: Fixture) => { f.snapshot.parameters.timebounds.maxTime++; },
    (f: Fixture) => { f.snapshot.intent.config.network = f.evidence.config.network = 'PUBLIC'; }]) {
    const f = fixture(); mutate(f); reject(f);
  }
  for (const [signer, network] of [[pool, Networks.TESTNET], [donor, Networks.PUBLIC]] as const) {
    const f = fixture(); const tx = new Transaction(f.snapshot.unsignedXdr, network); tx.sign(signer);
    f.snapshot.signedTxXdr = tx.toXDR(); reject(f);
  }
  const f = fixture();
  const different = buildDonationTransaction({ ...f.snapshot.intent, amount: '1.0000000' }, f.snapshot.parameters);
  const tx = new Transaction(different.unsignedXdr, Networks.TESTNET); tx.sign(donor);
  f.snapshot.signedTxXdr = tx.toXDR(); reject(f);
});
