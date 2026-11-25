import { test, expect } from '@playwright/test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import ts from 'typescript';

const hash = 'a'.repeat(64);
const eligibleAt = '2026-11-25T20:27:17Z';
function load(relative: string, stubs: Record<string, unknown> = {}, fetcher: typeof fetch = fetch) {
  const file = resolve(__dirname, relative), exports: Record<string, any> = {};
  const compiled = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
  } });
  const native = createRequire(file);
  new Function('require', 'exports', 'fetch', 'process', compiled.outputText)(
    (name: string) => Object.hasOwn(stubs, name) ? stubs[name] : native(name),
    exports, fetcher, { env: { NEXT_PUBLIC_SUPABASE_ANON_KEY: 'test-public-key' } },
  );
  return exports;
}
function client(status: number, body: unknown, networkFailure = false,
  preflight: Response | Error = Response.json({ wallet_age_eligible: true })) {
  const calls: string[] = [];
  const requests: { method: string; headers: RequestInit['headers'] }[] = [];
  class Builder {
    addOperation() { return this; }
    setTimeout() { return this; }
    build() { return { toXDR: () => 'unsigned-fixture' }; }
    static fromXDR() { return {}; }
  }
  const api = load('../../src/lib/vote.ts', {
    '@stellar/stellar-sdk': { TransactionBuilder: Builder, Operation: { manageData: () => ({}) }, BASE_FEE: '100' },
    '@stellar/freighter-api': { signTransaction: async () => { calls.push('sign'); return { signedTxXdr: 'signed-fixture' }; } },
    './stellar': { NETWORK: 'Testnet fixture', getServer: () => { calls.push('server'); return { loadAccount: async () => { calls.push('load'); return {}; }, submitTransaction: async () => { calls.push('submit'); return { hash }; } }; } },
    './donate': { fundIfMissing: async () => { calls.push('fund'); } },
  }, (async (url: string, init?: RequestInit) => {
    requests.push({ method: init?.method ?? 'GET', headers: init?.headers });
    if (!init?.method && new URL(url).searchParams.has('voter')) {
      calls.push('cooldown');
      return Response.json({ retry_after: 17, cooldown_s: 300 });
    }
    if (init?.method === 'GET') {
      calls.push('preflight');
      expect(new URL(url).searchParams.get('voter')).toBe('public-wallet');
      expect(new URL(url).searchParams.get('check')).toBe('wallet_age');
      expect(init.cache).toBe('no-store');
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(init.headers).toEqual({ apikey: 'test-public-key', Authorization: 'Bearer test-public-key' });
      if (preflight instanceof Error) throw preflight;
      return preflight;
    }
    calls.push('register');
    expect(JSON.parse(String(init?.body))).toEqual({ incident_id: 'incident:full', public_key: 'public-wallet', tx_hash: hash });
    if (networkFailure) throw new TypeError('Network unavailable');
    return Response.json(body, { status });
  }) as typeof fetch);
  return Object.assign(api, { calls, requests });
}

const submittedCalls = ['preflight', 'server', 'fund', 'load', 'sign', 'submit', 'register'];

test('public anon bearer reaches preflight, registration and cooldown consistently', async () => {
  const api = client(200, { ok: true, votes: 20 });
  await api.castVote('https://example.invalid', 'public-wallet', 'incident:full');
  await expect(api.getVoteCooldown('https://example.invalid', 'public-wallet')).resolves.toBe(17);
  const headers = { apikey: 'test-public-key', Authorization: 'Bearer test-public-key' };
  expect(api.requests).toEqual([
    { method: 'GET', headers },
    { method: 'POST', headers: { 'content-type': 'application/json', ...headers } },
    { method: 'GET', headers },
  ]);
  expect(api.calls).toEqual([...submittedCalls, 'cooldown']);
});

