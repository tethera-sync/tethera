# Task

Implement the "generation wiring" plan for the Tethera repository. Do not redesign the approach unless you find a real blocker; if you do, stop and report the blocker instead of inventing a different architecture.

There are two missions. **Mission A (Rust contracts) must be merged before Mission B (desktop wiring) starts.** Mission A changes no desktop behaviour and is independently testable. Do not begin Mission B in the same PR as Mission A.

Related plan (for deeper context only; all instructions are inlined here): `.ai/plans/2026-09-17-generation-wiring/plan.html`.

---

# Context

Tethera's live continuous sync still builds two full `FileManifest` objects per changed cycle and exchanges them as one chunked peer message. The engine already implements staged scan generations and set-based reconciliation:

- `crates/sync-storage/src/scan_generations.rs` — `begin`/`append`/`seal`/`abort`/`read_page`/`cleanup`, bound to mapping, participant device, mapping revision, root, ignore rules and hash mode; quotas: 4 open generations per mapping, 1,000,000 entries per generation, 1,000 entries per batch, 24 h expiry.
- `crates/sync-storage/src/file_sync.rs` — `MappingStore::reconcile_generations` (line 314) and `plan_generations_reconciliation` (line 1356): identical paths baseline inside SQLite, only differences stream out; `IgnoredPaths` (line 1260) exists and is used by `plan_reconciliation` (lines 861-865), but not by the generation planner.
- `crates/sync-engine/src/main.rs` — RPC dispatch lines 326-337; session-token method list 1718-1770.
- Desktop: `apps/desktop/src/main/scan-generation.ts` already has `fetchPeerGenerationPages`, `streamRelativeFilePaths`, parsers and `toEntryPages`, but nothing outside tests calls them; the peer responder `scan-generation-read-page` exists at `apps/desktop/src/main/index.ts:4164`, gated by `requireSharedActiveFolder` (index.ts:3997). `flushContinuousSync` (index.ts:2584) is the live cycle.

Three contract gaps must be closed before wiring: generation planning ignores ignore rules, staged observations cannot express occupied destination paths, and sealed generations cannot be removed.

---

# Mission A — Rust contracts (PR 1)

## A1. Schema v11: staged occupancy kind

In `crates/sync-storage/src/mapping.rs`:

1. Bump `SCHEMA_VERSION` (line 20) to `11`.
2. Add `migrate_v10_to_v11` following the existing step pattern (see `migrate_v9_to_v10` for style) and call it from the migration chain when `current < 11`.
3. Add `kind TEXT NOT NULL DEFAULT 'file' CHECK (kind IN ('file','directory','special'))` to `scan_entries`. `ALTER TABLE ... ADD COLUMN` is acceptable; rebuilding the table is also acceptable. Existing rows become `file`.
4. Add or update a migration test in the style of `migrates_schema_v9_to_v10_preserving_staged_scan_entries` (mapping.rs:2973) proving staged rows survive a v10 store and read back as `file`.

## A2. Kind through staging, paging and validation

In `crates/sync-storage/src/scan_generations.rs`:

1. `GenerationEntry` gains a string `kind` field with serde default `"file"` (mirror the existing `hash_mode` string style; do not introduce an enum on the wire).
2. `validate_generation_entry`: allow only `file|directory|special`; keep the current size/digest checks for `file`; for `directory`/`special` require `size == 0` and no digest, failing closed otherwise.
3. `append_scan_batch`: store `kind`; include it in `stored_entries`/`stored_matches_entry` so a replayed batch with a changed kind is rejected like a changed digest. Quota counting is unchanged (all rows count).
4. `read_generation_page`: select and return `kind`; keyset ordering by `relative_path` unchanged.
5. Tests: kind round-trip; replay with changed kind rejected (idempotency); occupied validation rejects non-zero size or a digest.

## A3. Ignore rules in generation reconciliation

In `crates/sync-storage/src/file_sync.rs`:

