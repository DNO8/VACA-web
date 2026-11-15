import { test, expect } from '@playwright/test';
import { StrKey } from '@stellar/stellar-sdk';
import { proxyD1, type ProxyEnvironment } from '../../src/lib/d1/server-proxy';
import { GET, POST, HEAD, OPTIONS, PUT, PATCH, DELETE } from '../../src/app/api/d1/[action]/route';

const project = 'abcdefghijklmnopqrst';
const origin = `https://${project}.supabase.co`;
const namespace = '01234567-89ab-cdef-0123-456789abcdef';
const pool = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 1));
const config = { network: 'TESTNET', pool_public_key: pool, donation_ttl_seconds: 300 };
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const token = (payload: unknown = { role: 'anon', ref: project }, header: unknown = { alg: 'HS256', typ: 'JWT' }) =>
  `${encode(header)}.${encode(payload)}.${Buffer.alloc(32, 1).toString('base64url')}`;
const env: ProxyEnvironment = {
  D1_CUSTODY_SUPABASE_URL: origin,
  D1_CUSTODY_ANON_KEY: token(),
  D1_CUSTODY_NAMESPACE: namespace,
};

function request(action = 'prepare', body = '{"signature":"personal-proof"}', init: RequestInit = {}) {
  return new Request(`https://web.example/api/d1/${action}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body, ...init,
  });
}

function probe(upstream: () => Response | Promise<Response> = () => Response.json({ ok: true }), environment = env) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchMock: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init: init! });
    return upstream();
  };
  return { calls, run: (req: Request, action = 'prepare') => proxyD1(req, action, { env: environment, fetch: fetchMock }) };
}

async function result(response: Response, status: number, body: unknown) {
  expect(response.status).toBe(status);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('content-type')).toBe('application/json');
  expect([...response.headers.keys()].sort()).toEqual(['cache-control', 'content-type']);
  expect(await response.json()).toEqual(body);
}

test('Next adapter awaits Promise params and rejects unsupported routes/methods without fetch', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('network forbidden'); };
  try {
    await result(await GET(new Request('https://web.example/api/d1/unknown'), {
      params: Promise.resolve({ action: 'unknown' }),
    }), 404, { error: 'unsupported_action' });
    for (const [method, handler] of Object.entries({ POST, HEAD, OPTIONS, PUT, PATCH, DELETE })) {
      await result(await handler(new Request('https://web.example/api/d1/config', { method }), {
        params: Promise.resolve({ action: 'config' }),
      }), 405, { error: 'method_not_allowed' });
    }
    expect(calls).toBe(0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('GET config validates public deployment facts and adds only configured namespace', async () => {
  const p = probe(() => Response.json(config), { ...env, D1_CUSTODY_SUPABASE_URL: `${origin}/` });
  await result(await p.run(new Request('https://web.example/api/d1/config'), 'config'), 200, { ...config, namespace });
  expect(p.calls).toHaveLength(1);
  expect(p.calls[0].url).toBe(`${origin}/functions/v1/d1-custody/config`);
  expect(p.calls[0].init.method).toBe('GET');
  expect(p.calls[0].init.body).toBeUndefined();
});

for (const action of ['prepare', 'issue', 'reconcile']) {
  test(`POST ${action} preserves signed bytes, outcome and exclusively server-owned headers`, async () => {
    const body = ' { "signature": "personal-proof", "wallet":"provisional", "target":"https://ignored.example", "amount":"1.0000000" }\n';
    const outcome = { state: 'pending', request_id: 'original', included: false };
    const p = probe(() => Response.json(outcome, { status: 202, headers: { 'set-cookie': 'private', 'x-secret': 'private' } }));
    await result(await p.run(request(action, body, { headers: {
      'content-type': 'application/json; charset=utf-8', authorization: 'Bearer incoming-secret',
      cookie: 'session=private', apikey: 'incoming-key', 'x-target': 'https://ignored.example',
    } }), action), 202, outcome);
    expect(p.calls).toHaveLength(1);
    const { url, init } = p.calls[0];
    expect(url).toBe(`${origin}/functions/v1/d1-custody/${action}`);
    expect(init.method).toBe('POST');
    expect(Buffer.from(init.body as Uint8Array).equals(Buffer.from(body))).toBe(true);
    expect(Object.fromEntries(new Headers(init.headers))).toEqual({
      accept: 'application/json', 'content-type': 'application/json',
      apikey: env.D1_CUSTODY_ANON_KEY, authorization: `Bearer ${env.D1_CUSTODY_ANON_KEY}`,
    });
    expect(init.redirect).toBe('manual');
    expect(init.credentials).toBe('omit');
    expect(init.cache).toBe('no-store');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
}

const rejectedRoutes: [string, string, string, number, string][] = [
  ['unknown', 'GET', '/api/d1/unknown', 404, 'unsupported_action'],
  ['grantadmin', 'POST', '/api/d1/grantadmin', 404, 'unsupported_action'],
  ['config', 'POST', '/api/d1/config', 405, 'method_not_allowed'],
  ['prepare', 'GET', '/api/d1/prepare', 405, 'method_not_allowed'],
  ['issue', 'GET', '/api/d1/issue', 405, 'method_not_allowed'],
  ['reconcile', 'GET', '/api/d1/reconcile', 405, 'method_not_allowed'],
  ['prepare', 'DELETE', '/api/d1/prepare', 405, 'method_not_allowed'],
  ['config', 'HEAD', '/api/d1/config', 405, 'method_not_allowed'],
  ['config', 'OPTIONS', '/api/d1/config', 405, 'method_not_allowed'],
  ['config', 'GET', '/api/d1/config?target=https://evil.example', 400, 'invalid_path'],
  ['config', 'GET', '/api/d1/config?apikey=secret', 400, 'invalid_path'],
  ['config', 'GET', '/api/d1/%63onfig', 400, 'invalid_path'],
  ['config', 'GET', '/api/d1/config/', 400, 'invalid_path'],
  ['../config', 'GET', '/api/d1/config', 404, 'unsupported_action'],
  ['config', 'GET', '/api/d1/config#fragment', 400, 'invalid_path'],
];
for (const [action, method, path, status, error] of rejectedRoutes) {
  test(`rejects ${method} ${path} (${action}) before fetch`, async () => {
    const p = probe();
    await result(await p.run(new Request(`https://web.example${path}`, { method }), action), status, { error });
    expect(p.calls).toHaveLength(0);
  });
}

