import { isScanCancelled } from "./folder-manifest"

/**
 * Runs local work and its paired peer request concurrently with sibling
 * cancellation: if either side fails, the other is aborted at its next
 * cooperative checkpoint instead of running to natural completion.
 * Cancellation is never reported as successful completion; callers rethrow.
 * Each side returns its own validated result, so nothing is parsed twice.
 */
export async function runPairedScans<Local, Peer>(
  runLocal: (signal: AbortSignal) => Promise<Local>,
  runPeer: (signal: AbortSignal) => Promise<Peer>,
): Promise<{ local: Local; peer: Peer }> {
  const localController = new AbortController()
  const peerController = new AbortController()
  // Async wrappers turn a synchronous throw into a rejection, so a failure on
  // one side can never escape before the other side is aborted.
  const localPromise = (async () => runLocal(localController.signal))()
  const peerPromise = (async () => runPeer(peerController.signal))()
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
