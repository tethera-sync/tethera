import { randomUUID } from "node:crypto"
import { z } from "zod"
import type { FolderScanActivity, FolderScanIssue } from "../shared/contracts"
import {
  describeMappedPathCollision,
  stageFolderEntries,
  type CachedFileDigest,
  type ScanDigestCache,
} from "./folder-manifest"
import { ObservationFingerprint } from "./observation-fingerprint"
import type { GenerationEntry } from "./scan-generation"

/**
 * Stages and releases the SQLite scan generations the continuous cycle
 * reconciles. Traversal and digest reuse stay in the scanner kernel; this
 * module only binds a generation to its mapping, streams bounded batches to
 * the engine, and guarantees a failed stage leaves nothing behind.
 */

/** Narrow engine RPC surface, so tests can drive staging without a child process. */
export interface GenerationStagingRpc {
  request<T>(method: string, params?: unknown): Promise<T>
}

export interface StagedGeneration {
  generationId: string
  files: number
  occupied: number
  ignored: number
  unreadable: number
  unreadableEntries: FolderScanIssue[]
  /** Matches a full-integrity scan of the same files, for the quiet-cycle record. */
  fingerprint: string
  rootPath: string
}

export interface GenerationBinding {
  mappingId: string
  participantDeviceId: string
  mappingRevision: number
  root: string
  ignorePatterns: string[]
}

export interface StageLocalGenerationOptions extends GenerationBinding {
  signal?: AbortSignal | null
  fileConcurrency?: number
  digestCache?: ScanDigestCache
  reuse?: ReadonlyMap<string, CachedFileDigest>
  excludePath?: (path: string, directory: boolean) => boolean
  mapPath?: (path: string, directory?: boolean) => string
  onActivity?: (activity: FolderScanActivity) => void
  onSettledDigest?: (relativePath: string, digest: CachedFileDigest) => void
  onUnreadable?: (issue: FolderScanIssue) => void
}

const generationStatusSchema = z.object({
  generationId: z.string().min(1),
  state: z.enum(["open", "sealed", "aborted"]),
  entryCount: z.number().int().nonnegative(),
})

function beginGeneration(
  rpc: GenerationStagingRpc,
  binding: GenerationBinding,
  generationId: string,
): Promise<void> {
  return rpc
    .request<unknown>("scanGeneration.begin", {
      generationId,
      mappingId: binding.mappingId,
      participantDeviceId: binding.participantDeviceId,
      mappingRevision: binding.mappingRevision,
      root: binding.root,
      ignorePatterns: binding.ignorePatterns,
      hashMode: "full-sha256",
    })
    .then((status) => {
      generationStatusSchema.parse(status)
    })
}

async function abortQuietly(rpc: GenerationStagingRpc, generationId: string): Promise<void> {
  try {
    await rpc.request("scanGeneration.abort", { generationId })
  } catch {
    // Cleanup continues through `scanGeneration.cleanup` after expiry.
  }
}

/**
 * Scans one folder into a sealed generation. Every file is read against the
 * durable digest cache and streamed in bounded batches, so memory follows the
 * batch size rather than the folder size. A failure aborts the generation.
 */
export async function stageLocalGeneration(
  rpc: GenerationStagingRpc,
  options: StageLocalGenerationOptions,
): Promise<StagedGeneration> {
  const generationId = randomUUID()
  await beginGeneration(rpc, options, generationId)
  const fingerprint = new ObservationFingerprint()
  let sequence = 0
  let delivered = 0
  try {
    const summary = await stageFolderEntries(
      options.root,
      options.ignorePatterns,
      {
        hashAllFiles: true,
        digestCache: options.digestCache,
        reuse: options.reuse,
        excludePath: options.excludePath,
        mapPath: options.mapPath,
        onActivity: options.onActivity,
        onSettledDigest: options.onSettledDigest,
        onUnreadable: options.onUnreadable,
        signal: options.signal,
        fileConcurrency: options.fileConcurrency,
      },
      async (entries) => {
        for (const entry of entries) {
          if (entry.kind === "file") fingerprint.add(entry.path, entry.size, entry.digest)
        }
        const status = generationStatusSchema.parse(
          await rpc.request<unknown>("scanGeneration.append", { generationId, sequence, entries }),
        )
        delivered += entries.length
        // The engine stores one row per path, so a lower count means two
        // scanned paths mapped to one sync path across batches; the batch-local
        // duplicate already failed before this request.
        if (status.entryCount !== delivered) throw new Error(describeMappedPathCollision())
        sequence += 1
      },
    )
    await rpc.request("scanGeneration.seal", {
      generationId,
      expectedCount: summary.files + summary.occupiedPaths.length,
    })
    return {
      generationId,
      files: summary.files,
      occupied: summary.occupiedPaths.length,
      ignored: summary.ignored,
      unreadable: summary.unreadable,
      unreadableEntries: summary.unreadableEntries,
      fingerprint: fingerprint.value(),
      rootPath: summary.rootPath,
    }
  } catch (error) {
    await abortQuietly(rpc, generationId)
    throw error
  }
}

/**
 * Stages a peer's sealed generation locally page by page, so the engine can
 * reconcile both observations set-based. The pages arrive in path order with
 * backpressure and are validated by the contract parser before they get here.
 */
export async function stageIncomingGeneration(
  rpc: GenerationStagingRpc,
  pages: AsyncIterable<GenerationEntry[]>,
  binding: GenerationBinding,
): Promise<StagedGeneration> {
  const generationId = randomUUID()
  await beginGeneration(rpc, binding, generationId)
  const fingerprint = new ObservationFingerprint()
  let sequence = 0
  let files = 0
  let occupied = 0
  try {
    for await (const page of pages) {
      if (page.length === 0) continue
      for (const entry of page) {
        if (entry.kind === undefined || entry.kind === "file") {
          if (!entry.digest) throw new Error("The paired computer staged a file without a digest.")
          fingerprint.add(entry.path, entry.size, entry.digest)
          files += 1
        } else {
          occupied += 1
        }
      }
      await rpc.request("scanGeneration.append", { generationId, sequence, entries: page })
      sequence += 1
    }
    await rpc.request("scanGeneration.seal", { generationId, expectedCount: files + occupied })
    return {
      generationId,
      files,
      occupied,
      ignored: 0,
      unreadable: 0,
      unreadableEntries: [],
      fingerprint: fingerprint.value(),
      rootPath: binding.root,
    }
  } catch (error) {
    await abortQuietly(rpc, generationId)
    throw error
  }
}

/**
 * Deletes one finished generation with its staged entries. Best effort: an
 * unreleased generation still expires through `scanGeneration.cleanup`. An
 * already-released or expired generation is routine and stays quiet.
 */
export async function releaseGeneration(rpc: GenerationStagingRpc, generationId: string): Promise<void> {
  try {
    await rpc.request("scanGeneration.release", { generationId })
  } catch (error) {
    if (errorCode(error) === "MAPPING_NOT_FOUND") return
    console.warn(`[continuous-sync] unable to release staged scan ${generationId}`, error)
  }
}

/** The structured engine error code, when the rejection carries one. */
function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined
  return typeof error.code === "string" ? error.code : undefined
}
