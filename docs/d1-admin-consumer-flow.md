# Admin: review an original, then request one explicit D1 action

The existing Admin panel now keeps incident curation separate from financial execution. Promotion/demotion still updates incident status, but neither promotion nor a legacy “release aid” button invokes browser pool release. D1 actions use personal wallet proof; the backend, not the connected wallet or legacy session, decides administrator membership and financial eligibility.

## Quick path

1. Open Admin, select the explicit [A/B profile](d1-b-client-profile.md) (A is default), then explicitly **read public D1 configuration**. This is Testnet technical configuration, not authority to spend. The same profile supplies the command transport, including both refund lanes; B uses `/api/d1/video-auto/` instead of the A prefix in the tables below.
2. Supply the **original signed payment snapshot**, the **retained issuance UUID**, an explicit beneficiary and a canonical allocation amount such as `1.0000000`. Do not substitute a payment UUID, incident ID, claim ID or feed total for an issuance reference.
3. Select **Observe original and retain review**. The existing original-hash observer reads only fixed-origin Testnet Horizon transaction/operations/ledger reports. It validates the donor's signed payment and original facts before a live opaque original handle exists. Imported JSON and cached reports alone cannot produce this handle.
4. Review the immutable donor, pool, asset, gross, payment hash/operation, beneficiary, allocation and original confirmation plus **300 seconds**. A `1.0000000` allocation from `10.0000000` gross does not mean `10.0000000` was settled.
5. Choose a single explicit action and sign its personal proof. Nothing chains automatically. Preserve the displayed report and original references for later explicit observation/reconciliation.

No actor membership, payment-to-incident mapping, beneficiary discovery or lane discovery is inferred from `VaquitaIncident`. The component accepts only independent original context; it does not import the parallel donor flow.

## Initial allocation and issuance

| Action | Required context | What it does not do |
|---|---|---|
| Prepare | Observed original, explicit issuance UUID, beneficiary and exact allocation | Does not issue or discover a beneficiary |
| Issue | A preparation receipt validated against that same context, obtained in this flow or explicitly supplied on recovery | Does not automatically follow prepare or use gross as allocation |
| Reconcile | Explicit known issuance transaction hash, retained issuance UUID and same original context | Does not issue, reset history or infer economics from reconciliation progress |

`commands`, `wallet-proof`, `receipt-context`, `preparation-receipt` and `issuance-receipt` remain unchanged. Preparation accepts an allocated receipt with HTTP 200/201; issuance/reconciliation use their existing status-aware parsers. A pending/unverified report is never displayed as financial success. A known issuance hash remains bound on subsequent responses.

Prepare and issue each acquire an original-network/namespace/pool/issuance-UUID/action hold before sending. The browser adapter uses Web Locks plus localStorage and fails closed when these are unavailable. Records are never replaced or cleared. Reopening the panel, changing an allocation, or receiving 404/503/unknown cannot authorize a second send. A repeated retained action may request a new personal proof before discovering the durable hold, but never sends again. Reconciliation is a distinct explicit action and does not clear either hold.

Changing profile disposes the live review, clears visible configuration/results and requires a fresh original-bound review, but never edits an original, renews a deadline or clears a durable hold. Selection is disabled during every active action; lifecycle guards reject late wallet/storage/network work. Returning to A recovers only A references and retained history, never a B reinterpretation.

On reload, supply the same original signed snapshot and explicit issuance references. An optional retained preparation receipt is structurally and economically bound again; importing it is not backend authorization. Initial reconciliation additionally requires the known issuance transaction hash. There is intentionally no reset control.

## Manual refund and verified remainder

The operator must explicitly select the known lane; there is no default or cross-lane fallback:

| Known lane | Status / execute / reconcile proxy routes | Meaning |
|---|---|---|
| `full_gross_v1` | `/api/d1/refund-status`, `/api/d1/refund`, `/api/d1/refund-reconcile` | Original full-gross v1 contract |
| `verified_remainder_v2` | `/api/d1/refund-remainder-status`, `/api/d1/refund-remainder`, `/api/d1/refund-remainder-reconcile` | Backend-verified remainder, not an operator-entered amount |

