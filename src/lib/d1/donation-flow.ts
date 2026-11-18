import type { DonationJournalV2 } from './donation-journal';
import { readDonationAccount } from './donation-account';
import { donationRecovery, recoverDonation, validateDonationScope, type DonationScope } from './donation-recovery';
import { acquireDonation, signDonation, type DonationSession, type SignDonationTransaction } from './donation-session';
import { createDonationIntent } from './donation-transaction';
import { submitDonation } from './donation-submission';
import { observeDonation } from './donation-observation';

export type DonationFlowOptions = DonationScope & Readonly<{
  journal: DonationJournalV2;
  signTransaction: SignDonationTransaction;
  fetcher?: typeof fetch;
  uuid?: () => string;
  now?: () => number;
}>;
/** Decimal text only: no float conversion, rounding, truncation or silent locale substitution. */
function nativeAmount(input: string): string {
  if (typeof input !== 'string' || !/^(0|[1-9][0-9]{0,11})(\.[0-9]{1,7})?$/.test(input)) throw new Error('d1_flow_invalid_amount');
  const [whole, fraction = ''] = input.split('.');
  const amount = `${whole}.${fraction.padEnd(7, '0')}`;
  if (BigInt(amount.replace('.', '')) <= BigInt(0) || BigInt(amount.replace('.', '')) > BigInt('9223372036854775807')) throw new Error('d1_flow_invalid_amount');
  return amount;
}

/** Explicit actions only. Durable journal arbitration, never a UI flag, owns send exclusion. */
export function createDonationFlow(options: DonationFlowOptions) {
  const context = validateDonationScope(options), { journal, signTransaction } = options;
  const fetcher = options.fetcher ?? globalThis.fetch;
  const uuid = options.uuid ?? (() => globalThis.crypto.randomUUID());
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const controller = new AbortController();
  let busy = false;
  const active = () => { if (controller.signal.aborted) throw new Error('d1_flow_inactive'); };
  async function exclusive<T>(action: () => Promise<T>): Promise<T> {
    active();
    if (busy) throw new Error('d1_flow_busy');
    busy = true;
    try { return await action(); } finally { busy = false; }
  }
  async function original(session: DonationSession) {
    const recovery = await recoverDonation(journal, context); active();
    if (!recovery || JSON.stringify(recovery.session.snapshot.intent) !== JSON.stringify(session.snapshot.intent)) throw new Error('d1_flow_original_mismatch');
    return recovery.session;
  }
  return Object.freeze({
    dispose() { controller.abort(); },
    async recover() { active(); const result = await recoverDonation(journal, context); active(); return result; },
    prepare(input: string) {
      return exclusive(async () => {
        const retained = await recoverDonation(journal, context); active();
        if (retained) return retained;
        const amount = nativeAmount(input);
        const sequence = await readDonationAccount(context.donor, controller.signal, fetcher); active();
        // A scope may have won while the read was pending; don't even propose another UUID then.
        const winner = await recoverDonation(journal, context); active();
        if (winner) return winner;
        const time = now();
        if (!Number.isSafeInteger(time) || time < 0 || !Number.isSafeInteger(time + 180)) throw new Error('d1_flow_invalid_clock');
        const intent = createDonationIntent(context.config, {
          request_id: uuid(), donor: context.donor, incident_id: context.incidentId, asset: { type: 'native' }, amount,
        });
        active();
        const acquired = await acquireDonation(journal, intent, { sequence, fee: '100', timebounds: { minTime: 0, maxTime: time + 180 } });
        return donationRecovery(acquired.record);
      });
    },
    sign(session: DonationSession) {
      return exclusive(async () => {
        const retained = await original(session);
        return signDonation(journal, retained.snapshot.intent, async (wire, settings) => { active(); return signTransaction(wire, settings); });
      });
    },
    send(session: DonationSession) {
      return exclusive(async () => {
        const retained = await original(session);
        return submitDonation(journal, retained.snapshot.intent, fetcher);
      });
    },
    check(session: DonationSession) {
      return exclusive(async () => {
        const retained = await original(session);
        return observeDonation(journal, retained.snapshot.intent, fetcher);
      });
    },
  });
}
export type DonationFlow = ReturnType<typeof createDonationFlow>;
