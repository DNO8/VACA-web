import { test as base, expect, chromium, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import type { DonationJournal, DonationJournalRecord } from '../../src/lib/d1/donation-journal';

// This contract compiles against v1: RED must be behavioral, not a missing export.
type V2 = DonationJournal & {
  readScope(scope: string): Promise<Readonly<{ record: DonationJournalRecord; active: boolean; resolution: string | null }> | null>;
  readResolution(requestId: string): Promise<string | null>;
};
declare global {
  interface Window {
    v2Module: { openDonationJournal(factory: IDBFactory, name: string): Promise<V2> };
    v2Journal: V2;
    v2Name: string;
  }
}
const source = ts.transpileModule(readFileSync('src/lib/d1/donation-journal.ts', 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const script = `(() => { const exports = {}; ${source}\nwindow.v2Module = exports; })();`;
const id = 'abcdef01-2345-6789-abcd-0123456789ab';
const rival = 'abcdef02-2345-6789-abcd-0123456789ab';
const third = 'abcdef03-2345-6789-abcd-0123456789ab';
const scope = 'TESTNET|pool|namespace|donor|incident';
const intent = ' { "amount": "1.0000000", "opaque": "é" }\n\u0000';
const signed = ' exact opaque signed payload\n\u0000';
const evidence = ' opaque—not authenticated { "result": null }\n\u0000';
const original = { scope, requestId: id, intent, state: 'intent' } as const;
const signedRecord = { ...original, state: 'signed', signed } as const;
const claimed = { ...signedRecord, state: 'submission_claimed' } as const;
const activeView = { record: original, active: true, resolution: null };
async function load(page: Page, name: string) {
  await page.addScriptTag({ content: script });
  await page.evaluate(name => { window.v2Name = name; }, name);
}
async function open(page: Page) {
  return page.evaluate(async () => {
    try {
      window.v2Journal = await window.v2Module.openDonationJournal(indexedDB, window.v2Name);
      return { opened: true };
    } catch (error) { return { error: (error as Error).message }; }
  });
}
async function call(page: Page, method: keyof V2, args: unknown[] = []) {
  return page.evaluate(async ({ method, args }) => {
    try {
      const operation = window.v2Journal[method] as (...args: unknown[]) => unknown;
      return { value: await operation(...args) };
    } catch (error) { return { error: (error as Error).message }; }
  }, { method, args });
}
type Fixture = {
  version?: number; rows?: unknown[]; owners?: unknown[]; resolutions?: unknown[];
  schema?: 'extra-store' | 'wrong-key' | 'auto-increment' | 'extra-index' | 'missing-index' | 'wrong-index' | 'nonunique' | 'multi-entry';
};
// Native writes are restricted to explicit legacy, resolved, or corrupt fixtures.
async function seed(page: Page, fixture: Fixture) {
  await page.evaluate(async fixture => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(window.v2Name, fixture.version ?? 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        const store = db.createObjectStore('donations', {
          keyPath: fixture.schema === 'wrong-key' ? 'scope' : 'requestId',
          autoIncrement: fixture.schema === 'auto-increment',
        });
        if (fixture.schema !== 'missing-index') store.createIndex('scope', fixture.schema === 'wrong-index' ? 'intent' : 'scope', {
          unique: (fixture.version ?? 1) === 1 && fixture.schema !== 'nonunique',
          multiEntry: fixture.schema === 'multi-entry',
        });
        if (fixture.schema === 'extra-index') store.createIndex('unexpected', 'intent');
        if (fixture.schema === 'extra-store') db.createObjectStore('unexpected');
        for (const row of fixture.rows ?? []) store.add(row);
        if (fixture.version === 2) {
          const owners = db.createObjectStore('scopes', { keyPath: 'scope' });
          const resolutions = db.createObjectStore('resolutions', { keyPath: 'requestId' });
          for (const owner of fixture.owners ?? []) owners.add(owner);
          for (const resolution of fixture.resolutions ?? []) resolutions.add(resolution);
        }
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => { request.result.close(); resolve(); };
    });
  }, fixture);
}
// Only used when a rejecting opener cannot expose rollback/version/schema state.
async function snapshot(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(window.v2Name);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const names = Array.from(db.objectStoreNames);
      const tx = db.transaction(names, 'readonly');
      const stores: Record<string, unknown> = {};
      for (const name of names) {
        const store = tx.objectStore(name), rows = store.getAll(), keys = store.getAllKeys();
        keys.onsuccess = () => {
          stores[name] = { keyPath: store.keyPath, autoIncrement: store.autoIncrement,
            indexes: Array.from(store.indexNames, name => {
              const index = store.index(name);
              return { name, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry };
            }), rows: rows.result, keys: keys.result };
        };
      }
      await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
      return { version: db.version, stores };
    } finally { db.close(); }
  });
}
const test = base.extend<{ pages: [Page, Page]; dbName: string }>({
  dbName: async ({}, use) => { await use(`d1-journal-v2-${crypto.randomUUID()}`); },
  pages: async ({ dbName }, use, info) => {
    console.log(`Journal v2 browser output: ${info.project.outputDir}`);
    const browser = await chromium.launch({
      executablePath: process.env.D1_TEST_BROWSER || chromium.executablePath(), headless: true, chromiumSandbox: true,
    });
    try {
      const context = await browser.newContext({ serviceWorkers: 'block' });
      await context.route('**/*', route => route.request().url() === 'http://d1-test.local/'
        ? route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Offline journal v2</title>' }) : route.abort());
      const pages: [Page, Page] = [await context.newPage(), await context.newPage()];
      for (const page of pages) { await page.goto('http://d1-test.local/'); await load(page, dbName); }
      try { await use(pages); }
      finally {
        for (const page of pages) await page.evaluate(() => window.v2Journal?.close());
        await pages[0].evaluate(async name => {
          await new Promise<void>((resolve, reject) => {
            const request = indexedDB.deleteDatabase(name);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
            request.onblocked = () => reject(new Error('fixture connection leaked'));
          });
        }, dbName);
      }
    } finally { await browser.close(); }
  },
});

test('fresh v2 exposes immutable scope views without changing donation envelopes', async ({ pages: [a] }) => {
  expect(await open(a)).toEqual({ opened: true });
  expect(await call(a, 'readScope', [scope])).toEqual({ value: null });
  expect(await call(a, 'readResolution', [id])).toEqual({ value: null });
  expect(await call(a, 'acquire', [scope, id, intent])).toEqual({ value: { acquired: true, record: original } });
  expect(await call(a, 'readScope', [scope])).toEqual({ value: activeView });
  expect(await a.evaluate(async scope => {
    const first = await window.v2Journal.readScope(scope), second = await window.v2Journal.readScope(scope);
    return { frozen: [first, first!.record, second, second!.record].every(Object.isFrozen),
      independent: first !== second && first!.record !== second!.record,
      mutation: Reflect.set(first!, 'active', false), methods: Object.keys(window.v2Journal).sort() };
  }, scope)).toEqual({ frozen: true, independent: true, mutation: false,
    methods: ['acquire', 'claimSubmission', 'close', 'read', 'readResolution', 'readScope', 'saveSigned'].sort() });
  expect(await call(a, 'read', [id])).toEqual({ value: original });
});

test('v1 intent, signed and claimed records migrate byte-exact as active unresolved owners', async ({ pages: [a, b] }) => {
  const rows = [original, { ...signedRecord, scope: scope + '2', requestId: rival }, { ...claimed, scope: scope + '3', requestId: third }];
  await seed(a, { rows });
  expect(await open(a)).toEqual({ opened: true });
  expect(await open(b)).toEqual({ opened: true });
  for (const row of rows) {
    expect(await call(b, 'read', [row.requestId])).toEqual({ value: row });
    expect(await call(a, 'readScope', [row.scope])).toEqual({ value: { record: row, active: true, resolution: null } });
    expect(await call(a, 'readResolution', [row.requestId])).toEqual({ value: null });
    expect(await call(b, 'acquire', [row.scope, 'abcdef04-2345-6789-abcd-0123456789ab', 'other'])).toEqual({ value: { acquired: false, record: row } });
  }
  expect(await call(a, 'saveSigned', [id, intent, signed])).toEqual({ value: signedRecord });
  expect(await call(b, 'claimSubmission', [id, signed])).toEqual({ value: { claimed: true, record: claimed } });
  await a.reload(); await load(a, await b.evaluate(() => window.v2Name));
  expect(await open(a)).toEqual({ opened: true });
  expect(await call(a, 'readScope', [scope])).toEqual({ value: { record: claimed, active: true, resolution: null } });
});

for (const schema of ['extra-store', 'wrong-key', 'auto-increment', 'extra-index', 'missing-index', 'wrong-index', 'nonunique', 'multi-entry'] as const) {
  test(`v1 ${schema} schema rejects with complete schema/data rollback`, async ({ pages: [a] }) => {
    await seed(a, { schema, rows: [original] });
    const before = await snapshot(a);
    expect(await open(a)).toEqual({ error: 'd1_journal_open_failed' });
    expect(await snapshot(a)).toEqual(before);
  });
}
for (const bad of [
  { ...claimed, requestId: third, scope: 'late', extra: true },
  { ...original, requestId: third, scope: 'late', state: 'signed' },
  { ...original, requestId: third, scope: 'late', intent: '' },
  { ...original, requestId: 'zz-invalid-uuid', scope: 'late' },
]) {
  test(`late invalid v1 row rolls back earlier migrated rows: ${JSON.stringify(bad)}`, async ({ pages: [a] }) => {
    await seed(a, { rows: [original, { ...signedRecord, requestId: rival, scope: 'middle' }, bad] });
    const before = await snapshot(a);
    expect(await open(a)).toEqual({ error: 'd1_journal_open_failed' });
    expect(await snapshot(a)).toEqual(before);
  });
}
for (const fault of ['abort', 'request-error'] as const) {
  test(`migration ${fault} after a successful ownership write rolls back schema and all records`, async ({ pages: [a] }) => {
    await seed(a, { rows: [original, { ...claimed, requestId: rival, scope: 'other' }] });
    const before = await snapshot(a);
    expect(await a.evaluate(async fault => {
      let wrote = false;
      const factory = { open(name: string, version?: number) {
        const request = indexedDB.open(name, version);
        request.addEventListener('upgradeneeded', () => {
          const tx = request.transaction!, db = request.result;
          const wrap = (store: IDBObjectStore) => {
            if (store.name !== 'scopes') return store;
            for (const method of ['add', 'put'] as const) {
              const write = store[method].bind(store);
              store[method] = (...args) => {
                const result = write(...args);
                result.addEventListener('success', () => {
                  if (wrote) return;
                  wrote = true;
                  if (fault === 'abort') tx.abort();
                  else IDBObjectStore.prototype.add.call(store, args[0]); // Real duplicate-key error aborts tx.
                });
                return result;
              };
            }
            return store;
          };
          const create = db.createObjectStore.bind(db), objectStore = tx.objectStore.bind(tx);
          db.createObjectStore = (...args) => wrap(create(...args));
          tx.objectStore = name => wrap(objectStore(name));
        });
        return request;
      } } as IDBFactory;
      try { const journal = await window.v2Module.openDonationJournal(factory, window.v2Name); journal.close(); return { opened: true, wrote }; }
      catch (error) { return { error: (error as Error).message, wrote }; }
    }, fault)).toEqual({ error: 'd1_journal_open_failed', wrote: true });
    expect(await snapshot(a)).toEqual(before);
  });
}

test('an old tab closes on migration versionchange and v2 closes on a later upgrade', async ({ pages: [a, b] }) => {
  await seed(a, { rows: [original] });
  const old = await a.evaluateHandle(async () => {
    const request = indexedDB.open(window.v2Name, 1);
    const db = await new Promise<IDBDatabase>(resolve => { request.onsuccess = () => resolve(request.result); });
    const state = { db, versions: [] as (number | null)[] };
    db.onversionchange = event => { state.versions.push(event.newVersion); db.close(); };
    return state;
  });
  try {
    expect(await open(b)).toEqual({ opened: true });
    expect(await old.evaluate(state => state.versions)).toEqual([2]);
    expect(await call(b, 'readScope', [scope])).toEqual({ value: activeView });
    await a.evaluate(async () => {
      const request = indexedDB.open(window.v2Name, 3);
      request.onupgradeneeded = () => request.transaction!.abort();
      await new Promise<void>(resolve => { request.onerror = () => resolve(); });
    });
    expect(await call(b, 'read', [id])).toEqual({ error: 'd1_journal_closed' });
    expect(await open(b)).toEqual({ opened: true });
    expect(await call(b, 'read', [id])).toEqual({ value: original });
  } finally { await old.evaluate(state => state.db.close()); await old.dispose(); }
});

test('real blocked migration rejects; releasing the blocker cannot migrate after rejection', async ({ pages: [a] }) => {
  await seed(a, { rows: [original] });
  const before = await snapshot(a);
  expect(await a.evaluate(async () => {
    const request = indexedDB.open(window.v2Name, 1);
    const blocker = await new Promise<IDBDatabase>(resolve => { request.onsuccess = () => resolve(request.result); });
    let terminal: Promise<void> = Promise.resolve();
    const factory = { open(name: string, version?: number) {
      const pending = indexedDB.open(name, version);
      terminal = new Promise<void>(resolve => {
        pending.addEventListener('error', () => resolve());
        pending.addEventListener('success', () => resolve());
      });
      return pending;
    } } as IDBFactory;
    let outcome;
    try { const journal = await window.v2Module.openDonationJournal(factory, window.v2Name); journal.close(); outcome = { opened: true }; }
    catch (error) { outcome = { error: (error as Error).message }; }
    finally { blocker.close(); }
    await terminal;
    return outcome;
  })).toEqual({ error: 'd1_journal_blocked' });
  expect(await snapshot(a)).toEqual(before);
});

test('late real successful open is closed after a blocked signal; higher versions fail closed', async ({ pages: [a] }) => {
  await seed(a, { version: 2, rows: [original], owners: [{ scope, requestId: id, active: true }] });
  expect(await a.evaluate(async () => {
    let closed = 0;
    let terminal: Promise<void> = Promise.resolve();
    const factory = { open(name: string, version?: number) {
      const request = indexedDB.open(name, version);
      terminal = new Promise<void>(resolve => {
        request.addEventListener('success', () => {
          const db = request.result, close = db.close.bind(db);
          db.close = () => { closed++; close(); };
        });
        // Native dispatch can checkpoint microtasks between listeners. Register
        // this observer after the opener installs onsuccess, not before cleanup.
        queueMicrotask(() => request.addEventListener('success', () => resolve()));
        request.addEventListener('error', () => resolve());
      });
      queueMicrotask(() => request.dispatchEvent(new Event('blocked')));
      return request;
    } } as IDBFactory;
    let error = '';
    try { const journal = await window.v2Module.openDonationJournal(factory, window.v2Name); journal.close(); }
    catch (e) { error = (e as Error).message; }
    await terminal;
    return { error, closed };
  })).toEqual({ error: 'd1_journal_blocked', closed: 1 });
  await a.evaluate(async () => {
    const request = indexedDB.open(window.v2Name, 3);
    await new Promise<void>((resolve, reject) => { request.onsuccess = () => { request.result.close(); resolve(); }; request.onerror = () => reject(request.error); });
  });
  const before = await snapshot(a);
  expect(await open(a)).toEqual({ error: 'd1_journal_open_failed' });
  expect(await snapshot(a)).toEqual(before);
});

test('resolved latest pointer admits one new owner across connections, retaining history and UUID identity', async ({ pages: [a, b], dbName }) => {
  await seed(a, { version: 2, rows: [claimed], owners: [{ scope, requestId: id, active: false }], resolutions: [{ requestId: id, evidence }] });
  for (const page of [a, b]) expect(await open(page)).toEqual({ opened: true });
  const resolved = { record: claimed, active: false, resolution: evidence };
  expect(await call(a, 'readScope', [scope])).toEqual({ value: resolved });
  expect(await call(a, 'readResolution', [id])).toEqual({ value: evidence });
  expect(await call(b, 'acquire', [scope, id, intent])).toEqual({ value: { acquired: false, record: claimed } });
  expect(await call(a, 'readScope', [scope])).toEqual({ value: resolved });
  for (const args of [[scope, id, intent + ' '], [scope + 'other', id, intent]]) {
    expect(await call(b, 'acquire', args)).toEqual({ error: 'd1_journal_conflict' });
    expect(await call(a, 'readScope', [scope])).toEqual({ value: resolved });
  }
  const results = await Promise.all([call(a, 'acquire', [scope, rival, 'next-A']), call(b, 'acquire', [scope, third, 'next-B'])]);
  const values = results.map(result => result.value as { acquired: boolean; record: DonationJournalRecord });
  expect(values.map(value => value.acquired).sort()).toEqual([false, true]);
  const winner = values.find(value => value.acquired)!.record;
  expect(winner).toEqual({ scope, requestId: winner.requestId, intent: winner.requestId === rival ? 'next-A' : 'next-B', state: 'intent' });
  expect([rival, third]).toContain(winner.requestId);
  expect(values[0].record).toEqual(values[1].record);
  await a.reload(); await load(a, dbName); expect(await open(a)).toEqual({ opened: true });
  for (const page of [a, b]) {
    expect(await call(page, 'read', [id])).toEqual({ value: claimed });
    expect(await call(page, 'readResolution', [id])).toEqual({ value: evidence });
    expect(await call(page, 'read', [winner.requestId === rival ? third : rival])).toEqual({ value: null });
    expect(await call(page, 'readScope', [scope])).toEqual({ value: { record: winner, active: true, resolution: null } });
    expect(await call(page, 'acquire', [scope, id, intent])).toEqual({ value: { acquired: false, record: claimed } });
    expect(await call(page, 'readScope', [scope])).toEqual({ value: { record: winner, active: true, resolution: null } });
  }
});

const corrupt: [string, Fixture][] = [
  ['missing owner', {}],
  ['missing linked record', { owners: [{ scope, requestId: rival, active: true }] }],
  ['wrong scope linkage', { owners: [{ scope: 'other', requestId: id, active: true }] }],
  ['nonboolean active', { owners: [{ scope, requestId: id, active: 'yes' }] }],
  ['extra pointer field', { owners: [{ scope, requestId: id, active: true, extra: 1 }] }],
  ['active plus resolution', { owners: [{ scope, requestId: id, active: true }], resolutions: [{ requestId: id, evidence }] }],
  ['inactive missing resolution', { owners: [{ scope, requestId: id, active: false }] }],
  ['inactive wrong resolution UUID', { owners: [{ scope, requestId: id, active: false }], resolutions: [{ requestId: rival, evidence }] }],
  ['inactive unclaimed record', { rows: [signedRecord], owners: [{ scope, requestId: id, active: false }], resolutions: [{ requestId: id, evidence }] }],
  ['empty resolution', { owners: [{ scope, requestId: id, active: false }], resolutions: [{ requestId: id, evidence: '' }] }],
  ['oversize resolution', { owners: [{ scope, requestId: id, active: false }], resolutions: [{ requestId: id, evidence: 'x'.repeat(1048577) }] }],
  ['extra resolution field', { owners: [{ scope, requestId: id, active: false }], resolutions: [{ requestId: id, evidence, extra: 1 }] }],
];
for (const [label, fixture] of corrupt) {
  test(`corrupt ${label} fails closed without creating a new donation`, async ({ pages: [a] }) => {
    const row = (fixture.rows?.[0] ?? claimed) as DonationJournalRecord;
    await seed(a, { version: 2, rows: [row], ...fixture });
    expect(await open(a)).toEqual({ opened: true });
    expect(await call(a, 'readScope', [scope])).toEqual({ error: 'd1_journal_invalid_record' });
    if (label === 'wrong scope linkage') {
      expect(await call(a, 'readScope', ['other'])).toEqual({ error: 'd1_journal_invalid_record' });
      expect(await call(a, 'acquire', ['other', third, 'new'])).toEqual({ error: 'd1_journal_invalid_record' });
    }
    if (['empty resolution', 'oversize resolution', 'extra resolution field'].includes(label)) {
      expect(await call(a, 'readResolution', [id])).toEqual({ error: 'd1_journal_invalid_record' });
    }
    expect(await call(a, 'acquire', [scope, third, 'new'])).toEqual({ error: 'd1_journal_invalid_record' });
    expect(await call(a, 'read', [third])).toEqual({ value: null });
    expect(await call(a, 'read', [id])).toEqual({ value: row });
    expect(await call(a, 'readScope', [scope])).toEqual({ error: 'd1_journal_invalid_record' });
  });
}

test('new reads validate arguments and inclusive limits, preserve opaque bytes and honor close', async ({ pages: [a] }) => {
  const maxScope = 's'.repeat(4096), maxEvidence = 'é'.repeat(1048576);
  await seed(a, { version: 2, rows: [{ ...claimed, scope: maxScope }], owners: [{ scope: maxScope, requestId: id, active: false }], resolutions: [{ requestId: id, evidence: maxEvidence }] });
  expect(await open(a)).toEqual({ opened: true });
  for (const bad of ['', 1, null, {}, 'x'.repeat(4097)]) expect(await call(a, 'readScope', [bad])).toEqual({ error: 'd1_journal_invalid_argument' });
  for (const bad of ['', 1, null, {}, id.toUpperCase(), id + '\n']) expect(await call(a, 'readResolution', [bad])).toEqual({ error: 'd1_journal_invalid_argument' });
  expect(await call(a, 'readResolution', [id])).toEqual({ value: maxEvidence });
  expect(await call(a, 'readResolution', [rival])).toEqual({ value: null });
  expect(await call(a, 'readScope', [maxScope])).toEqual({ value: { record: { ...claimed, scope: maxScope }, active: false, resolution: maxEvidence } });
  await call(a, 'close'); await call(a, 'close');
  expect(await call(a, 'readScope', [maxScope])).toEqual({ error: 'd1_journal_closed' });
  expect(await call(a, 'readResolution', [id])).toEqual({ error: 'd1_journal_closed' });
});

test('scope view uses one readonly transaction and never publishes a result before completion', async ({ pages: [a] }) => {
  await seed(a, { version: 2, rows: [claimed], owners: [{ scope, requestId: id, active: false }], resolutions: [{ requestId: id, evidence }] });
  expect(await a.evaluate(async scope => {
    const transactions: { mode: string; names: string[] }[] = [];
    let abortRead = false, succeeded = false;
    const factory = { open(name: string, version?: number) {
      const request = indexedDB.open(name, version);
      request.addEventListener('success', () => {
        const db = request.result, transaction = db.transaction.bind(db);
        db.transaction = (...args) => {
          const tx = transaction(...args), objectStore = tx.objectStore.bind(tx);
          transactions.push({ mode: tx.mode, names: Array.from(tx.objectStoreNames).sort() });
          tx.objectStore = name => {
            const store = objectStore(name), get = store.get.bind(store);
            store.get = key => {
              const read = get(key);
              read.addEventListener('success', () => {
                if (abortRead && name === 'resolutions') { succeeded = true; tx.abort(); }
              });
              return read;
            };
            return store;
          };
          return tx;
        };
      });
      return request;
    } } as IDBFactory;
    const journal = await window.v2Module.openDonationJournal(factory, window.v2Name);
    try {
      transactions.length = 0;
      const view = await journal.readScope(scope), reads = [...transactions];
      abortRead = true;
      let error = '';
      try { await journal.readScope(scope); } catch (e) { error = (e as Error).message; }
      return { view, reads, error, succeeded };
    } finally { journal.close(); }
  }, scope)).toEqual({ view: { record: claimed, active: false, resolution: evidence },
    reads: [{ mode: 'readonly', names: ['donations', 'resolutions', 'scopes'] }], error: 'd1_journal_storage_error', succeeded: true });
  expect(await open(a)).toEqual({ opened: true });
  expect(await call(a, 'readScope', [scope])).toEqual({ value: { record: claimed, active: false, resolution: evidence } });
});
