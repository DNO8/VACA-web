import { test, expect } from '@playwright/test';
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { Keypair, Networks, Transaction, xdr } from '@stellar/stellar-sdk';
import { buildDonationTransaction as build, createDonationIntent as intent, validateSignedDonation as validate } from '../../src/lib/d1/donation-transaction';

const seed = Buffer.alloc(32, 37), donor = Keypair.fromRawEd25519Seed(seed);
const pool = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 38)).publicKey();
const id = '11111111-2222-3333-4444-555555555555';
const config = { network: 'TESTNET', pool_public_key: pool, namespace: id, donation_ttl_seconds: 300 };
const input = { request_id: id, donor: donor.publicKey(), incident_id: 'Exact/Incident:42', asset: { type: 'native' }, amount: '0.0000001' };
const params = { sequence: '42', fee: '100', timebounds: { minTime: 0, maxTime: 1900000000 } };
const snapshot = () => build(intent(config, input), params);
function reply(s: ReturnType<typeof snapshot>, network = Networks.TESTNET) {
  const tx = new Transaction(s.unsignedXdr, network);
  const digest = createHash('sha256').update(tx.signatureBase()).digest();
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
  tx.addDecoratedSignature(new xdr.DecoratedSignature({ hint: donor.rawPublicKey().subarray(28), signature: sign(null, digest, key) }));
  return { signerAddress: donor.publicKey(), signedTxXdr: ' \n' + tx.toXDR() + '\n ' };
}

test('independent crypto authenticates exact payment and preserves envelope bytes', () => {
  const s = snapshot(), tx = new Transaction(s.unsignedXdr, Networks.TESTNET);
  expect(s.transactionHash).toBe(createHash('sha256').update(tx.signatureBase()).digest('hex'));
  expect(tx.memo.value).toEqual(createHash('sha256').update('vaca.d1.donation.v1\nExact/Incident:42').digest());
  expect(tx.operations).toHaveLength(1);
  expect(tx.operations[0]).toMatchObject({ type: 'payment', source: donor.publicKey(), destination: pool, amount: input.amount });
  const r = reply(s), loaded = JSON.parse(JSON.stringify(s)), before = JSON.stringify(loaded);
  expect(validate(loaded, r).signedTxXdr).toBe(r.signedTxXdr);
  expect(() => validate(loaded, reply(s, Networks.PUBLIC))).toThrow(/^d1_invalid_signature$/);
  expect(JSON.stringify(loaded)).toBe(before);
});

test('UUID and namespace continuity requires external retention, unlike pool binding', () => {
  const s = snapshot(), r = reply(s), other = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const loaded = JSON.parse(JSON.stringify(s));
  loaded.intent.request_id = other; loaded.intent.config.namespace = other;
  const out = validate(loaded, r);
  expect(out.intent.request_id).toBe(other);
  expect(out.intent.config.namespace).toBe(other);
  expect(out.transactionHash).toBe(s.transactionHash);
  expect(Object.isFrozen(out.intent.config)).toBe(true);
  expect(out.intent.config).not.toBe(loaded.intent.config);
  loaded.intent.config.pool_public_key = donor.publicKey();
  expect(() => validate(loaded, r)).toThrow(/^d1_invalid_donation_snapshot$/);
  const changed = build(intent({ ...config, pool_public_key: donor.publicKey() }, input), params);
  expect(() => validate(s, reply(changed))).toThrow(/^d1_donation_body_mismatch$/);
});

test('wallet and reloaded snapshot descriptors reject without evaluation or mutation', () => {
  const s = snapshot(), valid = reply(s);
  for (const target of ['snapshot', 'wallet']) for (const kind of ['getter', 'hidden', 'symbol']) {
    const loaded = JSON.parse(JSON.stringify(s)), r = { ...valid };
    const obj = target === 'snapshot' ? loaded : r;
    let calls = 0;
    Object.defineProperty(obj, kind === 'symbol' ? Symbol('extra') : kind === 'getter' ? (target === 'snapshot' ? 'unsignedXdr' : 'signedTxXdr') : 'extra',
      kind === 'getter' ? { enumerable: true, get() { calls++; return ''; } } : { enumerable: false, value: true });
    const before = Object.getOwnPropertyDescriptors(obj);
    expect(() => validate(loaded, r)).toThrow(new RegExp('^' + (target === 'snapshot' ? 'd1_invalid_donation_snapshot' : 'd1_wallet_error') + '$'));
    expect(calls).toBe(0);
    expect(Object.getOwnPropertyDescriptors(obj)).toEqual(before);
    expect(Object.isFrozen(obj)).toBe(false);
  }
});
