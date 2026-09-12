import type { CachedFileDigest } from "./folder-manifest"

/**
 * Pre-mapping identity seeds for folder setup.
 *
 * A comparison preview reads and hashes a folder before any mapping exists,
 * so the durable engine digest cache cannot hold its results. This store keeps
 * those verified identities in memory for a short window. A later walk over
 * the same root and rules can then reuse a digest without reading the file —
 * but only when the platform reports a usable identity (non-zero device and
 * file id, positive nanosecond modification and change times), the root's
 * filesystem is not FAT/exFAT, and every identity value still matches the
 * current file. Any weaker evidence is a miss, never a hit.
 *
 * Entries are only ever recorded by the local user's own workflows, never by
 * a peer request, and are bounded by both age and total count. Losing or
 * expiring a seed only costs hashing again.
 */
export const SCAN_REUSE_TTL_MS = 30 * 60_000
/** Total digest entries retained across all seeded roots. */
export const SCAN_REUSE_MAX_ENTRIES = 500_000

interface SeededScan {
  capturedAt: number
  digests: ReadonlyMap<string, CachedFileDigest>
}

function seedKey(rootPath: string, ignorePatterns: readonly string[]): string {
  return JSON.stringify([rootPath, ignorePatterns])
}

export class ScanReuseStore {
  readonly #seeds = new Map<string, SeededScan>()
  #totalEntries = 0

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = SCAN_REUSE_TTL_MS,
    private readonly maxEntries: number = SCAN_REUSE_MAX_ENTRIES,
  ) {}

  remember(rootPath: string, ignorePatterns: readonly string[], digests: ReadonlyMap<string, CachedFileDigest>): void {
    if (digests.size === 0 || digests.size > this.maxEntries) return
    this.#prune()
    const key = seedKey(rootPath, ignorePatterns)
    const previous = this.#seeds.get(key)
    if (previous) this.#totalEntries -= previous.digests.size
    this.#evictUntilFits(digests.size)
    this.#seeds.set(key, { capturedAt: this.now(), digests: new Map(digests) })
    this.#totalEntries += digests.size
  }

  lookup(rootPath: string, ignorePatterns: readonly string[]): ReadonlyMap<string, CachedFileDigest> | undefined {
    this.#prune()
    return this.#seeds.get(seedKey(rootPath, ignorePatterns))?.digests
  }

  forget(rootPath: string, ignorePatterns: readonly string[]): void {
    const key = seedKey(rootPath, ignorePatterns)
    const existing = this.#seeds.get(key)
    if (!existing) return
    this.#totalEntries -= existing.digests.size
    this.#seeds.delete(key)
  }

  #prune(): void {
    for (const [key, seed] of this.#seeds) {
      if (this.now() - seed.capturedAt >= this.ttlMs) {
        this.#totalEntries -= seed.digests.size
        this.#seeds.delete(key)
      }
    }
  }

  #evictUntilFits(incomingEntries: number): void {
    while (this.#totalEntries + incomingEntries > this.maxEntries && this.#seeds.size > 0) {
      let oldestKey: string | undefined
      let oldestAt = Number.POSITIVE_INFINITY
      for (const [key, seed] of this.#seeds) {
        if (seed.capturedAt < oldestAt) {
          oldestAt = seed.capturedAt
          oldestKey = key
        }
      }
      if (!oldestKey) return
      const oldest = this.#seeds.get(oldestKey)
      if (oldest) this.#totalEntries -= oldest.digests.size
      this.#seeds.delete(oldestKey)
    }
  }
}
