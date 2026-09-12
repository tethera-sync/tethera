# Implementation Status

This document separates implemented behaviour from planned behaviour so the product does not imply that unfinished sync features are protecting data.

## Implemented desktop and peer foundation

- Electron/React desktop shell with a narrow context-isolated preload bridge, tray lifecycle, preferences, local activity and mapping-management UI.
- Persistent Ed25519 device identity, signed LAN presence, two-sided pairing and pinned trusted peers.
- Short-lived authenticated encrypted peer requests using ephemeral X25519, HKDF, AES-256-GCM and the paired Ed25519 identity.
- Custom local and trusted-peer folder selection, mapping proposal/approval and a bounded development initial comparison.
- Capability-negotiated remote preview progress: active scans can continue beyond five minutes while reporting bounded authenticated counters, with a five-minute idle timeout and thirty-minute maximum scan duration. Preview dialogs support cancellation, disconnected requests abort cooperative scan work, and older peers retain the single-response fallback. Progress alone does not lift the single-frame limit; chunked exchanges do, between updated peers.
- An explicitly initiated, direction-aware additive initial merge coordinated across both computers. Missing files transfer in 512 KiB encrypted requests with a full SHA-256 check and an atomic no-replace destination commit. Same-path differences are left untouched and surfaced.
- Automatic post-merge reconciliation. Both participants debounce native directory watches, the non-coordinator reports changes over the authenticated peer session, a five-minute full scan covers missed/coalesced notifications, and one deterministic mapping participant coordinates each cycle.
- Concurrent full-integrity scanning and a durable per-folder digest cache. Scans inspect up to 16 files at once while committing results in walk order, so manifests, counters and truncation are identical to a sequential scan. Continuous-sync scans on both computers skip reading files whose exact identity (device, inode, size, mtime and ctime in nanoseconds) matches an earlier settled digest; the first sweep after launch and one sweep per day re-hash everything. Reuse requires a usable identity on both sides (non-zero device and file id, positive nanosecond timestamps). On Linux it is disabled per root for FAT/exFAT by filesystem magic; on Windows the root gate is skipped because `statfs().type` is not meaningful there and the per-file gate rejects the zeroed file ids those filesystems report. A miss is never treated as a hit, and the same gate applies to the setup seed store and to transfer-recorded identities.
- Chunked peer exchanges. Between computers that both advertise `chunked-frames-v1`, manifests and observations larger than one 16 MiB frame travel as authenticated chunks (up to 256 MiB of JSON per exchange), so folder previews, initial merges, merge verification and continuous sync are no longer capped by a single frame. Older peers keep the legacy single-frame limits. Frame decryption requires full 16-byte GCM tags and 12-byte IVs.
- Idle continuous cycles stop after scanning. Between computers that both advertise `continuous-fingerprint-v1`, a cycle whose order-independent observation fingerprints (computed with a streaming scan that holds no file list) match the last reconcile that queued nothing ends without exchanging manifests, reconciling or writing sync state. The first cycle after launch and one per hour always reconcile in full.
- Rust/SQLite verified-file baselines, durable retry operations, and explicit non-destructive conflicts. Only a one-sided change from a common digest may replace an existing file.
- A Recovery screen that projects durable conflicts and replacement-journal failures without exposing archive roots or internal object keys. For a conflict with two present copies, it freshly hashes both computers and lets the user select an exact version permitted by the mapping direction.

## Authoritative Rust/SQLite mapping index

SQLite is the sole authoritative store for approved folder-mapping configuration. The desktop starts its stable device identity, opens the authenticated Rust RPC session, completes or verifies the legacy import, and then obtains active mappings through `mapping.list`. It never silently falls back to `state.json`.

Schema version 6 keeps the original migrations and adds:

- `mapping_revisions` for the current active event metadata;
- `mapping_tombstones` for durable deletion evidence;
- `mapping_delivery_outbox` for exact peer delivery and acknowledgement; and
- `mapping_legacy_import` for durable one-time import status.
- `file_sync_mapping_state` for the first verified observation boundary;
- `file_sync_baselines` for common SHA-256 file versions;
- `file_sync_operations` for retryable pull/push work; and
- `file_sync_conflicts` for simultaneous changes, one-sided deletion, direction mismatch, or unbased state.
- `archive_objects` for verified content-addressed archive metadata; and
- `file_replacement_journal` for restart-safe replacement and restore lifecycle state.
- `scan_generations` and `scan_entries` (version 6) for bounded staged scan generations with participant/revision/root/rules/hash-mode binding, idempotent batches, seal verification, ordered paging, quota/expiry, and startup cleanup; and
- `fileSync.reconcileGenerations`, `fileSync.operationsPage`, `fileSync.conflictsPage`, and `scanGeneration.begin/append/seal/abort/readPage/cleanup` RPC.

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
- `fileSync.reconcile`, `fileSync.getState`, `fileSync.resolveConflict`, `fileSync.authorizeApply`, `fileSync.complete`, `fileSync.applyVerified` and `fileSync.fail`; and
- the read-only `archive.listVersions`, which is mapping-scoped and takes an optional positive `limit`.

