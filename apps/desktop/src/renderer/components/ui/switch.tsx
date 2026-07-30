import { Switch as SwitchPrimitive } from "@base-ui/react/switch"
import type * as React from "react"
import { cn } from "@/lib/utils"

type SwitchProps = Omit<React.ComponentProps<typeof SwitchPrimitive.Root>, "className"> & { className?: string }

function Switch({ className, ...props }: SwitchProps) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        "relative inline-flex h-[22px] w-[38px] shrink-0 items-center rounded-full bg-input outline-none transition-colors data-[checked]:bg-primary focus-visible:ring-2 focus-visible:ring-ring/45",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="block size-[18px] translate-x-0.5 rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.35)] transition-transform data-[checked]:translate-x-[18px]" />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
