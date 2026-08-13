# Data model

SQLite is local to each device. Schema version `4` is authoritative for mapping configuration, verified file baselines, retry/conflict state, and replacement recovery metadata. User-file bytes are never stored in SQLite.

## Implemented mapping tables

### `folder_mappings`

The active configuration row introduced in schema version 1: stable mapping ID, both participant IDs and names, both approved path strings, mode, ignore patterns, history limits, setup status, preview, and created/updated timestamps. Paths are opaque strings and are never opened by the mapping store.

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

The same-directory `.tethera-displaced-*` inode is reserved and excluded from scans. It is retained as a secondary safety copy for late POSIX writes through an already-open file handle; it is not the authoritative archive object and is not eligible for implicit cleanup. A future retention migration may attach explicit cleanup evidence to completed journal rows.

States are `planned`, `archived`, `installed`, `completed`, `aborted`, `recovery-required`, and `integrity-failed`. Sync completion and the `completed` transition share one immediate transaction. Archive staging names are derived from the journal ID; startup can publish a complete verified stage, while partial or corrupt evidence is retained. Startup uses verified live/archive digests and the canonical root identity to roll forward or abort; mismatches remain inspectable failures.

## Not implemented in this schema

Logical content revisions, scan generations, transfer/chunk resume state, archive retention/pruning, and file deletion propagation remain future work. They must arrive in later versioned migrations rather than being inferred from mapping configuration.