The RPC exposes no SQL, no arbitrary file operation and no identity private key.

## Initial merge and continuous synchronization

Desktop comparison previews report time-throttled local listing, metadata and hashing activity, the current relative path, checked files, excluded/unreadable entries, bytes hashed and reused unchanged files. Unreadable files and directories are additionally reported per relative path with a short reason and a true total (bounded detail list), carried through the proposal to the approval dialog. Remote preview scans report authenticated counters when both peers support `scan-progress-v1`, otherwise a waiting phase. Remote progress never includes paths or contents. Preview samples retain the 14 largest differences across the scanned manifests, ordered by size with path/category tie-breaks. Initial-merge local scans also expose activity before transfer starts. A reviewed comparison's local and peer scans are cached for a short, input-keyed session so requesting approval reuses them instead of walking both folders again; that cache-backed step is labelled as reuse rather than reported as a scan. Settled file identities from setup scans are also kept in a bounded, short-lived seed store (root and rules keyed, local-user workflows only) so the consent and merge walks reuse digests for unchanged files and read only changed, new or above-ceiling files. A bounded in-process scan ledger records every admitted walk with its stage and reuse/hash counters. Explicit `**/node_modules/**` rules prune root and nested dependency directories before traversal and before the scan-file ceiling is consumed. Read-only scans are cooperatively cancellable (preview cancellation/supersession, peer disconnect/deadline, pause/removal, shutdown, paired-scan sibling abort) with per-scan hash-buffer reuse and a process-wide budget of 4 active and 16 queued scans; peer frames stay capped at 16 MiB with a 32-message/4 MiB parked queue.

The preliminary Rust scanner, comparison and no-write plan are not wired into the live desktop transfer path. They still have documented development ceilings, use BLAKE3 rather than the desktop transfer path's SHA-256, and have no durable per-file index. Their opaque digest values must not be mixed with the desktop manifest contract.

The Electron main process owns the initial merge. One user action runs a full-integrity local pull, asks the authenticated peer to run the inverse pull, and performs a fresh two-sided convergence scan before activation. A deterministic device-id coordinator prevents simultaneous starts from deadlocking. Completion is reported only after the peer acknowledges the exact active mapping event. Each source file is hashed before transfer, read in bounded chunks only while its size and modification time remain stable, re-hashed at the destination, staged beside its destination, fsynced, and atomically linked into place without replacing a path that appeared after planning. Full-integrity scans are restricted to the approved mapping and its exact ignore rules. Initial-merge and verification scans use the mapping's durable digest cache (and the first merge walk also reuses the setup seed), and transferred files have their verified identity recorded, so these walks read only files that actually changed, are new, or exceed the preview hashing ceiling. The walk itself remains: per-file identity is the minimum sound freshness evidence, because directory timestamps cannot reveal a content edit. Truncated or digest-incomplete scans fail closed. Unreadable paths are listed for review: paths already acknowledged in the approved comparison are skipped without re-asking, new ones pause the merge until the user continues or cancels, and the held scan is reused for the merge. Skipped paths are excluded from the plan, are never treated as deletions, and are recorded in the structured outcome that survives restart. Differing files remain unchanged on both computers.

After activation, the lower participant device ID is the deterministic coordinator. Both participants watch their local tree; a non-coordinator change sends a bounded authenticated notification that queues the coordinator, while a five-minute full two-sided scan covers missed events. Full SHA-256 observations go to the Rust engine, which compares them with the last verified common baseline. A new path or one-sided modification permitted by the mapping mode becomes durable work. Both devices record the new baseline only after the destination verifies and atomically commits the exact source digest. A disconnect or restart leaves retry state in SQLite; a commit whose acknowledgement was lost converges on the next identical scan.

