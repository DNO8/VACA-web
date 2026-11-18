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
| `/api/d1/refund-status` | POST | `/functions/v1/d1-custody/refund-status` |
| `/api/d1/refund` | POST | `/functions/v1/d1-custody/refund` |
| `/api/d1/refund-reconcile` | POST | `/functions/v1/d1-custody/refund-reconcile` |
| `/api/d1/refund-remainder-status` | POST | `/functions/v1/d1-custody/refund-remainder-status` |
| `/api/d1/refund-remainder` | POST | `/functions/v1/d1-custody/refund-remainder` |
| `/api/d1/refund-remainder-reconcile` | POST | `/functions/v1/d1-custody/refund-remainder-reconcile` |

Only the configured Supabase origin is used. Other actions, methods, query strings and noncanonical route paths are rejected before fetch. Request headers and body fields cannot select a destination or gateway credential. Incoming authorization, cookies and API keys are never forwarded. Outgoing headers contain only the configured anon Bearer/API key and JSON content/accept headers; credentials are omitted, redirects are not followed, and every response is `Cache-Control: no-store`.

POST requires `application/json` (parameters such as charset are allowed), a JSON object and at most **8192 streamed bytes**, regardless of Content-Length. Accepted bytes are forwarded unchanged: no reserialization, signature rewrite or extra namespace injection. Full command schema and personal authorization remain backend responsibilities; the six refund routes additionally validate the correlation fields below.

There is exactly one upstream fetch attempt, with a **10-second abort deadline** covering fetch and response reading. There is no retry, polling, redirect or automatic reconciliation. Upstream JSON is limited to **65536 streamed bytes**. GET config requires exactly `network: TESTNET`, a checksum-valid Stellar `pool_public_key`, and `donation_ttl_seconds: 300`; the response adds the configured public namespace. Legacy prepare/issue/reconcile preserve successful JSON and HTTP status, including **202 pending/unverified**, without inferring inclusion or settlement. Refund success responses must instead pass the bound receipt parser. Non-success backend responses otherwise retain the sole `{error: safe_code}` rule (1–64 lowercase alphanumeric/underscore characters, starting with a letter), with the execution-only refund DTO exception below. Upstream headers and malformed/error details are never exposed or logged.

### Manual refund correlation

The first three refund routes require version1 actions `refund_status`, `refund`, `refund_reconcile`; remainder routes require version2 actions `refund_remainder_status`, `refund_remainder`, `refund_remainder_reconcile`. URL suffixes are hyphenated; signed action names use underscores. The proxy requires the route's version/action, `network: TESTNET`, the configured namespace, a valid Ed25519 public `pool`, and a canonical original `request_id`. Invalid correlation returns `400 invalid_request` without an upstream call. It does not validate freshness, renew a timestamp, re-sign, or select a lane from response actions.

The pool is **request-bound, not independently authenticated by this proxy**: server settings contain no pool, and POST does not fetch config. The backend remains responsible for configured-pool matching, current admin membership and the complete personal proof. Valid correlation alone grants nothing.

Successful refund responses are returned only as the validated shape from [the refund receipt parser](d1-refund-receipts.md). HTTP409 DTOs are admitted only on `/refund` and `/refund-remainder`, with the corresponding `not_due` or `blocked` report. Sole safe error envelopes still use the existing sanitizer, including on execution409; malformed, extra-field or mismatched DTOs become `502 invalid_upstream_response`. Status/reconciliation409 DTOs remain rejected. HTTP200 with `not_started` remains unverified, not execution acceptance; a timeout, error, hash or `safeActions` never grants another send. Transport adds no reservation, selector, automatic executor or admin UI.

| Local status | JSON error code |
| --- | --- |
| 400 | `invalid_path`, `invalid_json`, `invalid_request` (refund correlation only) |
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

Run `pnpm test:d1` or `node node_modules/@playwright/test/cli.js test --config playwright.d1.config.ts`. This separate configuration runs only `tests/d1/**/*.spec.ts` and the existing `tests/e2e/stellar-contracts.spec.ts`, without a server or live Testnet. The journal tests additionally require sandboxed local Chromium (see below); the other tests do not launch a browser. It uses mock credentials and injected fetch, zero retries, fail-fast reporting, and unique operating-system temporary output directories. Follow with `node node_modules/typescript/bin/tsc --noEmit --incremental false` for type checking.

Review the boundary in `src/lib/d1/server-proxy.ts`, the thin Next 15 Promise-params adapter in `src/app/api/d1/[action]/route.ts`, and the observable contract in `tests/d1/proxy.spec.ts`. Existing donation/admin/Stellar helpers are unchanged. T2a's focused checks are `node node_modules/@playwright/test/cli.js test --config playwright.d1.config.ts tests/d1/commands.spec.ts tests/d1/wallet-proof.spec.ts tests/d1/independent-commands.spec.ts --max-failures=0`. The independent probes use Node crypto as a separate Ed25519 signing oracle. Payment intent, receipts, UI, phone coordination and live financial journeys are later tasks.

