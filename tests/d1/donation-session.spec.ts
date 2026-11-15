import { test, expect } from '@playwright/test';
import { Keypair, Networks, Transaction } from '@stellar/stellar-sdk';
import type { DonationJournal, DonationJournalRecord } from '../../src/lib/d1/donation-journal';
import { buildDonationTransaction, validateSignedDonation } from '../../src/lib/d1/donation-transaction';
import { acquireDonation, readDonation, signDonation } from '../../src/lib/d1/donation-session';

// Synthetic keys and a bounded public adapter: no live wallet or IndexedDB atomicity claim.
const donor = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 61));
const other = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 62));
const id = '11111111-2222-3333-4444-555555555555';
const nextId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const intent = () => ({ config: { network: 'TESTNET', pool_public_key: other.publicKey(), namespace: id, donation_ttl_seconds: 300 },
  request_id: id, donor: donor.publicKey(), incident_id: 'incident:[exact,scope]', asset: { type: 'native' }, amount: '1.0000001' });
const params = () => ({ sequence: '42', fee: '100', timebounds: { minTime: 0, maxTime: 1900000000 } });
const build = () => buildDonationTransaction(intent(), params());
const scope = () => JSON.stringify(['TESTNET', other.publicKey(), id, donor.publicKey(), intent().incident_id]);
const record = (): DonationJournalRecord => ({ scope: scope(), requestId: id, intent: JSON.stringify(build()), state: 'intent' });
function reply(snapshot = build(), key = donor, network = Networks.TESTNET) {
  const tx = new Transaction(snapshot.unsignedXdr, network);
  tx.sign(key);
  return { signerAddress: donor.publicKey(), signedTxXdr: ' \n' + tx.toXDR() + '\n ' };
}
function signedRecord(state: 'signed' | 'submission_claimed' = 'signed'): DonationJournalRecord {
  return { ...record(), state, signed: JSON.stringify(validateSignedDonation(build(), reply())) };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
class Journal implements DonationJournal {
  stored: DonationJournalRecord | null = null;
  writes = 0;
  reads: string[] = [];
  saves: unknown[][] = [];
  beforeSave = async () => {};
  async acquire(scope: string, requestId: string, intent: string) {
    if (this.stored) {
      if (this.stored.requestId === requestId && (this.stored.scope !== scope || this.stored.intent !== intent)) throw new Error('d1_journal_conflict');
      return { acquired: false, record: this.stored };
    }
    this.stored = { scope, requestId, intent, state: 'intent' };
    this.writes++;
    return { acquired: true, record: this.stored };
  }
  async read(requestId: string) { this.reads.push(requestId); return this.stored; }
  async saveSigned(requestId: string, expectedIntent: string, signed: string): Promise<DonationJournalRecord> {
    this.saves.push([requestId, expectedIntent, signed]);
    await this.beforeSave();
    if (!this.stored || this.stored.requestId !== requestId || this.stored.intent !== expectedIntent) throw new Error('d1_journal_guard_mismatch');
    if (this.stored.state !== 'intent') {
      if (this.stored.signed !== signed) throw new Error('d1_journal_conflict');
      return this.stored;
    }
    this.stored = { ...this.stored, state: 'signed', signed };
    this.writes++;
    return this.stored;
  }
  async claimSubmission(): Promise<never> { throw new Error('session must not claim'); }
  close() {}
}
async function rejectedStored(stored: unknown, error: string) {
  const journal = new Journal();
  journal.stored = stored as DonationJournalRecord;
  const before = Object.getOwnPropertyDescriptors(stored);
  let calls = 0;
  await expect(readDonation(journal, intent())).rejects.toThrow(new RegExp(`^${error}$`));
  await expect(signDonation(journal, intent(), async () => { calls++; return reply(); })).rejects.toThrow(new RegExp(`^${error}$`));
  expect(Object.getOwnPropertyDescriptors(journal.stored)).toEqual(before);
  expect(journal.writes).toBe(0);
  expect(journal.saves).toEqual([]);
  expect(calls).toBe(0);
}

test('acquisition retains canonical original bytes across competing UUID/amount/asset/parameters', async () => {
  const journal = new Journal(), original = intent(), parameters = params();
  const before = JSON.stringify({ original, parameters });
  const first = await acquireDonation(journal, original, parameters);
  expect(first).toEqual({ acquired: true, record: { scope: scope(), requestId: id, state: 'intent', snapshot: build() } });
  expect(journal.stored).toEqual(record());
  const second = await acquireDonation(journal, { ...intent(), request_id: nextId, amount: '2.0000000',
    asset: { type: 'issued', code: 'USD', issuer: other.publicKey() } }, { ...params(), sequence: '99' });
  expect(second).toEqual({ acquired: false, record: first.record });
  expect(journal.writes).toBe(1);
  expect(journal.saves).toEqual([]);
  expect(JSON.stringify({ original, parameters })).toBe(before);
  expect(Object.isFrozen(original)).toBe(false);
  expect(Object.isFrozen(parameters.timebounds)).toBe(false);
  expect(Object.isFrozen(first)).toBe(true);
  expect(Object.isFrozen(first.record.snapshot.intent.config)).toBe(true);
  expect(Object.isFrozen(first.record.snapshot.parameters.timebounds)).toBe(true);
  expect(second.record.snapshot).not.toBe(first.record.snapshot);
  original.amount = '9.0000000'; parameters.timebounds.maxTime++;
  expect(await readDonation(journal, intent())).toEqual(first.record);
  await expect(acquireDonation(journal, { ...intent(), amount: '0' }, params())).rejects.toThrow(/^d1_invalid_donation_intent$/);
  await expect(acquireDonation(journal, intent(), { ...params(), fee: '0' })).rejects.toThrow(/^d1_invalid_donation_parameters$/);
  expect(journal.stored).toEqual(record()); expect(journal.writes).toBe(1);
});

test('acquisition rejects malformed result flags and inconsistent acquisition guards', async () => {
  const changed = buildDonationTransaction({ ...intent(), amount: '2.0000000' }, params());
  for (const [response, error] of [
    [{ acquired: 1, record: record() }, 'd1_session_invalid_record'],
    [{ acquired: true, record: record(), extra: true }, 'd1_session_invalid_record'],
    [{ acquired: true, record: signedRecord() }, 'd1_session_invalid_record'],
    [{ acquired: false, record: { ...record(), scope: 'other' } }, 'd1_session_identity_mismatch'],
    [{ acquired: true, record: { ...record(), requestId: nextId } }, 'd1_session_identity_mismatch'],
    [{ acquired: false, record: { ...record(), intent: JSON.stringify(changed) } }, 'd1_session_identity_mismatch'],
  ] as const) {
    const journal = new Journal();
    journal.acquire = async () => response as Awaited<ReturnType<DonationJournal['acquire']>>;
    await expect(acquireDonation(journal, intent(), params())).rejects.toThrow(new RegExp(`^${error}$`));
    expect(journal.stored).toBeNull(); expect(journal.writes).toBe(0);
  }
});

test('missing read is null; signing missing and invalid expected input never calls wallet or writes', async () => {
  const journal = new Journal(); let calls = 0;
  expect(await readDonation(journal, intent())).toBeNull();
  await expect(signDonation(journal, intent(), async () => { calls++; return reply(); })).rejects.toThrow(/^d1_session_not_found$/);
  expect(journal.reads).toEqual([id, id]);
  await expect(readDonation(journal, { ...intent(), extra: true })).rejects.toThrow(/^d1_invalid_donation_intent$/);
  expect(journal.reads).toEqual([id, id]); expect(calls).toBe(0); expect(journal.writes).toBe(0);
});

test('read and sign bind every original immutable intent field, not just UUID', async () => {
  const changes = [{ request_id: nextId }, { donor: other.publicKey() }, { incident_id: 'other' }, { amount: '2.0000000' },
    { asset: { type: 'issued', code: 'USD', issuer: other.publicKey() } },
    ...[{ namespace: nextId }, { pool_public_key: donor.publicKey() }].map(change => ({ config: { ...intent().config, ...change } }))];
  for (const change of changes) {
    const journal = new Journal(); journal.stored = record(); let calls = 0;
    const expected = { ...intent(), ...change }, before = JSON.stringify(expected);
    await expect(readDonation(journal, expected)).rejects.toThrow(/^d1_session_identity_mismatch$/);
    await expect(signDonation(journal, expected, async () => { calls++; return reply(); })).rejects.toThrow(/^d1_session_identity_mismatch$/);
    expect(JSON.stringify(expected)).toBe(before); expect(journal.stored).toEqual(record());
    expect(calls).toBe(0); expect(journal.writes).toBe(0); expect(journal.saves).toEqual([]);
  }
});

test('unsigned JSON must exactly match reconstructed canonical bytes', async () => {
  const snapshot = build();
  for (const payload of ['null', '{}', JSON.stringify({ ...snapshot, extra: true }), JSON.stringify({ ...snapshot, unsignedXdr: 'bad' }),
    JSON.stringify({ ...snapshot, transactionHash: 'a'.repeat(64) }), JSON.stringify({ ...snapshot, parameters: { ...params(), fee: '101' } }),
    JSON.stringify({ ...snapshot, intent: { ...snapshot.intent, amount: '2.0000000' } }), JSON.stringify(snapshot, null, 2)]) {
    await rejectedStored({ ...record(), intent: payload }, 'd1_session_invalid_snapshot');
  }
  await rejectedStored({ ...record(), intent: '{' }, 'd1_session_invalid_json');
});

test('envelope state, keys and scope/UUID guards reject before callback without getter evaluation', async () => {
  for (const change of [{ state: 'unknown' }, { state: 'signed' }, { signed: '{}' }, { extra: true }, { intent: 1 }]) {
    await rejectedStored({ ...record(), ...change }, 'd1_session_invalid_record');
  }
  for (const change of [{ scope: 'other' }, { requestId: nextId }]) {
    await rejectedStored({ ...record(), ...change }, 'd1_session_identity_mismatch');
  }
  let getters = 0;
  const accessor = { ...record() };
  Object.defineProperty(accessor, 'state', { enumerable: true, get() { getters++; return 'intent'; } });
  await rejectedStored(accessor, 'd1_session_invalid_record'); expect(getters).toBe(0);
});

test('explicit signing uses exact retained body/options once and waits for durable completion', async () => {
  const journal = new Journal(); await acquireDonation(journal, intent(), params());
  const entered = deferred(), release = deferred();
  journal.beforeSave = async () => { entered.resolve(); await release.promise; };
  const calls: unknown[][] = []; let resolved = false;
  const pending = signDonation(journal, intent(), async (...args) => {
    calls.push(args); expect(journal.stored).toEqual(record()); return reply();
  }).then(value => { resolved = true; return value; });
  await Promise.race([entered.promise, pending]);
  expect(calls).toEqual([[build().unsignedXdr, { address: donor.publicKey(), networkPassphrase: Networks.TESTNET }]]);
  expect(journal.saves).toEqual([[id, record().intent, JSON.stringify(validateSignedDonation(build(), reply()))]]);
  expect(resolved).toBe(false); expect(journal.stored).toEqual(record());
  release.resolve();
  const result = await pending;
  expect(result.state).toBe('signed'); expect(result.snapshot).toEqual(validateSignedDonation(build(), reply()));
  expect(journal.stored).toEqual(signedRecord()); expect(journal.writes).toBe(2);
});

test('wrong signer/body/signature/network, wallet errors and throws leave original bytes unchanged', async () => {
  const changed = buildDonationTransaction({ ...intent(), amount: '2.0000000' }, params());
  for (const [response, error] of [
    [{ ...reply(), signerAddress: other.publicKey() }, 'd1_signer_mismatch'], [reply(changed), 'd1_donation_body_mismatch'],
    [reply(build(), other), 'd1_invalid_signature'], [reply(build(), donor, Networks.PUBLIC), 'd1_invalid_signature'],
    [{ ...reply(), signedTxXdr: build().unsignedXdr }, 'd1_invalid_signature'], [{ ...reply(), signedTxXdr: 'bad' }, 'd1_invalid_signed_donation'],
    [{ ...reply(), error: { message: 'private wallet detail' } }, 'd1_wallet_error'], [null, 'd1_wallet_error'],
    [undefined, 'd1_wallet_error'],
  ] as const) {
    const journal = new Journal(); journal.stored = record(); let calls = 0;
    await expect(signDonation(journal, intent(), async () => {
      calls++; if (response === undefined) throw new Error('private wallet detail'); return response;
    })).rejects.toThrow(new RegExp(`^${error}$`));
    expect(calls).toBe(1); expect(journal.stored).toEqual(record()); expect(journal.saves).toEqual([]); expect(journal.writes).toBe(0);
  }
});

test('signed and claimed reloads verify exact signed bytes without wallet calls or writes', async () => {
  for (const state of ['signed', 'submission_claimed'] as const) {
    const journal = new Journal(); journal.stored = signedRecord(state); let calls = 0;
    const result = await signDonation(journal, intent(), async () => { calls++; return reply(); });
    expect(result).toEqual({ scope: scope(), requestId: id, state, snapshot: validateSignedDonation(build(), reply()) });
    expect(await readDonation(journal, intent())).toEqual(result);
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.snapshot.intent.asset)).toBe(true);
    expect(calls).toBe(0); expect(journal.writes).toBe(0); expect(journal.saves).toEqual([]);
    expect(journal.stored).toEqual(signedRecord(state));
  }
});

