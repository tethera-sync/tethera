import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

export type Tone = "success" | "warning" | "danger" | "info" | "neutral"

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
    <span className={cn("status-pill", `tone-${tone}`, pulse && "pulse", className)} data-bare={bare || undefined}>
      <i aria-hidden="true" />
      {children}
    </span>
  )
}
