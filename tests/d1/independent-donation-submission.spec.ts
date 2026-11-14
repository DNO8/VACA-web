import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { Keypair, Networks, Transaction } from '@stellar/stellar-sdk';
import type { DonationJournal, DonationJournalRecord } from '../../src/lib/d1/donation-journal';
import { buildDonationTransaction, validateSignedDonation } from '../../src/lib/d1/donation-transaction';
import { submitDonation } from '../../src/lib/d1/donation-submission';

const donor = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 81));
const pool = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 82));
const id = '11111111-2222-3333-4444-555555555555';
const intent = { config: { network: 'TESTNET', pool_public_key: pool.publicKey(), namespace: id,
  donation_ttl_seconds: 300 }, request_id: id, donor: donor.publicKey(), incident_id: 'probe:incident',
  asset: { type: 'native' }, amount: '2.0000001' };
const unsigned = buildDonationTransaction(intent, { sequence: '42', fee: '100',
  timebounds: { minTime: 0, maxTime: 1900000000 } });
const tx = new Transaction(unsigned.unsignedXdr, Networks.TESTNET);
tx.sign(donor);
const signed = validateSignedDonation(unsigned, { signerAddress: donor.publicKey(),
  signedTxXdr: ' \n' + tx.toXDR() + '\n ' });
const original: Extract<DonationJournalRecord, { signed: string }> = {
  scope: JSON.stringify(['TESTNET', pool.publicKey(), id, donor.publicKey(), intent.incident_id]),
  requestId: id, intent: JSON.stringify(unsigned), state: 'signed', signed: JSON.stringify(signed),
};
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
class Journal implements DonationJournal {
  record: Extract<DonationJournalRecord, { signed: string }> = { ...original };
  claims = 0;
  acknowledge: (value: unknown) => unknown = value => value;
  async read() { return { ...this.record }; }
  async acquire(): Promise<never> { throw new Error('unexpected acquire'); }
  async saveSigned(): Promise<never> { throw new Error('unexpected signing'); }
  async claimSubmission(requestId: string, bytes: string) {
    expect(requestId).toBe(id);
    expect(bytes).toBe(original.signed);
    this.claims++;
    this.record = { ...this.record, state: 'submission_claimed' };
    return this.acknowledge({ claimed: true, record: { ...this.record } }) as
      Awaited<ReturnType<DonationJournal['claimSubmission']>>;
  }
  close() {}
}
const identity = { requestId: id, transactionHash: unsigned.transactionHash };

test('S10: committed claim with lost acknowledgement blocks repeat after reload', async () => {
  const journal = new Journal();
  let sends = 0;
  const fetcher = (async () => { sends++; return new Response(); }) as typeof fetch;
  journal.acknowledge = () => { throw new Error('lost acknowledgement'); };
  await expect(submitDonation(journal, intent, fetcher)).rejects.toThrow(/^d1_submission_storage_error$/);
  const retained = digest(journal.record);
  expect(journal.record.state).toBe('submission_claimed');
  const reload = new Journal();
  reload.record = { ...journal.record };
  for (const adapter of [journal, reload]) {
    const outcome = await submitDonation(adapter, intent, fetcher);
    expect(outcome).toEqual({ ...identity, state: 'already_claimed' });
    expect(Object.isFrozen(outcome)).toBe(true);
    expect(digest(adapter.record)).toBe(retained);
  }
  expect(journal.claims).toBe(1);
  expect(reload.claims).toBe(0);
  expect(sends).toBe(0);
});

test('S1/S10: nested acknowledgement getter cannot rewrite identity or authorize sending', async () => {
  const journal = new Journal();
  let getters = 0, sends = 0;
  journal.acknowledge = () => ({ claimed: true, record: {
    ...journal.record, get signed() { getters++; journal.record = { ...journal.record, requestId: 'changed' }; return original.signed; },
  } });
  const fetcher = (async () => { sends++; return new Response(); }) as typeof fetch;
  await expect(submitDonation(journal, intent, fetcher)).rejects.toThrow(/^d1_submission_invalid_claim$/);
  expect(getters).toBe(0);
  expect(sends).toBe(0);
  expect(digest(journal.record)).toBe(digest({ ...original, state: 'submission_claimed' }));
  const retained = digest(journal.record);
  expect(await submitDonation(journal, intent, fetcher)).toEqual({ ...identity, state: 'already_claimed' });
  expect(digest(journal.record)).toBe(retained);
  expect(journal.claims).toBe(1);
});

test('S1/S10: hostile HTTP body cannot substitute hash or confer retry authority', async () => {
  const journal = new Journal();
  let bodyReads = 0, cancels = 0, sends = 0;
  const fetcher = (async (url: RequestInfo | URL, options?: RequestInit) => {
    sends++;
    expect(journal.record.state).toBe('submission_claimed');
    expect(url).toBe('https://horizon-testnet.stellar.org/transactions');
    expect(options).toMatchObject({ method: 'POST', credentials: 'omit', redirect: 'error',
      cache: 'no-store', referrerPolicy: 'no-referrer' });
    expect(Array.from((options!.body as URLSearchParams).entries())).toEqual([['tx', signed.signedTxXdr]]);
    return { status: 202, transactionHash: 'f'.repeat(64),
      get json() { bodyReads++; throw new Error('untrusted replacement body'); },
      get text() { bodyReads++; throw new Error('untrusted replacement body'); },
      body: { cancel() { cancels++; return Promise.resolve(); } } };
  }) as unknown as typeof fetch;
  const outcome = await submitDonation(journal, intent, fetcher);
  expect(outcome).toEqual({ ...identity, state: 'response_unverified', httpStatus: 202 });
  expect(Object.isFrozen(outcome)).toBe(true);
  expect(bodyReads).toBe(0);
  expect(cancels).toBe(1);
  const retained = digest(journal.record);
  expect(await submitDonation(journal, intent, fetcher)).toEqual({ ...identity, state: 'already_claimed' });
  expect(digest(journal.record)).toBe(retained);
  expect(sends).toBe(1);
});
