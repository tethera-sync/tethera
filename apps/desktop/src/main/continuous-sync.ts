import { watch, type FSWatcher } from "node:fs"
import { opendir, realpath, stat } from "node:fs/promises"
import path from "node:path"
import type { SyncMode } from "../shared/contracts"
import type { FileManifest } from "./folder-manifest"
import { isManifestPathIgnored } from "./folder-manifest"
import { isTetheraStagingPath } from "./path-safety"

const CHANGE_DEBOUNCE_MS = 750
const FALLBACK_SCAN_MS = 5 * 60_000
const MAX_WATCH_DIRECTORIES = 10_000
const MAX_WATCH_DEPTH = 128

/** Thrown by {@link collectWatchDirectories} when the tree has too many directories to watch individually. */
class WatchDirectoryLimitExceededError extends Error {}

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
  | { kind: "watch-limit-exceeded"; message: string }
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
}

/** Advertised by peers that can answer a continuous scan with "unchanged" instead of a full manifest. */
export const CONTINUOUS_FINGERPRINT_CAPABILITY = "continuous-fingerprint-v1"

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

/** Identifies a set of open conflicts, independent of the order they were listed in. */
export function conflictKey(conflicts: FileSyncConflict[]): string {
  return conflicts
    .map((conflict) => JSON.stringify([conflict.path, conflict.kind, conflict.localDigest ?? null, conflict.remoteDigest ?? null]))
    .sort()
    .join("\n")
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
    unbased > 0 ? `${unbased} without a verified baseline` : "",
    directionBlocked > 0 ? `${directionBlocked} changed against the one-way direction` : "",
  ].filter(Boolean)
  return `${conflicts.length} conflict${conflicts.length === 1 ? " needs" : "s need"} attention${details.length > 0 ? ` (${details.join(", ")})` : ""}; neither copy was changed.`
}

/**
 * Watches every real directory below an approved mapping root. Native notifications trigger a
 * debounced reconciliation and a periodic full scan catches coalesced or unsupported events.
 */
export class FolderChangeMonitor {
  readonly #rootPath: string
  readonly #ignorePatterns: string[]
  readonly #onChange: () => void
  readonly #onWatchHealth?: (report: WatchHealthReport) => void
  readonly #watchers = new Map<string, FSWatcher>()
  #debounce: NodeJS.Timeout | null = null
  #fallback: NodeJS.Timeout | null = null
  #stopped = false
  #refreshing: Promise<void> | null = null
  /** Cancels an in-flight directory collection when the monitor closes. */
  #collectionController: AbortController | null = null
  /** The currently reported degradation, so an unchanged condition is not re-reported. `null` while watching normally. */
  #degradedKey: string | null = null

  constructor(
    rootPath: string,
    ignorePatterns: string[],
    onChange: () => void,
    onWatchHealth?: (report: WatchHealthReport) => void,
  ) {
    this.#rootPath = path.resolve(rootPath)
    this.#ignorePatterns = [...ignorePatterns]
    this.#onChange = onChange
    this.#onWatchHealth = onWatchHealth
  }

  async start(): Promise<void> {
    const rootStat = await stat(this.#rootPath)
    if (!rootStat.isDirectory()) throw new Error("The synchronized folder is no longer available.")
    await this.#refreshWatchers()
    if (this.#stopped) return
    this.#fallback = setInterval(() => this.#schedule(true), FALLBACK_SCAN_MS)
  }

  close(): void {
    this.#stopped = true
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
    if (this.#debounce) clearTimeout(this.#debounce)
    this.#debounce = setTimeout(() => {
      this.#debounce = null
      if (refreshDirectories) {
        void this.#refreshWatchers()
          .then(() => this.#reportRecovered())
          .catch((error: unknown) => this.#reportRefreshFailure(error))
      }
      this.#onChange()
    }, CHANGE_DEBOUNCE_MS)
  }

  #reportDegraded(reason: WatchDegradationReason): void {
    // One refresh over a large tree can hit the same condition for thousands of
    // directories (an exhausted OS watch-descriptor limit rejects every one), so
    // only a change in condition is reported rather than every occurrence.
    const key = reason.kind === "watcher-rejected" ? `${reason.kind}:${reason.directory}` : reason.kind
    if (this.#degradedKey === key) return
    this.#degradedKey = key
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
    if (error instanceof WatchDirectoryLimitExceededError) {
      this.#reportDegraded({ kind: "watch-limit-exceeded", message: error.message })
      return
    }
    // Not a known degraded-watch condition (e.g. the root vanished mid-scan);
    // surface it for diagnosis instead of swallowing it, since `start()`'s
    // own directory check is what normally catches an unavailable root.
    console.warn(`[continuous-sync] Unable to refresh watchers for ${this.#rootPath}`, error)
  }

  async #refreshWatchers(): Promise<void> {
    if (this.#refreshing) return await this.#refreshing
    this.#refreshing = this.#replaceWatchers().finally(() => {
      this.#refreshing = null
    })
    return await this.#refreshing
  }

  async #replaceWatchers(): Promise<void> {
    const controller = new AbortController()
    this.#collectionController?.abort()
    this.#collectionController = controller
    try {
      const directories = await collectWatchDirectories(this.#rootPath, this.#ignorePatterns, controller.signal)
      if (this.#stopped || controller.signal.aborted) return
      const wanted = new Set(directories)
      for (const [directory, watcher] of this.#watchers) {
        if (!wanted.has(directory)) {
          watcher.close()
          this.#watchers.delete(directory)
        }
      }
      for (const directory of directories) {
        if (this.#stopped || controller.signal.aborted) return
        if (this.#watchers.has(directory)) continue
        try {
          const watcher = watch(directory, { persistent: false }, (event) => this.#schedule(event === "rename"))
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
          this.#reportDegraded({
            kind: "watcher-rejected",
            directory,
            message: error instanceof Error ? error.message : String(error),
          })
          this.#schedule(false)
        }
      }
    } catch (error) {
      // A close() during collection aborts the walk; a stopped monitor swallows
      // it instead of reporting a refresh failure for a scan it no longer wants.
      if (controller.signal.aborted || this.#stopped) return
      throw error
    } finally {
      if (this.#collectionController === controller) this.#collectionController = null
    }
  }
}

export async function collectWatchDirectories(rootPath: string, ignorePatterns: string[], signal?: AbortSignal | null): Promise<string[]> {
  const canonicalRoot = await realpath(rootPath)
  if (signal?.aborted) throw new Error("The watcher collection was cancelled.")
  const directories: string[] = []

  async function visit(directoryPath: string, relativeDirectory: string, depth: number): Promise<void> {
    if (signal?.aborted) throw new Error("The watcher collection was cancelled.")
    if (depth > MAX_WATCH_DEPTH) {
      throw new WatchDepthExceededError(`The synchronized folder exceeds the ${MAX_WATCH_DEPTH}-level watch limit.`)
    }
    if (directories.length >= MAX_WATCH_DIRECTORIES) {
      throw new WatchDirectoryLimitExceededError(
        `The synchronized folder exceeds the ${MAX_WATCH_DIRECTORIES.toLocaleString("en-US")}-directory watch limit.`,
      )
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
        if (isTetheraStagingPath(relativePath) || isManifestPathIgnored(`${relativePath}/placeholder`, ignorePatterns)) {
          continue
        }
        await visit(path.join(directoryPath, entry.name), relativePath, depth + 1)
      }
    } finally {
      await closeDirQuietly(directory)
    }
  }

  await visit(rootPath, "", 0)
  return directories
}
