# Folder preview peer timeout: fix plan

Status: implemented locally on 2026-09-10. The original investigation below is retained as context. Preview requests now negotiate bounded authenticated progress, reset their five-minute idle wait only on valid progress, enforce a thirty-minute scan deadline, abort disconnected handlers, and support dialog cancellation with preserved selections. The real failing PC session has not been reproduced; the fix is verified with authenticated loopback tests and a real Electron preload/renderer smoke using synthetic main-process peer responses. Initial/continuous sync large-folder limitations remain separate follow-up work.

## Evidence and limits

- `apps/desktop/src/main/index.ts:1210` owns preview orchestration: local scan, then remote `scan-manifest`, then comparison. The remote request explicitly receives five minutes (`:1233`); increasing the default 45-second peer timeout would not fix this caller.
- `apps/desktop/src/main/peer-session-service.ts:189` and `:221` use the same supplied timeout independently for handshake welcome and encrypted response. Both can produce the identical error at `:518`. The reported message alone cannot identify the phase or prove a slow scan.
- The responder awaits `onRequest` at `peer-session-service.ts:326`. Its socket-close callback (`:241`) closes the connection but does not abort `handlerController`. That controller is only aborted in `finally`, after the handler settles. A disconnected caller can therefore leave a scan running or queued, holding scan/session capacity and making retries worse.
- The context comment promises deadline cancellation, but no handler execution deadline is installed. Existing timers cover connection/read/response flush, not the awaited handler.
- `index.ts:3012` dispatches remote manifest scans through `runLocalScan` and its admission queue. Preview scanning reads and hashes eligible files; five minutes may be consumed by queueing, disk work, or an unresponsive filesystem. These are hypotheses for the initial timeout, not measured findings.
- Graceful response flushing already exists (`await connection.end(...)`). Its existing 8 MiB encrypted loopback test passes; do not reapply the old response-truncation fix.
- `apps/desktop/src/renderer/components/add-folder-dialog.tsx:133` displays the raw invocation error. Remote progress reports only waiting, without remote scan counts.

The actual failing two-device session has not been reproduced. Confirm both installed builds and time spent in the failing phase before claiming its root cause.

## Ordered implementation

1. **Add a regression fixture and phase evidence.** Extend the existing authenticated loopback fixture. Hold the responder handler behind a controllable barrier, let the requester time out or cancel, and assert the responder signal aborts before releasing that barrier. Always release fixtures during cleanup. Add distinct bounded diagnostics for connect, welcome, response, and flush; record operation, ephemeral request correlation, elapsed time, and responder queue/scan duration. Do not log paths, manifest contents, credentials, or stable device identifiers. Capture these diagnostics from the actual failure.

2. **Repair responder cancellation.** Abort the handler controller immediately on socket closure and transport failure. Preserve final cleanup and propagate the existing signal through queued and active scan work. Check already-aborted signals before scan admission. Verify slots and session accounting return to their previous levels once cooperative work stops. Do not release a running scan slot early while its filesystem work continues.

3. **Make deadlines explicit and bounded.** Separate the short handshake budget from the operation response budget. Define a receiver-owned scan deadline covering queue wait and execution, and make the requester budget allow a bounded terminal response flush. Scope the policy to scan operations after inspecting all callers; approval and transfer requests have different timing needs. Clear deadline timers/listeners on every exit. Keep cancellation cooperative and document that a stuck OS filesystem call may not stop until it returns. Do not introduce an unbounded wait, automatic retries, or a peer-controlled unlimited timeout.

4. **Resolve the measured initial cause.** If handshake stalls, investigate peer process responsiveness and installed protocol/build compatibility. If queue wait dominates, verify abandoned work is gone and give a recoverable busy outcome. If healthy scan work exceeds the budget, measure the temporary-root workload before selecting a justified bounded scan budget or a separately scoped progress/job protocol. Existing generation paging serves approved mappings and is not a drop-in replacement for pre-approval preview. Any progress protocol requires capability negotiation, authenticated correlation, bounded messages and compatibility tests.

5. **Return actionable preview errors.** Preserve technical phase details in safe diagnostics while showing the peer name and the appropriate retry/check-peer message. Preserve paths and settings after failure and clear loading state. Distinguish an unavailable peer from a scan that exceeded its deadline. Use an explicit validated result contract if reliable error categories must cross Electron IPC; do not rely on custom Error properties surviving `invoke`, or blindly strip error strings. Update both preload/main and renderer consumers if that contract changes.

## Acceptance tests

- Caller timeout and explicit cancellation each abort a running responder handler before it independently completes.
- Disconnect while queued removes the scan; disconnect while scanning stops at the next cooperative checkpoint; a subsequent request succeeds without leaked capacity.
- A connected caller cannot keep scan work alive indefinitely; receiver deadline cancellation is tested with a bounded terminal response.
- Slow/missing welcome and slow operation response yield different diagnostics. A valid scan longer than the handshake budget still succeeds within its scan budget.
- Large encrypted response, response correlation/authentication, queue bounds, manifest size limits, path safety, and scan cancellation tests remain passing.
- Dialog exits loading on failure, preserves inputs, gives useful recovery text, and retries successfully. No mapping is approved from a failed or incomplete scan.

Run targeted desktop tests during implementation, then `bun run verify` and `git diff --check`. Exercise the real Electron preload path and a temporary-root Linux-to-Windows comparison, including disconnect and retry. Browser/unit tests alone do not establish physical cross-platform behavior.

## Validation performed during planning

`bun test apps/desktop/tests/peer-session-service.test.ts apps/desktop/tests/scan-cancellation.test.ts`: **18 passed, 0 failed**. Existing coverage does not test responder cancellation after an authenticated request begins; its peer-cancellation case uses a missing peer. `git diff --check` passed before adding this plan. No full application suite or physical peer reproduction was run.
