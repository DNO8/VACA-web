import { test, expect } from '@playwright/test';
import { StrKey } from '@stellar/stellar-sdk';
import { proxyD1, type ProxyEnvironment } from '../../src/lib/d1/server-proxy';
import * as adapter from '../../src/app/api/d1/[action]/route';

const project = 'abcdefghijklmnopqrst';
const namespace = '11111111-1111-1111-1111-111111111111';
const id = '22222222-2222-2222-2222-222222222222';
const account = (n: number) => StrKey.encodeEd25519PublicKey(Buffer.alloc(32, n));
const pool = account(1);
const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const key = [part({ alg: 'HS256', typ: 'JWT' }), part({ role: 'anon', ref: project }), Buffer.alloc(32).toString('base64url')].join('.');
const env: ProxyEnvironment = { D1_CUSTODY_SUPABASE_URL: `https://${project}.supabase.co`, D1_CUSTODY_ANON_KEY: key, D1_CUSTODY_NAMESPACE: namespace };
const routes = [
  { path: 'refund-status', version: 1, action: 'refund_status', role: 'status' },
  { path: 'refund', version: 1, action: 'refund', role: 'execute' },
  { path: 'refund-reconcile', version: 1, action: 'refund_reconcile', role: 'reconcile' },
  { path: 'refund-remainder-status', version: 2, action: 'refund_remainder_status', role: 'status' },
  { path: 'refund-remainder', version: 2, action: 'refund_remainder', role: 'execute' },
  { path: 'refund-remainder-reconcile', version: 2, action: 'refund_remainder_reconcile', role: 'reconcile' },
] as const;
type Route = typeof routes[number];
const states = ['not_due', 'not_started', 'blocked', 'pending', 'unknown', 'refund_observed', 'refund_failed_observed', 'settled'] as const;
type State = typeof states[number];
function command(route: Route) {
  // Synthetic proof: only the real backend authenticates it. The proxy must not renew its timestamp.
  return { version: route.version, action: route.action, network: 'TESTNET', namespace, pool,
    request_id: id, timestamp: 1, payload: {}, wallet: account(2), signature: Buffer.alloc(64).toString('base64') };
}
function dto(route: Route, state: State = 'unknown') {
  const prefix = route.version === 1 ? 'refund' : 'refund_remainder';
  return {
    version: route.version, network: 'TESTNET', namespace, pool, requestId: id, state,
    verification: ['refund_observed', 'refund_failed_observed', 'settled'].includes(state) ? 'persisted_sdk_observation' : 'unverified',
    deadline: '2026-11-01T12:05:00Z',
    donation: { paymentOperationId: '1', paymentTransactionHash: 'a'.repeat(64), donor: account(3), asset: { type: 'native' }, grossAmount: '10.0000000' },
    refund: ['pending', 'refund_observed', 'refund_failed_observed', 'settled'].includes(state)
      ? { transactionHash: 'b'.repeat(64), amount: route.version === 1 ? '10.0000000' : '9.0000000', claimableBalanceId: null } : null,
    settlement: { beneficiaryClaimedAmount: state === 'settled' ? (route.version === 1 ? '0.0000000' : '1.0000000') : null,
      donorRefundedAmount: state === 'settled' ? (route.version === 1 ? '10.0000000' : '9.0000000') : null,
      remainingPrincipalAmount: state === 'settled' ? '0.0000000' : null },
    safeActions: state === 'not_started' ? [prefix, `${prefix}_status`]
      : ['not_due', 'settled'].includes(state) ? [`${prefix}_status`] : [`${prefix}_status`, `${prefix}_reconcile`],
    reason: state === 'not_due' ? 'deadline_not_reached' : state === 'blocked' ? 'financial_precondition_unavailable'
      : state === 'unknown' ? 'outcome_unresolved' : state === 'refund_failed_observed' ? 'refund_failed' : null,
  };
}
function status(route: Route, state: State): number {
  return route.role === 'status' ? 200 : ['pending', 'unknown'].includes(state) ? 202
    : route.role === 'execute' && ['not_due', 'blocked'].includes(state) ? 409 : 200;
}
function request(path: string, body: string, method = 'POST', suffix = '') {
  return new Request(`https://web.example/api/d1/${path}${suffix}`, { method,
    headers: { 'content-type': 'application/json; charset=utf-8', authorization: 'Bearer caller', apikey: 'caller', 'x-admin': 'caller' },
    body: ['GET', 'HEAD'].includes(method) ? undefined : body });
}
function probe(upstream: Response | Error) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (upstream instanceof Error) throw upstream;
    return upstream;
  };
  return { calls, fetcher, dependencies: { env, fetch: fetcher } };
}
async function result(response: Response, code: number, value: unknown) {
  expect(response.status).toBe(code);
  expect([...response.headers.entries()].sort()).toEqual([['cache-control', 'no-store'], ['content-type', 'application/json']]);
  expect(await response.json()).toEqual(value);
}

