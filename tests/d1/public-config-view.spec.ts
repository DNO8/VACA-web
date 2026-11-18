import { test, expect } from '@playwright/test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StrKey } from '@stellar/stellar-sdk';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import ts from 'typescript';
import type { ComponentProps } from 'react';
import type { D1ReadinessView as View } from '../../src/components/D1Readiness';

// Playwright's TSX transform emits component-test descriptors, not React elements.
// Compile this public component with the installed TypeScript React runtime for SSR.
const file = resolve(__dirname, '../../src/components/D1Readiness.tsx');
const compiled = ts.transpileModule(readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
});
const publicExports: { D1ReadinessView?: typeof View } = {};
new Function('require', 'exports', compiled.outputText)(createRequire(file), publicExports);
const D1ReadinessView = publicExports.D1ReadinessView!;

const config = { network: 'TESTNET' as const, pool_public_key: StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 2)), namespace: 'abcdef01-2345-6789-abcd-0123456789ab', donation_ttl_seconds: 300 as const };
test('technical states remain read-only and do not contradict the mounted D1 donation flow', () => {
  for (const state of [{ status: 'loading' as const }, { status: 'unavailable' as const }, { status: 'available' as const, config }]) {
    const html = renderToStaticMarkup(createElement(D1ReadinessView, { state, t: (key: Parameters<ComponentProps<typeof View>['t']>[0]) => key }));
    expect(html).toContain('role="status"');
    expect(html).toContain('d1_config_' + state.status);
    expect(html).toContain('d1_payment_notice');
    expect(html).not.toContain('d1_legacy_payment_notice');
    expect(html.includes(config.pool_public_key)).toBe(state.status === 'available');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('<a ');
  }
});
