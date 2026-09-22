import type { FSWatcher } from "node:fs"
import { lstat, opendir, realpath, stat, watch } from "./synced-fs"
import path from "node:path"
import type { OverallStatus, SyncMode } from "../shared/contracts"
import type { FileManifest } from "./folder-manifest"
import { createDestinationOccupancyCheck, createManifestPathIgnoreCheck } from "./folder-manifest"
import { isTetheraStagingPath } from "./path-safety"
import { SCAN_GENERATION_CAPABILITY } from "./scan-generation"

const CHANGE_DEBOUNCE_MS = 750
const FALLBACK_SCAN_MS = 5 * 60_000
const MAX_WATCH_DEPTH = 128
/** Windows and macOS watch a whole tree natively with one handle; Linux needs one watch per directory. */
const NATIVE_RECURSIVE_WATCH = process.platform === "win32" || process.platform === "darwin"

/** Thrown by {@link collectWatchDirectories} when the tree is nested deeper than the watcher will follow. */
class WatchDepthExceededError extends Error {}

// Bun 1.3's `Dir.close()` returns void while Node and newer Bun return a
// promise, so never assume `.catch` exists on its result.
async function closeDirQuietly(directory: { close: () => unknown }): Promise<void> {
  try {
    await directory.close()
  } catch {
    // Best-effort cleanup; traversal errors already propagate.
  }
}

export type WatchDegradationReason =
  | { kind: "watch-depth-exceeded"; message: string }
  | { kind: "watcher-rejected"; directory: string; message: string }

/** Reports a change in whether {@link FolderChangeMonitor} is watching the full tree natively. */
export type WatchHealthReport = { status: "degraded"; reason: WatchDegradationReason } | { status: "recovered" }

export interface ObservedFile {
  path: string
  size: number
  digest: string
}

export type FileSyncDirection = "pull-remote" | "push-local"
export type FileSyncConflictKind =
  | "unbased-divergence"
  | "simultaneous-modification"
  | "deletion-not-propagated"
  | "direction-blocked"

export interface FileSyncOperation {
  id: number
  mappingId: string
  path: string
  direction: FileSyncDirection
  sourceDigest: string
  sourceSize: number
  expectedDestinationDigest?: string
  status: "pending" | "failed"
  attempts: number
  lastError?: string
  createdAt: string
  updatedAt: string
}

export interface ExactConflictChoice {
  direction: FileSyncDirection
  localDigest: string
  localSize: number
  remoteDigest: string
  remoteSize: number
}

export interface PeerFileOperationIdentity {
  id: number
  path: string
  direction: FileSyncDirection
  sourceDigest: string
  sourceSize: number
  expectedDestinationDigest?: string
}

export interface FileSyncConflict {
  mappingId: string
  path: string
  kind: FileSyncConflictKind
  localDigest?: string
  remoteDigest?: string
  detectedAt: string
}

export interface FileSyncState {
  mappingId: string
  initialized: boolean
  baselineCount: number
  operations: FileSyncOperation[]
  conflicts: FileSyncConflict[]
  recoveryIssues: Array<{
    id: string
    path: string
    state: "recovery-required" | "integrity-failed"
    lastError?: string
  }>
}

export interface ReconcileFilesRequest {
  mappingId: string
  local: ObservedFile[]
  remote: ObservedFile[]
  mode: SyncMode
  observedAt: string
  queueOperations: boolean
}

export interface ReconcileFilesResult extends FileSyncState {
  verifiedCount: number
  /** One-sided files a folder, link or special entry already occupies; only generation reconciliation reports these. */
  occupiedPaths?: string[]
}

/** Advertised by peers that can answer a continuous scan with "unchanged" instead of a full manifest. */
export const CONTINUOUS_FINGERPRINT_CAPABILITY = "continuous-fingerprint-v1"

/**
 * A pending operation on a path the reconciler still reports as a conflict can
 * only come from a conflict choice the user made: reconciliation plans either
 * an operation or a conflict for a path, never both. Such a choice is not
 * re-derived from observations, so a fresh plan would drop it.
 */