test('preflight stops a young wallet before every transaction side effect', async () => {
  const api = client(200, { ok: true, votes: 20 }, false,
    Response.json({ error: 'wallet_too_new', min_age_s: 86400, eligible_at: eligibleAt, retry_after: 12300 }, { status: 403 }));
  const before = Date.now();
  const error = await api.castVote('https://example.invalid', 'public-wallet', 'incident:full').catch((e: Error) => e);
  expect(error).toBeInstanceOf(api.VoteError);
  expect(error.stage).toBe('preflight'); expect(error.code).toBe('wallet_too_new');
  expect(error.eligibleAt).toBe(eligibleAt); expect(error.minAgeSeconds).toBe(86400);
  expect(error.ageRetryAtMs).toBeGreaterThanOrEqual(before + 12300000);
  expect(error.ageRetryAtMs).toBeLessThanOrEqual(Date.now() + 12300000);
  expect(error.retryAfter).toBeUndefined(); expect(error.txHash).toBeUndefined();
  expect(api.calls).toEqual(['preflight']);
});

test('preflight fails closed on unavailable, unauthorized, malformed and legacy responses', async () => {
  for (const response of [
    Response.json({ error: 'wallet_age_unavailable' }, { status: 503 }),
    Response.json({ error: 'unauthorized' }, { status: 401 }),
    Response.json({ retry_after: 0, cooldown_s: 300 }),
    Response.json({ wallet_age_eligible: 'true' }),
    Response.json({ wallet_age_eligible: true }, { status: 503 }),
    new Response('not JSON'), new Response(null, { status: 204 }),
    new TypeError('Network unavailable'), new DOMException('Timed out', 'AbortError'),
  ]) {
    const api = client(200, { ok: true, votes: 20 }, false, response);
    const error = await api.castVote('https://example.invalid', 'public-wallet', 'incident:full').catch((e: Error) => e);
    expect(error).toBeInstanceOf(api.VoteError);
    expect(error.stage).toBe('preflight'); expect(error.code).toBe('wallet_age_unavailable');
    expect(error.txHash).toBeUndefined(); expect(error.retryAfter).toBeUndefined();
    expect(api.calls).toEqual(['preflight']);
  }
});

test('preflight success precedes signing and does not replace final registration', async () => {
  const api = client(200, { ok: true, votes: 20 });
  await expect(api.castVote('https://example.invalid', 'public-wallet', 'incident:full')).resolves.toMatchObject({ votes: 20, txHash: hash });
  expect(api.calls).toEqual(submittedCalls);
});

test('pre-sign feedback says no transaction and never displays Stellar proof', () => {
  const View = load('../../src/components/VoteFeedback.tsx').default;
  for (const lang of ['es', 'en']) {
    for (const code of ['wallet_too_new', 'wallet_age_unavailable']) {
      const html = renderToStaticMarkup(createElement(View, { lang, feedback: {
        accepted: false, stage: 'preflight', code, eligibleAt, minAgeSeconds: 86400,
      } }));
      expect(html).toContain(lang === 'es' ? 'No se firmó ni se envió una transacción.' : 'No transaction was signed or submitted.');
      expect(html).toContain('role="status"'); expect(html).not.toContain('href=');
      expect(html).not.toContain(lang === 'es' ? 'Transacción confirmada' : 'Transaction confirmed');
    }
  }
});

test('age rejection retains eligibility and the confirmed Stellar hash, not a cooldown', async () => {
  const api = client(403, { error: 'wallet_too_new', min_age_s: 86400, retry_after: 83110, eligible_at: eligibleAt });
  const error = await api.castVote('https://example.invalid', 'public-wallet', 'incident:full').catch((e: Error) => e);
  expect(error).toBeInstanceOf(api.VoteError);
  expect(error.code).toBe('wallet_too_new');
  expect(error.eligibleAt).toBe(eligibleAt);
  expect(error.minAgeSeconds).toBe(86400);
  expect(error.txHash).toBe(hash);
  expect(error.retryAfter).toBeUndefined();
  expect(api.calls).toEqual(submittedCalls);
});

