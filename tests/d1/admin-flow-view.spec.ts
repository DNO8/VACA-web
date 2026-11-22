import { test, expect } from '@playwright/test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import ts from 'typescript';

function load(fileName: string, mocks: Record<string, unknown>) {
  const file = resolve(__dirname, '../../src/components/' + fileName);
  const compiled = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } });
  const exports: Record<string, any> = {};
  const require = createRequire(file);
  new Function('require', 'exports', compiled.outputText)((name: string) => Object.hasOwn(mocks, name) ? mocks[name] : require(name), exports);
  return exports;
}
test('Admin curation preserves promote/demote and never calls legacy release', async () => {
  let updates = 0, changed = 0, claims = 0;
  const props = { session: { publicKey: 'public-admin', role: 'admin' }, supabaseUrl: 'https://invalid.example', incidents: [{ id: 'incident-1', category: 'sos', donationStatus: 'community', votes: 2, claimable: false }], onChanged() { changed++; }, onClose() {} };
  const realReact = createRequire(__filename)('react');
  const exports = load('AdminPanel.tsx', {
    react: { ...realReact, useState: (value: unknown) => [value, () => {}] },
    '@/lib/i18n': { useLang: () => ({ t: (key: string) => key }) },
    '@/lib/vaquitas': { CATEGORY_COLOR: { sos: '#fff' } },
    '@/lib/admin': { setDonationStatus: async (...args: unknown[]) => { updates++; expect(args.slice(2)).toEqual(['incident-1', updates === 1 ? 'vaquita' : 'signal']); return { stellarPubkey: 'beneficiary' }; }, recordClaim: async () => { claims++; } },
    '@/lib/claim': { createVaquitaClaim: async () => { claims++; return {}; } },
    './D1AdminPanel': () => createElement('section', { 'data-d1-admin': true }),
  });
  const tree = exports.default(props);
  const buttons: any[] = [];
  function walk(node: any) { if (!node || typeof node !== 'object') return; if (node.type === 'button') buttons.push(node); const children = node.props?.children; (Array.isArray(children) ? children.flat(Infinity) : [children]).forEach(walk); }
  walk(tree);
  expect(buttons.some(b => b.props.children === 'release_aid')).toBe(false);
  await buttons.find(b => b.props.children === 'promote_vaquita').props.onClick();
  await buttons.find(b => b.props.children === 'demote_signal').props.onClick();
  expect(updates).toBe(2); expect(changed).toBe(2); expect(claims).toBe(0);
  const html = renderToStaticMarkup(tree); expect(html).toContain('data-d1-admin'); expect(html).toContain('incident');
});
test('Admin financial forms have named explicit controls, visible labels and bilingual live results', () => {
  for (const lang of ['es', 'en']) {
    const realReact = createRequire(__filename)('react');
    const exports = load('D1AdminPanel.tsx', {
      '@/lib/i18n': { useLang: () => ({ lang }) },
      './D1ProfileSelector': load('D1ProfileSelector.tsx', { '../lib/i18n': { useLang: () => ({ t: (key: string) => key }) } }).default,
      '@stellar/freighter-api': { signMessage: async () => { throw new Error('forbidden'); } },
      '../lib/d1/admin-flow': {}, '../lib/d1/public-config': {}, '../lib/d1/refund-journal': {},
    });
    const html = renderToStaticMarkup(createElement(exports.default, { admin: 'explicit-admin' }));
    expect(html).toContain('<form'); expect(html).toContain('aria-labelledby='); expect(html).toContain('<label');
    expect(html).toContain('name="snapshot"'); expect(html).toContain('name="request_id"'); expect(html).toContain('name="beneficiary"'); expect(html).toContain('name="amount"');
    expect(html).toContain('role="status"'); expect(html).toContain('role="alert"');
    expect(html).toContain('type="button"'); expect(html).not.toContain('donor-payment-status');
    expect(html).toContain('<fieldset'); expect(html).toContain('<legend');
    expect(html).toContain('type="radio"'); expect(html).toContain('value="A"'); expect(html).toContain('value="B"');
    expect(html).toContain('d1_profile_a'); expect(html).toContain('d1_profile_b');
    expect(html).toContain(lang === 'es' ? 'no acredita' : 'does not establish');
    expect(realReact).toBeTruthy();
  }
});
