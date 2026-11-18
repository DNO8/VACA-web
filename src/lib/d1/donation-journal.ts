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
export type DonationJournalScope = Readonly<{
  record: DonationJournalRecord;
  active: boolean;
  resolution: string | null;
}>;
export interface DonationJournalV2 extends DonationJournal {
  /** One consistent readonly snapshot; null only when scope and history are absent. */
  readScope(scope: string): Promise<DonationJournalScope | null>;
  /** Opaque retained evidence, not authentication or settlement authority. */
  readResolution(requestId: string): Promise<string | null>;
}
const storeName = 'donations';
const scopeStore = 'scopes';
const resolutionStore = 'resolutions';
const journalStores = [storeName, scopeStore, resolutionStore];
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
function envelope(value: unknown, keys: string[]): Record<string, unknown> {
  check(value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype, 'invalid_record');
  check(Reflect.ownKeys(value).length === keys.length, 'invalid_record');
  const data: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    check(descriptor && 'value' in descriptor && descriptor.enumerable, 'invalid_record');
    data[key] = descriptor.value;
  }
  return data;
}
function ownership(value: unknown): Readonly<{ scope: string; requestId: string; active: boolean }> {
  const data = envelope(value, ['scope', 'requestId', 'active']);
  check(text(data.scope, 4096) && uuid(data.requestId) && typeof data.active === 'boolean', 'invalid_record');
  return Object.freeze({ scope: data.scope, requestId: data.requestId, active: data.active });
}
function resolution(value: unknown, requestId: string): string | null {
  if (value === undefined) return null;
  const data = envelope(value, ['requestId', 'evidence']);
  check(uuid(data.requestId) && data.requestId === requestId && text(data.evidence, maxPayload), 'invalid_record');
  return data.evidence;
}
function schema(tx: IDBTransaction, version: 1 | 2) {
  const names = version === 1 ? [storeName] : journalStores;
  check(tx.db.objectStoreNames.length === names.length && names.every(name => tx.db.objectStoreNames.contains(name)), 'open_failed');
  const store = tx.objectStore(storeName);
  check(store.keyPath === 'requestId' && !store.autoIncrement && store.indexNames.length === 1, 'open_failed');
  const index = store.index('scope');
  check(index.keyPath === 'scope' && index.unique === (version === 1) && !index.multiEntry, 'open_failed');
  if (version === 2) for (const name of [scopeStore, resolutionStore]) {
    const store = tx.objectStore(name);
    check(store.keyPath === (name === scopeStore ? 'scope' : 'requestId') && !store.autoIncrement && store.indexNames.length === 0, 'open_failed');
  }
}
function connection(db: IDBDatabase): DonationJournalV2 {
  let closed = false;
  const close = () => { closed = true; db.close(); };
  db.onversionchange = close;
  db.onclose = () => { closed = true; };
  type Watch = (request: IDBRequest, next: (value: unknown) => void) => void;
  function run<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore, watch: Watch, finish: (value: T) => void, tx: IDBTransaction) => void,
    names: string | string[] = storeName): Promise<T> {
    return new Promise((resolve, reject) => {
      if (closed) { reject(new JournalError('closed')); return; }
      let tx: IDBTransaction;
      try { tx = db.transaction(names, mode, { durability: 'strict' }); }
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
      try { action(tx.objectStore(storeName), watch, value => { result = value; finished = true; }, tx); }
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
  function byResolution(tx: IDBTransaction, watch: Watch, requestId: string, next: (value: string | null) => void) {
    watch(tx.objectStore(resolutionStore).get(requestId), value => next(resolution(value, requestId)));
  }
  function byScope(tx: IDBTransaction, watch: Watch, scope: string, next: (value: DonationJournalScope | null) => void) {
    watch(tx.objectStore(scopeStore).get(scope), value => {
      const owner = value === undefined ? null : ownership(value);
      check(!owner || owner.scope === scope, 'invalid_record');
      let view: DonationJournalScope | null = null;
      // Validate history too: a forged latest pointer cannot hide an unresolved predecessor.
      const cursor = tx.objectStore(storeName).index('scope').openCursor(scope);
      watch(cursor, value => {
        const entry = value as IDBCursorWithValue | null;
        if (!entry) {
          check(!owner || view, 'invalid_record');
          next(view);
          return;
        }
        const retained = record(entry.value);
        check(owner && retained.scope === scope && retained.requestId === entry.primaryKey, 'invalid_record');
        byResolution(tx, watch, retained.requestId, evidence => {
          const latest = retained.requestId === owner.requestId;
          if (latest && owner.active) check(evidence === null, 'invalid_record');
          else check(retained.state === 'submission_claimed' && evidence !== null, 'invalid_record');
          if (latest) view = Object.freeze({ record: retained, active: owner.active, resolution: evidence });
          entry.continue();
        });
      });
    });
  }
  return Object.freeze({
    async acquire(scope: string, requestId: string, intent: string) {
      check(text(scope, 4096) && uuid(requestId) && text(intent, maxPayload), 'invalid_argument');
      return run<Readonly<{ acquired: boolean; record: DonationJournalRecord }>>('readwrite', (store, watch, finish, tx) => {
        byId(store, watch, requestId, existing => {
          if (existing) check(existing.scope === scope && existing.intent === intent, 'conflict');
          byScope(tx, watch, scope, view => {
            if (existing || view?.active) {
              // A historical UUID is never assigned ownership again.
              finish(Object.freeze({ acquired: false, record: existing ?? view!.record }));
              return;
            }
            byResolution(tx, watch, requestId, evidence => {
              check(evidence === null, 'invalid_record');
              const retained = record({ scope, requestId, intent, state: 'intent' });
              store.add(retained);
              tx.objectStore(scopeStore).put(ownership({ scope, requestId, active: true }));
              finish(Object.freeze({ acquired: true, record: retained }));
            });
          });
        });
      }, journalStores);
    },
    async read(requestId: string) {
      check(uuid(requestId), 'invalid_argument');
      return run<DonationJournalRecord | null>('readonly', (store, watch, finish) => byId(store, watch, requestId, finish));
    },
    async readScope(scope: string) {
      check(text(scope, 4096), 'invalid_argument');
      return run<DonationJournalScope | null>('readonly', (_store, watch, finish, tx) => byScope(tx, watch, scope, finish), journalStores);
    },
    async readResolution(requestId: string) {
      check(uuid(requestId), 'invalid_argument');
      return run<string | null>('readonly', (store, watch, finish, tx) => {
        byId(store, watch, requestId, retained => {
          if (!retained) {
            byResolution(tx, watch, requestId, evidence => {
              check(evidence === null, 'invalid_record');
              finish(null);
            });
          } else byScope(tx, watch, retained.scope, () => byResolution(tx, watch, requestId, finish));
        });
      }, journalStores);
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
/** Persistent v2 with atomic, byte-preserving v1 migration. No resolution writer or transmission. */
export async function openDonationJournal(factory: IDBFactory, name: string): Promise<DonationJournalV2> {
  check(text(name, 256), 'invalid_argument');
  check(factory && typeof factory.open === 'function', 'unavailable');
  return new Promise((resolve, reject) => {
    let failed = false;
    const fail = (code: string) => { failed = true; reject(new JournalError(code)); };
    let request: IDBOpenDBRequest;
    try { request = factory.open(name, 2); } catch { fail('open_failed'); return; }
    request.onblocked = () => fail('blocked');
    request.onerror = () => fail('open_failed');
    request.onupgradeneeded = event => {
      const tx = request.transaction!;
      if (failed) { tx.abort(); return; }
      try {
        const db = request.result;
        check(db.version === 2 && (event.oldVersion === 0 || event.oldVersion === 1), 'open_failed');
        if (event.oldVersion === 1) schema(tx, 1);
        const store = event.oldVersion === 0 ? db.createObjectStore(storeName, { keyPath: 'requestId' }) : tx.objectStore(storeName);
        const owners = db.createObjectStore(scopeStore, { keyPath: 'scope' });
        db.createObjectStore(resolutionStore, { keyPath: 'requestId' });
        if (event.oldVersion === 1) store.deleteIndex('scope');
        store.createIndex('scope', 'scope', { unique: false });
        if (event.oldVersion === 1) {
          const cursor = store.openCursor();
          cursor.onsuccess = () => {
            try {
              const entry = cursor.result;
              if (!entry) return;
              const retained = record(entry.value);
              check(entry.primaryKey === retained.requestId, 'invalid_record');
              owners.add(ownership({ scope: retained.scope, requestId: retained.requestId, active: true }));
              entry.continue();
            } catch { tx.abort(); }
          };
        }
        // Native request errors abort the entire upgrade; onerror rejects after rollback.
      } catch { tx.abort(); }
    };
    request.onsuccess = () => {
      const db = request.result;
      if (failed) { db.close(); return; }
      try {
        check(db.version === 2, 'open_failed');
        schema(db.transaction(journalStores, 'readonly'), 2);
        resolve(connection(db));
      } catch { db.close(); fail('open_failed'); }
    };
  });
}
