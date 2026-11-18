import { test, expect } from '@playwright/test';
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { Keypair } from '@stellar/stellar-sdk';
import { buildRefundCommand, signRefundCommand } from '../../src/lib/d1/refund-commands';
import { validateRefundExecutionAttempt as preflight } from '../../src/lib/d1/refund-submission-preflight';

// Synthetic identity and explicit lanes are test assumptions, not authenticated provenance.
const seed = Buffer.alloc(32, 81);
const wallet = Keypair.fromRawEd25519Seed(seed).publicKey();
const pool = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 82)).publicKey();
const namespace = 'fedcba98-7654-3210-fedc-ba9876543210';
const request_id = '01234567-89ab-cdef-0123-456789abcdef';
const config = { network: 'TESTNET', pool_public_key: pool, namespace, donation_ttl_seconds: 300 };
const identity = { network: 'TESTNET', namespace, pool, request_id };
const clock = () => 2000;
const key = createPrivateKey({ key: Buffer.concat([
  Buffer.from('302e020100300506032b657004220420', 'hex'), seed,
]), format: 'der', type: 'pkcs8' });
const message = (value: Record<string, unknown>) => JSON.stringify(Object.fromEntries(
  Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
));
const proof = (raw: string) => sign(null, createHash('sha256').update('Stellar Signed Message:\n' + raw).digest(), key).toString('base64');
function envelope(changes: Record<string, unknown> = {}) {
  const unsigned = { version: 1, action: 'refund', network: 'TESTNET', namespace, pool, request_id,
    timestamp: 2000, payload: {}, wallet, ...changes };
  return { ...unsigned, signature: proof(message(unsigned)) };
}
const body = (changes: Record<string, unknown> = {}) => JSON.stringify(envelope(changes));
const bad = (raw: unknown, error = 'd1_invalid_refund_attempt', expected: unknown = identity) =>
  expect(() => preflight(config, raw, expected, clock)).toThrow(new RegExp('^' + error + '$'));

for (const [version, action] of [[1, 'refund'], [2, 'refund_remainder']] as const) {
  test(`validates retained ${version}/${action} bytes without granting authority`, () => {
    const raw = ' \n' + JSON.stringify(envelope({ version, action }), null, 2) + '\t';
    const expected = { ...identity }; const settings = { ...config };
    const result = preflight(settings, raw, expected, clock);
    expect(result).toEqual({ identity, attempt: { version, action, signedBody: raw } });
    expect(Object.keys(result)).toEqual(['identity', 'attempt']);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.identity)).toBe(true); expect(Object.isFrozen(result.attempt)).toBe(true);
    expect(result.identity).not.toBe(expected); expect(expected).toEqual(identity); expect(settings).toEqual(config);
    expect(Object.isFrozen(expected)).toBe(false); expect(Object.isFrozen(settings)).toBe(false);
  });
}

test('accepts unchanged existing signer output without requesting another proof', async () => {
  const command = buildRefundCommand(config, { version: 1, action: 'refund', request_id, timestamp: 2000, payload: {}, wallet }, clock);
  let calls = 0;
  const signed = await signRefundCommand(config, command, async raw => {
    calls++; return { signerAddress: wallet, signedMessage: proof(raw) };
  }, clock);
  const raw = JSON.stringify(signed);
  expect(preflight(config, raw, identity, clock).attempt.signedBody).toBe(raw);
  expect(calls).toBe(1); expect(signed.request_id).toBe(request_id); expect(signed.timestamp).toBe(2000);
});

test('rejects malformed or non-string envelopes and wrong exact field sets', () => {
  const missing = { ...envelope() } as Record<string, unknown>; delete missing.signature;
  for (const raw of [null, undefined, 1, {}, '', '{', 'null', '[]', '{}', JSON.stringify(missing),
    JSON.stringify({ ...envelope(), extra: true }), body() + '{}']) bad(raw);
});

test('rejects duplicate root keys including escaped spelling without interpreting a different attempt', () => {
  for (const field of ['"version":1,', '"ver\\u0073ion":1,', '"version":2,']) {
    bad('{' + field + body().slice(1));
  }
});

test('rejects read/reconcile and crossed version/action pairs rather than choosing a lane', () => {
  for (const [version, action] of [[1, 'refund_status'], [1, 'refund_reconcile'], [2, 'refund_remainder_status'], [2, 'refund_remainder_reconcile']]) {
    bad(body({ version, action }));
  }
  for (const [version, action] of [[1, 'refund_remainder'], [2, 'refund'], [3, 'refund'], [1, '/refund']]) {
    bad(body({ version, action }), 'd1_invalid_refund_command');
  }
});