export function conflictChoiceOperations(
  { operations, conflicts }: Pick<FileSyncState, "operations" | "conflicts">,
): FileSyncOperation[] {
  if (operations.length === 0 || conflicts.length === 0) return []
  const conflictPaths = new Set(conflicts.map((conflict) => conflict.path))
  return operations.filter((operation) => conflictPaths.has(operation.path))
}

/**
 * Conflict choices mirrored and run in one cycle. Each one costs a paired
 * inspection before it can be mirrored, so a folder holding thousands of them
 * would otherwise disappear into a single cycle that copies nothing until the
 * very end and that a restart has to begin again. A bounded batch keeps the
 * queue visibly moving and leaves the rest for the next cycle.
 */
export const CONFLICT_CHOICE_DRAIN_LIMIT = 100

/**
 * How often one conflict choice may fail before a cycle stops retrying it.
 * Reaching this means the copies the choice named are gone from at least one
 * computer, so reconciliation retires the choice and records the conflict
 * again rather than blocking every other queued copy behind it forever.
 */
export const MAX_CONFLICT_CHOICE_ATTEMPTS = 3

/** Splits queued conflict choices into the ones still worth retrying and the ones that are exhausted. */
export function partitionConflictChoices(chosen: FileSyncOperation[]): {
  runnable: FileSyncOperation[]
  exhausted: FileSyncOperation[]
} {
  const runnable: FileSyncOperation[] = []
  const exhausted: FileSyncOperation[] = []
  for (const operation of chosen) {
    if (operation.attempts >= MAX_CONFLICT_CHOICE_ATTEMPTS) exhausted.push(operation)
    else runnable.push(operation)
  }
  return { runnable, exhausted }
}

/** One queued path a cycle could not copy, and why. */
export interface TransferFailure {
  path: string
  detail: string
}

/** What one pass over a batch of durable operations achieved. */
export interface TransferBatchResult {
  copiedFiles: number
  failures: TransferFailure[]
}

/** Names one concrete failure and counts the rest, so a large batch still reports in a single line. */
export function describeTransferFailures(failures: TransferFailure[]): string {
  const [first] = failures
  if (!first) return "No queued file failed."
  if (failures.length === 1) return `${first.path}: ${first.detail}`
  return `${failures.length} files stayed queued. ${first.path}: ${first.detail}`
}

/**
 * Whether a changed cycle may reconcile through staged generations. Both peers
 * must stage and page scans, and the observe response must be able to span
 * several frames.
 *
 * Conflict choices are drained before scan-mode selection, while ordinary
 * queued work is planned independently by both computers from the same
 * observations. Generation-capable folders therefore never have to fall back
 * to materialising a whole-folder manifest merely because work is queued.
 */
export function shouldUseGenerations(
  capabilities: ReadonlySet<string>,
  chunkedFrames: boolean,
): boolean {
  return capabilities.has(SCAN_GENERATION_CAPABILITY) && chunkedFrames
}

const CHANGE_CYCLE_REST_FACTOR = 3
const MAX_CHANGE_CYCLE_REST_MS = 2 * 60_000

/**
 * How long a check started only by file changes waits after the previous check
 * finished. Scaling the rest with the check's own duration leaves a small
 * folder responding within a second, while a huge folder that never stops
 * changing (live git repositories, build output) spends at most about a
 * quarter of its time checking instead of scanning back to back.
 */
export function changeCycleRestMs(previousCycleMs: number): number {
  return Math.min(Math.max(0, previousCycleMs) * CHANGE_CYCLE_REST_FACTOR, MAX_CHANGE_CYCLE_REST_MS)
}

/** However quiet a folder looks, it is fully reconciled at least this often. */
export const FULL_RECONCILE_INTERVAL_MS = 60 * 60_000

/**
 * The last continuous reconcile that queued nothing, and what it saw. While
 * both observations and the durable state still match it, reconciling again
 * would decide exactly the same, so an idle cycle can stop after scanning.
 */
export interface QuietReconcile {
  revision: number
  localFingerprint: string
  remoteFingerprint: string
  baselineCount: number
  conflictKey: string
  reconciledAt: number
}

/** Identifies one open conflict by its path, kind and the exact copies it holds. */
export function conflictCopiesKey(conflict: FileSyncConflict): string {
  return JSON.stringify([conflict.path, conflict.kind, conflict.localDigest ?? null, conflict.remoteDigest ?? null])
}

