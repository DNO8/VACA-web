import { test as base, expect, chromium, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import type { RefundJournal, RefundOriginalIdentity, RefundExecutionAttempt } from '../../src/lib/d1/refund-journal';

// New portable regressions, not recovered verifier bytes. UI ports below are deliberately
// synthetic: real coordinator/proof/sender coverage remains in the existing Node suites.
// Only the third case exercises production financial infrastructure: the real IDB journal.
interface BrowserProbe {
  calls: string[];
  curation: { incident: string; status: string }[];
  changed: number;
  legacy: number;
  complete(error?: string): void;
  openRefundJournal: typeof import('../../src/lib/d1/refund-journal').openRefundJournal;
  journal?: RefundJournal;
}
declare global { interface Window { adminBrowser: BrowserProbe } }
const namespace = 'abcdef01-2345-6789-abcd-0123456789ab';
const request_id = '01234567-89ab-cdef-0123-456789abcdef';
const pool = 'GCATS5YOVB6ROX2WUNKGNQ2MP3GMXDMKSG2O4N5CLX3A6W4PZGZZI55U';
const beneficiary = 'GDWUSKGGFDI4FRXK5EBTRECZSVQSSWJHHJOGH6JWG3AUMFFMQ435DIAG';
const payment = { transaction_hash: 'ab'.repeat(32), operation_id: '99', donor: 'GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR', pool, asset: { type: 'native' }, amount: '10.0000000', confirmedAt: 1700000000 };
const config = { network: 'TESTNET', pool_public_key: pool, namespace, donation_ttl_seconds: 300 };
const origin = 'http://d1-admin-browser.local';
let scratch: string | undefined, bundle = '';

base.beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'vaca-admin-browser-'));
  const root = process.cwd(), require = createRequire(__filename);
  const ports = join(scratch, 'ports.ts'), loader = join(scratch, 'loader.cjs');
  writeFileSync(ports, `
    export const probe = { calls: [], curation: [], changed: 0, legacy: 0, complete() {} };
    export const useLang = () => ({ lang: 'en', t: key => key });
    export const CATEGORY_COLOR = { sos: '#fff' };
    export const X = () => null, ShieldCheck = X, Loader2 = X, Vote = X;
    // No real wallet, legacy release, membership lookup or backend implementation is loaded.
    export const signMessage = async () => { probe.legacy++; throw Error('wallet forbidden'); };
    export const createVaquitaClaim = signMessage, recordClaim = signMessage;
    export async function setDonationStatus(_url, _session, incident, status) {
      probe.curation.push({ incident, status }); return { stellarPubkey: 'must not release' };
    }
    export const readD1PublicConfig = async () => ({ status: 'available', config: ${JSON.stringify(config)} });
    export const observeAdminOriginal = async () => ({ evidence: { incident_id: 'original incident', payment: ${JSON.stringify(payment)} } });
    export const browserAdminActionHistory = () => ({});
    export function createAdminFlow(_config, _original, context) {
      const wait = action => {
        probe.calls.push(action);
        return new Promise((resolve, reject) => { probe.complete = error => error ? reject(Error(error)) : resolve({ state: action.startsWith('refund:') ? 'unknown' : 'pending', verification: 'unverified', reason: 'outcome_unresolved' }); });
      };
      return { context, dispose() {}, initial: action => wait('initial:' + action), refund: (lane, action) => wait('refund:' + lane + ':' + action) };
    }
    // Receipt context's account validators are not exercised by these fake UI ports.
    export const StrKey = {};
  `);
  writeFileSync(loader, `const ts = require(${JSON.stringify(require.resolve('typescript'))}); module.exports = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;`);
  const entry = join(scratch, 'entry.tsx');
  writeFileSync(entry, `
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import D1AdminPanel from ${JSON.stringify(resolve(root, 'src/components/D1AdminPanel.tsx'))};
    import AdminPanel from ${JSON.stringify(resolve(root, 'src/components/AdminPanel.tsx'))};
    import { openRefundJournal } from ${JSON.stringify(resolve(root, 'src/lib/d1/refund-journal.ts'))};
    import { probe } from './ports';
    window.adminBrowser = Object.assign(probe, { openRefundJournal });
    function Curation() {
      const [status, setStatus] = useState('community');
      return <AdminPanel session={{ publicKey: 'synthetic-admin', role: 'admin' }} supabaseUrl="https://invalid.example" incidents={[{ id: 'incident-1', category: 'sos', donationStatus: status, votes: 2, claimable: false }]} onChanged={() => { probe.changed++; setStatus(probe.curation.at(-1).status); }} onClose={() => {}} />;
    }
    createRoot(document.getElementById('root')).render(location.search.includes('curation') ? <Curation /> : <D1AdminPanel admin="synthetic-admin" />);
  `);
  const { webpack } = require('next/dist/compiled/webpack/bundle5')() as {
    webpack(options: unknown, callback: (error: Error | null, stats?: { hasErrors(): boolean; toString(options: unknown): string }) => void): { close(callback: (error?: Error | null) => void): void };
  };
  await new Promise<void>((yes, no) => {
    const compiler = webpack({
      mode: 'development', target: 'web', context: root, entry, devtool: false, cache: false,
      output: { path: scratch, filename: 'browser.js' },
      resolve: {
        extensions: ['.tsx', '.ts', '.js'],
        // The fallback is essential: react-dom's scheduler lives in its normal pnpm ancestry.
        modules: [resolve(root, 'node_modules'), 'node_modules'],
        alias: Object.fromEntries(['@/lib/i18n', '@/lib/admin', '@/lib/claim', '@/lib/vaquitas', '@stellar/freighter-api', '@stellar/stellar-sdk', 'lucide-react', '../lib/d1/admin-flow', '../lib/d1/public-config'].map(name => [name + '$', ports])),
      },
      module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: loader }] },
      optimization: { minimize: false },
    }, (error, stats) => compiler.close(closeError => {
      if (error || closeError || !stats || stats.hasErrors()) no(error ?? closeError ?? Error(stats?.toString({ all: false, errors: true }) ?? 'missing bundle stats'));
      else yes();
    }));
  });
  bundle = readFileSync(join(scratch, 'browser.js'), 'utf8');
});
base.afterAll(() => { if (scratch) rmSync(scratch, { recursive: true, force: true }); });

