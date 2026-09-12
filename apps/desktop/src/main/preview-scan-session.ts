import type { FolderMappingPreview, FolderScanIssue, SyncMode } from "../shared/contracts"

const SESSION_TTL_MS = 10 * 60_000
const MAX_SESSIONS = 8
const MAX_SUMMARY_BYTES = 2 * 1024 * 1024

export interface PreviewScanKeyInput {
  localPath: string
  remotePath: string
  peerId: string
  localPlatform: string
  remotePlatform: string
  ignorePatterns: string[]
  mode: SyncMode
  maxFiles: number | null
  direction: "outgoing" | "incoming"
}

/** Includes comparison orientation and every locally known scan/comparison input. */
export function previewScanKey(input: PreviewScanKeyInput): string {
  return JSON.stringify([
    input.direction, input.peerId, input.localPath, input.remotePath,
    input.localPlatform, input.remotePlatform, input.ignorePatterns, input.mode, input.maxFiles,
  ])
}

/**
 * Retain only the bounded comparison the user reviewed, never full manifests.
 * One completed comparison per operation makes reuse independent of folder size
 * and prevents mixing halves of different or cancelled scans. Consent/merge
 * freshness checks still run at their existing boundaries.
 */
export class PreviewScanSessions {
  readonly #sessions = new Map<string, { recordedAt: number; key: string; preview: FolderMappingPreview }>()

  constructor(private readonly now: () => number = Date.now) {}

  record(sessionId: string, key: string, preview: FolderMappingPreview): void {
    this.drop(sessionId)
    this.#prune()
    if (Buffer.byteLength(JSON.stringify(preview), "utf8") > MAX_SUMMARY_BYTES) return
    while (this.#sessions.size >= MAX_SESSIONS) {
      const oldestId = this.#sessions.keys().next().value
      if (oldestId === undefined) break
      this.drop(oldestId)
    }
    this.#sessions.set(sessionId, { recordedAt: this.now(), key, preview: structuredClone(preview) })
  }

  lookup(sessionId: string, key: string): FolderMappingPreview | undefined {
    this.#prune()
    const session = this.#sessions.get(sessionId)
    return session?.key === key ? structuredClone(session.preview) : undefined
  }

  drop(sessionId: string): void {
    this.#sessions.delete(sessionId)
  }

  #prune(): void {
    for (const [sessionId, session] of this.#sessions) {
      if (this.now() - session.recordedAt >= SESSION_TTL_MS) this.drop(sessionId)
    }
  }
}

export function previewsEqual(left: FolderMappingPreview, right: FolderMappingPreview): boolean {
  // The bounded issue lists are additive detail added after the original
  // contract. A preview from an older peer lacks them, so comparing them
  // would report a change that did not happen; the original counts still
  // have to match exactly.
  const canonical = (preview: FolderMappingPreview) => {
    const {
      unreadableLocal: _unreadableLocal,
      unreadableRemote: _unreadableRemote,
      unreadableLocalCount: _unreadableLocalCount,
      unreadableRemoteCount: _unreadableRemoteCount,
      ...rest
    } = preview
    return {
      ...rest,
      invalidWindowsNames: [...preview.invalidWindowsNames].sort(),
      caseCollisions: [...preview.caseCollisions].sort(),
      samples: [...preview.samples].sort((a, b) => `${a.category}:${a.path}`.localeCompare(`${b.category}:${b.path}`)),
    }
  }
  if (JSON.stringify(canonical(left)) !== JSON.stringify(canonical(right))) return false
  // Old peers omit these fields. When both scans supply details, a new
  // inaccessible path must be reviewed even if the aggregate counts match.
  if (left.unreadableLocal === undefined || right.unreadableLocal === undefined ||
      left.unreadableRemote === undefined || right.unreadableRemote === undefined) return true
  const issues = (preview: FolderMappingPreview) => ({
    local: [...(preview.unreadableLocal ?? [])].sort(compareIssues),
    remote: [...(preview.unreadableRemote ?? [])].sort(compareIssues),
    localCount: preview.unreadableLocalCount ?? preview.unreadableLocal?.length ?? 0,
    remoteCount: preview.unreadableRemoteCount ?? preview.unreadableRemote?.length ?? 0,
  })
  return JSON.stringify(issues(left)) === JSON.stringify(issues(right))
}

function compareIssues(left: FolderScanIssue, right: FolderScanIssue): number {
  return left.path.localeCompare(right.path) || left.kind.localeCompare(right.kind) || left.reason.localeCompare(right.reason)
}
