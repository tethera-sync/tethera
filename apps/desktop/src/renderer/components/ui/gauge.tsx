import type { CSSProperties } from "react"
import { clamp01, cn } from "@/lib/utils"

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
  const fraction = clamp01(value)
  const radius = (size - thickness) / 2
  const circumference = 2 * Math.PI * radius
  const arc = circumference * sweep
  // Centre the drawn arc at the top so the gap sits symmetrically at the bottom.
  const rotation = 270 - sweep * 180

  return (
    <div
      className={cn("gauge [position:relative] [display:grid] [width:var(--gauge-size)] [height:var(--gauge-size)] [flex:0_0_auto] [place-items:center] [&_svg]:[overflow:visible] [&[data-tone='warning']_.gauge-value]:[stroke:var(--warning)] [&[data-tone='danger']_.gauge-value]:[stroke:var(--danger)] [&[data-tone='neutral']_.gauge-value]:[stroke:color-mix(in_oklab,_var(--muted-foreground)_60%,_transparent)]", className)}
      data-tone={tone === "primary" ? undefined : tone}
      style={{ "--gauge-size": `${size}px`, "--gauge-rotation": `${rotation}deg` } as CSSProperties}
      role="img"
      aria-label={ariaLabel ?? `${label}${caption ? ` ${caption}` : ""}`}
    >
      <svg className="[transform:rotate(var(--gauge-rotation))]" width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle
          className="gauge-track [stroke:var(--chart-track)]"
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={thickness}
          strokeLinecap="round"
          strokeDasharray={`${arc} ${circumference - arc}`}
        />
        <circle
          className="gauge-value [stroke:var(--chart-1)] [transition:stroke-dasharray_620ms_cubic-bezier(0.32,_0.72,_0,_1)]"
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={thickness}
          strokeLinecap="round"
          strokeDasharray={`${arc * fraction} ${circumference - arc * fraction}`}
        />
      </svg>
      <div className="gauge-label [position:absolute] [display:grid] [place-items:center] [text-align:center] [&_strong]:[font-size:17px] [&_strong]:[font-weight:660] [&_strong]:[letter-spacing:-0.03em] [&_strong]:[font-variant-numeric:tabular-nums] [&_span]:[margin-top:1px] [&_span]:[color:var(--muted-foreground)] [&_span]:[font-size:8.5px] [&_span]:[font-weight:600] [&_span]:[letter-spacing:0.05em] [&_span]:[text-transform:uppercase]" aria-hidden="true">
        <strong>{label}</strong>
        {caption ? <span>{caption}</span> : null}
      </div>
    </div>
  )
}
