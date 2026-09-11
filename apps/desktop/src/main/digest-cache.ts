import { randomUUID } from "node:crypto"
import { z } from "zod"
import { isSha256HexDigest } from "./file-transfer"
import type { CachedFileDigest, ScanDigestCache } from "./folder-manifest"

export interface DigestCacheRpc {
  request<T>(method: string, params?: unknown): Promise<T>
}

/** The engine accepts at most this many paths or entries per digest-cache call. */
const MAX_DIGEST_CACHE_BATCH = 1_000
/** Record batches allowed to queue behind a slow engine before further records are dropped. */
const MAX_QUEUED_RECORD_BATCHES = 8
/** However the cache looks, every folder is fully re-hashed at least this often. */
export const DIGEST_CACHE_DEEP_VERIFY_MS = 24 * 60 * 60 * 1_000

const unsignedIdSchema = z.string().regex(/^[0-9]{1,20}$/)
const signedNanosecondsSchema = z.string().regex(/^-?[0-9]{1,20}$/)
const cachedDigestSchema = z.object({
  path: z.string().min(1),
  device: unsignedIdSchema,
  inode: unsignedIdSchema,
  size: z.number().int().nonnegative(),
  modifiedNs: signedNanosecondsSchema,
  changedNs: signedNanosecondsSchema,
  digest: z.string().refine(isSha256HexDigest),
})
const lookupResponseSchema = z.object({ entries: z.array(cachedDigestSchema).max(MAX_DIGEST_CACHE_BATCH) })

type RecordedDigest = CachedFileDigest & { path: string }

/**
 * One sweep's engine-backed digest cache for a folder. Faults only ever cost
 * re-hashing: a failed or untrustworthy lookup falls back to reading the
 * files, and a failed record leaves them to be hashed again next sweep.
 */
export class EngineScanDigestCache implements ScanDigestCache {
  readonly #rpc: DigestCacheRpc
  readonly #mappingId: string
  readonly #deep: boolean
  readonly #sweepId = randomUUID()
  #pending: RecordedDigest[] = []
  #queuedBatches = 0
  #flushes: Promise<void> = Promise.resolve()
  #recordsLost = false
  #lookupWarned = false

  constructor(rpc: DigestCacheRpc, mappingId: string, options: { deep: boolean }) {
    this.#rpc = rpc
    this.#mappingId = mappingId
    this.#deep = options.deep
  }

  async lookup(relativePaths: string[]): Promise<ReadonlyMap<string, CachedFileDigest>> {
    // A deep sweep deliberately trusts nothing, so every file is read and re-recorded.
    if (this.#deep) return new Map()
    const found = new Map<string, CachedFileDigest>()
    for (let start = 0; start < relativePaths.length; start += MAX_DIGEST_CACHE_BATCH) {
      const paths = relativePaths.slice(start, start + MAX_DIGEST_CACHE_BATCH)
      const entries = await this.#lookupBatch(paths)
      if (!entries) return found
      for (const { path, ...identity } of entries) found.set(path, identity)
    }
    return found
  }

  async #lookupBatch(paths: string[]): Promise<RecordedDigest[] | undefined> {
    let response: unknown
    try {
      response = await this.#rpc.request<unknown>("digestCache.lookup", { mappingId: this.#mappingId, paths })
    } catch (error) {
      this.#warnLookup("the lookup failed", error)
      return undefined
    }
    const parsed = lookupResponseSchema.safeParse(response)
    if (!parsed.success) {
      this.#warnLookup("the lookup response was malformed", parsed.error.issues[0])
      return undefined
    }
    // Only an entry for a path this call asked about, returned once, may stand in for a hash.
    const requested = new Set(paths)
    const returned = new Set<string>()
    for (const entry of parsed.data.entries) {
      if (!requested.has(entry.path) || returned.has(entry.path)) {
        this.#warnLookup("the lookup response named unexpected paths", entry.path)
        return undefined
      }
      returned.add(entry.path)
    }
    return parsed.data.entries
  }

  #warnLookup(reason: string, detail: unknown): void {
    if (this.#lookupWarned) return
    this.#lookupWarned = true
    console.warn(`[digest-cache] ${reason} for ${this.#mappingId}; hashing those files instead`, detail)
  }

  record(relativePath: string, entry: CachedFileDigest): void {
    this.#pending.push({ ...entry, path: relativePath })
    if (this.#pending.length >= MAX_DIGEST_CACHE_BATCH) this.#flushPending()
  }

  #flushPending(): void {
    if (this.#pending.length === 0) return
    const entries = this.#pending
    this.#pending = []
    if (this.#queuedBatches >= MAX_QUEUED_RECORD_BATCHES) {
      this.#recordsLost = true
      return
    }
    this.#queuedBatches += 1
    this.#flushes = this.#flushes.then(async () => {
      try {
        await this.#rpc.request<unknown>("digestCache.record", { mappingId: this.#mappingId, sweepId: this.#sweepId, entries })
      } catch (error) {
        if (!this.#recordsLost) console.warn(`[digest-cache] could not record digests for ${this.#mappingId}; they will be hashed again next sweep`, error)
        this.#recordsLost = true
      } finally {
        this.#queuedBatches -= 1
      }
    })
  }

  /**
   * Flushes outstanding records. Only a complete deep sweep whose every record
   * landed may prune rows it did not rewrite: those describe files that are
   * gone, now ignored, or no longer settled.
   */
  async finish(options: { complete: boolean }): Promise<void> {
    this.#flushPending()
    await this.#flushes
    if (!this.#deep || !options.complete || this.#recordsLost) return
    try {
      await this.#rpc.request<unknown>("digestCache.prune", { mappingId: this.#mappingId, keepSweepId: this.#sweepId })
    } catch (error) {
      console.warn(`[digest-cache] could not prune stale digests for ${this.#mappingId}`, error)
    }
  }
}

/** Decides per folder when a sweep must ignore the cache and re-hash every file. */
export class DigestCacheVerifier {
  readonly #lastDeepSweepAt = new Map<string, number>()

  /**
   * Some filesystems (FAT, many network mounts) keep coarse or unreliable
   * change times, so a periodic full re-hash bounds how long any mistake the
   * cache could make survives. The first sweep after launch is always deep so
   * a restart never inherits one.
   */
  requiresDeepSweep(mappingId: string, now: number): boolean {
    const last = this.#lastDeepSweepAt.get(mappingId)
    return last === undefined || now - last >= DIGEST_CACHE_DEEP_VERIFY_MS
  }

  completedDeepSweep(mappingId: string, startedAt: number): void {
    this.#lastDeepSweepAt.set(mappingId, startedAt)
  }
}
