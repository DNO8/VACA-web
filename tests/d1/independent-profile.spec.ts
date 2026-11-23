import { test, expect, chromium } from '@playwright/test';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { Keypair, hash } from '@stellar/stellar-sdk';
import { readD1PublicConfig as read } from '../../src/lib/d1/public-config';
import { postAdminCommand as post } from '../../src/lib/d1/admin-command-transport';
import { proxyD1 as proxy } from '../../src/lib/d1/server-proxy';
import { D1_B, profileCommandFetcher, type D1Profile } from '../../src/lib/d1/profile';
import { createRefundSender } from '../../src/lib/d1/refund-submission';
import type { RefundJournal, RefundHold, RefundOriginalIdentity } from '../../src/lib/d1/refund-journal';

const a = {
  network: 'TESTNET' as const,
  donation_ttl_seconds: 300 as const,
  namespace: 'abcdef01-2345-6789-abcd-0123456789ab',
  pool_public_key: 'GCATS5YOVB6ROX2WUNKGNQ2MP3GMXDMKSG2O4N5CLX3A6W4PZGZZI55U',
};
const b = { ...a, namespace: D1_B.namespace, pool_public_key: D1_B.pool };
const enc = (x: unknown) => Buffer.from(JSON.stringify(x)).toString('base64url');
const env = {
  D1_CUSTODY_SUPABASE_URL: D1_B.origin,
  D1_CUSTODY_NAMESPACE: a.namespace,
  D1_CUSTODY_ANON_KEY:
    `${enc({ alg: 'HS256', typ: 'JWT' })}.` +
    `${enc({ role: 'anon', ref: 'tgqxxnldwiqisopiclmk' })}.` +
    Buffer.alloc(32, 7).toString('base64url'),
};
const digest = (x: unknown) =>
  createHash('sha256').update(JSON.stringify(x)).digest('hex');
const req = (path: string, body?: string) =>
  new Request('https://offline.test' + path, body === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body,
  });

test('independent invalid profile matrix has zero IO', async () => {
  let n = 0;
  const f: typeof fetch = async () => { n++; throw Error('forbidden IO'); };
  for (const profile of [
    null, '', 'unknown', 'https://evil.test', {}, false,
  ] as unknown as D1Profile[]) {
    expect(await read(new AbortController().signal, f, 5000, profile))
      .toEqual({ status: 'unavailable' });
    await expect(post('prepare', '{}', f, profile))
      .rejects.toThrow('d1_profile_unavailable');
    const r = await proxy(req('/api/d1/config'), 'config', { env, fetch: f, profile });
    expect([r.status, await r.json()])
      .toEqual([503, { error: 'configuration_error' }]);
  }
  expect(n).toBe(0);
});

