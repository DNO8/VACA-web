import { test, expect } from '@playwright/test';
import { readD1PublicConfig } from '../../src/lib/d1/public-config';
import { postAdminCommand } from '../../src/lib/d1/admin-command-transport';
import { proxyD1 } from '../../src/lib/d1/server-proxy';

const origin = 'https://tgqxxnldwiqisopiclmk.supabase.co';
const namespace = '8126a1f4-ed8a-41ec-905b-9ad3442e5e6e';
const pool = 'GAYWVFBP2YPYMU245D6AOE7WWTVZOWGPVIFVGOH5EFFSSQ3VZAVR5JCW';
const aPool = 'GCATS5YOVB6ROX2WUNKGNQ2MP3GMXDMKSG2O4N5CLX3A6W4PZGZZI55U';
const config = { network: 'TESTNET', namespace, pool_public_key: pool, donation_ttl_seconds: 300 };
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const env = { D1_CUSTODY_SUPABASE_URL: origin, D1_CUSTODY_NAMESPACE: 'abcdef01-2345-6789-abcd-0123456789ab',
  D1_CUSTODY_ANON_KEY: `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ role: 'anon', ref: 'tgqxxnldwiqisopiclmk' })}.${Buffer.alloc(32, 1).toString('base64url')}` };
const command = { network: 'TESTNET', namespace, pool, signature: 'opaque-personal-proof' };

// Exercise public APIs; no backend, keys, wallet or stored financial state is loaded.
test('explicit unknown profiles, including null, never fall back to A', async () => {
  for (const profile of [null, '', 'unknown'] as unknown as ('A' | 'B')[]) {
    let calls = 0;
    const fetcher: typeof fetch = async () => { calls++; return Response.json(config); };
    expect(await readD1PublicConfig(new AbortController().signal, fetcher, 5000, profile)).toEqual({ status: 'unavailable' });
    await expect(postAdminCommand('prepare', '{}', fetcher, profile)).rejects.toThrow('d1_profile_unavailable');
    const response = await proxyD1(new Request('https://web.example/api/d1/config'), 'config', { env, fetch: fetcher, profile });
    expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: 'configuration_error' });
    expect(calls).toBe(0);
  }
});

test('B configuration and command select the same separate same-origin route', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher: typeof fetch = async (url, init) => { calls.push({ url: String(url), init }); return Response.json(init?.method === 'GET' ? config : { state: 'unknown' }); };
  expect(await readD1PublicConfig(new AbortController().signal, fetcher, 5000, 'B')).toEqual({ status: 'available', config });
  expect(await postAdminCommand('prepare', JSON.stringify(command), fetcher, 'B')).toEqual({ status: 200, body: { state: 'unknown' } });
  expect(calls.map(call => call.url)).toEqual(['/api/d1/video-auto/config', '/api/d1/video-auto/prepare']);
  expect(calls.every(call => call.init?.credentials === 'omit' && call.init.redirect === 'error' && call.init.cache === 'no-store')).toBe(true);
});

test('B config fails closed for project-independent public pool, namespace, network and TTL mismatches', async () => {
  for (const change of [{ pool_public_key: aPool }, { namespace: env.D1_CUSTODY_NAMESPACE }, { network: 'PUBLIC' }, { donation_ttl_seconds: 301 }]) {
    let calls = 0;
    const fetcher: typeof fetch = async () => { calls++; return Response.json({ ...config, ...change }); };
    expect(await readD1PublicConfig(new AbortController().signal, fetcher, 5000, 'B')).toEqual({ status: 'unavailable' });
    expect(calls).toBe(1);
  }
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; return Response.json(config); };
  expect(await readD1PublicConfig(new AbortController().signal, fetcher, 5000, 'unknown' as 'B')).toEqual({ status: 'unavailable' });
  expect(calls).toBe(0);
});

