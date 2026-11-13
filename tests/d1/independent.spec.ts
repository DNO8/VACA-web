import { test, expect } from '@playwright/test';
import { StrKey } from '@stellar/stellar-sdk';
import { proxyD1 } from '../../src/lib/d1/server-proxy';
import { POST, GET, runtime, dynamic } from '../../src/app/api/d1/[action]/route';
const ref = 'abcdefghijklmnopqrst';
const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
const key = (role = 'anon') => `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc({ role, ref })}.${Buffer.alloc(32).toString('base64url')}`;
const env = { D1_CUSTODY_SUPABASE_URL: `https://${ref}.supabase.co`, D1_CUSTODY_ANON_KEY: key(), D1_CUSTODY_NAMESPACE: '01234567-89ab-cdef-0123-456789abcdef' };
const req = (body = '{}', path = 'issue', method = 'POST') => new Request(`https://web.example/api/d1/${path}`, { method, ...(method === 'GET' ? {} : { body }), headers: { 'content-type': 'application/json', authorization: 'private', cookie: 'private', apikey: 'private' } });
async function check(r: Response, status: number, value: unknown) {
  expect(r.status).toBe(status);
  expect(Object.fromEntries(r.headers)).toEqual({ 'cache-control': 'no-store', 'content-type': 'application/json' });
  expect(await r.text()).toBe(JSON.stringify(value));
}
test('independent adapter preserves UTF8 signed bytes and pending status', async () => {
  const saved = { ...process.env }; const original = globalThis.fetch;
  Object.assign(process.env, env);
  const body = ' {"signature":"é\\u0061", "target":"https://evil.example", "n":1.00}\n';
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++;
    expect(String(url)).toBe(`${env.D1_CUSTODY_SUPABASE_URL}/functions/v1/d1-custody/issue`);
    expect(Buffer.from(init!.body as Uint8Array)).toEqual(Buffer.from(body));
    expect(Object.fromEntries(new Headers(init!.headers))).toEqual({ authorization: `Bearer ${key()}`, apikey: key(), accept: 'application/json', 'content-type': 'application/json' });
    expect([init!.method, init!.redirect, init!.credentials, init!.cache]).toEqual(['POST', 'manual', 'omit', 'no-store']);
    return Response.json({ state: 'unverified', included: false }, { status: 202, headers: { 'set-cookie': 'private' } });
  };
  try {
    expect([runtime, dynamic]).toEqual(['nodejs', 'force-dynamic']);
    await check(await POST(req(body), { params: Promise.resolve({ action: 'issue' }) }), 202, { state: 'unverified', included: false });
    expect(calls).toBe(1);
  } finally { globalThis.fetch = original; for (const k of Object.keys(env)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
});
test('independent rejection counters and configuration boundary', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; return Response.json({}); };
  const cases: [Request, string, typeof env, number, string][] = [
    [req(), 'issue', { ...env, D1_CUSTODY_ANON_KEY: key('service_role') }, 503, 'configuration_error'],
    [req(), 'issue', { ...env, D1_CUSTODY_SUPABASE_URL: env.D1_CUSTODY_SUPABASE_URL + '@evil.example' }, 503, 'configuration_error'],
    [req('{}', 'issue?target=evil'), 'issue', env, 400, 'invalid_path'],
    [req('{}', 'other'), 'other', env, 404, 'unsupported_action'],
    [req('{}', 'issue', 'GET'), 'issue', env, 405, 'method_not_allowed'],
    [req('[]'), 'issue', env, 400, 'invalid_json'],
    [req(JSON.stringify({ x: 'é'.repeat(4093) })), 'issue', env, 413, 'body_too_large'],
  ];
  for (const [request, action, environment, status, error] of cases) {
    await check(await proxyD1(request, action, { env: environment, fetch: fetcher }), status, { error });
    expect(calls).toBe(0);
  }
  // Next method contract rejects before consulting any ambient configuration.
  await check(await GET(req('{}', 'issue', 'GET'), { params: Promise.resolve({ action: 'issue' }) }), 405, { error: 'method_not_allowed' });
});
test('independent public configuration and unsafe response boundary', async () => {
  const config = { network: 'TESTNET', pool_public_key: StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 2)), donation_ttl_seconds: 300 };
  await check(await proxyD1(req('{}', 'config', 'GET'), 'config', { env, fetch: async () => Response.json(config) }), 200, { ...config, namespace: env.D1_CUSTODY_NAMESPACE });
  let calls = 0;
  for (const response of [Response.json({ error: 'private', details: 'secret' }, { status: 403 }), Response.json({ x: 'a'.repeat(65536) }), Response.json({}, { status: 307, headers: { location: 'https://evil.example' } })]) {
    await check(await proxyD1(req(), 'issue', { env, fetch: async () => { calls++; return response; } }), 502, { error: 'invalid_upstream_response' });
  }
  expect(calls).toBe(3);
});
test('independent noncooperating fetch deadline has no retry', async () => {
  let calls = 0; let signal: AbortSignal | undefined;
  const response = await proxyD1(req(), 'issue', { env, fetch: async (_url, init) => {
    calls++; signal = init!.signal!; return new Promise<Response>(() => {});
  } });
  await check(response, 504, { error: 'upstream_timeout' });
  expect(calls).toBe(1); expect(signal!.aborted).toBe(true);
});
