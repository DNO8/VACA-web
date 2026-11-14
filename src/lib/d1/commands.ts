import { StrKey } from '@stellar/stellar-sdk';

export type D1Config = Readonly<{
  network: 'TESTNET';
  pool_public_key: string;
  namespace: string;
  donation_ttl_seconds: 300;
}>;
export type D1Action = 'prepare' | 'issue' | 'reconcile';
export type D1Input = {
  action: D1Action;
  request_id: string;
  timestamp: number;
  wallet: string;
  payload: Readonly<Record<string, string>>;
};
export type D1Command = Readonly<D1Input & {
  version: 1;
  network: 'TESTNET';
  pool: string;
  namespace?: string;
}>;
/** Unix seconds, not milliseconds. */
export type D1Clock = () => number;
const systemClock: D1Clock = () => Math.floor(Date.now() / 1000);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const inputKeys = ['action', 'request_id', 'timestamp', 'wallet', 'payload'];

// Only plain data: accessors, hidden fields and symbols cannot alter a snapshot.
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const own = Reflect.ownKeys(value);
  return own.length === keys.length && keys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable && 'value' in descriptor;
  });
}
function matches(value: unknown, pattern: RegExp): value is string {
  // JS `$` also matches before a final newline; require the entire string.
  return typeof value === 'string' && pattern.exec(value)?.[0] === value;
}
function account(value: unknown): value is string {
  return typeof value === 'string' && StrKey.isValidEd25519PublicKey(value);
}

export function validateD1Config(value: unknown): D1Config {
  if (!exact(value, ['network', 'pool_public_key', 'namespace', 'donation_ttl_seconds']) ||
      value.network !== 'TESTNET' || !account(value.pool_public_key) ||
      !matches(value.namespace, uuid) || value.donation_ttl_seconds !== 300) throw new Error('d1_invalid_config');
  return Object.freeze({ ...value }) as D1Config;
}

/** Validate against explicitly supplied matching public config and retain no caller references. */
export function validateD1Command(config: unknown, command: unknown, clock: D1Clock = systemClock): D1Command {
  const settings = validateD1Config(config);
  const hasNamespace = exact(command, [...inputKeys, 'version', 'network', 'pool', 'namespace']);
  if (!hasNamespace && !exact(command, [...inputKeys, 'version', 'network', 'pool'])) {
    throw new Error('d1_invalid_command');
  }
  const value = command as Record<string, unknown>;
  if (value.version !== 1 || value.network !== settings.network || value.pool !== settings.pool_public_key ||
      !['prepare', 'issue', 'reconcile'].includes(value.action as string) ||
      (value.action === 'prepare' ? hasNamespace : !hasNamespace || value.namespace !== settings.namespace) ||
      !matches(value.request_id, uuid) || !account(value.wallet) || !Number.isSafeInteger(value.timestamp)) {
    throw new Error('d1_invalid_command');
  }
  const payload = value.payload;
  if (value.action === 'prepare') {
    if (!exact(payload, ['incident_id', 'transaction_hash', 'operation_id', 'beneficiary', 'amount']) ||
        !matches(payload.incident_id, /^[\x20-\x7e]{1,256}$/) || payload.incident_id.trim() !== payload.incident_id ||
        !matches(payload.transaction_hash, /^[a-f0-9]{64}$/) || !matches(payload.operation_id, /^[1-9][0-9]{0,18}$/) ||
        !account(payload.beneficiary) || !matches(payload.amount, /^(0|[1-9][0-9]{0,11})\.[0-9]{7}$/)) {
      throw new Error('d1_invalid_command');
    }
  } else if (!exact(payload, [])) throw new Error('d1_invalid_command');
  const now = clock();
  if (!Number.isSafeInteger(now)) throw new Error('d1_invalid_command');
  if (Math.abs((value.timestamp as number) - now) > 60) throw new Error('d1_stale_command');
  return Object.freeze({ ...value, payload: Object.freeze({ ...(payload as Record<string, string>) }) }) as D1Command;
}

/** Caller supplies request_id and timestamp once; no identity generation or normalization. */
export function buildD1Command(config: unknown, input: D1Input, clock: D1Clock = systemClock): D1Command {
  const settings = validateD1Config(config);
  if (!exact(input, inputKeys)) throw new Error('d1_invalid_command');
  return validateD1Command(settings, {
    ...input, version: 1, network: settings.network, pool: settings.pool_public_key,
    ...(input.action === 'prepare' ? {} : { namespace: settings.namespace }),
  }, clock);
}

/** Serialize an already validated command (or signed result), excluding only its top-level signature. */
export function canonicalUnsignedJson(command: D1Command): string {
  const unsigned = Object.fromEntries(Object.entries(command).filter(([key]) => key !== 'signature'));
  return JSON.stringify(unsigned, (_key, value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]));
  });
}
