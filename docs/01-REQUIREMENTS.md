# Requirements

## Functional requirements

### Devices and pairing

- Each installation creates a persistent local device identity.
- Pairing supports one-time code, QR payload, and LAN/Tailscale peer discovery followed by approval.
- Both devices display and confirm the peer name and identity fingerprint.
- A user can rename, inspect, disconnect and revoke a paired device.
- Revocation immediately prevents new authenticated sessions.

### Folder pairs

- A folder pair maps one absolute local root to one absolute remote root.
- Destination selection is explicit on the second computer.
- Subdirectories are included recursively unless excluded.
- A new folder pair defaults to two-way sync.
- Direction can be two-way, A to B, B to A, or paused/disabled.
- Trigger can be immediate, interval or manual.
- Ignore rules support exact relative paths, directories and glob patterns.
- Rules can be tested before save and each ignored result records its matching rule.

### Initial reconciliation

- Scan both roots without modifying either.
- Present counts and estimated transfer sizes.
- Merge unique paths from either side and skip byte-identical files.
- For same-path divergent files, apply conflict policy and preserve the non-winning copy.
- Ignore historical deletion state during the first merge.
- Block or explicitly resolve case collisions, illegal Windows names, unsafe symlinks and insufficient space.
- Require confirmation before applying the plan.

### Continuous synchronisation

- Observe filesystem events and run periodic reconciliation scans.
- Debounce rapidly changing files and retry locked/unstable files.
- Detect renames/moves when confidence is high; otherwise safely fall back to add-plus-archive-delete.
- Stream transfers with bounded memory and resume verified data.
- Apply global/per-folder bandwidth and metered-network policies.

### History and deletion recovery

- Preserve the old destination before replacement.
- Archive a destination before applying remote deletion.
- Store history outside synced roots by default.
- Retention combines age and storage caps; oldest unpinned versions leave first.
- Allow search, restore, pin and explicit permanent deletion.
- Never synchronise archive contents as ordinary files.

### Conflicts

- Use logical revision metadata, not wall-clock time alone.
- Concurrent edits remain untouched until the user selects one exact current copy.
- Preserve the displaced copy in history and record the resolution event.
- Missing-copy conflicts remain paused until deletion has recovery-safe semantics.

### Desktop experience

- Dashboard lists folder cards and current device connectivity.
- Closing keeps the app in the tray by default; full exit is configurable.
- Startup is disabled by default and can be enabled after desktop sign-in.
- Important errors use native notifications; routine success is silent.
- Long lists are virtualised and queried incrementally.

### Updates and diagnostics

- Notify for signed releases with optional automatic installation.
- Do not update during active transfers.
- No telemetry or automatic crash upload.
- Maintain local logs and export a user-reviewed redacted support bundle.

## Non-functional requirements

### Data integrity

- Atomic destination commit where supported.
- Full-file verification after reconstruction.
- Durable database transactions and crash-recoverable operation journal.
- Idempotent protocol commands and safe replay.

### Security

- Mutual authentication and encrypted transport for every session, including over Tailscale.
- Private identity keys never enter the renderer.
- Pairing secrets are single-use and expiring.
- Renderer has no unrestricted filesystem/process access.

### Privacy

- No account, analytics, project-operated file copy or content logging.
- Exported diagnostics redact roots and usernames by default.

### Portability

- First-class Windows 11 and Linux Mint support.
- Do not assume every path is valid UTF-8 or valid on both platforms.

### Maintainability

- Pure semantics isolated from IO/network code.
- Versioned peer and local RPC schemas.
- Forwards migrations tested from every supported public schema.
- Every data-loss-sensitive bug receives a regression test.
