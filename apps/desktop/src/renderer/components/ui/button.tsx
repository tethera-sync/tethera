import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"
import type * as React from "react"
import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-[background,color,border-color,box-shadow,transform] outline-none disabled:pointer-events-none disabled:opacity-45 focus-visible:ring-2 focus-visible:ring-ring/45 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 active:translate-y-px",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground shadow-[0_1px_2px_rgba(0,0,0,0.25),0_6px_18px_color-mix(in_oklab,var(--primary)_28%,transparent)] hover:bg-primary/90",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/75",
        outline: "border border-border bg-surface-strong text-foreground shadow-xs hover:border-primary/40 hover:bg-accent",
        ghost: "text-muted-foreground hover:bg-accent hover:text-foreground",
        destructive: "bg-destructive text-white hover:bg-destructive/90",
      },
      size: {
        default: "h-9 px-3.5 text-[13px]",
        sm: "h-8 rounded-lg px-3 text-xs",
        lg: "h-11 px-5",
        icon: "size-9",
        "icon-sm": "size-8 rounded-lg",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
)

type ButtonProps = Omit<React.ComponentProps<typeof ButtonPrimitive>, "className"> &
  VariantProps<typeof buttonVariants> & { className?: string }

function Button({ className, variant, size, ...props }: ButtonProps) {
  return <ButtonPrimitive className={cn(buttonVariants({ variant, size }), className)} {...props} />
}

export { Button, buttonVariants }
