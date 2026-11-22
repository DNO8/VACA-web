# First D1 donation and original-payment recovery

**Donar now uses the existing D1 helpers on Stellar Testnet, not the legacy demo pool.** Prepare, sign, send and check are separate user actions. A pool payment is not beneficiary delivery or financial settlement.

## Quick path

1. Open a promoted incident and choose the explicit [D1 profile](d1-b-client-profile.md): **A · original (default)** or **B · video-auto (separate pool)**. Connect the existing Freighter wallet. It must have an existing funded Testnet account; this flow never funds accounts. Configuration and the donation use the same selected profile.
2. Enter positive native XLM using a decimal point and at most seven decimal places. Select **Prepare or recover original**. Preparation reads the fixed Testnet account sequence and saves the original before any signature.
3. Review the retained exact amount, configured pool, full incident, namespace, donor, request UUID and original transaction hash. Select **Sign exactly … XLM**. Signing does not send.
4. Select **Send signed … XLM once**. A durable claim must succeed before the one POST of the exact retained wallet bytes. An HTTP response is unverified, not payment evidence.
5. Select **Explicitly check original payment** to read that original hash, its single payment operation and ledger from fixed Testnet Horizon. There is no automatic polling. A matching observation displays the immutable ledger-confirmation time plus 300 seconds, not a new deadline.

> **Repeat-donation limitation:** another donation by the same wallet to the same D1 network/pool/namespace/incident remains retained until an accepted active-beneficiary-CB query is integrated. Confirming the pool payment does not unlock another payment. This is a temporary integration limitation, not a permanent product cap.

## Recovery and uncertainty

| Situation | Behavior |
| --- | --- |
| Existing scope, including a different entered amount | Recover its original UUID, economics and transaction before generating a new identity or reading a sequence. |
| Prepared but unsigned | Review and explicitly sign the retained original. No replacement body or renewed timebounds. |
| Signed but not claimed | The retained exact bytes can be explicitly submitted once. |
| Claimed, timeout, transport error, HTTP error or unknown | Never retry, clear, release or replace the claim. Recover and explicitly check the original instead. |
| Competing tab/coordinator | Journal scope acquisition and submission claim choose the winner, not a React state flag. |
| Corrupt or substituted cached evidence | Reject through the existing original-bound validators; never use cached flags as release authority. |
| Browser storage unavailable | Fail closed; no signing or sending without durable storage. |

Changing profile sends nothing and releases nothing. Selection is locked synchronously during an explicit financial action, including wallet/storage waits. Configuration loading alone does not steal native radio focus or prevent another selection. A changed/unmounted panel rejects late results and cannot start a late network send; return to the original profile to recover its unchanged original. Both profiles keep independent network/pool/namespace scopes in the same existing journal; switching is not permission to resend an A payment as B.

The browser uses the IndexedDB journal `vaca-d1-donations`. Recovery reconstructs unsigned XDR and validates retained signatures through `donation-session`; optional opaque journal resolution evidence passes `validateStoredDonationEvidence`. This is consistency checking, **not authentication of local storage**. There is no new resolution writer, import/export channel, backend donor-status endpoint or active-CB resolver. Fresh observations are held in the current panel only; after reload explicitly check again. No secrets are exported.

## Boundaries to review

- `donation-flow.ts`: scope recovery first; decimal text normalization without floats; native XLM only; explicit helper composition. The fixed 180-second transaction validity window is separate from the D1 original-confirmation-plus-300-second deadline.
- `donation-account.ts`: fixed `https://horizon-testnet.stellar.org/accounts/{validated-account}`, credential-free GET, redirects rejected, JSON limited to 65,536 bytes and a five-second deadline even for abort-ignoring transports. Missing/wrong accounts and invalid sequences fail before acquisition.
- `donation-recovery.ts`: full context and retained original validation, optional cached evidence validation, immutable deadline, no scope release.
- `D1DonationPanel.tsx`: visible amount label, named form, exact amount on sign/send controls, in-flight exclusion, live results/errors and stale/unmount suppression. No automatic signature, submission or observation. Async completions from an old wallet/incident cannot update the current panel.
- `VaquitaAside.tsx`: only the legacy donation invocation is replaced. Wallet connection, balance display, vote/cooldown and incident rendering remain separate. Donation work disables wallet/vote controls and vice versa.

## Offline checks

All traffic is injected; no live wallet, account, backend or financial requests are needed. The browser selections need the already-provisioned browser/runtime environment described below.

```sh
node node_modules/@playwright/test/cli.js test --config playwright.d1.config.ts tests/d1/donation-flow tests/d1/donation-session.spec.ts tests/d1/donation-submission.spec.ts tests/d1/public-config-view.spec.ts
node node_modules/typescript/bin/tsc --noEmit --incremental false
```

SSR view checks use the existing TypeScript `transpileModule`/ReactJSX approach rather than Playwright's component descriptors. They remain separate from the browser regressions below.

### Portable browser regressions (S4/S7)

`tests/d1/donation-flow-browser.spec.ts` adds three new regressions derived from current production and the existing fixtures. It is **not a byte-exact adoption or rerun of the disposable independent probes**. The earlier artifact handoff returned ENOENT and the then-missing test selection returned `Error: No tests found.` (exit 1, zero tests); that was unavailable input, not a product failure.

| Regression | What it proves | What it does not prove |
| --- | --- | --- |
| Production Aside/Panel in React DOM | Explicit prepare/sign/send/check, exact retained amount, busy wallet/vote exclusion, preserved vote callback/cooldown, and no reopening after unknown/observed results. | Real wallet signing, coordinator transport, cryptographic observation validation or settlement: financial/configuration ports are synthetic. |
| Pending UI completion | Incident change and unmount discard pending preparation results without signing/sending or repainting the current panel. | Every possible asynchronous race or browser lifecycle. |
| Production journal in real Chromium IndexedDB | Independent connections permit one original submission claim; exact opaque bytes and the hold survive reload and reject another amount/UUID. | Signature validity, coordinator composition or network delivery; this intentionally isolates the journal. |

The test transpiles the unmodified production components with TypeScript and bundles them using the installed compiled webpack API. Embedded fake ports and bundle output live only in a fresh `os.tmpdir()` directory and are removed in `finally`. Chromium keeps its sandbox enabled; each case uses a fresh synthetic origin, blocks service workers and aborts unexpected traffic. No Next server/config/environment loader, real wallet, backend or network payment is used.

Supply `D1_TEST_BROWSER` and, where required, `LD_LIBRARY_PATH` through the process environment using already-provisioned public browser/runtime paths:

```sh
node node_modules/@playwright/test/cli.js test --config playwright.d1.config.ts tests/d1/donation-flow-browser.spec.ts
```

Observed scoped result: **3/3 browser regressions passed** (22.6 seconds), and the donor scoped TypeScript project passed with no output. One fixture-only `Window` intersection annotation correction resolved the initial TypeScript diagnostics; the first browser run had also passed all three cases. No production correction was made, and no new product RED is claimed.

The parent subsequently ran one combined offline suite: **640/640 tests passed**, full-project TypeScript and whitespace passed, with no production correction. These retained regressions complement the parent-recorded independent DOM and real coordinator/IndexedDB probes; they do not replace that evidence or establish live Freighter/backend, production-build, deployment or financial acceptance. Wallet/network correctness and concurrent durable submissions remain named high-risk boundaries.
