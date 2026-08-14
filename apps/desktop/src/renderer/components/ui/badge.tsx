import { cva, type VariantProps } from "class-variance-authority"
import type * as React from "react"
import { cn } from "@/lib/utils"

const badgeVariants = cva("badge [display:inline-flex] [align-items:center] [gap:6px] [border:1px_solid_transparent] [border-radius:var(--radius-pill)] [padding:3px_9px] [font-size:10.5px] [font-weight:620] [line-height:1.5] [white-space:nowrap] [&_svg]:[width:12px] [&_svg]:[height:12px] [&_svg]:[flex:0_0_auto]", {
  variants: {
    variant: {
      neutral: "badge-neutral [border-color:var(--border)] [background:var(--secondary)] [color:var(--secondary-foreground)]",
      success: "badge-success [border-color:color-mix(in_oklab,_var(--success)_26%,_transparent)] [background:color-mix(in_oklab,_var(--success)_13%,_transparent)] [color:var(--success)]",
      warning: "badge-warning [border-color:color-mix(in_oklab,_var(--warning)_26%,_transparent)] [background:color-mix(in_oklab,_var(--warning)_13%,_transparent)] [color:var(--warning)]",
      danger: "badge-danger [border-color:color-mix(in_oklab,_var(--danger)_26%,_transparent)] [background:color-mix(in_oklab,_var(--danger)_13%,_transparent)] [color:var(--danger)]",
      info: "badge-info [border-color:color-mix(in_oklab,_var(--info)_26%,_transparent)] [background:color-mix(in_oklab,_var(--info)_13%,_transparent)] [color:var(--info)]",
    },
  },
  defaultVariants: { variant: "neutral" },
})

type BadgeProps = React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>

function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />
}

export { Badge }
