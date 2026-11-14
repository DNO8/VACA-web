import { Buffer } from 'buffer';
import { hash, Keypair, Networks } from '@stellar/stellar-sdk';
import { canonicalUnsignedJson, validateD1Command, validateD1Config, type D1Clock, type D1Command } from './commands';

export type SignMessage = (message: string, options: { address: string; networkPassphrase: string }) => Promise<unknown>;

function signatureBytes(value: unknown): Buffer {
  if (value instanceof Uint8Array && value.byteLength === 64) return Buffer.from(value);
  if (typeof value === 'string' && value.length === 88 && /^[A-Za-z0-9+/]{86}==$/.test(value)) {
    const bytes = Buffer.from(value, 'base64');
    if (bytes.length === 64 && bytes.toString('base64') === value) return bytes;
  }
  throw new Error('d1_invalid_signature');
}

/** One personal-wallet interaction, no submission, retries, renewal or persistent state. */
export async function signD1Command(
  config: unknown, command: unknown, signMessage: SignMessage, clock?: D1Clock,
): Promise<D1Command & { readonly signature: string }> {
  const settings = validateD1Config(config);
  const snapshot = validateD1Command(settings, command, clock);
  const message = canonicalUnsignedJson(snapshot);
  let result: unknown;
  try {
    // Freighter prefixes and hashes once itself. It must receive RAW canonical JSON.
    result = await signMessage(message, { address: snapshot.wallet, networkPassphrase: Networks.TESTNET });
  } catch {
    throw new Error('d1_wallet_error');
  }
  if (!result || typeof result !== 'object' || 'error' in result && result.error != null) throw new Error('d1_wallet_error');
  if (!('signerAddress' in result) || result.signerAddress !== snapshot.wallet) throw new Error('d1_signer_mismatch');
  const bytes = signatureBytes('signedMessage' in result ? result.signedMessage : undefined);
  const digest = hash(Buffer.from('Stellar Signed Message:\n' + message, 'utf8'));
  let verified = false;
  try {
    verified = Keypair.fromPublicKey(snapshot.wallet).verify(digest, bytes);
  } catch {
    // SDK failures are invalid proof, never permission to bypass local verification.
  }
  if (!verified) throw new Error('d1_invalid_signature');
  validateD1Command(settings, snapshot, clock); // Reject a command that expired while the wallet was open.
  return Object.freeze({ ...snapshot, signature: bytes.toString('base64') });
}
