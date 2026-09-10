import { opendir, realpath, stat } from "node:fs/promises"
import path from "node:path"
import { createIgnoreMatcher } from "./folder-manifest"
import { isTetheraStagingPath, resolveWithinRoot } from "./path-safety"
import { ScanCancelledError } from "./folder-manifest"

/**
 * TypeScript mirror of the Rust `scan_generations` contract. Every value
 * crossing the engine RPC or peer boundary is validated here; a compile-time
 * type on one side never validates the runtime payload on the other.
 */

export const SCAN_GENERATION_CAPABILITY = "scan-generations-v1"
export const SCAN_PAGE_MAX_ENTRIES = 1_000
export const SCAN_PAGE_MAX_BYTES = 1_048_576
export const SCAN_BATCH_MAX_ENTRIES = 1_000
/** Bounds the in-memory directory frontier; traversal fails explicitly beyond it. */
export const MAX_SCAN_FRONTIER_DIRECTORIES = 10_000

export interface GenerationEntry {
  path: string
  size: number
  digest?: string
}

export interface BeginGenerationInput {
  generationId: string
  mappingId: string
  participantDeviceId: string
  mappingRevision: number
  root: string
  ignorePatterns: string[]
  hashMode: "full-sha256" | "preview"
}

export interface AppendBatchInput {
  generationId: string
  sequence: number
  entries: GenerationEntry[]
}

export interface SealGenerationInput {
  generationId: string
  expectedCount: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseId(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 200 || value.includes("\0")) {
    throw new Error(`The scan generation ${field} is invalid.`)
  }
  return value
}

function parsePath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 4096 || value.includes("\0")) {
    throw new Error("The scan generation path is invalid.")
  }
  return value
}

export function parseGenerationEntry(value: unknown): GenerationEntry {
  if (!isRecord(value)) throw new Error("The scan generation entry is invalid.")
  const entryPath = parsePath(value.path)
  if (typeof value.size !== "number" || !Number.isSafeInteger(value.size) || value.size < 0) {
    throw new Error("The scan generation entry size is invalid.")
  }
  if (value.digest !== undefined && (typeof value.digest !== "string" || !/^[a-f0-9]{64}$/.test(value.digest))) {
    throw new Error("The scan generation entry digest is invalid.")
  }
  return { path: entryPath, size: value.size, digest: value.digest }
}

export function parseBeginGenerationInput(value: unknown): BeginGenerationInput {
  if (!isRecord(value)) throw new Error("The scan generation request is invalid.")
  const generationId = parseId(value.generationId, "id")
  const mappingId = parseId(value.mappingId, "mapping")
  const participantDeviceId = parseId(value.participantDeviceId, "participant")
  if (typeof value.mappingRevision !== "number" || !Number.isSafeInteger(value.mappingRevision) || value.mappingRevision <= 0) {
    throw new Error("The scan generation revision is invalid.")
  }
  if (typeof value.root !== "string" || value.root.length === 0 || value.root.length > 4096 || value.root.includes("\0")) {
    throw new Error("The scan generation root is invalid.")
  }
  if (!Array.isArray(value.ignorePatterns) || value.ignorePatterns.length > 256 ||
    value.ignorePatterns.some((pattern) => typeof pattern !== "string" || pattern.length > 512 || pattern.includes("\0"))) {
    throw new Error("The scan generation ignore rules are invalid.")
  }
  if (value.hashMode !== "full-sha256" && value.hashMode !== "preview") {
    throw new Error("The scan generation hash mode is invalid.")
  }
  return {
    generationId,
    mappingId,
    participantDeviceId,
    mappingRevision: value.mappingRevision,
    root: value.root,
    ignorePatterns: value.ignorePatterns as string[],
    hashMode: value.hashMode,
  }
}

export function parseAppendBatchInput(value: unknown): AppendBatchInput {
  if (!isRecord(value)) throw new Error("The scan batch is invalid.")
  const generationId = parseId(value.generationId, "id")
  if (typeof value.sequence !== "number" || !Number.isSafeInteger(value.sequence) || value.sequence < 0) {
    throw new Error("The scan batch sequence is invalid.")
  }
  if (!Array.isArray(value.entries) || value.entries.length > SCAN_BATCH_MAX_ENTRIES) {
    throw new Error("The scan batch exceeds the per-batch entry limit.")
  }
  return { generationId, sequence: value.sequence, entries: value.entries.map(parseGenerationEntry) }
}

export function parseSealGenerationInput(value: unknown): SealGenerationInput {
  if (!isRecord(value)) throw new Error("The scan seal request is invalid.")
  const generationId = parseId(value.generationId, "id")
  if (typeof value.expectedCount !== "number" || !Number.isSafeInteger(value.expectedCount) || value.expectedCount < 0 || value.expectedCount > 1_000_000) {
    throw new Error("The scan seal count is invalid.")
  }
  return { generationId, expectedCount: value.expectedCount }
}

