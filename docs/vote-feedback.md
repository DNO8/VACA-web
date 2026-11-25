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

This change does not alter the backend's 24-hour rule, vote weight, promotion threshold, authentication, or transaction submission. The requirement is explained before voting, but age verification still happens in the server's registration flow after the Stellar proof. The current public GET exposes cooldown only; this change does not invent a preflight eligibility contract or copy security policy into a second client validator.

No automatic retry, vote replay, payment, or backend deployment is added. A future pre-signing eligibility check requires a separately defined read-only contract.

## Local checks

Run the isolated client/feedback and existing D1 view regressions without a wallet or network:

```sh
./node_modules/.bin/playwright test --config playwright.d1.config.ts tests/d1/vote-feedback.spec.ts tests/d1/donation-flow-view.spec.ts
```

These tests use fixture responses and a mocked signing/submission boundary. They do not perform real Stellar or Supabase writes and do not replace interactive browser verification.