test('age retry_after is anchored once and never becomes the voting cooldown', async () => {
  const before = Date.now();
  const api = client(403, { error: 'wallet_too_new', retry_after: 12300 });
  const error = await api.castVote('https://example.invalid', 'public-wallet', 'incident:full').catch((e: Error) => e);
  expect(error.ageRetryAtMs).toBeGreaterThanOrEqual(before + 12300000);
  expect(error.ageRetryAtMs).toBeLessThanOrEqual(Date.now() + 12300000);
  expect(error.retryAfter).toBeUndefined();
  expect(api.calls).toEqual(submittedCalls);
  for (const retry_after of [undefined, -1, '12300', 1.5]) {
    const invalid = client(403, { error: 'wallet_too_new', retry_after });
    const result = await invalid.castVote('https://example.invalid', 'public-wallet', 'incident:full').catch((e: Error) => e);
    expect(result.ageRetryAtMs).toBeUndefined();
    expect(result.retryAfter).toBeUndefined();
  }
});

test('unavailable age and lost registration response retain proof without reporting acceptance', async () => {
  for (const networkFailure of [false, true]) {
    const api = client(503, { error: 'wallet_age_unavailable' }, networkFailure);
    const error = await api.castVote('https://example.invalid', 'public-wallet', 'incident:full').catch((e: Error) => e);
    expect(error).toBeInstanceOf(api.VoteError);
    expect(error.code).toBe(networkFailure ? 'registration_unconfirmed' : 'wallet_age_unavailable');
    expect(error.txHash).toBe(hash);
    expect(error.retryAfter).toBeUndefined();
    expect(api.calls).toEqual(submittedCalls);
  }
});

test('a successful HTTP response without an accepted vote remains unconfirmed', async () => {
  const api = client(200, {});
  const error = await api.castVote('https://example.invalid', 'public-wallet', 'incident:full').catch((e: Error) => e);
  expect(error).toBeInstanceOf(api.VoteError);
  expect(error.code).toBe('registration_unconfirmed');
  expect(error.txHash).toBe(hash);
  expect(api.calls).toEqual(submittedCalls);
});

test('existing accepted vote, duplicate and cooldown behavior are preserved', async () => {
  const accepted = client(200, { ok: true, votes: 20, donation_status: 'community', cooldown_s: 300 });
  await expect(accepted.castVote('https://example.invalid', 'public-wallet', 'incident:full')).resolves.toEqual({
    votes: 20, donationStatus: 'community', cooldownS: 300, txHash: hash,
    explorerUrl: `https://stellar.expert/explorer/testnet/tx/${hash}`,
  });
  for (const [status, body, message, retry] of [
    [409, { error: 'already_voted' }, 'Ya votaste esta señal', undefined],
    [429, { error: 'cooldown', retry_after: 40 }, 'Puedes votar de nuevo en 40 s', 40],
  ] as const) {
    const api = client(status, body);
    const error = await api.castVote('https://example.invalid', 'public-wallet', 'incident:full').catch((e: Error) => e);
    expect(error.message).toBe(message); expect(error.retryAfter).toBe(retry);
    expect(api.calls).toEqual(submittedCalls);
  }
});

test('persistent ES/EN feedback separates Stellar confirmation from VACA acceptance', () => {
  const View = load('../../src/components/VoteFeedback.tsx').default;
  for (const lang of ['es', 'en']) {
    const html = renderToStaticMarkup(createElement(View, { lang, feedback: {
      accepted: false, code: 'wallet_too_new', eligibleAt, minAgeSeconds: 86400, txHash: hash,
    } }));
    expect(html).toContain('role="status"'); expect(html).toContain('aria-live="polite"');
    expect(html).toContain('24'); expect(html).toMatch(/<time[^>]+datetime="2026-11-25T20:27:17Z"/i);
    expect(html).toContain(`href="https://stellar.expert/explorer/testnet/tx/${hash}"`);
    expect(html).toContain(lang === 'es' ? 'Voto no registrado' : 'Vote not recorded');
    expect(html).toContain(lang === 'es' ? 'Transacción confirmada en Stellar Testnet' : 'Transaction confirmed on Stellar Testnet');
    expect(html).not.toContain(lang === 'es' ? 'Voto registrado por VACA' : 'Vote recorded by VACA');
  }
});

