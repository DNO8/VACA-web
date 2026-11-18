import { test, expect } from '@playwright/test';
import { Keypair, Networks, Transaction, xdr } from '@stellar/stellar-sdk';
import { createDonationFlow } from '../../src/lib/d1/donation-flow';
import { readDonationAccount } from '../../src/lib/d1/donation-account';
import { recoverDonation } from '../../src/lib/d1/donation-recovery';
import type { DonationJournalV2, DonationJournalRecord, DonationJournalScope } from '../../src/lib/d1/donation-journal';

// Synthetic fixtures only. This adapter exercises orchestration, not browser IDB atomicity.
const donor = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 71));
const pool = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 72));
const id = '11111111-2222-3333-4444-555555555555';
const config = { network: 'TESTNET' as const, pool_public_key: pool.publicKey(), namespace: id, donation_ttl_seconds: 300 as const };
const context = { config, donor: donor.publicKey(), incidentId: 'full:incident:identity' };
class Journal implements DonationJournalV2 {
  private record: DonationJournalRecord | null = null;
  private resolution: string | null = null;
  mutations = 0;
  async acquire(scope: string, requestId: string, intent: string) {
    if (this.record) return { acquired: false, record: this.record };
    this.mutations++;
    this.record = { scope, requestId, intent, state: 'intent' };
    return { acquired: true, record: this.record };
  }
  async read(requestId: string) { return this.record?.requestId === requestId ? this.record : null; }
  async readScope(scope: string): Promise<DonationJournalScope | null> {
    return this.record?.scope === scope ? { record: this.record, active: this.resolution === null, resolution: this.resolution } : null;
  }
  async readResolution() { return this.resolution; }
  async saveSigned(requestId: string, intent: string, signed: string): Promise<DonationJournalRecord> {
    if (!this.record || this.record.requestId !== requestId || this.record.intent !== intent) throw Error('guard');
    if (this.record.state === 'intent') { this.mutations++; this.record = { ...this.record, state: 'signed', signed }; }
    else if (this.record.signed !== signed) throw Error('conflict');
    return this.record;
  }
  async claimSubmission(requestId: string, signed: string) {
    if (!this.record || this.record.requestId !== requestId || this.record.state === 'intent' || this.record.signed !== signed) throw Error('guard');
    const claimed = this.record.state === 'signed';
    if (claimed) { this.mutations++; this.record = { ...this.record, state: 'submission_claimed' }; }
    return { claimed, record: this.record };
  }
  // Simulates opaque historical cached data via the public journal interface.
  cache(evidence: unknown) { this.resolution = JSON.stringify(evidence); }
  close() {}
}
function fixture(journal = new Journal(), acknowledged = false) {
  const calls = { uuid: 0, account: 0, sign: 0, send: 0 };
  const requests: { url: string; init?: RequestInit }[] = [];
  const flow = createDonationFlow({ ...context, journal,
    uuid: () => { calls.uuid++; return id; }, now: () => 1800000000,
    fetcher: (async (url, init) => {
      requests.push({ url: String(url), init });
      if (init?.method === 'POST') {
        calls.send++;
        if (acknowledged) return new Response(null, { status: 202 });
        throw Error('unknown transport');
      }
      calls.account++;
      return Response.json({ account_id: donor.publicKey(), sequence: '42' });
    }) as typeof fetch,
    signTransaction: async (wire, options) => {
      calls.sign++; expect(options).toEqual({ address: donor.publicKey(), networkPassphrase: Networks.TESTNET });
      expect((await recoverDonation(journal, context))?.session.state).toBe('intent');
      const tx = new Transaction(wire, Networks.TESTNET); tx.sign(donor);
      return { signerAddress: donor.publicKey(), signedTxXdr: ' \n' + tx.toXDR() + '\n ' };
    },
  });
  return { journal, flow, calls, requests };
}

