import type { DonationJournal } from './donation-journal';
import { parseDonationEvidence, type DonationEvidence } from './donation-evidence';
import { readDonation } from './donation-session';

export type DonationObservation = Readonly<{ requestId: string; transactionHash: string } & (
  { state: 'observed'; evidence: DonationEvidence } | { state: 'unresolved' }
)>;
export type DonationObservationErrorCode = 'invalid_fetcher' | 'not_found' | 'not_submitted';
/** Pre-network rejection only; existing sanitized session/validation errors also propagate. */
export class DonationObservationError extends Error {
  constructor(readonly code: DonationObservationErrorCode) {
    super(`d1_observation_${code}`);
    this.name = 'DonationObservationError';
  }
}
function active(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('observation aborted');
}

/** Bounded raw JSON only. Cancellation is best effort and must never delay the deadline. */
async function readJson(url: string, fetcher: typeof fetch, signal: AbortSignal): Promise<unknown> {
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let cancelled = false, released = false;
  const release = () => {
    if (!reader || released) return;
    try { reader.releaseLock(); released = true; }
    catch { /* A nonstandard reader may still have a pending read; finally tries again. */ }
  };
  const cancel = () => {
    // An abort before fetch resolves still requires discarding the eventual late response.
    if (cancelled || !response) return;
    cancelled = true;
    try { void Promise.resolve(reader ? reader.cancel() : response.body?.cancel()).catch(() => {}); }
    catch { /* Response getters and cancellation may throw; neither grants another request. */ }
    release();
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    active(signal);
    response = await fetcher(url, {
      method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer',
      headers: { Accept: 'application/json' }, signal,
    });
    active(signal);
    if (response.status !== 200 || response.redirected === true ||
      (response.url !== '' && response.url !== url)) throw new Error('invalid response');
    const media = response.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase();
    if (media !== 'application/json' && media !== 'application/hal+json') throw new Error('invalid media');
    if (!response.body) throw new Error('missing body');
    reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let bytes = 0, text = '';
    while (true) {
      active(signal);
      const chunk = await reader.read();
      active(signal);
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array) || chunk.value.byteLength === 0) throw new Error('invalid chunk');
      bytes += chunk.value.byteLength;
      if (bytes > 65536) throw new Error('body too large');
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text) as unknown;
  } catch {
    cancel();
    throw new Error('invalid observation response');
  } finally {
    signal.removeEventListener('abort', cancel);
    release(); // Fully consumed successful streams need only release their reader lock.
  }
}

/** Explicit readonly Horizon report observation, never settlement or cryptographic inclusion proof. */
export async function observeDonation(
  journal: DonationJournal, expectedIntent: unknown, fetcher: typeof fetch = globalThis.fetch,
): Promise<DonationObservation> {
  if (typeof fetcher !== 'function') throw new DonationObservationError('invalid_fetcher');
  const current = await readDonation(journal, expectedIntent);
  if (!current) throw new DonationObservationError('not_found');
  if (current.state !== 'submission_claimed') throw new DonationObservationError('not_submitted');
  const identity = { requestId: current.requestId, transactionHash: current.snapshot.transactionHash };
  const unresolved = Object.freeze({ ...identity, state: 'unresolved' as const });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const controller = new AbortController();
    const { signal } = controller;
    const deadline = new Promise<DonationObservation>(resolve => {
      timer = setTimeout(() => {
        resolve(unresolved);
        controller.abort();
      }, 10_000);
    });
    const request = async (): Promise<DonationObservation> => {
      const base = `https://horizon-testnet.stellar.org/transactions/${identity.transactionHash}`;
      active(signal);
      const transaction = await readJson(base, fetcher, signal);
      active(signal);
      if (!transaction || typeof transaction !== 'object' || Array.isArray(transaction)) return unresolved;
      const tx = transaction as Record<string, unknown>;
      // Validate before deriving any ledger path or starting any subsequent GET.
      if (tx.hash !== identity.transactionHash || tx.successful !== true || tx.operation_count !== 1 ||
        typeof tx.ledger !== 'number' || !Number.isInteger(tx.ledger) || tx.ledger <= 0 || tx.ledger > 4294967295) return unresolved;
      active(signal);
      const operations = await readJson(`${base}/operations?limit=2&order=asc`, fetcher, signal);
      active(signal);
      const ledger = await readJson(`https://horizon-testnet.stellar.org/ledgers/${tx.ledger}`, fetcher, signal);
      active(signal);
      const evidence = parseDonationEvidence(current.snapshot, transaction, operations, ledger);
      return Object.freeze({ ...identity, state: 'observed', evidence });
    };
    // Abort alone cannot bound injected fetch/body implementations that ignore the signal.
    // The attached catch consumes late failures; each await checks abort before proceeding.
    return await Promise.race([request().catch(() => unresolved), deadline]);
  } catch { return unresolved; }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
