'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { signTransaction } from '@stellar/freighter-api';
import { useLang, type StrKey } from '../lib/i18n';
import type { D1Config } from '../lib/d1/commands';
import { readD1PublicConfig } from '../lib/d1/public-config';
import { openDonationJournal, type DonationJournalV2 } from '../lib/d1/donation-journal';
import { createDonationFlow, type DonationFlow } from '../lib/d1/donation-flow';
import { donationRecovery, type DonationRecovery } from '../lib/d1/donation-recovery';

type Status = 'loading' | 'connect' | 'ready' | 'prepared' | 'signed' | 'submitted_unverified' | 'observed' | 'unresolved' | 'unavailable';
const statusKeys: Record<Status, StrKey> = {
  loading: 'd1_config_loading', connect: 'd1_connect', ready: 'd1_ready', prepared: 'd1_prepared', signed: 'd1_signed',
  submitted_unverified: 'd1_submitted_unverified', observed: 'd1_observed', unresolved: 'd1_unresolved', unavailable: 'd1_config_unavailable',
};
type ViewProps = {
  config: D1Config | null; recovery: DonationRecovery | null; amount: string; busy: boolean; status: Status; error: string;
  t: (key: StrKey, vars?: Record<string, string | number>) => string;
  onAmountChange: (amount: string) => void;
  onPrepare: () => void; onSign: () => void; onSend: () => void; onCheck: () => void; onRecover: () => void;
};
const buttonClass = 'min-h-12 w-full rounded border border-[var(--gold-primary)] px-2 py-2 text-xs font-semibold text-[var(--gold-primary)] disabled:opacity-40';

/** Rendering boundary also used by offline accessibility/state checks. No financial effects. */
export function D1DonationView({ config, recovery, amount, busy, status, error, t, onAmountChange, onPrepare, onSign, onSend, onCheck, onRecover }: ViewProps) {
  const id = useId();
  const original = recovery?.session.snapshot;
  return (
    <section className="space-y-2 text-xs" aria-busy={busy}>
      <h3 id={`${id}-title`} className="font-semibold text-[var(--text-heading)]">{t('d1_donation_title')}</h3>
      <p role="status" aria-live="polite">{t(statusKeys[status])}{busy ? ` · ${t('d1_working')}` : ''}</p>
      <p className="text-[var(--text-muted)]">{t('d1_repeat_limit')}</p>
      {config && <p className="break-all">TESTNET · {t('d1_config_pool')} <code>{config.pool_public_key}</code></p>}
      {config && !original && status !== 'unavailable' && (
        <form method="post" aria-labelledby={`${id}-title`} onSubmit={event => { event.preventDefault(); onPrepare(); }} className="space-y-2">
          <label htmlFor={`${id}-amount`} className="block">{t('amount_aria')} · {t('d1_required')}</label>
          <input id={`${id}-amount`} name="amount" type="text" inputMode="decimal" required pattern="(0|[1-9][0-9]{0,11})(\.[0-9]{1,7})?"
            value={amount} disabled={busy} aria-invalid={error ? true : undefined} aria-describedby={`${id}-amount-help${error ? ` ${id}-error` : ''}`}
            onChange={event => onAmountChange(event.target.value)}
            className="min-h-12 w-full rounded border border-[var(--border-primary)] bg-transparent px-2 text-base text-[var(--text-primary)]" />
          <p id={`${id}-amount-help`}>{t('d1_amount_help')}</p>
          <button type="submit" disabled={busy} className={buttonClass}>{t('d1_prepare')}</button>
        </form>
      )}
      {original && recovery && (
        <div className="space-y-2 break-all">
          <p className="font-semibold">{t('d1_retained_amount')}: {original.intent.amount} XLM</p>
          <p>{t('d1_config_pool')} <code>{original.intent.config.pool_public_key}</code></p>
          <p>{t('d1_incident')}: <code>{original.intent.incident_id}</code></p>
          <p>{t('d1_donor')}: <code>{original.intent.donor}</code></p>
          <p>{t('d1_namespace')}: <code>{original.intent.config.namespace}</code></p>
          <p>{t('d1_request')}: <code>{original.intent.request_id}</code></p>
          <p>{t('d1_original_hash')}: <code>{original.transactionHash}</code></p>
          <p>{t('d1_memo_note')}</p>
          {recovery.deadline && <p>{t('d1_original_deadline')}: <time dateTime={recovery.deadline}>{recovery.deadline}</time></p>}
          {recovery.evidence && <p>{t('d1_cached_evidence_notice')}</p>}
          {recovery.session.state === 'intent' && <button type="button" disabled={busy} onClick={onSign} className={buttonClass}>{t('d1_sign', { amount: original.intent.amount })}</button>}
          {recovery.session.state === 'signed' && <button type="button" disabled={busy} onClick={onSend} className={buttonClass}>{t('d1_send', { amount: original.intent.amount })}</button>}
          {recovery.session.state === 'submission_claimed' && <button type="button" disabled={busy} onClick={onCheck} className={buttonClass}>{t('d1_check_original')}</button>}
        </div>
      )}
      {config && <button type="button" disabled={busy} onClick={onRecover} className={buttonClass}>{t('d1_recover')}</button>}
      <p className="text-[var(--text-muted)]">{t('d1_delivery_unknown')}</p>
      <p className="text-[var(--text-muted)]">{t('d1_settlement_unknown')}</p>
      {error && <p id={`${id}-error`} role="alert" aria-live="assertive" tabIndex={-1} className="text-red-400">{t('d1_action_error')} <code>{error}</code></p>}
    </section>
  );
}
function statusFor(recovery: DonationRecovery | null): Status {
  if (!recovery) return 'ready';
  if (recovery.evidence) return 'observed';
  return recovery.session.state === 'intent' ? 'prepared' : recovery.session.state === 'signed' ? 'signed' : 'submitted_unverified';
}
function safeError(error: unknown): string {
  return error instanceof Error && /^d1_[a-z_]+$/.test(error.message) ? error.message : 'd1_flow_unavailable';
}

