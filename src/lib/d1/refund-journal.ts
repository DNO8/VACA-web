export type RefundOriginalIdentity = Readonly<{
  network: 'TESTNET'; namespace: string; pool: string; request_id: string;
}>;
export type RefundExecutionAttempt = Readonly<{
  version: 1 | 2; action: 'refund' | 'refund_remainder'; signedBody: string;
}>;
export type RefundHold = Readonly<{ identity: RefundOriginalIdentity; attempt: RefundExecutionAttempt }>;
export interface RefundJournal {
  read(identity: RefundOriginalIdentity): Promise<RefundHold | null>;
  claimExecution(identity: RefundOriginalIdentity, attempt: RefundExecutionAttempt): Promise<Readonly<{ claimed: boolean; hold: RefundHold }>>;
  close(): void;
}
const database = 'vaca-d1-refund-holds', storeName = 'holds';
type Code = 'invalid_argument' | 'invalid_record' | 'unavailable' | 'open_failed' | 'blocked' | 'closed' | 'storage_error';
class JournalError extends Error {
  constructor(code: Code) { super(`d1_refund_journal_${code}`); }
}
function check(value: unknown, code: Code): asserts value {
  if (!value) throw new JournalError(code);
}
function fields(value: unknown, keys: string[], code: Code): Record<string, unknown> {
  check(value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value)), code);
  check(Reflect.ownKeys(value).length === keys.length, code);
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    check(descriptor?.enumerable && 'value' in descriptor, code);
    result[key] = descriptor.value;
  }
  return result;
}
const uuid = (v: unknown): v is string => typeof v === 'string' && v.length === 36 && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
function identity(value: unknown, code: Code): RefundOriginalIdentity {
  const r = fields(value, ['network', 'namespace', 'pool', 'request_id'], code);
  check(r.network === 'TESTNET' && uuid(r.namespace) && uuid(r.request_id), code);
  check(typeof r.pool === 'string' && r.pool.length === 56 && /^G[A-Z2-7]{55}$/.test(r.pool), code);
  return Object.freeze({ network: r.network, namespace: r.namespace, pool: r.pool, request_id: r.request_id });
}
function attempt(value: unknown, code: Code): RefundExecutionAttempt {
  const r = fields(value, ['version', 'action', 'signedBody'], code);
  check((r.version === 1 && r.action === 'refund') || (r.version === 2 && r.action === 'refund_remainder'), code);
  check(typeof r.signedBody === 'string' && r.signedBody.length > 0 && r.signedBody.length <= 8192
    && new TextEncoder().encode(r.signedBody).byteLength <= 8192, code);
  return Object.freeze({ version: r.version as 1 | 2, action: r.action as RefundExecutionAttempt['action'], signedBody: r.signedBody });
}
const keyOf = (i: RefundOriginalIdentity) => JSON.stringify([i.network, i.namespace, i.pool, i.request_id]);
function retained(value: unknown, expectedKey: string): RefundHold {
  const r = fields(value, ['key', 'identity', 'attempt'], 'invalid_record');
  const scope = identity(r.identity, 'invalid_record'), execution = attempt(r.attempt, 'invalid_record');
  check(r.key === expectedKey && keyOf(scope) === expectedKey, 'invalid_record');
  return Object.freeze({ identity: scope, attempt: execution });
}
function connection(db: IDBDatabase): RefundJournal {
  let closed = false;
  const close = () => { closed = true; db.close(); };
  db.onversionchange = close;
  db.onclose = () => { closed = true; };
  function run<T>(scope: RefundOriginalIdentity, execution: RefundExecutionAttempt | null): Promise<T> {
    return new Promise((resolve, reject) => {
      if (closed) { reject(new JournalError('closed')); return; }
      let tx: IDBTransaction;
      try { tx = db.transaction(storeName, execution ? 'readwrite' : 'readonly', { durability: 'strict' }); }
      catch { reject(new JournalError('storage_error')); return; }
      let result: unknown, ready = false, failure: JournalError | undefined;
      const abort = (error: unknown) => {
        failure = error instanceof JournalError ? error : new JournalError('storage_error');
        try { tx.abort(); } catch { reject(failure); }
      };
      // Insert success is tentative; only durable transaction completion grants the claim.
      tx.oncomplete = () => ready ? resolve(result as T) : reject(new JournalError('storage_error'));
      tx.onabort = () => reject(failure ?? new JournalError('storage_error'));
      try {
        const store = tx.objectStore(storeName), key = keyOf(scope), request = store.get(key);
        request.onsuccess = () => {
          try {
            const existing = request.result === undefined ? null : retained(request.result, key);
            if (!execution) result = existing;
            else {
              const hold = existing ?? Object.freeze({ identity: scope, attempt: execution });
              if (!existing) store.add({ key, identity: hold.identity, attempt: hold.attempt });
              result = Object.freeze({ claimed: existing === null, hold });
            }
            ready = true;
          } catch (error) { abort(error); }
        };
        // Native request errors abort the transaction; no error grants a fallback claim.
      } catch (error) { abort(error); }
    });
  }
  return Object.freeze({
    async read(value: RefundOriginalIdentity) {
      return run<RefundHold | null>(identity(value, 'invalid_argument'), null);
    },
    async claimExecution(value: RefundOriginalIdentity, execution: RefundExecutionAttempt) {
      return run<Readonly<{ claimed: boolean; hold: RefundHold }>>(identity(value, 'invalid_argument'), attempt(execution, 'invalid_argument'));
    },
    close,
  });
}

/** Persistence only: command authentication, eligibility and sending belong to the caller. */
export function openRefundJournal(factory: IDBFactory): Promise<RefundJournal> {
  return new Promise((resolve, reject) => {
    if (!factory) { reject(new JournalError('unavailable')); return; }
    let request: IDBOpenDBRequest, settled = false;
    const fail = (code: Code) => { if (!settled) { settled = true; reject(new JournalError(code)); } };
    try { request = factory.open(database, 1); }
    catch { fail('open_failed'); return; }
    request.onblocked = () => fail('blocked');
    request.onerror = () => fail('open_failed');
    request.onupgradeneeded = event => {
      try {
        check(!settled && event.oldVersion === 0 && request.result.objectStoreNames.length === 0, 'open_failed');
        request.result.createObjectStore(storeName, { keyPath: 'key' });
      } catch { request.transaction?.abort(); fail('open_failed'); }
    };
    request.onsuccess = () => {
      const db = request.result;
      if (settled) { db.close(); return; }
      try {
        check(db.version === 1 && db.objectStoreNames.length === 1 && db.objectStoreNames.contains(storeName), 'open_failed');
        const store = db.transaction(storeName, 'readonly').objectStore(storeName);
        check(store.keyPath === 'key' && !store.autoIncrement && store.indexNames.length === 0, 'open_failed');
        settled = true; resolve(connection(db));
      } catch { db.close(); fail('open_failed'); }
    };
  });
}
