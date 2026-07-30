import { cn } from "@/lib/utils"

export type GaugeTone = "primary" | "warning" | "danger" | "neutral"

interface GaugeProps {
  /** Fraction between 0 and 1. Values outside the range are clamped. */
  value: number
  /** Large text in the middle of the ring. */
  label: string
  /** Small uppercase caption under the label. */
  caption?: string
  tone?: GaugeTone
  size?: number
  thickness?: number
  /** Portion of the circle the arc covers, 1 = full ring, 0.75 = three quarters. */
  sweep?: number
  className?: string
  /** Announced to screen readers in place of the visual label. */
  ariaLabel?: string
}

export function Gauge({
  value,
  label,
  caption,
  tone = "primary",
  size = 78,
  thickness = 7,
  sweep = 0.78,
  className,
  ariaLabel,
}: GaugeProps) {
  const fraction = Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : 0
  const radius = (size - thickness) / 2
  const circumference = 2 * Math.PI * radius
  const arc = circumference * sweep
  // Centre the drawn arc at the top so the gap sits symmetrically at the bottom.
  const rotation = 270 - sweep * 180

  return (
    <div
      className={cn("gauge", className)}
      data-tone={tone === "primary" ? undefined : tone}
      style={{ width: size, height: size }}
      role="img"
      aria-label={ariaLabel ?? `${label}${caption ? ` ${caption}` : ""}`}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ transform: `rotate(${rotation}deg)` }}>
        <circle
          className="gauge-track"
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={thickness}
          strokeLinecap="round"
          strokeDasharray={`${arc} ${circumference - arc}`}
        />
        <circle
          className="gauge-value"
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={thickness}
          strokeLinecap="round"
          strokeDasharray={`${arc * fraction} ${circumference - arc * fraction}`}
        />
      </svg>
      <div className="gauge-label" aria-hidden="true">
        <strong>{label}</strong>
        {caption ? <span>{caption}</span> : null}
      </div>
    </div>
  )
}
