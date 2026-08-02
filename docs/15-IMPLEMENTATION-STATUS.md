# Implementation Status

This document separates implemented behaviour from planned behaviour so the product does not imply that unfinished sync features are protecting data.

## Implemented desktop and peer foundation

- Electron/React desktop shell with a narrow context-isolated preload bridge, tray lifecycle, preferences, local activity and mapping-management UI.
- Persistent Ed25519 device identity, signed LAN presence, two-sided pairing and pinned trusted peers.
- Short-lived authenticated encrypted peer requests using ephemeral X25519, HKDF, AES-256-GCM and the paired Ed25519 identity.
- Custom local and trusted-peer folder selection, mapping proposal/approval and a limited development initial comparison.
- An existing, explicitly initiated initial pull for remote-only files up to its documented development limit. It predates the authoritative-mapping work; this pull request neither expands its scanner nor adds a new file operation.

## Authoritative Rust/SQLite mapping index

SQLite is the sole authoritative store for approved folder-mapping configuration. The desktop starts its stable device identity, opens the authenticated Rust RPC session, completes or verifies the legacy import, and then obtains active mappings through `mapping.list`. It never silently falls back to `state.json`.

Schema version 2 keeps the original version-1 migration unchanged and adds:

- `mapping_revisions` for the current active event metadata;
- `mapping_tombstones` for durable deletion evidence;
- `mapping_delivery_outbox` for exact peer delivery and acknowledgement; and
- `mapping_legacy_import` for durable one-time import status.

Each migration step and each mapping mutation is transactional. A startup write probe distinguishes a genuinely writable store from a WAL database that can be opened for reads while another writer holds it. A newer schema is refused without modification.

`TETHERA_DATA_DIR` is the preferred engine data-directory variable. `FOLDERSYNC_DATA_DIR` remains a deprecated fallback and logs a warning when used. The desktop deliberately continues to pass Electron's existing `app.getPath("userData")`, so an installed `mappings.sqlite3` is not stranded by the naming cleanup.

## Active events, tombstones and pending delivery

Every active mapping has a positive monotonic revision, immutable event ID and author device. A local update requires the exact current revision. Removal transactionally writes a tombstone, removes the active projection and enqueues the tombstone for the other participant.

A tombstone contains the mapping ID, deletion event and revision, deletion and creation timestamps, deleting device, last-known active revision, and both mapping participants. Tombstoned IDs are terminal in this version: an active event with that ID can never revive it, regardless of arrival order. Re-adding the same folders creates a new mapping ID. Tombstones are durable and are not automatically pruned.

Active and tombstone events travel through the existing authenticated peer channel. The engine verifies that the authenticated peer, local device and event author are the mapping participants. Duplicate deliveries are idempotent; out-of-order events are resolved by revision plus event ID rather than wall-clock time. An outbox row is cleared only when the authenticated peer returns the exact mapping ID, event ID and revision. Disconnects leave it pending for retry.

This channel reconciles configuration only. It never scans a mapping or reads, writes, renames, moves or deletes a user file.

## One-time `state.json` migration

Legacy mapping fields are imported only while SQLite reports that legacy import has not completed. The desktop validates the entire intended set, rejects duplicate IDs, writes a mapping-only backup, verifies that backup, and sends one transactional import to the engine. Stable IDs, approved local/remote paths, modes, ignore rules, history limits, pending-delivery state and valid timestamps are preserved.

The completion marker commits in the same database transaction as the intended records and any tombstones needed to retire stale version-1 rows. A matching retry is idempotent. A different legacy snapshot cannot overwrite a completed import.

After the desktop reads the records back and verifies the exact intended configuration, it removes only SQLite-owned mapping fields from `state.json`. Unrelated preferences and temporary pending/rejected proposal UI state remain. A crash after database commit but before JSON cleanup repeats verification and cleanup on restart; it does not import again. The verified backup contains only mapping configuration, never identities, private keys, secrets or user-file contents.

Fresh installs and readable zero-mapping states commit an empty completed import. Missing JSON is treated as a fresh install. Malformed, duplicate or unreadable JSON fails closed and records a migration failure. A locked, unavailable or newer-schema database is not interpreted as zero mappings and is never rebuilt from JSON.

## Renderer and degraded behaviour

The renderer shows initial loading, ready, unavailable, unsupported/newer-schema, migration-required and migration-failed states. Active rows come from `mapping.list`; tombstones are never rendered as active. Pending configuration delivery is visible without presenting it as lost.

When the mapping store is not ready, the last in-memory view is not replaced with an empty list, mapping mutations are disabled, and a concise warning offers a safe engine retry. Settings show schema and migration status; journal mode is confined to advanced details. Diagnostics omit private keys and avoid unnecessary full database or mapping paths.

Creation, approval, pause/setup updates and removal are shown as durable only after their SQLite transaction succeeds. `state.json` no longer has a writable approved-mapping projection or one-way write-through reconciliation helpers.

## Local RPC boundary

Renderer access remains `renderer -> preload -> Electron main -> authenticated Rust stdio RPC`. The mapping methods are typed, reject unknown fields and require the engine session token before dispatch:

- `mapping.list`, `mapping.get` and `mapping.listPendingDelivery`;
- `mapping.upsert` and `mapping.remove`;
- `mapping.applyRemote` and `mapping.acknowledgeDelivery`; and
- `mapping.getMigrationStatus`, `mapping.importLegacy` and `mapping.recordMigrationFailure`.

The RPC exposes no SQL, no arbitrary file operation and no identity private key.

## Preliminary scanner and existing initial pull

The preliminary Rust scanner, comparison and no-write plan remain unchanged and are not wired into the authoritative configuration migration. It still has its documented development ceilings and no durable per-file index.

The Electron main process still owns the older limited initial comparison and explicit initial pull. Differing files are skipped rather than reconciled. This is an existing boundary, not a production sync engine, and was not expanded by this pull request.

## Clearly not implemented

- Durable per-file rows or scan generations.
- Production or expanded scanning, filesystem watchers, continuous reconciliation or file-operation plans.
- Engine-owned file transfer, chunking, resume, atomic journalled commits or bandwidth scheduling.
- File deletion or rename propagation, history/archive, restore or conflict winner selection.
- NAT traversal, cloud services, accounts or telemetry.
- Changes to the preliminary scanner's limits.
- Code-signed/notarised release builds.

## Recommended next pull request

PR #6 should introduce a migration-ready durable per-file manifest design and move read-only manifest generation behind the authenticated engine boundary. Keep that slice read-only until scan generations and the operation journal have explicit crash/restart tests; do not combine it with transfers, watcher scheduling, deletion propagation or conflict resolution.

## LAN ports

- UDP `47654`: discovery and presence
- TCP `47655`: pairing
- TCP `47656`: authenticated encrypted peer RPC
