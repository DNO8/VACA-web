import { test, expect } from '@playwright/test';
import { Keypair, Networks, Transaction } from '@stellar/stellar-sdk';
import type { DonationJournal, DonationJournalRecord } from '../../src/lib/d1/donation-journal';
import { buildDonationTransaction, validateSignedDonation } from '../../src/lib/d1/donation-transaction';
import { readDonation } from '../../src/lib/d1/donation-session';
import { submitDonation } from '../../src/lib/d1/donation-submission';

// Synthetic SDK signatures; this adapter tests orchestration, not IndexedDB atomicity.
const donor = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 71));
const pool = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 72));
const id = '11111111-2222-3333-4444-555555555555';
const intent = { config: { network: 'TESTNET', pool_public_key: pool.publicKey(), namespace: id, donation_ttl_seconds: 300 },
  request_id: id, donor: donor.publicKey(), incident_id: 'exact:incident', asset: { type: 'native' }, amount: '1.0000001' };
const unsigned = buildDonationTransaction(intent, { sequence: '42', fee: '100', timebounds: { minTime: 0, maxTime: 1900000000 } });
const tx = new Transaction(unsigned.unsignedXdr, Networks.TESTNET);
tx.sign(donor);
const signed = validateSignedDonation(unsigned, { signerAddress: donor.publicKey(), signedTxXdr: ' \n' + tx.toXDR() + '\n ' });
const original: DonationJournalRecord = { scope: JSON.stringify(['TESTNET', pool.publicKey(), id, donor.publicKey(), intent.incident_id]),
  requestId: id, intent: JSON.stringify(unsigned), state: 'signed', signed: JSON.stringify(signed) };
const claimed = { ...original, state: 'submission_claimed' } as DonationJournalRecord;
const result = (state: string, httpStatus?: number) => ({ state, requestId: id, transactionHash: unsigned.transactionHash,
  ...(httpStatus === undefined ? {} : { httpStatus }) });
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
class Journal implements DonationJournal {
  claims: unknown[][] = [];
  writes = 0;
  beforeClaim = async () => {};
  acknowledge = (value: unknown): unknown => value;
  constructor(private record: DonationJournalRecord | null = original) {}
  async read() { return this.record && { ...this.record }; }
  async acquire(): Promise<never> { throw new Error('unexpected acquire'); }
  async saveSigned(): Promise<never> { throw new Error('unexpected signing'); }
  async claimSubmission(requestId: string, bytes: string) {
    this.claims.push([requestId, bytes]);
    await this.beforeClaim();
    if (!this.record || this.record.requestId !== requestId || this.record.state === 'intent' || this.record.signed !== bytes) {
      throw new Error('private guard detail');
    }
    const won = this.record.state === 'signed';
    if (won) { this.record = { ...this.record, state: 'submission_claimed' }; this.writes++; }
    return this.acknowledge({ claimed: won, record: this.record }) as Awaited<ReturnType<DonationJournal['claimSubmission']>>;
  }
  close() {}
}
function mock(action: (options: RequestInit) => unknown = () => ({ status: 200 })) {
  const calls: { url: unknown; options: RequestInit }[] = [];
  const fetcher = (async (url, options) => {
    calls.push({ url, options: options! });
    return await action(options!);
  }) as typeof fetch;
  return { fetcher, calls };
}
async function rejectBeforeClaim(record: DonationJournalRecord | null, expected: unknown, error: string) {
  const journal = new Journal(record), network = mock();
  await expect(submitDonation(journal, expected, network.fetcher)).rejects.toThrow(new RegExp(`^${error}$`));
  expect(await journal.read()).toEqual(record);
  expect(journal.claims).toEqual([]); expect(journal.writes).toBe(0); expect(network.calls).toEqual([]);
}

test('missing and unsigned records fail before claim or fetch', async () => {
  await rejectBeforeClaim(null, intent, 'd1_submission_not_found');
  const { signed: _signed, ...record } = original as typeof original & { signed: string };
  await rejectBeforeClaim({ ...record, state: 'intent' }, intent, 'd1_submission_unsigned');
});