const invalidEnvironments: [keyof ProxyEnvironment, string | undefined][] = [
  ...[undefined, 'http://' + project + '.supabase.co', `${origin}:443`, `${origin}/path`, `${origin}?x=1`,
    `${origin}#x`, `https://user:password@${project}.supabase.co`, `${origin}.evil.example`,
    'https://short.supabase.co', `https://${project.toUpperCase()}.supabase.co`, ` ${origin}`,
  ].map(value => ['D1_CUSTODY_SUPABASE_URL', value] as [keyof ProxyEnvironment, string | undefined]),
  ...[undefined, namespace.toUpperCase(), 'not-a-uuid'].map(value => ['D1_CUSTODY_NAMESPACE', value] as [keyof ProxyEnvironment, string | undefined]),
  ...[undefined, 'sb_secret_mock', 'sb_publishable_mock', 'malformed', token({ role: 'service_role', ref: project }),
    token({ role: 'anon', ref: 'other-project' }), token({ role: 'anon' }), token({}, { alg: 'none' }),
    `${encode({ alg: 'HS256', typ: 'JWT' })}.not-json.signature`, `${token()}.extra`, token().slice(0, -2),
  ].map(value => ['D1_CUSTODY_ANON_KEY', value] as [keyof ProxyEnvironment, string | undefined]),
];
invalidEnvironments.forEach(([key, value], index) => {
  test(`invalid server configuration ${index} fails closed without disclosing values`, async () => {
    const p = probe(undefined, { ...env, [key]: value });
    await result(await p.run(request()), 503, { error: 'configuration_error' });
    expect(p.calls).toHaveLength(0);
  });
});

for (const body of ['', ' ', '{', 'null', '[]', '"text"', '1', 'true']) {
  test(`rejects non-object JSON ${JSON.stringify(body)}`, async () => {
    const p = probe();
    await result(await p.run(request('prepare', body)), 400, { error: 'invalid_json' });
    expect(p.calls).toHaveLength(0);
  });
}
for (const contentType of ['', 'text/plain', 'application/jsonp']) {
  test(`rejects unsupported media type ${contentType}`, async () => {
    const p = probe();
    await result(await p.run(request('prepare', '{}', { headers: { 'content-type': contentType } })), 415, { error: 'unsupported_media_type' });
    expect(p.calls).toHaveLength(0);
  });
}

test('8192-byte boundary is byte-based, with streaming overflow cancelled before fetch', async () => {
  const p = probe();
  const exact = JSON.stringify({ value: 'é'.repeat(4090) });
  expect(Buffer.byteLength(exact)).toBe(8192);
  await result(await p.run(request('prepare', exact)), 200, { ok: true });
  expect(p.calls).toHaveLength(1);
  expect(Buffer.from(p.calls[0].init.body as Uint8Array).equals(Buffer.from(exact))).toBe(true);
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(Buffer.from(exact)); controller.enqueue(Buffer.from(' ')); },
    cancel() { cancelled = true; },
  });
  const rejected = probe();
  const req = request('prepare', undefined, { body: stream, duplex: 'half', headers: { 'content-type': 'application/json', 'content-length': '1' } } as RequestInit);
  await result(await rejected.run(req), 413, { error: 'body_too_large' });
  expect(cancelled).toBe(true);
  expect(rejected.calls).toHaveLength(0);
});

