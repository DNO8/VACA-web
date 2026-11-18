import { Buffer } from 'buffer';
import { hash, Keypair } from '@stellar/stellar-sdk';
import { validateD1Config, type D1Clock } from './commands';
import { validateRefundCommand } from './refund-commands';
import type { RefundOriginalIdentity, RefundExecutionAttempt } from './refund-journal';

const identityKeys = ['network', 'namespace', 'pool', 'request_id'];
const signedKeys = [...identityKeys, 'version', 'action', 'timestamp', 'payload', 'wallet', 'signature'];

function snapshot(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new Error('d1_invalid_refund_attempt');
  }
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(fields).length !== keys.length || keys.some(key => {
    const field = fields[key];
    return !field?.enumerable || !('value' in field);
  })) throw new Error('d1_invalid_refund_attempt');
  return Object.fromEntries(keys.map(key => [key, fields[key].value]));
}

/** JSON.parse already checked syntax; this scan only detects ambiguous root names. */
function assertUniqueRootKeys(body: string): void {
  const names: string[] = [];
  let depth = 0; let expectingKey = false;
  for (const token of body.match(/"(?:[^"\\]|\\.)*"|[{}\[\],]/g) ?? []) {
    if (token === '{' || token === '[') { depth++; if (depth === 1) expectingKey = true; }
    else if (token === '}' || token === ']') depth--;
    else if (token === ',' && depth === 1) expectingKey = true;
    else if (token.startsWith('"') && depth === 1 && expectingKey) {
      names.push(JSON.parse(token)); expectingKey = false;
    }
  }
  if (names.length !== signedKeys.length || new Set(names).size !== names.length) {
    throw new Error('d1_invalid_refund_attempt');
  }
}

/** Mechanical proof/context validation only: never authority to claim, select, send or retry. */
export function validateRefundExecutionAttempt(
  config: unknown, signedBody: unknown, expectedIdentity: unknown, clock?: D1Clock,
): Readonly<{ identity: RefundOriginalIdentity; attempt: RefundExecutionAttempt }> {
  if (typeof signedBody !== 'string' || signedBody.length === 0 || Buffer.byteLength(signedBody, 'utf8') > 8192) {
    throw new Error('d1_invalid_refund_attempt');
  }
  let decoded: unknown;
  try { decoded = JSON.parse(signedBody); }
  catch { throw new Error('d1_invalid_refund_attempt'); }
  const record = snapshot(decoded, signedKeys);
  assertUniqueRootKeys(signedBody);
  const expected = snapshot(expectedIdentity, identityKeys);
  const settings = validateD1Config(config);
  const { signature, ...unsigned } = record;
  const command = validateRefundCommand(settings, unsigned, clock);
  if (!((command.version === 1 && command.action === 'refund') ||
      (command.version === 2 && command.action === 'refund_remainder'))) {
    throw new Error('d1_invalid_refund_attempt');
  }
  if (identityKeys.some(key => expected[key] !== record[key])) throw new Error('d1_refund_attempt_mismatch');
  if (typeof signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(signature)) throw new Error('d1_invalid_signature');
  const bytes = Buffer.from(signature, 'base64');
  if (bytes.length !== 64 || bytes.toString('base64') !== signature) throw new Error('d1_invalid_signature');
  // The backend canonicalizes unsigned root keys; the validated payload is empty.
  const message = JSON.stringify(Object.fromEntries(Object.entries(command).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
  let verified = false;
  try { verified = Keypair.fromPublicKey(command.wallet).verify(hash(Buffer.from('Stellar Signed Message:\n' + message, 'utf8')), bytes); }
  catch { /* Invalid proofs and SDK errors cannot grant a mechanical validation result. */ }
  if (!verified) throw new Error('d1_invalid_signature');
  validateRefundCommand(settings, command, clock);
  const identity: RefundOriginalIdentity = Object.freeze({
    network: command.network, namespace: command.namespace, pool: command.pool, request_id: command.request_id,
  });
  const attempt: RefundExecutionAttempt = Object.freeze({ version: command.version, action: command.action, signedBody });
  return Object.freeze({ identity, attempt });
}
