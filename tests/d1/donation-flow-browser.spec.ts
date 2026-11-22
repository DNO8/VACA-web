import { test as base, expect, chromium, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import ts from 'typescript';
import type { DonationJournalV2 } from '../../src/lib/d1/donation-journal';

// New S4/S7 regressions, not copies of the disposable independent probes.
// The exact production Aside/Panel run in React DOM with fake financial ports.
// The final case separately exercises the production journal in real IndexedDB.
let bundle: string;
const ports = `
import React from 'react';
export const donor = 'synthetic-donor';
export const config = { network: 'TESTNET', pool_public_key: 'synthetic-pool', namespace: 'synthetic-namespace', donation_ttl_seconds: 300 };
export const probe = { calls: { prepare: 0, sign: 0, send: 0, check: 0, wallet: 0, vote: 0 },
  hold: '', pending: 0, completed: 0, disposed: [], voteResults: [], configProfiles: [], release() {}, render() {}, unmount() {} };
const sessions = new Map();
async function gate(action) {
  if (probe.hold === action) {
    probe.hold = ''; probe.pending++;
    await new Promise(resolve => { probe.release = resolve; });
    probe.pending--;
  }
}
export const useLang = () => ({ lang: 'en', t: (key, vars) => key + (vars ? ':' + Object.values(vars).join('|') : '') });
export const readD1PublicConfig = async (_signal, _fetcher, _timeout, profile = 'A') => {
  probe.configProfiles.push(profile); await gate('config');
  return { status: 'available', config: profile === 'A' ? config : { ...config, namespace: 'synthetic-B', pool_public_key: 'separate-B-pool' } };
};
export const openDonationJournal = async () => ({ close() {} });
export function donationRecovery(session, evidence = null) {
  return { session, evidence, repeatBlocked: true, deadline: evidence ? '2027-01-15T08:05:00Z' : null };
}
export function createDonationFlow({ incidentId, config }) {
  const scope = JSON.stringify([config.namespace, incidentId]);
  return {
    dispose() { probe.disposed.push(incidentId); },
    async recover() { return sessions.has(scope) ? donationRecovery(sessions.get(scope)) : null; },
    async prepare(amount) {
      probe.calls.prepare++; await gate('prepare');
      const session = { state: 'intent', scope: incidentId, requestId: 'render-only-id', snapshot: {
        intent: { config, donor, incident_id: incidentId, request_id: 'render-only-id', asset: { type: 'native' }, amount },
        transactionHash: 'a'.repeat(64), unsignedXdr: 'render-only-unsigned' } };
      sessions.set(scope, session); probe.completed++; return donationRecovery(session);
    },
    async sign(session) {
      probe.calls.sign++; await gate('sign');
      const signed = { ...session, state: 'signed', snapshot: { ...session.snapshot, signedTxXdr: 'render-only-signed' } };
      sessions.set(scope, signed); return signed;
    },
    async send(session) {
      probe.calls.send++; await gate('send');
      sessions.set(scope, { ...session, state: 'submission_claimed' });
      return { state: 'unknown', transactionHash: session.snapshot.transactionHash };
    },
    async check() {
      probe.calls.check++; await gate('check');
      return { state: 'observed', evidence: { payment: { confirmedAt: 1800000000 } } };
    }
  };
}
export const isConnected = async () => ({ isConnected: true });
export const requestAccess = async () => { probe.calls.wallet++; return { address: donor }; };
export const signTransaction = async () => { throw Error('No real wallet port is allowed'); };
export const getBalance = async () => '10.00';
export const getVoteCooldown = async () => 0;
export class VoteError extends Error {}
export async function castVote() {
  probe.calls.vote++; await gate('vote');
  return { votes: 4, donationStatus: 'community', cooldownS: 300, explorerUrl: 'https://example.invalid/vote' };
}
export const CATEGORY_COLOR = { sos: '#fff' }, VAQUITA_GOLD = '#fc0';
export const X = () => null, Vote = X, HeartHandshake = X, MapPin = X, Users = X, Wallet = X, Loader2 = X, ExternalLink = X;
export default () => null;
`;

base.beforeAll(async () => {
  const root = resolve(__dirname, '../..');
  const scratch = mkdtempSync(join(tmpdir(), 'vaca-donor-browser-'));
  try {
    const portFile = join(scratch, 'ports.js');
    const loader = join(scratch, 'loader.cjs');
    const entry = join(scratch, 'entry.tsx');
    writeFileSync(portFile, ports);
    writeFileSync(loader, `const ts = require(${JSON.stringify(require.resolve('typescript'))});
      module.exports = source => ts.transpileModule(source, { compilerOptions: {
        target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX
      } }).outputText;`);
    writeFileSync(entry, `import React from 'react';
      import { createRoot } from 'react-dom/client';
      import Aside from ${JSON.stringify(join(root, 'src/components/VaquitaAside.tsx'))};
      import { probe } from './ports';
      const root = createRoot(document.getElementById('root'));
      window.donorProbe = probe;
      probe.render = incidentId => root.render(<Aside incident={{ id: incidentId, category: 'sos', donationStatus: 'community', votes: 3 }}
        regionName="Synthetic region" supabaseUrl="https://example.invalid" voteThreshold={5}
        onVote={(id, result) => probe.voteResults.push({ id, result })} onClose={() => {}} />);
      probe.unmount = () => root.unmount();
      probe.render('incident:original');`);
    const aliases = Object.fromEntries([
      '../lib/i18n', '../lib/d1/public-config', '../lib/d1/donation-journal', '../lib/d1/donation-flow', '../lib/d1/donation-recovery',
      '@/lib/i18n', '@/lib/vaquitas', '@/lib/donate', '@/lib/vote', './D1Readiness', '@stellar/freighter-api', 'lucide-react',
    ].map(name => [name + '$', portFile]));
    // Only the installed compiled webpack API is loaded: no Next config, server or env loader.
    const { webpack } = require('next/dist/compiled/webpack/bundle5')();
    await new Promise<void>((done, reject) => {
      const compiler = webpack({ mode: 'development', target: 'web', devtool: false, cache: false, entry,
        output: { path: scratch, filename: 'browser.js' },
        resolve: { modules: [join(root, 'node_modules'), 'node_modules'], extensions: ['.tsx', '.ts', '.js'], alias: aliases },
        module: { rules: [{ test: /\.tsx?$/, use: loader }] },
      });
      compiler.run((error: Error | null, stats: { hasErrors(): boolean; toString(): string } | undefined) => {
        compiler.close((closeError: Error | null) => {
          if (error || closeError) reject(error ?? closeError);
          else if (!stats || stats.hasErrors()) reject(new Error(stats?.toString() ?? 'Missing webpack result'));
          else done();
        });
      });
    });
    bundle = readFileSync(join(scratch, 'browser.js'), 'utf8');
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

type Probe = {
  calls: Record<'prepare' | 'sign' | 'send' | 'check' | 'wallet' | 'vote', number>;
  hold: string; pending: number; completed: number; disposed: string[]; configProfiles: string[];
  voteResults: unknown[]; release(): void; render(incidentId: string): void; unmount(): void;
};
type BrowserWindow = typeof window & { donorProbe: Probe; journalModule: typeof import('../../src/lib/d1/donation-journal'); journal: DonationJournalV2 };
const test = base.extend<{ pages: [Page, Page] }>({
  pages: async ({}, use, info) => {
    console.log(`Donor browser regression output: ${info.project.outputDir}`);
    const browser = await chromium.launch({ executablePath: process.env.D1_TEST_BROWSER || chromium.executablePath(), headless: true, chromiumSandbox: true });
    try {
      const context = await browser.newContext({ serviceWorkers: 'block' });
      const origin = `http://donor-${randomUUID()}.test/`;
      const blocked: string[] = [], errors: string[] = [];
      await context.route('**/*', route => {
        if (route.request().url() === origin && route.request().isNavigationRequest()) return route.fulfill({
          contentType: 'text/html', body: '<!doctype html><html lang="en"><title>Offline donor regression</title><div id="root"></div></html>',
        });
        blocked.push(route.request().url()); return route.abort();
      });
      const pages: [Page, Page] = [await context.newPage(), await context.newPage()];
      for (const page of pages) { page.on('pageerror', error => errors.push(error.message)); await page.goto(origin); }
      await use(pages);
      expect(blocked).toEqual([]); expect(errors).toEqual([]);
    } finally { await browser.close(); }
  },
});
async function connect(page: Page) {
  await page.addScriptTag({ content: bundle });
  await page.getByRole('button', { name: 'connect_wallet', exact: true }).click();
  await expect(page.getByLabel('amount_aria', { exact: false })).toBeVisible();
}
async function hold(page: Page, action: string) {
  await page.evaluate(action => { (window as BrowserWindow).donorProbe.hold = action; }, action);
}
async function release(page: Page) { await page.evaluate(() => (window as BrowserWindow).donorProbe.release()); }
async function calls(page: Page) { return page.evaluate(() => (window as BrowserWindow).donorProbe.calls); }
async function retainedOnly(page: Page) {
  await expect(page.locator('input[name="amount"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^d1_(prepare|send|sign)/ })).toHaveCount(0);
  await expect(page.getByText('d1_repeat_limit', { exact: true })).toBeVisible();
  await expect(page.getByText('d1_delivery_unknown', { exact: true })).toBeVisible();
  await expect(page.getByText('d1_settlement_unknown', { exact: true })).toBeVisible();
}

test('production panel keeps actions explicit, excludes busy wallet/vote work and retains unknown/observed payments', async ({ pages: [page] }) => {
  await connect(page);
  expect(await calls(page)).toEqual({ prepare: 0, sign: 0, send: 0, check: 0, wallet: 1, vote: 0 });
  await page.getByLabel('amount_aria', { exact: false }).fill('1.0000001');
  await hold(page, 'prepare');
  await page.getByRole('button', { name: 'd1_prepare', exact: true }).click();
  await expect(page.getByRole('button', { name: 'd1_prepare', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'vote_cta', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'synthe…onor', exact: true })).toBeDisabled();
  await page.locator('form').evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect((await calls(page)).prepare).toBe(1);
  await release(page);
  await expect(page.getByRole('button', { name: 'd1_sign:1.0000001', exact: true })).toBeEnabled();
  await expect(page.getByText('a'.repeat(64), { exact: true })).toBeVisible();
  await expect(page.getByText('d1_retained_amount: 1.0000001 XLM', { exact: true })).toBeVisible();
  expect(await calls(page)).toMatchObject({ prepare: 1, sign: 0, send: 0, check: 0 });
  await hold(page, 'sign');
  await page.getByRole('button', { name: 'd1_sign:1.0000001', exact: true }).click();
  await expect(page.getByRole('button', { name: 'd1_sign:1.0000001', exact: true })).toBeDisabled();
  await release(page);
  const send = page.getByRole('button', { name: 'd1_send:1.0000001', exact: true });
  await expect(send).toBeEnabled();
  expect((await calls(page)).send).toBe(0);
  await hold(page, 'vote');
  await page.getByRole('button', { name: 'vote_cta', exact: true }).click();
  await expect(send).toBeDisabled();
  await release(page);
  await expect(send).toBeEnabled();
  await expect(page.getByRole('button', { name: /^vote_cooldown:/ })).toBeDisabled();
  expect(await page.evaluate(() => (window as BrowserWindow).donorProbe.voteResults)).toEqual([
    { id: 'incident:original', result: { votes: 4, donationStatus: 'community' } },
  ]);
  await hold(page, 'send'); await send.click();
  await expect(send).toBeDisabled(); await release(page);
  await expect(page.getByRole('status')).toHaveText('d1_submitted_unverified');
  await retainedOnly(page);
  expect((await calls(page)).check).toBe(0);
  await hold(page, 'check');
  const check = page.getByRole('button', { name: 'd1_check_original', exact: true });
  await check.click(); await expect(check).toBeDisabled(); await release(page);
  await expect(page.getByRole('status')).toHaveText('d1_observed');
  await expect(page.locator('time')).toHaveAttribute('datetime', '2027-01-15T08:05:00Z');
  await retainedOnly(page);
  await page.getByRole('button', { name: 'd1_recover', exact: true }).click();
  await expect(check).toBeEnabled(); await retainedOnly(page);
  expect(await calls(page)).toEqual({ prepare: 1, sign: 1, send: 1, check: 1, wallet: 1, vote: 1 });
});

test('pending panel completions cannot repaint a changed incident or an unmounted panel', async ({ pages: [page] }) => {
  await connect(page); await hold(page, 'prepare');
  await page.getByRole('button', { name: 'd1_prepare', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as BrowserWindow).donorProbe.pending)).toBe(1);
  await page.evaluate(() => (window as BrowserWindow).donorProbe.render('incident:new'));
  await expect(page.getByRole('status')).toHaveText('d1_ready');
  await release(page);
  await expect.poll(() => page.evaluate(() => (window as BrowserWindow).donorProbe.completed)).toBe(1);
  await expect(page.locator('input[name="amount"]')).toBeVisible();
  await expect(page.getByRole('button', { name: /^d1_sign/ })).toHaveCount(0);
  await hold(page, 'prepare');
  await page.getByRole('button', { name: 'd1_prepare', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as BrowserWindow).donorProbe.pending)).toBe(1);
  await page.evaluate(() => (window as BrowserWindow).donorProbe.unmount()); await release(page);
  await expect.poll(() => page.evaluate(() => (window as BrowserWindow).donorProbe.completed)).toBe(2);
  await expect(page.locator('#root')).toBeEmpty();
  expect(await page.evaluate(() => (window as BrowserWindow).donorProbe.disposed)).toEqual(['incident:original', 'incident:new']);
  expect(await calls(page)).toEqual({ prepare: 2, sign: 0, send: 0, check: 0, wallet: 1, vote: 0 });
});

test('native profile selection is keyboard operable, locked during work, and recovers only its retained scope', async ({ pages: [page] }) => {
  await connect(page);
  const a = page.getByRole('radio', { name: 'd1_profile_a', exact: true });
  const b = page.getByRole('radio', { name: 'd1_profile_b', exact: true });
  await expect(a).toBeChecked(); await expect(a).toBeEnabled();
  await a.focus(); await expect(a).toBeFocused(); await page.keyboard.press('ArrowRight');
  await expect(b).toBeChecked(); await expect(b).toBeFocused();
  await expect(page.getByText('TESTNET · d1_config_pool separate-B-pool')).toBeVisible();
  await hold(page, 'prepare'); await page.getByRole('button', { name: 'd1_prepare', exact: true }).click();
  await expect(a).toBeDisabled(); await expect(b).toBeDisabled();
  await release(page); await expect(a).toBeEnabled();
  await expect(page.getByRole('button', { name: 'd1_sign:5', exact: true })).toBeVisible();
  await a.check(); await expect(page.getByLabel('amount_aria', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'd1_prepare', exact: true }).click();
  await expect(page.getByRole('button', { name: 'd1_sign:5', exact: true })).toBeVisible();
  await b.check();
  await expect(page.getByText('d1_namespace: synthetic-B', { exact: true })).toBeVisible();
  await a.check();
  await expect(page.getByText('d1_namespace: synthetic-namespace', { exact: true })).toBeVisible();
  expect(await calls(page)).toEqual({ prepare: 2, sign: 0, send: 0, check: 0, wallet: 1, vote: 0 });
  expect(await page.evaluate(() => (window as BrowserWindow).donorProbe.configProfiles)).toEqual(['A', 'B', 'A', 'B', 'A']);
});

test('late B configuration cannot repaint an unmounted donor view', async ({ pages: [page] }) => {
  await connect(page); await hold(page, 'config');
  await page.getByRole('radio', { name: 'd1_profile_b', exact: true }).check();
  await expect.poll(() => page.evaluate(() => (window as BrowserWindow).donorProbe.pending)).toBe(1);
  await page.evaluate(() => (window as BrowserWindow).donorProbe.unmount()); await release(page);
  await expect.poll(() => page.evaluate(() => (window as BrowserWindow).donorProbe.pending)).toBe(0);
  await expect(page.locator('#root')).toBeEmpty();
  expect(await calls(page)).toEqual({ prepare: 0, sign: 0, send: 0, check: 0, wallet: 1, vote: 0 });
});

// Opaque journal bytes deliberately do not claim signature validity or coordinator coverage.
const journalScript = `(() => { const exports = {}; ${ts.transpileModule(readFileSync(resolve(__dirname, '../../src/lib/d1/donation-journal.ts'), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText}\nwindow.journalModule = exports; })();`;
async function loadJournal(page: Page) {
  await page.addScriptTag({ content: journalScript });
  await page.evaluate(async () => { const w = window as BrowserWindow; w.journal = await w.journalModule.openDonationJournal(indexedDB, 'donor-regression'); });
}
test('real IndexedDB permits one cross-instance original claim and retains it after reload', async ({ pages: [a, b] }) => {
  await loadJournal(a); await loadJournal(b);
  const id = '11111111-2222-3333-4444-555555555555';
  const rival = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const scope = 'synthetic-original-scope', intent = ' exact original amount ', signed = ' exact signed bytes\n';
  await a.evaluate(async ({ scope, id, intent, signed }) => {
    const journal = (window as BrowserWindow).journal;
    await journal.acquire(scope, id, intent); await journal.saveSigned(id, intent, signed);
  }, { scope, id, intent, signed });
  const claim = (page: Page) => page.evaluate(({ id, signed }) => (window as BrowserWindow).journal.claimSubmission(id, signed), { id, signed });
  const winners = await Promise.all([claim(a), claim(b)]);
  expect(winners.map(result => result.claimed).sort()).toEqual([false, true]);
  const original = { scope, requestId: id, intent, signed, state: 'submission_claimed' };
  expect(winners.map(result => result.record)).toEqual([original, original]);
  await a.evaluate(() => (window as BrowserWindow).journal.close());
  await a.reload(); await loadJournal(a);
  for (const page of [a, b]) {
    expect(await claim(page)).toEqual({ claimed: false, record: original });
    expect(await page.evaluate(({ scope, rival }) => (window as BrowserWindow).journal.acquire(scope, rival, 'new amount'), { scope, rival }))
      .toEqual({ acquired: false, record: original });
    expect(await page.evaluate(id => (window as BrowserWindow).journal.read(id), id)).toEqual(original);
    await page.evaluate(() => (window as BrowserWindow).journal.close());
  }
  await loadJournal(a);
  const bScope = JSON.stringify(['TESTNET', 'GAYWVFBP2YPYMU245D6AOE7WWTVZOWGPVIFVGOH5EFFSSQ3VZAVR5JCW', '8126a1f4-ed8a-41ec-905b-9ad3442e5e6e', 'same-donor', 'same-incident']);
  expect(await a.evaluate(({ bScope, rival }) => (window as BrowserWindow).journal.acquire(bScope, rival, 'distinct B original'), { bScope, rival })).toMatchObject({ acquired: true, record: { scope: bScope, requestId: rival, state: 'intent' } });
  expect(await claim(a)).toEqual({ claimed: false, record: original });
  await a.reload(); await loadJournal(a);
  expect(await a.evaluate(scope => (window as BrowserWindow).journal.readScope(scope), scope)).toEqual({ record: original, active: true, resolution: null });
  expect(await a.evaluate(bScope => (window as BrowserWindow).journal.readScope(bScope), bScope)).toMatchObject({ active: true, resolution: null, record: { scope: bScope, requestId: rival, state: 'intent', intent: 'distinct B original' } });
  await a.evaluate(() => (window as BrowserWindow).journal.close());
});
