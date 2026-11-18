import { test, expect } from '@playwright/test';
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { Keypair, Networks } from '@stellar/stellar-sdk';
import { buildRefundCommand, validateRefundCommand, signRefundCommand, type RefundInput } from '../../src/lib/d1/refund-commands';

// Synthetic fixtures only. Node crypto checks the SDK-based proof verification.
const seed = Buffer.alloc(32, 73);
const wallet = Keypair.fromRawEd25519Seed(seed).publicKey();
const pool = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 74)).publicKey();
const id = '01234567-89ab-cdef-0123-456789abcdef';
const namespace = 'fedcba98-7654-3210-fedc-ba9876543210';
const config = { network: 'TESTNET', pool_public_key: pool, namespace, donation_ttl_seconds: 300 };
const clock = () => 2000;
const lanes = [
  [1, 'refund_status'], [1, 'refund'], [1, 'refund_reconcile'],
  [2, 'refund_remainder_status'], [2, 'refund_remainder'], [2, 'refund_remainder_reconcile'],
] as const;
const input = (version: 1 | 2 = 1, action: string = 'refund'): RefundInput =>
  ({ version, action, request_id: id, timestamp: 2000, payload: {}, wallet }) as RefundInput;
const key = createPrivateKey({ key: Buffer.concat([
  Buffer.from('302e020100300506032b657004220420', 'hex'), seed,
]), format: 'der', type: 'pkcs8' });
const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest();
const proof = (s: string) => sign(null, digest('Stellar Signed Message:\n' + s), key);
const reply = (s: string) => ({ signerAddress: wallet, signedMessage: proof(s) });
const expectedJson = (version: number, action: string) => JSON.stringify({
  action, namespace, network: 'TESTNET', payload: {}, pool, request_id: id, timestamp: 2000, version, wallet,
});

for (const [version, action] of lanes) {
  test(`builds exact immutable original-bound ${version}/${action}`, () => {
    const value = input(version, action);
    const before = structuredClone(value);
    const command = buildRefundCommand(config, value, clock);
    expect(command).toEqual({ ...value, network: 'TESTNET', namespace, pool });
    expect(Object.keys(command).sort()).toEqual(['action', 'namespace', 'network', 'payload', 'pool', 'request_id', 'timestamp', 'version', 'wallet']);
    expect(Object.isFrozen(command)).toBe(true);
    expect(Object.isFrozen(command.payload)).toBe(true);
    expect(command.payload).not.toBe(value.payload);
    expect(value).toEqual(before);
    expect(Object.isFrozen(value)).toBe(false);
    expect(Object.isFrozen(config)).toBe(false);
    expect(validateRefundCommand(config, command, clock)).toEqual(command);
  });
}

test('rejects cross-lane actions and route paths before any wallet interaction', async () => {
  const command = buildRefundCommand(config, input(), clock);
  for (const [version, action] of [[1, 'refund_remainder'], [2, 'refund'], [1, 'refund-status'], [2, 'refund-remainder-status'], [1, 'issue'], [3, 'refund']]) {
    const bad = { ...command, version, action };
    const before = structuredClone(bad); let calls = 0;
    await expect(signRefundCommand(config, bad, async raw => { calls++; return reply(raw); }, clock))
      .rejects.toThrow(/^d1_invalid_refund_command$/);
    expect(calls).toBe(0); expect(bad).toEqual(before);
  }
});

test('rejects invalid identity, nonempty payload, extra fields and signed input without mutation or signing', async () => {
  const command = buildRefundCommand(config, input(), clock);
  const missing = { ...command } as Record<string, unknown>; delete missing.namespace;
  const badValues = [missing, { ...command, network: 'PUBLIC' }, { ...command, pool: wallet },
    { ...command, namespace: id }, { ...command, request_id: id + '\n' },
    { ...command, request_id: id.toUpperCase() }, { ...command, request_id: 'incident-1' },
    { ...command, wallet: 'S'.repeat(56) }, { ...command, payload: { amount: '1.0000000' } },
    { ...command, payload: { value: 'x'.repeat(8192) } }, { ...command, payload: [] },
    { ...command, signature: 'already-signed' }, { ...command, extra: true }];
  for (const bad of badValues) {
    const before = structuredClone(bad); let calls = 0;
    await expect(signRefundCommand(config, bad, async raw => { calls++; return reply(raw); }, clock))
      .rejects.toThrow(/^d1_invalid_refund_command$/);
    expect(calls).toBe(0); expect(bad).toEqual(before);
  }
  const extraInput = { ...input(), namespace };
  expect(() => buildRefundCommand(config, extraInput, clock)).toThrow(/^d1_invalid_refund_command$/);
  expect(() => buildRefundCommand({ ...config, network: 'PUBLIC' }, input(), clock)).toThrow(/^d1_invalid_config$/);
});

test('plain-data boundary rejects accessors, hidden fields and symbols without invoking getters', () => {
  let reads = 0;
  const accessor = { ...input() };
  Object.defineProperty(accessor, 'wallet', { enumerable: true, get() { reads++; return wallet; } });
  const hidden = Object.defineProperty({ ...input() }, 'hidden', { value: 'private' });
  const symbolic = { ...input(), [Symbol('private')]: true };
  for (const bad of [accessor, hidden, symbolic, Object.assign(Object.create({ inherited: true }), input())]) {
    expect(() => buildRefundCommand(config, bad, clock)).toThrow(/^d1_invalid_refund_command$/);
  }
  expect(reads).toBe(0);
});

