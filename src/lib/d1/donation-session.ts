import { Networks } from '@stellar/stellar-sdk';
import type { DonationJournal } from './donation-journal';
import { buildDonationTransaction, validateDonationIntent, validateSignedDonation, type DonationIntent, type DonationTransaction, type SignedDonation } from './donation-transaction';
import { receiptRecord } from './receipt-context';

export type DonationSession = Readonly<{ scope: string; requestId: string } & (
  { state: 'intent'; snapshot: DonationTransaction } |
  { state: 'signed' | 'submission_claimed'; snapshot: SignedDonation }
)>;
export type SignDonationTransaction = (xdr: string, options: { address: string; networkPassphrase: string }) => Promise<unknown>;
function check(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(`d1_session_${code}`);
}
function shape(value: unknown, keys: readonly string[], code = 'invalid_record') {
  try { return receiptRecord(value, keys); }
  catch { throw new Error(`d1_session_${code}`); }
}
function parse(value: string): unknown {
  try { return JSON.parse(value); }
  catch { throw new Error('d1_session_invalid_json'); }
}
async function storage<T>(action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch { throw new Error('d1_session_storage_error'); }
}
function scopeOf(intent: DonationIntent): string {
  const { network, pool_public_key, namespace } = intent.config;
  return JSON.stringify([network, pool_public_key, namespace, intent.donor, intent.incident_id]);
}
const snapshotKeys = ['intent', 'parameters', 'unsignedXdr', 'transactionHash'];
function payload(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1048576;
}
/** Rebuild rather than trusting JSON flags/hashes. This is binding, not storage authentication. */
function retained(value: unknown, scope: string, expected?: DonationIntent): DonationSession {
  const state = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, 'state')?.value : undefined;
  const signedState = state === 'signed' || state === 'submission_claimed';
  const data = shape(value, ['scope', 'requestId', 'intent', 'state', ...(signedState ? ['signed'] : [])]);
  check((state === 'intent' || signedState) && payload(data.intent) && (!signedState || payload(data.signed)), 'invalid_record');
  check(typeof data.scope === 'string' && data.scope.length > 0 && data.scope.length <= 4096 &&
    typeof data.requestId === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(data.requestId) && data.requestId.length === 36, 'invalid_record');
  const unsigned = shape(parse(data.intent), snapshotKeys, 'invalid_snapshot');
  const snapshot = buildDonationTransaction(unsigned.intent, unsigned.parameters);
  check(data.intent === JSON.stringify(snapshot), 'invalid_snapshot');
  check(data.scope === scope && data.scope === scopeOf(snapshot.intent) && data.requestId === snapshot.intent.request_id, 'identity_mismatch');
  if (expected) check(JSON.stringify(snapshot.intent) === JSON.stringify(expected), 'identity_mismatch');
  const identity = { scope, requestId: snapshot.intent.request_id };
  if (!signedState) return Object.freeze({ ...identity, state: 'intent', snapshot });
  const signed = shape(parse(data.signed as string), [...snapshotKeys, 'signedTxXdr'], 'invalid_snapshot');
  const validated = validateSignedDonation(snapshot, { signedTxXdr: signed.signedTxXdr, signerAddress: snapshot.intent.donor });
  check(data.signed === JSON.stringify(validated), 'invalid_snapshot');
  return Object.freeze({ ...identity, state, snapshot: validated });
}

/** Persist before any signing. A different pending UUID wins by scope, including its economics. */
export async function acquireDonation(journal: DonationJournal, intent: unknown, parameters: unknown): Promise<Readonly<{ acquired: boolean; record: DonationSession }>> {
  const snapshot = buildDonationTransaction(intent, parameters);
  const scope = scopeOf(snapshot.intent), bytes = JSON.stringify(snapshot);
  const result = shape(await storage(() => journal.acquire(scope, snapshot.intent.request_id, bytes)), ['acquired', 'record']);
  check(typeof result.acquired === 'boolean', 'invalid_record');
  const record = retained(result.record, scope);
  if (result.acquired) check(record.state === 'intent', 'invalid_record');
  // A newly acquired record, or the same UUID, must retain this exact proposal.
  if (result.acquired || record.requestId === snapshot.intent.request_id) {
    const { signedTxXdr: _signed, ...unsigned } = record.snapshot as SignedDonation;
    check(record.requestId === snapshot.intent.request_id && JSON.stringify(unsigned) === bytes, 'identity_mismatch');
  }
  return Object.freeze({ acquired: result.acquired, record });
}

/** The caller must retain the original full intent, not only a UUID or an incident. */
export async function readDonation(journal: DonationJournal, expectedIntent: unknown): Promise<DonationSession | null> {
  const expected = validateDonationIntent(expectedIntent);
  const record = await storage(() => journal.read(expected.request_id));
  return record === null ? null : retained(record, scopeOf(expected), expected);
}

/** Explicit one-shot wallet invocation only; no submission, retry, renewal or claim. */
export async function signDonation(journal: DonationJournal, expectedIntent: unknown, signTransaction: SignDonationTransaction): Promise<DonationSession> {
  const current = await readDonation(journal, expectedIntent);
  check(current, 'not_found');
  if (current.state !== 'intent') return current;
  const unsignedBytes = JSON.stringify(current.snapshot);
  let response: unknown;
  try {
    response = await signTransaction(current.snapshot.unsignedXdr, {
      address: current.snapshot.intent.donor, networkPassphrase: Networks.TESTNET,
    });
  } catch { throw new Error('d1_wallet_error'); }
  const signedBytes = JSON.stringify(validateSignedDonation(current.snapshot, response));
  // The journal resolves only on transaction completion. A rejection is never durable success.
  const saved = await storage(() => journal.saveSigned(current.requestId, unsignedBytes, signedBytes));
  const result = retained(saved, current.scope, current.snapshot.intent);
  check(result.state !== 'intent', 'invalid_record');
  check(JSON.stringify(result.snapshot) === signedBytes, 'identity_mismatch');
  return result; // An intervening claim stays claimed; never downgrade or send here.
}
