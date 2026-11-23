import { matchesBCommand, profileCommandFetcher, type D1Profile } from './profile';

export type AdminRoute = 'prepare' | 'issue' | 'reconcile' | 'refund-status' | 'refund' | 'refund-reconcile' | 'refund-remainder-status' | 'refund-remainder' | 'refund-remainder-reconcile';
export type AdminResponse = Readonly<{ status: number; body: unknown }>;
const routes: readonly string[] = ['prepare', 'issue', 'reconcile', 'refund-status', 'refund', 'refund-reconcile', 'refund-remainder-status', 'refund-remainder', 'refund-remainder-reconcile'];

/** One bounded, credential-free POST. An acknowledgement is never a financial result. */
export async function postAdminCommand(route: AdminRoute, body: string, fetcher: typeof fetch, profile: D1Profile = 'A'): Promise<AdminResponse> {
  if (!routes.includes(route) || typeof body !== 'string' || new TextEncoder().encode(body).byteLength > 8192) throw new Error('d1_admin_invalid_transport');
  const selectedFetch = profileCommandFetcher(profile, fetcher);
  // Resolve profile/scope rejection before the transport's unknown-outcome boundary.
  if (profile === 'B') {
    let valid = false;
    try { valid = matchesBCommand(JSON.parse(body), route); } catch { /* Invalid JSON is not a B command. */ }
    if (!valid) throw new Error('d1_profile_scope_mismatch');
  }
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let response: Response | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    try { void Promise.resolve(reader ? reader.cancel() : response?.body?.cancel()).catch(() => {}); } catch { /* Best effort only. */ }
  };
  const work = async (): Promise<AdminResponse> => {
    try {
      response = await selectedFetch(`/api/d1/${route}`, { method: 'POST', body, headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', signal: controller.signal });
      if (controller.signal.aborted || response.redirected || !response.body || response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new Error('invalid response');
      reader = response.body.getReader();
      let text = '', size = 0;
      const decoder = new TextDecoder('utf-8', { fatal: true });
      while (true) {
        const chunk = await reader.read();
        if (controller.signal.aborted) throw new Error('expired');
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 65536) throw new Error('oversize');
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
      return Object.freeze({ status: response.status, body: JSON.parse(text) as unknown });
    } catch { cancel(); throw new Error('d1_admin_transport_unknown'); }
    finally { try { reader?.releaseLock(); } catch { /* Pending reads may ignore abort. */ } }
  };
  try {
    return await Promise.race([work(), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); cancel(); reject(new Error('d1_admin_transport_unknown')); }, 10_000);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

/** Show only the backend's bounded machine error; never render arbitrary response content. */
export function assertAdminResponse(response: AdminResponse, allowed: readonly number[]): void {
  if (allowed.includes(response.status)) return;
  const descriptor = response.body && typeof response.body === 'object' ? Object.getOwnPropertyDescriptor(response.body, 'error') : undefined;
  const code: unknown = descriptor && 'value' in descriptor ? descriptor.value : undefined;
  throw new Error(`d1_admin_http_${response.status}:${typeof code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : 'unknown'}`);
}
