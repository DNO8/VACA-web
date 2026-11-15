import { StrKey } from '@stellar/stellar-sdk';
import { validateD1Config, type D1Config } from './commands';

export type D1Asset = Readonly<{ type: 'native' } | { type: 'issued'; code: string; issuer: string }>;
export type D1Payment = Readonly<{
  transaction_hash: string; operation_id: string; donor: string; pool: string; asset: D1Asset; amount: string;
}>;
export type D1ReceiptContext = Readonly<{
  config: D1Config;
  request_id: string;
  admin: string;
  incident_id: string;
  beneficiary: string;
  amount: string;
  payment: D1Payment & { readonly confirmedAt: number };
}>;

// Shared receipt readers throw privately; each public boundary supplies its stable error.
export function receiptAssert(condition: unknown): asserts condition {
  if (!condition) throw new Error('d1_invalid_receipt_data');
}
export function receiptRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  receiptAssert(value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
  receiptAssert(Reflect.ownKeys(value).length === keys.length);
  const copy: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    receiptAssert(descriptor?.enumerable && 'value' in descriptor);
    copy[key] = descriptor.value;
  }
  return copy;
}
export function receiptString(value: unknown, pattern: RegExp): string {
  receiptAssert(typeof value === 'string' && pattern.exec(value)?.[0] === value);
  return value;
}
export function receiptAccount(value: unknown): string {
  receiptAssert(typeof value === 'string' && StrKey.isValidEd25519PublicKey(value));
  return value;
}
export function receiptId(value: unknown): string {
  return receiptString(value, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
}
export function receiptIncident(value: unknown): string {
  const incident = receiptString(value, /^[\x20-\x7e]{1,256}$/);
  receiptAssert(incident.trim() === incident);
  return incident;
}
export function receiptAmount(value: unknown): string {
  const amount = receiptString(value, /^(0|[1-9][0-9]{0,11})\.[0-9]{7}$/);
  receiptAssert(BigInt(amount.replace('.', '')) > BigInt(0));
  return amount;
}
export function receiptStroops(amount: string): bigint {
  return BigInt(amount.replace('.', ''));
}
export function receiptAsset(value: unknown): D1Asset {
  // Inspect only a data descriptor before selecting the exact union shape.
  const type = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, 'type')?.value : undefined;
  const asset = receiptRecord(value, type === 'native' ? ['type'] : ['type', 'code', 'issuer']);
  if (asset.type === 'native') return Object.freeze({ type: 'native' });
  receiptAssert(asset.type === 'issued');
  return Object.freeze({ type: 'issued', code: receiptString(asset.code, /^[A-Za-z0-9]{1,12}$/), issuer: receiptAccount(asset.issuer) });
}
const paymentKeys = ['transaction_hash', 'operation_id', 'donor', 'pool', 'asset', 'amount'] as const;
export function receiptPayment(value: unknown): D1Payment {
  const payment = receiptRecord(value, paymentKeys);
  return Object.freeze({
    transaction_hash: receiptString(payment.transaction_hash, /^[a-f0-9]{64}$/),
    operation_id: receiptString(payment.operation_id, /^[1-9][0-9]{0,18}$/),
    donor: receiptAccount(payment.donor), pool: receiptAccount(payment.pool),
    asset: receiptAsset(payment.asset), amount: receiptAmount(payment.amount),
  });
}
export function receiptDate(value: unknown, milliseconds: boolean): string {
  const date = receiptString(value, milliseconds
    ? /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
    : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  const parsed = new Date(date).toISOString();
  receiptAssert((milliseconds ? parsed : parsed.replace('.000Z', 'Z')) === date);
  return date;
}
export function originalDeadline(confirmedAt: number): string {
  return receiptDate(new Date((confirmedAt + 300) * 1000).toISOString().replace('.000Z', 'Z'), false);
}

/** Retain caller evidence, not authenticate it. Never generate a replacement UUID or confirmation time. */
export function validateReceiptContext(value: unknown): D1ReceiptContext {
  try {
    const context = receiptRecord(value, ['config', 'request_id', 'admin', 'incident_id', 'beneficiary', 'amount', 'payment']);
    const config = validateD1Config(context.config);
    const { confirmedAt, ...original } = receiptRecord(context.payment, [...paymentKeys, 'confirmedAt']);
    receiptAssert(typeof confirmedAt === 'number' && Number.isSafeInteger(confirmedAt));
    receiptDate(new Date(confirmedAt * 1000).toISOString().replace('.000Z', 'Z'), false);
    originalDeadline(confirmedAt); // Excludes unrepresentable/expanded-year dates and deadline overflow.
    const payment = receiptPayment(original);
    const amount = receiptAmount(context.amount);
    receiptAssert(payment.pool === config.pool_public_key && receiptStroops(amount) <= receiptStroops(payment.amount));
    return Object.freeze({
      config, request_id: receiptId(context.request_id), admin: receiptAccount(context.admin),
      incident_id: receiptIncident(context.incident_id), beneficiary: receiptAccount(context.beneficiary), amount,
      payment: Object.freeze({ ...payment, confirmedAt }),
    });
  } catch {
    throw new Error('d1_invalid_receipt_context');
  }
}
