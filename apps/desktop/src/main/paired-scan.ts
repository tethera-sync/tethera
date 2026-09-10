import { isScanCancelled, parsePeerManifest, type FileManifest } from "./folder-manifest"

/**
 * Runs a local scan and its paired peer request concurrently with sibling
 * cancellation: if either side fails, the other is aborted at its next
 * cooperative checkpoint instead of scanning to natural completion.
 * Cancellation is never reported as successful completion; callers rethrow.
 */
export async function runPairedScans(
  runLocal: (signal: AbortSignal) => Promise<FileManifest>,
  runPeer: (signal: AbortSignal) => Promise<unknown>,
): Promise<{ local: FileManifest; peer: FileManifest }> {
  const localController = new AbortController()
  const peerController = new AbortController()
  const localPromise = runLocal(localController.signal)
  const peerPromise = (async (): Promise<FileManifest> => {
    const raw = await runPeer(peerController.signal)
    return parsePeerManifest(raw)
  })()
  try {
    const [local, peer] = await Promise.all([localPromise, peerPromise])
    return { local, peer }
  } catch (error) {
    // Stop the surviving sibling; its abort escapes per-file catch blocks and
    // surfaces as cancellation rather than an unreadable-file count.
    if (!localController.signal.aborted) localController.abort()
    if (!peerController.signal.aborted) peerController.abort()
    throw error
  }
}

export function throwIfPairedCancelled(error: unknown): void {
  if (isScanCancelled(error)) throw error
}
