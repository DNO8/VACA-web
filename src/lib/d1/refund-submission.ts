import { validateD1Config, type D1Clock } from './commands';
import { postAdminCommand } from './admin-command-transport';
import type { RefundJournal, RefundOriginalIdentity, RefundHold } from './refund-journal';
import { receiptRecord } from './receipt-context';
import { validateRefundExecutionAttempt } from './refund-submission-preflight';

function sameHold(a: RefundHold, b: RefundHold): boolean {
  return a.identity.network === b.identity.network && a.identity.namespace === b.identity.namespace && a.identity.pool === b.identity.pool && a.identity.request_id === b.identity.request_id &&
    a.attempt.version === b.attempt.version && a.attempt.action === b.attempt.action && a.attempt.signedBody === b.attempt.signedBody;
}

/** Preflight is not permission: only this invocation's durable winner gets a one-use closure. */
export function createRefundSender(config: unknown, journal: RefundJournal, identity: RefundOriginalIdentity, fetcher: typeof fetch, clock?: D1Clock) {
  const settings = validateD1Config(config);
  const expected = Object.freeze(receiptRecord(identity, ['network', 'namespace', 'pool', 'request_id']));
  return Object.freeze({
    async claim(signedBody: string) {
      const validated = validateRefundExecutionAttempt(settings, signedBody, expected, clock);
      const result = await journal.claimExecution(validated.identity, validated.attempt);
      if (!result.claimed) throw new Error('d1_refund_execution_retained');
      if (!sameHold(result.hold, validated)) throw new Error('d1_refund_hold_mismatch');
      let consumed = false;
      return Object.freeze({
        async send(signal?: AbortSignal) {
          if (consumed) throw new Error('d1_refund_capability_consumed');
          consumed = true; // Includes failures, concurrent calls, expiry and uncertain IO.
          const retained = await journal.read(validated.identity);
          if (!retained || !sameHold(retained, validated)) throw new Error('d1_refund_hold_mismatch');
          validateRefundExecutionAttempt(settings, validated.attempt.signedBody, validated.identity, clock);
          if (signal?.aborted) throw new Error('d1_admin_stale');
          return postAdminCommand(validated.attempt.version === 1 ? 'refund' : 'refund-remainder', validated.attempt.signedBody, fetcher);
        },
      });
    },
  });
}
