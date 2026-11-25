# Understand the result of a Testnet vote

A confirmed Stellar transaction is a public proof, not confirmation that VACA registered the vote. The incident panel now keeps both outcomes visible in Spanish or English, with a transaction link when Stellar returned a confirmed hash.

## Read the result

| Result | Meaning and next step |
| --- | --- |
| Vote recorded by VACA | The server accepted the vote. Only this result updates the incident counter and promotion state. |
| Account too new | The current Stellar Testnet account must be at least 24 hours old. The panel shows the server's eligibility date in your local time zone when supplied, plus a readable remaining duration in Spanish or English (for example, “Te faltan 3 horas y 25 minutos para poder votar”). Wallet installation age is unrelated. |
| Account age unavailable | The server could not verify account creation. This does not establish that the account is too new. |
| Registration unconfirmed | Stellar may have confirmed the proof, but the server response does not establish acceptance. Keep the transaction link; do not sign again merely to check. |
| Voting cooldown / already voted | The existing five-minute cooldown and one-vote-per-wallet-and-incident rules still apply. |

The result stays visible while the same incident and wallet are selected; it is not dismissed by the generic five-second error timer. A server rejection can still have a confirmed Stellar transaction link. That link is not a donation, CB issuance, beneficiary delivery, or refund receipt.

The remaining duration uses the server's timezone-qualified `eligible_at`. If that is unavailable, a valid nonnegative integer `retry_after` from `wallet_too_new` is anchored once when the response arrives. It never uses the cooldown GET as an account-age estimate. Missing or invalid timing data produces no invented countdown. The browser clock updates the estimate, rounding positive remainders up to a minute; reaching zero only invites another attempt with server revalidation, never marks a vote accepted or triggers signing/submission. The timer is separate from the polite status region so recurring updates do not repeatedly announce the whole result. `Intl.DurationFormat` formats supported browsers; localized number/unit and list formatters provide the fallback without a new dependency.

## Scope and limitations

Before any funding, account load, signature or transaction submission, the web requests `GET /functions/v1/vaquita-vote?voter=<encoded-public-key>&check=wallet_age` with caching disabled. Only HTTP 200 with the explicit boolean `wallet_age_eligible: true` opens the transaction flow. HTTP 403 `wallet_too_new` displays the existing date/countdown and explicitly says no transaction was signed or submitted and no XLM was spent on this attempt. Unavailable age, authentication/network failures, a 12-second timeout, malformed JSON or a legacy cooldown-only response all stop before signing.

All vote requests (preflight, registration and cooldown) send the project's public legacy anon JWT in both `apikey` and `Authorization: Bearer …`, preserving the gateway's JWT protection. Configure `NEXT_PUBLIC_SUPABASE_ANON_KEY` with that public anon JWT, never a service-role key; an opaque publishable key is not a JWT bearer. The preflight blocks if the gateway rejects the configured credentials. Adding authorization only to the preflight would leave final registration failing after a fee-bearing submission.

The server must implement this additive read-only contract before the web is deployed. The legacy GET without `check=wallet_age` still means cooldown only; it never clears account age. The preflight does not reserve a vote or guarantee acceptance. Final POST validation, the 24-hour rule, vote weight, promotion threshold, authentication, duplicate/cooldown checks and post-submission proof handling remain authoritative and unchanged. Errors after submission may still have a transaction fee and confirmed link; the no-transaction statement is restricted to the explicit preflight stage.

No automatic retry, vote replay, payment, wallet creation, or backend deployment is added by this change. An absent or unverifiable account is not automatically funded by a rejected preflight; the shared donation/funding helper is unchanged. Deploying only the web against an older backend deliberately blocks voting rather than guessing eligibility.

## Local checks

Run the isolated client/feedback and existing D1 view regressions without a wallet or network:

```sh
./node_modules/.bin/playwright test --config playwright.d1.config.ts tests/d1/vote-feedback.spec.ts tests/d1/donation-flow-view.spec.ts
```

These tests use fixture responses and a mocked signing/submission boundary. They do not perform real Stellar or Supabase writes and do not replace interactive browser verification.
