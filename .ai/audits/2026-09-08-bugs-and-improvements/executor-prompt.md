---
type: executor-prompt
title: Fix watcher coverage and health reporting
slug: watcher-coverage-health
created: 2026-09-08
status: ready
target: desktop folder watchers and production health projection
related:
  - audit.html
---
# Fix watcher coverage and health reporting

Implement this focused plan in Tethera. Do not re-plan or rewrite the architecture.

## Context

Electron main owns FolderChangeMonitor in apps/desktop/src/main/continuous-sync.ts. Production wiring is refreshContinuousSyncMonitors in apps/desktop/src/main/index.ts:1786. Existing tests are apps/desktop/tests/continuous-sync.test.ts; manifest ignore behavior lives in folder-manifest.ts. Read AGENTS.md and the sync, security and testing documents first.

## Implementation

1. Add regression coverage: rename then change in the same debounce window must still refresh directories; an event during refresh must not lose required follow-up work; close must suppress pending work.
2. Retain pending refresh intent across events in FolderChangeMonitor instead of capturing only the last event boolean. Keep refreshes serialized.
3. Replace the synthetic `${relativePath}/placeholder` ignore probe with directory-aware matching consistent with the manifest. Test that **/placeholder leaves docs/keep.txt watched and **/node_modules/** still prunes dependency subtrees.
4. Aggregate native watcher coverage during refresh. Caught watch failures must not be followed by recovered. Report asynchronous watcher errors, deduplicate repeated failures across directories and clear degradation only when intended coverage returns. Use deterministic test seams only where needed; keep real temporary-root watcher tests.
5. Supply the currently omitted onWatchHealth callback in refreshContinuousSyncMonitors. Project degraded coverage into truthful folder feedback/activity and retain that health across normal sync snapshot updates. Preserve conflict/transfer status priority. Mention fallback polling only when active; preserve existing startup failure semantics.
6. Test the production wiring, repeated failures, actual recovery, monitor replacement and callbacks after close. Update existing documentation only where behavior changes.

## Constraints

No any, dependencies, unrelated refactors, storage migrations, deletion/rename propagation or archive pruning. Reuse existing contracts and UI. Preserve filesystem containment, authenticated boundaries and all archive/durable sync guarantees. Use synthetic roots only.

## Validation

Run focused continuous-sync and folder-manifest tests, desktop typecheck/test, and bun run verify plus git diff --check for PR readiness. Exercise degraded/recovered feedback in real Electron. Report exact commands and any unverified physical Linux-to-Windows behavior. Do not equate browser preview or unit tests with native runtime proof.

## Completion report

Summarize changes, files, test results and remaining limitations. Do not commit or publish unless separately requested.
