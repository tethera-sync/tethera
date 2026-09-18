# Data model

SQLite is local to each device. Schema version `11` is authoritative for mapping configuration, verified file baselines, retry/conflict state, replacement recovery metadata, staged scan generations, and older case-duplicate folder cleanup evidence. User-file bytes are never stored in SQLite.

## Implemented mapping tables

### `folder_mappings`

The active configuration row introduced in schema version 1: stable mapping ID, both participant IDs and names, both approved path strings, mode, ignore patterns, history limits, setup status, preview, and created/updated timestamps. Paths are opaque strings and are never opened by the mapping store.

The preview JSON optionally retains `unreadableLocal`, `unreadableRemote`, `unreadableLocalCount` and `unreadableRemoteCount`. Each side has at most 100 display-only issues with a UTF-8 path of at most 4,096 bytes, a nonempty reason of at most 200 UTF-16 code units, and a `file` or `directory` kind. An empty path denotes the scanned root. Totals are nonnegative JavaScript-safe integers, at least as large as the retained list. Old previews omit these fields and round-trip without adding them. This uses the existing JSON column; no schema migration is required. Older builds that reject these fields cannot consume newly saved previews.

The preview JSON may also retain `directoryMappings`: at most 100 approved case-only directory aliases. Each entry names the logical sync `path`, the selected `localPath` and `remotePath` (in initiator/responder orientation), and at most 100 older same-spelling-insensitive sibling paths per side. Every path is relative, case-equivalent to the logical path, free of `\`, `:`, NUL, empty/`.`/`..` components and `.tethera-` components, and nested entries must sit beneath their parent's selected spellings. The engine validates this shape but never opens the paths. Old previews omit the field.

An active row is visible only when it has valid version-2 revision metadata and no terminal tombstone for the same ID.

### `mapping_revisions`

One current active event per mapping:

- positive monotonic `revision`;
- deterministic `event_id`;
- participant `author_device_id`;
- per-mapping pause state;
- event creation timestamp.

Revision and event ID, not wall-clock time, order active events. Equal revisions are deterministically ordered by event ID. Local updates require the exact expected revision.

### `mapping_tombstones`

Durable, terminal removal evidence:

- mapping ID;
- deletion event ID and deletion revision;
- deletion timestamp;
- deleting participant device ID;
- last known active revision;
- tombstone creation timestamp;
- both mapping participant IDs.

A tombstoned mapping ID can never become active again. Re-adding the same two paths creates a new mapping ID. Tombstones are not automatically pruned.

### `mapping_delivery_outbox`

Immutable active or tombstone events awaiting a paired device. Identity is the exact `(event_id, target_device_id)` plus mapping ID and revision. An entry remains pending across restarts and disconnects until that authenticated target acknowledges the exact event ID and revision. Duplicate acknowledgements are idempotent; mismatched or stale acknowledgements do not clear anything.

### `mapping_legacy_import`

A singleton durable state machine for the one-time `state.json` import:

- `pending`, `failed`, or `completed`;
- SHA-256 source fingerprint;
- imported record count;
- completion timestamp;
- bounded last failure detail.

The active records, any tombstones needed to defeat stale PR #4 rows, outbox entries, and the `completed` marker commit in one transaction.

## Schema migrations

- Version 1 is preserved exactly as introduced in PR #4.
- Version 2 additively creates the revision, tombstone, outbox, and legacy-import tables and backfills version-1 active rows.
- Version 3 adds verified file baselines, retryable operations, and durable conflicts.
- Version 4 additively creates content-addressed archive-object metadata and the replacement/restore journal.
- Version 5 adds the per-folder maximum file-size column.
- Version 6 additively creates staged scan generations (`scan_generations`) and their ordered entries (`scan_entries`) with mapping/revision/participant binding, open/sealed/aborted lifecycle, idempotent batch ingestion, and keyset paging indexes.
- Version 7 additively creates the per-mapping scan digest cache (`scan_digest_cache`), a derived performance cache keyed by mapping and relative path.
- Version 8 additively creates `directory_cleanup`, the durable evidence for moving an approved older case-duplicate folder to the OS trash.
- Version 9 additively creates `archive_object_deletions`, the durable queue of archive objects whose files version history retention still has to remove, and a partial index on `file_replacement_journal.archive_digest`.
- Version 10 rebuilds `scan_entries` as a `WITHOUT ROWID` table clustered on `(generation_id, relative_path)`, copying any staged rows and dropping the duplicate ordering index, so each staged path is stored once.
- Version 11 adds `scan_entries.kind` (`file`, `directory`, or `special`, defaulting to `file`), so a staged observation records occupied destination paths as well as files; existing staged rows become `file`.
- Every schema step and `PRAGMA user_version` bump shares one immediate transaction.
- Malformed version-1 data rolls the whole step back and leaves version 1 intact.
- A database newer than this build supports is refused without writes.
- Startup also probes the immediate writer transaction used by mapping mutations; a locked/read-only authority is unavailable, never an empty mapping list.

## Legacy snapshot retirement

Electron validates all intended legacy records, rejects duplicates or malformed records, writes and verifies a mapping-only backup, then sends the complete import through authenticated RPC. It cleans only retired mapping ownership after reading the committed records back from SQLite. Unrelated settings and temporary proposal/rejection workflow state survive.

If Electron crashes after the database commit but before cleanup, the durable fingerprint makes cleanup retryable without importing again. A changed stale snapshot never overwrites a completed database.

## Peer reconciliation invariants

- Only an already authenticated trusted peer can submit a configuration event.
- The authenticated peer and local device must be the mapping’s two participants; the event author must be that peer.
- Tombstones are terminal even when an active event arrives later or carries a newer wall-clock timestamp.
- Duplicate and out-of-order delivery is deterministic and idempotent.
- Configuration reconciliation never scans a mapped path and never reads, creates, renames, moves, modifies, or deletes a user file.

## Replacement archive and restore journal

`archive_objects` records each SHA-256 object key, size, durable availability state (`available`, `missing`, or `corrupt`), verification time, and bounded integrity error. Bytes live under the desktop data directory at `version-archive/objects/sha256/<prefix>/<digest>`, outside mapped folders. Matching content shares one object; object paths never contain mapping names or relative user paths. Version queries project object availability, and a failed restore verification persists `missing` or `corrupt` before returning an error.

`file_replacement_journal` retains the mapping ID, canonical local-root identity, relative path, durable sync-operation ID when applicable, old and replacement digests/sizes, archive object identity, timestamps, restore lineage, bounded failure detail, and explicit lifecycle state. Recovery refuses to apply an entry if the mapping now resolves to another local root. The journal intentionally has no cascading mapping foreign key, so removing/recreating a mapping cannot erase its recovery history. A partial unique index permits only one active replacement per mapping/path.

The same-directory `.tethera-displaced-*` inode is reserved and excluded from scans. It is retained as a secondary safety copy for late POSIX writes through an already-open file handle; it is not the authoritative archive object. Retention removes it only when its journal entry is pruned, it lies under the folder's current canonical root, and it still hashes to the journaled previous digest. An edited copy is kept.

States are `planned`, `archived`, `installed`, `completed`, `aborted`, `recovery-required`, and `integrity-failed`. Sync completion and the `completed` transition share one immediate transaction. Archive staging names are derived from the journal ID; startup can publish a complete verified stage, while partial or corrupt evidence is retained. Startup uses verified live/archive digests and the canonical root identity to roll forward or abort; mismatches remain inspectable failures.

Retention reads each active mapping's `history_days` and `history_max_bytes`; zero disables that limit. Walking completed and aborted archived entries newest first, an entry becomes removable once it is older than the day limit, or once the distinct archived bytes of the newer entries kept so far exceed the cap; every older entry after that is removable too. Unfinished entries and the source of an unfinished restore are never removable. Pruning deletes journal rows and, in the same transaction, moves each `archive_objects` row that no journal entry archives and no unfinished entry uses as its old or replacement digest into `archive_object_deletions`. `prepareReplacement`, `prepareRestore` and `markArchived` refuse queued content until the desktop confirms the object file is gone, so a queue row is only ever cleared after its file was removed. Entries of removed mappings are not pruned.

Explicit conflict selection does not add another persistence model or schema version. While the exact `file_sync_conflicts` row remains present, each participant records the user's choice as a normal `file_sync_operations` row in its local orientation, containing the selected direction and exact source/destination metadata. Repeating the same exact choice is idempotent; a stale version or a different queued operation for that path is rejected. Each participant's verified-completion transaction independently advances its baseline, removes its operation, and clears its local conflict after exact completion is recorded; authenticated peer acknowledgement drives the other participant's transaction.

## Staged scan generations (version 6)

`scan_generations` binds one staged observation to its mapping, authenticated
participant, mapping revision, canonical owning root, ignore rules, and hash
mode (`full-sha256` or `preview`), with `open`, `sealed`, or `aborted` state,
a staged entry count, next batch sequence, and expiry. `scan_entries` stores
one row per relative path per generation in a `WITHOUT ROWID` table clustered
on `(generation_id, relative_path)` (version 10), which serves keyset paging
and merge joins without a separate index. Since version 11 each row carries a
`kind`: `file` rows store the size and digest, while `directory` and `special`
rows record an occupied path (a folder without synchronized files, or a
symbolic link or other special entry) with no size or digest.

Batches are transactional and idempotent: an identical re-delivery is accepted
without double-counting, while gaps, changed duplicates, stale revisions, and
cross-mapping reads fail. Each batch advances the stored entry count by the
rows it inserted, so staging costs follow the batch size, not the generation
size. Sealing verifies the staged count once; only a sealed generation is
visible to planning reads and `fileSync.reconcileGenerations`. Reconciliation
applies the mapping's current ignore rules, advances baselines for paths both
generations observed identically in one statement, and streams only differing
or baseline-only paths, in path order, to the planner. A one-sided addition
whose destination path or ancestor is occupied, or lies beneath a synchronized
file, is reported as an occupied skip instead of queued work. The completed
plan is published atomically. Aborted and expired generations are cleaned
without touching baselines, operations, conflicts, or recovery evidence, and
an owner may release a generation in any state once its exchange has
finished. Every staged generation is purged once at engine start, when
nothing can be in flight, so an unfinished row left by a crash cannot hold
the open-generation quota. At most four open generations per mapping and one
million entries per generation are staged, and one batch holds at most 1,000
entries.

## Scan digest cache (version 7)

`scan_digest_cache` stores one row per mapping and relative path: the file's device and inode, size, modification and status-change timestamps in nanoseconds, its digest, and the sweep token it was last recorded under. Device, inode, and the two timestamps are stored as exact decimal-string renderings rather than integers, because they can exceed i64/f64 precision on some platforms; the engine stores and returns them byte-for-byte and never parses them.

This table is a derived performance cache, not authoritative sync state. Losing it costs nothing but re-hashing on the next scan — it holds no information a full rescan cannot reproduce. Rows cascade away when their owning mapping is removed (`ON DELETE CASCADE`). The desktop scanner decides when a cached digest may still be trusted against the current filesystem state; the engine only records and returns exact values. Pruning is by sweep token rather than wall-clock time: the desktop calls `digestCache.prune` only after a complete sweep that re-recorded every eligible file, so a clock jump cannot cause a live entry to be dropped or a stale one to be kept.

## Directory cleanup evidence (version 8)

`directory_cleanup` stores one row per mapping, participant device, and approved older relative directory path: the directory's exact device, inode, and nanosecond modification/status-change timestamps (decimal strings, as JSON) recorded before the trash operation, and a `completed` flag. `directoryMapping.cleanup` accepts a path only when it is listed as an older path for that participant's side of an approved, unpaused, delivered `ready-for-initial-sync` mapping. The identity is recorded once (`INSERT OR IGNORE`), and completion requires the same identity, so a directory recreated after cleanup is never treated as the recorded one. Rows intentionally have no cascading mapping foreign key: cleanup evidence survives mapping removal. The desktop moves directories only through the OS trash; there is no permanent-delete fallback.

## Not implemented in this schema

Logical content revisions, transfer/chunk resume state, and file deletion propagation remain future work. They must arrive in later versioned migrations rather than being inferred from mapping configuration. General archive browsing is also not represented by the conflict-resolution projection.
