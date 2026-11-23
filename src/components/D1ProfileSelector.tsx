'use client';

import { useId } from 'react';
import { useLang } from '../lib/i18n';
import type { D1Profile } from '../lib/d1/profile';

export default function D1ProfileSelector({ profile, disabled, onChange }: {
  profile: D1Profile; disabled: boolean; onChange: (profile: D1Profile) => void;
}) {
  const id = useId(), { t } = useLang();
  return <fieldset disabled={disabled} aria-describedby={`${id}-help`} className="space-y-1 text-xs">
    <legend className="font-semibold text-[var(--text-heading)]">{t('d1_profile')}</legend>
    {(['A', 'B'] as const).map(value => <div key={value} className="flex min-h-12 items-center gap-2">
      <input id={`${id}-${value}`} name={`${id}-profile`} type="radio" value={value} checked={profile === value}
        onChange={() => { if (!disabled) onChange(value); }} />
      <label htmlFor={`${id}-${value}`} className="flex min-h-12 items-center">{t(value === 'A' ? 'd1_profile_a' : 'd1_profile_b')}</label>
    </div>)}
    <p id={`${id}-help`} className="text-[var(--text-muted)]">{t('d1_profile_help')}</p>
  </fieldset>;
}
