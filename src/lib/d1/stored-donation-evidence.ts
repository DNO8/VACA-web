import { validateD1Config } from './commands';
import type { DonationEvidence } from './donation-evidence';
import { validateSignedDonation } from './donation-transaction';
import { originalDeadline, receiptAssert, receiptDate, receiptPayment, receiptRecord, receiptString } from './receipt-context';

const configKeys = ['network', 'pool_public_key', 'namespace', 'donation_ttl_seconds'] as const;
function encoded(value: unknown): string {
  receiptAssert(typeof value === 'string' && value.length > 0 && value.length <= 1048576);
  return value;
}

/** Cached-report consistency only; not storage authentication, inclusion or permission to release a claim. */
export function validateStoredDonationEvidence(snapshot: unknown, evidence: unknown): DonationEvidence {
  try {
    const { signedTxXdr, ...unsigned } = receiptRecord(snapshot,
      ['intent', 'parameters', 'unsignedXdr', 'transactionHash', 'signedTxXdr']);
    const intent = receiptRecord(unsigned.intent, ['config', 'request_id', 'donor', 'incident_id', 'asset', 'amount']);
    // Descriptor copies use schema order, including config (whose public validator preserves key order).
    // The fixed schema traversal rejects cycles/deep objects at a typed leaf; no recursive serialization.
    const config = receiptRecord(intent.config, configKeys);
    const retained = validateSignedDonation({ ...unsigned, unsignedXdr: encoded(unsigned.unsignedXdr),
      intent: { ...intent, config } }, { signedTxXdr: encoded(signedTxXdr), signerAddress: intent.donor });
    const original = retained.intent;

    const data = receiptRecord(evidence, ['config', 'request_id', 'incident_id', 'payment', 'ledger']);
    const settings = validateD1Config(receiptRecord(data.config, configKeys));
    for (const key of configKeys) receiptAssert(settings[key] === original.config[key]);
    receiptAssert(data.request_id === original.request_id && data.incident_id === original.incident_id);
    const { confirmedAt, ...paymentData } = receiptRecord(data.payment,
      ['transaction_hash', 'operation_id', 'donor', 'pool', 'asset', 'amount', 'confirmedAt']);
    const payment = receiptPayment(paymentData);
    receiptAssert(payment.transaction_hash === retained.transactionHash && payment.donor === original.donor);
    receiptAssert(payment.pool === original.config.pool_public_key && payment.amount === original.amount);
    receiptAssert(payment.asset.type === original.asset.type);
    if (payment.asset.type === 'issued') {
      receiptAssert(original.asset.type === 'issued');
      receiptAssert(payment.asset.code === original.asset.code && payment.asset.issuer === original.asset.issuer);
    }

    const block = receiptRecord(data.ledger, ['sequence', 'hash', 'closed_at']);
    const sequence = block.sequence;
    receiptAssert(typeof sequence === 'number' && Number.isSafeInteger(sequence) && sequence > 0 && sequence <= 4294967295);
    const ledgerHash = receiptString(block.hash, /^[0-9a-f]{64}$/);
    const closedAt = receiptDate(block.closed_at, false);
    const seconds = Date.parse(closedAt) / 1000;
    receiptAssert(Number.isSafeInteger(seconds) && seconds >= 0 && confirmedAt === seconds);
    originalDeadline(seconds);

    return Object.freeze({
      config: original.config, request_id: original.request_id, incident_id: original.incident_id,
      payment: Object.freeze({ ...payment, confirmedAt: seconds }),
      ledger: Object.freeze({ sequence, hash: ledgerHash, closed_at: closedAt }),
    });
  } catch {
    throw new Error('d1_stored_donation_evidence_invalid');
  }
}
