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
  const canonical = (preview: FolderMappingPreview) => [
    preview.localFiles, preview.remoteFiles, preview.identicalFiles, preview.differentFiles,
    preview.localOnlyFiles, preview.remoteOnlyFiles, preview.ignoredLocal, preview.ignoredRemote,
    preview.bytesToRemote, preview.bytesToLocal, preview.truncated,
    [...preview.invalidWindowsNames].sort(), [...preview.caseCollisions].sort(),
    [...preview.samples].sort((a, b) => a.category.localeCompare(b.category) || a.path.localeCompare(b.path) || (a.size ?? 0) - (b.size ?? 0))
      .map((sample) => [sample.category, sample.path, sample.size ?? null]),
  ]
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right)) &&
    scanIssuesEqual(left.unreadableLocal, right.unreadableLocal, left.unreadableLocalCount, right.unreadableLocalCount) &&
    scanIssuesEqual(left.unreadableRemote, right.unreadableRemote, left.unreadableRemoteCount, right.unreadableRemoteCount)
}

function scanIssuesEqual(left: FolderScanIssue[] | undefined, right: FolderScanIssue[] | undefined, leftCount: number | undefined, rightCount: number | undefined): boolean {
  const leftTotal = leftCount ?? left?.length
  const rightTotal = rightCount ?? right?.length
  if (leftTotal !== undefined && rightTotal !== undefined && leftTotal !== rightTotal) return false
  // Legacy omissions only relax the missing side; known counts/details still matter.
  if (left === undefined || right === undefined) return true
  const canonical = (issues: FolderScanIssue[]) => [...issues]
    .sort((a, b) => a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind) || a.reason.localeCompare(b.reason))
    .map((issue) => [issue.path, issue.kind, issue.reason])
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right))
}
