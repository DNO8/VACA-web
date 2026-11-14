import { test, expect } from '@playwright/test';
import { Keypair, Networks, Transaction, xdr } from '@stellar/stellar-sdk';
import { observeDonation } from '../../src/lib/d1/donation-observation';
import type { DonationJournal, DonationJournalRecord } from '../../src/lib/d1/donation-journal';
import { buildDonationTransaction, validateSignedDonation } from '../../src/lib/d1/donation-transaction';

const origin = 'https://horizon-testnet.stellar.org';
const id = 'abcdef01-2345-6789-abcd-0123456789ab';
const closed_at = '2023-11-14T22:13:25Z';
function fixture(issued = false) {
  const donor = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1));
  const pool = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 2));
  const unsigned = buildDonationTransaction({
    config: { network: 'TESTNET', pool_public_key: pool.publicKey(), namespace: id, donation_ttl_seconds: 300 },
    request_id: id, donor: donor.publicKey(), incident_id: 'original incident', amount: '12.0000001',
    asset: issued ? { type: 'issued', code: 'LONGASSET123', issuer: pool.publicKey() } : { type: 'native' },
  }, { sequence: '9007199254740993', fee: '100', timebounds: { minTime: 1700000000, maxTime: 1700000060 } });
  const tx = new Transaction(unsigned.unsignedXdr, Networks.TESTNET);
  tx.sign(donor);
  const snapshot = validateSignedDonation(unsigned, { signedTxXdr: tx.toXDR() + '\n', signerAddress: donor.publicKey() });
  const result = new xdr.TransactionResult({ feeCharged: xdr.Int64.fromString('100'),
    result: xdr.TransactionResultResult.txSuccess([
      xdr.OperationResult.opInner(xdr.OperationResultTr.payment(xdr.PaymentResult.paymentSuccess())),
    ]), ext: xdr.TransactionResultExt.fromXDR('00000000', 'hex') }).toXDR('base64');
  const transaction = { hash: snapshot.transactionHash, successful: true, operation_count: 1, ledger: 42,
    source_account: donor.publicKey(), source_account_sequence: tx.sequence, envelope_xdr: tx.toXDR(),
    result_xdr: result, created_at: closed_at, _links: { self: { href: 'https://invalid.example/ignored' } } };
  const operations = { _embedded: { records: [{ type: 'payment', type_i: 1, transaction_successful: true,
    transaction_hash: snapshot.transactionHash, id: '9007199254740993', source_account: donor.publicKey(),
    from: donor.publicKey(), to: pool.publicKey(), amount: '12.0000001', created_at: closed_at,
    ...(issued ? { asset_type: 'credit_alphanum12', asset_code: 'LONGASSET123', asset_issuer: pool.publicKey() }
      : { asset_type: 'native' }) }] }, _links: { next: { href: 'https://invalid.example/ignored' } } };
  const ledger = { sequence: 42, hash: 'ab'.repeat(32), closed_at };
  const intent = snapshot.intent;
  let record: DonationJournalRecord | null = { scope: JSON.stringify(['TESTNET', pool.publicKey(), id, donor.publicKey(), intent.incident_id]),
    requestId: id, intent: JSON.stringify(unsigned), state: 'submission_claimed', signed: JSON.stringify(snapshot) };
  const counters = { reads: 0, writes: 0 };
  const forbidden = async (): Promise<never> => { counters.writes++; throw new Error('forbidden mutation'); };
  const journal: DonationJournal = { acquire: forbidden, saveSigned: forbidden, claimSubmission: forbidden,
    close: () => { counters.writes++; }, read: async requestId => { expect(requestId).toBe(id); counters.reads++; return record; } };
  return { snapshot, intent, transaction, operations, ledger, journal, counters,
    get record() { return record; }, set record(value) { record = value; } };
}
type Fixture = ReturnType<typeof fixture>;
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/hal+json; charset=utf-8' } });
function transport(f: Fixture, override?: (index: number, url: string, init: RequestInit) => Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init: init! });
    return override ? override(calls.length - 1, url, init!) : json([f.transaction, f.operations, f.ledger][calls.length - 1]);
  };
  return { calls, fetcher };
}
function frozen(value: unknown) {
  if (!value || typeof value !== 'object') return;
  expect(Object.isFrozen(value)).toBe(true);
  Object.values(value).forEach(frozen);
}
async function run(f: Fixture, t: ReturnType<typeof transport>, state: 'observed' | 'unresolved', count: number) {
  const before = JSON.stringify(f);
  const reads = f.counters.reads;
  const result = await observeDonation(f.journal, f.intent, t.fetcher);
  expect(result.state).toBe(state);
  expect(result.requestId).toBe(id);
  expect(result.transactionHash).toBe(f.snapshot.transactionHash);
  frozen(result);
  expect(f.counters).toEqual({ reads: reads + 1, writes: 0 });
  expect(JSON.stringify({ ...f, counters: { reads, writes: 0 } })).toBe(before);
  expect(t.calls).toHaveLength(count);
  const urls = [`${origin}/transactions/${f.snapshot.transactionHash}`,
    `${origin}/transactions/${f.snapshot.transactionHash}/operations?limit=2&order=asc`, `${origin}/ledgers/42`];
  t.calls.forEach(({ url, init }, index) => {
    expect(url).toBe(urls[index]);
    expect(init).toEqual({ method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store',
      referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' }, signal: expect.any(AbortSignal) });
    expect(init.signal).toBe(t.calls[0].init.signal);
  });
  return result;
}

for (const issued of [false, true]) test(`matching original evidence, explicit repeat only: issued=${issued}`, async () => {
  const f = fixture(issued);
  for (let repeat = 0; repeat < 2; repeat++) {
    const t = transport(f);
    const result = await run(f, t, 'observed', 3);
    expect(result).toEqual({ state: 'observed', requestId: id, transactionHash: f.snapshot.transactionHash,
      evidence: { config: f.intent.config, request_id: id, incident_id: f.intent.incident_id,
        payment: { transaction_hash: f.snapshot.transactionHash, operation_id: '9007199254740993', donor: f.intent.donor,
          pool: f.intent.config.pool_public_key, asset: f.intent.asset, amount: '12.0000001', confirmedAt: 1700000005 }, ledger: f.ledger } });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(t.calls).toHaveLength(3);
    expect(t.calls[0].init.signal?.aborted).toBe(false);
  }
});

for (const variant of ['fetcher', 'missing', 'intent', 'signed', 'tampered', 'signature', 'mismatch', 'storage']) {
  test(`precondition ${variant} rejects before network or mutation`, async () => {
    const f = fixture();
    let code = 'd1_observation_not_submitted';
    if (variant === 'missing') { f.record = null; code = 'd1_observation_not_found'; }
    if (variant === 'intent' && f.record) {
      const { signed: _signed, ...record } = f.record as Extract<DonationJournalRecord, { signed: string }>;
      f.record = { ...record, state: 'intent' };
    }
    if (variant === 'signed' && f.record) f.record = { ...f.record, state: 'signed', signed: JSON.stringify(f.snapshot) };
    if (variant === 'tampered' && f.record) {
      f.record = { ...f.record, intent: f.record.intent.replace(f.snapshot.transactionHash, 'ab'.repeat(32)) };
      code = 'd1_session_invalid_snapshot';
    }
    if (variant === 'signature' && f.record) {
      f.record = { ...f.record, state: 'submission_claimed', signed: JSON.stringify({ ...f.snapshot, signedTxXdr: f.snapshot.unsignedXdr }) };
      code = 'd1_invalid_signature';
    }
    if (variant === 'mismatch') code = 'd1_session_identity_mismatch';
    if (variant === 'storage') { f.journal.read = async () => { throw new Error('private detail'); }; code = 'd1_session_storage_error'; }
    if (variant === 'fetcher') code = 'd1_observation_invalid_fetcher';
    const before = JSON.stringify(f.record);
    const t = transport(f);
    await expect(observeDonation(f.journal, variant === 'mismatch' ? { ...f.intent, amount: '1.0000000' } : f.intent,
      variant === 'fetcher' ? null as unknown as typeof fetch : t.fetcher)).rejects.toThrow(new RegExp(`^${code}$`));
    expect(t.calls).toEqual([]);
    expect(f.counters).toEqual({ reads: ['fetcher', 'storage'].includes(variant) ? 0 : 1, writes: 0 });
    expect(JSON.stringify(f.record)).toBe(before);
  });
}

for (const [field, values] of Object.entries({ hash: ['ab'.repeat(32), '../other'], successful: [false, 'true'],
  operation_count: [0, 2, '1'], ledger: [0, -1, 1.5, '42', 4294967296, null] })) {
  for (const value of values) test(`early transaction guard ${field}=${value}`, async () => {
    const f = fixture();
    Object.assign(f.transaction, { [field]: value });
    await run(f, transport(f), 'unresolved', 1);
  });
}

for (const variant of ['404', '500', '201', 'redirected', 'url', 'media', 'utf8', 'json', 'missing-body', 'throw', 'getter']) {
  test(`invalid response ${variant} is unresolved`, async () => {
    const f = fixture();
    let cancellations = 0;
    const t = transport(f, async (_index, url) => {
      if (variant === 'throw') throw new Error('private detail');
      const body = new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(variant === 'utf8' ? new Uint8Array([0xc3, 0x28]) : new TextEncoder().encode(variant === 'json' ? '{' : JSON.stringify(f.transaction)));
        controller.close();
      } });
      const response = new Response(variant === 'missing-body' ? null : body, {
        status: /^\d+$/.test(variant) ? Number(variant) : 200,
        headers: { 'Content-Type': variant === 'media' ? 'text/plain' : 'application/json; charset=utf-8' },
      });
      const cancel = response.body?.cancel.bind(response.body);
      if (cancel) response.body!.cancel = reason => { cancellations++; return cancel(reason); };
      Object.defineProperty(response, 'url', { value: variant === 'url' ? `${url}?other` : url });
      if (variant === 'redirected') Object.defineProperty(response, 'redirected', { value: true });
      if (variant === 'getter') Object.defineProperty(response, 'status', { get() { throw new Error('private detail'); } });
      return response;
    });
    await run(f, t, 'unresolved', 1);
    if (['404', '500', '201', 'redirected', 'url', 'media', 'getter'].includes(variant)) expect(cancellations).toBe(1);
  });
}