/** Identifies a set of open conflicts, independent of the order they were listed in. */
export function conflictKey(conflicts: FileSyncConflict[]): string {
  return conflicts.map(conflictCopiesKey).sort().join("\n")
}

/**
 * Whether a conflict may turn out to hold the same text on both computers in
 * different line endings, which the coordinator settles without asking. A
 * one-way folder's blocked change keeps its protection, and a deletion has
 * only one copy to compare.
 */
export function isLineEndingCandidate(conflict: FileSyncConflict): boolean {
  return (
    (conflict.kind === "unbased-divergence" || conflict.kind === "simultaneous-modification") &&
    conflict.localDigest !== undefined &&
    conflict.remoteDigest !== undefined
  )
}

export interface ConflictReport {
  /** Conflicts to announce now. */
  report: FileSyncConflict[]
  /** Every announced conflict still open, by {@link conflictCopiesKey}. */
  reported: Set<string>
  /** Every conflict seen by this pass, by {@link conflictCopiesKey}. */
  seen: Set<string>
}

/**
 * Picks the conflicts worth a new activity entry, so resolving some of a large
 * set never re-announces the rest. A conflict whose resolution is already
 * queued is not announced. A line-ending candidate waits until the coordinator
 * has compared its copies, or until a later pass still finds it (the paired
 * computer cannot see that comparison), because most are settled without the
 * user and announcing them first would only be noise.
 */
export function selectConflictsToReport(
  state: Pick<FileSyncState, "conflicts" | "operations">,
  previouslyReported: ReadonlySet<string>,
  previouslySeen: ReadonlySet<string>,
  lineEndingChecked: ReadonlySet<string>,
): ConflictReport {
  const queuedPaths = new Set(conflictChoiceOperations(state).map((operation) => operation.path))
  const report: FileSyncConflict[] = []
  const reported = new Set<string>()
  const seen = new Set<string>()
  for (const conflict of state.conflicts) {
    const key = conflictCopiesKey(conflict)
    seen.add(key)
    if (previouslyReported.has(key)) {
      reported.add(key)
      continue
    }
    if (queuedPaths.has(conflict.path)) continue
    if (isLineEndingCandidate(conflict) && !lineEndingChecked.has(key) && !previouslySeen.has(key)) continue
    report.push(conflict)
    reported.add(key)
  }
  return { report, reported, seen }
}

/**
 * Whether an idle cycle may stop after its scans, provided both come back
 * unchanged since `quiet`: the same mapping revision, nothing queued or
 * awaiting recovery, the same baseline count and conflicts, and a full
 * reconcile recent enough.
 */
export function canSkipUnchangedCycle(
  quiet: QuietReconcile | undefined,
  durable: FileSyncState,
  revision: number,
  now: number,
): quiet is QuietReconcile {
  return (
    quiet !== undefined &&
    quiet.revision === revision &&
    durable.operations.length === 0 &&
    durable.recoveryIssues.length === 0 &&
    durable.baselineCount === quiet.baselineCount &&
    conflictKey(durable.conflicts) === quiet.conflictKey &&
    now - quiet.reconciledAt < FULL_RECONCILE_INTERVAL_MS
  )
}

/** A peer's answer that its folder still matches the fingerprint it was asked about. */
export function isUnchangedScanReply(value: unknown): value is { unchanged: true } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    "unchanged" in value &&
    value.unchanged === true
  )
}

export function observedFiles(manifest: FileManifest): ObservedFile[] {
  return manifest.files.map((entry) => {
    if (!entry.digest) throw new Error(`The full-content scan did not produce a digest for ${entry.path}.`)
    return { path: entry.path, size: entry.size, digest: entry.digest }
  })
}

/**
 * Observations for reconciliation, without the one-sided files the other
 * computer cannot receive because a folder, link or special entry already uses
 * that path there. A file present on both computers always stays in.
 */
