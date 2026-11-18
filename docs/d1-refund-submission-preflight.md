# Validate retained refund proof bytes before composition

`validateRefundExecutionAttempt(config, signedBody, expectedIdentity, clock?)`
checks a retained signed execution command offline and returns a frozen,
detached `{ identity, attempt }`. It does **not** authorize execution, determine
eligibility, discover an original request, select a lane, claim the journal,
request a wallet signature, or send anything.

## Mechanical checks

- The input is a JSON string of at most 8192 UTF-8 bytes, with exactly the ten
  signed refund fields. Duplicate root keys, including escaped equivalents,
  are rejected rather than resolved by last-key-wins parsing.
- The unsigned command satisfies the existing configuration, identity, empty
  payload, version/action and inclusive ±60-second freshness rules.
- Only explicit v1 `refund` and v2 `refund_remainder` attempts are accepted;
  status/reconciliation commands cannot become execution attempts.
- Network, namespace, pool and original issuance request UUID must match the
  separately supplied expected identity. The identity is snapshotted before
  invoking the injected clock; no accessor-backed or extra fields are accepted.
- The signature must be canonical base64 for 64 bytes, verified against the
  command wallet over the SHA-256 digest of `Stellar Signed Message:\n` followed
  by compact JSON with sorted unsigned root keys. Payload is exactly empty.
- Freshness is checked again after proof verification. No timestamp is renewed.

The returned `attempt.signedBody` is the **original input string**, including
accepted whitespace and field order. Validation does not reserialize the body.
The input configuration and identity are not frozen or mutated by the validator.

## Errors and limits

`d1_invalid_refund_attempt` covers malformed, ambiguous, oversized or unsupported
execution envelopes and invalid expected-identity object shapes.
`d1_refund_attempt_mismatch` means the command and expected original identity
disagree. Existing `d1_invalid_config`, `d1_invalid_refund_command`,
`d1_stale_refund_command` and `d1_invalid_signature` errors remain distinct.

A valid personal signature proves neither current administrator membership nor
original-payment provenance. An expected identity is a caller-supplied comparison
context, not independently authenticated evidence. This function does not bind
reported donor/asset/gross/confirmation time or produce an eligibility capability.

Before future UI/transport composition, the caller still needs authoritative
original-request and positive lane evidence, current-admin permission, a durable
winning [shared hold](d1-refund-journal.md), and backend revalidation/fences.
After a hold is committed, any crash or uncertain send must retain it; running
this validator again never grants a replay, lane switch, reset or release.
The underlying [command contract](d1-refund-commands.md) is unchanged.
