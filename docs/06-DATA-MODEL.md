# Data model

SQLite is local to each device. Schema version `2` is authoritative for mapping configuration only; it is not a durable per-file index.

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

## Not implemented in this schema

The conceptual per-file model remains future work: entries, scan generations, content revisions, operation journal, transfers/chunks, history/archive metadata, conflicts, and file deletion propagation. Those tables must arrive in later versioned migrations rather than being inferred from mapping configuration.
