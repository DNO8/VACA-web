import { test, expect } from '@playwright/test';
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { Keypair, Networks, Transaction, xdr } from '@stellar/stellar-sdk';
import { buildDonationTransaction } from '../../src/lib/d1/donation-transaction';
import { parseDonationEvidence } from '../../src/lib/d1/donation-evidence';

// Synthetic keys and offline raw JSON; no observer or financial action.
const seed = Buffer.alloc(32, 41);
const donor = Keypair.fromRawEd25519Seed(seed);
const pool = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 42));
const uuid = '12345678-1234-1234-1234-123456789abc';
const date = '2024-01-01T00:00:05Z';
function fixture() {
  const built = buildDonationTransaction({
    config: { network: 'TESTNET', namespace: uuid, pool_public_key: pool.publicKey(), donation_ttl_seconds: 300 },
    request_id: uuid, donor: donor.publicKey(), incident_id: 'independent original',
    asset: { type: 'native' }, amount: '3.0000007',
  }, { sequence: '9007199254740994', fee: '100', timebounds: { minTime: 1704067200, maxTime: 1704067260 } });
  const tx = new Transaction(built.unsignedXdr, Networks.TESTNET);
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
  const digest = createHash('sha256').update(tx.signatureBase()).digest();
  expect(digest.toString('hex')).toBe(built.transactionHash);
  tx.addSignature(donor.publicKey(), sign(null, digest, key).toString('base64'));
  const result = new xdr.TransactionResult({ feeCharged: xdr.Int64.fromString('100'),
    result: xdr.TransactionResultResult.txSuccess([xdr.OperationResult.opInner(
      xdr.OperationResultTr.payment(xdr.PaymentResult.paymentSuccess()))]),
    ext: xdr.TransactionResultExt.fromXDR('00000000', 'hex') }).toXDR('base64');
  return JSON.parse(JSON.stringify({ snapshot: { ...built, signedTxXdr: tx.toXDR() },
    transaction: { hash: built.transactionHash, successful: true, operation_count: 1,
      source_account: donor.publicKey(), source_account_sequence: tx.sequence, ledger: 19,
      envelope_xdr: tx.toXDR(), result_xdr: result, created_at: date },
    operations: { _embedded: { records: [{ type: 'payment', type_i: 1, transaction_successful: true,
      transaction_hash: built.transactionHash, id: '9007199254740995', source_account: donor.publicKey(),
      from: donor.publicKey(), to: pool.publicKey(), amount: '3.0000007', asset_type: 'native', created_at: date }] } },
    ledger: { sequence: 19, hash: 'cd'.repeat(32), closed_at: date } }));
}
const parse = (f: ReturnType<typeof fixture>) => parseDonationEvidence(f.snapshot, f.transaction, f.operations, f.ledger);
const fingerprint = (f: unknown) => createHash('sha256').update(JSON.stringify(f)).digest('hex');
function rejects(f: ReturnType<typeof fixture>) {
  const before = fingerprint(f);
  expect(() => parse(f)).toThrow(/^d1_donation_evidence_invalid$/);
  expect(fingerprint(f)).toBe(before);
}

test('S1-S3: canonical success cannot override contradictory original evidence', () => {
  const f = fixture();
  expect(parse(f).payment.amount).toBe('3.0000007');
  const other = new Transaction(f.snapshot.unsignedXdr, Networks.TESTNET);
  const envelope = other.toEnvelope();
  envelope.v1().tx().fee(200);
  const changed = new Transaction(envelope, Networks.TESTNET);
  changed.sign(donor);
  f.transaction.envelope_xdr = changed.toXDR();
  rejects(f); // Correct signature and successful result, but different signed body.
  const g = fixture();
  g.operations._embedded.records[0].amount = '2.0000007';
  rejects(g);
  const h = fixture();
  h.ledger.sequence++;
  rejects(h);
});

test('S1-S3: optional JSON depth boundary and hostile nested getter stay inert', () => {
  const f = fixture();
  let metadata: unknown = null;
  for (let n = 0; n < 31; n++) metadata = { child: metadata };
  f.transaction.metadata = metadata;
  expect(parse(f).ledger.closed_at).toBe(date);
  f.transaction.metadata = { child: metadata };
  rejects(f);
  const g = fixture();
  let calls = 0;
  const leaf = Object.defineProperty({}, 'href', { enumerable: true, get() { calls++; throw new Error('private detail'); } });
  g.operations._links = { next: [leaf] };
  expect(() => parse(g)).toThrow(/^d1_donation_evidence_invalid$/);
  expect(calls).toBe(0);
  expect(Object.getOwnPropertyDescriptor(leaf, 'href')?.get).toBeDefined();
});

test('S1-S3/S10: signature variance is allowed, output cannot renew or unlock', () => {
  const f = fixture();
  const tx = new Transaction(f.snapshot.signedTxXdr, Networks.TESTNET);
  tx.sign(pool);
  f.transaction.envelope_xdr = tx.toXDR() + '\n';
  const before = fingerprint(f);
  const result = parse(f);
  expect(fingerprint(f)).toBe(before);
  expect(Object.keys(result).sort()).toEqual(['config', 'incident_id', 'ledger', 'payment', 'request_id']);
  const saved = JSON.stringify(result);
  f.snapshot.intent.amount = '9.0000000';
  f.snapshot.intent.config.namespace = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
  f.ledger.closed_at = '2025-01-01T00:00:00Z';
  expect(JSON.stringify(result)).toBe(saved);
  expect(result.payment.confirmedAt).toBe(1704067205);
  expect(result.payment.amount).toBe('3.0000007');
  for (const value of [result, result.config, result.payment, result.payment.asset, result.ledger]) expect(Object.isFrozen(value)).toBe(true);
});
