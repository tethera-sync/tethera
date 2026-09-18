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

Mapping RPC regressions cover persistence and queued delivery of bounded unreadable-file details, old previews without the additive fields, and malformed reports rejected without creating a mapping. Comparison-session tests cover large-folder summary reuse, all input-key changes, expiry, cancellation/drop, bounded retention and changed unreadable paths requiring review, including partial legacy reports and reordered JSON properties. Approval-review tests ensure cloned IPC snapshots preserve consent while changed destinations, rules or issue details reset it. Seed collection is capped during the scan, retaining a useful partial seed instead of allocating and discarding an oversized one.

Desktop tests exercise the one-time `state.json` import and cleanup independently from the database implementation. They cover no file, zero mappings, valid data, malformed and duplicate data, unreadable state, import retry after failure, crash after database commit but before cleanup, verified backups, preservation of unrelated settings, SQLite-only startup reads, tombstone filtering, health warnings and mutation gating.

Initial-merge tests cover direction-aware additive planning, fresh-scan convergence gating, large-file eligibility, strict two-pass completion ordering, durable conflict outcome projection, bounded source reads, source mutation detection and its per-file classification (never for folder escapes), free-space preflight and out-of-space reporting, full-file SHA-256 verification, incomplete-staging cleanup, atomic no-replace commits, and source/destination symlink escape rejection. Full-integrity manifest tests prove files above the preview hashing ceiling receive digests and crash-residue staging names are never synchronized.

Existing-destination regressions cover identical-file reuse, leaving out paths occupied by a folder, link or special entry (in planning, verification and continuous observations), preserving divergent versions regardless of timestamps, files appearing during commit, continued unrelated transfers, staging cleanup and integrity/symlink rejection. Rust and desktop comparison tests cover cross-participant directory-case collisions. Ignore-preset tests cover nested dependency exclusions, retained source/lockfiles, preserved custom rules and duplicate-free repeated application.

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

Archive retention storage tests cover the age-window boundary, the newest-first storage cap with shared content counted once, zero limits, protection of unfinished work and unfinished restore sources, re-evaluated and idempotent pruning, queueing only unreferenced objects, and refusing to re-archive queued content until its removal is confirmed, including across a reopen. Engine tests cover retention RPC parameter validation, and the v8-to-v9 migration is tested. Desktop tests cover verified displaced-copy removal through the logical-to-physical path mapping, keeping an edited or out-of-root copy, skipping an unavailable root, and an interrupted object removal that is never confirmed before its file is gone and finishes on the next pass.

The file-sync suite covers its schema migration, deterministic planner, durable operations/conflicts, restart reads, and safe transfer staging. Power-loss fault injection, large-scale/cross-platform stress, resumable chunks, archive recovery, and deletion propagation still require dedicated suites before those features are enabled.

Large-scan coverage now includes: cooperative scan cancellation (pre-aborted, mid-walk, mid-hash, sibling abort, retry, queued-queue bounds, watcher-collection cancel, peer-request cancel); bounded scan admission (active/queue caps, slot release, aborted queued tasks); comparison equivalence (two-pass counts, deterministic top-14 samples, case-collision semantics); peer-manifest validation (duplicates, sizes, digests, truncation explicitness) and legacy encoded-byte budgets; an opt-in temporary-root stress harness (`TETHERA_SCAN_STRESS=1` for 10k files, `huge` for 10k/100k, both uncapped) reporting heap/external/RSS budgets without touching real folders; an opt-in Rust reconcile timing (`cargo test -p sync-storage --release -- --ignored reconcile_scale_timing`, with `TETHERA_RECONCILE_FILES` setting the per-side size, 250,000 by default) and a regular test that more than 10,000 files per side reconcile; streamed JSON equivalence with `JSON.stringify`, engine requests larger than the pipe buffer, peer chunks sealed from a stream (including multibyte text across chunk boundaries and a message that changes between measuring and sending), and a recursive folder watcher that skips ignored paths; Rust generation contracts (idempotent replay, changed-duplicate/gap/stale-revision rejection, entry-kind round-trips and validation, seal-count verification, incomplete invisibility, abort cleanup, release and purge in every state, ordered bounded paging, open-generation quota, v5-to-v6 and v10-to-v11 migrations); generation reconciliation equivalence with full arrays including ignored paths that keep their baselines and occupied destinations that block one-sided additions (exact path, folder beneath the path, folder, symbolic link and file ancestors, and the baselined variant); and TypeScript generation validators (entry kinds, occupied-entry rules, strict peer scan replies), peer page backpressure/cancellation/capability negotiation, the generation-path selection matrix (capability, chunked frames, pending durable work), and desktop generation staging (bounded batch flushing with exact seal counts, occupied-kind staging, fingerprint equivalence with a full-integrity scan, mapped-path collision reporting, abort on a failed local or incoming batch, and best-effort release). The additive merge plan is covered on the Rust side (paged additions with first-page totals, read-only planning that never writes a baseline or conflict, occupied and blocked destination handling including subtree blocks and a file ancestor, ignore rules and one-way sends, case-only aliases including a directory component, rejection of unapproved or incomplete generations, a stable paged query plan without a temporary sort, and an opt-in `cargo test -p sync-storage --release -- --ignored additive_plan_scale_timing` timing at 250,000 additions) and on the TypeScript side (strict page parsing, blocked-path bound, engine request shape, first-page totals requirement, cursor ordering that fails closed on a repeated cursor, blocked-path conversion from scan issues including the empty-file and root-directory cases, the merge-generation capability gate, and strict parsing of the merge scan reply's bounded inaccessible report). Disk-full injection, power-loss fault injection, and physical Linux-to-Windows runs remain uncovered (see limitations), and the wired generation merge and cycle have not yet been exercised between two packaged Electron apps.

Future file-operation properties remain: journal recovery after process/power failure, displaced-version recovery across a power loss, deletion propagation, and convergence under repeated transport interruption. User-directed conflict selection is deterministic and durable for two present exact copies, while the additive initial merge already enforces that partial transfer never creates a live path and paths never escape an approved root.

## Release gates

No known data-loss bug, migration/restart tests pass, unsupported databases fail closed, cross-platform E2E passes, signed clean-VM artefacts verify, and the security checklist is complete. Configuration delivery must remain idempotent and exact-acknowledged; no unavailable database may be represented as an empty mapping set.