const test = base.extend<{ adminPages: { page: Page; other(): Promise<Page> } }>({
  adminPages: async ({}, use) => {
    const browser = await chromium.launch({ executablePath: process.env.D1_TEST_BROWSER || chromium.executablePath(), headless: true, chromiumSandbox: true });
    try {
      const context = await browser.newContext({ serviceWorkers: 'block' });
      const external: string[] = [], errors: string[] = [];
      await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin === origin && url.pathname === '/') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><html lang="en"><meta charset="utf-8"><title>Offline Admin regression</title><div id="root"></div><script src="/browser.js"></script></html>' });
        if (url.origin === origin && url.pathname === '/browser.js') return route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: bundle });
        external.push(url.href); return route.abort();
      });
      const other = async () => { const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message)); await page.goto(origin); await page.waitForFunction(() => !!window.adminBrowser); return page; };
      await use({ page: await other(), other });
      expect(external).toEqual([]); expect(errors).toEqual([]);
    } finally { await browser.close(); }
  },
});

test('production D1 panel reviews original and amount, then waits for explicit actions and announces unknown', async ({ adminPages: { page } }) => {
  await expect(page.getByRole('heading', { name: 'D1 · explicit Testnet administration' })).toBeVisible();
  await expect(page.getByText('Wallet connection / legacy session does not establish', { exact: false })).toBeVisible();
  await expect(page.getByLabel('Original signed payment snapshot (JSON, required)')).toBeVisible();
  expect(await page.evaluate(() => window.adminBrowser.calls)).toEqual([]);
  await page.getByRole('button', { name: 'Read public D1 configuration' }).click();
  await expect(page.getByRole('status')).toContainText('configuration loaded');
  await page.getByLabel('Original signed payment snapshot (JSON, required)').fill('{"synthetic":"UI-only, not authenticated evidence"}');
  await page.getByLabel('Retained issuance request UUID', { exact: false }).fill(request_id);
  await page.getByLabel('Explicit beneficiary public key', { exact: false }).fill(beneficiary);
  await page.getByLabel('Allocation amount', { exact: false }).fill('1.0000000');
  await page.getByRole('button', { name: 'Observe original and retain review' }).click();
  const review = page.locator('pre').filter({ hasText: 'original incident' });
  for (const fact of [request_id, beneficiary, payment.donor, pool, payment.transaction_hash, '10.0000000', '1.0000000']) await expect(review).toContainText(fact);
  await expect(page.getByText('Original confirmation + 300 seconds: 2023-11-14T22:18:20Z', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.adminBrowser.calls)).toEqual([]);
  const initial = page.getByRole('form', { name: 'Explicit initial action' });
  await initial.getByRole('button').click();
  await expect(initial.getByRole('button')).toBeDisabled();
  await initial.evaluate(form => (form as HTMLFormElement).requestSubmit());
  expect(await page.evaluate(() => window.adminBrowser.calls)).toEqual(['initial:prepare']);
  await page.evaluate(() => window.adminBrowser.complete());
  await expect(initial.getByRole('button')).toBeEnabled();
  expect(await page.evaluate(() => window.adminBrowser.calls)).toEqual(['initial:prepare']); // Never automatic issue.
  const refund = page.getByRole('form', { name: 'Manual refund / verified remainder' });
  await expect(refund.getByLabel('Known original refund lane', { exact: false })).toHaveValue('');
  await refund.getByLabel('Known original refund lane', { exact: false }).selectOption('verified_remainder_v2');
  await refund.getByRole('radio', { name: 'Execute once for this original' }).check();
  await refund.getByRole('button').click();
  await expect(refund.getByRole('button')).toBeDisabled();
  await page.evaluate(() => window.adminBrowser.complete());
  await expect(page.getByRole('status')).toContainText('"state": "unknown"');
  await expect(page.getByRole('status')).toContainText('HTTP acceptance alone is not financial success');
  expect(await page.evaluate(() => window.adminBrowser.calls)).toEqual(['initial:prepare', 'refund:verified_remainder_v2:execute']);
  await expect(refund.getByLabel('Known original refund lane', { exact: false })).toHaveValue('verified_remainder_v2');
  await expect(page.getByRole('button', { name: /reset|resend/i })).toHaveCount(0);
});

