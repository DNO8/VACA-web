'use client';

import React, { useEffect, useState } from 'react';
import { readD1PublicConfig, type PublicConfigResult } from '../lib/d1/public-config';
import { useLang, type StrKey } from '../lib/i18n';

type State = PublicConfigResult | { status: 'loading' };
type Props = { state: State; t: (key: StrKey, vars?: Record<string, string | number>) => string };

export function D1ReadinessView({ state, t }: Props) {
  const message = state.status === 'available' ? 'd1_config_available'
    : state.status === 'loading' ? 'd1_config_loading' : 'd1_config_unavailable';
  return (
    <section className="rounded-lg border border-[var(--border-secondary)] bg-[var(--bg-secondary)] p-3 text-xs">
      <p role="status" aria-live="polite" className="font-semibold text-[var(--text-heading)]">{t(message)}</p>
      {state.status === 'available' && (
        <div className="mt-1.5 space-y-1 text-[var(--text-secondary)]">
          <p>{state.config.network} · {t('d1_config_ttl', { seconds: state.config.donation_ttl_seconds })}</p>
          <p className="break-all">{t('d1_config_pool')} <code>{state.config.pool_public_key}</code></p>
        </div>
      )}
      <p className="mt-1.5 text-[11px] leading-snug text-[var(--text-muted)]">{t('d1_legacy_payment_notice')}</p>
    </section>
  );
}

export default function D1Readiness() {
  const { t } = useLang();
  const [state, setState] = useState<State>({ status: 'loading' });
  useEffect(() => {
    const controller = new AbortController();
    void readD1PublicConfig(controller.signal).then(result => {
      if (!controller.signal.aborted && result.status !== 'cancelled') setState(result);
    });
    return () => controller.abort();
  }, []);
  return <D1ReadinessView state={state} t={t} />;
}
