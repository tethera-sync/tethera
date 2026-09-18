# Electron-to-engine RPC contract

## Call path and transport

```text
React renderer
  -> narrow contextBridge API
  -> Electron main IPC handler
  -> authenticated newline-delimited JSON over child-process stdio
  -> Rust method allowlist
  -> SQLite MappingStore
```

The renderer never receives the engine session token and cannot call mapping RPC directly. Electron creates a fresh random token for each engine process. Rust validates that token before inspecting the method or params.

## Envelope

```ts
interface RpcRequest<T> {
  id: string
  method: string
  sessionToken: string
  params?: T
}

interface RpcResponse<T> {
  id: string
  ok: boolean
  result?: T
  error?: string
  errorCode?: string
}
```

Unknown request-envelope fields and unknown fields in every mapping params/configuration/event type are rejected. IDs, paths, modes, limits, revisions, timestamps, participant relationships, and exact acknowledgement identities are validated again in Rust.

## Implemented mapping methods

| Method | Purpose |
|---|---|
| `mapping.getMigrationStatus` | Read durable legacy-import state without treating pending as empty. |
| `mapping.importLegacy` | Transactionally import the complete validated snapshot and completion fingerprint. |
| `mapping.recordMigrationFailure` | Store a bounded migration diagnostic without marking completion. |
| `mapping.list` | List active records only; tombstones never appear as active. |
| `mapping.get` | Get one active record or `null`; a tombstoned ID is not revived. |
| `mapping.upsert` | Create/update an active mapping using author, expected revision, optional delivery target, and event time. |
| `mapping.remove` | Atomically replace an active mapping with a durable tombstone and optional outbox event. |
| `mapping.listPendingDelivery` | Read immutable active/tombstone events that still need peer acknowledgement. |
| `mapping.applyRemote` | Apply one bounded event from the authenticated peer after participant validation. |
| `mapping.acknowledgeDelivery` | Clear exactly one matching event/revision/target; stale acknowledgements fail. |

Replacement safety adds authenticated `archive.prepareReplacement`, `archive.markArchived`, `archive.markInstalled`, `archive.listIncomplete`, `archive.listVersions`, `archive.get`, `archive.recordIssue`, `archive.recordObjectIssue`, `archive.recover`, `archive.prepareRestore`, and `archive.completeRestore`. These methods validate journal identities and lifecycle transitions; they do not accept arbitrary archive paths or file bytes. `archive.recordObjectIssue` durably marks a previously published object `missing` or `corrupt` after filesystem verification fails. `fileSync.complete` and `fileSync.applyVerified` require the receiving device's installed replacement journal before completing a destructive pull. `fileSync.applyVerified` also requires the exact authorized pull-operation ID; a missing ID can only acknowledge an already-identical verified baseline and cannot authorize a filesystem write.

Version history retention adds `archive.listPrunable`, `archive.prune`, `archive.listObjectDeletions`, and `archive.completeObjectDeletion`. `archive.listPrunable` takes an active mapping `id`, an RFC 3339 `now`, and a `limit` from 1 to 1,000, and returns removable entries (`id`, logical `path`, `localRoot`, `oldDigest`, `oldSize`, `createdAt`) without changing anything. `archive.prune` takes the mapping `id`, 1 to 1,000 distinct `entryIds`, and `now`; it re-evaluates the policy in one transaction, ignores entries that are no longer removable, and returns `prunedEntries` and `queuedObjectDeletions`. `archive.listObjectDeletions` takes a `limit` from 1 to 1,000 and returns queued `digest`, `objectKey`, and `size` rows. `archive.completeObjectDeletion` takes a `digest` whose object file the desktop has already removed and returns whether a queue row was cleared. None of these methods accepts a filesystem path.

