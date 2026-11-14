import type { DonationJournal } from './donation-journal';
import { readDonation } from './donation-session';
import { receiptRecord } from './receipt-context';

export type DonationSubmission = Readonly<{ requestId: string; transactionHash: string } & (
  { state: 'response_unverified'; httpStatus: number } |
  { state: 'unknown' | 'already_claimed' }
)>;
export type DonationSubmissionErrorCode = 'invalid_fetcher' | 'not_found' | 'unsigned' | 'storage_error' | 'invalid_claim';
/** Pre-transport rejection only. A failed claim acknowledgement can still leave a durable claim. */
export class DonationSubmissionError extends Error {
  constructor(readonly code: DonationSubmissionErrorCode) {
    super(`d1_submission_${code}`);
    this.name = 'DonationSubmissionError';
  }
}

/** Never read a response body or wait for cancellation (including after the deadline). */
function discard(response: Response): void {
  try { void Promise.resolve(response.body?.cancel()).catch(() => {}); }
  catch { /* A malformed response or locked body cannot grant another send. */ }
}

/** Explicit one-shot transport only: every result is unverified, never payment evidence. */
export async function submitDonation(
  journal: DonationJournal,
  expectedIntent: unknown,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<DonationSubmission> {
  if (typeof fetcher !== 'function') throw new DonationSubmissionError('invalid_fetcher');
  const current = await readDonation(journal, expectedIntent);
  if (!current) throw new DonationSubmissionError('not_found');
  if (current.state === 'intent') throw new DonationSubmissionError('unsigned');
  const identity = { requestId: current.requestId, transactionHash: current.snapshot.transactionHash };
  const already = () => Object.freeze({ ...identity, state: 'already_claimed' as const });
  if (current.state === 'submission_claimed') return already();

  const signedBytes = JSON.stringify(current.snapshot);
  // Strip only the signed envelope; object rest preserves the original canonical property order.
  const { signedTxXdr, ...unsigned } = current.snapshot;
  const unsignedBytes = JSON.stringify(unsigned);
  let acknowledgement: unknown;
  try { acknowledgement = await journal.claimSubmission(current.requestId, signedBytes); }
  catch { throw new DonationSubmissionError('storage_error'); }

  let won: boolean;
  try {
    const ack = receiptRecord(acknowledgement, ['claimed', 'record']);
    const record = receiptRecord(ack.record, ['scope', 'requestId', 'intent', 'state', 'signed']);
    if (typeof ack.claimed !== 'boolean' || record.scope !== current.scope || record.requestId !== current.requestId ||
      record.intent !== unsignedBytes || record.signed !== signedBytes || record.state !== 'submission_claimed') {
      throw new Error('invalid acknowledgement');
    }
    won = ack.claimed;
  } catch { throw new DonationSubmissionError('invalid_claim'); }
  if (!won) return already();

  // From here on, failure is unknown and the claim is permanent. No storage writes or retries.
  const unknown = Object.freeze({ ...identity, state: 'unknown' as const });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const controller = new AbortController();
    const deadline = new Promise<DonationSubmission>(resolve => {
      timer = setTimeout(() => {
        resolve(unknown);
        controller.abort();
      }, 10_000);
    });
    const request = Promise.resolve().then(() => fetcher('https://horizon-testnet.stellar.org/transactions', {
      method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ tx: signedTxXdr }), signal: controller.signal,
    })).then((response): DonationSubmission => {
      try {
        const status = response?.status;
        if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599) return unknown;
        return Object.freeze({ ...identity, state: 'response_unverified', httpStatus: status });
      } finally { discard(response); }
    }).catch(() => unknown);
    // Abort alone cannot bound an injected implementation that ignores its signal.
    // Both handlers stay attached so late fulfillment is discarded and rejection is consumed.
    return await Promise.race([request, deadline]);
  } catch { return unknown; }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
