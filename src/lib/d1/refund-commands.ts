import { Buffer } from 'buffer';
import { hash, Keypair, Networks, StrKey } from '@stellar/stellar-sdk';
import { validateD1Config, type D1Clock } from './commands';
import type { SignMessage } from './wallet-proof';

type RefundLane =
  | { readonly version: 1; readonly action: 'refund_status' | 'refund' | 'refund_reconcile' }
  | { readonly version: 2; readonly action: 'refund_remainder_status' | 'refund_remainder' | 'refund_remainder_reconcile' };
export type RefundInput = Readonly<RefundLane & {
  request_id: string;
  timestamp: number;
  payload: Readonly<Record<string, never>>;
  wallet: string;
}>;
export type RefundCommand = Readonly<RefundInput & { network: 'TESTNET'; namespace: string; pool: string }>;
export type SignedRefundCommand = Readonly<RefundCommand & { signature: string }>;

const actions: Readonly<Record<1 | 2, readonly string[]>> = {
  1: ['refund_status', 'refund', 'refund_reconcile'],
  2: ['refund_remainder_status', 'refund_remainder', 'refund_remainder_reconcile'],
};
const inputKeys = ['version', 'action', 'request_id', 'timestamp', 'payload', 'wallet'];
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const systemClock: D1Clock = () => Math.floor(Date.now() / 1000);

function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  return Reflect.ownKeys(value).length === keys.length && keys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable && 'value' in descriptor;
  });
}

/** Validate an explicit lane and original request reference; never discover or choose a lane. */
export function validateRefundCommand(config: unknown, command: unknown, clock: D1Clock = systemClock): RefundCommand {
  const settings = validateD1Config(config);
  if (!exact(command, [...inputKeys, 'network', 'pool', 'namespace']) ||
      (command.version !== 1 && command.version !== 2) ||
      typeof command.action !== 'string' || !actions[command.version].includes(command.action) ||
      command.network !== settings.network || command.pool !== settings.pool_public_key || command.namespace !== settings.namespace ||
      typeof command.request_id !== 'string' || uuid.exec(command.request_id)?.[0] !== command.request_id ||
      typeof command.wallet !== 'string' || !StrKey.isValidEd25519PublicKey(command.wallet) ||
      !Number.isSafeInteger(command.timestamp) || (command.timestamp as number) < 0 || !exact(command.payload, [])) {
    throw new Error('d1_invalid_refund_command');
  }
  const now = clock();
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('d1_invalid_refund_command');
  if (Math.abs((command.timestamp as number) - now) > 60) throw new Error('d1_stale_refund_command');
  return Object.freeze({ ...command, payload: Object.freeze({}) }) as RefundCommand;
}

/** Caller supplies the original issuance UUID, lane, action and timestamp; no generation or renewal. */
export function buildRefundCommand(config: unknown, input: RefundInput, clock?: D1Clock): RefundCommand {
  const settings = validateD1Config(config);
  if (!exact(input, inputKeys)) throw new Error('d1_invalid_refund_command');
  return validateRefundCommand(settings, {
    ...input, network: settings.network, pool: settings.pool_public_key, namespace: settings.namespace,
  }, clock);
}

function signatureBytes(value: unknown): Buffer {
  if (value instanceof Uint8Array && value.byteLength === 64) return Buffer.from(value);
  if (typeof value === 'string' && value.length === 88 && /^[A-Za-z0-9+/]{86}==$/.test(value)) {
    const bytes = Buffer.from(value, 'base64');
    if (bytes.length === 64 && bytes.toString('base64') === value) return bytes;
  }
  throw new Error('d1_invalid_signature');
}

/** One personal proof, not authorization, submission, settlement, retry or durable storage. */
export async function signRefundCommand(
  config: unknown, command: unknown, signMessage: SignMessage, clock?: D1Clock,
): Promise<SignedRefundCommand> {
  const settings = validateD1Config(config);
  const snapshot = validateRefundCommand(settings, command, clock);
  // Payload is exactly empty: sorting these unsigned root keys is the backend's canonical JSON.
  const message = JSON.stringify(Object.fromEntries(Object.entries(snapshot).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
  let result: unknown;
  try {
    // Freighter adds the SEP-53 prefix and hashes once; send raw JSON, never a prehashed message.
    result = await signMessage(message, { address: snapshot.wallet, networkPassphrase: Networks.TESTNET });
  } catch {
    throw new Error('d1_wallet_error');
  }
  if (!result || typeof result !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(result))) {
    throw new Error('d1_wallet_error');
  }
  const fields = Object.getOwnPropertyDescriptors(result);
  for (const key of ['error', 'signerAddress', 'signedMessage']) {
    if (fields[key] && (!fields[key].enumerable || !('value' in fields[key]))) throw new Error('d1_wallet_error');
  }
  if (fields.error && fields.error.value != null) throw new Error('d1_wallet_error');
  if (fields.signerAddress?.value !== snapshot.wallet) throw new Error('d1_signer_mismatch');
  const bytes = signatureBytes(fields.signedMessage?.value);
  const digest = hash(Buffer.from('Stellar Signed Message:\n' + message, 'utf8'));
  let verified = false;
  try { verified = Keypair.fromPublicKey(snapshot.wallet).verify(digest, bytes); }
  catch { /* SDK failures cannot bypass proof verification. */ }
  if (!verified) throw new Error('d1_invalid_signature');
  validateRefundCommand(settings, snapshot, clock);
  const signed = Object.freeze({ ...snapshot, signature: bytes.toString('base64') });
  if (Buffer.byteLength(JSON.stringify(signed), 'utf8') > 8192) throw new Error('d1_invalid_refund_command');
  return signed;
}