test('timestamps are nonnegative safe integers with inclusive +/-60 seconds and no renewal', () => {
  for (const timestamp of [1940, 2000, 2060]) {
    expect(buildRefundCommand(config, { ...input(), timestamp }, clock).timestamp).toBe(timestamp);
  }
  expect(buildRefundCommand(config, { ...input(), timestamp: 0 }, () => 0).timestamp).toBe(0);
  for (const timestamp of [1939, 2061]) {
    expect(() => buildRefundCommand(config, { ...input(), timestamp }, clock)).toThrow(/^d1_stale_refund_command$/);
  }
  for (const timestamp of [-1, 2000.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => buildRefundCommand(config, { ...input(), timestamp }, clock)).toThrow(/^d1_invalid_refund_command$/);
  }
  for (const now of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => buildRefundCommand(config, input(), () => now)).toThrow(/^d1_invalid_refund_command$/);
  }
});

for (const [version, action] of lanes) {
  test(`signs ${version}/${action} once with raw canonical JSON and locally verified proof`, async () => {
    const command = buildRefundCommand(config, input(version, action), clock);
    for (const encoding of ['bytes', 'base64'] as const) {
      let calls = 0;
      const signed = await signRefundCommand(config, command, async (raw, options) => {
        calls++; expect(raw).toBe(expectedJson(version, action));
        expect(options).toEqual({ address: wallet, networkPassphrase: Networks.TESTNET });
        return { signerAddress: wallet, signedMessage: encoding === 'bytes' ? new Uint8Array(proof(raw)) : proof(raw).toString('base64') };
      }, clock);
      expect(calls).toBe(1);
      expect(signed).toEqual({ ...command, signature: proof(expectedJson(version, action)).toString('base64') });
      expect(Object.keys(signed)).toHaveLength(10);
      expect(Object.isFrozen(signed)).toBe(true); expect(Object.isFrozen(signed.payload)).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(signed), 'utf8')).toBeLessThanOrEqual(8192);
    }
  });
}

test('rejects proof replay across action/version and wrong signing domain with one call', async () => {
  const command = buildRefundCommand(config, input(2, 'refund_remainder'), clock);
  const wrong = [proof(expectedJson(1, 'refund')), proof(expectedJson(2, 'refund_remainder_status')),
    sign(null, digest(expectedJson(2, 'refund_remainder')), key), proof('Stellar Signed Message:\n' + expectedJson(2, 'refund_remainder'))];
  for (const signedMessage of wrong) {
    let calls = 0;
    await expect(signRefundCommand(config, command, async () => { calls++; return { signerAddress: wallet, signedMessage }; }, clock))
      .rejects.toThrow(/^d1_invalid_signature$/);
    expect(calls).toBe(1);
  }
});

test('rejects unsupported proof representations and mismatched signer without retry', async () => {
  const command = buildRefundCommand(config, input(), clock);
  const bytes = proof(expectedJson(1, 'refund'));
  for (const signedMessage of [null, bytes.toJSON(), bytes.toString('hex'), bytes.toString('base64url'),
    bytes.toString('base64') + '\n', Buffer.alloc(63), Buffer.alloc(65), Buffer.alloc(64), 123]) {
    let calls = 0;
    await expect(signRefundCommand(config, command, async () => { calls++; return { signerAddress: wallet, signedMessage }; }, clock))
      .rejects.toThrow(/^d1_invalid_signature$/);
    expect(calls).toBe(1);
  }
  await expect(signRefundCommand(config, command, async raw => ({ ...reply(raw), signerAddress: pool }), clock))
    .rejects.toThrow(/^d1_signer_mismatch$/);
});

test('wallet rejection, error result and accessor responses fail without resubmission', async () => {
  const command = buildRefundCommand(config, input(), clock);
  let reads = 0;
  const accessor = { signerAddress: wallet, get signedMessage() { reads++; return proof(expectedJson(1, 'refund')); } };
  for (const response of [null, [], { error: 'cancelled' }, { error: false }, accessor]) {
    let calls = 0;
    await expect(signRefundCommand(config, command, async () => { calls++; return response; }, clock)).rejects.toThrow(/^d1_wallet_error$/);
    expect(calls).toBe(1);
  }
  let calls = 0;
  await expect(signRefundCommand(config, command, async () => { calls++; throw new Error('private'); }, clock)).rejects.toThrow(/^d1_wallet_error$/);
  expect(calls).toBe(1); expect(reads).toBe(0);
});

test('retains original snapshot across wallet callback and rejects expired proof without resigning', async () => {
  for (const end of [1940, 2060, 1939, 2061]) {
    const command = { ...buildRefundCommand(config, input(), clock), payload: {} };
    const original = structuredClone(command); const settings = { ...config };
    let now = 2000; let calls = 0;
    const pending = signRefundCommand(settings, command, async raw => {
      calls++; await Promise.resolve(); command.request_id = namespace; command.wallet = pool;
      settings.pool_public_key = wallet; now = end;
      return reply(raw);
    }, () => now);
    if (Math.abs(end - 2000) > 60) await expect(pending).rejects.toThrow(/^d1_stale_refund_command$/);
    else expect(await pending).toEqual({ ...original, signature: proof(expectedJson(1, 'refund')).toString('base64') });
    expect(calls).toBe(1);
  }
});

test('building and signing never fetch or replace the original identity', async () => {
  const originalFetch = globalThis.fetch; let networkCalls = 0;
  globalThis.fetch = async () => { networkCalls++; throw new Error('network forbidden'); };
  try {
    const command = buildRefundCommand(config, input(), clock);
    const signed = await signRefundCommand(config, command, async raw => reply(raw), clock);
    expect(signed.request_id).toBe(id); expect(signed.timestamp).toBe(2000);
    expect(networkCalls).toBe(0);
  } finally { globalThis.fetch = originalFetch; }
});