for (const size of [65536, 65537]) test(`stream byte boundary ${size}, no Content-Length trust`, async () => {
  const f = fixture();
  const encoded = Buffer.from(JSON.stringify({ ...f.transaction, metadata: 'é' }));
  const bytes = Buffer.concat([encoded, Buffer.alloc(size - encoded.length, 32)]);
  let cancellations = 0;
  let body: ReadableStream<Uint8Array>;
  const t = transport(f, async index => {
    if (index) return json([f.transaction, f.operations, f.ledger][index]);
    let offset = 0;
    body = new ReadableStream<Uint8Array>({ pull(controller) {
      if (offset < bytes.length) { controller.enqueue(bytes.subarray(offset, offset + 257)); offset += 257; }
      else if (size === 65536) controller.close();
    }, cancel() { cancellations++; return Promise.reject(new Error('ignored cancellation rejection')); } });
    return new Response(body, { headers: { 'Content-Type': 'application/json', 'Content-Length': '1' } });
  });
  await run(f, t, size === 65536 ? 'observed' : 'unresolved', size === 65536 ? 3 : 1);
  expect(cancellations).toBe(size === 65536 ? 0 : 1);
  expect(body!.locked).toBe(false);
});

for (const variant of ['empty', 'invalid', 'read-reject']) test(`stream ${variant} cancels without waiting`, async () => {
  const f = fixture();
  let cancelled = 0, released = 0;
  const t = transport(f, async () => ({ status: 200, redirected: false, url: '', headers: new Headers({ 'Content-Type': 'application/json' }),
    body: { getReader: () => ({ read: async () => {
      if (variant === 'read-reject') throw new Error('private detail');
      return { done: false, value: variant === 'empty' ? new Uint8Array() : 'not bytes' };
    }, cancel: () => { cancelled++; return Promise.reject(new Error('private detail')); }, releaseLock: () => { released++; } }) },
  } as unknown as Response));
  await run(f, t, 'unresolved', 1);
  expect(cancelled).toBe(1);
  expect(released).toBe(1);
});

