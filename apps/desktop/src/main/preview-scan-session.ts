import type { FileManifest } from "./folder-manifest"

/**
 * A rendered comparison is built from one local scan and one peer scan. The
 * wizard then asks the main process to verify those exact results again
 * (request approval) or to re-check them before approval on the responder
 * side. Reusing the scans captured for the same renderer operation turns
 * those follow-up steps into pure comparison work instead of a second
 * filesystem walk on both computers.
 *
 * Guarantees and limits:
 * - entries expire after a short window, so a later merge still scans fresh;
 * - a changed path, rule set, hash mode or peer misses the key and rescans;
 * - large manifests are not cached, bounding memory per session;
 * - losing a cache entry only ever costs a rescan, never correctness.
 */
const SESSION_TTL_MS = 10 * 60_000
const MAX_SESSIONS = 8
/** Manifests above this many files are not cached; the follow-up step rescans. */
const MAX_CACHED_FILES = 50_000

export interface PreviewScanKeyInput {
  kind: "local" | "remote"
  rootPath: string
  ignorePatterns: string[]
  hashAllFiles: boolean
  maxFiles: number | null
  peerId?: string
}

/** Stable cache key; every input that changes what a scan would collect is part of it. */
export function previewScanKey(input: PreviewScanKeyInput): string {
  return JSON.stringify([
    input.kind,
    input.peerId ?? "",
    input.rootPath,
    input.ignorePatterns,
    input.hashAllFiles,
    input.maxFiles,
  ])
}

interface PreviewScanSession {
  startedAt: number
  scans: Map<string, FileManifest>
}

export class PreviewScanSessions {
  readonly #sessions = new Map<string, PreviewScanSession>()

  constructor(private readonly now: () => number = Date.now) {}

  record(sessionId: string, key: string, manifest: FileManifest): void {
    if (manifest.files.length > MAX_CACHED_FILES) return
    this.#prune()
    let session = this.#sessions.get(sessionId)
    if (!session) {
      this.#trimSessions()
      session = { startedAt: this.now(), scans: new Map() }
      this.#sessions.set(sessionId, session)
    }
    session.scans.set(key, manifest)
  }

  lookup(sessionId: string, key: string): FileManifest | undefined {
    const session = this.#sessions.get(sessionId)
    if (!session) return undefined
    if (this.now() - session.startedAt >= SESSION_TTL_MS) {
      this.#sessions.delete(sessionId)
      return undefined
    }
    return session.scans.get(key)
  }

  drop(sessionId: string): void {
    this.#sessions.delete(sessionId)
  }

  #prune(): void {
    for (const [sessionId, session] of this.#sessions) {
      if (this.now() - session.startedAt >= SESSION_TTL_MS) this.#sessions.delete(sessionId)
    }
  }

  #trimSessions(): void {
    // Called before the new session is inserted, so free a slot when the map
    // is already at capacity; otherwise record() would retain one too many.
    while (this.#sessions.size >= MAX_SESSIONS) {
      let oldestId: string | undefined
      let oldestAt = Number.POSITIVE_INFINITY
      for (const [sessionId, session] of this.#sessions) {
        if (session.startedAt < oldestAt) {
          oldestAt = session.startedAt
          oldestId = sessionId
        }
      }
      if (!oldestId) return
      this.#sessions.delete(oldestId)
    }
  }
}