export function syncableObservations(local: FileManifest, remote: FileManifest): {
  local: ObservedFile[]
  remote: ObservedFile[]
  occupiedPaths: string[]
} {
  const occupiedPaths: string[] = []
  const receivable = (files: ObservedFile[], destination: FileManifest) => {
    const destinationPaths = new Set(destination.files.map((entry) => entry.path))
    const isOccupied = createDestinationOccupancyCheck(destination)
    return files.filter((file) => {
      if (destinationPaths.has(file.path) || !isOccupied(file.path)) return true
      occupiedPaths.push(file.path)
      return false
    })
  }
  const receivableLocal = receivable(observedFiles(local), remote)
  const receivableRemote = receivable(observedFiles(remote), local)
  return { local: receivableLocal, remote: receivableRemote, occupiedPaths }
}

/**
 * Selects durable work whose source and destination still match the observations that created it.
 * This resumes interrupted work before reconciliation without ever applying a stale operation.
 */
export function replayableOperations(
  operations: FileSyncOperation[],
  local: ObservedFile[],
  remote: ObservedFile[],
): FileSyncOperation[] {
  const localByPath = new Map(local.map((file) => [file.path, file]))
  const remoteByPath = new Map(remote.map((file) => [file.path, file]))
  return operations.filter((operation) => {
    const source = operation.direction === "push-local"
      ? localByPath.get(operation.path)
      : remoteByPath.get(operation.path)
    const destination = operation.direction === "push-local"
      ? remoteByPath.get(operation.path)
      : localByPath.get(operation.path)
    if (!source || source.digest !== operation.sourceDigest || source.size !== operation.sourceSize) {
      return false
    }
    return operation.expectedDestinationDigest === undefined
      ? destination === undefined
      : destination?.digest === operation.expectedDestinationDigest
  })
}

/** Mirrors a coordinator's exact conflict choice into the paired computer's local orientation. */
export function mirrorConflictChoice(choice: ExactConflictChoice): ExactConflictChoice {
  return {
    direction: choice.direction === "push-local" ? "pull-remote" : "push-local",
    localDigest: choice.remoteDigest,
    localSize: choice.remoteSize,
    remoteDigest: choice.localDigest,
    remoteSize: choice.localSize,
  }
}

/** Finds the paired participant's exact durable half of one synchronization operation. */
export function findMirroredPeerOperation(
  operation: FileSyncOperation,
  peerOperations: PeerFileOperationIdentity[],
): PeerFileOperationIdentity | undefined {
  const peerDirection: FileSyncDirection = operation.direction === "push-local" ? "pull-remote" : "push-local"
  return peerOperations.find((candidate) =>
    candidate.path === operation.path &&
    candidate.direction === peerDirection &&
    candidate.sourceDigest === operation.sourceDigest &&
    candidate.sourceSize === operation.sourceSize &&
    candidate.expectedDestinationDigest === operation.expectedDestinationDigest,
  )
}

export function conflictSummary(conflicts: FileSyncConflict[]): string {
  if (conflicts.length === 0) return "Watching for changes."
  let simultaneous = 0
  let deletions = 0
  let unbased = 0
  let directionBlocked = 0
  for (const conflict of conflicts) {
    if (conflict.kind === "simultaneous-modification") simultaneous += 1
    else if (conflict.kind === "deletion-not-propagated") deletions += 1
    else if (conflict.kind === "unbased-divergence") unbased += 1
    else if (conflict.kind === "direction-blocked") directionBlocked += 1
    else {
      const exhaustiveKind: never = conflict.kind
      throw new Error(`Unknown sync conflict kind: ${exhaustiveKind}`)
    }
  }
  const details = [
    simultaneous > 0 ? `${simultaneous} edited on both computers` : "",
    deletions > 0 ? `${deletions} deleted on one computer` : "",
    unbased > 0 ? `${unbased} different on each computer` : "",
    directionBlocked > 0 ? `${directionBlocked} changed against the one-way direction` : "",
  ].filter(Boolean)
  return `${conflicts.length} conflict${conflicts.length === 1 ? " needs" : "s need"} attention${details.length > 0 ? ` (${details.join(", ")})` : ""}; neither copy was changed.`
}

/** Summary for conflicts the initial merge reported that no two-sided scan has checked yet. */
export function unverifiedMergeConflictsAction(count: number): string {
  return `Waiting for the first full check of both computers. ${count.toLocaleString("en-GB")} file${count === 1 ? "" : "s"} differed during the initial merge; any that now match will drop off the list.`
}