test('first native payment prepares durably, signs explicitly and POSTs exact retained bytes once', async () => {
  const f = fixture(new Journal(), true);
  expect(await f.flow.recover()).toBeNull();
  const prepared = await f.flow.prepare('1.0000001');
  expect(prepared.session.snapshot.intent).toEqual({ config, request_id: id, donor: donor.publicKey(), incident_id: context.incidentId, asset: { type: 'native' }, amount: '1.0000001' });
  expect(prepared.repeatBlocked).toBe(true);
  expect(f.calls).toEqual({ uuid: 1, account: 1, sign: 0, send: 0 });
  const signed = await f.flow.sign(prepared.session);
  expect(signed.state).toBe('signed');
  expect(f.calls.send).toBe(0);
  const sent = await f.flow.send(signed);
  expect(sent).toEqual({ state: 'response_unverified', httpStatus: 202, requestId: id, transactionHash: signed.snapshot.transactionHash });
  const post = f.requests.find(request => request.init?.method === 'POST')!;
  expect(post.url).toBe('https://horizon-testnet.stellar.org/transactions');
  expect((post.init!.body as URLSearchParams).get('tx')).toBe('signedTxXdr' in signed.snapshot ? signed.snapshot.signedTxXdr : 'missing');
  expect((await f.flow.recover())?.session.state).toBe('submission_claimed');
  expect(await f.flow.send(signed)).toEqual({ state: 'already_claimed', requestId: id, transactionHash: signed.snapshot.transactionHash });
  expect(f.calls).toEqual({ uuid: 1, account: 1, sign: 1, send: 1 });
  expect(f.journal.mutations).toBe(3);
});

test('existing scope recovers original economics before proposing UUID, sequence or body', async () => {
  const f = fixture(); const first = await f.flow.prepare('5');
  const before = f.journal.mutations;
  const g = fixture(f.journal);
  const recovered = await g.flow.prepare('9.99999999');
  expect(recovered).toEqual(first);
  expect(recovered.session.snapshot.intent.amount).toBe('5.0000000');
  expect(g.calls).toEqual({ uuid: 0, account: 0, sign: 0, send: 0 });
  expect(g.journal.mutations).toBe(before);
});

test('competing coordinators share durable claim; unknown never permits a second send', async () => {
  const f = fixture(); const prepared = await f.flow.prepare('2');
  const signed = await f.flow.sign(prepared.session);
  const g = fixture(f.journal);
  const results = await Promise.all([f.flow.send(signed), g.flow.send(signed)]);
  expect(results.map(result => result.state).sort()).toEqual(['already_claimed', 'unknown']);
  expect(f.calls.send + g.calls.send).toBe(1);
  const recovered = await g.flow.prepare('3');
  expect(recovered.session.snapshot.transactionHash).toBe(signed.snapshot.transactionHash);
  expect(recovered.session.state).toBe('submission_claimed');
  expect(recovered.repeatBlocked).toBe(true);
  expect(g.calls.uuid).toBe(0); expect(g.calls.account).toBe(0); expect(g.calls.sign).toBe(0);
  expect(f.journal.mutations).toBe(3);
});

