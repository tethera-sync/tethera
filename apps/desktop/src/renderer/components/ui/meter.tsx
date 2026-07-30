import { cn } from "@/lib/utils"

interface MeterProps {
  label: string
  /** Right-aligned readout. Falls back to a percentage of `value`. */
  readout?: string
  /** Fraction between 0 and 1. Values outside the range are clamped. */
  value: number
  tone?: "primary" | "warning" | "danger" | "neutral"
  className?: string
}

export function Meter({ label, readout, value, tone = "primary", className }: MeterProps) {
  const fraction = Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : 0
  const percentage = Math.round(fraction * 100)

  return (
    <div className={cn("meter", className)}>
      <div className="meter-head">
        <span>{label}</span>
        <strong>{readout ?? `${percentage}%`}</strong>
      </div>
      <div
        className="meter-track"
        role="progressbar"
        aria-label={label}
        aria-valuenow={percentage}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={readout}
      >
        <div
          className="meter-fill"
          data-tone={tone === "primary" ? undefined : tone}
          style={{ width: `${Math.max(percentage, fraction > 0 ? 2 : 0)}%` }}
        />
      </div>
    </div>
  )
}
