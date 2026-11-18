import { validateD1Config, type D1Config } from './commands';
import type { DonationEvidence } from './donation-evidence';
import type { DonationJournalV2 } from './donation-journal';
import { readDonation, type DonationSession } from './donation-session';
import { validateDonationIntent } from './donation-transaction';
import { validateStoredDonationEvidence } from './stored-donation-evidence';
import { originalDeadline, receiptAccount, receiptIncident, receiptRecord } from './receipt-context';

export type DonationScope = Readonly<{ config: D1Config; donor: string; incidentId: string }>;
export type DonationRecovery = Readonly<{
  session: DonationSession;
  evidence: DonationEvidence | null;
  deadline: string | null;
  /** No accepted active-beneficiary-CB resolver exists. Observation cannot clear this. */
  repeatBlocked: true;
}>;
export function validateDonationScope(value: DonationScope): DonationScope {
  return Object.freeze({ config: validateD1Config(value.config), donor: receiptAccount(value.donor), incidentId: receiptIncident(value.incidentId) });
}
/** Journal's documented scope format excludes amount/asset; acquireDonation remains the only writer. */
function scopeKey(context: DonationScope): string {
  return JSON.stringify([context.config.network, context.config.pool_public_key, context.config.namespace, context.donor, context.incidentId]);
}
export function donationRecovery(session: DonationSession, cached: unknown = null): DonationRecovery {
  let evidence: DonationEvidence | null = null;
  if (cached !== null) {
    if (session.state !== 'submission_claimed') throw new Error('d1_recovery_invalid_state');
    evidence = validateStoredDonationEvidence(session.snapshot, cached);
  }
  return Object.freeze({ session, evidence, deadline: evidence ? originalDeadline(evidence.payment.confirmedAt) : null, repeatBlocked: true });
}

/** Recover the winning scope before creating any replacement identity, body, or account read. */
export async function recoverDonation(journal: DonationJournalV2, input: DonationScope): Promise<DonationRecovery | null> {
  const context = validateDonationScope(input), scope = scopeKey(context);
  const raw = await journal.readScope(scope);
  if (raw === null) return null;
  const view = receiptRecord(raw, ['record', 'active', 'resolution']);
  if (typeof view.active !== 'boolean' || (view.resolution !== null && (typeof view.resolution !== 'string' || view.resolution.length > 1048576))) throw new Error('d1_recovery_invalid_scope');
  const state = Object.getOwnPropertyDescriptor(view.record, 'state')?.value;
  const record = receiptRecord(view.record, ['scope', 'requestId', 'intent', 'state', ...(state === 'intent' ? [] : ['signed'])]);
  if (typeof record.intent !== 'string' || record.intent.length > 1048576) throw new Error('d1_recovery_invalid_scope');
  const stored = receiptRecord(JSON.parse(record.intent), ['intent', 'parameters', 'unsignedXdr', 'transactionHash']);
  const expected = validateDonationIntent(stored.intent);
  const session = await readDonation(journal, expected); // Rebuild XDR and validate signed bytes with existing validators.
  if (!session || record.scope !== scope || session.scope !== scope || record.requestId !== session.requestId || expected.asset.type !== 'native') throw new Error('d1_recovery_identity_mismatch');
  const { signedTxXdr: _signed, ...unsigned } = session.snapshot as DonationSession['snapshot'] & { signedTxXdr?: string };
  if (record.intent !== JSON.stringify(unsigned) ||
    (state !== 'intent' && (record.signed !== JSON.stringify(session.snapshot) || session.state === 'intent')) ||
    (state === 'submission_claimed' && session.state !== 'submission_claimed') ||
    (view.active ? view.resolution !== null : view.resolution === null)) throw new Error('d1_recovery_invalid_scope');
  return donationRecovery(session, view.resolution === null ? null : JSON.parse(view.resolution as string));
}
