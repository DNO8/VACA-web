import { test, expect } from '@playwright/test';
import { createPrivateKey, createPublicKey, createHash, sign } from 'node:crypto';
import { StrKey, Keypair } from '@stellar/stellar-sdk';
import { validateRefundExecutionAttempt as validate } from '../../src/lib/d1/refund-submission-preflight';
import { signRefundCommand } from '../../src/lib/d1/refund-commands';

// S1-S3/S17, T5-P only: synthetic identity/lane are not authority.
const key = createPrivateKey({ key: Buffer.concat([
  Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, 37),
]), format: 'der', type: 'pkcs8' });
const wallet = StrKey.encodeEd25519PublicKey(createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32));
const pool = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 13));
const id = { network: 'TESTNET', namespace: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', pool,
  request_id: '12345678-1234-1234-1234-123456789abc' };
const config = { network: 'TESTNET', namespace: id.namespace, pool_public_key: pool, donation_ttl_seconds: 300 };
const now = 1800000000;
function command(version = 1) {
  return { ...id, version, action: version === 1 ? 'refund' : 'refund_remainder', timestamp: now, payload: {}, wallet };
}
function proof(c: object, prefix = 'Stellar Signed Message:\n') {
  const message = JSON.stringify(c, Object.keys(c).sort());
  return sign(null, createHash('sha256').update(prefix + message).digest(), key).toString('base64');
}
function body(c = command()) { return JSON.stringify({ ...c, signature: proof(c) }); }
function reject(b: unknown, error: string, identity: unknown = id, clock = () => now) {
  const before = JSON.stringify({ config, id, b, identity });
  expect(() => validate(config, b, identity, clock)).toThrow(new Error(error));
  expect(JSON.stringify({ config, id, b, identity })).toBe(before);
}

test('independent SEP53 oracle, exact bytes, both lanes, signer seam and no IO', async () => {
  for (const version of [1, 2]) {
    const c = command(version); const retained = ' \n' + JSON.stringify({ signature: proof(c), ...c }, null, 2) + '\t';
    const originalFetch = globalThis.fetch; const originalSign = Keypair.prototype.sign;
    let calls = 0; let result: ReturnType<typeof validate>;
    try {
      globalThis.fetch = (() => { calls++; throw new Error('network'); }) as typeof fetch;
      Keypair.prototype.sign = () => { calls++; throw new Error('signing'); };
      result = validate(config, retained, id, () => now);
    } finally { globalThis.fetch = originalFetch; Keypair.prototype.sign = originalSign; }
    expect(calls).toBe(0); expect(result!.attempt.signedBody).toBe(retained);
    expect(result!.identity).toEqual(id); expect(result!.identity).not.toBe(id);
    expect([result!, result!.identity, result!.attempt].every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(config)).toBe(false); expect(Object.isFrozen(id)).toBe(false);
    expect(Object.keys(result!).sort()).toEqual(['attempt', 'identity']);
    const signed = await signRefundCommand(config, c, async message => ({ signerAddress: wallet,
      signedMessage: sign(null, createHash('sha256').update('Stellar Signed Message:\n' + message).digest(), key).toString('base64') }), () => now);
    expect(validate(config, JSON.stringify(signed), id, () => now).attempt.version).toBe(version);
  }
});

test('identity, signature encoding, tampering and unsupported execution reject exactly', () => {
  for (const field of Object.keys(id)) reject(body(), 'd1_refund_attempt_mismatch', { ...id, [field]: 'different' });
  const c = command(); const sig = proof(c);
  for (const signature of [sig.slice(0, -2), sig + '\n', 'A'.repeat(86) + '==', proof(c, ''),
    sig.slice(0, 85) + 'B==']) reject(JSON.stringify({ ...c, signature }), 'd1_invalid_signature');
  reject(JSON.stringify({ ...c, timestamp: now + 1, signature: sig }), 'd1_invalid_signature');
  for (const action of ['refund_status', 'refund_reconcile']) reject(body({ ...c, action }), 'd1_invalid_refund_attempt');
  reject(body({ ...c, version: 2 }), 'd1_invalid_refund_command');
  reject(body({ ...c, payload: { extra: true } } as typeof c), 'd1_invalid_refund_command');
  for (const bad of ['', '{', 'null', '[]', '{}', body().replace('{', '{"extra":1,')]) reject(bad, 'd1_invalid_refund_attempt');
  reject(body(), 'd1_invalid_refund_attempt', { ...id, extra: 1 });
  let getterCalls = 0;
  const accessor = { ...id }; Object.defineProperty(accessor, 'pool', { enumerable: true, get() { getterCalls++; return pool; } });
  expect(() => validate(config, body(), accessor, () => now)).toThrow(new Error('d1_invalid_refund_attempt'));
  expect(getterCalls).toBe(0);
});

test('duplicate escaped names, exact UTF8 bound and before/after freshness', () => {
  const b = body();
  for (const name of ['wallet', '\\u0077allet']) reject(b.replace('{', '{"' + name + '":"' + wallet + '",'), 'd1_invalid_refund_attempt');
  const padded = b + ' '.repeat(8192 - Buffer.byteLength(b));
  expect(validate(config, padded, id, () => now).attempt.signedBody).toBe(padded);
  reject(padded + ' ', 'd1_invalid_refund_attempt');
  // JSON permits escaped root names; spell a name with escapes without altering its semantic value.
  const escaped = b.replace('"wallet"', '"\\u0077allet"');
  expect(validate(config, escaped, id, () => now).attempt.signedBody).toBe(escaped);
  reject(b + 'é'.repeat(4096), 'd1_invalid_refund_attempt');
  for (const delta of [-60, 60]) expect(validate(config, b, id, () => now + delta).identity).toEqual(id);
  for (const delta of [-61, 61]) reject(b, 'd1_stale_refund_command', id, () => now + delta);
  let reads = 0; reject(b, 'd1_stale_refund_command', id, () => now + (reads++ ? 61 : 0));
  expect(reads).toBe(2);
  const mutable = { ...id }; const result = validate(config, b, mutable, () => { mutable.request_id = 'changed'; return now; });
  expect(result.identity).toEqual(id); expect(mutable.request_id).toBe('changed');
});