1. Add `#[serde(default)] pub ignore_patterns: Vec<String>` to `ReconcileGenerationsRequest` (line 141), validated by the same rules used for the full-array request (reuse the existing pattern validation; do not duplicate matcher logic).
2. In `plan_generations_reconciliation` (line 1356) build `IgnoredPaths` and skip any streamed row whose path is ignored — mirror `plan_reconciliation` lines 861-865 exactly. Identical pairs still advance baselines through `advance_identical_generation_baselines` (line 1491), which is harmless for ignored paths.
3. Tests: a baselined path that becomes ignored produces no conflict and keeps its baseline; removing the rule later compares against the retained baseline. Update `docs/03-SYNC-SEMANTICS.md:100` (it currently says generation reconciliation does not take rules).

## A4. Occupancy-aware planning and reporting

In `plan_generations_reconciliation`:

1. Restrict identical-pair baselining to `local.kind = 'file' AND remote.kind = 'file'`.
2. File observations come only from `kind = 'file'` rows; occupied rows act only as blockers.
3. For a one-sided file addition, probe the **destination** generation for the path itself and each ancestor using a prepared point lookup (`SELECT kind FROM scan_entries WHERE generation_id = ?1 AND relative_path = ?2`). Any hit blocks the addition: `directory`/`special` is occupancy; a `file` ancestor is the structural file-versus-folder case that `createDestinationOccupancyCheck` (`apps/desktop/src/main/folder-manifest.ts:1005`) already blocks.
4. Blocked outcome must match today's behaviour exactly:
   - no baseline for the path → report an occupied skip, plan no operation and no conflict;
   - baseline exists → plan `DeletionNotPropagated` (today's filtered-observation path produces this).
5. Divergent pairs (present on both sides, different digests) are never affected by occupancy.
6. Add an optional `occupied_paths: Vec<String>` to the generation reconcile result (serialise only when non-empty) so the desktop can keep calling `recordOccupiedPaths`.
7. Tests: equivalence with full-array planning under (a) directory ancestor, (b) special entry at the exact path, (c) file ancestor, (d) baselined path whose destination became occupied, (e) divergent pairs unaffected. Follow `set_based_generation_planning_matches_full_array_planning` (scan_generations.rs:1048).

## A5. Release

In `scan_generations.rs`:

1. Add `pub fn release_scan_generation(&self, generation_id: &str) -> Result<(), MappingStoreError>`: one transaction deleting the generation row in any state (`open`, `sealed`, `aborted`) with entries cascading; `NotFound` for an unknown id. Do not change `abort` or `cleanup` semantics.
2. Expose `scanGeneration.release` in `crates/sync-engine/src/main.rs`: handler near the other generation handlers (lines 818-943), dispatch entry (lines 332-337), and add the method to the session-token list (lines 1734-1743).
3. Tests: release deletes open and sealed generations with their entries; missing id is `NotFound`.

## A6. Scale measurement and docs

1. Extend the ignored `generation_scale` test (scan_generations.rs:1547) to include occupied rows so ancestor-probe cost is measured; record the numbers in `docs/15-IMPLEMENTATION-STATUS.md`.
2. Update `docs/06-DATA-MODEL.md` (schema v11, kind, release), `docs/09-LOCAL-RPC.md` (`scanGeneration.release`), `docs/11-TESTING.md` (new coverage), `docs/03-SYNC-SEMANTICS.md` (rules).

## Mission A validation

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace
git diff --check
```

Behaviour of the desktop must be unchanged after Mission A: it does not call the new fields or the release RPC.

## Mission A final response

Report: (1) summary of changes, (2) files changed, (3) commands run and their results, (4) measured scale numbers if run, (5) blockers/assumptions.

---

# Mission B — Desktop wiring (PR 2)

**Start only after Mission A is merged.** Read the merged Rust code first; do not assume the field/response names below if they changed during review.

## B1. Streaming scan sink

In `apps/desktop/src/main/folder-manifest.ts`:

1. Allow `onEntry` to return `void | Promise<void>` and `await` it at the call site (line 523). Existing callers pass sync functions and must be unchanged.
2. Add `onOccupied?: (occupied: OccupiedPath) => void` to the scan options; the kernel already yields occupied records (lines 325 and 330).
3. Add an exported batching helper (e.g. `stageFolderEntries`) mirroring `scanFolder` that flushes at most `SCAN_STAGE_BATCH_ENTRIES = 1_000` entries to an async sink, awaiting each flush before continuing, and returns the existing `ScanSummary`. Do not change `scanFolder` behaviour.

## B2. Generation staging module

New file `apps/desktop/src/main/generation-staging.ts` (keep `scan-generation.ts` a contract/validator module):

1. `stageLocalGeneration(folder, mappingRevision, signal, onActivity)`: `scanGeneration.begin` with `{ generationId: randomUUID(), mappingId, participantDeviceId: localDeviceId, mappingRevision, root: folder.localPath, ignorePatterns: folder.ignorePatterns, hashMode: "full-sha256" }`; stream entries (files plus occupied) in strictly increasing batch `sequence`; `scanGeneration.seal` with the exact count. Run through `withFolderDigestCache` (index.ts:545) and `runAdmittedScan` (index.ts:473) so digest reuse, the scan ledger, admission limits, activity counters and cancellation behave exactly like `runCachedFolderScan` (index.ts:611-625). On failure, best-effort `scanGeneration.abort`, then rethrow.
2. `stageIncomingGeneration(folder, peerDeviceId, peerRoot, generationId, signal)`: begin with the peer as participant; iterate `fetchPeerGenerationPages` (`scan-generation.ts:172`) and append batches; seal; abort on failure. Implement the missing `PeerPageClient`: `request` over `requirePeerSessions().request` with `NO_PEER_RESPONSE_DEADLINE`; `supportsGenerations` over `cachedPeerCapabilities` (index.ts:650).
3. `releaseGeneration(generationId)`: best-effort `scanGeneration.release`; log-only failures.
4. Return `{ generationId, entries, occupied, ignored, unreadable, unreadableEntries, rootPath }`; never hold a file list.

## B3. Capability-gated cycle

In `flushContinuousSync` (index.ts:2584), keep the durable preflight, the quiet-fingerprint pass, execution, projection and error handling shared; branch only the scan/reconcile exchange:

```ts
const generations = capabilities.has(SCAN_GENERATION_CAPABILITY)
if (generations) { /* generation cycle */ }
else { /* existing manifest cycle, byte-for-byte */ }
```

Generation cycle:

1. `runPairedScans` (paired-scan.ts:10) of `stageLocalGeneration` and a new `requestPeerGenerationScan` that sends `continuous-sync-generation-scan` with `NO_PEER_RESPONSE_DEADLINE`. Report local counters via `reportScanCounts(folderId, "changes", { local })` as today.
2. `stageIncomingGeneration` for the peer's sealed generation.
3. `fileSync.reconcileGenerations` with `{ mappingId, localGenerationId, remoteGenerationId, mode: folder.mode, observedAt, queueOperations: true, ignorePatterns: folder.ignorePatterns }`.
4. `recordOccupiedPaths(folder, result.occupiedPaths ?? [])` then the existing conflict/state projection (`retireInitialConflictProjection`, `applyFileSyncStateToFolder`, `recordContinuousConflicts`, broadcast) unchanged.
5. Peer reconcile: send `continuous-sync-observe-generations` with `{ folderId, localGenerationId, remoteGenerationId (the peer's own, echoed back), mode: invertMode(folder.mode), observedAt }`; validate the reply's operations with `parsePeerFileOperations` (ipc-validation.ts:479) and its conflicts/recovery issues with strict parsers before use.
6. `executeContinuousOperations` (index.ts:2457) keeps every check and completion path. Replace its `remoteManifest` parameter with a source resolver: the manifest path keeps today's `remoteFilesByPath` map; the generation path resolves `{ size: operation.sourceSize, digest: operation.sourceDigest }` from the durable operation, because `validateTransferDescriptor` (ipc-validation.ts:377) compares only size and digest and `pull-file-descriptor` re-verifies the live peer file. Keep the mirrored-operation check (continuous-sync.ts:250).
7. Release both generations after reconcile succeeds, and in `finally` on failure.

## B4. Peer handlers and gates

In `handlePeerRequest` (index.ts:4053-4647):

1. Add `continuous-sync-generation-scan`: `requireSharedActiveFolder` + `withPeerFileOperation`; stage the responder's own generation with the digest cache and `reportScanCounts(folderId, "peer-changes", …)`; reply `{ generationId, entries, occupied, ignored, unreadable }`. Leave `continuous-sync-scan` (index.ts:4125) untouched.
2. Add `continuous-sync-observe-generations`: `requireMappingMutations` + `requireSharedActiveFolder`; require `request.mode === folder.mode`; use `folder.ignorePatterns` (never peer-supplied rules) as the existing observe handler does (index.ts:4260-4275); stage the incoming generation from the coordinator, reconcile, project state, reply it; release the incoming generation and the echoed `remoteGenerationId` in `finally`.
3. `scan-generation-read-page` (index.ts:4164): replace `requireSharedActiveFolder` with a participant-scoped gate — active mapping, not blocked, not paused, `folder.remoteDeviceId === context.peerId`. Keep every other bound and the `withPeerFileOperation` wrapper. Update `docs/17-SECURE-PEER-SESSION-AND-MAPPING.md` to state that both authenticated participants may read a sealed generation of their shared mapping, while scans remain coordinator-initiated only.

## B5. Validation and parsers

1. `scan-generation.ts`: `parseGenerationEntry` accepts `kind` (`file` default; unknown rejected).
2. Add strict parsers for the generation scan reply and the observe-generations reply using the repository's existing validation conventions; bound counters and lists; reject unknown shapes before they affect local state.
3. `kind` and `occupiedPaths` values from the engine and peer are untrusted: validate before use, never trust a compile-time type across the boundary.

## B6. Cleanup wiring

Call `scanGeneration.cleanup` with the current timestamp when the engine becomes ready and after generation-cycle failures, so crash leftovers expire. Never call it mid-cycle.

## B7. Compatibility and docs

1. Use the generation path only when this build supports it and the peer advertises `scan-generations-v1`; otherwise run the manifest path unchanged, including `assertManifestFitsExchange` and the legacy budgets.
2. Update `docs/15-IMPLEMENTATION-STATUS.md` (implemented behaviour, remaining limits, next recommended PR = initial merge through generations), `docs/03`, `docs/06`, `docs/09`, `docs/11`, `docs/17`, `docs/10`.
3. Do not enable deletion or rename propagation, and do not change transfer, archive, retention, recovery or conflict-resolution semantics.

## Mission B validation

```bash
bun run desktop:typecheck
bun run desktop:test
bun run desktop:build
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace
git diff --check
# full pull-request gate:
bun run verify
```

Add tests for: staging batch bounds and abort-on-failure; incoming staging over a fake page client (backpressure, cancellation); capability fallback; strict parsing of the new replies; the read-page gate still rejecting a non-participant peer; release on success and failure. Cross-process behaviour (preload/engine spawn/Electron) cannot be verified by unit tests alone — verify in Electron or state clearly what was not verified.

## Mission B final response

Report: (1) summary of changes, (2) files changed, (3) commands run and their results, (4) tests added, (5) what was not verified (e.g. no real Linux↔Windows run), (6) blockers/assumptions.

---

# Constraints (both missions)

- Follow existing project patterns; keep each change focused; no unrelated refactors or reformatting.
- Reuse existing types, helpers and components before writing new ones (`IgnoredPaths`, `scanFolderEntries`, `withFolderDigestCache`, `runAdmittedScan`, `runPairedScans`, `fetchPeerGenerationPages`, `parsePeerFileOperations`, existing validators).
- Do not add dependencies or edit lockfiles.
- Never use `any`; do not weaken type safety; do not use assertions to silence the compiler.
- Rust: no `unwrap`/`expect`/`panic!`/`unreachable!` on data, filesystem, database, network, peer or RPC paths; keep `cargo fmt` clean and Clippy warnings as errors.
- Treat every peer and engine payload as untrusted; validate size, shape, participant identity, revision and path scope before it can affect local state.
- Preserve staged-write, digest-verification, fsync, atomic no-replace, archive and replacement-journal guarantees untouched.
- Migrations must preserve existing installations, run transactionally, be restart-safe and idempotent, and refuse a newer schema without modifying it.
- Tests use temporary/synthetic roots only; never point tests at real user folders.
