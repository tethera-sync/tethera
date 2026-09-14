import type { ConnectionRoute, FolderSummary, OverallStatus } from "@shared/contracts"
import type { Tone } from "@/components/ui/status-pill"
import { formatBytes } from "@shared/byte-format"

export { formatBytes }

export function formatRelative(iso: string): string {
  const difference = Date.now() - new Date(iso).getTime()
  const minutes = Math.floor(difference / 60_000)
  if (minutes < 1) return "Just now"
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

export function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(iso))
}

/** Title-cases a kebab-case status for display. */
export function pretty(value: string): string {
  return value.replaceAll("-", " ").replace(/^./, (character) => character.toUpperCase())
}

/** User-facing sync direction. */
export function prettyMode(value: FolderSummary["mode"]): string {
  if (value === "two-way") return "Two-way sync"
  if (value === "send-only") return "Send only"
  return "Receive only"
}

/** User-facing connection route. */
export function prettyRoute(route: ConnectionRoute): string {
  if (route === "lan-direct") return "LAN direct"
  if (route === "tailscale-direct") return "Tailscale direct"
  if (route === "tailscale-relay") return "Tailscale relay"
  return pretty(route)
}

/** User-facing platform name. */
export function prettyPlatform(platform?: "linux" | "windows" | "unknown"): string {
  if (platform === "linux") return "Linux"
  if (platform === "windows") return "Windows 11"
  return "Unknown platform"
}

/** Status pill tone for an overall folder status. */
export function statusTone(status: OverallStatus): Tone {
  if (status === "needs-attention") return "danger"
  if (status === "paused") return "warning"
  if (status === "offline") return "neutral"
  if (status === "syncing") return "info"
  return "success"
}

/** Per-second transfer rate. */
export function formatRate(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`
}
