import { StrKey } from '@stellar/stellar-sdk';

export type ProxyEnvironment = {
  D1_CUSTODY_SUPABASE_URL?: string;
  D1_CUSTODY_ANON_KEY?: string;
  D1_CUSTODY_NAMESPACE?: string;
};

const REQUEST_LIMIT = 8192;
const RESPONSE_LIMIT = 65536;
const TIMEOUT_MS = 10_000;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

function error(code: string, status: number): Response {
  return json({ error: code }, status);
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function decodePart(part: string): unknown {
  const bytes = Buffer.from(part, 'base64url');
  if (bytes.toString('base64url') !== part) throw new Error('invalid encoding');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

function configuration(env: ProxyEnvironment) {
  const match = /^https:\/\/([a-z0-9]{20})\.supabase\.co\/?$/.exec(env.D1_CUSTODY_SUPABASE_URL ?? '');
  const key = env.D1_CUSTODY_ANON_KEY ?? '';
  const namespace = env.D1_CUSTODY_NAMESPACE ?? '';
  if (!match || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(namespace)) return null;
  if (key.length > 8192 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(key)) return null;
  try {
    const [headerPart, payloadPart, signature] = key.split('.');
    const header = decodePart(headerPart);
    const payload = decodePart(payloadPart);
    // Configuration guard only: the deployed gateway verifies the actual JWT signature.
    if (!object(header) || header.alg !== 'HS256' || header.typ !== 'JWT' ||
        !object(payload) || payload.role !== 'anon' || payload.ref !== match[1] ||
        Buffer.from(signature, 'base64url').toString('base64url') !== signature) return null;
    return { origin: `https://${match[1]}.supabase.co`, key, namespace };
  } catch {
    return null;
  }
}

class BodyLimitError extends Error {}

async function readBounded(body: ReadableStream<Uint8Array> | null, limit: number, signal?: AbortSignal): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        cancel();
        throw new BodyLimitError();
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } finally {
    signal?.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

function parseJson(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

function isJson(headers: Headers): boolean {
  return headers.get('content-type')?.split(';')[0].trim().toLowerCase() === 'application/json';
}

function validConfig(value: unknown): value is Record<string, unknown> {
  return object(value) && Object.keys(value).sort().join(',') === 'donation_ttl_seconds,network,pool_public_key' &&
    value.network === 'TESTNET' && value.donation_ttl_seconds === 300 &&
    typeof value.pool_public_key === 'string' && StrKey.isValidEd25519PublicKey(value.pool_public_key);
}

export async function proxyD1(
  request: Request,
  action: string,
  dependencies: { env: ProxyEnvironment; fetch: typeof fetch },
): Promise<Response> {
  if (!['config', 'prepare', 'issue', 'reconcile'].includes(action)) return error('unsupported_action', 404);
  const method = action === 'config' ? 'GET' : 'POST';
  if (request.method !== method) return error('method_not_allowed', 405);
  const url = new URL(request.url);
  if (url.pathname !== `/api/d1/${action}` || url.search || url.hash || request.url.includes('?') || request.url.includes('#')) {
    return error('invalid_path', 400);
  }
  const settings = configuration(dependencies.env);
  if (!settings) return error('configuration_error', 503);

  let body: Uint8Array | undefined;
  if (method === 'POST') {
    if (!isJson(request.headers)) return error('unsupported_media_type', 415);
    try {
      body = await readBounded(request.body, REQUEST_LIMIT);
      if (!object(parseJson(body))) return error('invalid_json', 400);
    } catch (cause) {
      return cause instanceof BodyLimitError ? error('body_too_large', 413) : error('invalid_json', 400);
    }
  }

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<Response>(resolve => {
    timer = setTimeout(() => {
      resolve(error('upstream_timeout', 504));
      controller.abort();
    }, TIMEOUT_MS);
  });
  const forward = async (): Promise<Response> => {
    let upstream: Response;
    try {
      upstream = await dependencies.fetch(`${settings.origin}/functions/v1/d1-custody/${action}`, {
        method,
        headers: {
          authorization: `Bearer ${settings.key}`, apikey: settings.key,
          accept: 'application/json', 'content-type': 'application/json',
        },
        body: body as BodyInit | undefined,
        redirect: 'manual', credentials: 'omit', cache: 'no-store', signal: controller.signal,
      });
    } catch {
      return error('upstream_unavailable', 502);
    }
    try {
      // Redirects are never followed; neither Location nor any upstream headers escape.
      if ((upstream.status >= 300 && upstream.status < 400) || !isJson(upstream.headers)) {
        void upstream.body?.cancel().catch(() => {});
        return error('invalid_upstream_response', 502);
      }
      const value = parseJson(await readBounded(upstream.body, RESPONSE_LIMIT, controller.signal));
      if (!upstream.ok) {
        if (!object(value) || Object.keys(value).length !== 1 || typeof value.error !== 'string' ||
            !/^[a-z][a-z0-9_]{0,63}$/.test(value.error)) return error('invalid_upstream_response', 502);
        return json(value, upstream.status);
      }
      if (action === 'config') {
        if (upstream.status !== 200 || !validConfig(value)) return error('invalid_upstream_response', 502);
        return json({ ...value, namespace: settings.namespace }, 200);
      }
      return json(value, upstream.status);
    } catch {
      return error('invalid_upstream_response', 502);
    }
  };
  try {
    return await Promise.race([timeout, forward()]);
  } finally {
    clearTimeout(timer!);
  }
}
