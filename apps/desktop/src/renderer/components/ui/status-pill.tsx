import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

export type Tone = "success" | "warning" | "danger" | "info" | "neutral"

const toneStyles: Record<Tone, string> = {
  success: "[color:var(--success)] [background:color-mix(in_oklab,var(--success)_12%,transparent)]",
  warning: "[color:var(--warning)] [background:color-mix(in_oklab,var(--warning)_12%,transparent)]",
  danger: "[color:var(--danger)] [background:color-mix(in_oklab,var(--danger)_12%,transparent)]",
  info: "[color:var(--info)] [background:color-mix(in_oklab,var(--info)_12%,transparent)]",
  neutral: "[color:var(--muted-foreground)] [background:color-mix(in_oklab,var(--muted-foreground)_12%,transparent)]",
}

interface StatusPillProps {
  tone?: Tone
  children: ReactNode
  /** Drop the tinted background and render the dot inline with surrounding text. */
  bare?: boolean
  /** Animate the dot, for states that are actively in progress. */
  pulse?: boolean
  className?: string
}

export function StatusPill({ tone = "neutral", children, bare = false, pulse = false, className }: StatusPillProps) {
  return (
    <span className={cn("status-pill [display:inline-flex] [align-items:center] [gap:6px] [border-radius:var(--radius-pill)] [padding:3px_9px_3px_7px] [font-size:10.5px] [font-weight:600] [line-height:1.45] [white-space:nowrap] [&_i]:[width:6px] [&_i]:[height:6px] [&_i]:[flex:0_0_auto] [&_i]:[border-radius:999px] [&_i]:[background:currentColor] [&_i]:[box-shadow:0_0_0_3px_color-mix(in_oklab,_currentColor_22%,_transparent)] [&[data-bare='true']]:[padding:0] [&[data-bare='true']]:[background:none]", toneStyles[tone], pulse && "[&_i]:animate-pulse", className)} data-bare={bare || undefined}>
      <i aria-hidden="true" />
      {children}
    </span>
  )
}
