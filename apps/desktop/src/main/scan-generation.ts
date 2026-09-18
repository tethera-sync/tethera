import { MAX_UNREADABLE_REPORTED, ScanCancelledError, isFolderScanIssue } from "./folder-manifest"
import type { FolderScanIssue } from "../shared/contracts"

/**
 * TypeScript mirror of the Rust `scan_generations` contract. Every value the
 * engine or a peer returns across that boundary is validated here; a
 * compile-time type on one side never validates the runtime payload on the
 * other.
 */

export const SCAN_GENERATION_CAPABILITY = "scan-generations-v1"
export const SCAN_PAGE_MAX_ENTRIES = 1_000

/**
 * A staged observation is either a file with its verified digest, or an
 * occupied path a transfer must never be planned onto: a folder without
 * synchronized files, or a symbolic link or other special entry.
 */
export type GenerationEntryKind = "file" | "directory" | "special"

export interface GenerationEntry {
  path: string
  size: number
  digest?: string
  kind?: GenerationEntryKind
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
  const kind = value.kind ?? "file"
  if (kind !== "file" && kind !== "directory" && kind !== "special") {
    throw new Error("The scan generation entry kind is invalid.")
  }
  if (kind !== "file" && (value.size !== 0 || value.digest !== undefined)) {
    throw new Error("An occupied scan generation entry must not carry a size or digest.")
  }
  if (value.digest !== undefined && (typeof value.digest !== "string" || !/^[a-f0-9]{64}$/.test(value.digest))) {
    throw new Error("The scan generation entry digest is invalid.")
  }
  return { path: entryPath, size: value.size, digest: value.digest, kind }
}

export interface PeerGenerationScanReply {
  generationId: string
  entries: number
  occupied: number
  ignored: number
  unreadable: number
}

/**
 * The reply to a generation-mode scan: the id of the peer's sealed generation
 * and its bounded counters. The entries themselves never travel in this reply;
 * the coordinator fetches them page by page.
 */
export function parsePeerGenerationScanReply(value: unknown): PeerGenerationScanReply {
  if (!isRecord(value)) throw new Error("The paired computer returned an invalid staged scan.")
  const generationId = parseId(value.generationId, "id")
  const count = (field: unknown): number => {
    if (typeof field !== "number" || !Number.isSafeInteger(field) || field < 0 || field > 1_000_000) {
      throw new Error("The paired computer returned an invalid staged scan.")
    }
    return field
  }
  return {
    generationId,
    entries: count(value.entries),
    occupied: count(value.occupied),
    ignored: count(value.ignored),
    unreadable: count(value.unreadable),
  }
}

/**
 * The initial merge's generation scan reply. Unlike a continuous cycle, a
 * merge may continue past unreadable items after the user reviews them, so the
 * responder also returns its bounded detail list; the count stays the true
 * total and is what planning and the review decision compare.
 */
export interface PeerMergeGenerationScanReply extends PeerGenerationScanReply {
  unreadableEntries: FolderScanIssue[]
}

export function parsePeerMergeGenerationScanReply(value: unknown): PeerMergeGenerationScanReply {
  const base = parsePeerGenerationScanReply(value)
  const entries = (value as { unreadableEntries?: unknown }).unreadableEntries
  if (entries === undefined) return { ...base, unreadableEntries: [] }
  if (!Array.isArray(entries) || entries.length > MAX_UNREADABLE_REPORTED) {
    throw new Error("The paired computer returned an invalid staged scan.")
  }
  const unreadableEntries = entries.map((entry) => {
    if (!isFolderScanIssue(entry)) {
      throw new Error("The paired computer returned an invalid staged scan.")
    }
    return { path: entry.path, reason: entry.reason, kind: entry.kind }
  })
  return { ...base, unreadableEntries }
}

export interface PeerPageClient {
  request: (payload: { type: string } & Record<string, unknown>, timeoutMs: number, signal: AbortSignal) => Promise<unknown>
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