export interface FolderSyncStateInput {
  paused: boolean
  peerOnline: boolean
  state: Pick<FileSyncState, "conflicts" | "operations" | "recoveryIssues">
  /** Initial-merge conflicts that the first two-sided scan has not replaced yet. */
  unverifiedMergeConflicts: number
}

/**
 * Status and one-line summary for an active folder. Initial-merge conflicts are only a pending
 * check until the first two-sided scan replaces them with durable results, so they do not ask
 * the user to act; durable conflicts and recovery issues do.
 */
export function describeFolderSyncState(
  { paused, peerOnline, state, unverifiedMergeConflicts }: FolderSyncStateInput,
): { status: OverallStatus; currentAction: string } {
  const { conflicts, operations, recoveryIssues } = state
  const status: OverallStatus = paused
    ? "paused"
    : conflicts.length > 0 || recoveryIssues.length > 0
      ? "needs-attention"
      : !peerOnline
        ? "offline"
        : unverifiedMergeConflicts > 0 || operations.length > 0 ? "syncing" : "up-to-date"
  if (recoveryIssues.length > 0) {
    const count = recoveryIssues.length
    return { status, currentAction: recoveryIssues[0]?.lastError ?? `${count} file replacement${count === 1 ? " requires" : "s require"} recovery.` }
  }
  if (conflicts.length > 0) return { status, currentAction: conflictSummary(conflicts) }
  if (unverifiedMergeConflicts > 0) return { status, currentAction: unverifiedMergeConflictsAction(unverifiedMergeConflicts) }
  if (operations.length > 0) {
    return { status, currentAction: `${operations.length} change${operations.length === 1 ? " is" : "s are"} waiting to retry.` }
  }
  return { status, currentAction: "Watching for changes." }
}

export interface InitialMergeOutcomeInput {
  paused: boolean
  peerOnline: boolean
  /** Same-path conflicts the merge left untouched; unchecked until the first two-sided scan. */
  conflicts: number
  /** Inaccessible items the user chose to skip. */
  unreadableSkipped: number
}

/**
 * Status right after an initial merge, before live sync has run its first two-sided scan.
 * Skipped inaccessible items need the user; the merge's conflicts are still a pending check.
 */
export function describeInitialMergeOutcome(
  { paused, peerOnline, conflicts, unreadableSkipped }: InitialMergeOutcomeInput,
): { status: OverallStatus; currentAction: string } {
  const pending = describeFolderSyncState({
    paused,
    peerOnline,
    state: { conflicts: [], operations: [], recoveryIssues: [] },
    unverifiedMergeConflicts: conflicts,
  })
  if (unreadableSkipped === 0) {
    return conflicts > 0 ? pending : { status: pending.status, currentAction: "Initial merge completed safely on both computers." }
  }
  const one = unreadableSkipped === 1
  const skipped = `${unreadableSkipped.toLocaleString("en-GB")} inaccessible item${one ? " was" : "s were"} skipped and need${one ? "s" : ""} attention; affected paths were left untouched.`
  return {
    status: paused ? "paused" : "needs-attention",
    currentAction: conflicts > 0 ? `${skipped} ${pending.currentAction}` : skipped,
  }
}

export interface FolderChangeMonitorOptions {
  /** One recursive watcher for the whole tree instead of one per directory. Defaults to platforms that do this natively. */
  recursive?: boolean
}

/**
 * Watches an approved mapping root: with one native recursive watcher where the platform
 * provides it, otherwise with one watcher per included directory, however many there are.
 * Native notifications trigger a debounced reconciliation and a periodic full scan catches
 * coalesced, dropped or unsupported events.
 */
export class FolderChangeMonitor {
  readonly #rootPath: string
  readonly #ignorePatterns: string[]
  readonly #onChange: () => void
  readonly #onWatchHealth?: (report: WatchHealthReport) => void
  readonly #recursive: boolean
  readonly #isIgnored: (relativePath: string) => boolean
  readonly #watchers = new Map<string, FSWatcher>()
  #debounce: NodeJS.Timeout | null = null
  #fallback: NodeJS.Timeout | null = null
  #stopped = false
  /** Aborts every directory collection when the monitor closes. */
  readonly #closed = new AbortController()
  /** Set when the debounced change also needs every watched directory re-collected. */
  #fullRefreshPending = false
  /** Entries created, removed or moved since the last debounce, whose watch coverage must be updated. */
  readonly #renamedEntries = new Set<string>()
  #refreshing: Promise<boolean> | null = null
  /** Cancels an in-flight directory collection when the monitor closes. */
  #collectionController: AbortController | null = null
  /** The currently reported degradation, so an unchanged condition is not re-reported. `null` while watching normally. */
  #degradedKey: string | null = null