**Configuration, authenticated reads and passing offline tests are not financial acceptance.** Neither a reachable backend nor a successful reconcile response proves final full-principal settlement. Deployment and live actions require separate coordination and authorization.

## T2b foundation: original-bound preparation receipt

`validateReceiptContext(value)` in `src/lib/d1/receipt-context.ts` returns a deeply frozen, independent `D1ReceiptContext`. Retain exactly `{config, request_id, admin, incident_id, beneficiary, amount, payment}`. `config` is the matching public D1 configuration above; `payment` is exactly `{transaction_hash, operation_id, donor, pool, asset, amount, confirmedAt}`. The context's `amount` is the requested allocation; the payment's `amount` is the original gross payment. `confirmedAt` is original confirmation time in safe-integer epoch **seconds**, not browser/signing time. Both confirmation and its +300-second deadline must have representable four-digit-year UTC dates. Pool must match config. Namespace/network remain retained even though the receipt does not echo them.

Call `parsePreparationReceipt(raw, expectedContext)` from `src/lib/d1/preparation-receipt.ts` with decoded receipt data, not a JSON string. It validates context first and returns an independent, deeply frozen `PreparationReceipt` in the exact backend shape:

- Outer: `{revision: 1, state: 'allocated', request_id, allocation}`.
- Allocation: `{reservation, payment, allocated_amount, state: 'allocated', allocated_at}`.
- Reservation: `{request_id, authorized_by, request, state: 'reserved', reserved_at}`.
- Request: `{version: 1, incident_id, donor, beneficiary, asset, amount, deadline}`.
- Payment: `{transaction_hash, operation_id, donor, pool, asset, amount}` (no invented confirmation field).

Both request UUIDs and the administrator, incident, beneficiary, original payment identities, asset and amounts must match the retained context. An incident ID or claimable-balance ID never substitutes for the original UUID. Assets are exactly `{type: 'native'}` or `{type: 'issued', code, issuer}`, with 1–12 ASCII alphanumeric code characters and a checksum-valid Ed25519 issuer. All nested objects must be plain data with exact enumerable fields: arrays, coercion, accessors, symbols, hidden and unknown fields are rejected without invoking getters. Caller inputs are never frozen or mutated.

Amounts are positive canonical strings with seven decimal places and at most twelve integer digits, compared as **BigInt stroops**, never floating point. Allocation and request amount must equal the expected requested amount and cannot exceed original gross payment. **A 10.0000000 payment allocated as 1.0000000 is valid**; it proves neither settlement of 10 nor current remaining capacity. Deadline must equal original `confirmedAt + 300`, exactly `YYYY-MM-DDTHH:mm:ssZ`; `reserved_at`/`allocated_at` require `YYYY-MM-DDTHH:mm:ss.sssZ`. Impossible calendar dates, timezone aliases and renewed deadlines are rejected, not normalized.

| Stable `Error.message` | Rejection |
| --- | --- |
| `d1_invalid_receipt_context` | Malformed retained context/configuration, unrepresentable time, mismatched pool or requested amount exceeding gross payment |
| `d1_malformed_preparation_receipt` | Invalid receipt shape, primitive, asset, amount, state/version or canonical calendar date |
| `d1_receipt_binding_mismatch` | Structurally valid receipt differs from original identity/economics or original deadline |

This is **binding to caller-retained evidence, not independent authentication** of that evidence, administrator authority or blockchain provenance. No IO, retries, settlement, claim/refund status or current availability interpretation is added. Issuance/reconciliation parsers, durable handoff and UI remain later units. Focused offline check: `node node_modules/@playwright/test/cli.js test --config playwright.d1.config.ts tests/d1/preparation-receipt.spec.ts --max-failures=0`.

## T2b dependent unit: historical issuance and reconciliation

`src/lib/d1/issuance-receipt.ts` now exports `parseIssuanceReceipt(status, raw, expectedContext, knownTransactionHash?)` and `parseReconciliationReceipt(status, raw, expectedContext, knownTransactionHash?)`. Supply the numeric HTTP status, decoded unknown data and original retained context above. Both return independent deeply frozen `{receipt, transactionHashBinding}` copies without freezing or mutating caller data. This adds the parsers deferred in the foundation section, not durable handoff or UI.

| HTTP / parser | Exact wire fields and literals |
| --- | --- |
| 202 / issue | `state: 'pending'`, `verification: 'unverified'`, `requestId`, `transactionHash` |
| 200 / issue | `state: 'issuance_observed'` or `'issuance_failed_observed'`, `verification: 'persisted_sdk_observation'`, `requestId`, `transactionHash`, `donor`, `beneficiary`, `asset`, `amount`, `paymentTransactionHash`, `deadline` |
| 202 / reconcile | `state: 'reconciliation_progress'`, `requestId`, `transactionHash`, `stage: 'discovery'` or `'transactions'`; **no verification field** |
| 200 / reconcile | `state: 'issuance_outcome_recorded'`, `requestId`, `transactionHash`, `outcome: 'success'` or `'failed'` (string, not journal object); **no verification field** |

