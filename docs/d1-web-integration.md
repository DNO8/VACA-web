# D1 same-origin custody transport

T1 adds a server-only transport to the existing D1 backend, not a replacement backend or a payment UI. No official wallet is needed to configure or test this transport. Provisional personal wallets remain a separate integration concern; this unit never signs, pays, issues automatically, or handles pool secrets.

## Server setup

Set these server environment variables through your deployment's configuration mechanism. Do not put them in `NEXT_PUBLIC_*` variables or commit their values.

| Variable | Required value |
| --- | --- |
| `D1_CUSTODY_SUPABASE_URL` | HTTPS origin of the matching Supabase project: exactly 20 lowercase alphanumeric characters followed by `.supabase.co`. A root slash is allowed; userinfo, ports, other paths, query strings and fragments are not. |
| `D1_CUSTODY_ANON_KEY` | That project's public legacy anon JWT. The deployed gateway requires `verify_jwt=true`, so a publishable key is not a usable substitute. |
| `D1_CUSTODY_NAMESPACE` | The matching deployed D1 namespace, as a canonical lowercase UUID. Obtain it from deployment configuration; do not generate a new namespace for this web integration. |

There is no service-role or alternate-secret fallback. The local JWT syntax, HS256 header, `role=anon`, and project `ref` checks guard against accidental misconfiguration; they are **not cryptographic JWT authentication**. The gateway verifies the JWT, and the backend verifies each administrator's personal wallet proof. An anon gateway credential never substitutes for that proof or grants administrator authority. Namespace correctness across deployments remains the operator's responsibility: the backend config does not expose a namespace to compare.

## HTTP contract

| Same-origin route | Method | Fixed upstream action |
| --- | --- | --- |
| `/api/d1/config` | GET | `/functions/v1/d1-custody/config` |
| `/api/d1/prepare` | POST | `/functions/v1/d1-custody/prepare` |
| `/api/d1/issue` | POST | `/functions/v1/d1-custody/issue` |
| `/api/d1/reconcile` | POST | `/functions/v1/d1-custody/reconcile` |

Only the configured Supabase origin is used. Other actions, methods, query strings and noncanonical route paths are rejected before fetch. Request headers and body fields cannot select a destination or gateway credential. Incoming authorization, cookies and API keys are never forwarded. Outgoing headers contain only the configured anon Bearer/API key and JSON content/accept headers; credentials are omitted, redirects are not followed, and every response is `Cache-Control: no-store`.

POST requires `application/json` (parameters such as charset are allowed), a JSON object and at most **8192 streamed bytes**, regardless of Content-Length. Accepted bytes are forwarded unchanged: no reserialization, signature rewrite or extra namespace injection. Command schema and personal authorization remain backend responsibilities.

There is exactly one upstream fetch attempt, with a **10-second abort deadline** covering fetch and response reading. There is no retry, polling, redirect or automatic reconciliation. Upstream JSON is limited to **65536 streamed bytes**. GET config requires exactly `network: TESTNET`, a checksum-valid Stellar `pool_public_key`, and `donation_ttl_seconds: 300`; the response adds the configured public namespace. POST preserves successful JSON and HTTP status, including **202 pending/unverified**, without inferring inclusion or settlement. Non-success backend responses are relayed only as a sole `{error: safe_code}` field (1–64 lowercase alphanumeric/underscore characters, starting with a letter). Upstream headers and malformed/error details are never exposed or logged.

| Local status | JSON error code |
| --- | --- |
| 400 | `invalid_path`, `invalid_json` |
| 404 / 405 | `unsupported_action` / `method_not_allowed` |
| 413 / 415 | `body_too_large` / `unsupported_media_type` |
| 503 | `configuration_error` |
| 502 | `upstream_unavailable`, `invalid_upstream_response` |
| 504 | `upstream_timeout` |

## Offline verification

Run `pnpm test:d1` or `node node_modules/@playwright/test/cli.js test --config playwright.d1.config.ts`. This separate configuration runs only `tests/d1/**/*.spec.ts` and the existing `tests/e2e/stellar-contracts.spec.ts`, without a server, browser launch or live Testnet. It uses mock credentials and injected fetch, zero retries, fail-fast reporting, and unique operating-system temporary output directories. Follow with `node node_modules/typescript/bin/tsc --noEmit --incremental false` for type checking.

Review the boundary in `src/lib/d1/server-proxy.ts`, the thin Next 15 Promise-params adapter in `src/app/api/d1/[action]/route.ts`, and the observable contract in `tests/d1/proxy.spec.ts`. Existing donation/admin/Stellar helpers are unchanged. Wallet proof, payment intent, receipts, UI, phone coordination and live financial journeys are later tasks.

**Configuration, authenticated reads and passing offline tests are not financial acceptance.** Neither a reachable backend nor a successful reconcile response proves final full-principal settlement. Deployment and live actions require separate coordination and authorization.
