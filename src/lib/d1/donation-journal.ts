/** Opaque persistence only: callers must validate donation objects before writing and after reading. */
export type DonationJournalRecord = Readonly<{
  scope: string;
  requestId: string;
  intent: string;
} & ({ state: 'intent' } | { state: 'signed' | 'submission_claimed'; signed: string })>;
export interface DonationJournal {
  /** Scope must bind validated network/pool/namespace/donor/incident, NOT amount or asset. */
  acquire(scope: string, requestId: string, intent: string): Promise<Readonly<{ acquired: boolean; record: DonationJournalRecord }>>;
  read(requestId: string): Promise<DonationJournalRecord | null>;
  saveSigned(requestId: string, expectedIntent: string, signed: string): Promise<DonationJournalRecord>;
  /** A durable local claim only; neither submission nor ledger evidence. Never reset/release unknown outcomes. */
  claimSubmission(requestId: string, expectedSigned: string): Promise<Readonly<{ claimed: boolean; record: DonationJournalRecord }>>;
  close(): void;
}
const storeName = 'donations';
const maxPayload = 1048576;
class JournalError extends Error {
  constructor(code: string) { super(`d1_journal_${code}`); }
}
function check(condition: unknown, code: string): asserts condition {
  if (!condition) throw new JournalError(code);
}
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}
function uuid(value: unknown): value is string {
  return typeof value === 'string' && value.length === 36 && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}
