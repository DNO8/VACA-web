# D1 custody transport and personal command proofs

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

## T2a: command construction and personal proof

The browser-safe `src/lib/d1/commands.ts` and `wallet-proof.ts` add **offline command/proof helpers only**, without importing the server proxy. They do not submit commands, create pools, retain state, decode receipts or change the existing donation/admin flows.

1. Supply matching public configuration from `/api/d1/config`: exactly `network`, `pool_public_key`, `namespace`, `donation_ttl_seconds`. `validateD1Config(config)` validates and freezes a copy; deployment matching remains the operator's responsibility.
2. Call `buildD1Command(config, {action, request_id, timestamp, wallet, payload}, clock?)`. The caller chooses the lowercase UUID request ID and Unix-seconds timestamp **once**. The optional clock returns safe-integer Unix seconds; default is `Math.floor(Date.now()/1000)`. `validateD1Command(config, unknownCommand, clock?)` also accepts complete unsigned wire commands and returns a deeply frozen snapshot.
3. Call `signD1Command(config, command, signMessage, clock?)`, injecting Freighter's `signMessage` API or an offline equivalent. It returns a frozen signed command with a canonical standard-base64 `signature`; `JSON.stringify(result)` is a possible transport body, but this helper never sends it. There is at most one wallet call, no implicit request generation, timestamp renewal, re-signing or retries.

| Command | Exact unsigned fields | Payload |
| --- | --- | --- |
| `prepare` | `version`, `network`, `pool`, `action`, `request_id`, `timestamp`, `payload`, `wallet` (**no namespace**) | Exactly `incident_id`, `transaction_hash`, `operation_id`, `beneficiary`, `amount`, all strings |
| `issue`, `reconcile` | Those eight fields plus matching lowercase UUID `namespace` | Empty object |

Version is `1`, network is `TESTNET`, and pool/namespace come only from the supplied config. Stellar addresses must be checksum-valid Ed25519 accounts. Incident IDs are 1–256 printable ASCII characters without edge whitespace, not necessarily UUIDs. Transaction hashes are 64 lowercase hex characters; operation IDs match `[1-9][0-9]{0,18}`; amounts match `(0|[1-9][0-9]{0,11})\.[0-9]{7}`. These strings are never normalized or converted to floating point. Timestamps must be within the inclusive ±60-second window, checked both before and after wallet interaction.

`canonicalUnsignedJson(validatedCommand)` recursively sorts object keys, preserves array order, and excludes the top-level signature; it is a serializer, not an input validator. Valid command payloads contain no arrays. The wallet receives this **raw JSON**, with `{address: command.wallet, networkPassphrase: Networks.TESTNET}`. Local SDK verification checks Ed25519 against the retained wallet and SHA256(UTF8(`Stellar Signed Message:\n`) + UTF8(canonical JSON)). Never prehash, prefix or base64-encode the message sent to Freighter: its extension applies the prefix/hash itself.

| Stable `Error.message` | Rejection |
| --- | --- |
| `d1_invalid_config` | Invalid public configuration |
| `d1_invalid_command` | Invalid/extra/missing fields, mismatched configuration, invalid timestamp or clock |
| `d1_stale_command` | Timestamp outside the allowed window, including after signing |
| `d1_wallet_error` | Wallet throw/rejection, error result or absent/nonobject response |
| `d1_signer_mismatch` | Missing or different signer address |
| `d1_invalid_signature` | Unsupported representation, malformed signature or failed local verification |

Only 64-byte `Uint8Array`/Buffer or strict canonical standard-base64 strings are accepted (decode, length and roundtrip checked). Hex, base64url, Buffer-shaped JSON, arbitrary strings and other objects are rejected. Freighter 6.0.1 forwards the message unchanged; immutable official extension source `41532f40037729b6e2186708d83b55abc1cc615b` establishes prefix/hash and raw-byte signing. **Bridge string encoding and interoperability with the user's installed extension are not proved.** Representation checks and local verification are rejection gates, not universal extension compatibility claims. Receipt validation (T2b), durable payments, UI/orchestration (T3–T5), browser/runtime checks and live journeys remain separate work.

## Offline verification

Run `pnpm test:d1` or `node node_modules/@playwright/test/cli.js test --config playwright.d1.config.ts`. This separate configuration runs only `tests/d1/**/*.spec.ts` and the existing `tests/e2e/stellar-contracts.spec.ts`, without a server, browser launch or live Testnet. It uses mock credentials and injected fetch, zero retries, fail-fast reporting, and unique operating-system temporary output directories. Follow with `node node_modules/typescript/bin/tsc --noEmit --incremental false` for type checking.

Review the boundary in `src/lib/d1/server-proxy.ts`, the thin Next 15 Promise-params adapter in `src/app/api/d1/[action]/route.ts`, and the observable contract in `tests/d1/proxy.spec.ts`. Existing donation/admin/Stellar helpers are unchanged. T2a's focused checks are `node node_modules/@playwright/test/cli.js test --config playwright.d1.config.ts tests/d1/commands.spec.ts tests/d1/wallet-proof.spec.ts tests/d1/independent-commands.spec.ts --max-failures=0`. The independent probes use Node crypto as a separate Ed25519 signing oracle. Payment intent, receipts, UI, phone coordination and live financial journeys are later tasks.

**Configuration, authenticated reads and passing offline tests are not financial acceptance.** Neither a reachable backend nor a successful reconcile response proves final full-principal settlement. Deployment and live actions require separate coordination and authorization.
