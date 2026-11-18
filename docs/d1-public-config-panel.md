# D1 configuration visibility in the donor panel

The incident panel reads `/api/d1/config` and distinguishes loading, available and unavailable **technical configuration**. Available means the existing exact TESTNET/pool/namespace/300-second DTO validator accepted the response; it does not establish funded custody or a working financial journey.

The existing Donate button remains on the legacy flow, explicitly identified in both Spanish and English. Wallet connection, voting, payments, persistence, admin and backend routes are unchanged.

The reader performs one credential-free, no-store GET, rejects redirects, limits the response to 4,096 bytes, decodes strict streaming UTF-8 and uses a maximum five-second deadline. `AbortSignal.any` combines caller cancellation with `AbortSignal.timeout`; unsupported browsers show unavailable without a request. Unmount cancels the request and suppresses stale UI updates. No polling or retries are added.

Focused offline checks cover the public reader, cancellation/deadline, byte boundary, invalid responses and rendered technical states. These do not prove live backend availability or browser/device financial operation. The remaining donor integration needs the backend owner's current evidence and active-beneficiary-CB contract; see `odd/tasks/d1-web-integration-resume.md`.
