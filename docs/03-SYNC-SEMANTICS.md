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

Full-integrity scans of an active folder may reuse a digest recorded by an earlier scan instead of reading the file, but only while the file's exact identity still matches: device, inode, size, modification time and change time, at nanosecond precision, and only when the platform reports those values as usable (non-zero ids and positive nanosecond timestamps). Reuse is disabled for a root on FAT/exFAT, which cannot supply that evidence, and for any legacy cache row whose identity fields are zero. Change time is part of the identity because userspace cannot set it the way `touch -r` or `utimes` can set modification time, so a same-size rewrite that preserves mtime still misses the cache on filesystems that track change time. A digest is recorded only when both timestamps are at least two seconds older than the moment hashing began, so a write landing in the same coarse timestamp tick (FAT keeps a two-second mtime) cannot hide behind an unchanged identity. The first sweep of each folder after launch, and at least one sweep per day after that, ignores the cache and re-hashes every file. The cache is derived engine state: losing it only costs re-hashing, a cache fault falls back to reading files rather than trusting anything unverified, and every transfer still verifies full digests end to end.

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

Inaccessible files and directories are reported per path with a short reason (for example `Permission denied`) and a true total; the detail list is bounded. A comparison the user approved records those paths. If a later full-integrity scan finds only already-approved inaccessible paths, the merge proceeds and skips them; if it finds new ones, the merge stops and the user chooses between continuing with an explicit skip and cancelling to fix access. Skipped paths are excluded from the plan, can never propagate as deletions or replacements, and are recorded in the structured initial-merge outcome. Truncated or digest-incomplete scans still fail closed.

## Setup scan budget and reuse

Folder setup walks each tree only as often as a current observation is genuinely required:

* the preview walk produces the comparison the initiator reviews (hashes files up to the preview ceiling);
* the responder's approval walks both sides once more, because approval is the authorization gate and must reflect what is on disk *now*, not what the initiator saw earlier; a comparison that no longer matches is rejected and refreshed;
* the merge walk establishes current membership and full digests before anything is copied (a preview does not hash files above its ceiling);
* the post-merge verification walk proves neither side changed during the copy.

Repeated *reads* of unchanged data are removed instead of repeated walks. Each scan records the exact on-disk identity (device, inode, size, mtime and ctime in nanoseconds) of files whose digest settled, and a later walk over the same root and rules reuses that digest when every identity value still matches. This is the same identity rule as the durable digest cache, applied before a mapping exists; the walk is the evidence, and its per-file lstat is the minimum sound check because directory timestamps detect structural changes but not content edits. Seeds expire after a short window, are bounded in count, and are only recorded by local user workflows. Losing a seed, an identity mismatch, a changed rule set, or a changed root all fall back to reading the file again. The transfer path independently revalidates each source digest against the peer's current descriptor, so a stale reviewed manifest can never cause bytes to be copied unverified. Walk and hash counts per stage are recorded in a bounded in-process ledger so duplicate scanning is visible in development.

### What is hashed at which stage

* **Preview and responder consent** run without full hashing. Every file at or below the 16 MiB preview ceiling is hashed unless its identity matches a seed; files above the ceiling are listed with size and mtime but no digest and are not read.
* **Initial merge** runs with full hashing. Every file is hashed except those whose identity matches a seed or the durable digest cache. This is where files above the preview ceiling are hashed for the first time, and where changed or new files are read.
* **Verification** reuses the durable digests recorded by the merge scan and by each transferred file's verified write. It rehashes only files whose identity changed, files copied during the merge that could not be recorded, and files on filesystems without reusable identity.
* **Above the preview ceiling** a file's entry has no digest until the merge. Comparison before the merge falls back to size plus a two-second mtime tolerance for that entry; it is never treated as identical on digest evidence it does not have.

### Digest reuse invariant

A cached digest for a path may be reused only when all of the following hold:

1. The platform reports a usable identity for both the cached entry and the current file: a non-zero volume id, a non-zero file id (inode or NTFS file index), and positive nanosecond modification (`mtime`) and change (`ctime`) timestamps.
2. The size is unchanged and every identity value still matches exactly.
3. For the durable cache, the digest was recorded when the file's timestamps sat at least two seconds behind the moment hashing began, so a write sharing a coarse timestamp tick cannot hide behind an unchanged identity.

If a device id, file id or timestamp is missing, zero or negative, or if any identity value differs — including a legacy cache row recorded before this rule existed — the file is read and hashed again. A zero-length file is valid and may reuse its digest. Full-integrity sweeps ignore the cache entirely on the first sweep after launch and at least once every 24 hours. A miss is acceptable; a false hit is not.

### Platform behaviour behind those fields

* **Linux (ext4, XFS, Btrfs, tmpfs)**: `stat` provides a device number, a stable inode number, and nanosecond modification and inode-change times. Change time advances on writes, renames, link changes and timestamp changes, so same-size rewrites and restored mtimes are detected.
* **macOS (APFS)**: device and inode are meaningful, APFS timestamps are nanosecond, and POSIX change-time semantics apply. HFS+ has second-granular timestamps, which weakens same-second detection; the settle rule and the periodic deep sweep bound that.
* **Windows (NTFS)**: the device id is the volume serial number and the inode is the file index from `GetFileInformationByHandle`; modification and change times come from NTFS `FILE_BASIC_INFO` with 100 ns resolution, and change time advances on content and metadata writes. Reuse is enabled only while both ids are non-zero.
* **Windows (FAT/exFAT)**: file indexes are absent or synthesized and change time is not tracked, so the per-file gate rejects the zeroed identities Windows reports and files are rehashed on every sweep. On Linux the filesystem magic rejects the root outright, because a driver can synthesize plausible inode and change-time values that do not advance on a write.
* **FUSE and network mounts (SMB/NFS)**: ids and times are server-provided and may change across reconnects or remounts. Missing or zero fields disable reuse; changed ids produce a miss, which is safe; reuse resumes only when a full stable match appears.

Rename, delete-and-recreate and atomic replacement are all detected by the changed file id and change time, because reuse is keyed by path and the replacement is a different file on every filesystem that supplies identity values. A file whose entire identity — including nanosecond change time — matches an earlier digest is, by definition, indistinguishable from that digest's file using metadata alone; the settle rule, the 30-minute seed window and the 24-hour deep sweep bound how long any such mistake can survive. Transfers never rely on the cache for byte safety: every copied file is hashed at the source and re-verified at the destination.

## Folder removal

Ask which live copies remain. Destructive choices show estimated count/size and need a second confirmation. Archive deletion is separate.