test('account reader fixes Testnet origin and rejects account/sequence/redirect/oversize before acquisition', async () => {
  const seen: { url: string; init?: RequestInit }[] = [];
  const controller = new AbortController();
  expect(await readDonationAccount(donor.publicKey(), controller.signal, (async (url, init) => {
    seen.push({ url: String(url), init }); return Response.json({ account_id: donor.publicKey(), sequence: '42' });
  }) as typeof fetch)).toBe('42');
  expect(seen[0].url).toBe('https://horizon-testnet.stellar.org/accounts/' + donor.publicKey());
  expect(seen[0].init).toMatchObject({ method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer' });
  let requests = 0;
  await expect(readDonationAccount('https://evil.test/account', controller.signal, (async () => { requests++; return Response.json({}); }) as typeof fetch)).rejects.toThrow(/^d1_account_invalid$/);
  expect(requests).toBe(0);
  for (const response of [Response.json({ account_id: pool.publicKey(), sequence: '42' }),
    Response.json({ account_id: donor.publicKey(), sequence: '9223372036854775807' }),
    Response.json({ account_id: donor.publicKey(), sequence: '4e2' }),
    new Response('x'.repeat(65537), { headers: { 'Content-Type': 'application/json' } }),
    new Response(null, { status: 302, headers: { Location: 'https://evil.test' } })]) {
    const journal = new Journal();
    const flow = createDonationFlow({ ...context, journal, uuid: () => id, now: () => 1800000000,
      fetcher: (async () => response) as typeof fetch, signTransaction: async () => { throw Error('must not sign'); } });
    await expect(flow.prepare('1')).rejects.toThrow(/^d1_account_unavailable$/);
    expect(journal.mutations).toBe(0); expect(await flow.recover()).toBeNull();
  }
});

test('invalid decimal input and stale context reject before network, UUID or durable mutation', async () => {
  for (const amount of ['0', '-1', '1e2', '1,2', '1.00000001', 'NaN', ' 1', '01', '922337203686']) {
    const f = fixture(); await expect(f.flow.prepare(amount)).rejects.toThrow(/^d1_flow_invalid_amount$/);
    expect(f.calls).toEqual({ uuid: 0, account: 0, sign: 0, send: 0 }); expect(f.journal.mutations).toBe(0);
  }
  const f = fixture(); f.flow.dispose();
  await expect(f.flow.prepare('1')).rejects.toThrow(/^d1_flow_inactive$/);
  expect(f.journal.mutations).toBe(0); expect(f.requests).toEqual([]);
});

function observationReplies(snapshot: { unsignedXdr: string; transactionHash: string; signedTxXdr: string }, confirmedAt = 1800000000) {
  const closed = new Date(confirmedAt * 1000).toISOString().replace('.000Z', 'Z');
  const result = new xdr.TransactionResult({ feeCharged: xdr.Int64.fromString('100'),
    result: xdr.TransactionResultResult.txSuccess([xdr.OperationResult.opInner(xdr.OperationResultTr.payment(xdr.PaymentResult.paymentSuccess()))]),
    ext: xdr.TransactionResultExt.fromXDR('00000000', 'hex') });
  const base = 'https://horizon-testnet.stellar.org/transactions/' + snapshot.transactionHash;
  const replies: Record<string, unknown> = {
    [base]: { hash: snapshot.transactionHash, successful: true, operation_count: 1, source_account: donor.publicKey(),
      source_account_sequence: new Transaction(snapshot.unsignedXdr, Networks.TESTNET).sequence, ledger: 123,
      envelope_xdr: snapshot.signedTxXdr, result_xdr: result.toXDR('base64'), created_at: closed },
    [base + '/operations?limit=2&order=asc']: { _embedded: { records: [{ type: 'payment', type_i: 1, transaction_successful: true,
      transaction_hash: snapshot.transactionHash, id: '1234', source_account: donor.publicKey(), from: donor.publicKey(), to: pool.publicKey(),
      amount: '1.0000000', asset_type: 'native', created_at: closed }] } },
    'https://horizon-testnet.stellar.org/ledgers/123': { sequence: 123, hash: 'a'.repeat(64), closed_at: closed },
  };
  return replies;
}

test('explicit original observation and validated cached evidence retain original +300s and never release repeat hold', async () => {
  const f = fixture(); const prepared = await f.flow.prepare('1'); const signed = await f.flow.sign(prepared.session);
  await f.flow.send(signed);
  if (!('signedTxXdr' in signed.snapshot)) throw Error('fixture unsigned');
  const replies = observationReplies(signed.snapshot);
  const urls: string[] = [];
  const observer = createDonationFlow({ ...context, journal: f.journal, uuid: () => { throw Error('no uuid'); }, now: () => 1900000000,
    fetcher: (async (url, init) => { urls.push(String(url)); expect(init?.method).toBe('GET'); return Response.json(replies[String(url)]); }) as typeof fetch,
    signTransaction: async () => { throw Error('no wallet'); } });
  const observation = await observer.check(signed);
  expect(observation.state).toBe('observed');
  if (observation.state !== 'observed') throw Error('fixture unresolved');
  expect(urls).toEqual(Object.keys(replies)); expect(f.journal.mutations).toBe(3);
  f.journal.cache(observation.evidence);
  const recovery = await observer.recover();
  expect(recovery?.deadline).toBe('2027-01-15T08:05:00Z');
  expect(recovery?.evidence).toEqual(observation.evidence); expect(recovery?.repeatBlocked).toBe(true);
  expect(await observer.prepare('99')).toEqual(recovery); expect(f.journal.mutations).toBe(3);
  for (const evidence of [{ ...observation.evidence, request_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
    { ...observation.evidence, payment: { ...observation.evidence.payment, amount: '2.0000000' } },
    { ...observation.evidence, ledger: { ...observation.evidence.ledger, closed_at: '2027-01-15T08:01:00Z' } }]) {
    f.journal.cache(evidence);
    await expect(observer.recover()).rejects.toThrow(/^d1_stored_donation_evidence_invalid$/);
    await expect(observer.prepare('3')).rejects.toThrow(/^d1_stored_donation_evidence_invalid$/);
    expect(f.journal.mutations).toBe(3);
  }
});
