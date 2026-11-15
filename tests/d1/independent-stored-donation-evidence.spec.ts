import { test, expect } from '@playwright/test';
import { createPrivateKey, createHash, sign } from 'node:crypto';
import { Keypair, Networks, Transaction, xdr } from '@stellar/stellar-sdk';
import { buildDonationTransaction } from '../../src/lib/d1/donation-transaction';
import { validateStoredDonationEvidence as validate } from '../../src/lib/d1/stored-donation-evidence';

type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };
const copy = <T>(v: T): Mutable<T> => JSON.parse(JSON.stringify(v));
function fixture() {
  const seed = Buffer.alloc(32, 71), donor = Keypair.fromRawEd25519Seed(seed);
  const pool = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 72)).publicKey();
  const id = '12345678-1234-1234-1234-123456789abc';
  const built = buildDonationTransaction({
    config: { network: 'TESTNET', pool_public_key: pool, namespace: id, donation_ttl_seconds: 300 },
    request_id: id, donor: donor.publicKey(), incident_id: 'independent retained donation',
    asset: { type: 'issued', code: 'USD', issuer: pool }, amount: '7.0000001',
  }, { sequence: '41', fee: '100', timebounds: { minTime: 1700000000, maxTime: 1700000060 } });
  const tx = new Transaction(built.unsignedXdr, Networks.TESTNET);
  const digest = createHash('sha256').update(tx.signatureBase()).digest();
  expect(digest.toString('hex')).toBe(built.transactionHash);
  const key = createPrivateKey({ key: Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'), seed,
  ]), format: 'der', type: 'pkcs8' });
  tx.signatures.push(new xdr.DecoratedSignature({ hint: donor.signatureHint(), signature: sign(null, digest, key) }));
  return copy({ snapshot: { ...built, signedTxXdr: tx.toXDR() }, evidence: {
    config: built.intent.config, request_id: id, incident_id: built.intent.incident_id,
    payment: { transaction_hash: built.transactionHash, operation_id: '9007199254740993',
      donor: donor.publicKey(), pool, asset: built.intent.asset, amount: '7.0000001', confirmedAt: 1700000005 },
    ledger: { sequence: 42, hash: 'cd'.repeat(32), closed_at: '2023-11-14T22:13:25Z' },
  } });
}
type Fixture = ReturnType<typeof fixture>;
function rejects(f: Fixture) {
  const before = JSON.stringify(f);
  expect(() => validate(f.snapshot, f.evidence)).toThrow(/^d1_stored_donation_evidence_invalid$/);
  expect(JSON.stringify(f)).toBe(before);
}

test('S1/S10: signed body, retained identity, economics and original date remain bound', () => {
  const good = fixture();
  expect(validate(good.snapshot, good.evidence)).toEqual(good.evidence);
  const mutations: ((f: Fixture) => void)[] = [
    f => { f.snapshot.intent.amount = f.evidence.payment.amount = '8.0000001'; },
    f => { f.snapshot.parameters.fee = '101'; },
    f => { f.snapshot.signedTxXdr = f.snapshot.unsignedXdr; },
    f => { f.evidence.request_id = '12345678-1234-1234-1234-123456789abd'; },
    f => { f.evidence.incident_id += ' changed'; },
    f => { f.evidence.payment.asset = { type: 'issued', code: 'EUR', issuer: f.evidence.payment.pool }; },
    f => { f.evidence.payment.confirmedAt++; },
    f => { f.evidence.ledger.closed_at = '2023-11-14T22:13:25.000Z'; },
    f => { f.evidence.payment.operation_id = '0'; },
    f => { f.evidence.ledger.sequence = 0; },
  ];
  for (const mutate of mutations) { const f = copy(good); mutate(f); rejects(f); }
});

test('S1/S10: descriptor rejection does not invoke getters or mutate inputs', () => {
  const f = fixture(); let calls = 0;
  for (const target of [f.snapshot, f.snapshot.intent, f.snapshot.parameters,
    f.evidence, f.evidence.payment, f.evidence.payment.asset, f.evidence.ledger]) {
    const key = Object.keys(target)[0], descriptor = Object.getOwnPropertyDescriptor(target, key)!;
    const get = () => { calls++; throw new Error('must not escape'); };
    Object.defineProperty(target, key, { enumerable: true, configurable: true, get });
    expect(() => validate(f.snapshot, f.evidence)).toThrow(/^d1_stored_donation_evidence_invalid$/);
    expect(Object.getOwnPropertyDescriptor(target, key)?.get).toBe(get);
    Object.defineProperty(target, key, descriptor);
  }
  expect(calls).toBe(0);
  expect(validate(f.snapshot, f.evidence)).toEqual(f.evidence);
});

test('S1/S10: canonical independent deep-frozen clone is consistency, not authentication', () => {
  const f = fixture();
  function reverse(v: any): any {
    return v && typeof v === 'object'
      ? Object.fromEntries(Object.entries(v).reverse().map(([k, child]) => [k, reverse(child)])) : v;
  }
  const result = validate(reverse(f.snapshot), reverse(f.evidence));
  expect(JSON.stringify(result)).toBe(JSON.stringify(f.evidence));
  function independent(a: any, b: any) {
    if (!a || typeof a !== 'object') return;
    expect(Object.isFrozen(a)).toBe(true); expect(a).not.toBe(b);
    for (const k of Object.keys(a)) independent(a[k], b[k]);
  }
  independent(result, f.evidence);
  const again = validate(f.snapshot, f.evidence); independent(again, result);
  f.evidence.payment.amount = '9.0000000';
  expect(result.payment.amount).toBe('7.0000001');
  // UUID/namespace and ledger provenance are not authenticated by transaction signatures.
  const changed = fixture();
  changed.snapshot.intent.request_id = changed.evidence.request_id = '12345678-1234-1234-1234-123456789abd';
  changed.evidence.ledger.hash = 'ef'.repeat(32);
  expect(validate(changed.snapshot, changed.evidence)).toEqual(changed.evidence);
});