test('full intent, canonical snapshot and real signature validation precede claim', async () => {
  const changes = [{ amount: '2.0000000' }, { request_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
    { donor: pool.publicKey() }, { incident_id: 'other' }, { asset: { type: 'issued', code: 'USD', issuer: pool.publicKey() } },
    { config: { ...intent.config, namespace: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' } },
    { config: { ...intent.config, pool_public_key: donor.publicKey() } }];
  for (const change of changes) await rejectBeforeClaim(original, { ...intent, ...change }, 'd1_session_identity_mismatch');
  await rejectBeforeClaim({ ...original, intent: JSON.stringify(unsigned, null, 2) }, intent, 'd1_session_invalid_snapshot');
  await rejectBeforeClaim({ ...original, state: 'signed', signed: JSON.stringify({ ...signed, signedTxXdr: unsigned.unsignedXdr }) }, intent, 'd1_invalid_signature');
});

test('noncallable fetch is rejected before the durable claim', async () => {
  const journal = new Journal();
  await expect(submitDonation(journal, intent, null as unknown as typeof fetch)).rejects.toThrow(/^d1_submission_invalid_fetcher$/);
  expect(journal.claims).toEqual([]); expect(journal.writes).toBe(0); expect(await journal.read()).toEqual(original);
});

test('already claimed validated reload is frozen unverified metadata without claim or fetch', async () => {
  const journal = new Journal(claimed), network = mock();
  const outcome = await submitDonation(journal, intent, network.fetcher);
  expect(outcome).toEqual(result('already_claimed')); expect(Object.isFrozen(outcome)).toBe(true);
  expect(journal.claims).toEqual([]); expect(network.calls).toEqual([]); expect(journal.writes).toBe(0);
  expect(await journal.read()).toEqual(claimed);
});

test('winner waits for durable claim, then sends exactly the retained XDR with fixed safe options', async () => {
  const journal = new Journal(), entered = deferred<void>(), release = deferred<void>();
  journal.beforeClaim = async () => { entered.resolve(); await release.promise; };
  let cancellations = 0;
  const network = mock(() => { expect(journal.writes).toBe(1); return { status: 200,
    body: { cancel: () => { cancellations++; return new Promise(() => {}); } },
    json: () => { throw new Error('must not parse'); } }; });
  const pending = submitDonation(journal, intent, network.fetcher);
  await Promise.race([entered.promise, pending]);
  expect(network.calls).toEqual([]); expect(await journal.read()).toEqual(original);
  expect(journal.claims).toEqual([[id, JSON.stringify(signed)]]);
  release.resolve();
  const outcome = await pending;
  expect(outcome).toEqual(result('response_unverified', 200)); expect(Object.isFrozen(outcome)).toBe(true);
  expect(network.calls).toHaveLength(1);
  const { url, options } = network.calls[0];
  expect(url).toBe('https://horizon-testnet.stellar.org/transactions');
  expect(options).toEqual({ method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: expect.any(URLSearchParams), signal: expect.any(AbortSignal) });
  expect(Array.from((options.body as URLSearchParams).entries())).toEqual([['tx', signed.signedTxXdr]]);
  expect(cancellations).toBe(1); expect(await journal.read()).toEqual(claimed);
});

test('two concurrent submissions, explicit repeat and reloaded read cannot send again', async () => {
  const journal = new Journal(), network = mock();
  const outcomes = await Promise.all([submitDonation(journal, intent, network.fetcher), submitDonation(journal, intent, network.fetcher)]);
  expect(outcomes).toEqual([result('response_unverified', 200), result('already_claimed')]);
  expect(journal.claims).toEqual([[id, JSON.stringify(signed)], [id, JSON.stringify(signed)]]);
  expect(journal.writes).toBe(1);
  expect((await readDonation(journal, intent))?.state).toBe('submission_claimed');
  expect(await submitDonation(journal, intent, network.fetcher)).toEqual(result('already_claimed'));
  expect(network.calls).toHaveLength(1); expect(journal.claims).toHaveLength(2); expect(await journal.read()).toEqual(claimed);
});

test('claim rejection and guard mismatch are safe storage errors, never a fetch or reset', async () => {
  for (const record of [original, { ...original, state: 'signed', signed: JSON.stringify(signed, null, 2) } as DonationJournalRecord]) {
    const journal = new Journal(record), network = mock();
    // A stale read emulates another writer changing bytes before the atomic guard.
    journal.read = async () => original;
    if (record === original) journal.beforeClaim = async () => { throw new Error('private storage detail'); };
    await expect(submitDonation(journal, intent, network.fetcher)).rejects.toThrow(/^d1_submission_storage_error$/);
    expect(journal.claims).toEqual([[id, JSON.stringify(signed)]]); expect(journal.writes).toBe(0); expect(network.calls).toEqual([]);
    expect(await Journal.prototype.read.call(journal)).toEqual(record);
  }
});

test('malformed claim acknowledgements fail closed even after persistence, without evaluating getters', async () => {
  let getters = 0;
  const accessor = { record: claimed, get claimed() { getters++; return true; } };
  const invalid = [null, [], { claimed: 1, record: claimed }, { claimed: true, record: claimed, extra: true }, accessor,
    { claimed: true, record: { ...claimed, extra: true } },
    ...[{ scope: 'other' }, { requestId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }, { intent: JSON.stringify(unsigned, null, 2) },
      { signed: JSON.stringify({ ...signed, signedTxXdr: signed.signedTxXdr.trim() }) }, { state: 'signed' }]
      .flatMap(change => [true, false].map(flag => ({ claimed: flag, record: { ...claimed, ...change } })))];
  for (const ack of invalid) {
    const journal = new Journal(), network = mock(); journal.acknowledge = () => ack;
    await expect(submitDonation(journal, intent, network.fetcher)).rejects.toThrow(/^d1_submission_invalid_claim$/);
    expect(journal.claims).toEqual([[id, JSON.stringify(signed)]]); expect(journal.writes).toBe(1);
    expect(network.calls).toEqual([]); expect(await journal.read()).toEqual(claimed);
  }
  expect(getters).toBe(0);
});

test('valid losing acknowledgement never sends', async () => {
  const journal = new Journal(claimed), network = mock(); journal.read = async () => original;
  expect(await submitDonation(journal, intent, network.fetcher)).toEqual(result('already_claimed'));
  expect(journal.claims).toEqual([[id, JSON.stringify(signed)]]); expect(journal.writes).toBe(0); expect(network.calls).toEqual([]);
  expect(await Journal.prototype.read.call(journal)).toEqual(claimed);
});

test('all HTTP classes are unverified metadata; body cancellation rejection is consumed', async () => {
  for (const status of [200, 400, 500]) {
    const journal = new Journal(); let cancellations = 0;
    const network = mock(() => ({ status, body: { cancel: () => { cancellations++; return Promise.reject(new Error('private body')); } } }));
    expect(await submitDonation(journal, intent, network.fetcher)).toEqual(result('response_unverified', status));
    expect(network.calls).toHaveLength(1); expect(cancellations).toBe(1); expect(await journal.read()).toEqual(claimed);
  }
});

test('throws, abort and invalid responses are unknown, frozen and permanently claimed', async () => {
  const actions = [() => { throw new Error('private network detail'); }, () => Promise.reject(new DOMException('private abort', 'AbortError')),
    ...[null, undefined, {}, { status: 0 }, { status: 600 }, { status: 200.5 }, { status: '200' }].map(value => () => value)];
  for (const action of actions) {
    const journal = new Journal(), network = mock(action);
    const outcome = await submitDonation(journal, intent, network.fetcher);
    expect(outcome).toEqual(result('unknown')); expect(Object.isFrozen(outcome)).toBe(true);
    expect(await journal.read()).toEqual(claimed); expect(journal.writes).toBe(1); expect(network.calls).toHaveLength(1);
    expect(await submitDonation(journal, intent, network.fetcher)).toEqual(result('already_claimed'));
    expect(network.calls).toHaveLength(1); expect(journal.claims).toHaveLength(1);
  }
});

test('actual 10-second deadline bounds abort-ignoring fetch and handles late success and rejection', async () => {
  const success = deferred<unknown>(), failure = deferred<unknown>();
  const journals = [new Journal(), new Journal()], networks = [mock(() => success.promise), mock(() => failure.promise)];
  const unhandled: unknown[] = [], onUnhandled = (error: unknown) => { unhandled.push(error); };
  process.on('unhandledRejection', onUnhandled);
  try {
    const started = performance.now();
    const outcomes = await Promise.all(journals.map((journal, index) => submitDonation(journal, intent, networks[index].fetcher)));
    expect(performance.now() - started).toBeGreaterThanOrEqual(9900);
    expect(performance.now() - started).toBeLessThan(14000);
    expect(outcomes).toEqual([result('unknown'), result('unknown')]);
    let cancellations = 0;
    success.resolve({ status: 200, body: { cancel: () => { cancellations++; return Promise.reject(new Error('late body')); } } });
    failure.reject(new Error('late network'));
    await new Promise(resolve => setImmediate(resolve));
    expect(cancellations).toBe(1); expect(unhandled).toEqual([]);
    for (const [index, journal] of journals.entries()) {
      expect(networks[index].calls[0].options.signal?.aborted).toBe(true);
      expect(networks[index].calls).toHaveLength(1); expect(await journal.read()).toEqual(claimed);
      expect(await submitDonation(journal, intent, networks[index].fetcher)).toEqual(result('already_claimed'));
      expect(networks[index].calls).toHaveLength(1); expect(journal.claims).toHaveLength(1);
    }
  } finally { process.off('unhandledRejection', onUnhandled); }
});