test('stored signed state cannot substitute valid signature, JSON, snapshot or identity', async () => {
  const signed = validateSignedDonation(build(), reply());
  for (const [payload, error] of [
    ['{', 'd1_session_invalid_json'], ['null', 'd1_session_invalid_snapshot'],
    [JSON.stringify({ ...signed, extra: true }), 'd1_session_invalid_snapshot'],
    [JSON.stringify({ ...signed, intent: { ...signed.intent, request_id: nextId } }), 'd1_session_invalid_snapshot'],
    [JSON.stringify({ ...signed, transactionHash: 'a'.repeat(64) }), 'd1_session_invalid_snapshot'],
    [JSON.stringify({ ...signed, signedTxXdr: reply(build(), other).signedTxXdr }), 'd1_invalid_signature'],
    [JSON.stringify({ ...signed, signedTxXdr: reply(build(), donor, Networks.PUBLIC).signedTxXdr }), 'd1_invalid_signature'],
    [JSON.stringify({ ...signed, signedTxXdr: reply(buildDonationTransaction(intent(), { ...params(), fee: '101' })).signedTxXdr }), 'd1_donation_body_mismatch'],
    [JSON.stringify(signed, null, 2), 'd1_session_invalid_snapshot'],
  ]) await rejectedStored({ ...record(), state: 'signed', signed: payload }, error);
});

