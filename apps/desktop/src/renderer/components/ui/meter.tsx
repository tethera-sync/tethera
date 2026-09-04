import type { CSSProperties } from "react"
import { clamp01, cn } from "@/lib/utils"

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
  const fraction = clamp01(value)
  const percentage = Math.round(fraction * 100)

  return (
    <div className={cn("meter [display:grid] [gap:6px]", className)}>
      <div className="meter-head [display:flex] [align-items:baseline] [justify-content:space-between] [gap:10px] [&_span]:[color:var(--muted-foreground)] [&_span]:[font-size:10.5px] [&_span]:[font-weight:550] [&_strong]:[font-size:11.5px] [&_strong]:[font-weight:650] [&_strong]:[font-variant-numeric:tabular-nums]">
        <span>{label}</span>
        <strong>{readout ?? `${percentage}%`}</strong>
      </div>
      <div
        className="meter-track [position:relative] [height:5px] [overflow:hidden] [border-radius:999px] [background:var(--chart-track)]"
        role="progressbar"
        aria-label={label}
        aria-valuenow={percentage}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={readout}
      >
        <div
          className="meter-fill [height:100%] [width:var(--meter-width)] [border-radius:999px] [background:linear-gradient(90deg,_color-mix(in_oklab,_var(--chart-1)_55%,_transparent),_var(--chart-1))] [transition:width_420ms_cubic-bezier(0.32,_0.72,_0,_1)] [&[data-tone='warning']]:[background:linear-gradient(90deg,_color-mix(in_oklab,_var(--warning)_55%,_transparent),_var(--warning))] [&[data-tone='danger']]:[background:linear-gradient(90deg,_color-mix(in_oklab,_var(--danger)_55%,_transparent),_var(--danger))] [&[data-tone='neutral']]:[background:color-mix(in_oklab,_var(--muted-foreground)_45%,_transparent)]"
          data-tone={tone === "primary" ? undefined : tone}
          style={{ "--meter-width": `${Math.max(percentage, fraction > 0 ? 2 : 0)}%` } as CSSProperties}
        />
      </div>
    </div>
  )
}
