import { z } from "zod"
import type { PeerRequest, PeerRequestOptions } from "./peer-session-service"

export interface CapabilityPeerClient {
  request(deviceId: string, request: PeerRequest, timeoutMs?: number, options?: PeerRequestOptions): Promise<unknown>
}

const capabilitiesSchema = z.object({ capabilities: z.array(z.string().max(100)).max(32) })

/**
 * Asks a peer which optional protocol features it supports. Older version-4
 * peers predate capability discovery, and only their exact unsupported-operation
 * response means "no optional features": a malformed answer or a transport
 * failure is an error, never a silent downgrade.
 */
export async function requestPeerCapabilities(
  client: CapabilityPeerClient,
  peerId: string,
  signal?: AbortSignal | null,
): Promise<ReadonlySet<string>> {
  try {
    const response = await client.request(peerId, { type: "scan-capabilities" }, undefined, { signal })
    const parsed = capabilitiesSchema.safeParse(response)
    if (!parsed.success) throw new Error("The other computer returned invalid scan capabilities. Update Tethera on both computers and retry.")
    return new Set(parsed.data.capabilities)
  } catch (error) {
    if (error instanceof Error && error.message === "This secure peer request is not supported.") return new Set()
    throw error
  }
}
