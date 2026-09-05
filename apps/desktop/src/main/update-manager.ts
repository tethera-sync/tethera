import type { UpdateState } from "../shared/contracts"

/** Re-check every six hours so long-lived sessions do not go stale. */
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
/** Delay the first packaged check so the window can paint and Squirrel can release its first-run lock. */
export const UPDATE_STARTUP_DELAY_MS = 10_000
/** Minimum percent delta or elapsed time before another download-progress snapshot is broadcast. */
export const UPDATE_PROGRESS_THROTTLE_MS = 750
export const UPDATE_PROGRESS_MIN_DELTA = 1

/**
 * electron-updater reports release notes as a string, an array of
 * `{ version, note }` entries, or null. Normalise to a short plain-text
 * snippet the renderer can show without rendering arbitrary HTML.
 */
export function normalizeReleaseNotes(notes: unknown): string | undefined {
  if (typeof notes === "string") {
    const trimmed = notes.trim().slice(0, 2000)
    return trimmed ? trimmed : undefined
  }
  if (Array.isArray(notes)) {
    const parts: string[] = []
    for (const entry of notes) {
      if (typeof entry === "string") {
        if (entry.trim()) parts.push(entry.trim())
        continue
      }
      if (entry !== null && typeof entry === "object" && "note" in entry) {
        const note = (entry as { note?: unknown }).note
        if (typeof note === "string" && note.trim()) parts.push(note.trim())
      }
      if (parts.join("\n").length >= 2000) break
    }
    const joined = parts.join("\n\n").slice(0, 2000).trim()
    return joined ? joined : undefined
  }
  return undefined
}

/** Turn any updater failure into a short human-readable sentence. No paths, URLs, or stack traces. */
export function formatUpdateError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    const message = error.message.trim()
    if (/ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|network|offline/i.test(message)) {
      return "Couldn't reach the update server. Check your connection — we'll retry automatically."
    }
  }
  return "The update check failed. We'll retry automatically."
}

/** An update already staged for install must survive later feed errors. */
export function shouldPreserveDownloadedOnError(current: UpdateState): boolean {
  return current.status === "downloaded"
}

/** `true` while a check or download is in flight; used to disable duplicate actions. */
export function isUpdateBusy(state: UpdateState): boolean {
  return state.status === "checking" || state.status === "downloading"
}

/** Downloads may only start from a confirmed `available` state. */
export function canDownloadUpdate(state: UpdateState): boolean {
  return state.status === "available"
}

/** Claim an available update before awaiting electron-updater so other actions see the download as active. */
export function beginUpdateDownload(
  state: UpdateState,
): Extract<UpdateState, { status: "downloading" }> | undefined {
  if (state.status !== "available") return undefined
  return {
    status: "downloading",
    version: state.version,
    progressPercent: 0,
    currentVersion: state.currentVersion,
    lastCheckedAt: state.lastCheckedAt,
  }
}

/** Installs may only run once the installer has been verified on disk. */
export function canInstallUpdate(state: UpdateState): boolean {
  return state.status === "downloaded"
}

/**
 * download-progress fires many times per second. Broadcast only when the
 * rounded percent moved or the throttle window elapsed, so the renderer and
 * tray are not re-rendered on every chunk.
 */
export function shouldBroadcastProgress(
  lastPercent: number | null,
  lastAt: number | null,
  nextPercent: number,
  now: number,
): boolean {
  if (lastPercent === null || lastAt === null) return true
  if (Math.abs(nextPercent - lastPercent) >= UPDATE_PROGRESS_MIN_DELTA) return true
  return now - lastAt >= UPDATE_PROGRESS_THROTTLE_MS
}

export function clampProgressPercent(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number.NaN
  if (!Number.isFinite(numeric)) return 0
  return Math.min(Math.max(Math.round(numeric), 0), 100)
}

export function toOptionalFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined
  return value
}

export function nowIso(): string {
  return new Date().toISOString()
}