  constructor(
    rootPath: string,
    ignorePatterns: string[],
    onChange: () => void,
    onWatchHealth?: (report: WatchHealthReport) => void,
    options: FolderChangeMonitorOptions = {},
  ) {
    this.#rootPath = path.resolve(rootPath)
    this.#ignorePatterns = [...ignorePatterns]
    this.#onChange = onChange
    this.#onWatchHealth = onWatchHealth
    this.#recursive = options.recursive ?? NATIVE_RECURSIVE_WATCH
    this.#isIgnored = createManifestPathIgnoreCheck(this.#ignorePatterns)
  }

  /** Resolves once the initial directory walk finished. `true` when at least one directory could not be watched natively. */
  async start(): Promise<boolean> {
    const rootStat = await stat(this.#rootPath)
    if (!rootStat.isDirectory()) throw new Error("The synchronized folder is no longer available.")
    let degraded: boolean
    if (this.#recursive) {
      degraded = !this.#watchRecursively()
    } else {
      try {
        degraded = await this.#refreshWatchers()
      } catch (error) {
        // A tree nested past the depth limit cannot be watched natively, but
        // the periodic fallback scan still covers it. Failing the start would
        // remove the monitor entirely and leave the folder with no scan.
        if (!(error instanceof WatchDepthExceededError)) throw error
        this.#reportRefreshFailure(error)
        degraded = true
      }
    }
    if (this.#stopped) return degraded
    this.#fallback = setInterval(() => this.#schedule(true), FALLBACK_SCAN_MS)
    return degraded
  }

  close(): void {
    this.#stopped = true
    this.#closed.abort()
    this.#collectionController?.abort()
    this.#collectionController = null
    if (this.#debounce) clearTimeout(this.#debounce)
    if (this.#fallback) clearInterval(this.#fallback)
    this.#debounce = null
    this.#fallback = null
    for (const watcher of this.#watchers.values()) watcher.close()
    this.#watchers.clear()
  }

  #schedule(refreshDirectories: boolean): void {
    if (this.#stopped) return
    // A later plain change must not cancel a full refresh an earlier event asked for.
    this.#fullRefreshPending ||= refreshDirectories
    if (this.#debounce) clearTimeout(this.#debounce)
    this.#debounce = setTimeout(() => {
      this.#debounce = null
      const fullRefresh = this.#fullRefreshPending
      this.#fullRefreshPending = false
      if (fullRefresh && this.#recursive) {
        this.#restoreRecursiveWatcher()
      } else if (fullRefresh) {
        this.#renamedEntries.clear()
        void this.#refreshWatchers()
          // A refresh that completed without rejecting a directory genuinely
          // restores full coverage; reporting recovery when the same pass just
          // rejected watch() would mask a still-degraded tree.
          .then((degraded) => {
            if (!degraded) this.#reportRecovered()
          })
          .catch((error: unknown) => this.#reportRefreshFailure(error))
      } else if (this.#renamedEntries.size > 0) {
        // Watch a new folder before its check runs, so a write landing in it
        // straight after the check started still raises its own event.
        void this.#watchRenamedEntries()
          .catch((error: unknown) => {
            if (!this.#stopped) this.#reportRefreshFailure(error)
          })
          .finally(() => {
            if (!this.#stopped) this.#onChange()
          })
        return
      }
      this.#onChange()
    }, CHANGE_DEBOUNCE_MS)
  }

  /**
   * One directory watcher's event. Tethera's own staging files and ignored
   * paths never need a check. A created, removed or moved entry only changes
   * coverage below itself, so re-walking the whole tree for it (as happens for
   * every git command, which renames its lock files into place) is avoided.
   */
  #onDirectoryEvent(directory: string, event: string, filename: string | null): void {
    if (filename === null) {
      this.#schedule(true)
      return
    }
    const entry = path.join(directory, filename)
    if (this.#isExcludedChange(path.relative(this.#rootPath, entry))) return
    if (event === "rename") this.#renamedEntries.add(entry)
    this.#schedule(false)
  }

  async #watchRenamedEntries(): Promise<void> {
    // A full refresh already walking the tree would close watchers it did not see.
    await this.#refreshing?.then(() => undefined, () => undefined)
    const entries = [...this.#renamedEntries]
    this.#renamedEntries.clear()
    for (const entry of entries) {
      if (this.#stopped) return
      this.#unwatchSubtree(entry)
      if (!(await isRealDirectory(entry))) continue
      const relativeEntry = path.relative(this.#rootPath, entry).replaceAll("\\", "/")
      const directories = await collectWatchDirectories(this.#rootPath, this.#ignorePatterns, this.#closed.signal, relativeEntry)
      if (this.#stopped) return
      this.#watchDirectories(directories)
    }
  }

  /** Closes the watchers for a directory that was removed, moved or replaced, and for everything below it. */
  #unwatchSubtree(directory: string): void {
    if (!this.#watchers.has(directory)) return
    const below = directory + path.sep
    for (const [watched, watcher] of this.#watchers) {
      if (watched !== directory && !watched.startsWith(below)) continue
      watcher.close()
      this.#watchers.delete(watched)
    }
  }

  #reportDegraded(reason: WatchDegradationReason): void {
    // One refresh over a large tree can hit the same condition for thousands of
    // directories (an exhausted OS watch-descriptor limit rejects every one), so
    // only a change in condition is reported rather than every occurrence.
    if (this.#degradedKey === reason.kind) return
    this.#degradedKey = reason.kind
    this.#onWatchHealth?.({ status: "degraded", reason })
  }

  #reportRecovered(): void {
    if (this.#degradedKey === null) return
    this.#degradedKey = null
    this.#onWatchHealth?.({ status: "recovered" })
  }

  #reportRefreshFailure(error: unknown): void {
    if (error instanceof WatchDepthExceededError) {
      this.#reportDegraded({ kind: "watch-depth-exceeded", message: error.message })
      return
    }
    // Not a known degraded-watch condition (e.g. the root vanished mid-scan);
    // surface it for diagnosis instead of swallowing it, since `start()`'s
    // own directory check is what normally catches an unavailable root.
    console.warn(`[continuous-sync] Unable to refresh watchers for ${this.#rootPath}`, error)
  }

  /** Starts the single recursive watcher. Returns whether it is watching; a refusal is reported as degraded coverage. */
  #watchRecursively(): boolean {
    try {
      const watcher = watch(this.#rootPath, { persistent: false, recursive: true }, (_event, filename) => {
        if (filename !== null && this.#isExcludedChange(filename)) return
        this.#schedule(false)
      })
      watcher.on("error", (error: Error) => {
        watcher.close()
        this.#watchers.delete(this.#rootPath)
        this.#reportDegraded({ kind: "watcher-rejected", directory: this.#rootPath, message: error.message })
        this.#schedule(false)
      })
      this.#watchers.set(this.#rootPath, watcher)
      return true
    } catch (error) {
      this.#reportDegraded({
        kind: "watcher-rejected",
        directory: this.#rootPath,
        message: error instanceof Error ? error.message : String(error),
      })
      return false
    }
  }

  /** Run by the periodic scan: brings back a recursive watcher the platform dropped. */
  #restoreRecursiveWatcher(): void {
    if (this.#stopped || this.#watchers.has(this.#rootPath)) return
    if (this.#watchRecursively()) this.#reportRecovered()
  }

  /** A recursive watcher also reports ignored trees and Tethera's own staging files, which never need a sync check. */
  #isExcludedChange(filename: string): boolean {
    const relativePath = filename.replaceAll("\\", "/")
    return isTetheraStagingPath(relativePath) || this.#isIgnored(relativePath)
  }

  async #refreshWatchers(): Promise<boolean> {
    if (this.#refreshing) return await this.#refreshing
    this.#refreshing = this.#replaceWatchers().finally(() => {
      this.#refreshing = null
    })
    return await this.#refreshing
  }

  async #replaceWatchers(): Promise<boolean> {
    const controller = new AbortController()
    this.#collectionController?.abort()
    this.#collectionController = controller
    let degraded = false
    try {
      const directories = await collectWatchDirectories(this.#rootPath, this.#ignorePatterns, controller.signal)
      if (this.#stopped || controller.signal.aborted) return true
      const wanted = new Set(directories)
      for (const [directory, watcher] of this.#watchers) {
        if (!wanted.has(directory)) {
          watcher.close()
          this.#watchers.delete(directory)
        }
      }
      degraded = this.#watchDirectories(directories)
    } catch (error) {
      // A close() during collection aborts the walk; a stopped monitor swallows
      // it instead of reporting a refresh failure for a scan it no longer wants.
      if (controller.signal.aborted || this.#stopped) return true
      throw error
    } finally {
      if (this.#collectionController === controller) this.#collectionController = null
    }
    return degraded
  }

  /** Watches every listed directory not already watched. Returns whether any was refused. */
  #watchDirectories(directories: string[]): boolean {
    let degraded = false
    for (const directory of directories) {
      if (this.#stopped) return degraded
      if (this.#watchers.has(directory)) continue
      try {
        const watcher = watch(directory, { persistent: false }, (event, filename) => {
          this.#onDirectoryEvent(directory, event, filename)
        })
        watcher.on("error", () => {
          watcher.close()
          this.#watchers.delete(directory)
          this.#schedule(false)
        })
        this.#watchers.set(directory, watcher)
      } catch (error) {
        // e.g. ENOSPC once the OS's native watch-descriptor limit is exhausted
        // (common on large trees). The directory is left unwatched; report it
        // rather than silently losing coverage of that subtree.
        degraded = true
        this.#reportDegraded({
          kind: "watcher-rejected",
          directory,
          message: error instanceof Error ? error.message : String(error),
        })
        this.#schedule(false)
      }
    }
    return degraded
  }
}

async function isRealDirectory(entry: string): Promise<boolean> {
  try {
    const metadata = await lstat(entry)
    return metadata.isDirectory() && !metadata.isSymbolicLink()
  } catch (error) {
    // The entry was removed or moved away again before it could be checked.
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT" || code === "ENOTDIR") return false
    throw error
  }
}

/** Lists the directories to watch under `startDirectory` (the whole root by default), skipping ignored and escaping ones. */
export async function collectWatchDirectories(
  rootPath: string,
  ignorePatterns: string[],
  signal?: AbortSignal | null,
  startDirectory = "",
): Promise<string[]> {
  const canonicalRoot = await realpath(rootPath)
  if (signal?.aborted) throw new Error("The watcher collection was cancelled.")
  const directories: string[] = []
  const isIgnored = createManifestPathIgnoreCheck(ignorePatterns)

  async function visit(directoryPath: string, relativeDirectory: string, depth: number): Promise<void> {
    if (signal?.aborted) throw new Error("The watcher collection was cancelled.")
    if (depth > MAX_WATCH_DEPTH) {
      throw new WatchDepthExceededError(`The synchronized folder exceeds the ${MAX_WATCH_DEPTH}-level watch limit.`)
    }
    const canonicalDirectory = await realpath(directoryPath)
    if (signal?.aborted) throw new Error("The watcher collection was cancelled.")
    const relativeCanonical = path.relative(canonicalRoot, canonicalDirectory)
    if (relativeCanonical.startsWith("..") || path.isAbsolute(relativeCanonical)) return
    directories.push(directoryPath)
    const directory = await opendir(directoryPath)
    try {
      for await (const entry of directory) {
        if (signal?.aborted) throw new Error("The watcher collection was cancelled.")
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue
        const relativePath = path.join(relativeDirectory, entry.name).replaceAll("\\", "/")
        if (isTetheraStagingPath(relativePath) || isIgnored(`${relativePath}/placeholder`)) {
          continue
        }
        await visit(path.join(directoryPath, entry.name), relativePath, depth + 1)
      }
    } finally {
      await closeDirQuietly(directory)
    }
  }

  if (startDirectory === "") {
    await visit(rootPath, "", 0)
  } else if (!isTetheraStagingPath(startDirectory) && !isIgnored(`${startDirectory}/placeholder`)) {
    await visit(path.join(rootPath, startDirectory), startDirectory, startDirectory.split("/").length)
  }
  return directories
}
