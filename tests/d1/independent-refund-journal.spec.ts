import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import type * as Module from '../../src/lib/d1/refund-journal';
test.use({ launchOptions: { executablePath: process.env.D1_TEST_BROWSER, chromiumSandbox: true }, serviceWorkers: 'block' });
declare global { interface Window { J: typeof Module } }
const script = ts.transpileModule(readFileSync('src/lib/d1/refund-journal.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2017 } }).outputText;
const id = { network: 'TESTNET' as const, namespace: '11111111-1111-1111-1111-111111111111', pool: 'G' + 'A'.repeat(55), request_id: '22222222-2222-2222-2222-222222222222' };
const first = { version: 1 as const, action: 'refund' as const, signedBody: '  {"admin":"one","proof":"é\u0000"}\n' };
async function load(page: Page) {
  await page.route('**/*', route => route.request().url() === 'http://refund.invalid/' ? route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }) : route.abort());
  await page.goto('http://refund.invalid/');
  await page.addScriptTag({ content: '{ const exports = {}; ' + script + '; window.J = exports; }' });
}
test('S17: real cross-tab race, immutable winner and reopening never reclaims', async ({ context, page }) => {
  const pages = [page, await context.newPage(), await context.newPage(), await context.newPage()];
  await Promise.all(pages.map(load));
  const results = await Promise.all(pages.map((p, n) => p.evaluate(async ({ id, n }) => {
    const j = await window.J.openRefundJournal(indexedDB);
    const a: Module.RefundExecutionAttempt = n % 2 ? { version: 2, action: 'refund_remainder', signedBody: 'new admin/proof ' + n } : { version: 1, action: 'refund', signedBody: 'original proof ' + n };
    const r = await j.claimExecution(id, a); j.close(); return r;
  }, { id, n })));
  expect(results.filter(r => r.claimed)).toHaveLength(1);
  const winner = results.find(r => r.claimed)!.hold;
  for (const r of results) expect(r.hold).toEqual(winner);
  await page.reload(); await load(page);
  const replay = await page.evaluate(async ({ id, first }) => {
    const j = await window.J.openRefundJournal(indexedDB);
    const r = await j.claimExecution(id, first);
    const frozen = [r, r.hold, r.hold.identity, r.hold.attempt].every(Object.isFrozen);
    const snapshot = JSON.stringify(r.hold);
    try { (r.hold.attempt as { signedBody: string }).signedBody = 'changed'; } catch {}
    const reread = await j.read(id); j.close();
    return { r, frozen, snapshot, reread };
  }, { id, first });
  expect(replay.r).toEqual({ claimed: false, hold: winner }); expect(replay.frozen).toBe(true);
  expect(replay.reread).toEqual(winner); expect(replay.snapshot).toBe(JSON.stringify(winner));
});
test('S17: opaque bytes, UTF8 limits, rejected inputs and independent identity dimensions', async ({ page }) => {
  await load(page);
  const result = await page.evaluate(async ({ id, first }) => {
    const j = await window.J.openRefundJournal(indexedDB); const original = JSON.stringify({ id, first });
    const r = await j.claimExecution(id, first); const before = JSON.stringify(await j.read(id));
    const errors: string[] = []; const unchanged: boolean[] = [];
    const attempts: unknown[] = [{ ...first, signedBody: '' }, { ...first, signedBody: 'é'.repeat(4096) + 'a' }, { ...first, action: 'refund_remainder' }, { ...first, version: 2 }, { ...first, extra: true }];
    let getterCalls = 0; attempts.push({ version: 1, action: 'refund', get signedBody() { getterCalls++; return 'x'; } });
    for (const a of attempts) {
      try { await j.claimExecution(id, a as Module.RefundExecutionAttempt); errors.push('accepted'); } catch (e) { errors.push((e as Error).message); }
      unchanged.push(JSON.stringify(await j.read(id)) === before);
    }
    const identities = [{ ...id, network: 'PUBLIC' }, { ...id, namespace: '' }, { ...id, request_id: 'BAD' }, { ...id, pool: 'G' }, { ...id, admin: 'other' }];
    for (const i of identities) {
      try { await j.claimExecution(i as Module.RefundOriginalIdentity, first); errors.push('accepted'); } catch (e) { errors.push((e as Error).message); }
      unchanged.push(JSON.stringify(await j.read(id)) === before);
    }
    const separated = [];
    for (const i of [{ ...id, namespace: '33333333-3333-3333-3333-333333333333' }, { ...id, request_id: '44444444-4444-4444-4444-444444444444' }, { ...id, pool: 'G' + 'B'.repeat(55) }]) {
      separated.push(await j.read(i), await j.claimExecution(i, { ...first, signedBody: 'é'.repeat(4096) }));
    }
    j.close(); let closed = ''; try { await j.read(id); } catch (e) { closed = (e as Error).message; }
    return { r, errors, unchanged, getterCalls, inputsUntouched: JSON.stringify({ id, first }) === original, separated, closed };
  }, { id, first });
  expect(result.r).toEqual({ claimed: true, hold: { identity: id, attempt: first } });
  expect(result.errors).toEqual(Array(11).fill('d1_refund_journal_invalid_argument'));
  expect(result.unchanged.every(Boolean)).toBe(true); expect(result.getterCalls).toBe(0); expect(result.inputsUntouched).toBe(true);
  for (let n = 0; n < 6; n += 2) { expect(result.separated[n]).toBeNull(); expect(result.separated[n + 1]).toMatchObject({ claimed: true, hold: { attempt: { signedBody: 'é'.repeat(4096) } } }); }
  expect(result.closed).toBe('d1_refund_journal_closed');
});
test('S17: actual native insert abort cannot grant permission or persist hold', async ({ page }) => {
  await load(page);
  const result = await page.evaluate(async ({ id, first }) => {
    const j = await window.J.openRefundJournal(indexedDB); const add = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function (...args: Parameters<typeof add>) {
      const r = add.apply(this, args); r.addEventListener('success', () => this.transaction.abort()); return r;
    };
    let error = ''; try { await j.claimExecution(id, first); } catch (e) { error = (e as Error).message; }
    finally { IDBObjectStore.prototype.add = add; }
    const absent = await j.read(id); const r = await j.claimExecution(id, first); j.close(); return { error, absent, r };
  }, { id, first });
  expect(result.error).toBe('d1_refund_journal_storage_error'); expect(result.absent).toBeNull(); expect(result.r.claimed).toBe(true);
});
test('S17: malformed schema and newer database fail closed through public open', async ({ browser }) => {
  for (const kind of ['missing', 'extra', 'wrong-key', 'index', 'increment', 'newer']) {
    const c = await browser.newContext({ serviceWorkers: 'block' }); const p = await c.newPage(); await load(p);
    const error = await p.evaluate(async kind => {
      await new Promise<void>((resolve, reject) => {
        const r = indexedDB.open('vaca-d1-refund-holds', kind === 'newer' ? 2 : 1);
        r.onupgradeneeded = () => {
          if (kind === 'missing') return;
          const store = r.result.createObjectStore('holds', { keyPath: kind === 'wrong-key' ? 'bad' : 'key', autoIncrement: kind === 'increment' });
          if (kind === 'extra') r.result.createObjectStore('other');
          if (kind === 'index') store.createIndex('extra', 'identity');
        };
        r.onerror = () => reject(r.error); r.onsuccess = () => { r.result.close(); resolve(); };
      });
      try { const j = await window.J.openRefundJournal(indexedDB); j.close(); return 'accepted'; } catch (e) { return (e as Error).message; }
    }, kind);
    expect(error, kind).toBe('d1_refund_journal_open_failed'); await c.close();
  }
});
test('S17: corrupted retained identity or attempt never grants replacement', async ({ browser }) => {
  for (const kind of ['identity', 'attempt', 'extra']) {
    const c = await browser.newContext({ serviceWorkers: 'block' }); const p = await c.newPage(); await load(p);
    const result = await p.evaluate(async ({ kind, id, first }) => {
      const key = JSON.stringify([id.network, id.namespace, id.pool, id.request_id]);
      const record = { key, identity: kind === 'identity' ? { ...id, request_id: '33333333-3333-3333-3333-333333333333' } : id, attempt: kind === 'attempt' ? { ...first, signedBody: '' } : first, ...(kind === 'extra' ? { unexpected: 1 } : {}) };
      await new Promise<void>((resolve, reject) => {
        const r = indexedDB.open('vaca-d1-refund-holds', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('holds', { keyPath: 'key' });
        r.onerror = () => reject(r.error); r.onsuccess = () => {
          const tx = r.result.transaction('holds', 'readwrite'); tx.objectStore('holds').add(record);
          tx.oncomplete = () => { r.result.close(); resolve(); }; tx.onabort = () => reject(tx.error);
        };
      });
      const j = await window.J.openRefundJournal(indexedDB); const errors: string[] = [];
      for (const op of [() => j.read(id), () => j.claimExecution(id, first), () => j.claimExecution(id, { version: 2, action: 'refund_remainder', signedBody: 'replacement' }), () => j.read(id)]) {
        try { await op(); errors.push('accepted'); } catch (e) { errors.push((e as Error).message); }
      }
      j.close(); return errors;
    }, { kind, id, first });
    expect(result).toEqual(Array(4).fill('d1_refund_journal_invalid_record')); await c.close();
  }
});
