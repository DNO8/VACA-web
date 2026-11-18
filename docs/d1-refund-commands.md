# Build a personal proof for a manual D1 refund action

`src/lib/d1/refund-commands.ts` constructs and signs **offline manual commands**. It does not send requests, discover the refund lane, schedule automatic refunds, persist a submission claim or prove administrator authority. Existing issuance helpers and the HTTP proxy are unchanged by this unit.

## Usage

1. Retain matching public D1 configuration, the **original issuance request UUID**, and a positively established refund lane. Neither an incident ID nor a claimable balance ID replaces that UUID. Do not generate a new UUID or try one lane and fall back to the other.
2. Call `buildRefundCommand(config, input, clock?)` with exactly `version`, `action`, `request_id`, `timestamp`, `payload: {}`, and `wallet`.
3. Call `signRefundCommand(config, command, signMessage, clock?)`, injecting Freighter's `signMessage` or an offline equivalent. It returns a detached, deeply frozen signed command. Keep it for the separately guarded transport; this helper never submits it.

| Explicit version | Allowed signed actions |
| --- | --- |
| `1` | `refund_status`, `refund`, `refund_reconcile` |
| `2` | `refund_remainder_status`, `refund_remainder`, `refund_remainder_reconcile` |

Signed action names use **underscores**, not the backend URL paths' hyphens. The helper does not select or construct URLs. It rejects cross-version actions rather than choosing a fallback. A `safeActions` list from one lane is not evidence that the lane itself is correct.

## Wire and proof contract

The unsigned command has exactly nine fields: `version`, `network`, `pool`, `namespace`, `action`, `request_id`, `timestamp`, `payload`, `wallet`. Signing adds only `signature`, giving ten fields. Matching `network: "TESTNET"`, pool and namespace come from `validateD1Config`; the UUID and personal wallet are validated without normalization. No destination, amount, asset, fee or XDR is accepted in the empty payload.

`validateRefundCommand(config, unknownCommand, clock?)` accepts **unsigned** commands, checks exact plain-data fields without invoking accessors, and returns an independent frozen snapshot. Signed inputs and extra, hidden or symbol fields are rejected. The helper can validate a UUID's format but cannot authenticate its provenance or the caller's lane choice.

Timestamps and the injected clock are nonnegative safe-integer Unix seconds. The inclusive **±60-second** window is checked before and after the wallet callback. Expiry causes rejection; it never renews the timestamp or signs again. There is at most one wallet interaction per invocation. The caller must retain durable execution ownership separately; calling this helper is not a submission claim.

The wallet receives compact, lexicographically root-key-sorted **raw JSON** and the selected wallet/TESTNET network passphrase. Its signature must verify locally against Ed25519 over SHA256(UTF8(`Stellar Signed Message:\n` + JSON)). The wallet applies the prefix/hash itself: do not prehash or double-prefix its input. Accept only 64-byte `Uint8Array`/Buffer or canonical standard-base64 signatures; output uses canonical base64. Validated field bounds keep the message small, and the final signed JSON is checked against **8192 UTF-8 bytes**.

| Stable error | Meaning |
| --- | --- |
| `d1_invalid_config` | Invalid matching public configuration |
| `d1_invalid_refund_command` | Invalid shape, lane/action, identity, payload, timestamp/clock or signed wire size |
| `d1_stale_refund_command` | Outside the freshness window, including after wallet interaction |
| `d1_wallet_error` | Wallet rejection, error result or non-data response |
| `d1_signer_mismatch` | Missing or different signer |
| `d1_invalid_signature` | Unsupported representation or failed local proof verification |

A valid signature is **not** current administrator membership, persisted-scope permission, refund eligibility, blockchain inclusion or settlement. The backend still enforces those boundaries. No pool secret, service-role credential, automatic-service identity or financial execution is introduced here. Real installed-wallet interoperability remains unproved by offline tests.

## Verification and remaining work

Run `node node_modules/@playwright/test/cli.js test --config=playwright.d1.config.ts tests/d1/refund-commands.spec.ts --max-failures=0`, then TypeScript with `node node_modules/typescript/bin/tsc --noEmit --incremental false`. Tests use synthetic keys and a Node-crypto oracle; no live wallet or backend is contacted.

DTO validation, narrowly admitted refund-only HTTP 409 responses, transport routing, original-reference discovery, shared automatic/manual execution fences and the admin UI are separate units. Do not connect an execution button until its original reference and lane are established and its guarded submission path exists.