All refund commands retain the explicit original issuance UUID and empty payload. `refund-commands` signs personal proof and `refund-receipt` parses the correlated report. The coordinator additionally checks original donor/asset/gross/payment hash/operation and original+300s deadline against the observed original. A report's `safeActions` is displayed data, never permission to execute or switch lanes.

### One-send boundary

1. Reject a known retained original-scope execution hold before requesting another wallet proof.
2. Sign once and serialize once. Existing `refund-submission-preflight` validates the **exact bytes**, signature, freshness, deployment and original identity. It does **not** grant permission.
3. Existing `refund-journal.claimExecution` atomically retains the winning attempt across both lanes. Only that invocation's durable winner obtains an in-memory one-use capability.
4. Consume the capability before any asynchronous send work, re-read the exact retained hold, revalidate the original bytes, check disposal, then send those bytes once to the selected fixed route.

A loser, retained/uncertain claim, failed validation, disposal, expired proof, unknown response, 404 or 503 cannot recreate a capability. Status/reconcile do not write or clear execution history. Reloading loses the in-memory capability and cannot recover it from stored bytes. This intentionally favors retention over a possible duplicate financial send.

## Limits and failure handling

- All financial POSTs are credential-free, same-origin fixed routes, limited to 8192 request bytes, 65536 response bytes and one 10-second bounded attempt. No redirect, automatic polling, retry or fallback exists.
- Errors display a localized explanation and bounded technical reason, including backend machine error/status. Responses must pass existing receipt parsers; HTTP acceptance alone never means settlement.
- Forms use visible labels, named controls, explicit helper button types, in-flight exclusion and live status/error announcements. Editing review inputs disposes the previous flow. Late wallet/storage/network completions cannot publish a stale report; disposal before transmission leaves any acquired hold retained.
- Original observation is fixed-origin report consistency, not an independent inclusion proof or authorization credential. The readonly observer adapter never writes a donation record or creates a donation submission permit.
- Browser holds protect only the same browser origin and intact storage. Storage eviction/deletion, malicious same-origin code and other devices remain outside browser exclusion. The backend remains authoritative.
- The six-route refund proxy prerequisite exists on this feature branch; publication/promotion and deployment are parent-owned. No live backend, wallet or financial acceptance was exercised here.
- Target backend A (`a7ad40826b4c5e65c1a0b3a6c2bb2276999b2afa`) explicitly 404s `donor-payment-status`; this consumer never calls it. Internal tick/token/cursor, private signer, cutoff selection and scheduler activation remain backend-only. No missing discovery contract is disguised as financial readiness.

## Review and verification

Review `refund-submission.ts` first (durable winner versus preflight), then `admin-flow.ts` (original and receipt binding), then the two Admin components (explicit actions and curation separation). ES/EN strings live in `admin-flow-messages.ts`, not shared `i18n.tsx`.

Tests cover original mismatch before financial calls, separate prepare/issue/reconcile, retained history, exact full/remainder routes and bytes, competing/reloaded/uncertain holds, double invokes, stale wallet/storage completion, economic report rejection and curation preservation. Offline component rendering uses TypeScript ReactJSX, not Playwright's JSX descriptors. Journal browser-concurrency and primitive parser suites remain their existing independent proof; injected journal tests here verify composition, not a new claim of real-browser durability.

Historical T2 scoped commands (117 tests and scoped types passed before the browser-regression file below was added). The `tests/d1/admin-flow` selection now also includes that browser file, so it requires the browser/runtime environment described below rather than assuming a Node-only run:

```text
node node_modules/@playwright/test/cli.js test --config playwright.d1.config.ts tests/d1/admin-flow tests/d1/refund-submission.spec.ts tests/d1/refund-submission-preflight.spec.ts tests/d1/refund-proxy.spec.ts
node node_modules/typescript/bin/tsc --noEmit --incremental false --project node_modules/.cache/d1-consumer-flow-checks/admin.json
```

This coherent unit exceeds the advisory 400-line target because it includes two separate execution boundaries, a bounded transport, bilingual mounted UI, behavioral tests and operator recovery documentation. No shared financial primitive, dependency, server proxy or backend was modified.

