import { test as base, expect, chromium, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

declare global { interface Window { refundModule: any; refundJournal: any } }
const source = ts.transpileModule(readFileSync('src/lib/d1/refund-journal.ts', 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const script = `(() => { const exports = {}; ${source}\nwindow.refundModule = exports; })();`;
const identity = { network: 'TESTNET', namespace: 'abcdef01-2345-6789-abcd-0123456789ab',
  pool: 'GBJU5J6F2L6XXPTYADYS6NIPAP6RAJBN7SAXJDAOWIFSPEWFSCASEIXN', request_id: 'abcdef02-2345-6789-abcd-0123456789ab' };
const attempt = { version: 1, action: 'refund', signedBody: ' {"opaque":"é","admin":"first"}\n' };
const rival = { version: 2, action: 'refund_remainder', signedBody: '{"admin":"second","timestamp":999}' };
const held = { identity, attempt };
async function load(page: Page) {
  await page.addScriptTag({ content: script });
  await page.evaluate(async () => { window.refundJournal = await window.refundModule.openRefundJournal(indexedDB); });
}
async function call(page: Page, method: string, ...args: unknown[]) {
  return page.evaluate(async ({ method, args }) => {
    try { return { value: await window.refundJournal[method](...args) }; }
    catch (e) { return { error: (e as Error).message }; }
  }, { method, args });
}
const test = base.extend<{ pages: [Page, Page] }>({
  pages: async ({}, use) => {
    const browser = await chromium.launch({ executablePath: process.env.D1_TEST_BROWSER || chromium.executablePath(),
      headless: true, chromiumSandbox: true });
    try {
      const context = await browser.newContext({ serviceWorkers: 'block' });
      await context.route('**/*', route => route.request().url() === 'http://d1-test.local/'
        ? route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Refund journal</title>' }) : route.abort());
      const pages: [Page, Page] = [await context.newPage(), await context.newPage()];
      for (const p of pages) { await p.goto('http://d1-test.local/'); await load(p); }
      await use(pages);
    } finally { await browser.close(); }
  },
});

test('one cross-lane claim wins between independent connections and retains its exact attempt', async ({ pages: [a, b] }) => {
  expect(await call(a, 'read', identity)).toEqual({ value: null });
  const results = await Promise.all([call(a, 'claimExecution', identity, attempt), call(b, 'claimExecution', identity, rival)]);
  const values = results.map(r => r.value as { claimed: boolean; hold: typeof held });
  expect(values.filter(v => v.claimed)).toHaveLength(1);
  const winner = values.find(v => v.claimed)!.hold;
  expect([held, { identity, attempt: rival }]).toContainEqual(winner);
  for (const value of values) expect(value.hold).toEqual(winner);
  for (const page of [a, b]) expect(await call(page, 'read', identity)).toEqual({ value: winner });
});
test('same attempt, another admin or lane, reload and reopen never authorize another execution', async ({ pages: [a, b] }) => {
  expect(await call(a, 'claimExecution', identity, attempt)).toEqual({ value: { claimed: true, hold: held } });
  await call(a, 'close'); await load(a); await b.reload(); await load(b);
  for (const page of [a, b]) for (const value of [attempt, rival, { ...attempt, signedBody: 'new proof' }]) {
    expect(await call(page, 'claimExecution', identity, value)).toEqual({ value: { claimed: false, hold: held } });
    expect(await call(page, 'read', identity)).toEqual({ value: held });
  }
  expect(await a.evaluate(() => Object.keys(window.refundJournal).sort())).toEqual(['claimExecution', 'close', 'read']);
});
test('each original tuple component isolates unrelated holds without accepting another network', async ({ pages: [a] }) => {
  await call(a, 'claimExecution', identity, attempt);
  for (const other of [
    { ...identity, namespace: 'abcdef03-2345-6789-abcd-0123456789ab' },
    { ...identity, request_id: 'abcdef03-2345-6789-abcd-0123456789ab' },
    { ...identity, pool: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF' },
  ]) {
    expect(await call(a, 'read', other)).toEqual({ value: null });
    expect(await call(a, 'claimExecution', other, rival)).toEqual({ value: { claimed: true, hold: { identity: other, attempt: rival } } });
  }
  expect(await call(a, 'claimExecution', { ...identity, network: 'PUBLIC' }, attempt)).toEqual({ error: 'd1_refund_journal_invalid_argument' });
  expect(await call(a, 'read', identity)).toEqual({ value: held });
});
test('returns detached frozen snapshots without mutating inputs or consulting a clock', async ({ pages: [a] }) => {
  const result = await a.evaluate(async ({ identity, attempt }) => {
    const before = JSON.stringify({ identity, attempt }); const now = Date.now;
    let value;
    try { Date.now = () => { throw new Error('clock used'); }; value = await window.refundJournal.claimExecution(identity, attempt); }
    finally { Date.now = now; }
    const unchanged = before === JSON.stringify({ identity, attempt });
    const second = await window.refundJournal.read(identity);
    return { value, second, unchanged, frozen: [value, value.hold, value.hold.identity, value.hold.attempt, second, second.identity, second.attempt].every(Object.isFrozen),
      detached: value.hold !== second && value.hold.identity !== identity && value.hold.attempt !== attempt,
      mutableInput: !Object.isFrozen(identity) && !Object.isFrozen(attempt) };
  }, { identity, attempt });
  expect(result).toEqual({ value: { claimed: true, hold: held }, second: held, unchanged: true, frozen: true, detached: true, mutableInput: true });
});
test('invalid data and oversized UTF8 bodies reject without acquiring or replacing a hold', async ({ pages: [a] }) => {
  const checks = await a.evaluate(async ({ identity, attempt }) => {
    let getters = 0; const results: string[] = [];
    const accessor = Object.defineProperty({ ...identity }, 'pool', { get() { getters++; return identity.pool; } });
    const badIdentities = [null, [], { ...identity, extra: true }, { ...identity, request_id: identity.request_id.toUpperCase() }, accessor,
      Object.assign({ ...identity }, { [Symbol('extra')]: 1 }), Object.defineProperty({ ...identity }, 'pool', { enumerable: false })];
    const badAttempts = [{ ...attempt, action: 'refund_status' }, { ...attempt, version: 2 }, { ...attempt, signedBody: '' },
      { ...attempt, signedBody: 'é'.repeat(4097) }, { ...attempt, extra: true }];
    for (const [scope, value] of [...badIdentities.map(i => [i, attempt]), ...badAttempts.map(v => [identity, v])]) {
      try { await window.refundJournal.claimExecution(scope, value); results.push('accepted'); }
      catch (e) { results.push((e as Error).message); }
    }
    return { getters, results, retained: await window.refundJournal.read(identity) };
  }, { identity, attempt });
  expect(checks).toEqual({ getters: 0, results: Array(12).fill('d1_refund_journal_invalid_argument'), retained: null });
  const exact = { ...attempt, signedBody: 'é'.repeat(4096) };
  expect(await call(a, 'claimExecution', identity, exact)).toEqual({ value: { claimed: true, hold: { identity, attempt: exact } } });
  expect(await call(a, 'claimExecution', identity, { ...exact, signedBody: exact.signedBody + 'x' })).toEqual({ error: 'd1_refund_journal_invalid_argument' });
  expect(await call(a, 'read', identity)).toEqual({ value: { identity, attempt: exact } });
});
test('transaction abort after successful insert publishes no permission and leaves no hold', async ({ pages: [a] }) => {
  const error = await a.evaluate(async ({ identity, attempt }) => {
    const original = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function(...args: Parameters<IDBObjectStore['add']>) {
      const request = original.apply(this, args); const tx = this.transaction;
      request.addEventListener('success', () => tx.abort()); return request;
    };
    try { await window.refundJournal.claimExecution(identity, attempt); return 'accepted'; }
    catch (e) { return (e as Error).message; }
    finally { IDBObjectStore.prototype.add = original; }
  }, { identity, attempt });
  expect(error).toBe('d1_refund_journal_storage_error');
  expect(await call(a, 'read', identity)).toEqual({ value: null });
  expect(await call(a, 'claimExecution', identity, attempt)).toEqual({ value: { claimed: true, hold: held } });
});
test('closed handles and unavailable factory fail closed without altering retained data', async ({ pages: [a, b] }) => {
  await call(a, 'claimExecution', identity, attempt); await call(a, 'close'); await call(a, 'close');
  expect(await call(a, 'read', identity)).toEqual({ error: 'd1_refund_journal_closed' });
  expect(await call(a, 'claimExecution', identity, rival)).toEqual({ error: 'd1_refund_journal_closed' });
  expect(await call(b, 'read', identity)).toEqual({ value: held });
  const error = await a.evaluate(async () => {
    try { await window.refundModule.openRefundJournal(undefined); return 'accepted'; }
    catch (e) { return (e as Error).message; }
  });
  expect(error).toBe('d1_refund_journal_unavailable');
});
