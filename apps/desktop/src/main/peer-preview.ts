import { ScanCancelledError, parsePeerManifest, type FileManifest } from "./folder-manifest"
import { requestPeerCapabilities, type CapabilityPeerClient } from "./peer-capabilities"
import { PEER_SCAN_PROGRESS_CAPABILITY, type PeerScanProgress } from "./peer-scan-progress"
import { CHUNKED_FRAMES_CAPABILITY, NO_PEER_RESPONSE_DEADLINE } from "./peer-session-service"
import { DIRECTORY_MAPPING_CAPABILITY } from "../shared/directory-mapping"

/** Negotiate progress and chunked frames before sending a multi-response request to an older app. */
export async function requestPeerPreview(
  client: CapabilityPeerClient,
  peer: { id: string; name: string },
  input: { path: string; ignorePatterns: string[] },
  signal: AbortSignal,
  onProgress: (progress: PeerScanProgress) => void,
): Promise<FileManifest> {
  let scanRequested = false
  try {
    const capabilities = await requestPeerCapabilities(client, peer.id, signal)
    const supportsProgress = capabilities.has(PEER_SCAN_PROGRESS_CAPABILITY)
    const chunked = capabilities.has(CHUNKED_FRAMES_CAPABILITY)
    scanRequested = true
    // A scan runs as long as the folder needs; cancelling the comparison or
    // losing the connection ends it.
    const manifest = await client.request(peer.id, {
      type: "scan-manifest",
      ...input,
      ...(capabilities.has(DIRECTORY_MAPPING_CAPABILITY) ? { includeDirectories: true } : {}),
      ...(supportsProgress ? { reportProgress: true } : {}),
    }, NO_PEER_RESPONSE_DEADLINE, { signal, ...(supportsProgress ? { onProgress } : {}), ...(chunked ? { chunked: true } : {}) })
    if (signal.aborted) throw new ScanCancelledError()
    const parsed = parsePeerManifest(manifest)
    return capabilities.has(DIRECTORY_MAPPING_CAPABILITY) ? parsed : { ...parsed, directories: undefined }
  } catch (error) {
    if (signal.aborted) throw new ScanCancelledError("The folder comparison was cancelled.")
    const code = error instanceof Error && "code" in error ? error.code : undefined
    if (code === "PEER_RESPONSE_TIMEOUT" && !scanRequested) {
      throw new Error(`${peer.name} did not answer the scan-support check. Check that Tethera is running on that computer, then retry.`)
    }
    if (code === "PEER_HANDSHAKE_TIMEOUT") {
      throw new Error(`${peer.name} did not answer the secure connection request. Check that Tethera is running on that computer, then retry.`)
    }
    throw error
  }
}
