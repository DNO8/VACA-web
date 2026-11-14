import { test, expect } from '@playwright/test';
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { Keypair, Networks, Transaction, xdr } from '@stellar/stellar-sdk';
import type { DonationJournal, DonationJournalRecord } from '../../src/lib/d1/donation-journal';
import { buildDonationTransaction } from '../../src/lib/d1/donation-transaction';
import { acquireDonation, readDonation, signDonation } from '../../src/lib/d1/donation-session';

const seed = Buffer.alloc(32, 81), donor = Keypair.fromRawEd25519Seed(seed);
const pool = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 82)).publicKey();
const id = '11111111-2222-3333-4444-555555555555';
const next = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const intent = () => ({ config: { network: 'TESTNET', pool_public_key: pool, namespace: id, donation_ttl_seconds: 300 },
  request_id: id, donor: donor.publicKey(), incident_id: 'independent:e,[scope]', asset: { type: 'native' }, amount: '0.0000001' });
const parameters = { sequence: '7', fee: '100', timebounds: { minTime: 0, maxTime: 1900000000 } };
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
function response(unsigned: string) {
  const tx = new Transaction(unsigned, Networks.TESTNET);
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
  const hash = createHash('sha256').update(tx.signatureBase()).digest();
  tx.signatures.push(new xdr.DecoratedSignature({ hint: donor.signatureHint(), signature: sign(null, hash, key) }));
  return { signerAddress: donor.publicKey(), signedTxXdr: '\n ' + tx.toXDR() + ' \n' };
}
function fixture() {
  let stored: DonationJournalRecord | null = null, saves = 0, claims = 0;
  const journal: DonationJournal = {
    async acquire(scope, requestId, bytes) {
      const acquired = stored === null;
      stored ??= { scope, requestId, intent: bytes, state: 'intent' };
      return { acquired, record: stored };
    },
    async read() { return stored; },
    async saveSigned(requestId, expected, signed) {
      saves++; expect(stored?.requestId).toBe(requestId); expect(stored?.intent).toBe(expected);
      stored = { ...stored!, state: 'signed', signed }; return stored;
    },
    async claimSubmission() { claims++; throw new Error('unexpected claim'); }, close() {},
  };
  return { journal, get stored() { return stored; }, set stored(v) { stored = v; }, get saves() { return saves; }, get claims() { return claims; } };
}

test('S1/S10: committed signed bytes survive a lost save acknowledgement without another signature', async () => {
  const f = fixture(); await acquireDonation(f.journal, intent(), parameters);
  const save = f.journal.saveSigned; let callbacks = 0;
  f.journal.saveSigned = async (...args) => { await save(...args); throw new Error('lost acknowledgement'); };
  await expect(signDonation(f.journal, intent(), async body => { callbacks++; return response(body); })).rejects.toThrow(/^d1_session_storage_error$/);
  expect(f.stored?.state).toBe('signed'); const before = digest(f.stored);
  const resumed = await signDonation(f.journal, intent(), async () => { callbacks++; throw new Error('must not resign'); });
  expect(resumed.state).toBe('signed'); expect(callbacks).toBe(1); expect(f.saves).toBe(1);
  expect(digest(f.stored)).toBe(before); expect(f.claims).toBe(0);
  expect('signedTxXdr' in resumed.snapshot && resumed.snapshot.signedTxXdr).toBe(response(resumed.snapshot.unsignedXdr).signedTxXdr);
});

test('S1/S10: duplicate JSON keys and coherent external-metadata substitution fail before signing', async () => {
  const f = fixture(); await acquireDonation(f.journal, intent(), parameters);
  const original = f.stored!; let callbacks = 0;
  const replacement = buildDonationTransaction({ ...intent(), request_id: next, config: { ...intent().config, namespace: next } }, parameters);
  expect(replacement.unsignedXdr).toBe(buildDonationTransaction(intent(), parameters).unsignedXdr);
  const attempts: [DonationJournalRecord, string][] = [
    [{ ...original, intent: original.intent.replace('{', '{"transactionHash":"ignored",') }, 'd1_session_invalid_snapshot'],
    [{ ...original, requestId: next, scope: JSON.stringify(['TESTNET', pool, next, donor.publicKey(), intent().incident_id]), intent: JSON.stringify(replacement) }, 'd1_session_identity_mismatch'],
  ];
  for (const [record, error] of attempts) {
    f.stored = record; const before = digest(f.stored);
    await expect(signDonation(f.journal, intent(), async body => { callbacks++; return response(body); })).rejects.toThrow(new RegExp('^' + error + '$'));
    expect(digest(f.stored)).toBe(before);
  }
  expect(callbacks).toBe(0); expect(f.saves).toBe(0); expect(f.claims).toBe(0);
});

test('S1/S10: losing issued-asset proposal cannot sign; retained original remains independent during wallet await', async () => {
  const f = fixture(); const first = await acquireDonation(f.journal, intent(), parameters);
  const losing = { ...intent(), request_id: next, amount: '2.0000000', asset: { type: 'issued', code: 'USD', issuer: pool } };
  const reused = await acquireDonation(f.journal, losing, { ...parameters, sequence: '8' });
  expect(reused.acquired).toBe(false); expect(reused.record).toEqual(first.record);
  const before = digest(f.stored); let callbacks = 0;
  await expect(signDonation(f.journal, losing, async body => { callbacks++; return response(body); })).rejects.toThrow(/^d1_session_identity_mismatch$/);
  expect(digest(f.stored)).toBe(before); expect(callbacks).toBe(0);
  const expected = intent();
  const signed = await signDonation(f.journal, expected, async (body, options) => {
    callbacks++; expect(digest(f.stored)).toBe(before);
    expect(options).toEqual({ address: donor.publicKey(), networkPassphrase: Networks.TESTNET });
    expected.amount = '99.0000000'; expected.config.namespace = next;
    await Promise.resolve(); return response(body);
  });
  expect(signed.snapshot.intent).toEqual(intent()); expect(callbacks).toBe(1); expect(f.saves).toBe(1);
  expect(await readDonation(f.journal, intent())).toEqual(signed); expect(f.claims).toBe(0);
});
