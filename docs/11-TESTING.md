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

Mapping RPC regressions cover persistence and queued delivery of bounded unreadable-file details, old previews without the additive fields, and malformed reports rejected without creating a mapping. Comparison-session tests cover large-folder summary reuse, all input-key changes, expiry, cancellation/drop, bounded retention and changed unreadable paths requiring review.

Desktop tests exercise the one-time `state.json` import and cleanup independently from the database implementation. They cover no file, zero mappings, valid data, malformed and duplicate data, unreadable state, import retry after failure, crash after database commit but before cleanup, verified backups, preservation of unrelated settings, SQLite-only startup reads, tombstone filtering, health warnings and mutation gating.

Initial-merge tests cover direction-aware additive planning, fresh-scan convergence gating, large-file eligibility, strict two-pass completion ordering, durable conflict outcome projection, bounded source reads, source mutation detection, full-file SHA-256 verification, incomplete-staging cleanup, atomic no-replace commits, and source/destination symlink escape rejection. Full-integrity manifest tests prove files above the preview hashing ceiling receive digests and crash-residue staging names are never synchronized.

Continuous-sync tests cover watcher delivery, full-digest observation conversion, one-way mode inversion, compare-and-replace destination checks, first-observation fail-safe behavior, verified-baseline advancement, durable retry state, simultaneous modifications, one-sided deletions, unbased divergence, exact replay of a queued conflict choice, mirrored operation-ID matching, rejection of stale observations, and cascade cleanup when a mapping is removed. Rust storage and authenticated RPC tests cover idempotent exact conflict selection, stale/missing version rejection, projection into durable retry work, exact incoming-application authorization and operation binding, safe lost-ack idempotency, recovery-issue reconciliation blocking without journal orphaning, and a mirrored two-store choice completing through an installed archive journal on the receiver.

## Migration and restart integration

Preview transport regressions use authenticated loopback peers to cover active-handler disconnect/cancellation, progress extending the idle wait, hard scan deadlines, terminal-response validation, progress sequence/size limits, and the existing 8 MiB response flush. Preview client tests cover capability negotiation, older-peer fallback, cancellation, and preserved comparison errors across IPC. These synthetic tests do not prove a physical Linux-to-Windows comparison.

The integration gate creates a temporary legacy state, launches the real Rust engine, imports the mappings, restarts the engine, and confirms the import is not duplicated. It then removes a mapping, restarts again, presents an older active event, and verifies the tombstone prevents resurrection. A sentinel beneath a path-shaped fixture must remain byte-for-byte unchanged throughout.

No migration or configuration test may scan a mapped directory. Paths in these tests are opaque configuration values.

## Required pull-request checks

Run from the repository root:

```bash
bun run verify
```

That single command runs exactly this sequence, so the list below is what `verify` executes rather than a second source of truth:

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace
bun run desktop:typecheck
bun run desktop:test
bun run desktop:build
```

CI runs the equivalent desktop typecheck/test/build and Rust format/clippy/test gates on Linux. Cross-platform path preservation is unit-tested without resolving the paths on the host platform.

## Future sync-engine tests

The file-sync suite covers its schema migration, deterministic planner, durable operations/conflicts, restart reads, and safe transfer staging. Scan generations, power-loss fault injection, large-scale/cross-platform stress, resumable chunks, archive recovery, and deletion propagation still require dedicated suites before those features are enabled.

Large-scan coverage now includes: cooperative scan cancellation (pre-aborted, mid-walk, mid-hash, sibling abort, retry, queued-queue bounds, watcher-collection cancel, peer-request cancel); bounded scan admission (active/queue caps, slot release, aborted queued tasks); comparison equivalence (two-pass counts, deterministic top-14 samples, case-collision semantics); peer-manifest validation (duplicates, sizes, digests, truncation explicitness) and legacy encoded-byte budgets; an opt-in temporary-root stress harness (`TETHERA_SCAN_STRESS=1` for 10k files, `huge` for 10k/100k) reporting heap/external/RSS budgets without touching real folders; Rust generation contracts (idempotent replay, changed-duplicate/gap/stale-revision rejection, seal-count verification, incomplete invisibility, abort cleanup, ordered bounded paging, open-generation quota, v5-to-v6 migration); paged generation reconciliation equivalence with full arrays; and TypeScript generation validators, byte-bounded paging, relative-path streaming with a bounded directory frontier, and peer page backpressure/cancellation/capability negotiation. Disk-full injection, power-loss fault injection, and physical Linux-to-Windows runs remain uncovered (see limitations).

Future file-operation properties remain: journal recovery after process/power failure, displaced-version recovery across a power loss, deletion propagation, and convergence under repeated transport interruption. User-directed conflict selection is deterministic and durable for two present exact copies, while the additive initial merge already enforces that partial transfer never creates a live path and paths never escape an approved root.

## Release gates

No known data-loss bug, migration/restart tests pass, unsupported databases fail closed, cross-platform E2E passes, signed clean-VM artefacts verify, and the security checklist is complete. Configuration delivery must remain idempotent and exact-acknowledged; no unavailable database may be represented as an empty mapping set.
