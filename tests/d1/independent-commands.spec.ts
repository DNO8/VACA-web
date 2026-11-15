import { test, expect } from '@playwright/test';
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { Keypair, Networks } from '@stellar/stellar-sdk';
import { buildD1Command, canonicalUnsignedJson, type D1Command } from '../../src/lib/d1/commands';
import { signD1Command } from '../../src/lib/d1/wallet-proof';

// Public synthetic fixtures; Node crypto provides an independent signing oracle.
const seed = Buffer.alloc(32, 37);
const wallet = Keypair.fromRawEd25519Seed(seed).publicKey();
const pool = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 38)).publicKey();
const privateKey = createPrivateKey({ key: Buffer.concat([
  Buffer.from('302e020100300506032b657004220420', 'hex'), seed,
]), format: 'der', type: 'pkcs8' });
const id = '01234567-89ab-cdef-0123-456789abcdef';
const config = { network: 'TESTNET', pool_public_key: pool, namespace: id, donation_ttl_seconds: 300 };
const payload = { incident_id: 'a"\\z', transaction_hash: '09'.repeat(32), operation_id: '1234567890123456789', beneficiary: wallet, amount: '123456789012.3456789' };
const input = (action: 'prepare' | 'issue' | 'reconcile' = 'prepare') => ({ action, request_id: id, timestamp: 2000, wallet, payload: action === 'prepare' ? { ...payload } : {} });
const clock = () => 2000;
const digest = (s: string) => createHash('sha256').update(s).digest();
const proof = (s: string) => sign(null, digest('Stellar Signed Message:\n' + s), privateKey);
const reply = (s: string) => ({ signerAddress: wallet, signedMessage: proof(s) });
const fingerprint = (v: unknown) => digest(JSON.stringify(v)).toString('hex');

 test('independent exact wire bytes and Ed25519 oracle for all actions', async () => {
  for (const action of ['prepare', 'issue', 'reconcile'] as const) {
    const command = buildD1Command(config, input(action), clock);
    const expected = JSON.stringify({ action, ...(action === 'prepare' ? {} : { namespace: id }), network: 'TESTNET',
      payload: action === 'prepare' ? { amount: payload.amount, beneficiary: wallet, incident_id: payload.incident_id, operation_id: payload.operation_id, transaction_hash: payload.transaction_hash } : {},
      pool, request_id: id, timestamp: 2000, version: 1, wallet });
    let calls = 0;
    for (const encoding of ['bytes', 'base64'] as const) {
      const signed = await signD1Command(config, command, async (raw, options) => {
        calls++; expect(raw).toBe(expected);
        expect(options).toEqual({ address: wallet, networkPassphrase: Networks.TESTNET });
        return { signerAddress: wallet, signedMessage: encoding === 'bytes' ? new Uint8Array(proof(raw)) : proof(raw).toString('base64') };
      }, clock);
      expect(Object.keys(command)).toHaveLength(action === 'prepare' ? 8 : 9);
      expect(Object.keys(signed)).toHaveLength(action === 'prepare' ? 9 : 10);
      expect(signed).toEqual({ ...command, signature: proof(expected).toString('base64') });
      expect(canonicalUnsignedJson(signed)).toBe(expected);
    }
    expect(calls).toBe(2);
  }
});

