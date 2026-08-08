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

export function observedFiles(manifest: FileManifest): ObservedFile[] {
  return manifest.files.map((entry) => {
    if (!entry.digest) throw new Error(`The full-content scan did not produce a digest for ${entry.path}.`)
    return { path: entry.path, size: entry.size, digest: entry.digest }
  })
}

export function conflictSummary(conflicts: FileSyncConflict[]): string {
  if (conflicts.length === 0) return "Watching for changes."
  const simultaneous = conflicts.filter((conflict) => conflict.kind === "simultaneous-modification").length
  const deletions = conflicts.filter((conflict) => conflict.kind === "deletion-not-propagated").length
  const unbased = conflicts.filter((conflict) => conflict.kind === "unbased-divergence").length
  const details = [
    simultaneous > 0 ? `${simultaneous} edited on both computers` : "",
    deletions > 0 ? `${deletions} deleted on one computer` : "",
    unbased > 0 ? `${unbased} without a verified baseline` : "",
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
  readonly #watchers = new Map<string, FSWatcher>()
  #debounce: NodeJS.Timeout | null = null
  #fallback: NodeJS.Timeout | null = null
  #stopped = false
  #refreshing: Promise<void> | null = null

  constructor(rootPath: string, ignorePatterns: string[], onChange: () => void) {
    this.#rootPath = path.resolve(rootPath)
    this.#ignorePatterns = [...ignorePatterns]
    this.#onChange = onChange
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
      if (refreshDirectories) void this.#refreshWatchers().catch(() => undefined)
      this.#onChange()
    }, CHANGE_DEBOUNCE_MS)
  }

  async #refreshWatchers(): Promise<void> {
    if (this.#refreshing) return await this.#refreshing
    this.#refreshing = this.#replaceWatchers().finally(() => {
      this.#refreshing = null
    })
    return await this.#refreshing
  }

  async #replaceWatchers(): Promise<void> {
    const directories = await collectWatchDirectories(this.#rootPath, this.#ignorePatterns)
    if (this.#stopped) return
    const wanted = new Set(directories)
    for (const [directory, watcher] of this.#watchers) {
      if (!wanted.has(directory)) {
        watcher.close()
        this.#watchers.delete(directory)
      }
    }
    for (const directory of directories) {
      if (this.#watchers.has(directory)) continue
      try {
        const watcher = watch(directory, { persistent: false }, (event) => this.#schedule(event === "rename"))
        watcher.on("error", () => {
          watcher.close()
          this.#watchers.delete(directory)
          this.#schedule(false)
        })
        this.#watchers.set(directory, watcher)
      } catch {
        this.#schedule(false)
      }
    }
  }
}

async function collectWatchDirectories(rootPath: string, ignorePatterns: string[]): Promise<string[]> {
  const canonicalRoot = await realpath(rootPath)
  const directories: string[] = []

  async function visit(directoryPath: string, relativeDirectory: string, depth: number): Promise<void> {
    if (depth > MAX_WATCH_DEPTH) throw new Error(`The synchronized folder exceeds the ${MAX_WATCH_DEPTH}-level watch limit.`)
    if (directories.length >= MAX_WATCH_DIRECTORIES) {
      throw new Error(`The synchronized folder exceeds the ${MAX_WATCH_DIRECTORIES.toLocaleString("en-US")}-directory watch limit.`)
    }
    const canonicalDirectory = await realpath(directoryPath)
    const relativeCanonical = path.relative(canonicalRoot, canonicalDirectory)
    if (relativeCanonical.startsWith("..") || path.isAbsolute(relativeCanonical)) return
    directories.push(directoryPath)
    const directory = await opendir(directoryPath)
    for await (const entry of directory) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      const relativePath = path.join(relativeDirectory, entry.name).replaceAll("\\", "/")
      if (isTetheraStagingPath(relativePath) || isManifestPathIgnored(`${relativePath}/placeholder`, ignorePatterns)) {
        continue
      }
      await visit(path.join(directoryPath, entry.name), relativePath, depth + 1)
    }
  }

  await visit(rootPath, "", 0)
  return directories
}