Coverage: **S1/S3** existing D1 web/Admin integration; **S5** explicit manual full/remainder controls without exposing automatic backend internals; **S6** independently implemented while live financial, independent review and deployment proof remain explicitly separate. Publication/deployment (S2) and donor repeat-release (S7) are not claimed by this unit.

### T3 portable browser regressions: verified offline

`tests/d1/admin-flow-browser.spec.ts` adds three small **new** portable regressions for S1/S5. These are not byte-exact adoption of the independent verifier's removed artifacts and do not repeat or replace its reported four passing probes.

| Case | Real code under test | Explicit test boundary |
|---|---|---|
| Original/amount review, explicit action, busy exclusion and unknown report | Current `D1AdminPanel`, React DOM, labels/messages and original deadline helper | Synthetic config/original/coordinator/wallet ports; no claim of cryptographic validation, backend membership, execution hold or financial settlement |
| Promotion/demotion and change callbacks with zero legacy financial calls | Current `AdminPanel` and mounted D1 panel | Synthetic curation port and legacy-call traps; no old baseline or Git history comparison |
| Shared single winner and reload retention across v1/v2 | Current `refund-journal` with real Chromium IndexedDB in independent tabs | Opaque journal bytes only, not a signature, preflight validation or one-use send capability |

The fixture compiles current UI source with installed TypeScript and compiled webpack `bundle5()`. Embedded test ports/entry/loader and bundle output live only in a fresh `os.tmpdir()` directory, with teardown cleanup. Resolution retains normal `node_modules` fallback for pnpm's nested scheduler. Each case launches sandboxed Chromium with a fresh context, blocks service workers and aborts all traffic except the synthetic document/bundle routes. No Next server, environment file, real wallet/backend, install, fixed commit or old artifact path is read by the tests.

Portability evidence, including retained failures:

- Earlier handoff: supplied artifact reads returned ENOENT; the absent-test command exited 1 with `Error: No tests found.` and scoped types exited 0. This was removed temporary handoff data, not failed independent proof; zero fixture corrections were consumed then.
- The initial browser command collected three tests and printed the first case, then the foreground tool timed out at **30 seconds**. It reported no completed test, assertion failure or numeric exit code. That attempt remains failed; it was not retried automatically.
- Initial scoped typecheck exited 2 with TS2345 because the fixture name `offline` conflicted with Playwright's existing boolean option. One fixture-only correction renamed it `adminPages`; the same scoped typecheck then exited 0 without diagnostics. There were no production corrections and no reset of prior production budgets.
- The human subsequently authorized parent-owned continuation with an outer 90-second bound, unchanged per-test timeouts and one remaining fixture correction. The corrected-name run failed because the synthetic page decoded UTF-8 as a legacy encoding: its accessibility snapshot showed `D1 Â·` instead of `D1 ·`. Explicit UTF-8 HTML/JavaScript response headers and a charset meta tag fixed the fixture, without changing production or weakening assertions. The remaining correction was consumed.
- The corrected fixture passed **3/3 tests in 3.8 seconds**, and scoped TypeScript passed. The parent then ran the combined offline suite once: **640/640 passed**, full-project TypeScript and whitespace checks passed. Previous failed runs remain historical, not erased or counted as passes.
- These checks complement the separate four-probe independent Admin verification, including sandboxed browser interaction and real IndexedDB. Live financial/backend membership, production-build and deployment acceptance remain separate; teardown of the original interrupted run was not established.

Exact browser portability command used from the repository root (runtime paths are invocation configuration, never baked into the committed test):

```text
env D1_TEST_BROWSER=/home/danilo/projects/vaca-web-d1-posix/node_modules/.cache/playwright-browsers/chromium-1228/chrome-linux64/chrome LD_LIBRARY_PATH=/home/danilo/projects/vaca-web-d1-posix/node_modules/.cache/d1-journal-independent-u9y25wjf/runtime/lib node node_modules/@playwright/test/cli.js test --config playwright.d1.config.ts tests/d1/admin-flow-browser.spec.ts
node node_modules/typescript/bin/tsc --noEmit --incremental false --project node_modules/.cache/d1-consumer-flow-checks/admin.json
```
