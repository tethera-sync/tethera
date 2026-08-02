# Testing and quality strategy

## Authoritative mapping store

The mapping-configuration safety boundary is covered at three levels.

Rust storage tests exercise:

- schema v1 to v2 migration, transactional rollback, idempotency and newer-schema refusal;
- legacy import as one transaction, including zero mappings, duplicates, malformed records, retry and late SQL failure;
- durable tombstones across reopen, terminal deletion semantics, stale/out-of-order event rejection and same-ID resurrection prevention;
- exact pending-delivery acknowledgements, duplicate delivery and two authenticated peers converging through active and deletion events;
- locked/unavailable databases, corrupt stored rows, invalid revisions and invalid participants;
- opaque round trips for Windows drive paths, UNC paths and Linux paths; and
- a sentinel proving mapping storage never reads or changes files beneath a configured path.

Rust engine/RPC tests exercise authentication before dispatch, unknown-field rejection, structured error codes, migration states, database-unavailable and unsupported-schema health, participant validation, exact acknowledgement matching, active-only reads and the branded data-directory environment fallback.

Desktop tests exercise the one-time `state.json` import and cleanup independently from the database implementation. They cover no file, zero mappings, valid data, malformed and duplicate data, unreadable state, import retry after failure, crash after database commit but before cleanup, verified backups, preservation of unrelated settings, SQLite-only startup reads, tombstone filtering, health warnings and mutation gating.

## Migration and restart integration

The integration gate creates a temporary legacy state, launches the real Rust engine, imports the mappings, restarts the engine, and confirms the import is not duplicated. It then removes a mapping, restarts again, presents an older active event, and verifies the tombstone prevents resurrection. A sentinel beneath a path-shaped fixture must remain byte-for-byte unchanged throughout.

No migration or configuration test may scan a mapped directory. Paths in these tests are opaque configuration values.

## Required pull-request checks

Run from the repository root:

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace
bun run desktop:typecheck
bun run desktop:test
bun run desktop:build
bun run check
```

CI runs the equivalent desktop typecheck/test and Rust format/clippy/test gates on Linux. Cross-platform path preservation is unit-tested without resolving the paths on the host platform.

## Future sync-engine tests

The mapping suite intentionally does not stand in for future file-synchronisation testing. A durable per-file index, scan generations, operation journal, transfer staging, crash recovery and reconciliation will need their own migration, model, fault-injection and cross-platform suites before those features can write user data.

Future file-operation properties remain: partial transfer never changes a live path, replacement preserves displaced content, paths never escape a root, both peers choose the same deterministic result, and eventual authenticated delivery converges.

## Release gates

No known data-loss bug, migration/restart tests pass, unsupported databases fail closed, cross-platform E2E passes, signed clean-VM artefacts verify, and the security checklist is complete. Configuration delivery must remain idempotent and exact-acknowledged; no unavailable database may be represented as an empty mapping set.
