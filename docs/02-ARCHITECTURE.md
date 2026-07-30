# Architecture

## Process model

```text
Electron main process
├── window/tray/notifications/updates
├── engine supervision
├── native folder dialogs
└── validated IPC
        │ narrow contextBridge API
Sandboxed React renderer
        │ authenticated local RPC
Rust sync engine
├── filesystem observation and scans
├── hashing/chunking
├── peer sessions and transfer
├── conflict/deletion/history policy
└── SQLite + operation journal
        │ mutually authenticated encrypted protocol
Paired Rust engine
```

The renderer is replaceable. No correctness-critical decision belongs in React, Electron state or browser storage.

## Rust crates

### `sync-core`
Pure revision, reconciliation, direction, conflict, deletion and safety semantics. Avoid filesystem/network/SQLite dependencies so it can be tested exhaustively.

### `sync-engine`
Long-running orchestration binary: startup/recovery, task scheduling, folder actors, local RPC, peer sessions, events and shutdown.

### `sync-protocol`
Versioned serialisable local-RPC and peer-protocol domain types. Unknown optional fields are ignored only within a compatible major version.

### `sync-crypto`
Device identity, pairing state, peer trust, key-vault integration and fingerprint formatting. It wraps audited libraries and never implements primitives itself.

### `sync-storage`
SQLite, migrations, operation journal, indexes, archive metadata, retention and event log.

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

- Linux Unix domain socket in the per-user runtime directory.
- Windows named pipe restricted to the current user SID.
- Length-prefixed MessagePack/CBOR or initially JSON for inspectability.
- Request IDs, schema version, typed errors and event sequence numbers.
- Per-launch authentication token.

## Persistence

- SQLite stores metadata, logical revisions and operation state.
- Content stays in user folders or app-managed history/archive locations.
- Private identity is held in the OS credential service.
- Engine-owned settings are authoritative.

## Failure containment

- Renderer crash: engine continues and a new renderer requests a snapshot.
- Engine crash: Electron reports and restarts only after preserving logs; journal recovery precedes sync.
- Peer disconnect: partial temp data remains resumable or is safely cleaned.
- Database failure: pause affected folders; never guess state.
