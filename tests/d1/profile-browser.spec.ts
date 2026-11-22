import { test, expect, chromium } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { D1_B } from '../../src/lib/d1/profile';

let bundle = '';
const aPool = 'GCATS5YOVB6ROX2WUNKGNQ2MP3GMXDMKSG2O4N5CLX3A6W4PZGZZI55U';
const aConfig = { network: 'TESTNET', donation_ttl_seconds: 300, namespace: 'abcdef01-2345-6789-abcd-0123456789ab', pool_public_key: aPool };
const bConfig = { ...aConfig, namespace: D1_B.namespace, pool_public_key: D1_B.pool };
// Real reader, selector, readiness and ES/EN provider; only network and SDK address
// syntax are ports. Node suites separately exercise actual Stellar validation.
test.beforeAll(async () => {
  const root = process.cwd(), scratch = mkdtempSync(join(tmpdir(), 'vaca-profile-browser-'));
  try {
    const entry = join(scratch, 'entry.tsx'), sdk = join(scratch, 'sdk.js'), loader = join(scratch, 'loader.cjs');
    writeFileSync(sdk, `export const StrKey = { isValidEd25519PublicKey: key => ${JSON.stringify([aPool, D1_B.pool])}.includes(key) };`);
    writeFileSync(loader, `const ts = require(${JSON.stringify(require.resolve('typescript'))}); module.exports = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;`);
    writeFileSync(entry, `
      import React, { useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { LangProvider, useLang } from ${JSON.stringify(resolve(root, 'src/lib/i18n.tsx'))};
      import Selector from ${JSON.stringify(resolve(root, 'src/components/D1ProfileSelector.tsx'))};
      import Readiness from ${JSON.stringify(resolve(root, 'src/components/D1Readiness.tsx'))};
      const probe = window.profileProbe = { calls: [], release() {}, unmount() {} };
      window.fetch = async input => {
        probe.calls.push(String(input));
        if (input === '/api/d1/config') await new Promise(resolve => { probe.release = resolve; });
        return Response.json(input === '/api/d1/config' ? ${JSON.stringify(aConfig)} : ${JSON.stringify(bConfig)});
      };
      function View() {
        const [profile, select] = useState('A'), { setLang } = useLang();
        return <><button type="button" onClick={() => setLang('es')}>ES</button><button type="button" onClick={() => setLang('en')}>EN</button>
          <Selector profile={profile} disabled={false} onChange={select} /><Readiness key={profile} profile={profile} /></>;
      }
      const root = createRoot(document.getElementById('root')); probe.unmount = () => root.unmount();
      root.render(<LangProvider><View /></LangProvider>);
    `);
    const { webpack } = require('next/dist/compiled/webpack/bundle5')();
    await new Promise<void>((done, reject) => {
      const compiler = webpack({ mode: 'development', target: 'web', entry, devtool: false, cache: false,
        output: { path: scratch, filename: 'browser.js' },
        resolve: { extensions: ['.tsx', '.ts', '.js'], modules: [resolve(root, 'node_modules'), 'node_modules'], alias: { '@stellar/stellar-sdk$': sdk } },
        module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: loader }] },
      }, (error: Error | null, stats: { hasErrors(): boolean; toString(): string } | undefined) => compiler.close((closeError: Error | null) => {
        if (error || closeError || !stats || stats.hasErrors()) reject(error ?? closeError ?? Error(stats?.toString() ?? 'missing bundle'));
        else done();
      }));
    });
    bundle = readFileSync(join(scratch, 'browser.js'), 'utf8');
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test('real configuration reader discards late A after keyboard B selection, with native labels/focus in ES/EN', async () => {
  const browser = await chromium.launch({ executablePath: process.env.D1_TEST_BROWSER || chromium.executablePath(), headless: true, chromiumSandbox: true });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' }), blocked: string[] = [], errors: string[] = [];
    const origin = 'http://d1-profile.local/';
    await context.route('**/*', route => {
      if (route.request().url() === origin) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><html lang="en"><meta charset="utf-8"><title>Offline profile regression</title><div id="root"></div></html>' });
      blocked.push(route.request().url()); return route.abort();
    });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin); await page.addScriptTag({ content: bundle });
    await page.getByRole('button', { name: 'EN', exact: true }).click();
    const a = page.getByRole('radio', { name: 'A · original (default)', exact: true });
    const b = page.getByRole('radio', { name: 'B · video-auto (separate pool)', exact: true });
    await expect(a).toBeChecked(); await expect(page.getByRole('group', { name: 'D1 profile · Testnet' })).toBeVisible();
    await a.focus(); await page.keyboard.press('ArrowRight'); await expect(b).toBeFocused(); await expect(b).toBeChecked();
    expect(await b.evaluate(element => getComputedStyle(element).outlineStyle)).not.toBe('none');
    await expect(page.getByText(D1_B.pool, { exact: true })).toBeVisible();
    await page.evaluate(() => (window as ProbeWindow).profileProbe.release());
    await expect(page.getByRole('status')).toHaveText('D1 configuration available');
    await expect(page.getByText(aPool, { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'ES', exact: true }).click();
    await expect(page.getByRole('group', { name: 'Perfil D1 · Testnet' })).toBeVisible();
    await expect(page.getByRole('radio', { name: 'B · video-auto (pool separado)', exact: true })).toBeChecked();
    await expect(page.getByRole('status')).toHaveText('Configuración D1 disponible');
    expect(await page.evaluate(() => (window as ProbeWindow).profileProbe.calls)).toEqual(['/api/d1/config', '/api/d1/video-auto/config']);
    await page.evaluate(() => (window as ProbeWindow).profileProbe.unmount()); await expect(page.locator('#root')).toBeEmpty();
    expect(blocked).toEqual([]); expect(errors).toEqual([]);
  } finally { await browser.close(); }
});
type ProbeWindow = typeof window & { profileProbe: { calls: string[]; release(): void; unmount(): void } };