test('remaining age is readable in ES/EN and expires without claiming acceptance', () => {
  const view = load('../../src/components/VoteFeedback.tsx');
  const now = Date.parse('2026-11-25T17:02:17Z');
  const feedback = { accepted: false, code: 'wallet_too_new', eligibleAt, ageRetryAtMs: now + 99999999 };
  expect(view.voteWaitDeadline(feedback)).toBe(Date.parse(eligibleAt));
  expect(view.voteWaitMessage('es', view.voteWaitDeadline(feedback), now)).toBe('Te faltan 3 horas y 25 minutos para poder votar.');
  expect(view.voteWaitMessage('en', view.voteWaitDeadline(feedback), now)).toContain('3 hours');
  expect(view.voteWaitMessage('en', view.voteWaitDeadline(feedback), now)).toContain('25 minutes');
  expect(view.voteWaitMessage('es', now + 60000, now)).toBe('Te falta 1 minuto para poder votar.');
  expect(view.voteWaitMessage('es', now + 1, now)).toBe('Te falta 1 minuto para poder votar.');
  expect(view.voteWaitMessage('es', now, now)).toContain('El servidor volverá a validar');
  expect(view.voteWaitMessage('en', now - 1, now)).toContain('The server will validate');
  expect(view.voteWaitMessage('es', null, now)).toBeNull();
  expect(view.voteWaitDeadline({ ...feedback, eligibleAt: 'invalid', ageRetryAtMs: now + 60000 })).toBe(now + 60000);
  for (const invalid of [undefined, NaN, Infinity, -1]) {
    expect(view.voteWaitDeadline({ ...feedback, eligibleAt: 'invalid', ageRetryAtMs: invalid })).toBeNull();
  }
  expect(view.voteWaitDeadline({ ...feedback, code: 'cooldown' })).toBeNull();
  expect(view.voteWaitDeadline({ ...feedback, accepted: true })).toBeNull();
  const html = renderToStaticMarkup(createElement(view.default, { lang: 'es', feedback: {
    accepted: false, code: 'wallet_too_new', eligibleAt: new Date(Date.now() + 12300000 - 500).toISOString(),
  } }));
  expect(html).toContain('Te faltan 3 horas y 25 minutos para poder votar.');
  expect(html).toContain('aria-live="off"');
  const expired = renderToStaticMarkup(createElement(view.default, { lang: 'es', feedback: {
    accepted: false, code: 'wallet_too_new', eligibleAt: '2020-01-01T00:00:00Z',
  } }));
  expect(expired).toContain('El servidor volverá a validar');
  expect(expired).not.toContain('Voto registrado por VACA');
});

test('unconfirmed registration never claims rejection, and invalid dates are not invented', () => {
  const View = load('../../src/components/VoteFeedback.tsx').default;
  const html = renderToStaticMarkup(createElement(View, { lang: 'es', feedback: {
    accepted: false, code: 'registration_unconfirmed', txHash: hash,
  } }));
  expect(html).toContain('No pudimos confirmar el registro');
  expect(html).not.toContain('Voto no registrado');
  const missingDate = renderToStaticMarkup(createElement(View, { lang: 'es', feedback: {
    accepted: false, code: 'wallet_too_new', eligibleAt: 'not-a-date', minAgeSeconds: 86400,
  } }));
  expect(missingDate).not.toContain('<time'); expect(missingDate).not.toContain('Invalid Date');
  expect(missingDate).not.toContain('href=');
});