test('rejects deployment mismatch, malformed unsigned fields and nonempty payload', () => {
  for (const changes of [{ network: 'PUBLIC' }, { namespace: request_id }, { pool: wallet },
    { payload: { amount: '1.0000000' } }, { payload: [] }, { request_id: 'incident-1' },
    { wallet: 'S'.repeat(56) }, { timestamp: -1 }, { timestamp: 2000.5 }]) {
    bad(body(changes), 'd1_invalid_refund_command');
  }
  expect(() => preflight({ ...config, network: 'PUBLIC' }, body(), identity, clock)).toThrow(/^d1_invalid_config$/);
});

test('requires every original-identity field to match without mutating the caller context', () => {
  for (const changed of [{ network: 'PUBLIC' }, { namespace: request_id }, { pool: wallet }, { request_id: namespace }]) {
    const expected = { ...identity, ...changed }; const before = structuredClone(expected);
    bad(body(), 'd1_refund_attempt_mismatch', expected); expect(expected).toEqual(before);
  }
});

test('rejects non-data identity shapes without invoking accessors', () => {
  let reads = 0;
  const accessor = Object.defineProperty({ ...identity }, 'request_id', { enumerable: true, get() { reads++; return request_id; } });
  for (const expected of [null, [], { ...identity, extra: true }, { pool }, accessor,
    Object.defineProperty({ ...identity }, 'hidden', { value: 1 }), { ...identity, [Symbol('hidden')]: 1 },
    Object.assign(Object.create({ inherited: true }), identity)]) bad(body(), 'd1_invalid_refund_attempt', expected);
  expect(reads).toBe(0);
});

test('verifies canonical SEP-53 signature and claimed signer without normalizing invalid encodings', () => {
  const value = envelope();
  const unsigned = { ...value } as Record<string, unknown>; delete unsigned.signature;
  const wrongDomain = sign(null, createHash('sha256').update(message(unsigned)).digest(), key).toString('base64');
  for (const signature of [null, 1, '', value.signature + '\n', value.signature.slice(0, -2),
    Buffer.alloc(64).toString('base64'), wrongDomain, envelope({ action: 'refund_status' }).signature,
    envelope({ version: 2, action: 'refund_remainder' }).signature]) {
    bad(JSON.stringify({ ...value, signature }), 'd1_invalid_signature');
  }
  bad(body({ wallet: pool }), 'd1_invalid_signature');
  bad(JSON.stringify({ ...value, request_id: namespace }), 'd1_invalid_signature', { ...identity, request_id: namespace });
});

test('honors inclusive freshness boundaries and rejects expiration before return without renewal', () => {
  const raw = body();
  for (const now of [1940, 2060]) expect(preflight(config, raw, identity, () => now).attempt.signedBody).toBe(raw);
  for (const now of [1939, 2061]) expect(() => preflight(config, raw, identity, () => now)).toThrow(/^d1_stale_refund_command$/);
  for (const now of [-1, 0.5, NaN, Infinity]) expect(() => preflight(config, raw, identity, () => now)).toThrow(/^d1_invalid_refund_command$/);
  let checks = 0;
  expect(() => preflight(config, raw, identity, () => ++checks === 1 ? 2000 : 2061)).toThrow(/^d1_stale_refund_command$/);
  expect(checks).toBe(2);
});

test('retains exactly bounded body bytes and rejects oversized UTF-8 input', () => {
  const raw = body(); const boundary = raw + ' '.repeat(8192 - Buffer.byteLength(raw, 'utf8'));
  expect(Buffer.byteLength(boundary, 'utf8')).toBe(8192);
  expect(preflight(config, boundary, identity, clock).attempt.signedBody).toBe(boundary);
  bad(boundary + ' '); bad('€'.repeat(3000));
});

test('snapshots expected identity before an injected clock can mutate its caller object', () => {
  const expected = { ...identity };
  const result = preflight(config, body(), expected, () => { expected.request_id = namespace; return 2000; });
  expect(result.identity).toEqual(identity); expect(expected.request_id).toBe(namespace);
});

test('has no network or storage interaction on success or rejection', () => {
  const fetch = globalThis.fetch; const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB'); let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('network forbidden'); };
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, get() { calls++; throw new Error('storage forbidden'); } });
  try { preflight(config, body(), identity, clock); bad('{}'); expect(calls).toBe(0); }
  finally { globalThis.fetch = fetch; if (descriptor) Object.defineProperty(globalThis, 'indexedDB', descriptor); else delete (globalThis as { indexedDB?: unknown }).indexedDB; }
});
