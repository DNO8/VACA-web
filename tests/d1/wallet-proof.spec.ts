import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { Keypair, Networks } from '@stellar/stellar-sdk';
import { signD1Command, type SignMessage } from '../../src/lib/d1/wallet-proof';

// Public deterministic test keys; no wallet, network or private configuration access.
const key = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1));
const other = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 2));
const id = 'abcdef01-2345-6789-abcd-0123456789ab';
const config = { network: 'TESTNET', pool_public_key: other.publicKey(), namespace: id, donation_ttl_seconds: 300 };
const clock = () => 1000;
function command(action = 'prepare') {
  return { version: 1, network: 'TESTNET', pool: config.pool_public_key, action, request_id: id, timestamp: 1000,
    payload: action === 'prepare' ? { incident_id: 'incident-1', transaction_hash: 'ab'.repeat(32), operation_id: '9007199254740993', beneficiary: key.publicKey(), amount: '12.0000001' } : {},
    wallet: key.publicKey(), ...(action === 'prepare' ? {} : { namespace: id }) };
}
const digest = (message: string) => createHash('sha256').update('Stellar Signed Message:\n').update(message, 'utf8').digest();
const proof = (message: string) => key.sign(digest(message));
const reply = (message: string) => ({ signedMessage: proof(message), signerAddress: key.publicKey() });

for (const action of ['prepare', 'issue', 'reconcile']) {
  test(`${action}: raw canonical message, exact options and locally verified base64 proof`, async () => {
    const input = command(action);
    const before = JSON.stringify(input);
    let calls = 0;
    const expected = JSON.stringify(input, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort().map(k => [k, value[k]])) : value);
    const signed = await signD1Command(config, input, async (message, options) => {
      calls++;
      expect(options).toEqual({ address: key.publicKey(), networkPassphrase: Networks.TESTNET });
      expect(message).toBe(expected);
      return reply(message);
    }, clock);
    expect(calls).toBe(1);
    expect(signed).toEqual({ ...input, signature: proof(expected).toString('base64') });
    expect(Object.keys(signed)).toHaveLength(action === 'prepare' ? 9 : 10);
    expect(Object.isFrozen(signed)).toBe(true);
    expect(JSON.stringify(input)).toBe(before);
  });
}

test('accepts only valid bytes and canonical standard base64', async () => {
  for (const encode of [(b: Buffer) => b, (b: Buffer) => new Uint8Array(b), (b: Buffer) => b.toString('base64')]) {
    let calls = 0;
    const signed = await signD1Command(config, command(), async message => {
      calls++;
      return { ...reply(message), signedMessage: encode(proof(message)) };
    }, clock);
    expect(Buffer.from(signed.signature, 'base64')).toHaveLength(64);
    expect(calls).toBe(1);
  }
});

test('retains immutable command and configuration across asynchronous wallet interaction', async () => {
  const input = command();
  const settings = { ...config };
  const before = structuredClone(input);
  let release!: (value: unknown) => void;
  let message = '';
  const pending = signD1Command(settings, input, async raw => {
    message = raw;
    return new Promise(resolve => { release = resolve; });
  }, clock);
  input.payload.amount = '99.0000000';
  input.wallet = other.publicKey();
  input.timestamp = 1061;
  settings.pool_public_key = key.publicKey();
  release(reply(message));
  expect(await pending).toEqual({ ...before, signature: proof(message).toString('base64') });
});

test('invalid configuration/commands never call wallet or mutate input', async () => {
  let calls = 0;
  const sign: SignMessage = async message => { calls++; return reply(message); };
  const cases = [
    [config, { ...command(), namespace: id }, 'd1_invalid_command'],
    [config, { ...command(), timestamp: 939 }, 'd1_stale_command'],
    [{ ...config, network: 'PUBLIC' }, command(), 'd1_invalid_config'],
    [config, { ...command(), pool: key.publicKey() }, 'd1_invalid_command'],
  ] as const;
  for (const [settings, input, error] of cases) {
    const before = JSON.stringify(input);
    await expect(signD1Command(settings, input, sign, clock)).rejects.toThrow(new RegExp(`^${error}$`));
    expect(JSON.stringify(input)).toBe(before);
    expect(calls).toBe(0);
  }
});

test('rejects wallet errors, wrong signer/body and malformed proofs exactly once', async () => {
  const invalid: [string, (message: string) => unknown][] = [
    ['d1_wallet_error', () => { throw new Error('user rejected'); }],
    ['d1_wallet_error', message => ({ ...reply(message), error: { message: 'rejected' } })],
    ['d1_wallet_error', () => null],
    ['d1_signer_mismatch', message => ({ ...reply(message), signerAddress: other.publicKey() })],
    ['d1_signer_mismatch', message => ({ signedMessage: proof(message) })],
    ...[null, {}, [], 'arbitrary', new Uint8Array(63), new Uint8Array(65)].map(value => ['d1_invalid_signature', () => ({ signerAddress: key.publicKey(), signedMessage: value })] as [string, () => unknown]),
    ...[(b: Buffer) => b.toString('hex'), (b: Buffer) => b.toString('base64url'), (b: Buffer) => b.toString('base64') + '\n',
      (b: Buffer) => b.toString('base64').slice(0, 85) + 'B==', (b: Buffer) => b.toJSON()].map(encode =>
      ['d1_invalid_signature', (message: string) => ({ ...reply(message), signedMessage: encode(proof(message)) })] as [string, (message: string) => unknown]),
    ['d1_invalid_signature', message => ({ ...reply(message), signedMessage: other.sign(digest(message)) })],
    ['d1_invalid_signature', message => ({ ...reply(message), signedMessage: proof(message + ' ') })],
    ['d1_invalid_signature', message => ({ ...reply(message), signedMessage: key.sign(Buffer.from(message)) })],
  ];
  for (const [error, result] of invalid) {
    let calls = 0;
    const input = command();
    const before = JSON.stringify(input);
    await expect(signD1Command(config, input, async message => { calls++; return result(message); }, clock)).rejects.toThrow(new RegExp(`^${error}$`));
    expect(calls).toBe(1);
    expect(JSON.stringify(input)).toBe(before);
  }
});

test('fails closed if wallet interaction outlasts timestamp window; never refreshes or retries', async () => {
  let now = 1000;
  let calls = 0;
  await expect(signD1Command(config, command(), async message => {
    calls++;
    now = 1061;
    return reply(message);
  }, () => now)).rejects.toThrow(/^d1_stale_command$/);
  expect(calls).toBe(1);
});
