import { test, expect } from '@playwright/test';
import { Keypair, Networks, Transaction, xdr } from '@stellar/stellar-sdk';
import { buildDonationTransaction, validateSignedDonation } from '../../src/lib/d1/donation-transaction';
import { observeDonation } from '../../src/lib/d1/donation-observation';
import type { DonationJournal } from '../../src/lib/d1/donation-journal';

function setup() {
  const donor = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 21));
  const pool = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 22)).publicKey();
  const id = '11111111-2222-4333-8444-555555555555';
  const unsigned = buildDonationTransaction({ request_id: id, donor: donor.publicKey(),
    incident_id: 'independent-observation', amount: '2.0000001', asset: { type: 'native' },
    config: { network: 'TESTNET', pool_public_key: pool, namespace: id, donation_ttl_seconds: 300 },
  }, { sequence: '42', fee: '100', timebounds: { minTime: 1700000000, maxTime: 1700000060 } });
  const tx = new Transaction(unsigned.unsignedXdr, Networks.TESTNET);
  tx.sign(donor);
  const signed = validateSignedDonation(unsigned, { signedTxXdr: tx.toXDR(), signerAddress: donor.publicKey() });
  const result = new xdr.TransactionResult({ feeCharged: xdr.Int64.fromString('100'),
    result: xdr.TransactionResultResult.txSuccess([
      xdr.OperationResult.opInner(xdr.OperationResultTr.payment(xdr.PaymentResult.paymentSuccess())),
    ]), ext: xdr.TransactionResultExt.fromXDR('00000000', 'hex') }).toXDR('base64');
  const closed_at = '2023-11-14T22:13:25Z';
  const reports = [
    { hash: signed.transactionHash, successful: true, operation_count: 1, ledger: 9,
      source_account: donor.publicKey(), source_account_sequence: tx.sequence,
      envelope_xdr: tx.toXDR(), result_xdr: result, created_at: closed_at },
    { _embedded: { records: [{ type: 'payment', type_i: 1, transaction_successful: true,
      transaction_hash: signed.transactionHash, id: '123456789', source_account: donor.publicKey(),
      from: donor.publicKey(), to: pool, amount: '2.0000001', asset_type: 'native', created_at: closed_at }] } },
    { sequence: 9, hash: 'cd'.repeat(32), closed_at },
  ];
  const record = { scope: JSON.stringify(['TESTNET', pool, id, donor.publicKey(), unsigned.intent.incident_id]),
    requestId: id, intent: JSON.stringify(unsigned), state: 'submission_claimed' as const, signed: JSON.stringify(signed) };
  let writes = 0;
  const forbidden = async (): Promise<never> => { writes++; throw Error('unexpected write'); };
  const journal: DonationJournal = { read: async () => record, acquire: forbidden,
    saveSigned: forbidden, claimSubmission: forbidden, close: () => { writes++; } };
  return { signed, reports, record, journal, writes: () => writes };
}
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

// S1-S3/S10: byte accounting must not confuse UTF-16 length with streamed UTF-8 bytes.
test('split multibyte JSON accepts exact byte cap and rejects one extra byte', async () => {
  for (const size of [65536, 65537]) {
    const f = setup(), before = JSON.stringify(f.record);
    const encoded = Buffer.from(JSON.stringify({ ...f.reports[0], note: '😀é' }));
    const bytes = Buffer.concat([encoded, Buffer.alloc(size - encoded.length, 32)]);
    const split = encoded.indexOf(Buffer.from('😀')) + 1;
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      if (calls++) return json(f.reports[calls - 1]);
      return new Response(new ReadableStream<Uint8Array>({ start(c) {
        c.enqueue(bytes.subarray(0, split)); c.enqueue(bytes.subarray(split, split + 1));
        c.enqueue(bytes.subarray(split + 1)); c.close();
      } }), { headers: { 'Content-Type': 'application/hal+json', 'Content-Length': '1' } });
    };
    const value = await observeDonation(f.journal, f.signed.intent, fetcher);
    expect(value.state).toBe(size === 65536 ? 'observed' : 'unresolved');
    expect(calls).toBe(size === 65536 ? 3 : 1);
    expect(JSON.stringify(f.record)).toBe(before); expect(f.writes()).toBe(0);
  }
});

// S1-S3/S10: caller mutation after validation must not redirect or renew the original payment.
test('GET callback cannot replace validated caller identity or economics', async () => {
  const f = setup(), before = JSON.stringify(f.record);
  const intent = JSON.parse(JSON.stringify(f.signed.intent));
  const urls: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    urls.push(String(url));
    expect(init).toMatchObject({ method: 'GET', credentials: 'omit', redirect: 'error',
      cache: 'no-store', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' } });
    intent.request_id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    intent.amount = '99.0000000'; intent.config.pool_public_key = intent.donor;
    return json({ ...f.reports[urls.length - 1], _links: { next: { href: 'https://evil.invalid/' } } });
  };
  const value = await observeDonation(f.journal, intent, fetcher);
  expect(value.state).toBe('observed');
  if (value.state !== 'observed') throw Error('missing evidence');
  expect(value.requestId).toBe(f.signed.intent.request_id);
  expect(value.evidence.payment.amount).toBe('2.0000001');
  expect(value.evidence.config).toEqual(f.signed.intent.config);
  expect(Object.isFrozen(value.evidence.config)).toBe(true);
  const base = `https://horizon-testnet.stellar.org/transactions/${f.signed.transactionHash}`;
  expect(urls).toEqual([base, `${base}/operations?limit=2&order=asc`, 'https://horizon-testnet.stellar.org/ledgers/9']);
  expect(JSON.stringify(f.record)).toBe(before); expect(f.writes()).toBe(0);
});