for (const route of routes) {
  test(`${route.path}: fixed endpoint, one call and unchanged signed bytes/server headers`, async () => {
    const bytes = ` \n${JSON.stringify(command(route))}\t `; const report = dto(route);
    const p = probe(Response.json(report, { status: status(route, 'unknown'), headers: { 'x-private': 'hidden', 'set-cookie': 'hidden=1' } }));
    await result(await proxyD1(request(route.path, bytes), route.path, p.dependencies), status(route, 'unknown'), report);
    expect(p.calls).toHaveLength(1); const call = p.calls[0]; const init = call.init!;
    expect(call.url).toBe(`https://${project}.supabase.co/functions/v1/d1-custody/${route.path}`);
    expect(init.method).toBe('POST'); expect(init.body).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(init.body as Uint8Array)).toEqual(Buffer.from(bytes));
    expect([...new Headers(init.headers).entries()].sort()).toEqual([
      ['accept', 'application/json'], ['apikey', key], ['authorization', `Bearer ${key}`], ['content-type', 'application/json'],
    ]);
    expect(init.redirect).toBe('manual'); expect(init.credentials).toBe('omit'); expect(init.cache).toBe('no-store');
    expect(init.signal).toBeInstanceOf(AbortSignal); expect(init.signal?.aborted).toBe(false);
  });
  for (const state of states) test(`${route.path}: admits the bound ${state} DTO only at its HTTP status`, async () => {
    const report = dto(route, state); const code = status(route, state); const bytes = JSON.stringify(command(route));
    const p = probe(Response.json(report, { status: code }));
    await result(await proxyD1(request(route.path, bytes), route.path, p.dependencies), code, report);
    expect(p.calls).toHaveLength(1);
    for (const wrong of [200, 202, 409, 201].filter(value => value !== code)) {
      const bad = probe(Response.json(report, { status: wrong }));
      await result(await proxyD1(request(route.path, bytes), route.path, bad.dependencies), 502, { error: 'invalid_upstream_response' });
      expect(bad.calls).toHaveLength(1);
    }
  });
  test(`${route.path}: invalid correlation is rejected without upstream work`, async () => {
    for (const patch of [{ version: route.version === 1 ? 2 : 1 }, { action: 'prepare' }, { network: 'PUBLIC' },
      { namespace: id }, { pool: 'S'.repeat(56) }, { request_id: 'incident-1' }, { request_id: id + '\n' }, { pool: null }]) {
      const bytes = JSON.stringify({ ...command(route), ...patch }); const p = probe(Response.json(dto(route)));
      await result(await proxyD1(request(route.path, bytes), route.path, p.dependencies), 400, { error: 'invalid_request' });
      expect(p.calls).toHaveLength(0);
    }
  });
  test(`${route.path}: only POST with an exact local path is admitted`, async () => {
    const bytes = JSON.stringify(command(route));
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'DELETE']) {
      const p = probe(Response.json(dto(route)));
      await result(await proxyD1(request(route.path, bytes, method), route.path, p.dependencies), 405, { error: 'method_not_allowed' });
      expect(p.calls).toHaveLength(0);
    }
    for (const suffix of ['?next=/config', '#config']) {
      const p = probe(Response.json(dto(route)));
      await result(await proxyD1(request(route.path, bytes, 'POST', suffix), route.path, p.dependencies), 400, { error: 'invalid_path' });
      expect(p.calls).toHaveLength(0);
    }
  });
}

test('refund routes preserve sole safe errors, sanitize malformed errors and never retry failures', async () => {
  for (const route of routes) {
    const bytes = JSON.stringify(command(route));
    for (const code of [400, 401, 403, 404, 405, 409, 503]) {
      const value = { error: 'custody_unavailable' }; const p = probe(Response.json(value, { status: code }));
      await result(await proxyD1(request(route.path, bytes), route.path, p.dependencies), code, value);
      expect(p.calls).toHaveLength(1);
    }
    for (const value of [{ error: 'unsafe detail' }, { error: 'custody_unavailable', private: 'hidden' }, { error: 1 }]) {
      const p = probe(Response.json(value, { status: 409 }));
      await result(await proxyD1(request(route.path, bytes), route.path, p.dependencies), 502, { error: 'invalid_upstream_response' });
      expect(p.calls).toHaveLength(1);
    }
    const p = probe(new Error('private upstream failure'));
    await result(await proxyD1(request(route.path, bytes), route.path, p.dependencies), 502, { error: 'upstream_unavailable' });
    expect(p.calls).toHaveLength(1);
  }
});

test('refund success never exposes malformed or foreign DTO fields', async () => {
  for (const route of routes) {
    const bytes = JSON.stringify(command(route)); const report = dto(route);
    for (const value of [{ ...report, namespace: id }, { ...report, pool: account(8) }, { ...report, requestId: namespace },
      { ...report, private: 'hidden' }, { ...report, reason: 'private detail' }, { ...report, state: 'success' },
      { ...report, safeActions: ['refund'] }, { error: 'custody_unavailable' }, null, []]) {
      const p = probe(Response.json(value, { status: status(route, 'unknown') }));
      await result(await proxyD1(request(route.path, bytes), route.path, p.dependencies), 502, { error: 'invalid_upstream_response' });
      expect(p.calls).toHaveLength(1);
    }
  }
});

