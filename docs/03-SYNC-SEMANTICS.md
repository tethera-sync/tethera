# Sync semantics and safety invariants

This document is normative.

## Core entities

- **Device:** installation with stable cryptographic identity.
- **Folder pair:** stable mapping of two local roots.
- **Entry:** relative path and observed content/metadata state.
- **Revision:** content state produced by a device from parent revisions.
- **Tombstone:** logical deletion revision.
- **History version:** local recoverable content displaced by an operation.

## Non-negotiable invariants

1. Partial received data never appears at the final path.
2. Previous destination content is archived before destructive replacement.
3. Remote deletion becomes a local archive operation first.
4. An operation is replayable or durably complete.
5. The engine never mutates outside configured live/archive roots.
6. Symlinks are never followed during recursion.
7. Stale plans are revalidated before commit.
8. The UI displays engine state and never invents it.
9. Wall clocks are not the sole revision authority.
10. Every skipped/failed path has an inspectable reason.

## Paths

Protocol paths are byte-safe relative components plus a display string. Before access: reject absolute/dot/dot-dot components, validate platform names, join under root, canonicalise nearest existing ancestor, verify containment and refuse unsafe symlink/reparse traversal.

## Revision model

A revision records folder, relative path, creating device, monotonically increasing device sequence, parent revision IDs, content digest, size/metadata and display timestamp.

A revision wins sequentially when it descends from another. Revisions are concurrent when neither descends from the other. Use device-keyed maps/lists so future multi-device support is possible.

## Conflict default

- Descendant beats ancestor.
- Concurrent files remain untouched until a user explicitly chooses one of the exact current copies; wall clock is never a winner selector.
- Preserve the displaced copy in history and keep the durable conflict until the selected replacement is verified and indexed on both participants.
- A choice is valid only while both current digests and sizes still match the recorded conflict. A changed or missing copy forces a fresh scan instead of applying stale intent.
- One-way folder direction still applies to manual resolution. Deletion conflicts remain read-only until deletion propagation has complete recovery semantics.

The coordinator records a valid choice as ordinary durable `push-local` or `pull-remote` work. Before transfer, the authenticated peer records the exact mirrored operation in its own local orientation so the receiving journal can bind replacement to durable work. Restart recovery replays it only when both observed source and destination still match that exact operation. Replacement then uses the normal staging, digest verification, archive, journal and atomic no-replace commit path; conflict-specific code does not bypass those guarantees.

## Change observation

Filesystem events are hints. Debounce bursts, probe stable size/mtime, hash with before/after metadata checks, retry changed/locked files and run periodic reconciliation scans.

Full-integrity scans of an active folder may reuse a digest recorded by an earlier scan instead of reading the file, but only while the file's exact identity still matches: device, inode, size, modification time and change time, at nanosecond precision. Change time is part of the identity because userspace cannot set it the way `touch -r` or `utimes` can set modification time, so a same-size rewrite that preserves mtime still misses the cache. A digest is recorded only when both timestamps are at least two seconds older than the moment hashing began, so a write landing in the same coarse timestamp tick (FAT keeps a two-second mtime) cannot hide behind an unchanged identity. The first sweep of each folder after launch, and at least one sweep per day after that, ignores the cache and re-hashes every file. The cache is derived engine state: losing it only costs re-hashing, a cache fault falls back to reading files rather than trusting anything unverified, and every transfer still verifies full digests end to end.

A continuous cycle may stop after scanning when nothing changed. Each computer first computes an order-independent fingerprint of its full-integrity observation (every file's path, size and digest) without holding the file list in memory. If both fingerprints match the ones seen by the last reconcile that queued nothing, the mapping revision is the same, and neither computer has pending operations, recovery issues, changed conflicts or a changed baseline count, reconciling again would decide exactly the same, so the cycle ends without exchanging manifests or writing state. The first cycle after launch, and at least one cycle per hour, always reconciles in full.

## Transfer strategy

- Small files: whole-file.
- Large files: content-defined chunks when worthwhile.
- Benchmark a 16–32 MB starting threshold.
- Verify a full-file digest after reconstruction.

## Incoming commit phases

1. `PLANNED`
2. `RECEIVING` to same-filesystem temp path
3. `VERIFIED`
4. `ARCHIVED_OLD`
5. `COMMITTED` atomically
6. `INDEXED`
7. `ACKED`

Recovery examines journal plus filesystem and safely rolls forward/resumes.

## Deletion

Create a tombstone. Before accepting remotely, verify expected ancestor, archive the live destination, commit tombstone/archive metadata and only then acknowledge. Never recursively delete an unexpected non-empty directory. First merge ignores old tombstones.

## History

- Preserve local old content before replacement.
- Keep archives local, outside sync roots by default.
- Default retention: 30 days or 10 GB per folder.
- Remove oldest unpinned versions when either limit is exceeded.
- Restore creates a new live revision and archives any replaced live content.

## Rename detection

Evidence order: stable file ID, watcher rename pair, matching digest/size/time proximity, chunk signature. High confidence sends rename; low confidence uses add plus archived delete.

## Direction

- Two-way: both devices produce revisions.
- One-way: source authoritative, but destination local edits are surfaced and protected before overwrite.
- Paused: optionally continue indexing but do not exchange/apply.

## Ignore rules

Use ordered slash-separated relative patterns, expose the matching rule, support a tester, show/remove presets and never ignore all dotfiles implicitly. Rule changes produce a previewed scoped reconciliation, not silent deletion.

## Initial merge

Scan without mutation, classify identical/unique/divergent/incompatible entries, estimate bytes and archive impact, preview, revalidate, preserve divergent loser and never interpret absence as historical deletion.

## Folder removal

Ask which live copies remain. Destructive choices show estimated count/size and need a second confirmation. Archive deletion is separate.
