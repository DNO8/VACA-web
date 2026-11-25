'use client';

import { useEffect, useState } from 'react';
import type { Lang } from '../lib/i18n';
import type { VoteFeedbackState } from '../lib/vote';

function eligibleInstant(value?: string): number | null {
  // The server supplies a timezone-qualified instant, not a local calendar date.
  if (!value || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const instant = Date.parse(value);
  return Number.isFinite(instant) ? instant : null;
}

export function voteWaitDeadline(feedback: VoteFeedbackState | null): number | null {
  if (!feedback || feedback.accepted || feedback.code !== 'wallet_too_new') return null;
  const instant = eligibleInstant(feedback.eligibleAt);
  if (instant !== null) return instant;
  const fallback = feedback.ageRetryAtMs;
  return typeof fallback === 'number' && Number.isSafeInteger(fallback) && fallback >= 0 && fallback <= 8.64e15 ? fallback : null;
}

export function voteWaitMessage(lang: Lang, deadline: number | null, nowMs: number): string | null {
  if (deadline === null || !Number.isFinite(deadline) || !Number.isFinite(nowMs)) return null;
  if (deadline <= nowMs) return lang === 'es'
    ? 'Ya pasó la espera indicada. Puedes volver a intentarlo. El servidor volverá a validar tu cuenta.'
    : 'The indicated wait has elapsed. You can try again. The server will validate your account again.';
  // These are elapsed seconds between absolute instants, not calendar/DST units.
  // Round upward so a positive remainder never announces that the wait is over.
  const totalMinutes = Math.ceil((deadline - nowMs) / 60000);
  const hours = Math.floor(totalMinutes / 60), minutes = totalMinutes % 60;
  const locale = lang === 'es' ? 'es-CL' : 'en-US';
  const DurationFormat = (Intl as typeof Intl & {
    DurationFormat?: new (locale: string, options: { style: 'long' }) => { format(value: { hours?: number; minutes?: number }): string };
  }).DurationFormat;
  const duration = DurationFormat
    ? new DurationFormat(locale, { style: 'long' }).format({ ...(hours ? { hours } : {}), ...(minutes ? { minutes } : {}) })
    : new Intl.ListFormat(locale, { type: 'conjunction' }).format(
      ([['hour', hours], ['minute', minutes]] as const).filter(([, value]) => value > 0)
        .map(([unit, value]) => new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'long' }).format(value)),
    );
  return lang === 'es'
    ? `${totalMinutes === 1 || totalMinutes === 60 ? 'Te falta' : 'Te faltan'} ${duration} para poder votar.`
    : `You have ${duration} left before you can vote.`;
}

/** A ledger proof and the server's vote decision are separate results. */
export default function VoteFeedback({ lang, feedback }: { lang: Lang; feedback: VoteFeedbackState | null }) {
  const [, refreshClock] = useState(0);
  const deadline = voteWaitDeadline(feedback);
  useEffect(() => {
    if (deadline === null || deadline <= Date.now()) return;
    const timer = setInterval(() => {
      refreshClock((tick) => tick + 1);
      if (Date.now() >= deadline) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [deadline]);
  if (!feedback) return null;
  const waitMessage = voteWaitMessage(lang, deadline, Date.now());
  const es = lang === 'es';
  const hash = feedback.txHash && /^[a-f0-9]{64}$/i.test(feedback.txHash) ? feedback.txHash : null;
  const eligible = eligibleInstant(feedback.eligibleAt) !== null ? feedback.eligibleAt : null;
  const hours = feedback.minAgeSeconds && Number.isFinite(feedback.minAgeSeconds) && feedback.minAgeSeconds > 0
    ? feedback.minAgeSeconds / 3600 : 24;
  let title: string;
  let detail = '';
  if (feedback.accepted) {
    title = es ? 'Voto registrado por VACA' : 'Vote recorded by VACA';
  } else if (feedback.code === 'wallet_too_new') {
    title = es ? 'Voto no registrado: falta antigüedad' : 'Vote not recorded: account too new';
    detail = es
      ? `Tu cuenta de Stellar Testnet debe tener al menos ${hours} horas. Se cuenta desde su creación en Testnet, no desde la instalación de la wallet.`
      : `Your Stellar Testnet account must be at least ${hours} hours old. This is measured from its creation on Testnet, not when you installed the wallet.`;
  } else if (feedback.code === 'wallet_age_unavailable') {
    title = es ? 'Voto no registrado: antigüedad no verificable' : 'Vote not recorded: account age unavailable';
    detail = es ? 'No pudimos verificar la fecha de creación en Stellar. Esto no significa que tu cuenta sea nueva.'
      : 'We could not verify the creation date on Stellar. This does not mean your account is new.';
  } else if (feedback.code === 'already_voted') {
    title = es ? 'Ya hay un voto de esta wallet para esta señal' : 'This wallet has already voted for this signal';
  } else if (feedback.code === 'cooldown') {
    title = es ? 'Voto no registrado: espera entre votos' : 'Vote not recorded: voting cooldown';
  } else if (feedback.code === 'tx_invalid') {
    title = es ? 'Voto no registrado: prueba no validada' : 'Vote not recorded: proof not validated';
    detail = es ? 'El servidor no pudo validar esta transacción como prueba del voto.' : 'The server could not validate this transaction as vote proof.';
  } else {
    title = hash
      ? (es ? 'No pudimos confirmar el registro' : 'We could not confirm vote registration')
      : (es ? 'No se completó el voto' : 'Voting did not complete');
    detail = hash ? (es ? 'La transacción en Stellar no confirma por sí sola el registro en VACA.'
      : 'The Stellar transaction alone does not confirm registration in VACA.') : (feedback.message ?? '');
  }
  return (
    <div className="mt-3 space-y-2 text-xs leading-relaxed text-[var(--text-secondary)]">
      <div role="status" aria-live="polite" aria-atomic="true" className="space-y-2">
        <p className="font-semibold text-[var(--text-heading)]">{title}</p>
        {detail && <p>{detail}</p>}
        {feedback.code === 'wallet_too_new' && eligible && (
          <p>{es ? 'Podrás votar desde: ' : 'You can vote from: '}
            <time dateTime={eligible}>{new Intl.DateTimeFormat(es ? 'es-CL' : 'en-US', {
              dateStyle: 'medium', timeStyle: 'long',
            }).format(new Date(eligible))}</time>
          </p>
        )}
      </div>
      {waitMessage && <p role="timer" aria-live="off">{waitMessage}</p>}
      {hash && (
        <p>
          {es ? 'Transacción confirmada en Stellar Testnet. ' : 'Transaction confirmed on Stellar Testnet. '}
          <a href={`https://stellar.expert/explorer/testnet/tx/${hash}`} target="_blank" rel="noreferrer"
            className="break-all text-[var(--cyan-primary)] underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">
            {es ? 'Ver transacción en Stellar Expert' : 'View transaction on Stellar Expert'}
          </a>
        </p>
      )}
      {hash && !feedback.accepted && <p>{es
        ? 'No vuelvas a firmar solo para comprobar el resultado. Conserva el enlace de esta transacción.'
        : 'Do not sign again just to check the result. Keep this transaction link.'}</p>}
    </div>
  );
}
