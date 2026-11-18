import { receiptAccount } from './receipt-context';

/** Credential-free, fixed-Testnet account sequence read. Never funds or mutates an account. */
export async function readDonationAccount(account: unknown, signal: AbortSignal, fetcher: typeof fetch = globalThis.fetch): Promise<string> {
  let address: string;
  try { address = receiptAccount(account); }
  catch { throw new Error('d1_account_invalid'); }
  if (typeof fetcher !== 'function' || signal.aborted) throw new Error('d1_account_unavailable');
  const url = `https://horizon-testnet.stellar.org/accounts/${address}`;
  const controller = new AbortController();
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const cancel = () => {
    try { void Promise.resolve(reader ? reader.cancel() : response?.body?.cancel()).catch(() => {}); }
    catch { /* Best effort only, never wait for cancellation. */ }
  };
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  const active = () => { if (controller.signal.aborted) throw new Error('aborted'); };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => { cancel(); reject(new Error('aborted')); }, { once: true });
      timer = setTimeout(abort, 5000);
      if (signal.aborted) abort();
    });
    const request = async () => {
      active();
      response = await fetcher(url, {
        method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer',
        headers: { Accept: 'application/json' }, signal: controller.signal,
      });
      active();
      const media = response.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase();
      if (response.status !== 200 || response.redirected || (response.url !== '' && response.url !== url) ||
        !['application/json', 'application/hal+json'].includes(media ?? '') || !response.body) throw new Error('response');
      reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let bytes = 0, text = '';
      while (true) {
        const chunk = await reader.read(); active();
        if (chunk.done) break;
        if (!(chunk.value instanceof Uint8Array) || chunk.value.byteLength === 0) throw new Error('chunk');
        bytes += chunk.value.byteLength;
        if (bytes > 65536) throw new Error('size');
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
      const data = JSON.parse(text);
      if (!data || typeof data !== 'object' || Array.isArray(data) || data.account_id !== address ||
        Object.hasOwn(data, 'account_id_muxed') || typeof data.sequence !== 'string' ||
        !/^(0|[1-9][0-9]{0,18})$/.test(data.sequence) || BigInt(data.sequence) >= BigInt('9223372036854775807')) throw new Error('account');
      return data.sequence as string;
    };
    // Keep rejection/cancellation handlers attached to late noncompliant transports too.
    return await Promise.race([request().catch(error => { cancel(); throw error; }), deadline]);
  } catch { throw new Error('d1_account_unavailable'); }
  finally {
    if (timer !== undefined) clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    try { reader?.releaseLock(); } catch { /* A late read releases only after cancellation. */ }
  }
}
