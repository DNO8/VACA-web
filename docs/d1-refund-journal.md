# Shared refund execution hold

`openRefundJournal(indexedDB)` opens the fixed, origin-local IndexedDB database
`vaca-d1-refund-holds` at version 1. Its only operations are `read(identity)`,
`claimExecution(identity, attempt)` and `close()`.

## Identity and retained attempt

Identity is exactly `{network: 'TESTNET', namespace, pool, request_id}`. Namespace
and original issuance request ID are lowercase UUIDs; pool is structurally a
Stellar G-address. Checksum, deployment matching, original-request provenance,
current administrator authority and financial eligibility must already have been
validated by the caller. This persistence boundary does not authenticate them.

An attempt is exactly `{version, action, signedBody}`: version 1 with `refund`,
or version 2 with `refund_remainder`. `signedBody` is an opaque nonempty string
of at most 8192 UTF-8 bytes, retained without normalization or JSON reserialization.
The future submission boundary must validate its actual command, signature and
identity agreement before claiming. Storing bytes does not validate a signature.
Status and reconciliation commands are not execution attempts.

Both lanes share one identity key. Version, action, administrator, timestamp and
signature do not create a separate reservation. Atomic `claimExecution` returns
`{claimed: true, hold: {identity, attempt}}` only for the first committed insert.
Every later call returns `claimed: false` with the original winning hold, even
with different lane/proof bytes. `read` returns that hold or `null`. Returned
objects are detached and deeply frozen; caller inputs remain untouched.

## Failure and recovery boundary

Only transaction completion publishes a claim; a successful insert request is
not enough. No storage/open/abort failure falls back to memory. Errors use
`d1_refund_journal_` followed by `invalid_argument`, `invalid_record`,
`unavailable`, `open_failed`, `blocked`, `closed` or `storage_error`.

There is no reset, release, delete, TTL, receipt-driven clearing or retry API.
Close/reopen/reload does not authorize another claim. After a committed claim,
a crash or lost response may leave submission unknown: recover only through
separately authorized, freshly signed status/reconciliation, never a replay or
a switch to the other lane. This module performs no fetch, signing or clock read.

The journal coordinates connections within one browser origin/storage partition.
It cannot protect against cleared/evicted or maliciously replaced storage,
another origin/device, or backend automation. Backend guards 037/040/046 remain
the final execution authority. Their automatic/manual executor integration is
not proved by this client module. A journal alone also cannot prevent callers
from bypassing it; the later submission/UI unit must claim before every send.

Run the offline real-browser checks with
`node node_modules/@playwright/test/cli.js test --config=playwright.d1.config.ts tests/d1/refund-journal.spec.ts`
and the project-local sandboxed Chromium configuration described in
[d1-web-integration.md](d1-web-integration.md). No wallet or Testnet call is needed.
