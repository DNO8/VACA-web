import {
  originalDeadline, receiptAccount, receiptAmount, receiptAssert, receiptAsset, receiptDate,
  receiptId, receiptIncident, receiptPayment, receiptRecord, validateReceiptContext,
  type D1Asset, type D1Payment,
} from './receipt-context';

export type PreparationReceipt = Readonly<{
  revision: 1;
  state: 'allocated';
  request_id: string;
  allocation: Readonly<{
    reservation: Readonly<{
      request_id: string;
      authorized_by: string;
      request: Readonly<{
        version: 1; incident_id: string; donor: string; beneficiary: string;
        asset: D1Asset; amount: string; deadline: string;
      }>;
      state: 'reserved';
      reserved_at: string;
    }>;
    payment: D1Payment;
    allocated_amount: string;
    state: 'allocated';
    allocated_at: string;
  }>;
}>;

function sameAsset(a: D1Asset, b: D1Asset): boolean {
  return a.type === 'native' ? b.type === 'native'
    : b.type === 'issued' && a.code === b.code && a.issuer === b.issuer;
}

/** Pure historical allocation binding; no IO, settlement inference or current capacity calculation. */
export function parsePreparationReceipt(raw: unknown, expectedContext: unknown): PreparationReceipt {
  const context = validateReceiptContext(expectedContext);
  let receipt: PreparationReceipt;
  try {
    const outer = receiptRecord(raw, ['revision', 'state', 'request_id', 'allocation']);
    const allocation = receiptRecord(outer.allocation, ['reservation', 'payment', 'allocated_amount', 'state', 'allocated_at']);
    const reservation = receiptRecord(allocation.reservation, ['request_id', 'authorized_by', 'request', 'state', 'reserved_at']);
    const request = receiptRecord(reservation.request, ['version', 'incident_id', 'donor', 'beneficiary', 'asset', 'amount', 'deadline']);
    receiptAssert(outer.revision === 1 && outer.state === 'allocated' && allocation.state === 'allocated' &&
      reservation.state === 'reserved' && request.version === 1);
    receipt = Object.freeze({
      revision: 1, state: 'allocated', request_id: receiptId(outer.request_id),
      allocation: Object.freeze({
        reservation: Object.freeze({
          request_id: receiptId(reservation.request_id), authorized_by: receiptAccount(reservation.authorized_by),
          request: Object.freeze({
            version: 1, incident_id: receiptIncident(request.incident_id), donor: receiptAccount(request.donor),
            beneficiary: receiptAccount(request.beneficiary), asset: receiptAsset(request.asset),
            amount: receiptAmount(request.amount), deadline: receiptDate(request.deadline, false),
          }),
          state: 'reserved', reserved_at: receiptDate(reservation.reserved_at, true),
        }),
        payment: receiptPayment(allocation.payment), allocated_amount: receiptAmount(allocation.allocated_amount),
        state: 'allocated', allocated_at: receiptDate(allocation.allocated_at, true),
      }),
    });
  } catch {
    throw new Error('d1_malformed_preparation_receipt');
  }
  const { reservation, payment, allocated_amount } = receipt.allocation;
  const request = reservation.request;
  const original = context.payment;
  if (receipt.request_id !== context.request_id || reservation.request_id !== context.request_id ||
      reservation.authorized_by !== context.admin || request.incident_id !== context.incident_id ||
      request.beneficiary !== context.beneficiary || request.donor !== original.donor ||
      !sameAsset(request.asset, original.asset) || request.amount !== context.amount || allocated_amount !== context.amount ||
      request.deadline !== originalDeadline(original.confirmedAt) || payment.transaction_hash !== original.transaction_hash ||
      payment.operation_id !== original.operation_id || payment.donor !== original.donor || payment.pool !== original.pool ||
      !sameAsset(payment.asset, original.asset) || payment.amount !== original.amount) {
    throw new Error('d1_receipt_binding_mismatch');
  }
  return receipt;
}