Issue success additionally requires `claimableBalanceId` matching `/^00000000[0-9a-f]{64}$/`: full 72-character lowercase XDR with the zero discriminant, not a 64-character hash. Only success permits optional enumerable `availability`; its value and descendants are **never evaluated**, even for an accessor or circular object, and it is omitted from output. No current presence, absence or claimability is inferred. Failure must omit both fields. All other fields must be own enumerable data in exact plain-object shapes; unknown/hidden/symbol fields, arrays, accessors and coercion are rejected.

Both parsers bind `requestId` to the original UUID. Issue 200 additionally binds donor/asset/payment hash to the original payment, beneficiary to the retained beneficiary, amount to **context.amount** (1 allocated from 10 paid is valid), and deadline to original confirmation +300 seconds in canonical UTC ISO whole-second text. It never renews time. Reconcile has no economics and cannot independently assert them. Namespace, pool, administrator, incident and original payment mapping must remain externally retained; they are not invented as echoed receipt fields. Incident IDs and claimable-balance IDs never replace the UUID; the original payment hash is not the issuance transaction hash.

`knownTransactionHash` is optional because issue's empty command cannot prebind the hash first generated/exposed after backend submission. If omitted, local wrapper metadata is `transactionHashBinding: 'first_report'`; if supplied it must be 64 lowercase hex characters and match exactly, yielding `'retained_match'`. These labels are **local provenance**, never new wire fields. Neither first report nor retained match authenticates the backend or proves cryptographic provenance/inclusion.

| Stable `Error.message` | Rejection |
| --- | --- |
| `d1_invalid_receipt_context` | Invalid original context or malformed supplied issuance hash; checked before receipt parsing |
| `d1_malformed_issuance_receipt` / `d1_malformed_reconciliation_receipt` | Wrong HTTP/status pairing, wire shape, literals or primitive encoding |
| `d1_receipt_binding_mismatch` | Well-formed receipt differs from original request, supplied issuance hash or issue economics/deadline |

These pure helpers perform no IO, polling, retries, re-signing or time renewal. Pending is unverified; reconciliation success is not settlement; observed failure is not refund or retry permission; a lost response never authorizes resubmission. Independent verification, durable receipt storage, UI, deployment and live financial acceptance remain separate. Focused offline check: `node node_modules/@playwright/test/cli.js test --config playwright.d1.config.ts tests/d1/issuance-receipt.spec.ts --max-failures=0`.

## T3 foundation: immutable donation transaction and personal signature

`src/lib/d1/donation-transaction.ts` is a **pure offline boundary**, not a wallet invocation, store or submission flow. It imports no legacy donation/pool orchestration and retains no secret material. All returned records are independent, deeply frozen plain data; caller objects are neither mutated nor frozen, including on rejection.

1. `createDonationIntent(config, {request_id, donor, incident_id, asset, amount})` retains the original UUID and matching public TESTNET config, including namespace and TTL 300. `validateDonationIntent(value)` validates the complete `{config, request_id, donor, incident_id, asset, amount}` shape. Both reuse the strict T2 readers: exact fields, checksum-valid Ed25519 accounts, lowercase UUIDs, full 1–256-character printable ASCII incident without edge whitespace, explicit native or issued asset. No normalization, issuer selection or UUID generation occurs. Positive canonical seven-decimal amounts additionally fit signed64 stroops: maximum `922337203685.4775807`.
2. `buildDonationTransaction(intent, {sequence, fee, timebounds: {minTime, maxTime}})` returns a frozen `DonationTransaction`: `{intent, parameters, unsignedXdr, transactionHash}`. Supply the current account sequence as a canonical unsigned decimal string `0`–`9223372036854775806`; a new local SDK Account alone is incremented. Fee is a positive canonical decimal stroop string up to `4294967295`, for exactly one operation; sufficient network fee/funding is not asserted. Time bounds are explicit safe-integer epoch seconds, `0 <= minTime < maxTime <= Number.MAX_SAFE_INTEGER`; zero/infinite max is forbidden. No clock, default timeout or renewal is used.
3. After a **separately authorized** personal Freighter interaction, call `validateSignedDonation(buildSnapshot, {signedTxXdr, signerAddress, error?})`. It returns a frozen `SignedDonation` with the original build fields plus the **exact returned** `signedTxXdr`, not a reconstructed envelope. It never invokes a wallet, signs, sends, retries or stores anything.

