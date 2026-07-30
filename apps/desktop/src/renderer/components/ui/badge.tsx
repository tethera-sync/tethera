import { cva, type VariantProps } from "class-variance-authority"
import type * as React from "react"
import { cn } from "@/lib/utils"

const badgeVariants = cva("badge", {
  variants: {
    variant: {
      neutral: "badge-neutral",
      success: "badge-success",
      warning: "badge-warning",
      danger: "badge-danger",
      info: "badge-info",
    },
  },
  defaultVariants: { variant: "neutral" },
})

type BadgeProps = React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>

function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />
}

export { Badge }