test('pool correlation is request-bound, not an extra config fetch or pool authentication claim', async () => {
  const route = routes[0]; const requestedPool = account(9); const report = { ...dto(route), pool: requestedPool };
  const bytes = JSON.stringify({ ...command(route), pool: requestedPool }); const p = probe(Response.json(report));
  await result(await proxyD1(request(route.path, bytes), route.path, p.dependencies), 200, report);
  expect(p.calls).toHaveLength(1); expect(p.calls[0].url.endsWith('/refund-status')).toBe(true);
});

test('refund paths retain exact request/response byte limits and fatal UTF8 decoding', async () => {
  const route = routes[0]; const bytes = JSON.stringify(command(route)); const report = dto(route);
  const boundary = probe(Response.json(report));
  await result(await proxyD1(request(route.path, bytes.padEnd(8192)), route.path, boundary.dependencies), 200, report);
  expect(Buffer.from(boundary.calls[0].init!.body as Uint8Array)).toHaveLength(8192);
  const excess = probe(Response.json(report));
  await result(await proxyD1(request(route.path, bytes.padEnd(8193)), route.path, excess.dependencies), 413, { error: 'body_too_large' });
  expect(excess.calls).toHaveLength(0);
  for (const size of [65536, 65537]) {
    const p = probe(new Response(JSON.stringify(report).padEnd(size), { headers: { 'content-type': 'application/json' } }));
    await result(await proxyD1(request(route.path, bytes), route.path, p.dependencies), size === 65536 ? 200 : 502,
      size === 65536 ? report : { error: 'invalid_upstream_response' });
    expect(p.calls).toHaveLength(1);
  }
  const invalidUtf8 = probe(new Response(new Uint8Array([0xc3, 0x28]), { headers: { 'content-type': 'application/json' } }));
  await result(await proxyD1(request(route.path, bytes), route.path, invalidUtf8.dependencies), 502, { error: 'invalid_upstream_response' });
  const malformed = probe(Response.json(report));
  await result(await proxyD1(request(route.path, '{'), route.path, malformed.dependencies), 400, { error: 'invalid_json' });
  expect(malformed.calls).toHaveLength(0);
});

test('existing dynamic Next adapter reaches all six routes without forwarding caller headers', async () => {
  const previous = Object.fromEntries(Object.keys(env).map(name => [name, process.env[name]])); const oldFetch = globalThis.fetch;
  Object.assign(process.env, env);
  try {
    for (const route of routes) {
      const report = dto(route); const p = probe(Response.json(report, { status: status(route, 'unknown') })); globalThis.fetch = p.fetcher;
      await result(await adapter.POST(request(route.path, JSON.stringify(command(route))), { params: Promise.resolve({ action: route.path }) }), status(route, 'unknown'), report);
      expect(p.calls).toHaveLength(1);
    }
  } finally {
    globalThis.fetch = oldFetch;
    for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
});

for (const action of ['prepare', 'issue', 'reconcile']) test(`${action}: legacy opacity and error sanitization stay unchanged for refund-shaped input`, async () => {
  const bytes = ` \n${JSON.stringify(command(routes[0]))} `; const value = { legacy: true, private_shape: ['not a refund DTO'] };
  const p = probe(Response.json(value, { status: 201 }));
  await result(await proxyD1(request(action, bytes), action, p.dependencies), 201, value);
  expect(p.calls).toHaveLength(1); expect(Buffer.from(p.calls[0].init!.body as Uint8Array)).toEqual(Buffer.from(bytes));
  const bad = probe(Response.json(dto(routes[0], 'not_due'), { status: 409 }));
  await result(await proxyD1(request(action, bytes), action, bad.dependencies), 502, { error: 'invalid_upstream_response' });
  const safe = probe(Response.json({ error: 'custody_unavailable' }, { status: 409 }));
  await result(await proxyD1(request(action, bytes), action, safe.dependencies), 409, { error: 'custody_unavailable' });
});

test('config keeps its server namespace and rejects refund-shaped responses', async () => {
  const config = { network: 'TESTNET', pool_public_key: pool, donation_ttl_seconds: 300 }; const p = probe(Response.json(config));
  await result(await proxyD1(request('config', '', 'GET'), 'config', p.dependencies), 200, { ...config, namespace });
  expect(p.calls).toHaveLength(1); expect(p.calls[0].init?.body).toBeUndefined();
  const bad = probe(Response.json(dto(routes[0])));
  await result(await proxyD1(request('config', '', 'GET'), 'config', bad.dependencies), 502, { error: 'invalid_upstream_response' });
});

test('underscore aliases and unknown action names remain unsupported without upstream work', async () => {
  for (const action of ['refund_status', 'refund_remainder', 'refund_remainder_reconcile', '__proto__', 'unknown']) {
    const p = probe(Response.json({}));
    await result(await proxyD1(request(action, '{}'), action, p.dependencies), 404, { error: 'unsupported_action' });
    expect(p.calls).toHaveLength(0);
  }
});
