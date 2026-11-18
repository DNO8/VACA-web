import { test as base, expect, chromium, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import type { DonationJournalV2 } from '../../src/lib/d1/donation-journal';
declare global { interface Window {
  independentModule: { openDonationJournal(f: IDBFactory, n: string): Promise<DonationJournalV2> };
  independentJournal: DonationJournalV2;
} }
const source = ts.transpileModule(readFileSync('src/lib/d1/donation-journal.ts', 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const script = `(() => { const exports = {}; ${source}\nwindow.independentModule = exports; })();`;
const id = (n: number) => `12345678-1234-1234-abcd-${String(n).padStart(12, '0')}`;
const scope = 'TESTNET|pool|namespace|donor|incident';
const opaque = '\u0000\ud800é\r\n {not JSON} ';
const row = (n: number, state = 'submission_claimed', sc = scope) => ({
  scope: sc, requestId: id(n), intent: opaque, state, ...(state === 'intent' ? {} : { signed: opaque + 'signed' }),
});
const test = base.extend<{ tabs: Page[] }>({ tabs: async ({}, use) => {
  const browser = await chromium.launch({ executablePath: process.env.D1_TEST_BROWSER || chromium.executablePath(), headless: true, chromiumSandbox: true });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.route('**/*', route => route.request().url() === 'http://d1-test.local/'
      ? route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Independent journal</title>' }) : route.abort());
    const tabs = [await context.newPage(), await context.newPage()];
    for (const p of tabs) { await p.goto('http://d1-test.local/'); await p.addScriptTag({ content: script }); }
    await use(tabs);
  } finally { await browser.close(); }
} });
async function open(p: Page, name: string) {
  return p.evaluate(async name => {
    try { window.independentJournal = await window.independentModule.openDonationJournal(indexedDB, name); return 'opened'; }
    catch (e) { return (e as Error).message; }
  }, name);
}
async function call(p: Page, method: keyof DonationJournalV2, args: unknown[] = []) {
  return p.evaluate(async ({ method, args }) => {
    try { return { value: await (window.independentJournal[method] as (...a: unknown[]) => unknown)(...args) }; }
    catch (e) { return { error: (e as Error).message }; }
  }, { method, args });
}
// Native writes only construct legacy/resolved/corrupt fixtures; never simulate release authority.
async function seed(p: Page, name: string, version: number, rows: unknown[], owners: unknown[] = [], evidence: unknown[] = []) {
  await p.evaluate(async ({ name, version, rows, owners, evidence }) => {
    const r = indexedDB.open(name, version);
    r.onupgradeneeded = () => {
      const d = r.result, store = d.createObjectStore('donations', { keyPath: 'requestId' });
      store.createIndex('scope', 'scope', { unique: version === 1 });
      rows.forEach(v => store.add(v));
      if (version === 2) {
        const o = d.createObjectStore('scopes', { keyPath: 'scope' }), e = d.createObjectStore('resolutions', { keyPath: 'requestId' });
        owners.forEach(v => o.add(v)); evidence.forEach(v => e.add(v));
      }
    };
    await new Promise<void>((resolve, reject) => { r.onsuccess = () => { r.result.close(); resolve(); }; r.onerror = () => reject(r.error); });
  }, { name, version, rows, owners, evidence });
}
// Only for rollback/corrupt fixtures. Hash logical native schema/data, not physical IDB bytes.
async function digest(p: Page, name: string) {
  const snapshot = await p.evaluate(async name => {
    const r = indexedDB.open(name);
    const db = await new Promise<IDBDatabase>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    try {
      const tx = db.transaction(Array.from(db.objectStoreNames), 'readonly');
      const stores: Record<string, unknown> = {};
      for (const name of Array.from(db.objectStoreNames)) {
        const s = tx.objectStore(name), r = s.getAll();
        r.onsuccess = () => { stores[name] = { key: s.keyPath, auto: s.autoIncrement, indexes: Array.from(s.indexNames, n => {
          const i = s.index(n); return [n, i.keyPath, i.unique, i.multiEntry];
        }), rows: r.result }; };
      }
      await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
      return JSON.stringify({ version: db.version, stores });
    } finally { db.close(); }
  }, name);
  return createHash('sha256').update(snapshot).digest('hex');
}
test('S10: migrated opaque states survive reload; late corrupt row rolls back schema and data', async ({ tabs: [a, b] }) => {
  const rows = ['intent', 'signed', 'submission_claimed'].map((st, i) => row(i + 1, st, scope + i));
  await seed(a, 'legacy', 1, rows);
  expect(await open(a, 'legacy')).toBe('opened');
  await call(a, 'close');
  expect(await open(b, 'legacy')).toBe('opened');
  for (const r of rows) {
    expect(await call(b, 'read', [r.requestId])).toEqual({ value: r });
    expect(await call(b, 'readScope', [r.scope])).toEqual({ value: { record: r, active: true, resolution: null } });
    expect(await call(b, 'readResolution', [r.requestId])).toEqual({ value: null });
  }
  await seed(a, 'broken-legacy', 1, [...rows, { ...row(99, 'signed', 'late'), signed: '' }]);
  const before = await digest(a, 'broken-legacy');
  expect(await open(a, 'broken-legacy')).toBe('d1_journal_open_failed');
  expect(await digest(a, 'broken-legacy')).toBe(before);
});
test('S10: resolved history never regains ownership; competing tabs acquire and claim once', async ({ tabs: [a, b] }) => {
  await seed(a, 'history', 2, [row(1), row(2)], [{ scope, requestId: id(2), active: false }],
    [1, 2].map(n => ({ requestId: id(n), evidence: opaque + n })));
  for (const p of [a, b]) expect(await open(p, 'history')).toBe('opened');
  expect(await call(a, 'acquire', [scope, id(1), opaque])).toEqual({ value: { acquired: false, record: row(1) } });
  expect(await call(a, 'readScope', [scope])).toEqual({ value: { record: row(2), active: false, resolution: opaque + 2 } });
  const results = await Promise.all([call(a, 'acquire', [scope, id(3), opaque]), call(b, 'acquire', [scope, id(4), opaque])]);
  const values = results.map(r => r.value as { acquired: boolean; record: { requestId: string } });
  expect(values.filter(v => v.acquired)).toHaveLength(1);
  expect(values[0].record).toEqual(values[1].record);
  const winner = values[0].record.requestId, loser = winner === id(3) ? id(4) : id(3);
  expect(await call(a, 'read', [loser])).toEqual({ value: null });
  await call(a, 'saveSigned', [winner, opaque, opaque + 'signed']);
  const claims = await Promise.all([call(a, 'claimSubmission', [winner, opaque + 'signed']), call(b, 'claimSubmission', [winner, opaque + 'signed'])]);
  expect(claims.map(r => (r.value as { claimed: boolean }).claimed).sort()).toEqual([false, true]);
  const before = await call(a, 'readScope', [scope]);
  for (const p of [a, b]) {
    expect(await call(p, 'acquire', [scope, id(1), opaque])).toEqual({ value: { acquired: false, record: row(1) } });
    expect(await call(p, 'readResolution', [id(1)])).toEqual({ value: opaque + 1 });
    expect(await call(p, 'readScope', [scope])).toEqual(before);
  }
  expect(await a.evaluate(async scope => {
    const v = (await window.independentJournal.readScope(scope))!;
    return [Object.isFrozen(v), Object.isFrozen(v.record), Reflect.set(v, 'active', false), Reflect.set(v.record, 'intent', 'changed')];
  }, scope)).toEqual([true, true, false, false]);
  await call(a, 'close'); expect(await open(a, 'history')).toBe('opened');
  expect(await call(a, 'readScope', [scope])).toEqual(before);
});
test('S10: unresolved predecessor and orphan evidence reject without native fixture mutation', async ({ tabs: [a] }) => {
  await seed(a, 'hidden', 2, [row(1, 'signed'), row(2)], [{ scope, requestId: id(2), active: false }], [{ requestId: id(2), evidence: opaque }]);
  expect(await open(a, 'hidden')).toBe('opened');
  const before = await digest(a, 'hidden');
  for (const [method, args] of [['readScope', [scope]], ['readResolution', [id(2)]], ['acquire', [scope, id(3), opaque]]] as const) {
    expect(await call(a, method, [...args])).toEqual({ error: 'd1_journal_invalid_record' });
    expect(await digest(a, 'hidden')).toBe(before);
  }
  await call(a, 'close');
  await seed(a, 'orphan', 2, [], [], [{ requestId: id(1), evidence: opaque }]);
  expect(await open(a, 'orphan')).toBe('opened');
  const orphan = await digest(a, 'orphan');
  expect(await call(a, 'readResolution', [id(1)])).toEqual({ error: 'd1_journal_invalid_record' });
  expect(await digest(a, 'orphan')).toBe(orphan);
  expect(await call(a, 'acquire', [scope, id(1), opaque])).toEqual({ error: 'd1_journal_invalid_record' });
  expect(await digest(a, 'orphan')).toBe(orphan);
});
test('S10: inclusive read limits and rejected calls preserve public views', async ({ tabs: [a] }) => {
  const sc = 's'.repeat(4096), evidence = 'é'.repeat(1048576);
  await seed(a, 'limits', 2, [row(1, 'submission_claimed', sc)], [{ scope: sc, requestId: id(1), active: false }], [{ requestId: id(1), evidence }]);
  expect(await open(a, 'limits')).toBe('opened');
  const before = await call(a, 'readScope', [sc]);
  expect(await call(a, 'readResolution', [id(1)])).toEqual({ value: evidence });
  for (const [method, args] of [
    ['readScope', ['']], ['readScope', [sc + 's']], ['readResolution', [id(1).toUpperCase()]],
    ['readResolution', [null]], ['acquire', [sc, id(2), '']], ['acquire', [sc, id(1), opaque + 'changed']],
  ] as [keyof DonationJournalV2, unknown[]][]) {
    expect(await call(a, method, args)).toEqual({ error: method === 'acquire' && args[1] === id(1) ? 'd1_journal_conflict' : 'd1_journal_invalid_argument' });
    expect(await call(a, 'readScope', [sc])).toEqual(before);
    expect(await call(a, 'read', [id(2)])).toEqual({ value: null });
  }
  await call(a, 'close');
  expect(await call(a, 'readScope', [sc])).toEqual({ error: 'd1_journal_closed' });
  expect(await call(a, 'readResolution', [id(1)])).toEqual({ error: 'd1_journal_closed' });
});
