import { z } from "zod"
import { ScanCancelledError, parsePeerManifest, type FileManifest } from "./folder-manifest"
import type { PeerRequest, PeerRequestOptions } from "./peer-session-service"
import { PEER_SCAN_IDLE_TIMEOUT_MS, PEER_SCAN_PROGRESS_CAPABILITY, type PeerScanProgress } from "./peer-scan-progress"

interface PreviewPeerClient {
  request(deviceId: string, request: PeerRequest, timeoutMs?: number, options?: PeerRequestOptions): Promise<unknown>
}

const capabilitiesSchema = z.object({ capabilities: z.array(z.string().max(100)).max(32) })

/** Negotiate progress before sending a multi-response request to an older app. */
export async function requestPeerPreview(
  client: PreviewPeerClient,
  peer: { id: string; name: string },
  input: { path: string; ignorePatterns: string[] },
  signal: AbortSignal,
  onProgress: (progress: PeerScanProgress) => void,
): Promise<FileManifest> {
  let supportsProgress = false
  let scanRequested = false
  try {
    try {
      const response = await client.request(peer.id, { type: "scan-capabilities" }, undefined, { signal })
      const parsed = capabilitiesSchema.safeParse(response)
      if (!parsed.success) throw new Error("The other computer returned invalid scan capabilities. Update Tethera on both computers and retry.")
      supportsProgress = parsed.data.capabilities.includes(PEER_SCAN_PROGRESS_CAPABILITY)
    } catch (error) {
      // Older version-4 peers predate capability discovery. Only their exact
      // unsupported-operation response permits downgrade; transport failures do not.
      if (!(error instanceof Error) || error.message !== "This secure peer request is not supported.") throw error
    }
    scanRequested = true
    const manifest = await client.request(peer.id, {
      type: "scan-manifest",
      ...input,
      ...(supportsProgress ? { reportProgress: true } : {}),
    }, PEER_SCAN_IDLE_TIMEOUT_MS, { signal, ...(supportsProgress ? { onProgress } : {}) })
    if (signal.aborted) throw new ScanCancelledError()
    return parsePeerManifest(manifest)
  } catch (error) {
    if (signal.aborted) throw new ScanCancelledError("The folder comparison was cancelled.")
    const code = error instanceof Error && "code" in error ? error.code : undefined
    if (code === "PEER_RESPONSE_TIMEOUT" || code === "PEER_SCAN_IDLE_TIMEOUT") {
      if (!scanRequested) throw new Error(`${peer.name} did not answer the scan-support check. Check that Tethera is running on that computer, then retry.`)
      throw new Error(supportsProgress
        ? `${peer.name} stopped reporting scan progress. Check that Tethera is open and the folder is accessible on that computer, then retry.`
        : `${peer.name} did not finish scanning within five minutes. Update Tethera on both computers for progress-aware comparisons, or compare a smaller folder.`)
    }
    if (code === "PEER_SCAN_DEADLINE") {
      throw new Error(`The scan on ${peer.name} reached the 30-minute limit. Compare smaller folders or exclude generated files, then retry.`)
    }
    if (code === "PEER_HANDSHAKE_TIMEOUT") {
      throw new Error(`${peer.name} did not answer the secure connection request. Check that Tethera is running on that computer, then retry.`)
    }
    throw error
  }
}