test('independent B pins and namespace-free prepare bytes; scope and project fail closed', async () => {
  const calls: { url: string; body: unknown }[] = [];
  const f: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body });
    return Response.json({ state: 'unknown' }, { status: 503 });
  };
  const proof = ' \n' + JSON.stringify({
    version: 1, network: 'TESTNET', pool: D1_B.pool, signature: 'unchanged proof',
  }) + '\n';
  expect(await post('prepare', proof, f, 'B'))
    .toEqual({ status: 503, body: { state: 'unknown' } });
  expect(calls).toEqual([{ url: '/api/d1/video-auto/prepare', body: proof }]);

  for (const change of [
    { pool: a.pool_public_key }, { network: 'PUBLIC' },
    { namespace: a.namespace }, { namespace: null },
  ]) {
    const bytes = JSON.stringify({ ...JSON.parse(proof), ...change });
    const before = digest(bytes);
    await expect(post('prepare', bytes, f, 'B'))
      .rejects.toThrow('d1_profile_scope_mismatch');
    expect(digest(bytes)).toBe(before);
  }
  expect(calls).toHaveLength(1);

  for (const change of [
    { pool_public_key: a.pool_public_key }, { namespace: a.namespace },
    { network: 'PUBLIC' }, { donation_ttl_seconds: 299 },
  ]) {
    expect(await read(
      new AbortController().signal,
      async () => Response.json({ ...b, ...change }), 5000, 'B',
    )).toEqual({ status: 'unavailable' });
  }
  expect(await read(new AbortController().signal, async url => {
    expect(url).toBe('/api/d1/video-auto/config');
    return Response.json(b);
  }, 5000, 'B')).toEqual({ status: 'available', config: b });

  let forwarded = 0;
  const upstream: typeof fetch = async (url, init) => {
    forwarded++;
    expect(String(url))
      .toBe(D1_B.origin + '/functions/v1/d1-custody/video-auto/prepare');
    expect(Buffer.from(init!.body as Uint8Array).toString()).toBe(proof);
    return Response.json({ error: 'outcome_unresolved' }, { status: 503 });
  };
  const r = await proxy(req('/api/d1/video-auto/prepare', proof), 'prepare', {
    env, fetch: upstream, profile: 'B',
  });
  expect([r.status, await r.json()])
    .toEqual([503, { error: 'outcome_unresolved' }]);
  expect(forwarded).toBe(1);

  const bad = await proxy(req('/api/d1/video-auto/config'), 'config', {
    env: {
      ...env,
      D1_CUSTODY_SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
    },
    fetch: upstream, profile: 'B',
  });
  expect([bad.status, await bad.json()])
    .toEqual([503, { error: 'configuration_error' }]);
  expect(forwarded).toBe(1);
  await expect(profileCommandFetcher('B', f)(
    'https://evil.test/prepare', { body: proof },
  )).rejects.toThrow('d1_profile_unavailable');
});

test('independent signed B refund 503 consumes capability without changing either original hold', async () => {
  const retained = new Map<string, RefundHold>();
  const key = (i: RefundOriginalIdentity) => JSON.stringify(i);
  const journal: RefundJournal = {
    close() {},
    async read(i) { return retained.get(key(i)) ?? null; },
    async claimExecution(i, attempt) {
      const old = retained.get(key(i));
      const hold = old ?? { identity: i, attempt };
      retained.set(key(i), hold);
      return { claimed: !old, hold };
    },
  };
  const wallet = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 23));
  const request_id = '12345678-1234-1234-1234-123456789abc';
  const now = 1700000000;
  const identity: RefundOriginalIdentity = {
    network: 'TESTNET', namespace: b.namespace, pool: b.pool_public_key, request_id,
  };
  const originalA = {
    ...identity, namespace: a.namespace, pool: a.pool_public_key,
  };
  await journal.claimExecution(originalA, {
    version: 1, action: 'refund', signedBody: ' retained A bytes\n',
  });
  const unsigned = {
    ...identity, version: 1, action: 'refund',
    timestamp: now, payload: {}, wallet: wallet.publicKey(),
  };
  const message = JSON.stringify(Object.fromEntries(
    Object.entries(unsigned).sort(([x], [y]) => x < y ? -1 : x > y ? 1 : 0),
  ));
  const body = ' ' + JSON.stringify({
    ...unsigned,
    signature: wallet.sign(hash(Buffer.from(
      'Stellar Signed Message:\n' + message,
    ))).toString('base64'),
  }) + '\n';
  const calls: string[] = [];
  const f: typeof fetch = async (url, init) => {
    calls.push(String(url));
    expect(init?.body).toBe(body);
    return Response.json({ error: 'outcome_unresolved' }, { status: 503 });
  };
  const sender = createRefundSender(
    b, journal, identity, profileCommandFetcher('B', f), () => now,
  );
  const capability = await sender.claim(body);
  const before = digest([...retained]);
  expect(await capability.send())
    .toEqual({ status: 503, body: { error: 'outcome_unresolved' } });
  await expect(capability.send())
    .rejects.toThrow('d1_refund_capability_consumed');
  await expect(sender.claim(body))
    .rejects.toThrow('d1_refund_execution_retained');
  expect(digest([...retained])).toBe(before);
  expect(calls).toEqual(['/api/d1/video-auto/refund']);
  expect(retained.size).toBe(2);
});

