import { Networks, Transaction, xdr } from '@stellar/stellar-sdk';
import { validateSignedDonation } from './donation-transaction';
import { originalDeadline, receiptAssert, receiptDate, receiptRecord, receiptString, type D1ReceiptContext } from './receipt-context';

export type DonationEvidence = Readonly<Pick<D1ReceiptContext, 'config' | 'request_id' | 'incident_id' | 'payment'> & {
  ledger: Readonly<{ sequence: number; hash: string; closed_at: string }>;
}>;
const maxEncodedLength = 1048576;
function encoded(value: unknown): string {
  receiptAssert(typeof value === 'string' && value.length > 0 && value.length <= maxEncodedLength);
  return value;
}

/** Inspect raw JSON-like data without evaluating getters, including optional Horizon metadata. */
function plainData(value: unknown, ancestors = new Set<object>(), depth = 0): void {
  receiptAssert(depth <= 32);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') { receiptAssert(Number.isFinite(value)); return; }
  receiptAssert(value && typeof value === 'object' && !ancestors.has(value));
  const array = Array.isArray(value);
  receiptAssert(array ? Object.getPrototypeOf(value) === Array.prototype
    : [Object.prototype, null].includes(Object.getPrototypeOf(value)));
  ancestors.add(value);
  for (const key of Reflect.ownKeys(value)) {
    receiptAssert(typeof key === 'string');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    receiptAssert(descriptor && 'value' in descriptor);
    if (array && key === 'length') continue;
    receiptAssert(descriptor.enumerable);
    plainData(descriptor.value, ancestors, depth + 1);
  }
  ancestors.delete(value);
}
function record(value: unknown, required: readonly string[]): Record<string, unknown> {
  receiptAssert(value && typeof value === 'object');
  const data = receiptRecord(value, Object.keys(value));
  receiptAssert(required.every(key => Object.hasOwn(data, key)));
  return data;
}
function unmuxed(data: Record<string, unknown>, names: readonly string[]): void {
  for (const name of names) {
    receiptAssert(!Object.hasOwn(data, name + '_muxed') && !Object.hasOwn(data, name + '_muxed_id'));
  }
}
function successfulResult(value: unknown): void {
  const wire = encoded(value);
  const result = xdr.TransactionResult.fromXDR(wire, 'base64');
  receiptAssert(result.toXDR('base64') === wire); // Reject trailing bytes and noncanonical base64.
  receiptAssert(result.result().switch().name === 'txSuccess');
  const results = result.result().results();
  receiptAssert(results.length === 1 && results[0].switch().name === 'opInner');
  const inner = results[0].tr();
  receiptAssert(inner.switch().name === 'payment' && inner.paymentResult().switch().name === 'paymentSuccess');
}

/** Consistency only: callers must separately establish fixed-origin source provenance. No effects. */
export function parseDonationEvidence(retainedSignedSnapshot: unknown, transaction: unknown, operations: unknown, ledger: unknown): DonationEvidence {
  try {
    const { signedTxXdr, ...unsigned } = receiptRecord(retainedSignedSnapshot,
      ['intent', 'parameters', 'unsignedXdr', 'transactionHash', 'signedTxXdr']);
    encoded(unsigned.unsignedXdr);
    // Strip ONLY signedTxXdr. The existing validator reconstructs and checks the canonical unsigned snapshot.
    const intent = receiptRecord(unsigned.intent, ['config', 'request_id', 'donor', 'incident_id', 'asset', 'amount']);
    const retained = validateSignedDonation(unsigned, { signedTxXdr: encoded(signedTxXdr), signerAddress: intent.donor });
    const original = retained.intent;
    for (const value of [transaction, operations, ledger]) plainData(value);
    const tx = record(transaction, ['hash', 'successful', 'operation_count', 'source_account', 'source_account_sequence',
      'ledger', 'envelope_xdr', 'result_xdr', 'created_at']);
    receiptAssert(tx.hash === retained.transactionHash && tx.successful === true && tx.operation_count === 1);
    receiptAssert(tx.source_account === original.donor);
    receiptAssert(tx.source_account_sequence === new Transaction(retained.unsignedXdr, Networks.TESTNET).sequence);
    receiptAssert(typeof tx.ledger === 'number' && Number.isSafeInteger(tx.ledger) && tx.ledger > 0 && tx.ledger <= 4294967295);
    unmuxed(tx, ['source_account']);
    // Different signature sets/whitespace are allowed, but never a different body, network or missing donor proof.
    validateSignedDonation(unsigned, { signedTxXdr: encoded(tx.envelope_xdr), signerAddress: original.donor });
    successfulResult(tx.result_xdr);

    const collection = record(operations, ['_embedded']);
    const embedded = record(collection._embedded, ['records']);
    receiptAssert(Array.isArray(embedded.records) && embedded.records.length === 1);
    const op = record(embedded.records[0], ['type', 'type_i', 'transaction_successful', 'transaction_hash', 'id',
      'source_account', 'from', 'to', 'amount', 'asset_type', 'created_at']);
    receiptAssert(op.type === 'payment' && op.type_i === 1 && op.transaction_successful === true);
    receiptAssert(op.transaction_hash === retained.transactionHash && op.source_account === original.donor && op.from === original.donor);
    receiptAssert(op.to === original.config.pool_public_key && op.amount === original.amount);
    unmuxed(op, ['source_account', 'from', 'to']);
    const operationId = receiptString(op.id, /^[1-9][0-9]{0,18}$/);
    if (original.asset.type === 'native') {
      receiptAssert(op.asset_type === 'native' && !Object.hasOwn(op, 'asset_code') && !Object.hasOwn(op, 'asset_issuer'));
    } else {
      receiptAssert(op.asset_type === (original.asset.code.length <= 4 ? 'credit_alphanum4' : 'credit_alphanum12'));
      receiptAssert(op.asset_code === original.asset.code && op.asset_issuer === original.asset.issuer);
    }
    const block = record(ledger, ['sequence', 'hash', 'closed_at']);
    receiptAssert(block.sequence === tx.ledger);
    const ledgerHash = receiptString(block.hash, /^[0-9a-f]{64}$/);
    const closedAt = receiptDate(block.closed_at, false);
    // Conservative gate, not a claim that Horizon universally guarantees timestamp equality.
    receiptAssert(receiptDate(tx.created_at, false) === closedAt && receiptDate(op.created_at, false) === closedAt);
    const confirmedAt = Date.parse(closedAt) / 1000;
    receiptAssert(Number.isSafeInteger(confirmedAt) && confirmedAt >= 0);
    originalDeadline(confirmedAt);
    return Object.freeze({
      config: original.config, request_id: original.request_id, incident_id: original.incident_id,
      payment: Object.freeze({ transaction_hash: retained.transactionHash, operation_id: operationId, donor: original.donor,
        pool: original.config.pool_public_key, asset: original.asset, amount: original.amount, confirmedAt }),
      ledger: Object.freeze({ sequence: tx.ledger, hash: ledgerHash, closed_at: closedAt }),
    });
  } catch {
    throw new Error('d1_donation_evidence_invalid');
  }
}
