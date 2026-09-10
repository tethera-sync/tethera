# Reliability and everyday-use review

Reviewed 2026-09-10 after the folder-preview timeout fix. This is a focused source-backed follow-up, not a claim that every platform or every failure path has been exercised. The findings below are separate from the implemented preview fix; they have not been silently folded into its diff.

## Highest-priority follow-up work

### 1. Large folders can pass preview and still time out during actual sync

**Confirmed limitation / P1 workflow defect.** Progress-aware waiting is now wired into outgoing and incoming preview comparisons. Initial merge, its final verification, and continuous sync still use separate five-minute remote manifest requests.

Evidence: `apps/desktop/src/main/index.ts:2118`, `:2604`, `:2671`; `CONTINUOUS_SYNC_RPC_TIMEOUT_MS` at `:211`. These flows hash all files, including files that the preview only checks by metadata. A folder that needs a long preview may need an even longer full-integrity scan. The new disconnect cleanup prevents abandoned scan work from piling up, but does not by itself let these later requests continue beyond their own deadlines.

Recommended next implementation: extend negotiated scan activity to the approved-mapping scan requests, preserving participant/revision checks and mapping-scoped operation ownership. Align the outer initial-merge request and lease/heartbeat budgets before extending inner scans. Do not blindly increase all peer timeouts or weaken full-digest validation. Test slow full-integrity scans, cancellation, lease loss and post-transfer verification, then exercise a real two-computer run.

### 2. The scan setting suggests a large-folder path the live sync engine cannot complete

**Confirmed limitation / P1 product-contract defect.** Settings permits up to one million files or no scan limit, while live legacy manifests and Rust observations are still capped at 10,000 files per side. Increasing the setting can turn a partial preview into a later hard failure rather than enable synchronization.

Evidence: `apps/desktop/src/main/ipc-validation.ts:35`–`:41`; `apps/desktop/src/main/index.ts:359` calls the legacy observation and byte-budget guards; `apps/desktop/src/renderer/views/settings.tsx:187`–`:263` exposes the scan setting. `docs/15-IMPLEMENTATION-STATUS.md` explicitly records that staged-generation primitives are not yet wired into the live flows.

Recommended immediate product fix: state the actual supported sync capacity beside the setting and during folder setup, and reject a setup that cannot complete with a specific recovery path. The complete engineering fix is bounded staged-generation scanning/reconciliation through initial and continuous sync, including paged UI outcomes. Preserve the existing limits until that path is fully tested. This matters for photos and document archives as well as coding trees.

### 3. History controls promise cleanup that does not happen

**Confirmed / P1 trust and disk-use issue.** Setup offers “Keep versions for,” “History storage cap,” and “Oldest versions are removed first,” but retention pruning is not implemented. A person selecting a storage cap can reasonably believe archive disk use is bounded by it.

Evidence: `apps/desktop/src/renderer/components/add-folder-dialog.tsx:241`; history values are persisted in `crates/sync-storage/src/mapping.rs`, while `apps/desktop/src/main/version-archive.ts:283` leaves cleanup to a future safety policy. `docs/15-IMPLEMENTATION-STATUS.md:93` states that no archive object or journal row is pruned or expired. The promise was also visible during the real Electron smoke test.

Recommended immediate fix: stop presenting these values as enforced limits; clearly state that saved versions are retained until safe cleanup support exists. Implement retention separately with reference checks for unfinished recovery journals, interruption/restart tests and disk-space reporting. Do not delete recovery evidence to make the label true.

### 4. Incomplete comparisons can look identical and still proceed to approval

**Confirmed / P2 misleading comparison and avoidable dead end.** Manifest comparison combines unreadable counts with ordinary ignored entries. A scan with one unreadable item can return no differences, `truncated: false`, and no dedicated unreadable count in the preview. The UI then says both folders currently contain the same files. Truncation produces a warning, but is not part of the approval-blocking condition. Actual merge later fails closed on incomplete/unreadable scans.

Evidence: `apps/desktop/src/main/folder-manifest.ts:308`; `apps/desktop/src/shared/contracts.ts:221`; `apps/desktop/src/renderer/components/add-folder-dialog.tsx:85`, `:344`, and its empty difference message; `apps/desktop/src/renderer/components/folder-mapping-approval-dialog.tsx:187` also warns without blocking approval; `apps/desktop/src/main/index.ts:2324` rejects incomplete transfer scans.

Verified with a synthetic call to `compareManifests`: an unreadable local entry produced `{ ignoredLocal: 1, truncated: false, samples: [] }`. No real user folder was scanned.

Recommended fix: preserve unreadable counts and per-side completeness in the preview contract; show “comparison incomplete” instead of “identical”; block approval in main and UI until the comparison is complete or rules are deliberately changed and rechecked. Test unreadable roots/items, truncation on either side, and renderer attempts to submit stale/incomplete previews.

### 5. Folder setup silently selects the first paired computer

**Confirmed / P2 multi-device usability bug.** Both the app toolbar and Folders view select `getPairedDevices(snapshot)[0]`. If that computer is offline while another paired computer is online, adding a folder is disabled. There is no target-computer selector in the mapping dialog.

Evidence: `apps/desktop/src/renderer/app.tsx:178`, `:298`; `apps/desktop/src/renderer/views/folders.tsx:39`, `:139`; `apps/desktop/src/renderer/lib/snapshot.ts:20`. A synthetic two-peer snapshot confirmed that the selected target stays the offline first peer.

Recommended fix: offer an explicit computer choice when multiple peers are paired, default to the available peer when unambiguous, and reset/revalidate remote paths and previews when the selection changes. Test offline-first ordering, peer disconnection and switching after browsing.

## Improvements for people who do not know the implementation

- **Simpler first setup:** use “Connect folders” and “Compare folders” in primary copy; keep protocol and mapping terminology out of the basic flow. Explain the actual direction and conflict behavior with the two computer names.
- **Optional exclusion presets:** offer explicit, reviewable presets for common temporary/generated content, including a code-project preset, without silently excluding personal files. Show what a preset changes before rescanning. Current defaults omit only a handful of temporary/system patterns (`add-folder-dialog.tsx:36`), so coding folders still include dependency and build trees unless the user writes glob rules.
- **A supported-capacity and recovery summary:** explain what was compared, which files were skipped, whether copying has actually started, and the next recoverable action. Preserve inputs on retry and distinguish waiting for a computer from active disk work. The preview fix implements part of this; consistent post-approval status is the next pass.

## Validation and orchestration

- The implemented preview fix passed `bun run verify` (Rust fmt/Clippy/151 workspace tests and desktop typecheck/test/build). After adding one final queued-cancellation regression, `bun run desktop:test` passed all 268 tests. A real Electron sandboxed preload + bundled renderer smoke with synthetic peer responses covered remote counters, cancellation, clean errors, preserved selections and retry. `git diff --check` passed.
- The follow-up findings above were checked against current source. Two pure synthetic probes validated the incomplete-preview projection and offline-first selection. No physical Linux-to-Windows run or production folder scan was performed.
- A Luna worker implemented and tested the bounded UI work, then completed the read-only usability audit. Its device-selection, incomplete-preview and retention findings were verified and accepted. Its general claim that offline status overpromises automatic sync was rejected as stated: `renderer/lib/snapshot.ts:52`–`:63` already handles offline and needs-attention states. Watcher-health correctness needs its own end-to-end trace and is not claimed as newly confirmed here.
- The bounded transport implementation used GPT-5.6 Terra; a separate Luna review hit the account usage limit, so the lead reviewed the transport changes directly rather than silently escalating to a more expensive review model. No recursive delegation or unrelated implementation was performed.
