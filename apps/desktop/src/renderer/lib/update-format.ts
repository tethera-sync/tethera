const BYTE_UNITS = ["B", "KB", "MB", "GB"] as const

/** Format a byte count as a short human string. Unknown values become undefined so callers can omit them. */
export function formatBytes(bytes: number | undefined): string | undefined {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return undefined
  if (bytes < 1024) return `${Math.round(bytes)} B`
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 100 ? Math.round(value).toString() : value.toFixed(1)} ${BYTE_UNITS[unit]}`
}

export function formatUpdateSpeed(bytesPerSecond: number | undefined): string | undefined {
  const formatted = formatBytes(bytesPerSecond)
  return formatted ? `${formatted}/s` : undefined
}

/** Short relative label for `lastCheckedAt` ("just now", "12 min ago", …). Falls back to a locale date. */
export function formatLastChecked(iso: string | undefined, now: number = Date.now()): string | undefined {
  if (!iso) return undefined
  const parsed = Date.parse(iso)
  if (Number.isNaN(parsed)) return undefined
  const diffMs = now - parsed
  if (diffMs < 0) return "just now"
  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hr ago`
  try {
    return new Date(parsed).toLocaleDateString(undefined, { month: "short", day: "numeric" })
  } catch {
    return undefined
  }
}

export interface DownloadReadout {
  percent: number
  transferred?: string
  total?: string
  speed?: string
}

/** Build the "42% · 18.2 MB of 96.4 MB · 2.1 MB/s" readout, omitting unknown parts. */
export function downloadReadout(input: {
  progressPercent: number
  transferredBytes?: number
  totalBytes?: number
  bytesPerSecond?: number
}): string {
  const percent = Number.isFinite(input.progressPercent)
    ? Math.min(Math.max(Math.round(input.progressPercent), 0), 100)
    : 0
  const parts = [`${percent}%`]
  const transferred = formatBytes(input.transferredBytes)
  const total = formatBytes(input.totalBytes)
  if (transferred && total) parts.push(`${transferred} of ${total}`)
  else if (total) parts.push(`of ${total}`)
  const speed = formatUpdateSpeed(input.bytesPerSecond)
  if (speed) parts.push(speed)
  return parts.join(" · ")
}
