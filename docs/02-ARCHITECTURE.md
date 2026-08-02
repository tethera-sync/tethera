# Architecture

## Process model

```text
Electron main process
├── window/tray/notifications/updates
├── engine supervision
├── pairing + authenticated peer sessions
├── one-time state.json mapping migration
└── validated IPC
        │ narrow contextBridge API
Sandboxed React renderer
        │ authenticated local RPC
Rust sync engine
├── authoritative mapping RPC
├── schema migrations
├── mapping revisions + tombstones
├── pending-delivery outbox
└── SQLite mapping index

Electron main ── mutually authenticated encrypted configuration request ── paired Electron main
```

The renderer is replaceable. Mapping ownership and deletion evidence do not live in React, Electron state, browser storage, or `state.json`.

## Rust crates

### `sync-core`
Pure revision, reconciliation, direction, conflict, deletion and safety semantics. Avoid filesystem/network/SQLite dependencies so it can be tested exhaustively.

### `sync-engine`
Current orchestration binary: authenticated stdio RPC, mapping-store startup/recovery, health, schema migration, mapping operations, and shutdown. Moving peer sessions and the full sync pipeline into this process remains planned.

### `sync-protocol`
Versioned serialisable local-RPC types. The mapping envelope and every mapping params type deny unknown fields.

### `sync-crypto`
Device identity, pairing state, peer trust, key-vault integration and fingerprint formatting. It wraps audited libraries and never implements primitives itself.

### `sync-storage`
Currently owns SQLite mapping configuration, revisions, tombstones, legacy-import state, and the configuration-delivery outbox. Per-file indexes, operation journals, archives, and retention remain planned.

### `sync-platform`
Filesystem watchers, path validation, atomic replacement, stable-read helpers, file locks, executable bits, symlinks, free space and metered network detection.

### `sync-transport`
LAN discovery, Tailscale address detection, connection selection, secure framing, reconnect and bandwidth shaping.

### `sync-testkit`
Virtual filesystems, deterministic clocks/IDs, packet faults, crash injection and filename corpora.

## Electron responsibilities

### Main
- Spawn and supervise the Rust binary.
- Create a random local-RPC session token per launch.
- Expose a fixed allowlist of IPC handlers.
- Manage tray, window, notifications, startup and update coordination.

### Preload
Expose capability-shaped methods, never raw `ipcRenderer`, Node modules, arbitrary channels, shell execution or unrestricted paths.

### Renderer
- React + TypeScript.
- shadcn/ui generated for Base UI.
- TanStack Query for engine-backed state.
- TanStack Router for navigation.
- Zustand only for temporary UI state.
- React Hook Form + Zod for forms.
- TanStack Virtual for large lists.

## Suggested engine topology

```text
EngineSupervisor
├── RpcServer
├── DeviceSessionManager
├── FolderManager
│   ├── FolderActor
│   │   ├── Watcher
│   │   ├── ReconciliationScanner
│   │   ├── OutboundPlanner
│   │   └── InboundApplier
├── ArchiveManager
├── RetentionWorker
├── ConnectivityMonitor
└── EventPublisher
```

Each folder actor serialises state transitions for its folder pair. Hashing and IO may be concurrent, but final path mutations are ordered through the journal.

## Local RPC

- Current transport is newline-delimited JSON over inherited child-process stdio.
- Electron generates a random per-launch session token and every method authenticates it before dispatch.
- Requests have a bounded method allowlist and typed params; mapping methods expose no SQL and never dereference mapping paths.
- Responses carry stable `errorCode` values so unavailable, unsupported-schema, migration-required, migration-failed, validation, stale-revision, participant, and acknowledgement failures stay distinct.
- A Unix socket / Windows named-pipe transport remains a later hardening step.

## Persistence

- `mappings.sqlite3` is the sole authority for active mapping configuration, monotonic revisions, terminal tombstones, and pending peer delivery.
- `state.json` stores desktop preferences, activity, and temporary proposal/rejection workflow state. Its `folders` field is imported once, backed up, verified, and retired; it is never a fallback mapping read source.
- `pairing-state.json` remains owned by the pairing service and contains trust state, not mapping configuration.
- Content stays in user folders or app-managed history/archive locations.
- Private identity is held in the OS credential service.

The desktop passes its existing Electron `userData` directory as `TETHERA_DATA_DIR`, keeping the PR #4 database in place. `FOLDERSYNC_DATA_DIR` is a deprecated fallback only.

## Failure containment

- Renderer crash: engine continues and a new renderer requests a snapshot.
- Engine crash: Electron reports and restarts only after preserving logs; journal recovery precedes sync.
- Peer disconnect: partial temp data remains resumable or is safely cleaned.
- Database failure: retain the last in-memory mapping view, show a degraded reason, disable mapping mutations, and never reinterpret the failure as an empty list.
- Legacy-import failure: do not mark completion, do not clean `state.json`, and retry the complete transaction only after the source is readable and valid.
- Peer disconnect: immutable configuration events remain in SQLite until the exact authenticated revision/event acknowledgement arrives.
