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
- Concurrent files use a deterministic revision/device-ID tie-breaker, never wall clock alone.
- Preserve the loser in history and record a conflict event.
- Per-folder alternatives: keep both, ask, or pause the entry.

## Change observation

Filesystem events are hints. Debounce bursts, probe stable size/mtime, hash with before/after metadata checks, retry changed/locked files and run periodic reconciliation scans.

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