test('production Admin curation preserves status/change callbacks with zero legacy financial calls', async ({ adminPages: { page } }) => {
  await page.goto(origin + '/?curation');
  await expect(page.getByRole('heading', { name: 'D1 · explicit Testnet administration' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'release_aid' })).toHaveCount(0);
  await page.getByRole('button', { name: 'promote_vaquita' }).click();
  await expect(page.getByText('status_short_vaquita', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'demote_signal' }).click();
  await expect(page.getByRole('button', { name: 'promote_community' })).toBeVisible();
  expect(await page.evaluate(() => ({ curation: window.adminBrowser.curation, changed: window.adminBrowser.changed, legacy: window.adminBrowser.legacy, financial: window.adminBrowser.calls }))).toEqual({ curation: [{ incident: 'incident-1', status: 'vaquita' }, { incident: 'incident-1', status: 'signal' }], changed: 2, legacy: 0, financial: [] });
});

test('real refund IndexedDB retains one cross-lane winner across independent tabs and reload', async ({ adminPages: { page: a, other } }) => {
  const b = await other();
  const identity: RefundOriginalIdentity = { network: 'TESTNET', namespace, pool, request_id };
  // Opaque journal bytes only, not a signature, validated attempt or send capability.
  const full: RefundExecutionAttempt = { version: 1, action: 'refund', signedBody: ' exact v1 journal bytes\n' };
  const remainder: RefundExecutionAttempt = { version: 2, action: 'refund_remainder', signedBody: ' exact v2 journal bytes\n' };
  for (const page of [a, b]) await page.evaluate(async () => { window.adminBrowser.journal = await window.adminBrowser.openRefundJournal(indexedDB); });
  const claim = (page: Page, attempt: RefundExecutionAttempt) => page.evaluate(({ identity, attempt }) => window.adminBrowser.journal!.claimExecution(identity, attempt), { identity, attempt });
  const results = await Promise.all([claim(a, full), claim(b, remainder)]);
  expect(results.map(result => result.claimed).sort()).toEqual([false, true]);
  const winner = results.find(result => result.claimed)!.hold;
  expect(winner).toEqual({ identity, attempt: winner.attempt.version === 1 ? full : remainder });
  expect(results.every(result => JSON.stringify(result.hold) === JSON.stringify(winner))).toBe(true);
  await a.reload();
  await a.waitForFunction(() => !!window.adminBrowser);
  await a.evaluate(async () => { window.adminBrowser.journal = await window.adminBrowser.openRefundJournal(indexedDB); });
  for (const page of [a, b]) {
    expect(await page.evaluate(identity => window.adminBrowser.journal!.read(identity), identity)).toEqual(winner);
    for (const attempt of [full, remainder]) expect(await claim(page, attempt)).toEqual({ claimed: false, hold: winner });
    expect(await page.evaluate(() => ({ calls: window.adminBrowser.calls, legacy: window.adminBrowser.legacy }))).toEqual({ calls: [], legacy: 0 });
    await page.evaluate(() => window.adminBrowser.journal!.close());
  }
});
