import { buildD1Command, validateD1Command, validateD1Config, type D1Action, type D1Clock, type D1Config } from './commands';
import { signD1Command, type SignMessage } from './wallet-proof';
import { receiptRecord, receiptString, validateReceiptContext, originalDeadline, type D1ReceiptContext } from './receipt-context';
import { parsePreparationReceipt, type PreparationReceipt } from './preparation-receipt';
import { parseIssuanceReceipt, parseReconciliationReceipt } from './issuance-receipt';
import { buildRefundCommand, signRefundCommand, type RefundInput } from './refund-commands';
import { parseRefundReceipt, type RefundReceiptContext } from './refund-receipt';
import type { RefundJournal, RefundOriginalIdentity } from './refund-journal';
import { createRefundSender } from './refund-submission';
import { assertAdminResponse, postAdminCommand, type AdminRoute } from './admin-command-transport';
import { validateSignedDonation } from './donation-transaction';
import type { DonationJournal } from './donation-journal';
import { observeDonation } from './donation-observation';
import type { DonationEvidence } from './donation-evidence';

/** Opaque live provenance, not an importable authorization credential. */
export type AdminOriginal = Readonly<{ evidence: DonationEvidence }>;
const originals = new WeakSet<object>();
function sameConfig(a: D1Config, b: D1Config): boolean {
  return a.network === b.network && a.namespace === b.namespace && a.pool_public_key === b.pool_public_key && a.donation_ttl_seconds === b.donation_ttl_seconds;
}

/** Validate imported signed bytes, then explicitly observe ONLY their original hash at fixed Testnet Horizon. */
export async function observeAdminOriginal(config: unknown, snapshot: unknown, fetcher: typeof fetch): Promise<AdminOriginal> {
  const settings = validateD1Config(config);
  const { signedTxXdr, ...unsigned } = receiptRecord(snapshot, ['intent', 'parameters', 'unsignedXdr', 'transactionHash', 'signedTxXdr']);
  const intent = receiptRecord(unsigned.intent, ['config', 'request_id', 'donor', 'incident_id', 'asset', 'amount']);
  const retained = validateSignedDonation(unsigned, { signedTxXdr, signerAddress: intent.donor });
  if (!sameConfig(settings, retained.intent.config)) throw new Error('d1_admin_original_mismatch');
  // Readonly adapter, NOT a durable submission claim: the observer independently checks chain reports.
  // Every mutation is forbidden; no imported state flag can authorize submission or release.
  const forbidden = async (): Promise<never> => { throw new Error('d1_admin_readonly_original'); };
  const journal: DonationJournal = {
    acquire: forbidden, saveSigned: forbidden, claimSubmission: forbidden, close() {},
    read: async () => ({ scope: JSON.stringify([settings.network, settings.pool_public_key, settings.namespace, retained.intent.donor, retained.intent.incident_id]), requestId: retained.intent.request_id,
      intent: JSON.stringify({ intent: retained.intent, parameters: retained.parameters, unsignedXdr: retained.unsignedXdr, transactionHash: retained.transactionHash }), state: 'submission_claimed', signed: JSON.stringify(retained) }),
  };
  const observed = await observeDonation(journal, retained.intent, fetcher);
  if (observed.state !== 'observed') throw new Error('d1_admin_original_unresolved');
  const original = Object.freeze({ evidence: observed.evidence });
  originals.add(original);
  return original;
}

export interface AdminActionHistory {
  /** Durable winner only. A retained or uncertain record can never be replaced. */
  claim(key: string, signedBody: string): Promise<boolean>;
}
/** Existing browser primitives; fail closed without cross-tab exclusion or durable storage. */
export function browserAdminActionHistory(storage: Storage, locks: LockManager): AdminActionHistory {
  if (!storage || !locks?.request) throw new Error('d1_admin_history_unavailable');
  return Object.freeze({
    claim: (key: string, signedBody: string) => locks.request(key, () => {
      if (storage.getItem(key) !== null) return false;
      storage.setItem(key, signedBody);
      if (storage.getItem(key) !== signedBody) throw new Error('d1_admin_history_uncertain');
      return true;
    }),
  });
}
export type RefundLane = 'full_gross_v1' | 'verified_remainder_v2';
export type AdminDependencies = {
  journal: RefundJournal; history: AdminActionHistory; signMessage: SignMessage; fetcher: typeof fetch;
  clock?: D1Clock; knownIssuanceHash?: string; preparationReceipt?: unknown;
};
const refundActions = {
  full_gross_v1: { version: 1, status: 'refund_status', reconcile: 'refund_reconcile', execute: 'refund' },
  verified_remainder_v2: { version: 2, status: 'refund_remainder_status', reconcile: 'refund_remainder_reconcile', execute: 'refund_remainder' },
} as const;