test('B command scope rejection is before IO and leaves exact caller bytes untouched', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; return Response.json({}); };
  for (const body of ['{}', '{', ...[{ namespace: env.D1_CUSTODY_NAMESPACE }, { pool: aPool }, { network: 'PUBLIC' }].map(change => JSON.stringify({ ...command, ...change }))]) {
    const retained = body;
    await expect(postAdminCommand('refund', body, fetcher, 'B')).rejects.toThrow('d1_profile_scope_mismatch');
    expect(body).toBe(retained); expect(calls).toBe(0);
  }
  await expect(postAdminCommand('prepare', '{}', fetcher, 'unknown' as 'B')).rejects.toThrow('d1_profile_unavailable');
  expect(calls).toBe(0);
});

test('B proxy pins upstream project, public config and separate namespace without changing A environment', async () => {
  const retained = JSON.stringify(env), calls: { url: string; init?: RequestInit }[] = [];
  const fetcher: typeof fetch = async (url, init) => { calls.push({ url: String(url), init }); const { namespace: _namespace, ...publicConfig } = config; return Response.json(publicConfig); };
  const response = await proxyD1(new Request('https://web.example/api/d1/video-auto/config'), 'config', { env, fetch: fetcher, profile: 'B' });
  expect(response.status).toBe(200); expect(await response.json()).toEqual(config);
  expect(calls.map(call => call.url)).toEqual([`${origin}/functions/v1/d1-custody/video-auto/config`]);
  expect(calls[0].init).toMatchObject({ redirect: 'manual', credentials: 'omit', cache: 'no-store' });
  expect(new Headers(calls[0].init?.headers).get('authorization')).toBe(`Bearer ${env.D1_CUSTODY_ANON_KEY}`);
  expect(JSON.stringify(env)).toBe(retained);
  const wrong = await proxyD1(new Request('https://web.example/api/d1/video-auto/config'), 'config', { env: { ...env, D1_CUSTODY_SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co' }, fetch: fetcher, profile: 'B' });
  expect(wrong.status).toBe(503); expect(await wrong.json()).toEqual({ error: 'configuration_error' }); expect(calls).toHaveLength(1);
});

test('B proxy rejects wrong scope and malformed paths before forwarding, preserves signed bytes once', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher: typeof fetch = async (url, init) => { calls.push({ url: String(url), init }); return Response.json({ state: 'pending' }, { status: 202 }); };
  const run = (path: string, body: string) => proxyD1(new Request(`https://web.example${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body }), 'prepare', { env, fetch: fetcher, profile: 'B' });
  for (const path of ['/api/d1/prepare', '/api/d1/video-auto/prepare?x=1', '/api/d1/video-auto/prepare/']) {
    const response = await run(path, JSON.stringify(command)); expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: 'invalid_path' });
  }
  for (const change of [{ namespace: env.D1_CUSTODY_NAMESPACE }, { pool: aPool }, { network: 'PUBLIC' }]) {
    const response = await run('/api/d1/video-auto/prepare', JSON.stringify({ ...command, ...change }));
    expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: 'invalid_request' });
  }
  expect(calls).toHaveLength(0);
  const bytes = ' ' + JSON.stringify(command) + '\n';
  const response = await run('/api/d1/video-auto/prepare', bytes);
  expect(response.status).toBe(202); expect(await response.json()).toEqual({ state: 'pending' }); expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe(`${origin}/functions/v1/d1-custody/video-auto/prepare`);
  expect(Buffer.from(calls[0].init?.body as Uint8Array).toString()).toBe(bytes);
});

test('B keeps request/response limits, gateway rejection, redirect refusal and exact prepare proof schema', async () => {
  const { namespace: _namespace, ...prepare } = command;
  const bytes = JSON.stringify(prepare), calls: { url: string; init?: RequestInit }[] = [];
  let upstream = () => Response.json({ state: 'unknown' }, { status: 202 });
  const fetcher: typeof fetch = async (url, init) => { calls.push({ url: String(url), init }); return upstream(); };
  const run = (body: string) => proxyD1(new Request('https://web.example/api/d1/video-auto/prepare', { method: 'POST', headers: { 'content-type': 'application/json' }, body }), 'prepare', { env, fetch: fetcher, profile: 'B' });
  const accepted = await run(bytes.padEnd(8192)); expect(accepted.status).toBe(202); expect(calls).toHaveLength(1);
  expect(Buffer.from(calls[0].init?.body as Uint8Array).toString()).toBe(bytes.padEnd(8192));
  const oversized = await run(bytes.padEnd(8193)); expect(oversized.status).toBe(413); expect(await oversized.json()).toEqual({ error: 'body_too_large' }); expect(calls).toHaveLength(1);
  upstream = () => Response.json({ error: 'invalid_signature' }, { status: 401 });
  const denied = await run(bytes); expect(denied.status).toBe(401); expect(await denied.json()).toEqual({ error: 'invalid_signature' });
  upstream = () => new Response('{}', { status: 302, headers: { 'content-type': 'application/json', location: 'https://invalid.example' } });
  const redirect = await run(bytes); expect(redirect.status).toBe(502); expect(await redirect.json()).toEqual({ error: 'invalid_upstream_response' });
  upstream = () => new Response(' '.repeat(65537), { headers: { 'content-type': 'application/json' } });
  const largeResponse = await run(bytes); expect(largeResponse.status).toBe(502); expect(await largeResponse.json()).toEqual({ error: 'invalid_upstream_response' });
  expect(calls).toHaveLength(4);
  for (const change of [{ pool_public_key: aPool }, { donation_ttl_seconds: 301 }, { namespace }]) {
    const { namespace: _namespace, ...publicConfig } = config;
    const response = await proxyD1(new Request('https://web.example/api/d1/video-auto/config'), 'config', { env, profile: 'B', fetch: async () => Response.json({ ...publicConfig, ...change }) });
    expect(response.status).toBe(502); expect(await response.json()).toEqual({ error: 'invalid_upstream_response' });
  }
});

test('B command transport allowlists every existing action without rewriting bytes', async () => {
  for (const route of ['prepare', 'issue', 'reconcile', 'refund-status', 'refund', 'refund-reconcile', 'refund-remainder-status', 'refund-remainder', 'refund-remainder-reconcile'] as const) {
    const calls: string[] = [], bytes = ' ' + JSON.stringify(command) + '\n';
    const fetcher: typeof fetch = async (url, init) => { calls.push(String(url)); expect(init?.body).toBe(bytes); return Response.json({ error: 'outcome_unresolved' }, { status: 503 }); };
    expect(await postAdminCommand(route, bytes, fetcher, 'B')).toEqual({ status: 503, body: { error: 'outcome_unresolved' } });
    expect(calls).toEqual(['/api/d1/video-auto/' + route]);
  }
});

test('A defaults retain routes and opaque command bytes but cannot advertise B pool under A namespace', async () => {
  const calls: string[] = [];
  const aConfig = { ...config, namespace: env.D1_CUSTODY_NAMESPACE, pool_public_key: aPool };
  const fetcher: typeof fetch = async (url, init) => { calls.push(String(url)); return Response.json(init?.method === 'GET' ? aConfig : { state: 'unknown' }); };
  expect(await readD1PublicConfig(new AbortController().signal, fetcher)).toEqual({ status: 'available', config: aConfig });
  expect(await postAdminCommand('issue', ' opaque A bytes ', fetcher)).toEqual({ status: 200, body: { state: 'unknown' } });
  expect(calls).toEqual(['/api/d1/config', '/api/d1/issue']);
  expect(await readD1PublicConfig(new AbortController().signal, async () => Response.json({ ...config, namespace: aConfig.namespace }))).toEqual({ status: 'unavailable' });
  const { namespace: _namespace, ...publicConfig } = config;
  const response = await proxyD1(new Request('https://web.example/api/d1/config'), 'config', { env, fetch: async () => Response.json(publicConfig) });
  expect(response.status).toBe(502); expect(await response.json()).toEqual({ error: 'invalid_upstream_response' });
});