/** Splits entries into pages bounded by count and estimated encoded bytes. */
export function toEntryPages(entries: GenerationEntry[], maxEntries = SCAN_PAGE_MAX_ENTRIES, maxBytes = SCAN_PAGE_MAX_BYTES): GenerationEntry[][] {
  const pages: GenerationEntry[][] = []
  let current: GenerationEntry[] = []
  let currentBytes = 0
  for (const entry of entries) {
    const entryBytes = Buffer.byteLength(entry.path, "utf8") * 2 + 128 + (entry.digest ? 64 : 0)
    if ((current.length >= maxEntries || currentBytes + entryBytes > maxBytes) && current.length > 0) {
      pages.push(current)
      current = []
      currentBytes = 0
    }
    current.push(entry)
    currentBytes += entryBytes
  }
  if (current.length > 0) pages.push(current)
  return pages
}

export interface StreamEntriesOptions {
  ignorePatterns: string[]
  signal?: AbortSignal | null
}

export interface PeerPageClient {
  request: (payload: Record<string, unknown>, timeoutMs: number, signal: AbortSignal) => Promise<unknown>
  supportsGenerations: () => Promise<boolean>
}

/**
 * Fetches one sealed peer generation page-by-page with backpressure: each
 * page is requested only after the caller consumed the previous one, and the
 * peer signal aborts the wait at the next checkpoint. Legacy peers without
 * the capability throw a distinct error so callers retain explicit limits.
 */
export async function* fetchPeerGenerationPages(
  client: PeerPageClient,
  folderId: string,
  generationId: string,
  options: { limit?: number; timeoutMs?: number; signal: AbortSignal },
): AsyncGenerator<GenerationEntry[], void, void> {
  if (!(await client.supportsGenerations())) {
    throw new Error("The paired computer speaks only legacy full-manifest scans with explicit limits.")
  }
  const limit = options.limit ?? 200
  if (limit <= 0 || limit > SCAN_PAGE_MAX_ENTRIES) throw new Error("The scan page request is invalid.")
  let cursor: string | undefined
  for (;;) {
    if (options.signal.aborted) throw new ScanCancelledError()
    const raw = await client.request(
      { type: "scan-generation-read-page", folderId, generationId, cursor: cursor ?? null, limit },
      options.timeoutMs ?? 60_000,
      options.signal,
    )
    if (options.signal.aborted) throw new ScanCancelledError()
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error("The paired computer returned an invalid scan page.")
    }
    const page = raw as { entries?: unknown; nextCursor?: unknown }
    if (!Array.isArray(page.entries) || page.entries.length > SCAN_PAGE_MAX_ENTRIES) {
      throw new Error("The paired computer returned an invalid scan page.")
    }
    const entries = page.entries.map(parseGenerationEntry)
    if (entries.length > 0) yield entries
    const next = page.nextCursor === undefined || page.nextCursor === null ? undefined : String(page.nextCursor)
    if (!next) break
    cursor = next
  }
}

/**
 * Streams relative file paths under an approved root in sorted order without
 * retaining the full manifest. The directory frontier is bounded; traversal
 * fails explicitly at the tested limit instead of exhausting handles.
 */
export async function* streamRelativeFilePaths(
  rootPath: string,
  options: StreamEntriesOptions,
): AsyncGenerator<string, void, void> {
  const root = path.resolve(rootPath)
  const rootStat = await stat(root)
  if (!rootStat.isDirectory()) throw new Error("The selected path is not a folder.")
  const canonicalRoot = await realpath(root)
  const matcher = createIgnoreMatcher(options.ignorePatterns)
  const frontier: Array<{ directoryPath: string; relativeDirectory: string }> = [{ directoryPath: root, relativeDirectory: "" }]
  const seen = new Set<string>()
  while (frontier.length > 0) {
    if (options.signal?.aborted) throw new ScanCancelledError()
    if (frontier.length > MAX_SCAN_FRONTIER_DIRECTORIES) {
      throw new Error(`The folder scan exceeds the ${MAX_SCAN_FRONTIER_DIRECTORIES.toLocaleString("en-US")}-directory frontier limit. Add ignore rules and retry.`)
    }
    const current = frontier.pop()
    if (!current) break
    const canonicalDirectory = await realpath(current.directoryPath)
    const relative = path.relative(canonicalRoot, canonicalDirectory)
    if (relative.startsWith("..") || path.isAbsolute(relative)) continue
    const directory = await opendir(current.directoryPath)
    try {
      const subdirectories: Array<{ directoryPath: string; relativeDirectory: string }> = []
      for await (const entry of directory) {
        if (options.signal?.aborted) throw new ScanCancelledError()
        const relativePath = `${current.relativeDirectory}${current.relativeDirectory ? "/" : ""}${entry.name}`.replaceAll("\\", "/")
        if (isTetheraStagingPath(relativePath)) continue
        if (matcher(relativePath, entry.isDirectory())) continue
        if (entry.isSymbolicLink()) continue
        if (entry.isDirectory()) {
          subdirectories.push({ directoryPath: path.join(current.directoryPath, entry.name), relativeDirectory: relativePath })
          continue
        }
        if (!entry.isFile()) continue
        // Validate containment through the owning root before yielding.
        resolveWithinRoot(root, relativePath)
        if (seen.has(relativePath)) continue
        seen.add(relativePath)
        yield relativePath
      }
      // Depth-first to keep the frontier small.
      for (let index = subdirectories.length - 1; index >= 0; index -= 1) {
        const next = subdirectories[index]
        if (next) frontier.push(next)
      }
    } finally {
      await directory.close().catch(() => undefined)
    }
  }
}
