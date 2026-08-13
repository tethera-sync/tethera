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

Replacement safety adds authenticated `archive.prepareReplacement`, `archive.markArchived`, `archive.markInstalled`, `archive.listIncomplete`, `archive.listVersions`, `archive.get`, `archive.recordIssue`, `archive.recordObjectIssue`, `archive.recover`, `archive.prepareRestore`, and `archive.completeRestore`. These methods validate journal identities and lifecycle transitions; they do not accept arbitrary archive paths or file bytes. `archive.recordObjectIssue` durably marks a previously published object `missing` or `corrupt` after filesystem verification fails. `fileSync.complete` and `fileSync.applyVerified` require the receiving device's installed replacement journal before completing a destructive pull.

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
