import { validateD1Config, type D1Config } from './commands';
import { assertProfileConfig, profileBase, type D1Profile } from './profile';

export type PublicConfigResult = { status: 'available'; config: D1Config } | { status: 'unavailable' | 'cancelled' };

/** Read public technical configuration only; never a payment or custody assertion. */
export async function readD1PublicConfig(signal: AbortSignal, fetcher: typeof fetch = fetch, timeoutMs = 5000, profile: D1Profile = 'A'): Promise<PublicConfigResult> {
  if (signal.aborted) return { status: 'cancelled' };
  let bounded: AbortSignal;
  let base: string;
  try {
    base = profileBase(profile);
    // Unsupported browsers fail closed rather than issue an unbounded request.
    bounded = AbortSignal.any([signal, AbortSignal.timeout(Math.min(5000, timeoutMs))]);
  } catch { return { status: 'unavailable' }; }
  return new Promise(resolve => {
    let finished = false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const finish = (result: PublicConfigResult) => {
      if (finished) return;
      finished = true;
      bounded.removeEventListener('abort', abort);
      resolve(result);
    };
    const cancelBody = () => { void reader?.cancel().catch(() => {}); };
    const abort = () => {
      cancelBody();
      finish({ status: signal.aborted ? 'cancelled' : 'unavailable' });
    };
    bounded.addEventListener('abort', abort, { once: true });
    if (bounded.aborted) { abort(); return; }
    void (async () => {
      try {
        const response = await fetcher(`${base}/config`, {
          method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store', signal: bounded,
        });
        if (finished || response.status !== 200 || response.redirected || !response.body) {
          void response.body?.cancel().catch(() => {});
          finish({ status: 'unavailable' });
          return;
        }
        reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8', { fatal: true });
        let bytes = 0;
        let text = '';
        while (!finished) {
          const chunk = await reader.read();
          if (finished) return;
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 4096) { cancelBody(); finish({ status: 'unavailable' }); return; }
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
        const config = validateD1Config(JSON.parse(text));
        assertProfileConfig(profile, config);
        finish({ status: 'available', config });
      } catch {
        cancelBody();
        finish({ status: signal.aborted ? 'cancelled' : 'unavailable' });
      } finally { reader?.releaseLock(); }
    })();
  });
}