let bundle = '';
test.beforeAll(async () => {
  const root = process.cwd();
  const dir = join(process.env.TMPDIR!, 'independent-browser');
  mkdirSync(dir, { recursive: true });
  const ports = join(dir, 'ports.js');
  const loader = join(dir, 'loader.cjs');
  const entry = join(dir, 'entry.tsx');

  writeFileSync(ports, `
    export const p={calls:[],pending:0,complete(){},unmount(){}};
    const originals=new Map();
    export const signTransaction=async()=>{
      throw Error('real wallet forbidden')
    };
    export function donationRecovery(session){
      return {session,evidence:null,deadline:null}
    };
    export function createDonationFlow({config}){
      const scope=config.namespace;
      return {
        dispose(){},
        async recover(){
          return originals.has(scope)
            ? donationRecovery(originals.get(scope)) : null
        },
        async prepare(amount){
          p.calls.push(scope);p.pending++;
          await new Promise(r=>p.complete=r);p.pending--;
          const session={state:'intent',snapshot:{
            intent:{config,amount,donor:'synthetic',
              incident_id:'incident',request_id:'synthetic'},
            transactionHash:'a'.repeat(64)
          }};
          originals.set(scope,session);
          return donationRecovery(session)
        }
      }
    };
  `);
  writeFileSync(loader, `
    const ts=require(${JSON.stringify(require.resolve('typescript'))});
    module.exports=s=>ts.transpileModule(s,{compilerOptions:{
      target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,
      jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true
    }}).outputText;
  `);
  writeFileSync(entry, `
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {LangProvider,useLang}
      from ${JSON.stringify(resolve(root, 'src/lib/i18n.tsx'))};
    import Section
      from ${JSON.stringify(resolve(root, 'src/components/D1DonationSection.tsx'))};
    import {openDonationJournal}
      from ${JSON.stringify(resolve(root, 'src/lib/d1/donation-journal.ts'))};
    import {openRefundJournal}
      from ${JSON.stringify(resolve(root, 'src/lib/d1/refund-journal.ts'))};
    import {p} from './ports';
    window.probe=Object.assign(p,{
      openDonationJournal,openRefundJournal,
      configCalls:[],releaseA(){}
    });
    window.fetch=async url=>{
      p.configCalls.push(url);
      if(url==='/api/d1/config')
        await new Promise(r=>p.releaseA=r);
      return Response.json(url==='/api/d1/config'
        ? ${JSON.stringify(a)} : ${JSON.stringify(b)})
    };
    function View(){
      const {setLang}=useLang();
      return <>
        <button onClick={()=>setLang('en')}>EN</button>
        <Section wallet="synthetic" incidentId="incident"
          enabled externalBusy={false} onBusyChange={()=>{}}/>
      </>
    };
    const root=createRoot(document.getElementById('root'));
    p.unmount=()=>root.unmount();
    root.render(<LangProvider><View/></LangProvider>);
  `);
  const aliases = Object.fromEntries([
    '../lib/d1/donation-flow',
    '../lib/d1/donation-recovery',
    '@stellar/freighter-api',
  ].map(x => [x + '$', ports]));
  const { webpack } = require('next/dist/compiled/webpack/bundle5')();
  await new Promise<void>((yes, no) => {
    const c = webpack({
      mode: 'development', target: 'web', entry,
      devtool: false, cache: false,
      output: { path: dir, filename: 'bundle.js' },
      resolve: {
        extensions: ['.tsx', '.ts', '.js'],
        modules: [join(root, 'node_modules'), 'node_modules'],
        alias: aliases,
      },
      module: {
        rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: loader }],
      },
    }, (e: Error | null, s: { hasErrors(): boolean; toString(): string }) =>
      c.close((ce: Error | null) =>
        e || ce || s.hasErrors()
          ? no(e ?? ce ?? Error(s.toString())) : yes()));
  });
  bundle = readFileSync(join(dir, 'bundle.js'), 'utf8');
});