Existing destinations are replaced only if their digest still matches the planner's expected destination digest. The new file is staged and verified beside the destination. The exact destination entry is then moved to a reserved same-directory displaced path, copied into `userData/version-archive/objects/sha256/<prefix>/<digest>`, fsynced, re-hashed, and recorded as `archived` in SQLite before the new file is installed with an atomic no-replace link. A path created concurrently in the installation or rollback window is never overwritten. Sync completion and the journal's `completed` transition commit together. Deterministic archive staging can be verified and published after restart, and every journal entry is bound to the canonical local root that created it. The reserved displaced inode is retained and ignored by scans because POSIX permits late writes through an already-open handle; a future retention policy may remove it only under an explicit safety rule. The external content-addressed object remains the authoritative archived version. New destinations use the same atomic no-replace link.

Startup processes incomplete replacement rows before watchers resume. An unchanged old live digest aborts work safely; the exact planned replacement plus a verified archive rolls forward; missing/corrupt archive content becomes `integrity-failed`; every ambiguous observation becomes `recovery-required`. Restore uses the same pipeline and archives a current live file before replacing it. A minimal Electron API exposes the engine-backed restore primitive, and replacement failures are visible in Recovery. Archived versions for one active folder can now be browsed and restored from the Recovery screen. The engine read is bounded to the most recent versions and reports when older history exists beyond that page. Main projects each journal row into a renderer-safe summary that deliberately omits archive roots, object keys and digests, so the renderer can identify a version by path, time, size and availability without learning where the archive lives. Retention is still not implemented: nothing prunes, expires or deletes an archive object or a journal row.

The first observation of a legacy/imported active mapping never assumes a one-sided file is new. Simultaneous modifications, one- or two-sided deletions, direction-blocked changes, and paths without a verified baseline become durable conflicts; files are not deleted and the folder/activity UI identifies affected paths. Legacy initial-merge conflict outcomes are promoted into the authoritative SQLite projection before their stale JSON copy is retired.

For a durable conflict where both files are present, the coordinator can inspect both copies through the authenticated peer session and queue one exact version as normal durable sync work. The renderer submits the device-bound digests and sizes it displayed; the coordinator freshly revalidates both copies before accepting that choice and replay validates them again. Each transfer acknowledgement names the exact mirrored durable operation. The receiving side authorizes every incoming file application against that exact pull operation; a missing operation is accepted only as a no-write retry when the verified baseline and live file already match. Restart preserves selected intent, but a changed or missing source/destination blocks it and forces reconciliation. Installation reuses the existing verified transfer and archive-backed replacement journal; each local conflict remains until exact completion is committed. An unresolved replacement recovery issue blocks reconciliation before scanning and its referenced operation cannot be deleted or rewritten by a later plan. One-way direction is enforced, and missing/deletion conflicts cannot be selected.

## Clearly not implemented

- Automatic large-folder sync through staged generations in the live initial/continuous flows (the contracts, paging, and peer serving above are implemented, but live merge/reconciliation still exchanges full manifests, chunked between updated peers, so memory still grows with folder size in cycles that find changes). Measured at 250,000 files per side on a release engine, staging one generation takes 14-27 s and `fileSync.reconcileGenerations` 29-40 s even when nothing changed, because each batch recounts the whole generation and planning looks every path up individually; live wiring waits on those becoming incremental..
- Engine-owned filesystem watching/network transfer, resumable/content-defined chunking, or bandwidth scheduling.
- File deletion or rename propagation, archive retention/pruning, or resolving conflicts where either copy is missing.
- NAT traversal, cloud services, accounts or telemetry.
- Removal of the scan-file ceiling itself. It is now a global preference (1,000–1,000,000 files, or explicitly unlimited; 10,000 by default) with no separate fixed per-side file-count cap gating legacy sync beneath it; every legacy scan still accumulates its full manifest in memory (now inspecting files concurrently and reusing cached digests) with cooperative cancellation, bounded admission (4 active, 16 queued), per-scan hash-buffer reuse, and a sync-side ceiling of the legacy single-frame encoded-byte budget with an older peer, or the 256 MiB chunked-exchange limit between updated peers.
- Code-signed/notarised release builds.

## Recommended next pull request

Wire the live initial merge and continuous reconciliation through sealed generations end to end (streamed staging, peer generation exchange, generation reconciliation, paged operation/conflict consumers, and UI summaries), then add the archive retention policy over the browser that now exists: an explicit age/count/size budget, a pruning pass that can never delete an object still referenced by an unfinished, recovery-required or integrity-failed journal entry, and tests for interrupted pruning. Deletion and rename propagation should remain disabled until archive recovery and cross-platform interruption tests prove the lifecycle safe.

## LAN ports

- UDP `47654`: discovery and presence
- TCP `47655`: pairing
- TCP `47656`: authenticated encrypted peer RPC
