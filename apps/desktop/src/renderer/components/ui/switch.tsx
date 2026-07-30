import { Switch as SwitchPrimitive } from "@base-ui/react/switch"
import type * as React from "react"
import { cn } from "@/lib/utils"

type SwitchProps = Omit<React.ComponentProps<typeof SwitchPrimitive.Root>, "className"> & { className?: string }

function Switch({ className, ...props }: SwitchProps) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        "relative inline-flex h-6 w-10 shrink-0 rounded-full bg-input outline-none transition-colors data-[checked]:bg-primary focus-visible:ring-2 focus-visible:ring-ring/45",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="block size-5 translate-x-0.5 rounded-full bg-white shadow-sm transition-transform data-[checked]:translate-x-[18px]" />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