test('independent mounted keyboard, busy exclusion, stale config/result and real IDB hold separation', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.D1_TEST_BROWSER,
    headless: true, chromiumSandbox: true,
  });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const blocked: string[] = [], errors: string[] = [];
    await context.route('**/*', route => {
      if (route.request().url() === 'http://independent.test/' &&
          route.request().isNavigationRequest()) {
        return route.fulfill({
          contentType: 'text/html',
          body: '<!doctype html><html><div id="root"></div></html>',
        });
      }
      blocked.push(route.request().url());
      return route.abort();
    });
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.goto('http://independent.test/');
    await page.addScriptTag({ content: bundle });
    await page.getByRole('button', { name: 'EN', exact: true }).click();

    const ar = page.getByRole('radio', {
      name: 'A · original (default)', exact: true,
    });
    const br = page.getByRole('radio', {
      name: 'B · video-auto (separate pool)', exact: true,
    });
    await expect(ar).toBeChecked();
    await ar.focus();
    await page.keyboard.press('ArrowRight');
    await expect(br).toBeChecked();
    await expect(br).toBeFocused();
    await expect(page.locator('input[name="amount"]')).toBeVisible();
    await page.evaluate(() => ((window as any).probe.releaseA)());
    await expect(page.getByText(a.pool_public_key, { exact: true })).toHaveCount(0);

    await page.getByRole('button', {
      name: 'Prepare or recover original (no signing or sending)', exact: true,
    }).click();
    await expect(ar).toBeDisabled();
    await expect(br).toBeDisabled();
    await page.keyboard.press('ArrowLeft');
    await expect(br).toBeChecked();
    await page.evaluate(() => {
      const p = (window as any).probe;
      p.unmount(); p.complete();
    });
    await expect(page.locator('#root')).toBeEmpty();

    const result = await page.evaluate(async ({ a, b }) => {
      const p = (window as any).probe;
      const idA = '11111111-1111-1111-1111-111111111111';
      const idB = '22222222-2222-2222-2222-222222222222';
      let d = await p.openDonationJournal(indexedDB, 'independent-originals');
      let r = await p.openRefundJournal(indexedDB);
      const scopes = [a, b].map(c => JSON.stringify([
        c.network, c.pool_public_key, c.namespace, 'same-donor', 'same-incident',
      ]));
      const identities = [a, b].map(c => ({
        network: c.network, namespace: c.namespace,
        pool: c.pool_public_key, request_id: idA,
      }));
      for (let i = 0; i < 2; i++) {
        const id = i ? idB : idA;
        await d.acquire(scopes[i], id, ' intent ' + i);
        await d.saveSigned(id, ' intent ' + i, ' signed ' + i);
        await d.claimSubmission(id, ' signed ' + i);
        await r.claimExecution(identities[i], {
          version: 1, action: 'refund', signedBody: ' exact ' + i,
        });
      }
      const snapshot = async () => JSON.stringify(await Promise.all([
        ...scopes.map(s => d.readScope(s)),
        ...identities.map(i => r.read(i)),
      ]));
      const before = await snapshot();
      d.close(); r.close();
      d = await p.openDonationJournal(indexedDB, 'independent-originals');
      r = await p.openRefundJournal(indexedDB);
      const losers = [];
      for (let i = 0; i < 2; i++) {
        losers.push((await d.claimSubmission(
          i ? idB : idA, ' signed ' + i,
        )).claimed);
        losers.push((await r.claimExecution(identities[i], {
          version: 2, action: 'refund_remainder', signedBody: ' rival',
        })).claimed);
      }
      const after = await snapshot();
      d.close(); r.close();
      return { before, after, losers, calls: p.calls, pending: p.pending };
    }, { a, b });

    expect(digest(result.after)).toBe(digest(result.before));
    expect(result.losers).toEqual([false, false, false, false]);
    expect(result.calls).toEqual([b.namespace]);
    expect(result.pending).toBe(0);
    expect(blocked).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});
