import { test, expect } from '@playwright/test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import ts from 'typescript';
import { Keypair } from '@stellar/stellar-sdk';
import { buildDonationTransaction } from '../../src/lib/d1/donation-transaction';
import type { D1DonationView as View } from '../../src/components/D1DonationPanel';
import type { ComponentProps } from 'react';

function load(relative: string, stubs: Record<string, unknown> = {}) {
  const file = resolve(__dirname, relative);
  const compiled = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
  } });
  const exports: Record<string, any> = {};
  const native = createRequire(file);
  new Function('require', 'exports', compiled.outputText)((name: string) => Object.hasOwn(stubs, name) ? stubs[name] : native(name), exports);
  return exports;
}
const t = (key: string, vars?: Record<string, string | number>) => key + (vars ? ':' + Object.values(vars).join('|') : '');
const i18n = { useLang: () => ({ lang: 'en', t }) };
const config = { network: 'TESTNET' as const, pool_public_key: Keypair.fromRawEd25519Seed(Buffer.alloc(32, 73)).publicKey(),
  namespace: '11111111-2222-3333-4444-555555555555', donation_ttl_seconds: 300 as const };
const snapshot = buildDonationTransaction({ config, request_id: config.namespace,
  donor: Keypair.fromRawEd25519Seed(Buffer.alloc(32, 74)).publicKey(), incident_id: 'incident:full', asset: { type: 'native' }, amount: '1.0000001' },
{ sequence: '42', fee: '100', timebounds: { minTime: 0, maxTime: 1800000000 } });
function view() { return load('../../src/components/D1DonationPanel.tsx', { '../lib/i18n': i18n }).D1DonationView as typeof View; }
function props(): ComponentProps<typeof View> {
  return { config, recovery: null, amount: '1.0000001', busy: false, status: 'ready', error: '', t,
    onAmountChange() {}, onPrepare() {}, onSign() {}, onSend() {}, onCheck() {}, onRecover() {} };
}

test('donation form has visible amount label, named semantic form and separate exact-amount review actions', () => {
  const component = view();
  const html = renderToStaticMarkup(createElement(component, props()));
  expect(html).toContain('<form'); expect(html).toContain('aria-labelledby='); expect(html).toContain('method="post"');
  expect(html).toContain('<label'); expect(html).toContain('name="amount"'); expect(html).toContain('inputMode="decimal"');
  expect(html).toContain('d1_prepare'); expect(html).toContain('d1_repeat_limit'); expect(html).toContain('role="status"');
  expect(html).not.toContain('type="submit" disabled');
  const retained = { session: { scope: 'test', requestId: config.namespace, state: 'intent' as const, snapshot }, evidence: null, deadline: null, repeatBlocked: true as const };
  const review = renderToStaticMarkup(createElement(component, { ...props(), recovery: retained }));
  expect(review).toContain('1.0000001 XLM'); expect(review).toContain(config.pool_public_key);
  expect(review).toContain(snapshot.transactionHash); expect(review).toContain('incident:full');
  expect(review).toContain('d1_sign:1.0000001'); expect(review).not.toContain('type="submit"');
  expect(review).toContain('type="button"');
});

test('claimed and observed states have no resend/prepare and distinguish delivery from settlement', () => {
  const component = view();
  for (const status of ['submitted_unverified', 'observed', 'unresolved'] as const) {
    const recovery = { session: { scope: 'test', requestId: config.namespace, state: 'submission_claimed' as const,
      snapshot: { ...snapshot, signedTxXdr: 'render-only' } }, evidence: null, deadline: null, repeatBlocked: true as const };
    const html = renderToStaticMarkup(createElement(component, { ...props(), recovery, status, busy: true, error: 'd1_account_unavailable' }));
    expect(html).toContain('d1_' + status); expect(html).toContain('d1_delivery_unknown'); expect(html).toContain('d1_settlement_unknown');
    expect(html).toContain('d1_repeat_limit'); expect(html).toContain('role="alert"'); expect(html).toContain('disabled');
    expect(html).not.toContain('d1_send:'); expect(html).not.toContain('d1_sign:'); expect(html).not.toContain('type="submit"');
  }
});

test('real incident aside mounts D1 in the donation seam and preserves vote/cooldown/connection controls', () => {
  const icons = new Proxy({}, { get: () => () => null });
  let legacyCalls = 0;
  const aside = load('../../src/components/VaquitaAside.tsx', {
    'lucide-react': icons, '@stellar/freighter-api': {}, '@/lib/i18n': i18n,
    '@/lib/vaquitas': { CATEGORY_COLOR: { sos: '#fff' }, VAQUITA_GOLD: '#fc0' },
    '@/lib/donate': { getBalance() { legacyCalls++; }, donateToPool() { legacyCalls++; } },
    '@/lib/vote': { castVote() { throw Error('not during render'); } },
    './D1Readiness': { __esModule: true, default: () => null },
    './D1DonationPanel': { __esModule: true, default: (p: { incidentId: string }) => createElement('section', { 'data-d1-incident': p.incidentId }, 'D1 consumer') },
  }).default;
  const incident = { id: 'incident:full', category: 'sos', donationStatus: 'community', votes: 3, createdAt: null };
  const html = renderToStaticMarkup(createElement(aside, { incident, regionName: 'Region', supabaseUrl: 'https://example.invalid', voteThreshold: 5, onVote() {}, onClose() {} }));
  expect(html).toContain('data-d1-incident="incident:full"'); expect(html).toContain('connect_wallet');
  expect(html).toContain('vote_cta'); expect(html).toContain('3/5'); expect(html).toContain('vote_note');
  expect(html).not.toContain('donate_cta'); expect(legacyCalls).toBe(0);
  const signal = renderToStaticMarkup(createElement(aside, { incident: { ...incident, donationStatus: 'signal' }, regionName: null,
    supabaseUrl: 'https://example.invalid', voteThreshold: 5, onVote() {}, onClose() {} }));
  expect(signal).toContain('donate_disabled'); expect(signal).not.toContain('data-d1-incident');
});