test('boundary acceptance and rejection leave caller bytes unchanged with zero wallet calls', async () => {
  for (const timestamp of [1940, 2060]) {
    expect(buildD1Command(config, { ...input(), timestamp }, clock).timestamp).toBe(timestamp);
  }
  for (const change of [{ incident_id: '!' }, { incident_id: '~'.repeat(256) }, { amount: '0.0000000' }, { operation_id: '1' }]) {
    expect(buildD1Command(config, { ...input(), payload: { ...payload, ...change } }, clock).payload).toEqual({ ...payload, ...change });
  }
  const good = buildD1Command(config, input(), clock);
  const bad: Array<[unknown, unknown, string]> = [
    [{ ...config, namespace: id.toUpperCase() }, good, 'd1_invalid_config'],
    [config, { ...good, timestamp: 1939 }, 'd1_stale_command'],
    [config, { ...good, timestamp: 2061 }, 'd1_stale_command'],
    [config, { ...good, namespace: id }, 'd1_invalid_command'],
    [config, { ...good, request_id: id + '\n' }, 'd1_invalid_command'],
    [config, { ...good, timestamp: 2000.1 }, 'd1_invalid_command'],
    [config, { ...good, pool: wallet }, 'd1_invalid_command'],
  ];
  for (const change of [{ incident_id: '' }, { incident_id: 'x '.repeat(129) }, { incident_id: '\tx' }, { transaction_hash: 'AB'.repeat(32) }, { operation_id: '00' }, { operation_id: 1 }, { amount: '01.0000000' }, { amount: 1 }, { beneficiary: wallet.toLowerCase() }, { extra: '' }]) {
    bad.push([config, { ...good, payload: { ...payload, ...change } }, 'd1_invalid_command']);
  }
  for (const [settings, command, error] of bad) {
    const before = fingerprint([settings, command]); let calls = 0;
    await expect(signD1Command(settings, command, async raw => { calls++; return reply(raw); }, clock)).rejects.toThrow(new RegExp(`^${error}$`));
    expect(calls).toBe(0); expect(fingerprint([settings, command])).toBe(before);
  }
});

test('wrong signing domain, unsupported proofs and callback errors fail once', async () => {
  const command = buildD1Command(config, input(), clock);
  const cases: Array<[string, (raw: string) => unknown]> = [
    ['d1_invalid_signature', raw => ({ ...reply(raw), signedMessage: sign(null, digest(raw), privateKey) })],
    ['d1_invalid_signature', raw => ({ ...reply(raw), signedMessage: proof('Stellar Signed Message:\n' + raw) })],
    ['d1_invalid_signature', raw => ({ ...reply(raw), signedMessage: proof(raw).toJSON() })],
    ['d1_invalid_signature', raw => ({ ...reply(raw), signedMessage: proof(raw).toString('base64') + '\n' })],
    ['d1_signer_mismatch', raw => ({ ...reply(raw), signerAddress: pool })],
    ['d1_wallet_error', raw => ({ ...reply(raw), error: false })],
    ['d1_wallet_error', () => { throw new Error('cancel'); }],
  ];
  for (const [error, response] of cases) {
    const before = fingerprint(command); let calls = 0;
    await expect(signD1Command(config, command, async raw => { calls++; return response(raw); }, clock)).rejects.toThrow(new RegExp(`^${error}$`));
    expect(calls).toBe(1); expect(fingerprint(command)).toBe(before);
  }
});

test('snapshot survives caller edits; post-wallet +/-60 boundary never renews identity', async () => {
  for (const end of [1940, 2060, 1939, 2061]) {
    const command = { ...buildD1Command(config, input(), clock), payload: { ...payload } };
    const original = structuredClone(command); const settings = { ...config };
    let now = 2000; let calls = 0;
    const pending = signD1Command(settings, command, async raw => {
      calls++; await Promise.resolve(); command.payload.amount = '9.0000000';
      command.wallet = pool; settings.pool_public_key = wallet; now = end;
      return reply(raw);
    }, () => now);
    if (Math.abs(end - 2000) > 60) await expect(pending).rejects.toThrow(/^d1_stale_command$/);
    else {
      const signed = await pending;
      expect(signed).toEqual({ ...original, signature: proof(canonicalUnsignedJson(original)).toString('base64') });
      expect(Object.isFrozen(signed.payload)).toBe(true);
    }
    expect(calls).toBe(1);
  }
});

test('serializer sorts objects inside arrays without reordering or stripping nested signature', () => {
  const value = { z: [{ z: 2, a: 1 }, 0], a: { signature: 'keep', a: 3 }, signature: 'omit' };
  expect(canonicalUnsignedJson(value as unknown as D1Command)).toBe('{"a":{"a":3,"signature":"keep"},"z":[{"a":1,"z":2},0]}');
});
