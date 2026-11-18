# Interpret a bound manual refund report

`parseRefundReceipt(status, raw, expectedContext)` in `src/lib/d1/refund-receipt.ts` is a synchronous, offline boundary for the existing manual refund/remainder DTO. It returns a detached, deeply frozen public report. It does not select a lane, authorize an administrator, sign, submit, reconcile, reserve execution or query the current time.

## Supply correlation, not a renewed proof

The expected context has exactly six fields: `version`, `action`, `network`, `namespace`, `pool`, `request_id`. The lane/action pairing must be explicit and valid, network must be `TESTNET`, and the namespace/original issuance UUID and public pool must be valid. Use the original request reference, not an incident, balance ID or replacement UUID. Timestamp, wallet, signature and extra fields are not part of this context.

The DTO must match that version/network/namespace/pool and map `requestId` to the retained `request_id`. This correlation is not positive lane discovery, current administrator permission or independent evidence of the original payment. The parser must not fetch configuration or call the command signer to fill missing context.

## Exact report and scalar boundaries

Require exactly these root fields: `version`, `network`, `namespace`, `pool`, `requestId`, `state`, `verification`, `deadline`, `donation`, `refund`, `settlement`, `safeActions`, `reason`.

- `donation` and all its fields are non-null: `paymentOperationId`, `paymentTransactionHash`, `donor`, `asset`, `grossAmount`.
- Operation IDs are canonical positive uint64 decimal strings, including the 20-digit maximum `18446744073709551615`. Hashes are exactly 64 lowercase hex characters. Accounts are Ed25519 public accounts.
- Assets have exact native/issued shapes. Issued code/issuer validation is delegated to the pinned Stellar SDK while preserving the original identity and case; do not normalize an issued `XLM` asset into native XLM.
- Gross/refund amounts are positive canonical seven-decimal strings bounded by `922337203685.4775807`. Known settlement amounts are nonnegative; null remains unknown, not zero. No floating-point arithmetic is used for money.
- `refund` is null or exactly `{transactionHash, amount, claimableBalanceId}`. V1 CBID is null or `00000000` plus 64 lowercase hex characters; v2 CBID is always null. Pending/observed/failed states require a refund object; other states do not impose a blanket null requirement.
- `settlement` is always an object with independently nullable `beneficiaryClaimedAmount`, `donorRefundedAmount`, `remainingPrincipalAmount`. Mixed known/null values are valid.
- Preserve the canonical whole-second UTC `deadline`: round-trip through ISO serialization with `.000Z` removed. Reject alternate offset/fraction spellings or normalized invalid dates. Do not invent a four-digit-year ceiling: the current producer can reach an expanded-year boundary after adding 300 seconds. This format check alone cannot establish original-confirmation provenance; callers with retained payment evidence must compare it separately.

## State and HTTP are separate from financial success

S/R/E below denote the **selected lane's** status/reconcile/execute actions. Their order is exact.

| State | Verification | Reason | Safe actions |
| --- | --- | --- | --- |
| `not_due` | `unverified` | `deadline_not_reached` | S |
| `not_started` | `unverified` | null | E, S |
| `blocked` | `unverified` | `financial_precondition_unavailable` or `remainder_protected` | S, R |
| `pending` | `unverified` | null | S, R |
| `unknown` | `unverified` | `outcome_unresolved` | S, R |
| `refund_observed` | `persisted_sdk_observation` | null | S, R |
| `refund_failed_observed` | `persisted_sdk_observation` | `refund_failed` | S, R |
| `settled` | `persisted_sdk_observation` | null | S |

Status actions use HTTP200 for every valid report state. Other actions use HTTP202 for pending/unknown; execution uses HTTP409 for not_due/blocked; all remaining combinations use HTTP200. **This includes execute+200+not_started**, which must remain an unverified not_started report, never execution acceptance. Backend documentation restricts acceptance wording, but the observed handler mapping has this default-200 case; do not silently invent a wire rejection or success flag.

Only a backend `settled` report with all settlement values known, gross = beneficiary claimed + donor refunded, and zero remaining principal can pass as settled. Claim1 does not settle10. Do not promote another state to settled merely because its arithmetic matches. A fully beneficiary-settled report may have null refund and known zero donor refund. A hash, observation or included failure does not by itself prove returned principal or permit another send. Even a well-formed settled report is not independent blockchain verification.

## Errors and integration boundary

Stable errors are `d1_invalid_refund_receipt_context`, `d1_invalid_refund_receipt`, and `d1_refund_receipt_binding_mismatch`. Malformed responses throw rather than fabricating an `unknown` DTO. Exact data descriptors are required; accessors and hidden/symbol extras are rejected without invoking getters. Dense ordered safe-action arrays are returned as information, never as execution permission.

This parser does not handle `{error: code}` responses or expose transport. Refund-specific proxy admission—including legitimate HTTP409 DTOs—is a later unit and must preserve existing legacy error sanitization. Backend automation, authoritative lane enumeration, durable fences, admin UI and real-wallet/financial acceptance remain separate.

Run offline checks with `node node_modules/@playwright/test/cli.js test --config=playwright.d1.config.ts tests/d1/refund-receipt.spec.ts --max-failures=0`, followed by `node node_modules/typescript/bin/tsc --noEmit --incremental false`. Tests exercise public parsing only; no wallet or backend is contacted.
