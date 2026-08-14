import { type CSSProperties, useId } from "react"
import { cn } from "@/lib/utils"

interface SparklineProps {
  /** Sampled values, oldest first. Fewer than two points renders nothing. */
  points: number[]
  height?: number
  className?: string
  /** Draw the gradient area under the line. */
  filled?: boolean
}

const VIEWBOX_WIDTH = 600

export function Sparkline({ points, height = 108, className, filled = true }: SparklineProps) {
  const gradientId = useId()

  if (points.length < 2) return null

  const max = Math.max(...points, 1)
  const min = Math.min(...points, 0)
  const range = max - min || 1
  const step = VIEWBOX_WIDTH / (points.length - 1)
  const padding = 4

  const coordinates = points.map((point, index) => {
    const x = index * step
    const y = padding + (1 - (point - min) / range) * (height - padding * 2)
    return [x, y] as const
  })

  const line = coordinates.reduce((path, [x, y], index) => {
    if (index === 0) return `M ${x.toFixed(2)} ${y.toFixed(2)}`
    const [previousX, previousY] = coordinates[index - 1]
    const controlX = (previousX + x) / 2
    return `${path} C ${controlX.toFixed(2)} ${previousY.toFixed(2)}, ${controlX.toFixed(2)} ${y.toFixed(2)}, ${x.toFixed(2)} ${y.toFixed(2)}`
  }, "")

  const area = `${line} L ${VIEWBOX_WIDTH} ${height} L 0 ${height} Z`

  return (
    <svg
      className={cn("sparkline [display:block] [width:100%] [height:var(--sparkline-height)] [overflow:visible]", className)}
      viewBox={`0 0 ${VIEWBOX_WIDTH} ${height}`}
      preserveAspectRatio="none"
      style={{ "--sparkline-height": `${height}px` } as CSSProperties}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--chart-2)" stopOpacity="0.42" />
          <stop offset="100%" stopColor="var(--chart-2)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {filled ? <path d={area} fill={`url(#${gradientId})`} /> : null}
      <path className="sparkline-line [fill:none] [stroke:var(--chart-2)] [stroke-width:1.75] [stroke-linecap:round] [stroke-linejoin:round] [vector-effect:non-scaling-stroke]" d={line} />
    </svg>
  )
}
