'use client';

import { useCallback, useRef, useState } from 'react';
import { useLang } from '../lib/i18n';
import type { D1Profile } from '../lib/d1/profile';
import D1ProfileSelector from './D1ProfileSelector';
import D1Readiness from './D1Readiness';
import D1DonationPanel from './D1DonationPanel';

/** One explicit selection supplies BOTH the technical read and the financial flow. */
export default function D1DonationSection({ wallet, incidentId, enabled, externalBusy, onBusyChange }: {
  wallet: string | null; incidentId: string; enabled: boolean; externalBusy: boolean; onBusyChange: (busy: boolean) => void;
}) {
  const { t } = useLang();
  const [profile, setProfile] = useState<D1Profile>('A'), [busy, setBusy] = useState(false);
  const executing = useRef(false);
  const updateBusy = useCallback((value: boolean) => {
    executing.current = value; setBusy(value);
  }, []);
  return <div className="space-y-3">
    <D1ProfileSelector profile={profile} disabled={busy || externalBusy} onChange={value => {
      if (!executing.current && !externalBusy) setProfile(value);
    }} />
    <D1Readiness key={profile} profile={profile} />
    {enabled ? <D1DonationPanel key={`${profile}:${incidentId}:${wallet ?? ''}`} profile={profile} wallet={wallet} incidentId={incidentId}
      onBusyChange={onBusyChange} onExecutionChange={updateBusy} externalBusy={externalBusy} /> : <p className="mt-2 text-[10px] leading-snug text-[var(--text-muted)]">{t('donate_disabled')}</p>}
  </div>;
}