/** Validate only the envelope, not JSON, XDR, signatures, economics or provenance. */
function record(value: unknown): DonationJournalRecord {
  check(value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype, 'invalid_record');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const data: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    check(typeof key === 'string', 'invalid_record');
    const descriptor = descriptors[key];
    check(descriptor && 'value' in descriptor && descriptor.enumerable, 'invalid_record');
    data[key] = descriptor.value;
  }
  const signedState = data.state === 'signed' || data.state === 'submission_claimed';
  const keys = ['scope', 'requestId', 'intent', 'state', ...(signedState ? ['signed'] : [])];
  check(Object.keys(data).length === keys.length && keys.every(key => Object.hasOwn(data, key)), 'invalid_record');
  check(text(data.scope, 4096) && uuid(data.requestId) && text(data.intent, maxPayload), 'invalid_record');
  check(signedState ? text(data.signed, maxPayload) : data.state === 'intent', 'invalid_record');
  return Object.freeze({ ...data }) as DonationJournalRecord;
}
function connection(db: IDBDatabase): DonationJournal {
  let closed = false;
  const close = () => { closed = true; db.close(); };
  db.onversionchange = close;
  db.onclose = () => { closed = true; };
  type Watch = (request: IDBRequest, next: (value: unknown) => void) => void;
  function run<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore, watch: Watch, finish: (value: T) => void) => void): Promise<T> {
    return new Promise((resolve, reject) => {
      if (closed) { reject(new JournalError('closed')); return; }
      let tx: IDBTransaction;
      try { tx = db.transaction(storeName, mode, { durability: 'strict' }); }
      catch { reject(new JournalError('storage_error')); return; }
      let result: T, finished = false, failure: JournalError | undefined;
      const abort = (error: unknown) => {
        failure = error instanceof JournalError ? error : new JournalError('storage_error');
        try { tx.abort(); } catch { reject(failure); }
      };
      // Request success is tentative. Only transaction completion publishes the result.
      tx.oncomplete = () => finished ? resolve(result) : reject(new JournalError('storage_error'));
      tx.onabort = () => reject(failure ?? new JournalError('storage_error'));
      const watch: Watch = (request, next) => {
        request.onsuccess = () => { try { next(request.result); } catch (error) { abort(error); } };
        // Native request errors abort the transaction; onabort is the rejection boundary.
      };
      try { action(tx.objectStore(storeName), watch, value => { result = value; finished = true; }); }
      catch (error) { abort(error); }
    });
  }
  function byId(store: IDBObjectStore, watch: Watch, requestId: string, next: (value: DonationJournalRecord | null) => void) {
    watch(store.get(requestId), value => {
      const retained = value === undefined ? null : record(value);
      check(!retained || retained.requestId === requestId, 'invalid_record');
      next(retained);
    });
  }
  return Object.freeze({
    async acquire(scope: string, requestId: string, intent: string) {
      check(text(scope, 4096) && uuid(requestId) && text(intent, maxPayload), 'invalid_argument');
      return run<Readonly<{ acquired: boolean; record: DonationJournalRecord }>>('readwrite', (store, watch, finish) => {
        byId(store, watch, requestId, existing => {
          if (existing) {
            check(existing.scope === scope && existing.intent === intent, 'conflict');
            finish(Object.freeze({ acquired: false, record: existing }));
            return;
          }
          watch(store.index('scope').get(scope), value => {
            if (value !== undefined) {
              const retained = record(value);
              check(retained.scope === scope, 'invalid_record');
              finish(Object.freeze({ acquired: false, record: retained }));
            } else {
              const retained = record({ scope, requestId, intent, state: 'intent' });
              store.add(retained);
              finish(Object.freeze({ acquired: true, record: retained }));
            }
          });
        });
      });
    },
    async read(requestId: string) {
      check(uuid(requestId), 'invalid_argument');
      return run<DonationJournalRecord | null>('readonly', (store, watch, finish) => byId(store, watch, requestId, finish));
    },
    async saveSigned(requestId: string, expectedIntent: string, signed: string) {
      check(uuid(requestId) && text(expectedIntent, maxPayload) && text(signed, maxPayload), 'invalid_argument');
      return run<DonationJournalRecord>('readwrite', (store, watch, finish) => {
        byId(store, watch, requestId, retained => {
          check(retained, 'not_found');
          check(retained.intent === expectedIntent, 'guard_mismatch');
          if (retained.state !== 'intent') {
            check(retained.signed === signed, 'conflict');
            finish(retained); // Idempotency never downgrades a claimed record.
          } else {
            const updated = record({ ...retained, state: 'signed', signed });
            store.put(updated);
            finish(updated);
          }
        });
      });
    },
    async claimSubmission(requestId: string, expectedSigned: string) {
      check(uuid(requestId) && text(expectedSigned, maxPayload), 'invalid_argument');
      return run<Readonly<{ claimed: boolean; record: DonationJournalRecord }>>('readwrite', (store, watch, finish) => {
        byId(store, watch, requestId, retained => {
          check(retained, 'not_found');
          check(retained.state !== 'intent', 'invalid_state');
          check(retained.signed === expectedSigned, 'guard_mismatch');
          const claimed = retained.state === 'signed';
          const updated = claimed ? record({ ...retained, state: 'submission_claimed' }) : retained;
          if (claimed) store.put(updated);
          finish(Object.freeze({ claimed, record: updated }));
        });
      });
    },
    close,
  });
}
/** Version 1, persistent IndexedDB only. No migration, fallback, wallet interaction or transmission. */
export async function openDonationJournal(factory: IDBFactory, name: string): Promise<DonationJournal> {
  check(text(name, 256), 'invalid_argument');
  check(factory && typeof factory.open === 'function', 'unavailable');
  return new Promise((resolve, reject) => {
    let failed = false;
    const fail = (code: string) => { failed = true; reject(new JournalError(code)); };
    let request: IDBOpenDBRequest;
    try { request = factory.open(name, 1); } catch { fail('open_failed'); return; }
    request.onblocked = () => fail('blocked');
    request.onerror = () => fail('open_failed');
    request.onupgradeneeded = event => {
      if (failed) { request.transaction?.abort(); return; }
      try {
        check(event.oldVersion === 0, 'open_failed');
        const store = request.result.createObjectStore(storeName, { keyPath: 'requestId' });
        store.createIndex('scope', 'scope', { unique: true });
      } catch { fail('open_failed'); request.transaction?.abort(); }
    };
    request.onsuccess = () => {
      const db = request.result;
      if (failed) { db.close(); return; }
      try {
        check(db.version === 1 && db.objectStoreNames.length === 1 && db.objectStoreNames.contains(storeName), 'open_failed');
        const store = db.transaction(storeName, 'readonly').objectStore(storeName);
        check(store.keyPath === 'requestId' && !store.autoIncrement && store.indexNames.length === 1, 'open_failed');
        const index = store.index('scope');
        check(index.keyPath === 'scope' && index.unique && !index.multiEntry, 'open_failed');
        resolve(connection(db));
      } catch { db.close(); fail('open_failed'); }
    };
  });
}