/** Explicit original-bound commands. Wallet proof is personal proof, NEVER administrator membership. */
export function createAdminFlow(config: unknown, original: object, expectedContext: unknown, dependencies: AdminDependencies) {
  if (!originals.has(original)) throw new Error('d1_admin_original_unverified');
  const settings = validateD1Config(config), context = validateReceiptContext(expectedContext);
  const evidence = (original as AdminOriginal).evidence;
  if (!sameConfig(settings, evidence.config) || !sameConfig(settings, context.config) || evidence.incident_id !== context.incident_id || JSON.stringify(evidence.payment) !== JSON.stringify(context.payment)) throw new Error('d1_admin_original_mismatch');
  const clock = dependencies.clock ?? (() => Math.floor(Date.now() / 1000));
  let knownHash = dependencies.knownIssuanceHash === undefined ? undefined : receiptString(dependencies.knownIssuanceHash, /^[a-f0-9]{64}$/);
  let preparation: PreparationReceipt | undefined = dependencies.preparationReceipt === undefined ? undefined : parsePreparationReceipt(dependencies.preparationReceipt, context);
  let busy = false, disposed = false;
  const lifecycle = new AbortController();
  const attempted = new Set<D1Action>();
  const identity: RefundOriginalIdentity = Object.freeze({ network: settings.network, namespace: settings.namespace, pool: settings.pool_public_key, request_id: context.request_id });
  const sender = createRefundSender(settings, dependencies.journal, identity, dependencies.fetcher, clock);
  const active = () => { if (disposed) throw new Error('d1_admin_stale'); };
  async function run<T>(operation: () => Promise<T>): Promise<T> {
    active(); if (busy) throw new Error('d1_admin_busy');
    busy = true;
    try { const result = await operation(); active(); return result; }
    finally { busy = false; }
  }
  return Object.freeze({
    context,
    dispose() { disposed = true; lifecycle.abort(); },
    initial(action: D1Action) {
      return run(async () => {
        if (!['prepare', 'issue', 'reconcile'].includes(action)) throw new Error('d1_admin_invalid_action');
        if (action === 'issue' && !preparation) throw new Error('d1_admin_preparation_required');
        if (action === 'reconcile' && !knownHash) throw new Error('d1_admin_issuance_reference_required');
        if (action !== 'reconcile' && attempted.has(action)) throw new Error('d1_admin_action_retained');
        const command = buildD1Command(settings, { action, request_id: context.request_id, timestamp: clock(), wallet: context.admin, payload: action === 'prepare' ? { incident_id: context.incident_id, transaction_hash: context.payment.transaction_hash, operation_id: context.payment.operation_id, beneficiary: context.beneficiary, amount: context.amount } : {} }, clock);
        const signed = await signD1Command(settings, command, dependencies.signMessage, clock);
        active();
        const bytes = JSON.stringify(signed);
        if (action !== 'reconcile') {
          attempted.add(action);
          const key = 'vaca-d1-admin-initial:' + JSON.stringify([identity.network, identity.namespace, identity.pool, identity.request_id, action]);
          if (!await dependencies.history.claim(key, bytes)) throw new Error('d1_admin_action_retained');
          active();
        }
        validateD1Command(settings, command, clock); // A durable lock wait cannot renew an expired proof.
        const response = await postAdminCommand(action, bytes, dependencies.fetcher);
        active(); assertAdminResponse(response, action === 'prepare' ? [200, 201] : [200, 202]);
        if (action === 'prepare') { preparation = parsePreparationReceipt(response.body, context); return preparation; }
        const parsed = action === 'issue' ? parseIssuanceReceipt(response.status, response.body, context, knownHash) : parseReconciliationReceipt(response.status, response.body, context, knownHash);
        knownHash = parsed.receipt.transactionHash;
        return parsed;
      });
    },
    refund(lane: RefundLane, operation: 'status' | 'reconcile' | 'execute') {
      return run(async () => {
        const selected = Object.hasOwn(refundActions, lane) ? refundActions[lane] : undefined;
        if (!selected || !['status', 'reconcile', 'execute'].includes(operation)) throw new Error('d1_admin_refund_reference_required');
        if (operation === 'execute' && await dependencies.journal.read(identity)) throw new Error('d1_refund_execution_retained');
        active();
        const action = selected[operation];
        const command = buildRefundCommand(settings, { version: selected.version, action, request_id: context.request_id, timestamp: clock(), wallet: context.admin, payload: {} } as RefundInput, clock);
        const signed = await signRefundCommand(settings, command, dependencies.signMessage, clock);
        active();
        const bytes = JSON.stringify(signed);
        let response;
        if (operation === 'execute') {
          const capability = await sender.claim(bytes); active(); response = await capability.send(lifecycle.signal);
        } else response = await postAdminCommand(action.replaceAll('_', '-') as AdminRoute, bytes, dependencies.fetcher);
        active(); assertAdminResponse(response, [200, 202, 409]);
        const correlation = { version: command.version, action: command.action, network: command.network, namespace: command.namespace, pool: command.pool, request_id: command.request_id } as RefundReceiptContext;
        const receipt = parseRefundReceipt(response.status, response.body, correlation);
        const d = receipt.donation, p = context.payment;
        if (d.paymentOperationId !== p.operation_id || d.paymentTransactionHash !== p.transaction_hash || d.donor !== p.donor || d.grossAmount !== p.amount || JSON.stringify(d.asset) !== JSON.stringify(p.asset) || receipt.deadline !== originalDeadline(p.confirmedAt)) throw new Error('d1_admin_refund_original_mismatch');
        return receipt; // safeActions is reported data, never permission or lane selection.
      });
    },
  });
}
export type AdminFlow = ReturnType<typeof createAdminFlow>;
