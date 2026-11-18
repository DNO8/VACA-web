'use client';

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { signMessage } from '@stellar/freighter-api';
import { useLang } from '@/lib/i18n';
import { adminFlowMessages } from '../lib/d1/admin-flow-messages';
import { browserAdminActionHistory, createAdminFlow, observeAdminOriginal, type AdminFlow, type RefundLane } from '../lib/d1/admin-flow';
import { readD1PublicConfig } from '../lib/d1/public-config';
import { openRefundJournal, type RefundJournal } from '../lib/d1/refund-journal';
import type { D1Config, D1Action } from '../lib/d1/commands';
import { originalDeadline } from '../lib/d1/receipt-context';

const control = 'min-h-12 w-full rounded border border-[var(--border-secondary)] bg-[var(--bg-secondary)] p-2 text-base text-[var(--text-primary)]';
const button = 'min-h-12 rounded border border-[var(--gold-primary)] px-3 py-2 text-xs text-[var(--gold-primary)] disabled:opacity-40';

/** Financial scope is supplied independently of VaquitaIncident and never inferred from curation. */
export default function D1AdminPanel({ admin }: { admin: string }) {
  const { lang } = useLang(), m = adminFlowMessages(lang), id = useId();
  const [config, setConfig] = useState<D1Config | null>(null);
  const [flow, setFlow] = useState<AdminFlow | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [result, setResult] = useState('');
  const [initial, setInitial] = useState<D1Action>('prepare');
  const [lane, setLane] = useState('');
  const [refundAction, setRefundAction] = useState<'status' | 'reconcile' | 'execute'>('status');
  const activeFlow = useRef<AdminFlow | null>(null), journal = useRef<RefundJournal | null>(null);
  const lifecycle = useRef<AbortController | null>(null), inFlight = useRef(false), generation = useRef(0);
  const errorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    const controller = new AbortController(); lifecycle.current = controller;
    return () => { generation.current++; controller.abort(); activeFlow.current?.dispose(); journal.current?.close(); };
  }, [admin]);
  function invalidate() {
    generation.current++; activeFlow.current?.dispose(); activeFlow.current = null;
    setFlow(null); setError(''); setResult('');
  }
  async function perform(action: (signal: AbortSignal) => Promise<string>) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError('');
    const current = generation.current, signal = lifecycle.current?.signal;
    try {
      if (!signal || signal.aborted) return;
      const message = await action(signal);
      if (!signal.aborted && current === generation.current) setResult(message);
    } catch (cause) {
      if (!signal?.aborted && current === generation.current) {
        setResult(''); setError(cause instanceof Error ? cause.message : 'd1_admin_unknown');
        // Focus the persistent error summary after React publishes its content.
        queueMicrotask(() => errorRef.current?.focus());
      }
    } finally {
      inFlight.current = false;
      if (!signal?.aborted) setBusy(false);
    }
  }
  function parse(text: string, max: number): unknown {
    if (new TextEncoder().encode(text).byteLength > max) throw new Error(m.oversized);
    try { return JSON.parse(text) as unknown; } catch { throw new Error(m.invalidJson); }
  }
  function observe(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void perform(async signal => {
      if (!config) throw new Error(m.noConfig);
      const snapshot = parse(String(data.get('snapshot')), 1048576);
      const preparation = String(data.get('preparation') ?? '').trim();
      const knownHash = String(data.get('issuanceHash') ?? '').trim();
      const current = generation.current;
      const fetcher: typeof fetch = (url, init) => {
        if (signal.aborted || generation.current !== current) return Promise.reject(new Error('d1_admin_stale'));
        return fetch(url, { ...init, signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal });
      };
      const original = await observeAdminOriginal(config, snapshot, fetcher);
      if (signal.aborted || generation.current !== current) throw new Error('d1_admin_stale');
      const history = browserAdminActionHistory(window.localStorage, navigator.locks);
      const store = journal.current ?? await openRefundJournal(window.indexedDB);
      if (signal.aborted || generation.current !== current) { store.close(); throw new Error('d1_admin_stale'); }
      journal.current = store;
      const context = { config, request_id: String(data.get('request_id')), admin, incident_id: original.evidence.incident_id, beneficiary: String(data.get('beneficiary')), amount: String(data.get('amount')), payment: original.evidence.payment };
      const next = createAdminFlow(config, original, context, { journal: store, history, signMessage, fetcher, knownIssuanceHash: knownHash || undefined, ...(preparation ? { preparationReceipt: parse(preparation, 65536) } : {}) });
      activeFlow.current?.dispose(); activeFlow.current = next; setFlow(next);
      return m.reviewReady;
    });
  }
  function request(event: FormEvent, refund: boolean) {
    event.preventDefault();
    void perform(async () => {
      const current = activeFlow.current;
      if (!current) throw new Error(m.noReview);
      const report = refund ? await current.refund(lane as RefundLane, refundAction) : await current.initial(initial);
      return m.accepted + '\n' + JSON.stringify(report, null, 2);
    });
  }
  const fields = [
    ['request_id', m.request, 'text', true], ['beneficiary', m.beneficiary, 'text', true],
    ['amount', m.amount, 'text', true], ['issuanceHash', m.issuanceHash, 'text', false],
  ] as const;
  return <section className="space-y-3 rounded-lg border border-[var(--gold-primary)]/40 p-3 text-xs" aria-labelledby={`${id}-title`}>
    <h2 id={`${id}-title`} className="font-bold text-[var(--text-heading)]">{m.title}</h2>
    <p>{m.authority}</p><p>{m.scope}</p>
    <button type="button" className={button} disabled={busy} onClick={() => {
      invalidate();
      void perform(async signal => {
        setConfig(null);
        const response = await readD1PublicConfig(signal);
        if (response.status !== 'available') throw new Error('d1_admin_config_unavailable');
        if (!signal.aborted) setConfig(response.config);
        return m.configReady;
      });
    }}>{m.config}</button>
    {config && <pre className="whitespace-pre-wrap break-all">{JSON.stringify(config, null, 2)}</pre>}
    <form method="post" aria-labelledby={`${id}-review`} onSubmit={observe} onChange={invalidate} className="space-y-3">
      <h3 id={`${id}-review`}>{m.original}</h3>
      <label className="block" htmlFor={`${id}-snapshot`}>{m.snapshot}</label>
      <textarea id={`${id}-snapshot`} name="snapshot" required maxLength={1048576} rows={5} spellCheck={false} autoCapitalize="none" aria-describedby={`${id}-snapshot-help`} className={control} disabled={busy} />
      <p id={`${id}-snapshot-help`}>{m.snapshotHelp}</p>
      {fields.map(([name, label, type, required]) => <div key={name}>
        <label className="block" htmlFor={`${id}-${name}`}>{label}</label>
        <input id={`${id}-${name}`} name={name} type={type} required={required} autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={name === 'amount' ? 20 : 64} pattern={name === 'amount' ? '(0|[1-9][0-9]{0,11})\\.[0-9]{7}' : undefined} inputMode={name === 'amount' ? 'decimal' : undefined} className={control} disabled={busy} />
      </div>)}
      <label className="block" htmlFor={`${id}-preparation`}>{m.preparation}</label>
      <textarea id={`${id}-preparation`} name="preparation" rows={3} maxLength={65536} spellCheck={false} className={control} disabled={busy} />
      <button type="submit" className={button} disabled={busy}>{m.review}</button>
    </form>
    {flow && <div className="space-y-3">
      <h3>{m.original}</h3>
      <pre className="whitespace-pre-wrap break-all">{JSON.stringify(flow.context, null, 2)}</pre>
      <p>{m.deadline}: {originalDeadline(flow.context.payment.confirmedAt)}</p>
      <form method="post" onSubmit={event => request(event, false)} aria-labelledby={`${id}-initial`}>
        <fieldset disabled={busy} className="space-y-2"><legend id={`${id}-initial`}>{m.initial}</legend>
          {(['prepare', 'issue', 'reconcile'] as const).map(action => <label key={action} className="flex min-h-12 items-center gap-2"><input type="radio" name="initialAction" value={action} checked={initial === action} onChange={() => { setInitial(action); setError(''); }} />{m[action]}</label>)}
          <button type="submit" className={button}>{m.initialSend} · {flow.context.amount}</button>
        </fieldset>
      </form>
      <form method="post" onSubmit={event => request(event, true)} aria-labelledby={`${id}-refund`} className="space-y-2">
        <h3 id={`${id}-refund`}>{m.refund}</h3>
        <label className="block" htmlFor={`${id}-lane`}>{m.lane}</label>
        <select id={`${id}-lane`} name="lane" required value={lane} onChange={event => { setLane(event.target.value); setError(''); }} disabled={busy} className={control}>
          <option value="">{m.selectLane}</option><option value="full_gross_v1">{m.full}</option><option value="verified_remainder_v2">{m.remainder}</option>
        </select>
        <fieldset disabled={busy} className="space-y-2"><legend>{m.refundAction}</legend>
          {(['status', 'reconcile', 'execute'] as const).map(action => <label key={action} className="flex min-h-12 items-center gap-2"><input type="radio" name="refundAction" value={action} checked={refundAction === action} onChange={() => { setRefundAction(action); setError(''); }} />{action === 'reconcile' ? m.refundReconcile : m[action]}</label>)}
          <p>{m.warning}</p><button type="submit" className={button}>{m.refundSend}</button>
        </fieldset>
      </form>
    </div>}
    <p ref={errorRef} role="alert" tabIndex={-1}>{error ? `${m.error} ${error}` : ''}</p>
    <div role="status" aria-live="polite" aria-atomic="true"><h3>{m.result}</h3><pre className="whitespace-pre-wrap break-all">{busy ? m.busy : result}</pre></div>
  </section>;
}