for (const variant of ['operation', 'ledger', 'second-404', 'third-network']) test(`later evidence ${variant} stays unresolved`, async () => {
  const f = fixture();
  if (variant === 'operation') f.operations._embedded.records[0].amount = '1.0000000';
  if (variant === 'ledger') f.ledger.sequence = 43;
  const t = transport(f, async index => {
    if (variant === 'second-404' && index === 1) return new Response(null, { status: 404 });
    if (variant === 'third-network' && index === 2) throw new Error('private detail');
    return json([f.transaction, f.operations, f.ledger][index]);
  });
  await run(f, t, 'unresolved', variant === 'second-404' ? 2 : 3);
});

test('one actual 10s deadline bounds abort-ignoring fetch and body; late activity cannot start GET', async () => {
  // Concurrent invocations share no state, but exercise both late fulfillment and late rejection in one wait.
  const fixtures = [fixture(), fixture(), fixture()];
  const resolve: ((response: Response) => void)[] = [];
  let rejectLate!: (reason: Error) => void;
  let resolveRead!: (value: ReadableStreamReadResult<Uint8Array>) => void;
  let cancelled = 0, released = 0;
  const transports = fixtures.map((f, index) => transport(f, async () => {
    if (index < 2) return new Promise<Response>((yes, no) => { resolve[index] = yes; rejectLate = no; });
    return { status: 200, redirected: false, url: '', headers: new Headers({ 'Content-Type': 'application/json' }),
      body: { getReader: () => ({ read: () => new Promise<ReadableStreamReadResult<Uint8Array>>(yes => { resolveRead = yes; }),
        cancel: () => { cancelled++; return Promise.reject(new Error('late cancel')); }, releaseLock: () => { released++; } }) },
    } as unknown as Response;
  }));
  await Promise.all(fixtures.map((f, index) => run(f, transports[index], 'unresolved', 1)));
  transports.forEach(t => expect(t.calls[0].init.signal?.aborted).toBe(true));
  expect(cancelled).toBe(1);
  const late = new Response(new ReadableStream({ cancel() { cancelled++; return Promise.reject(new Error('late cancel')); } }));
  resolve[0](late);
  rejectLate(new Error('late fetch failure'));
  resolveRead({ done: false, value: new TextEncoder().encode(JSON.stringify(fixtures[2].transaction)) });
  await new Promise(yes => setTimeout(yes, 0));
  expect(cancelled).toBe(2);
  expect(released).toBeGreaterThanOrEqual(1);
  transports.forEach(t => expect(t.calls).toHaveLength(1));
  fixtures.forEach(f => expect(f.counters).toEqual({ reads: 1, writes: 0 }));
});
