# Explicit D1 A/B web profiles

A is the default on each donor/Admin panel. Select **A · original (default)** or **B · video-auto (separate pool)** using the native labeled radio group (ES/EN). This is deployment selection, not administrator authority, permission to resend, financial acceptance or backend activation.

## Fixed routing and public pins

| Profile | Same-origin prefix | Backend prefix |
| --- | --- | --- |
| A (unchanged) | `/api/d1/` | `/functions/v1/d1-custody/` |
| B | `/api/d1/video-auto/` | `/functions/v1/d1-custody/video-auto/` |

Both prefixes allow only GET `config` and POST `prepare`, `issue`, `reconcile`, `refund-status`, `refund`, `refund-reconcile`, `refund-remainder-status`, `refund-remainder`, `refund-remainder-reconcile`. No arbitrary URL, route fallback, query selector or automatic financial action exists.

B pins are public, not credentials:

- Project origin: `https://tgqxxnldwiqisopiclmk.supabase.co`
- Namespace: `8126a1f4-ed8a-41ec-905b-9ad3442e5e6e`
- Pool: `GAYWVFBP2YPYMU245D6AOE7WWTVZOWGPVIFVGOH5EFFSSQ3VZAVR5JCW`
- Network/TTL: `TESTNET`, `300` seconds from original confirmation.

The existing server environment variables retain their A meanings; do not change the global origin or A namespace to select B. The B route requires the existing configured project origin and gateway JWT project ref to match the pinned project, otherwise `503 configuration_error`. It uses its own fixed namespace, not the A namespace variable. No new secret, environment file, dependency or backend setup is introduced.

Both proxy config responses retain the exact public DTO contract. B rejects a foreign pool/network/TTL or extra upstream fields with `502 invalid_upstream_response`; the client also rejects a mismatched namespace/pool/network/TTL. A explicitly refuses the B pool so an A namespace can never silently be advertised with B funding. The backend config does not echo namespace: the fixed B route/binding and locally pinned namespace are configuration, not independently authenticated financial scope.

## Original and proof boundaries

- Donor readiness and donation share one selection. Admin configuration and every initial/refund command share its own selection. Neither view infers a profile from an incident, receipt, imported original or response `safeActions`.
- Existing `readD1PublicConfig(signal, fetcher?, timeoutMs?)` and `postAdminCommand(route, body, fetcher)` calls remain A. An optional fourth `profile` argument selects B; invalid selections fail closed. `createAdminFlow` accepts optional `dependencies.profile`, default A.
- B rejects a foreign command network/pool/namespace before IO. **v1 prepare intentionally has no namespace**: the original builder and proof schema remain unchanged. No field or signature is injected, normalized or re-signed. Backend schema, proof, membership and financial preconditions remain authoritative.
- The B adapter reuses the existing bounded proxy and refund receipt parser. The existing refund sender obtains the same durable winner/one-use capability; a small fixed-route fetch adapter changes only the endpoint. It never recreates a capability from stored bytes or bypasses preflight.
- Original signed snapshots, allocation-versus-gross checks, issuance hashes, receipt validation, confirmation deadlines and journal keys remain owned by existing helpers. B scopes use their own pinned pool/namespace; switching back exposes the original A scope and its retained holds, never new resend permission.

## Lifecycle and accessibility

Each group uses a fieldset/legend, unique radio name/IDs and explicit visible labels. Native arrows, Tab/Space and focus indication are retained. Selecting a profile changes only configuration context; it never submits a financial form. Configuration reads can be superseded without stealing keyboard focus. Active financial actions lock selection synchronously, including wallet and durable-storage waits.

Profile changes abort/dispose the old context, clear its visible config/review/results and suppress late completions. Unmounted donation/Admin network adapters refuse a new send even after a storage wait. Disposal leaves any acquired hold retained. Returning to the original profile is read/review recovery, not release/reset/renewal. Storage eviction, malicious same-origin code, another browser/device and backend correctness remain outside client exclusion.

Stable profile errors: `d1_profile_unavailable` (unknown selection/adapter route) and `d1_profile_scope_mismatch` (foreign public configuration or B command). Public reads return unavailable instead of exposing exceptions; proxies retain their sanitized machine-error contract. Unknown financial results remain unknown.

## Offline evidence and limits

`tests/d1/profile.spec.ts` covers public API route agreement, pin/scope rejection, default A preservation, exact bytes, gateway errors, limits and redirect refusal. `refund-proxy.spec.ts` exercises all six B adapter routes and existing receipt states. `admin-flow.spec.ts` exercises actual synthetic personal signatures, original-bound parsers and the existing refund capability, including retained A/B histories.

Sandboxed browser regressions cover native selection/focus and real ES/EN strings, late A config after B selection, busy exclusion, original-specific donor recovery, review invalidation, unmount suppression and real IndexedDB A/B hold retention across reload. UI financial ports are synthetic; journal cases deliberately use opaque bytes and do not claim signature validity. No Next/env loader, external network, live wallet/backend or financial execution is used.

Run the project's offline Playwright D1 suite with its already-provisioned sandboxed Chromium/runtime and TypeScript `--noEmit --incremental false`. Temporary test output stays in fresh system-temp directories. Independent review, publication, deployment and live financial acceptance remain separately owned; this implementation makes no such claim.