for (const badConfig of [
  { ...config, network: 'PUBLIC' }, { ...config, donation_ttl_seconds: 301 },
  { ...config, donation_ttl_seconds: '300' }, { ...config, pool_public_key: pool.slice(0, -1) + 'A' },
  { ...config, pool_public_key: 'S'.repeat(56) }, { ...config, extra: 'private' },
  { network: 'TESTNET' }, null, [],
]) {
  test(`rejects invalid upstream config ${JSON.stringify(badConfig)}`, async () => {
    const p = probe(() => Response.json(badConfig));
    await result(await p.run(new Request('https://web.example/api/d1/config'), 'config'), 502, { error: 'invalid_upstream_response' });
    expect(p.calls).toHaveLength(1);
  });
}

for (const status of [200, 201, 202]) {
  test(`preserves POST JSON status ${status} without interpreting financial outcome`, async () => {
    const body = { state: 'unverified', nested: { amount: '1.0000000' } };
    const p = probe(() => Response.json(body, { status }));
    await result(await p.run(request()), status, body);
    expect(p.calls).toHaveLength(1);
  });
}
for (const status of [400, 401, 403, 409, 429, 500]) {
  test(`relays safe backend error with original status ${status}`, async () => {
    const p = probe(() => Response.json({ error: 'invalid_signature' }, { status }));
    await result(await p.run(request()), status, { error: 'invalid_signature' });
    expect(p.calls).toHaveLength(1);
  });
}

const unsafeResponses = [
  () => new Response('<html>private</html>'),
  () => new Response('{', { headers: { 'content-type': 'application/json' } }),
  () => Response.json({ error: 'Bearer private.token' }, { status: 401 }),
  () => Response.json({ error: 'safe_code', details: 'private' }, { status: 500 }),
  () => Response.json({ message: 'private' }, { status: 500 }),
  () => new Response(null, { status: 204 }),
  () => Response.json({ ok: true }, { status: 302, headers: { location: 'https://evil.example' } }),
];
unsafeResponses.forEach((upstream, index) => {
  test(`sanitizes invalid upstream response ${index} without following redirects`, async () => {
    const p = probe(upstream);
    await result(await p.run(request()), 502, { error: 'invalid_upstream_response' });
    expect(p.calls).toHaveLength(1);
  });
});

test('bounds streamed upstream JSON at 65536 bytes', async () => {
  const body = JSON.stringify({ value: 'a'.repeat(65524) });
  expect(Buffer.byteLength(body)).toBe(65536);
  const p = probe(() => new Response(body, { headers: { 'content-type': 'application/json' } }));
  await result(await p.run(request()), 200, JSON.parse(body));
  expect(p.calls).toHaveLength(1);
  let cancelled = false;
  const oversized = probe(() => new Response(new ReadableStream({
    start(controller) { controller.enqueue(Buffer.from(body)); controller.enqueue(Buffer.from(' ')); },
    cancel() { cancelled = true; },
  }), { headers: { 'content-type': 'application/json' } }));
  await result(await oversized.run(request()), 502, { error: 'invalid_upstream_response' });
  expect(cancelled).toBe(true);
  expect(oversized.calls).toHaveLength(1);
});

test('transport exceptions are sanitized and never retried', async () => {
  const p = probe(() => { throw new Error('private-url-and-credential'); });
  await result(await p.run(request()), 502, { error: 'upstream_unavailable' });
  expect(p.calls).toHaveLength(1);
});

test('10 second deadline aborts both fetch and response reading, with one attempt', async () => {
  const signals: AbortSignal[] = [];
  let cancelled = false;
  const run = (reading: boolean) => proxyD1(request(), 'prepare', { env, fetch: async (_url, init) => {
    signals.push(init!.signal!);
    if (reading) return new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
      headers: { 'content-type': 'application/json' },
    });
    return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('private'))));
  } });
  const started = Date.now();
  const responses = await Promise.all([run(false), run(true)]);
  for (const response of responses) await result(response, 504, { error: 'upstream_timeout' });
  expect(Date.now() - started).toBeGreaterThanOrEqual(9900);
  expect(Date.now() - started).toBeLessThan(12000);
  expect(signals).toHaveLength(2);
  expect(signals.every(signal => signal.aborted)).toBe(true);
  expect(cancelled).toBe(true);
});
