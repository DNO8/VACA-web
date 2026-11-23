import type { D1Config } from './commands';

export type D1Profile = 'A' | 'B';
export const D1_B = Object.freeze({
  origin: 'https://tgqxxnldwiqisopiclmk.supabase.co',
  namespace: '8126a1f4-ed8a-41ec-905b-9ad3442e5e6e',
  pool: 'GAYWVFBP2YPYMU245D6AOE7WWTVZOWGPVIFVGOH5EFFSSQ3VZAVR5JCW',
});

export function profileBase(profile: D1Profile): string {
  if (profile === 'A') return '/api/d1';
  if (profile === 'B') return '/api/d1/video-auto';
  throw new Error('d1_profile_unavailable');
}

/** Deployment selection is not authority, and never rewrites a retained original. */
export function assertProfileConfig(profile: D1Profile, config: D1Config): void {
  profileBase(profile);
  if (profile === 'B' ? config.network !== 'TESTNET' || config.donation_ttl_seconds !== 300 || config.namespace !== D1_B.namespace || config.pool_public_key !== D1_B.pool
    : config.pool_public_key === D1_B.pool) throw new Error('d1_profile_scope_mismatch');
}

export function matchesBCommand(value: unknown, route: string): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const command = value as Record<string, unknown>;
  // v1 prepare's signed schema has NO namespace. Do not inject one or alter its proof.
  return command.network === 'TESTNET' && command.pool === D1_B.pool &&
    (command.namespace === D1_B.namespace || (route === 'prepare' && command.namespace === undefined));
}

/** Adapt the existing sender's fixed A paths, keeping journal/capability logic intact. */
export function profileCommandFetcher(profile: D1Profile, fetcher: typeof fetch): typeof fetch {
  const base = profileBase(profile);
  if (profile === 'A') return fetcher;
  return (input, init) => {
    const match = typeof input === 'string' && /^\/api\/d1\/(prepare|issue|reconcile|refund(?:-status|-reconcile|-remainder(?:-status|-reconcile)?)?)$/.exec(input);
    if (!match) return Promise.reject(new Error('d1_profile_unavailable'));
    try {
      if (typeof init?.body !== 'string' || !matchesBCommand(JSON.parse(init.body), match[1])) throw new Error();
    } catch { return Promise.reject(new Error('d1_profile_scope_mismatch')); }
    return fetcher(`${base}/${match[1]}`, init);
  };
}
