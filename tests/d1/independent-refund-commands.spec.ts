import { test, expect } from '@playwright/test';
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { Keypair } from '@stellar/stellar-sdk';
import { buildRefundCommand, validateRefundCommand, signRefundCommand, type RefundInput } from '../../src/lib/d1/refund-commands';

// S1-S3/S17: public API only; independent synthetic signing oracle.
const seed = Buffer.alloc(32, 91);
const wallet = Keypair.fromRawEd25519Seed(seed).publicKey();
const pool = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 92)).publicKey();
const id = '11111111-2222-3333-4444-555555555555';
const ns = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const config = { network: 'TESTNET', pool_public_key: pool, namespace: ns, donation_ttl_seconds: 300 };
const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
const proof = (raw: string) => sign(null, createHash('sha256').update('Stellar Signed Message:\n' + raw).digest(), key);
const input = (): RefundInput => ({ version: 1, action: 'refund', request_id: id, timestamp: 60, payload: {}, wallet });
const lanes = [[1, 'refund_status'], [1, 'refund'], [1, 'refund_reconcile'], [2, 'refund_remainder_status'], [2, 'refund_remainder'], [2, 'refund_remainder_reconcile']] as const;

test('S17: six exact wire proofs cannot be replayed across original reference or config', async () => {
  for (const [version, action] of lanes) {
    const command = buildRefundCommand(config, { ...input(), version, action } as RefundInput, () => 0);
    const raw = JSON.stringify({ action, namespace: ns, network: 'TESTNET', payload: {}, pool, request_id: id, timestamp: 60, version, wallet });
    let calls = 0;
    const signed = await signRefundCommand(config, command, async (message, options) => {
      calls++;
      expect(message).toBe(raw);
      expect(options).toEqual({ address: wallet, networkPassphrase: 'Test SDF Network ; September 2015' });
      return { signerAddress: wallet, signedMessage: proof(raw).toString('base64') };
    }, () => 120);
    expect(calls).toBe(1);
    expect(signed).toEqual({ ...command, signature: proof(raw).toString('base64') });
    expect(Object.keys(signed).sort()).toEqual(['action', 'namespace', 'network', 'payload', 'pool', 'request_id', 'signature', 'timestamp', 'version', 'wallet']);
    expect(Buffer.byteLength(JSON.stringify(signed))).toBeLessThanOrEqual(8192);
    for (const [settings, altered] of [
      [config, { ...command, request_id: ns }],
      [{ ...config, namespace: id }, { ...command, namespace: id }],
      [{ ...config, pool_public_key: wallet }, { ...command, pool: wallet }],
    ] as const) {
      let attempts = 0;
      await expect(signRefundCommand(settings, altered, async () => {
        attempts++; return { signerAddress: wallet, signedMessage: proof(raw) };
      }, () => 60)).rejects.toThrow(/^d1_invalid_signature$/);
      expect(attempts).toBe(1);
    }
  }
});

test('S17: validation entry paths reject explicit extras and malformed data before signing', async () => {
  const command = buildRefundCommand(config, input(), () => 60);
  const bad = [
    { ...command, payload: { destination: wallet } },
    { ...command, payload: { memo: 'x'.repeat(8192) } },
    { ...command, payload: [] }, { ...command, request_id: '' },
    { ...command, timestamp: -1 }, { ...command, timestamp: 0.5 },
    { ...command, version: 2 }, { ...command, action: 'refund-reconcile' },
    { ...command, signature: 'explicit' },
  ];
  for (const value of bad) {
    const before = JSON.stringify(value); let calls = 0;
    expect(() => validateRefundCommand(config, value, () => 60)).toThrow(/^d1_invalid_refund_command$/);
    await expect(signRefundCommand(config, value, async () => { calls++; return null; }, () => 60))
      .rejects.toThrow(/^d1_invalid_refund_command$/);
    expect(calls).toBe(0); expect(JSON.stringify(value)).toBe(before);
  }
  for (const [version, action] of lanes) {
    expect(() => buildRefundCommand(config, { ...input(), version: version === 1 ? 2 : 1, action } as RefundInput, () => 60))
      .toThrow(/^d1_invalid_refund_command$/);
  }
  let reads = 0;
  const payload = Object.defineProperty({}, 'amount', { enumerable: true, get() { reads++; return '1'; } });
  expect(() => buildRefundCommand(config, { ...input(), payload }, () => 60)).toThrow(/^d1_invalid_refund_command$/);
  expect(reads).toBe(0);
  for (const now of [121, -1, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => validateRefundCommand(config, command, () => now)).toThrow(now === 121 ? /^d1_stale_refund_command$/ : /^d1_invalid_refund_command$/);
  }
  expect(buildRefundCommand(config, { ...input(), timestamp: 0 }, () => 0).timestamp).toBe(0);
});

test('S17: delayed wallet cannot renew, mutate retained identity, or cause retries', async () => {
  for (const end of [120, 121]) {
    const settings = { ...config };
    const command = { ...buildRefundCommand(config, input(), () => 60), payload: {} };
    const before = structuredClone(command);
    let now = 60; let calls = 0;
    const pending = signRefundCommand(settings, command, async raw => {
      calls++; await Promise.resolve();
      command.request_id = ns; command.timestamp = end;
      Object.assign(command.payload, { amount: '10.0000000' });
      settings.namespace = id; now = end;
      return { signerAddress: wallet, signedMessage: new Uint8Array(proof(raw)) };
    }, () => now);
    if (end === 121) await expect(pending).rejects.toThrow(/^d1_stale_refund_command$/);
    else {
      const signed = await pending;
      expect(signed).toMatchObject(before);
      expect(Object.isFrozen(signed)).toBe(true);
      expect(Object.isFrozen(signed.payload)).toBe(true);
      expect(signed.payload).not.toBe(command.payload);
    }
    expect(calls).toBe(1);
  }
  const command = buildRefundCommand(config, input(), () => 60);
  for (const error of ['d1_wallet_error', 'd1_signer_mismatch', 'd1_invalid_signature']) {
    let calls = 0;
    await expect(signRefundCommand(config, command, async raw => {
      calls++;
      if (error === 'd1_wallet_error') throw new Error('cancel');
      return { signerAddress: error === 'd1_signer_mismatch' ? pool : wallet, signedMessage: error === 'd1_invalid_signature' ? proof(raw).toString('hex') : proof(raw) };
    }, () => 60)).rejects.toThrow(new RegExp('^' + error + '$'));
    expect(calls).toBe(1);
  }
});
