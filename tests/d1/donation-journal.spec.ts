import { test as base, expect, chromium, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import type { DonationJournal } from '../../src/lib/d1/donation-journal';

declare global {
  interface Window {
    journalModule: typeof import('../../src/lib/d1/donation-journal');
    journal: DonationJournal;
  }
}
// Transpile ONLY the standalone production module; no fake IndexedDB or server.
const source = ts.transpileModule(readFileSync('src/lib/d1/donation-journal.ts', 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const script = `(() => { const exports = {}; ${source}\nwindow.journalModule = exports; })();`;
const id = 'abcdef01-2345-6789-abcd-0123456789ab';
const rival = 'abcdef02-2345-6789-abcd-0123456789ab';
const scope = 'TESTNET|pool|namespace|donor|incident';
const intent = ' { "amount": "1.0000000", "opaque": "é" }\n\u0000';
const signed = ' exact opaque signed payload\n';
const original = { scope, requestId: id, intent, state: 'intent' };
const signedRecord = { ...original, state: 'signed', signed };
const claimedRecord = { ...signedRecord, state: 'submission_claimed' };
async function load(page: Page) {
  await page.addScriptTag({ content: script });
  await page.evaluate(async () => { window.journal = await window.journalModule.openDonationJournal(indexedDB, 'journal'); });
}
async function call(page: Page, method: keyof DonationJournal, args: unknown[] = []) {
  return page.evaluate(async ({ method, args }) => {
    try {
      const operation = window.journal[method] as (...args: unknown[]) => unknown;
      return { value: await operation(...args) };
    } catch (error) { return { error: (error as Error).message }; }
  }, { method, args });
}
const test = base.extend<{ pages: [Page, Page] }>({
  pages: async ({}, use, info) => {
    console.log(`Journal browser test output: ${info.project.outputDir}`);
    const browser = await chromium.launch({
      executablePath: process.env.D1_TEST_BROWSER || chromium.executablePath(),
      headless: true, chromiumSandbox: true,
    });
    try {
      const context = await browser.newContext({ serviceWorkers: 'block' });
      await context.route('**/*', route => route.request().url() === 'http://d1-test.local/'
        ? route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Offline journal</title>' })
        : route.abort());
      const pages: [Page, Page] = [await context.newPage(), await context.newPage()];
      for (const page of pages) { await page.goto('http://d1-test.local/'); await load(page); }
      await use(pages);
    } finally { await browser.close(); }
  },
});

test('independent connections acquire one original scope despite different UUIDs and amounts', async ({ pages: [a, b] }) => {
  const results = await Promise.all([
    call(a, 'acquire', [scope, id, intent]),
    call(b, 'acquire', [scope, rival, '{"amount":"2.0000000"}']),
  ]);
  const values = results.map(result => result.value as { acquired: boolean; record: typeof original });
  expect(values.filter(result => result.acquired)).toHaveLength(1);
  const winner = values.find(result => result.acquired)!.record;
  expect(winner).toEqual(winner.requestId === id ? original : { ...original, requestId: rival, intent: '{"amount":"2.0000000"}' });
  expect(values[0].record).toEqual(winner);
  expect(values[1].record).toEqual(winner);
  for (const page of [a, b]) {
    expect(await call(page, 'read', [winner.requestId])).toEqual({ value: winner });
    expect(await call(page, 'read', [winner.requestId === id ? rival : id])).toEqual({ value: null });
  }
});

test('UUID and scope identity are immutable; exact acquisition is idempotent', async ({ pages: [a, b] }) => {
  expect(await call(a, 'acquire', [scope, id, intent])).toEqual({ value: { acquired: true, record: original } });
  expect(await call(b, 'acquire', [scope, id, intent])).toEqual({ value: { acquired: false, record: original } });
  for (const args of [[scope, id, intent + ' '], [scope + 'other', id, intent]]) {
    expect(await call(b, 'acquire', args)).toEqual({ error: 'd1_journal_conflict' });
    expect(await call(a, 'read', [id])).toEqual({ value: original });
  }
  expect(await call(b, 'acquire', [scope + 'other', rival, 'other'])).toMatchObject({ value: { acquired: true } });
  // Even when both scopes already exist, a reused UUID must not be silently merged.
  expect(await call(b, 'acquire', [scope, rival, 'other'])).toEqual({ error: 'd1_journal_conflict' });
  expect(await call(a, 'acquire', [scope, 'abcdef03-2345-6789-abcd-0123456789ab', 'another amount'])).toEqual({ value: { acquired: false, record: original } });
});

test('exact bytes, independent frozen records and guarded signing transitions', async ({ pages: [a, b] }) => {
  await call(a, 'acquire', [scope, id, intent]);
  expect(await a.evaluate(async id => {
    const first = await window.journal.read(id), second = await window.journal.read(id);
    const result = await window.journal.acquire(first!.scope, id, first!.intent);
    return { independent: first !== second && first !== result.record,
      frozen: [first, second, result, result.record].every(Object.isFrozen),
      mutation: Reflect.set(first!, 'intent', 'replacement'), first, second };
  }, id)).toEqual({ independent: true, frozen: true, mutation: false, first: original, second: original });
  for (const [args, error] of [
    [[id, intent + ' ', signed], 'd1_journal_guard_mismatch'],
    [[rival, intent, signed], 'd1_journal_not_found'],
  ] as const) {
    expect(await call(b, 'saveSigned', [...args])).toEqual({ error });
    expect(await call(a, 'read', [id])).toEqual({ value: original });
    expect(await call(a, 'read', [rival])).toEqual({ value: null });
  }
  expect(await call(a, 'saveSigned', [id, intent, signed])).toEqual({ value: signedRecord });
  expect(await call(b, 'saveSigned', [id, intent, signed])).toEqual({ value: signedRecord });
  expect(await call(b, 'saveSigned', [id, intent, signed + ' '])).toEqual({ error: 'd1_journal_conflict' });
  expect(await call(a, 'read', [id])).toEqual({ value: signedRecord });
  expect(await a.evaluate(async ({ id, intent, signed }) => Object.isFrozen(await window.journal.saveSigned(id, intent, signed)), { id, intent, signed })).toBe(true);
});

test('one submission claim survives close, reopen and reload; unknown never permits resend', async ({ pages: [a, b] }) => {
  await call(a, 'acquire', [scope, id, intent]);
  expect(await call(a, 'claimSubmission', [id, signed])).toEqual({ error: 'd1_journal_invalid_state' });
  expect(await call(b, 'claimSubmission', [rival, signed])).toEqual({ error: 'd1_journal_not_found' });
  expect(await call(a, 'read', [id])).toEqual({ value: original });
  await call(a, 'saveSigned', [id, intent, signed]);
  expect(await call(b, 'claimSubmission', [id, signed + ' '])).toEqual({ error: 'd1_journal_guard_mismatch' });
  expect(await call(a, 'read', [id])).toEqual({ value: signedRecord });
  const results = await Promise.all([call(a, 'claimSubmission', [id, signed]), call(b, 'claimSubmission', [id, signed])]);
  expect(results).toContainEqual({ value: { claimed: true, record: claimedRecord } });
  expect(results).toContainEqual({ value: { claimed: false, record: claimedRecord } });
  await call(a, 'close');
  await load(a);
  await b.reload();
  await load(b);
  for (const page of [a, b]) {
    expect(await call(page, 'read', [id])).toEqual({ value: claimedRecord });
    expect(await call(page, 'claimSubmission', [id, signed])).toEqual({ value: { claimed: false, record: claimedRecord } });
    expect(await call(page, 'acquire', [scope, rival, 'new amount'])).toEqual({ value: { acquired: false, record: claimedRecord } });
    expect(await call(page, 'saveSigned', [id, intent, signed])).toEqual({ value: claimedRecord });
    expect(await call(page, 'saveSigned', [id, intent, 'replacement'])).toEqual({ error: 'd1_journal_conflict' });
    expect(await call(page, 'read', [id])).toEqual({ value: claimedRecord });
  }
  expect(await a.evaluate(async ({ id, signed }) => {
    const result = await window.journal.claimSubmission(id, signed);
    return Object.isFrozen(result) && Object.isFrozen(result.record);
  }, { id, signed })).toBe(true);
});

test('primitive argument rejection leaves records and pending scope unchanged', async ({ pages: [a] }) => {
  await call(a, 'acquire', [scope, id, intent]);
  const invalid: [keyof DonationJournal, unknown[]][] = [];
  for (const bad of ['', 1, null, {}, 'x'.repeat(4097)]) invalid.push(['acquire', [bad, rival, intent]]);
  for (const bad of ['', id.toUpperCase(), id + '\n', 1, null, {}]) {
    invalid.push(['acquire', [scope, bad, intent]], ['read', [bad]], ['saveSigned', [bad, intent, signed]], ['claimSubmission', [bad, signed]]);
  }
  for (const bad of ['', 1, null, {}, 'x'.repeat(1048577)]) {
    invalid.push(['acquire', [scope, rival, bad]], ['saveSigned', [id, bad, signed]],
      ['saveSigned', [id, intent, bad]], ['claimSubmission', [id, bad]]);
  }
  for (const [method, args] of invalid) {
    expect(await call(a, method, args)).toEqual({ error: 'd1_journal_invalid_argument' });
    expect(await call(a, 'read', [id])).toEqual({ value: original });
    expect(await call(a, 'read', [rival])).toEqual({ value: null });
  }
  expect(await call(a, 'acquire', [scope, rival, intent])).toEqual({ value: { acquired: false, record: original } });
});

test('inclusive string limits and closed connections fail without volatile fallback', async ({ pages: [a, b] }) => {
  const maxScope = 's'.repeat(4096), payload = 'x'.repeat(1048576);
  expect(await call(a, 'acquire', [maxScope, id, payload])).toEqual({ value: { acquired: true, record: { scope: maxScope, requestId: id, intent: payload, state: 'intent' } } });
  expect(await call(a, 'saveSigned', [id, payload, payload])).toMatchObject({ value: { signed: payload, state: 'signed' } });
  await call(a, 'close');
  await call(a, 'close');
  for (const [method, args] of [['read', [id]], ['acquire', [scope, rival, intent]], ['saveSigned', [id, payload, payload]], ['claimSubmission', [id, payload]]] as [keyof DonationJournal, unknown[]][]) {
    expect(await call(a, method, args)).toEqual({ error: 'd1_journal_closed' });
  }
  expect(await call(b, 'read', [id])).toMatchObject({ value: { state: 'signed', signed: payload } });
  expect(await call(b, 'read', [rival])).toEqual({ value: null });
  expect(await b.evaluate(async () => {
    const open = window.journalModule.openDonationJournal;
    const errors = [];
    for (const name of ['', 'x'.repeat(257), null, 1]) {
      try { await open(indexedDB, name as string); } catch (e) { errors.push((e as Error).message); }
    }
    try { await open(undefined as unknown as IDBFactory, 'valid'); } catch (e) { errors.push((e as Error).message); }
    const journal = await open(indexedDB, 'n'.repeat(256));
    journal.close();
    return errors;
  })).toEqual([...Array(4).fill('d1_journal_invalid_argument'), 'd1_journal_unavailable']);
});

test('real transaction aborted after successful add rejects and retains no tentative record', async ({ pages: [a, b] }) => {
  await call(b, 'acquire', [scope, id, intent]);
  expect(await a.evaluate(async ({ rival, intent }) => {
    let requestSucceeded = false;
    // Thin fault boundary: actual Chromium database, transactions and requests; no substitute atomicity.
    const factory = { open(name: string, version?: number) {
      const request = indexedDB.open(name, version);
      request.addEventListener('success', () => {
        const db = request.result, transaction = db.transaction.bind(db);
        db.transaction = (...args) => {
          const tx = transaction(...args), objectStore = tx.objectStore.bind(tx);
          tx.objectStore = name => {
            const store = objectStore(name), add = store.add.bind(store);
            store.add = (...args) => {
              const write = add(...args);
              write.addEventListener('success', () => { requestSucceeded = true; tx.abort(); });
              return write;
            };
            return store;
          };
          return tx;
        };
      });
      return request;
    } } as IDBFactory;
    const journal = await window.journalModule.openDonationJournal(factory, 'journal');
    try { await journal.acquire('another scope', rival, intent); return { resolved: true }; }
    catch (e) { return { error: (e as Error).message, requestSucceeded }; }
    finally { journal.close(); }
  }, { rival, intent })).toEqual({ error: 'd1_journal_storage_error', requestSucceeded: true });
  expect(await call(b, 'read', [rival])).toEqual({ value: null });
  expect(await call(b, 'read', [id])).toEqual({ value: original });
  expect(await call(b, 'acquire', ['another scope', rival, intent])).toMatchObject({ value: { acquired: true } });
});

test('malformed stored envelopes fail closed without changing actual stored data', async ({ pages: [a, b] }) => {
  await call(b, 'acquire', [scope, id, intent]);
  expect(await a.evaluate(async ({ id, original }) => {
    let injected: unknown;
    const factory = { open(name: string, version?: number) {
      const request = indexedDB.open(name, version);
      request.addEventListener('success', () => {
        const db = request.result, transaction = db.transaction.bind(db);
        db.transaction = (...args) => {
          const tx = transaction(...args), objectStore = tx.objectStore.bind(tx);
          tx.objectStore = name => {
            const store = objectStore(name), get = store.get.bind(store);
            store.get = key => {
              const read = get(key);
              read.addEventListener('success', () => Object.defineProperty(read, 'result', { value: injected }));
              return read;
            };
            return store;
          };
          return tx;
        };
      });
      return request;
    } } as IDBFactory;
    const journal = await window.journalModule.openDonationJournal(factory, 'journal');
    const errors = [];
    try {
      for (injected of [null, [], { ...original, state: 'unknown' }, { ...original, state: 'signed' },
        { ...original, signed: 'unexpected' }, { ...original, scope: '' }, { ...original, requestId: 'bad' },
        { ...original, intent: '' }, { ...original, extra: true }, JSON.parse('{"__proto__":{},"scope":"s"}')]) {
        try { await journal.read(id); } catch (e) { errors.push((e as Error).message); }
      }
    } finally { journal.close(); }
    return errors;
  }, { id, original })).toEqual(Array(10).fill('d1_journal_invalid_record'));
  expect(await call(b, 'read', [id])).toEqual({ value: original });
});

test('version change closes old connections; unsupported upgrades abort without changing records', async ({ pages: [a, b] }) => {
  await call(a, 'acquire', [scope, id, intent]);
  expect(await a.evaluate(async () => {
    const factory = { open: (name: string) => indexedDB.open(name, 3) } as IDBFactory;
    try { await window.journalModule.openDonationJournal(factory, 'journal'); }
    catch (e) { return (e as Error).message; }
  })).toBe('d1_journal_open_failed');
  for (const page of [a, b]) expect(await call(page, 'read', [id])).toEqual({ error: 'd1_journal_closed' });
  await load(a);
  expect(await call(a, 'read', [id])).toEqual({ value: original });
});

test('blocked/error opens reject stably and late successful opens are closed', async ({ pages: [a] }) => {
  expect(await a.evaluate(async () => {
    const results = [];
    for (const event of ['onblocked', 'onerror', 'throw']) {
      let closed = 0;
      const request = { result: { close: () => closed++ } } as unknown as IDBOpenDBRequest;
      const factory = { open() {
        if (event === 'throw') throw new Error('private platform detail');
        queueMicrotask(() => (request[event as 'onblocked' | 'onerror'] as Function)?.());
        return request;
      } } as unknown as IDBFactory;
      let error = '';
      try { await window.journalModule.openDonationJournal(factory, 'test'); } catch (e) { error = (e as Error).message; }
      if (event !== 'throw') (request.onsuccess as Function)?.();
      results.push({ error, closed });
    }
    return results;
  })).toEqual([{ error: 'd1_journal_blocked', closed: 1 }, { error: 'd1_journal_open_failed', closed: 1 }, { error: 'd1_journal_open_failed', closed: 0 }]);
});


test('independent conflicting signatures retain one winner through claim', async ({ pages: [a, b] }) => {
  await call(a, 'acquire', [scope, id, intent]);
  const results = await Promise.all([
    call(a, 'saveSigned', [id, intent, 'signature-A']),
    call(b, 'saveSigned', [id, intent, 'signature-B']),
  ]);
  expect(results.filter(r => r.error)).toEqual([
    { error: 'd1_journal_conflict' },
  ]);
  const winner = results.find(r => r.value)!.value as {
    signed: string; state: string;
  };
  expect(winner.state).toBe('signed');
  const loser = winner.signed === 'signature-A'
    ? 'signature-B' : 'signature-A';
  const before = await call(a, 'read', [id]);
  expect(await call(b, 'claimSubmission', [id, loser])).toEqual({
    error: 'd1_journal_guard_mismatch',
  });
  expect(await call(a, 'read', [id])).toEqual(before);
  const claims = await Promise.all([
    call(a, 'claimSubmission', [id, winner.signed]),
    call(b, 'claimSubmission', [id, winner.signed]),
  ]);
  expect(claims.map(r => (r.value as { claimed: boolean }).claimed).sort())
    .toEqual([false, true]);
});

test('same UUID racing across scopes cannot reserve both scopes', async ({ pages: [a, b] }) => {
  const results = await Promise.all([
    call(a, 'acquire', [scope, id, intent]),
    call(b, 'acquire', [scope + '|other', id, intent]),
  ]);
  expect(results.filter(r => r.error)).toEqual([
    { error: 'd1_journal_conflict' },
  ]);
  const winner = results.find(r => r.value)!.value as {
    acquired: boolean; record: { scope: string };
  };
  expect(winner.acquired).toBe(true);
  const unused = winner.record.scope === scope ? scope + '|other' : scope;
  const before = await call(a, 'read', [id]);
  expect(await call(b, 'acquire', [unused, rival, intent]))
    .toMatchObject({ value: { acquired: true } });
  expect(await call(a, 'read', [id])).toEqual(before);
});

test('claim racing with idempotent save never downgrades durable ownership', async ({ pages: [a, b] }) => {
  await call(a, 'acquire', [scope, id, intent]);
  await call(a, 'saveSigned', [id, intent, signed]);
  const [claim, save] = await Promise.all([
    call(a, 'claimSubmission', [id, signed]),
    call(b, 'saveSigned', [id, intent, signed]),
  ]);
  expect(claim).toEqual({
    value: { claimed: true, record: claimedRecord },
  });
  expect(save.error).toBeUndefined();
  await a.reload();
  await load(a);
  expect(await call(a, 'read', [id])).toEqual({ value: claimedRecord });
  expect(await call(a, 'claimSubmission', [id, signed])).toEqual({
    value: { claimed: false, record: claimedRecord },
  });
  expect(await call(b, 'saveSigned', [id, intent, signed + 'changed']))
    .toEqual({ error: 'd1_journal_conflict' });
  expect(await call(a, 'read', [id])).toEqual({ value: claimedRecord });
});