test('asynchronous journal failure rejects without durable-success or private detail claims', async () => {
  const journal = new Journal(); journal.stored = record();
  journal.beforeSave = async () => { await Promise.resolve(); throw new Error('private storage detail'); };
  await expect(signDonation(journal, intent(), async () => reply())).rejects.toThrow(/^d1_session_storage_error$/);
  expect(journal.stored).toEqual(record()); expect(journal.writes).toBe(0); expect(journal.saves).toHaveLength(1);
  journal.acquire = async () => { throw new Error('private storage detail'); };
  await expect(acquireDonation(journal, intent(), params())).rejects.toThrow(/^d1_session_storage_error$/);
  expect(journal.stored).toEqual(record()); expect(journal.writes).toBe(0);
});

test('a claim racing signing is returned without downgrade or submission attempt', async () => {
  const journal = new Journal(); journal.stored = record();
  journal.beforeSave = async () => { journal.stored = signedRecord('submission_claimed'); };
  const result = await signDonation(journal, intent(), async () => reply());
  expect(result.state).toBe('submission_claimed'); expect(journal.stored).toEqual(signedRecord('submission_claimed'));
  expect(journal.writes).toBe(0); expect(journal.saves).toHaveLength(1);
});

test('persisted response is revalidated including exact unsigned and signed guards', async () => {
  for (const [returned, error] of [
    [record(), 'd1_session_invalid_record'],
    [{ ...signedRecord(), intent: JSON.stringify(buildDonationTransaction(intent(), { ...params(), fee: '101' })) }, 'd1_donation_body_mismatch'],
    [{ ...signedRecord(), signed: JSON.stringify(validateSignedDonation(build(), { ...reply(), signedTxXdr: reply().signedTxXdr.trim() })) }, 'd1_session_identity_mismatch'],
  ] as const) {
    const journal = new Journal(); journal.stored = record();
    journal.saveSigned = async () => returned;
    await expect(signDonation(journal, intent(), async () => reply())).rejects.toThrow(new RegExp(`^${error}$`));
    expect(journal.stored).toEqual(record()); expect(journal.writes).toBe(0);
  }
});

test('concurrent explicit calls may prompt twice but cannot replace retained signed bytes', async () => {
  const journal = new Journal(); journal.stored = record();
  const entered = deferred(), release = deferred(); let calls = 0;
  const signer = async () => { calls++; if (calls === 2) entered.resolve(); await release.promise; return reply(); };
  const both = Promise.all([signDonation(journal, intent(), signer), signDonation(journal, intent(), signer)]);
  await Promise.race([entered.promise, both]); expect(calls).toBe(2); release.resolve();
  const [first, second] = await both;
  expect(first).toEqual(second); expect(journal.writes).toBe(1); expect(journal.stored).toEqual(signedRecord());
});

test('compatibility: pure build/signature validators still retain exact body and wallet bytes', () => {
  const snapshot = build(), response = reply();
  expect(validateSignedDonation(JSON.parse(JSON.stringify(snapshot)), response)).toEqual({ ...snapshot, signedTxXdr: response.signedTxXdr });
  expect(snapshot.intent).toEqual(intent()); expect(snapshot.parameters).toEqual(params());
});