`fileSync.reconcile` accepts an optional `ignorePatterns` array (at most 256 rules, each compiled with the scanner's matcher; an invalid rule rejects the request without writing). Paths the rules exclude, directly or through an excluded folder, are left out of planning and keep their baselines. Omitting the field means no rules.

Staged scan generations add `scanGeneration.begin`, `scanGeneration.append`, `scanGeneration.seal`, `scanGeneration.abort`, `scanGeneration.readPage`, `scanGeneration.release`, `scanGeneration.cleanup`, and `scanGeneration.purge`, plus `fileSync.reconcileGenerations`, `fileSync.operationsPage`, and `fileSync.conflictsPage`. Begin binds the generation to the authenticated mapping participants, current revision, owning root, ignore rules, and hash mode; batches are idempotent on identical re-delivery and reject gaps, changed duplicates, quota overflow, and stale revisions; each entry carries a `kind` of `file`, `directory`, or `special`, where occupied kinds must not carry a size or digest; seal verifies the complete staged count; only sealed generations are readable for planning, and `scanGeneration.readPage` requires the owning `mappingId`: a read naming any other mapping is indistinguishable from a missing generation, so a peer cannot probe for generations outside a folder it shares. `scanGeneration.release` deletes a generation in any state with its staged entries once the device that owns it has finished the exchange; `scanGeneration.cleanup` removes aborted and expired rows on its own; and `scanGeneration.purge` deletes every staged generation, is called once at engine start when nothing can be in flight, and keeps a crashed unfinished row from holding the open-generation quota.

`fileSync.reconcileGenerations` accepts an optional `ignorePatterns` array validated exactly like the full-array method. Reconciliation applies the rules, baselines identical file paths inside SQLite, streams only differing paths to the planner, and publishes its plan atomically, so working memory follows the number of differences rather than the total file count. A one-sided addition whose destination path is occupied (the exact path, anything beneath it, or a synchronized file or special entry above it) is reported in the result's `occupiedPaths` instead of being queued. Incomplete generations never affect baselines or planning.

`fileSync.planAdditiveGenerations` is the read-only planning counterpart the initial merge uses: it takes two sealed generation IDs (a local destination and a remote source), a mode, optional `ignorePatterns`, a bounded `blockedPaths` list of `{ path, directory }` entries the merge must not write to (a file blocks exactly its path, a directory blocks its subtree, and a root directory entry blocks the tree), whether to report case-only aliases, a path cursor and a page limit. It reads no baseline, queues no operation and records no conflict, and it accepts an approved mapping whose setup status is `ready-for-initial-sync` or `active`. Each page returns the pull `additions` (`path`, `size`, `digest`), same-path `conflicts`, `occupied` destination paths, and a `nextCursor` when more difference rows remain; the first page (no cursor) also returns exact whole-plan `totals` so the caller can check free space before copying anything. Pages page over raw difference rows, so a page that classifies many rows as skipped still advances.

The scan digest cache adds `digestCache.lookup`, `digestCache.record`, and `digestCache.prune`, each requiring an active mapping. `digestCache.lookup` takes 1 to 1,000 distinct relative paths and returns only the rows that exist, in unspecified order. `digestCache.record` takes 1 to 1,000 distinct entries tagged with a sweep ID and upserts them in one transaction, replacing every column of a path that was already cached. `digestCache.prune` deletes a mapping's cached rows whose sweep ID does not match the given `keepSweepId`, which the desktop calls only after a sweep that re-recorded every eligible file, so pruning stays correct across a wall-clock jump. The engine stores and returns each entry's device, inode, and modification/status-change timestamps as exact decimal strings and never interprets them; deciding whether a cached digest is still trustworthy against the current filesystem state is entirely the desktop's responsibility.

No mapping method accepts SQL or dereferences a mapping path. No private key or user-file content is returned.

## Ordering and delivery

Active events carry a positive monotonic revision plus deterministic event ID. Wall-clock timestamps are diagnostic fields, never the sole ordering key. Tombstones carry their own deletion event/revision and are terminal for the mapping ID.

Electron sends pending events over the existing mutually authenticated encrypted peer channel as `mapping-config`. The receiver supplies the peer identity established by that channel—not a renderer value—to `mapping.applyRemote`. Its response acknowledges the exact mapping ID, event ID, and revision. Disconnects and invalid acknowledgements leave the SQLite outbox entry pending.

## Health

`health` reports mapping-store:

- status (`ready`, `not-configured`, `unavailable`, `unsupported-schema`, or `migration-failed`);
- schema version when known;
- legacy migration state;
- whether mutations are enabled;
- journal mode for advanced diagnostics.

An unavailable, locked, corrupt, incomplete, or newer database produces an error state, not `[]`.

## Stable error codes

Mapping callers distinguish at least authentication, invalid request/params, not configured, unavailable, corrupt, unsupported schema, schema migration failure, legacy migration required/failed, duplicate legacy ID, tombstoned ID, not found, stale revision, invalid participant, and acknowledgement mismatch.

## Other current and planned RPC

The development engine also exposes authenticated `health`, `shutdown`, `manifest.scan`, `manifest.compare`, and `plan.build`. The manifest scanner remains preliminary and this PR does not expand or wire it into the desktop read path.

Production application/device/history/activity APIs, event streams, Unix sockets, and Windows named pipes remain planned.