The ordinary v1 transaction contains exactly one Payment with explicit donor source, retained pool destination, asset and amount, using `Networks.TESTNET`. Memo is `Memo.hash(SHA256(UTF8('vaca.d1.donation.v1\n' + exactFullIncidentId)))`, never legacy `vq:` text or a truncated incident. **Transaction time bounds are not financial expiry**: D1 expiry remains original payment confirmation +300 seconds in later evidence handling, never build/sign/retry time.

The signed validator reconstructs the unsigned transaction from strictly validated intent/parameters and checks stored unsigned XDR/hash before comparing the signed transaction's full signature base and hash. JSON-reloaded snapshots are supported; no process-local trust marker is needed. Fee-bump and v0 envelopes are unsupported. A matching signer string is insufficient: at least one decorated signature must verify with the donor's Ed25519 public key over the TESTNET transaction hash. Non-null wallet errors (including `false`) reject. This is **direct donor key proof**, not generalized multisig/account-threshold authorization, current ledger authorization, inclusion or settlement. Additional signatures do not establish those claims.

| Stable `Error.message` | Rejection |
| --- | --- |
| `d1_invalid_donation_intent` | Malformed intent/config/identity/asset, nonpositive or overflowing amount |
| `d1_invalid_donation_parameters` | Invalid sequence/fee/time bounds or SDK build failure |
| `d1_invalid_donation_snapshot` | Invalid retained build record or unsigned XDR/hash inconsistent with its intent/parameters |
| `d1_wallet_error` / `d1_signer_mismatch` | Malformed/error wallet response / absent or different signer address |
| `d1_invalid_signed_donation` | Malformed signed XDR or unsupported envelope |
| `d1_donation_body_mismatch` / `d1_invalid_signature` | Different transaction body / no valid direct donor signature |

The snapshot binds data internally, not to authenticated storage: replacing the entire caller-retained record cannot be detected without external retention. UUID and namespace are retained metadata, not fields authenticated by the payment signature. Durable storage, atomic cross-tab acquisition enforcing **one unresolved donation per wallet/config/incident**, submission and exact-hash recovery remain later T3 units. A timeout never permits a new send. UI, browser/extension interoperability and live financial acceptance remain unimplemented/unproved here.

Focused offline check: `node node_modules/@playwright/test/cli.js test --config playwright.d1.config.ts tests/d1/donation-transaction.spec.ts --max-failures=0`.

## T3 journal: one retained intent and one durable submission claim

`src/lib/d1/donation-journal.ts` adds **IndexedDB persistence only**, with no runtime imports. It does not parse JSON/XDR, validate economics or signatures, invoke a wallet, submit, retry, release, reset or infer settlement. A later coordinator must validate actual `DonationIntent`/`SignedDonation` objects **before storage and after reading**, retaining their original identity. A structurally valid stored envelope is not authenticated donation evidence.

1. `openDonationJournal(indexedDB, name)` opens database version 1; choose a fixed application database name. There is no volatile fallback or destructive migration.
2. `acquire(scope, requestId, intent)` returns frozen `{acquired, record}`. The caller supplies the original lowercase UUID and a fixed, unambiguous scope derived from validated **network/pool/namespace/donor/incident**, excluding amount and asset. The store's UUID primary key and unique scope index arbitrate independent connections. A competing UUID/amount receives the original record, not a replacement. The same UUID/exact scope/intent is idempotent (`acquired: false`); UUID reuse with a different scope or intent rejects.
3. `saveSigned(requestId, expectedIntent, signed)` stores the exact opaque signed string only against the exact original intent. An identical signed string is idempotent, including after a claim; a different string cannot replace it. It returns the retained record.
4. `claimSubmission(requestId, expectedSigned)` atomically changes `signed` to `submission_claimed`, returning frozen `{claimed, record}`. Exactly one caller wins. Later calls return `claimed: false`; close/reopen/reload does not grant another claim. This is **not submission or inclusion evidence**. A crash after claiming may mean nothing was sent, but uncertainty never authorizes a resend in this unit.
5. `read(requestId)` returns a frozen independent record or `null`; `close()` is idempotent. Records contain exactly `{scope, requestId, intent, state}`, plus `signed` only in `signed`/`submission_claimed` states. No timestamps, counters or UUIDs are generated.

Every mutation reads, compares and writes inside one IndexedDB readwrite transaction with strict durability requested; success is exposed **only on transaction completion**, never request success. Rejected guards and aborted transactions leave stored data unchanged. Version changes close the connection; blocked/error opens reject, and late successful opens are closed. Name/scope limits are 1–256/1–4096 UTF-16 code units; intent/signed strings are 1–1,048,576 code units, preserved exactly without normalization. UUIDs require canonical lowercase 8-4-4-4-12 hex syntax. Records are structurally validated before use. No release API exists yet, so a scope remains occupied even after a claim.

