import { open, mkdir, rename } from "node:fs/promises"
import { randomBytes } from "node:crypto"
import path from "node:path"
import type { SyncMode } from "../shared/contracts"
import type { FileManifest, FileManifestEntry } from "./folder-manifest"
import { resolveWithinRoot } from "./path-safety"

/**
 * A file this size base64-encodes to roughly 10.7 MB, staying safely under the
 * 16 MiB per-line guard the peer session transport enforces on every request
 * and response. Larger files are skipped until chunked transfer exists.
 */
export const MAX_TRANSFER_FILE_BYTES = 8 * 1024 * 1024

export interface SyncSkip {
  path: string
  reason: string
}

export interface SyncPlan {
  toPull: FileManifestEntry[]
  skipped: SyncSkip[]
}

/**
 * Only ever pulls: files that exist on the remote side but not locally are
 * copied down. Files that exist on both sides but differ are left alone
 * (skipped, with a reason) rather than guessing a winner — that needs a
 * revision model this codebase doesn't have yet. Local-only files are copied
 * when the *other* device runs its own initial sync and pulls them from here.
 */
export function computeSyncPlan(local: FileManifest, remote: FileManifest, mode: SyncMode): SyncPlan {
  if (mode === "send-only") return { toPull: [], skipped: [] }

  const localByPath = new Map(local.files.map((entry) => [entry.path, entry]))
  const toPull: FileManifestEntry[] = []
  const skipped: SyncSkip[] = []

  for (const remoteEntry of remote.files) {
    const localEntry = localByPath.get(remoteEntry.path)
    if (!localEntry) {
      if (remoteEntry.size > MAX_TRANSFER_FILE_BYTES) {
        skipped.push({ path: remoteEntry.path, reason: "Larger than the 8 MiB initial-sync limit." })
      } else {
        toPull.push(remoteEntry)
      }
      continue
    }

    const digestMatch = Boolean(localEntry.digest && remoteEntry.digest && localEntry.digest === remoteEntry.digest)
    const metadataMatch =
      !localEntry.digest &&
      !remoteEntry.digest &&
      localEntry.size === remoteEntry.size &&
      Math.abs(localEntry.modifiedMs - remoteEntry.modifiedMs) <= 2_000
    if (digestMatch || metadataMatch) continue

    skipped.push({
      path: remoteEntry.path,
      reason: "Exists on both computers with different content; skipped until conflict resolution is available.",
    })
  }

  return { toPull, skipped }
}

/** Writes to a temp file beside the destination, fsyncs, then renames into place so a partial transfer never appears at the final path. */
export async function writeFileAtomic(rootPath: string, relativePath: string, content: Buffer): Promise<void> {
  const destination = resolveWithinRoot(rootPath, relativePath)
  await mkdir(path.dirname(destination), { recursive: true })
  const tempPath = `${destination}.tethera-tmp-${randomBytes(6).toString("hex")}`
  const handle = await open(tempPath, "w")
  try {
    await handle.writeFile(content)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(tempPath, destination)
}
