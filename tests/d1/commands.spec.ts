import { test, expect } from '@playwright/test';
import { Keypair } from '@stellar/stellar-sdk';
import { buildD1Command, canonicalUnsignedJson, validateD1Command, type D1Action } from '../../src/lib/d1/commands';

// Public deterministic fixtures only: never use these keys for funds.
const wallet = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1)).publicKey();
const pool = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 2)).publicKey();
const id = 'abcdef01-2345-6789-abcd-0123456789ab';
const config = { network: 'TESTNET', pool_public_key: pool, namespace: id, donation_ttl_seconds: 300 };
const payload = { incident_id: 'incident: not a UUID', transaction_hash: 'ab'.repeat(32), operation_id: '9999999999999999999', beneficiary: wallet, amount: '999999999999.1234567' };
const input = (action: D1Action = 'prepare') => ({ action, request_id: id, timestamp: 1000, wallet, payload: action === 'prepare' ? { ...payload } : {} });
const wire = (action: D1Action = 'prepare') => ({ ...input(action), version: 1, network: 'TESTNET', pool, ...(action === 'prepare' ? {} : { namespace: id }) });
const clock = () => 1000;

for (const action of ['prepare', 'issue', 'reconcile'] as const) {
  test(`${action}: exact unsigned shape, identity and immutable copy`, () => {
    const original = input(action);
    const before = JSON.stringify(original);
    const result = buildD1Command(config, original, clock);
    expect(result).toEqual(wire(action));
    expect(Object.keys(result)).toHaveLength(action === 'prepare' ? 8 : 9);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.payload)).toBe(true);
    expect(result.payload).not.toBe(original.payload);
    expect(validateD1Command(config, result, clock)).toEqual(result);
    expect(JSON.stringify(original)).toBe(before);
  });
}

test('rejects invalid/mismatched configuration without changing commands', () => {
  const command = wire();
  const before = JSON.stringify(command);
  for (const change of [{ network: 'PUBLIC' }, { pool_public_key: 'G'.repeat(56) }, { namespace: id.toUpperCase() }, { donation_ttl_seconds: 301 }, { extra: true }]) {
    expect(() => validateD1Command({ ...config, ...change }, command, clock)).toThrow(/^d1_invalid_config$/);
  }
  for (const command of [{ ...wire(), pool: wallet }, { ...wire('issue'), namespace: '00000000-0000-0000-0000-000000000000' }]) {
    expect(() => validateD1Command(config, command, clock)).toThrow(/^d1_invalid_command$/);
  }
  expect(JSON.stringify(command)).toBe(before);
});

test('rejects extra/missing fields, wrong types and noncanonical identity', () => {
  const changes = [{ version: 2 }, { network: 'PUBLIC' }, { action: 'other' }, { request_id: id.toUpperCase() }, { request_id: 'id' }, { wallet: 'G'.repeat(56) }, { namespace: id }, { signature: 'proof' }, { extra: 1 }, { pool: undefined }, { timestamp: '1000' }];
  for (const change of changes) expect(() => validateD1Command(config, { ...wire(), ...change }, clock)).toThrow(/^d1_invalid_command$/);
  for (const action of ['issue', 'reconcile'] as const) {
    expect(() => validateD1Command(config, { ...wire(action), payload }, clock)).toThrow(/^d1_invalid_command$/);
    expect(() => validateD1Command(config, { ...wire(action), namespace: undefined }, clock)).toThrow(/^d1_invalid_command$/);
  }
  expect(() => buildD1Command(config, { ...input(), extra: true } as ReturnType<typeof input>, clock)).toThrow(/^d1_invalid_command$/);
});

test('preserves precision and accepts exact payload boundaries', () => {
  for (const change of [{ incident_id: 'x' }, { incident_id: 'x'.repeat(256) }, { incident_id: 'a ~ b' }, { operation_id: '1' }, { amount: '0.0000000' }, { amount: '1.0000001' }, {}]) {
    const expected = { ...payload, ...change };
    expect(buildD1Command(config, { ...input(), payload: expected }, clock).payload).toEqual(expected);
  }
});

test('rejects every malformed payload field without normalization', () => {
  const invalid = {
    incident_id: ['', ' x', 'x ', 'x\n', '\tx', 'x'.repeat(257), 'é', 'x\u007f', 1],
    transaction_hash: ['AB'.repeat(32), 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), 'ab'.repeat(32) + '\n'],
    operation_id: ['0', '01', '-1', '1.0', '1e2', '1'.repeat(20), '1\n', 1],
    amount: ['1', '01.0000000', '-1.0000000', '1.000000', '1.00000000', '1000000000000.0000000', '1e2.0000000', '1.0000000\n', 1],
    beneficiary: ['G'.repeat(56), pool.toLowerCase(), 1],
  };
  for (const [key, values] of Object.entries(invalid)) {
    for (const value of values) expect(() => validateD1Command(config, { ...wire(), payload: { ...payload, [key]: value } }, clock)).toThrow(/^d1_invalid_command$/);
  }
  for (const value of [null, [], {}, { ...payload, extra: '' }, { ...payload, amount: undefined }]) {
    expect(() => validateD1Command(config, { ...wire(), payload: value }, clock)).toThrow(/^d1_invalid_command$/);
  }
});

test('inclusive 60-second window, safe integer timestamp and injected clock', () => {
  for (const timestamp of [940, 1000, 1060]) expect(buildD1Command(config, { ...input(), timestamp }, clock).timestamp).toBe(timestamp);
  for (const timestamp of [939, 1061]) expect(() => buildD1Command(config, { ...input(), timestamp }, clock)).toThrow(/^d1_stale_command$/);
  for (const timestamp of [NaN, Infinity, 1000.5, Number.MAX_SAFE_INTEGER + 1]) expect(() => buildD1Command(config, { ...input(), timestamp }, clock)).toThrow(/^d1_invalid_command$/);
  expect(() => buildD1Command(config, input(), () => NaN)).toThrow(/^d1_invalid_command$/);
  const timestamp = Math.floor(Date.now() / 1000);
  expect(buildD1Command(config, { ...input(), timestamp }).timestamp).toBe(timestamp);
});

test('canonical unsigned bytes sort nested keys, escape strings and omit signature', () => {
  const command = buildD1Command(config, { ...input(), payload: { ...payload, incident_id: 'a"\\b' } }, clock);
  const expected = `{"action":"prepare","network":"TESTNET","payload":{"amount":"999999999999.1234567","beneficiary":"${wallet}","incident_id":"a\\"\\\\b","operation_id":"9999999999999999999","transaction_hash":"${payload.transaction_hash}"},"pool":"${pool}","request_id":"${id}","timestamp":1000,"version":1,"wallet":"${wallet}"}`;
  expect(canonicalUnsignedJson(command)).toBe(expected);
  expect(canonicalUnsignedJson({ ...command, signature: 'excluded' } as typeof command)).toBe(expected);
});