| Stable `Error.message` | Meaning |
| --- | --- |
| `d1_journal_invalid_argument` | Invalid primitive, UUID or string length |
| `d1_journal_unavailable` | No usable supplied IndexedDB factory; never falls back to memory |
| `d1_journal_blocked` / `d1_journal_open_failed` | Blocked open / platform, schema or version failure |
| `d1_journal_closed` / `d1_journal_storage_error` | Closed connection / transaction failure or abort |
| `d1_journal_invalid_record` | Stored envelope shape, identity or state is malformed |
| `d1_journal_conflict` | UUID binding conflict or replacement signed payload |
| `d1_journal_not_found` / `d1_journal_guard_mismatch` / `d1_journal_invalid_state` | Missing record / original bytes differ / claim attempted before signing |

**Browser proof:** `tests/d1/donation-journal.spec.ts` transpiles only this standalone module and exercises its public API in real Chromium: independent-page acquisition and claim races, exact bytes, immutable snapshots, invalid guards, durable close/reopen/reload and closed connections. Thin factory fault injection tests real transaction abort after request success and invalid envelopes; synthetic open lifecycle tests are not concurrency proof. The runner uses fresh browser contexts, blocked service workers, an inline-only `http://d1-test.local/` route and aborts other page requests. No server, personal profile, wallet or live financial call is used. Missing browser/runtime prerequisites fail rather than skip.

