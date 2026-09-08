import { Select as SelectPrimitive } from "@base-ui/react/select"
import { CheckIcon, ChevronsUpDownIcon } from "lucide-react"
import type * as React from "react"
import { cn } from "@/lib/utils"

const Select = SelectPrimitive.Root

type SelectTriggerProps = Omit<React.ComponentProps<typeof SelectPrimitive.Trigger>, "className"> & { className?: string }

function SelectTrigger({ className, children, ...props }: SelectTriggerProps) {
  return (
    <SelectPrimitive.Trigger
      className={cn(
        "flex h-[38px] w-fit min-w-[160px] items-center justify-between gap-2 rounded-[9px] border border-[var(--input)] bg-[var(--surface-sunken)] px-[11px] text-[12.5px] text-[var(--foreground)] outline-none transition-[border-color,box-shadow] duration-150 data-[placeholder]:text-[var(--muted-foreground)] data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 focus-visible:border-[color-mix(in_oklab,var(--ring)_65%,var(--border))] focus-visible:ring-2 focus-visible:ring-[color-mix(in_oklab,var(--ring)_45%,transparent)]",
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon className="text-[var(--muted-foreground)]">
        <ChevronsUpDownIcon className="size-4" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  )
}

const SelectValue = SelectPrimitive.Value

type SelectContentProps = Omit<React.ComponentProps<typeof SelectPrimitive.Popup>, "className"> & {
  className?: string
  sideOffset?: React.ComponentProps<typeof SelectPrimitive.Positioner>["sideOffset"]
  side?: React.ComponentProps<typeof SelectPrimitive.Positioner>["side"]
  align?: React.ComponentProps<typeof SelectPrimitive.Positioner>["align"]
  alignOffset?: React.ComponentProps<typeof SelectPrimitive.Positioner>["alignOffset"]
}

function SelectContent({
  className,
  children,
  sideOffset = 4,
  side,
  align = "start",
  alignOffset,
  ...props
}: SelectContentProps) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Positioner
        sideOffset={sideOffset}
        side={side}
        align={align}
        alignOffset={alignOffset}
        className="z-50 outline-none"
      >
        <SelectPrimitive.Popup
          className={cn(
            "max-h-[320px] min-w-[var(--anchor-width)] overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--popover)] p-1 text-[var(--popover-foreground)] shadow-2xl outline-none transition-[transform,opacity] data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0",
            className,
          )}
          {...props}
        >
          <SelectPrimitive.List>{children}</SelectPrimitive.List>
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  )
}

type SelectItemProps = Omit<React.ComponentProps<typeof SelectPrimitive.Item>, "className"> & { className?: string }

function SelectItem({ className, children, ...props }: SelectItemProps) {
  return (
    <SelectPrimitive.Item
      className={cn(
        "relative flex cursor-default select-none items-center gap-2 rounded-md py-1.5 pl-2 pr-8 text-[12.5px] text-[var(--foreground)] outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-[var(--accent)] data-[selected]:font-medium",
        className,
      )}
      {...props}
    >
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator className="absolute right-2 flex size-4 items-center justify-center">
        <CheckIcon className="size-4" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  )
}

const SelectGroup = SelectPrimitive.Group

type SelectGroupLabelProps = Omit<React.ComponentProps<typeof SelectPrimitive.GroupLabel>, "className"> & { className?: string }

function SelectGroupLabel({ className, ...props }: SelectGroupLabelProps) {
  return (
    <SelectPrimitive.GroupLabel
      className={cn("px-2 py-1.5 text-xs font-medium text-[var(--muted-foreground)]", className)}
      {...props}
    />
  )
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectTrigger,
  SelectValue,
}
