import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"
import type * as React from "react"
import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-[7px] text-sm font-medium transition-[background,color,border-color,box-shadow,transform] outline-none disabled:pointer-events-none disabled:opacity-45 focus-visible:ring-2 focus-visible:ring-[color-mix(in_oklab,var(--ring)_45%,transparent)] [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 active:translate-y-px",
  {
    variants: {
      variant: {
        default:
          "bg-[var(--primary)] text-[var(--primary-foreground)] shadow-[0_1px_2px_rgba(0,0,0,0.18)] hover:bg-[color-mix(in_oklab,var(--primary)_90%,black)]",
        secondary: "bg-[var(--secondary)] text-[var(--secondary-foreground)] hover:bg-[color-mix(in_oklab,var(--secondary)_75%,transparent)]",
        outline: "border border-[var(--border)] bg-[var(--surface-strong)] text-[var(--foreground)] shadow-xs hover:border-[color-mix(in_oklab,var(--primary)_40%,transparent)] hover:bg-[var(--accent)]",
        ghost: "text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)]",
        destructive: "bg-[var(--destructive)] text-white hover:bg-[color-mix(in_oklab,var(--destructive)_90%,transparent)]",
      },
      size: {
        default: "h-9 px-3.5 text-[13px]",
        sm: "h-8 rounded-[7px] px-3 text-xs",
        lg: "h-11 px-5",
        icon: "size-9",
        "icon-sm": "size-8 rounded-[7px]",
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
