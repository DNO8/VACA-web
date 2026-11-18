# Journal v2: preserve history and one active donation per scope

The T3/S10 foundation upgrades valid v1 journals without rewriting donation
records. It separates historical UUIDs from active scope ownership and adds
consistent readonly views. There is **no resolution writer or release API**.
Parent RED observed 26 failures and eight preserved schema guards against v1;
implementation is now ready for parent-owned browser GREEN and compatibility.

## Storage contract

| Surface | Exact definition |
| --- | --- |
| Database version | `2`; higher versions fail closed |
| `donations` | Existing `requestId` key path, no auto-increment; unchanged record envelopes |
| `donations.scope` index | Key path `scope`, nonunique, not multi-entry; retains all history |
| `scopes` | Key path `scope`, no auto-increment, no indexes; `{scope, requestId, active}` |
| `resolutions` | Key path `requestId`, no auto-increment, no indexes; `{requestId, evidence}` |

`openDonationJournal` returns `DonationJournalV2`, extending the unchanged
`DonationJournal` interface. Existing `read`, `saveSigned`, `claimSubmission`,
exact-byte guards, and immutable record envelopes retain their prior semantics.
`readScope(scope)` returns a frozen `{record, active, resolution}` view (including
an independently frozen existing-format record), or `null` for a truly absent
scope. All related reads use one readonly transaction and publish only after
completion. `readResolution(requestId)` returns exact opaque evidence or `null`,
validating the associated record and scope history in that same transaction.
The existing 1,048,576-character payload limit applies to evidence; this is not
JSON parsing, signature verification, ledger observation, or settlement authority.

A v1 upgrade must validate the exact old schema and every record/key, retaining
all original records and making every old scope active/unresolved. A late bad
row, request error or abort must roll back both data and schema. The old unique
scope index becomes nonunique only inside that same versionchange transaction.

Acquisition reuses an active owner across connections. An inactive latest pointer
requires a claimed record and its matching resolution before a fresh UUID can
become owner. Reusing a historical UUID returns only its original matching
record; it never reactivates that record or replaces the latest pointer.
Missing/corrupt ownership with existing history, wrong linkage, or contradictory
resolution state fails closed with `d1_journal_invalid_record`. Every historical
predecessor must also be claimed with matching evidence; a forged latest pointer
cannot hide an unresolved record. This scans the scope's history rather than
assuming a pointer alone proves safety. Acquisition writes the donation and
pointer atomically, returning only after transaction completion.

Arguments retain the existing bounded scope/UUID/payload rules and sanitized
`d1_journal_invalid_argument` errors. Aborted operations return
`d1_journal_storage_error`; failed upgrades return `d1_journal_open_failed` only
after the native request reports rollback. Blocked opens remain rejected even
if a later event arrives; versionchange closes old connections.

## Parent verification handoff

With the already-authorized browser environment supplied by the parent:

```sh
node node_modules/@playwright/test/cli.js test --config=playwright.d1.config.ts tests/d1/donation-journal-v2.spec.ts --max-failures=0
```

The test-local V2 type deliberately avoids importing a not-yet-existing export.
The real Chromium harness transpiles only the standalone journal module; all
requests are intercepted locally. Native writes create only uniquely named
legacy/resolved/corrupt fixtures; teardown deletes only that test's database.
Thin fault boundaries preserve native requests/transactions for migration abort,
request-error, late-success cleanup, and readonly completion checks. Native
snapshots are limited to rollback/version checks when the new opener rejects.

The original 13 journal tests retain every assertion; after RED their sole
unsupported-version fixture advanced from `2` to `3`. The V2 late-success test
registers its terminal observer after the production success handler, avoiding
a microtask checkpoint before cleanup without weakening the close-count check.
Before closure, the parent also owns a scratch-only BASE/CURRENT differential covering
`acquire`, `read`, `saveSigned`, `claimSubmission`, and `close`; no committed test
reads Git history. Resolution writing, actual user databases, UI, networking,
signing, and financial actions remain outside this unit.