Run `node node_modules/@playwright/test/cli.js test --config playwright.d1.config.ts tests/d1/donation-journal.spec.ts --max-failures=0`, with process-scoped `D1_TEST_BROWSER` pointing to the prepared Chromium executable (or `PLAYWRIGHT_BROWSERS_PATH` for Playwright's installed executable resolution). Any prepared local runtime libraries belong only in process-scoped `LD_LIBRARY_PATH`. Chromium runs with `chromiumSandbox: true`; do not disable the sandbox. Follow with `node node_modules/typescript/bin/tsc --noEmit --incremental false`.

This enforces uniqueness only within the **same browser origin/database** and caller-consistent scope. It does not protect against storage eviction/deletion, malicious same-origin code, a different browser/device or a wholly replaced valid record. The following session unit adds validated retention/signing; cross-device authority, actual submission, exact-hash recovery, UI and live payment acceptance remain separate T3+ work. Neither unit completes T3.

## T3 session: validated retention and explicit personal signing

`src/lib/d1/donation-session.ts` bridges the pure transaction validators and `DonationJournal`. It has **no submission callback or submission claim**, network access, UUID/time generation, renewal, release, reset, recovery, polling or retry. The existing donation UI and legacy orchestration are unchanged.

1. `acquireDonation(journal, intent, parameters)` builds and validates first, then awaits journal acquisition of the full canonical `JSON.stringify(DonationTransaction)` before returning `{acquired, record}`. Scope is exactly `JSON.stringify([network, pool_public_key, namespace, donor, incident_id])` from validated intent; amount, asset and request UUID are deliberately excluded. A competing UUID/amount/asset receives the original validated snapshot, including its original UUID, economics, parameters and unsigned body. No wallet is called. Same-UUID proposals must match the original snapshot exactly.
2. Retain the returned **original full intent**, not the losing proposal. `readDonation(journal, expectedIntent)` validates it, reads by original UUID and returns `null` if missing. Otherwise every immutable intent field must match, including config/namespace, donor, incident, asset and amount. The result is a deeply frozen independent `DonationSession`: `{scope, requestId, state, snapshot}`. Snapshot is `DonationTransaction` for `intent`, or `SignedDonation` for `signed`/`submission_claimed`.
3. Only explicit `signDonation(journal, expectedIntent, signTransaction)` invokes the injected async Freighter-shaped callback. It first fully validates the retained record. Already signed/claimed records return without a callback or write. For `intent`, it calls exactly once with retained `unsignedXdr` and `{address: donor, networkPassphrase: Networks.TESTNET}`, validates the actual response, then awaits `journal.saveSigned(originalUUID, exactUnsignedJSON, canonicalSignedJSON)`. Success requires journal completion and revalidation of the returned record; a racing claim remains claimed.

Reload validation uses **JSON.parse only**, rebuilds with the existing pure builder, and requires exact canonical unsigned JSON, rejecting extra/missing fields, changed hash/XDR/body/parameters and noncanonical JSON formatting. Signed records additionally require cryptographic validation of the actual signed XDR against the rebuilt transaction and donor; the resulting canonical signed JSON must equal stored bytes exactly. The wallet's `signedTxXdr` string, including accepted whitespace, is preserved without reserialization. Shape/state/identity failures occur before a wallet call or signed write. Rejected wallet results or throws never trigger retries or signed writes.

| Stable `Error.message` | Meaning |
| --- | --- |
| `d1_session_invalid_record` | Invalid adapter envelope, state, acquisition flag or result shape |
| `d1_session_invalid_json` | Retained unsigned/signed JSON cannot be parsed |
| `d1_session_invalid_snapshot` | Wrong payload shape or bytes differ from canonical reconstructed snapshot |
| `d1_session_identity_mismatch` | Scope, UUID, expected full intent or exact acquisition/persistence guard differs |
| `d1_session_not_found` | Explicit signing requested a missing original record |
| `d1_session_storage_error` | Journal operation threw/rejected; no durable success is returned |

Existing pure validation errors listed above propagate for invalid intent/parameters and signed-transaction verification. Callback throws become `d1_wallet_error`; journal errors become `d1_session_storage_error`, without exposing raw storage payloads or wallet details. A conflicting concurrently retained signed byte set is not replaced or retried.

**Limits:** structural/cryptographic binding is not authentication of UUID/namespace against a wholly replaced record by malicious same-origin code. Those fields remain external metadata, not transaction-signed identity. Concurrent explicit sign calls may prompt more than once, but their unsigned body is already fixed and the journal retains only one signed byte set. Only the journal's atomic submission claim can provide the later coordinator's one-send guard; this session never claims or sends. No current ledger/account-threshold authority, extension interoperability, cross-device exclusion, inclusion, payment completion or settlement is proved.

Focused Node-only check: `node node_modules/@playwright/test/cli.js test --config playwright.d1.config.ts tests/d1/donation-session.spec.ts --max-failures=0`. Tests use synthetic SDK Ed25519 signatures and an injected signer with a bounded fake journal to check orchestration effects, not IndexedDB atomicity. **No actual wallet interaction, network submission or financial action is executed by these tests.** Existing real-browser journal evidence is separate; independent verification and full-suite acceptance remain parent-owned.

## T3 transport: explicit one-shot submission, never payment confirmation

`submitDonation(journal, expectedIntent, fetcher?)` in `src/lib/d1/donation-submission.ts` sends only when explicitly called. Importing the module, opening a journal or reading a donation never sends. The optional fetch defaults to browser fetch; tests always inject a synthetic implementation. No UI invokes this API yet, and live financial execution still requires separate authorization.

1. Validate the callable fetcher, then use `readDonation` to validate the full original intent, canonical snapshot and actual donor signature. Missing or unsigned records reject. Already claimed records return without claiming or sending.
2. Await `claimSubmission(originalUUID, JSON.stringify(validatedSignedSnapshot))`. Validate the exact plain acknowledgement and its scope, UUID, canonical unsigned/signed bytes and `submission_claimed` state. Only a valid `claimed: true` winner sends. This is wrapper defense, not authentication against malicious same-origin replacement.
3. POST exactly once to `https://horizon-testnet.stellar.org/transactions`, with no destination override, credentials, redirects, cache or referrer. The form body has only `tx`: the exact retained signed XDR, including whitespace. No UUID, namespace or wallet key is added.
4. Bound network awaiting with a fixed **10,000 ms** deadline and AbortController, even if an injected fetch ignores abort. Always clear the timer; discard response bodies without parsing or awaiting cancellation, including late responses. Consume late rejections. Never retry, re-sign, renew identity/body, reset or release the claim.

| Frozen `DonationSubmission` result | Meaning |
| --- | --- |
| `response_unverified`, with integer `httpStatus` 100–599 | HTTP metadata only. 2xx, 4xx and 5xx prove neither inclusion, failure, settlement nor refund authorization. |
| `unknown` | Timeout, abort, network throw or invalid response; the durable claim remains occupied. |
| `already_claimed` | No fetch; a prior claim or concurrent winner owns the attempt. No HTTP status is retained. |

Every result carries the original `requestId` and retained `transactionHash`. **Every post-claim outcome leaves the record `submission_claimed`**, including an error acknowledgement after persistence. Explicit repeat/reload never permits another send. The API does not save a response or create ledger evidence.

Pre-transport failures reject: existing session/pure validation errors propagate; new typed `DonationSubmissionError.code` values are `invalid_fetcher`, `not_found`, `unsigned`, `storage_error` (claim operation rejected), and `invalid_claim` (malformed or mismatched acknowledgement). Their stable messages are `d1_submission_<code>`, never raw storage/network payloads. A rejection is not permission to retry: storage or acknowledgement failure may follow an already durable claim. After a validated winning claim, transport failures return `unknown` instead of throwing raw fetch details.

Focused offline command: `node node_modules/@playwright/test/cli.js test --config playwright.d1.config.ts tests/d1/donation-submission.spec.ts --max-failures=0`. Node-only tests use real synthetic SDK signatures and a public fake journal adapter; one actual 10-second deadline case checks abort-ignoring fetch and late completion. This does not replace real-browser atomic journal evidence. Original-hash observation/recovery, UI, cross-device exclusion and live payment acceptance remain unfinished; this unit does not complete T3.

## T3 evidence: pure successful-payment consistency validation

`parseDonationEvidence(retainedSignedSnapshot, transaction, operations, ledger)` in `src/lib/d1/donation-evidence.ts` accepts unknown inputs: the original `SignedDonation`, a **raw Horizon transaction**, a raw operations collection with `_embedded.records`, and a raw ledger. Hydrated SDK resources are not accepted. It performs no IO, clock reads, wallet calls, submission, persistence, polling, retries or journal release. All rejection paths throw exactly `d1_donation_evidence_invalid`, without raw input/error details or stored-data effects.

The validator reconstructs the original canonical unsigned snapshot and verifies its retained donor signature using the existing transaction validators. Horizon's `envelope_xdr` must independently verify the same ordinary TESTNET transaction body/hash and donor proof; additional signatures or whitespace need not equal the retained envelope bytes. Transaction hash, source account, precise source sequence, success and exactly one operation must agree. Encoded unsigned/signed/envelope/result strings are bounded to 1,048,576 characters before parsing.

`result_xdr` must be canonical base64 and roundtrip as `xdr.TransactionResult`, with `txSuccess`, exactly one `opInner`, `payment`, and `paymentSuccess`. **This structure contains fee/results, not a transaction hash, payment economics or cryptographic inclusion proof.** It never establishes payment by itself. The sole raw payment record must independently match the original hash, donor/source/from, pool/to, asset and full seven-decimal gross amount, with `type_i: 1` and `transaction_successful: true`. Operation IDs remain canonical positive decimal strings of 1–19 digits, never Numbers. Muxed aliases are rejected for this unmuxed original. Optional plain-data Horizon metadata/links are allowed but never followed; accessors, symbols, hidden fields and nonplain/cyclic data reject without invoking getters (nesting limit 32).

The matching positive uint32 ledger sequence, lowercase 64-hex hash and canonical whole-second UTC `closed_at` are retained. `payment.confirmedAt` is derived **only** as `Date.parse(closed_at) / 1000`, nonnegative and valid for the existing receipt deadline. Transaction and operation `created_at` must also be canonical and equal `closed_at`: this is a **conservative acceptance gate, not a proven universal Horizon API guarantee**. A mismatch remains unresolved; no backend timestamp is rewritten. Deadline remains `originalDeadline(confirmedAt)` (+300 seconds), never observation/build/retry time.

The independent, deeply frozen return has exactly `{config, request_id, incident_id, payment, ledger}`. `payment` is `{transaction_hash, operation_id, donor, pool, asset, amount, confirmedAt}`; `ledger` is `{sequence, hash, closed_at}`. Config, UUID, incident and gross economics come only from the retained intent. No administrator, beneficiary, allocation or resolved/retry/settled flag is fabricated. Later receipt preparation must separately supply authorized context; this is not permission to send or unlock a pending donation.

**Trust boundary:** this is consistency-validated supplied evidence, not authenticated origin, independent ledger authenticity/inclusion, current account authorization, settlement or financial acceptance. The fixed-origin observer below constrains the retrieval endpoint; it does not turn a supplied report into cryptographic inclusion proof. The donor signature authenticates transaction body, not external UUID/namespace metadata or a wholly replaced retained intent. Durable handoff/release and UI remain unfinished; S10's pending-send guard is unchanged. This does not complete T3.

Focused offline check: `node node_modules/@playwright/test/cli.js test --config playwright.d1.config.ts tests/d1/donation-evidence.spec.ts --max-failures=0`. Fixtures use synthetic SDK signatures, result XDR and raw ledger/operation records, with no live calls.

## T3 cached evidence: strict normalized-report reload validation

`validateStoredDonationEvidence(snapshot: unknown, evidence: unknown): DonationEvidence` in `src/lib/d1/stored-donation-evidence.ts` validates a decoded original `SignedDonation` and cached normalized `DonationEvidence`. It returns a fresh, canonical-key-order, deeply frozen copy, independent of input order and later mutation. It never mutates or freezes caller data, including on rejection.

This pure reload boundary reuses the existing public transaction and receipt validators:

- Rebuild the full original unsigned snapshot, check its retained XDR/hash and verify the signed transaction's body and donor proof. Unsigned/signed XDR strings are bounded to 1,048,576 characters. Require exact original config, request UUID, full incident, transaction hash, donor, pool, asset and **gross** amount; never substitute allocated amount.
- Require exactly `{config, request_id, incident_id, payment, ledger}` and the nested shapes documented above. Operation ID is a canonical positive 1–19-digit string, ledger sequence is positive uint32 and ledger hash is lowercase 64-hex. Canonical whole-second UTC `closed_at` must derive exactly the retained nonnegative integer `confirmedAt` in **seconds**, with a representable `originalDeadline(confirmedAt)` (+300 seconds).
- Read plain records through descriptors and validate typed leaves with fixed-depth schema traversal, not recursive input serialization. Unknown/symbol/hidden/accessor fields, nonplain records, cycles and deep structures reject without invoking getters or coercion hooks. Every rejection is exactly `Error('d1_stored_donation_evidence_invalid')`, without a cause or raw details.

**Consistency only:** a normalized cached report cannot re-prove raw result XDR, envelope/operation reports, authenticated browser storage, ledger inclusion or settlement. UUID/namespace remain external metadata, not signature-authenticated identity; replacing a whole consistent record is not detected. No administrator, beneficiary, allocation or authority/resolution flags are added. This unit performs no IO, clock reads, persistence, release or retry. A later wrapper must invoke the observer itself before durable persistence; S10's occupied pending scope is unchanged. Durable handoff, release and UI remain unfinished.

Focused offline check: `node node_modules/@playwright/test/cli.js test --config playwright.d1.config.ts tests/d1/stored-donation-evidence.spec.ts --max-failures=0`. The 13 tests include raw-parser-to-JSON round trips for native, short-code credit and long-code credit assets. Compatibility check: `node node_modules/@playwright/test/cli.js test --config playwright.d1.config.ts tests/d1/donation-evidence.spec.ts --max-failures=0`. Neither check makes live calls or proves financial acceptance.

## T3 observer: explicit bounded reads of the original payment

`observeDonation(journal, expectedIntent, fetcher = globalThis.fetch)` in `src/lib/d1/donation-observation.ts` reads a matching Horizon report without claiming, acquiring, signing, sending, saving, releasing or resetting anything. It first validates that fetcher is callable, then reuses `readDonation` to validate the full original intent, canonical retained snapshot and actual donor signature. Only `submission_claimed` records can be observed. No UI or import automatically invokes it.

Each explicit invocation makes at most **three sequential GETs**, exclusively to `https://horizon-testnet.stellar.org`:

1. `/transactions/{originalHash}`, using the retained lowercase 64-hex transaction hash. Before any further request, the report must match that hash, `successful: true`, `operation_count: 1` and a positive uint32 ledger sequence.
2. `/transactions/{originalHash}/operations?limit=2&order=asc`: the initial unfiltered page, with no cursor.
3. `/ledgers/{wireLedgerSequence}`: the sequence from the guarded transaction report.

Requests omit credentials and referrers, disable cache, reject redirects and send `Accept: application/json`. Only HTTP 200 and media type `application/json` or `application/hal+json` (including charset parameters) are accepted. Redirected responses and nonempty response URLs differing from the requested URL reject; synthetic responses with an empty URL are allowed. No links, alternate endpoints, pagination, polling or retries are followed.

One fixed **10,000 ms network-stage deadline**, starting after retained-record validation, covers all fetches and body reads. Abort plus a promise race bounds the return even when injected fetch/read implementations ignore abort. Late responses are discarded, late failures consumed, and no later GET starts after abort. Each body is limited to **65536 cumulative streamed bytes**, independent of Content-Length, with fatal UTF-8 decoding and JSON parsing. Missing bodies, invalid/empty nonprogress chunks, overflow and malformed data remain unresolved. Cancellation is best effort without awaiting it; reader locks are released and the timer cleared.

The frozen `DonationObservation` always carries original `{requestId, transactionHash}`. `state: 'observed'` adds deeply frozen `evidence` only after passing all three complete raw reports to the existing `parseDonationEvidence`; original gross economics and ledger-derived `confirmedAt` remain unchanged. `state: 'unresolved'` has no evidence: 404, other statuses, network/getter/body failures, timeout and contradictory evidence prove neither definitive failure nor inclusion, and never authorize another send.

Pre-network errors **reject**, unlike unresolved network outcomes. Typed `DonationObservationError.code` values are `invalid_fetcher`, `not_found` and `not_submitted`, with exact messages `d1_observation_<code>`. Missing records use `not_found`; unsigned or merely signed records use `not_submitted`. Existing sanitized session/pure-validation errors propagate for invalid original intent, retained data/signature or storage reads. Raw injected-response errors are not exposed.

**Trust and lifecycle limits:** fetch injection is a trusted adapter/test boundary, not cryptographic origin proof. A matching Horizon report is not independent ledger inclusion, settlement or financial acceptance. Another explicit observation is allowed and remains readonly; nothing schedules it. No journal state is added, no identity/time is renewed, and the pending claim stays occupied on every result. Durable evidence persistence, resolved/cache behavior, atomic active-scope release and UI remain later work; this unit does not complete T3.

Focused offline check: `node node_modules/@playwright/test/cli.js test --config playwright.d1.config.ts tests/d1/donation-observation.spec.ts --max-failures=0`. The 44 cases use synthetic SDK-signed snapshots/results, a readonly fake journal and injected fetch only, including one actual 10-second timeout test. No live Horizon, wallet or financial action is part of this check.