export default function D1DonationPanel({ wallet, incidentId, onBusyChange, externalBusy = false }: {
  wallet: string | null; incidentId: string; onBusyChange?: (busy: boolean) => void; externalBusy?: boolean;
}) {
  const { t } = useLang();
  const [config, setConfig] = useState<D1Config | null>(null);
  const [recovery, setRecovery] = useState<DonationRecovery | null>(null);
  const [amount, setAmount] = useState('5');
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  const flowRef = useRef<DonationFlow | null>(null);
  const generation = useRef(0);
  const inFlight = useRef(false);
  const regionRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (error) regionRef.current?.querySelector<HTMLElement>('[role="alert"]')?.focus(); }, [error]);
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);
  useEffect(() => {
    const version = ++generation.current;
    const controller = new AbortController();
    let journal: DonationJournalV2 | undefined, flow: DonationFlow | undefined;
    const current = () => !controller.signal.aborted && generation.current === version;
    setConfig(null); setRecovery(null); setError(''); setBusy(!!wallet); setStatus(wallet ? 'loading' : 'connect');
    flowRef.current = null; inFlight.current = false;
    if (wallet) void (async () => {
      try {
        const result = await readD1PublicConfig(controller.signal);
        if (!current()) return;
        if (result.status !== 'available') throw new Error('d1_config_unavailable');
        journal = await openDonationJournal(globalThis.indexedDB, 'vaca-d1-donations');
        if (!current()) { journal.close(); return; }
        flow = createDonationFlow({ config: result.config, donor: wallet, incidentId, journal, signTransaction });
        const retained = await flow.recover();
        if (!current()) return;
        flowRef.current = flow; setConfig(result.config); setRecovery(retained); setStatus(statusFor(retained));
      } catch (failure) {
        if (current()) { setError(safeError(failure)); setStatus('unavailable'); }
      } finally { if (current()) setBusy(false); }
    })();
    return () => { controller.abort(); flow?.dispose(); journal?.close(); generation.current++; flowRef.current = null; };
  }, [wallet, incidentId]);

  async function run(action: 'prepare' | 'sign' | 'send' | 'check' | 'recover') {
    const flow = flowRef.current, version = generation.current;
    if (!flow || inFlight.current || externalBusy) return;
    const current = () => generation.current === version && flowRef.current === flow;
    inFlight.current = true; setBusy(true); setError('');
    try {
      let retained = recovery;
      let nextStatus: Status | undefined;
      if (action === 'prepare') retained = await flow.prepare(amount);
      else if (action === 'recover') retained = await flow.recover();
      else if (retained) {
        if (action === 'sign') retained = donationRecovery(await flow.sign(retained.session));
        else if (action === 'send') {
          await flow.send(retained.session);
          retained = await flow.recover(); nextStatus = 'submitted_unverified';
        }
        else if (action === 'check') {
          const observation = await flow.check(retained.session);
          retained = donationRecovery(retained.session, observation.state === 'observed' ? observation.evidence : retained.evidence);
          nextStatus = observation.state === 'observed' ? 'observed' : 'unresolved';
        }
      }
      if (current()) { setRecovery(retained); setStatus(nextStatus ?? statusFor(retained)); }
    } catch (failure) {
      // A failed claim acknowledgement may still have persisted. Read back; never offer a fresh payment as recovery.
      let retained: DonationRecovery | null = null;
      let readable = false;
      try { retained = await flow.recover(); readable = true; } catch { /* Keep failure closed and visible. */ }
      if (current()) {
        setRecovery(retained); setStatus(readable ? statusFor(retained) : 'unavailable'); setError(safeError(failure));
      }
    } finally { if (current()) { inFlight.current = false; setBusy(false); } }
  }
  return <div ref={regionRef}><D1DonationView config={config} recovery={recovery} amount={amount} busy={busy || externalBusy} status={status} error={error} t={t}
    onAmountChange={value => { setAmount(value); setError(''); }} onPrepare={() => void run('prepare')}
    onSign={() => void run('sign')} onSend={() => void run('send')} onCheck={() => void run('check')} onRecover={() => void run('recover')} /></div>;
}
