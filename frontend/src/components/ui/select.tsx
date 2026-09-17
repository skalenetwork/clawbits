import { Select as SelectPrimitive } from "@base-ui/react/select"
import { ArrowDown01Icon, Tick01Icon } from "@hugeicons/core-free-icons"
import { ChevronsUpDown } from "lucide-react"

import { Icon } from "@/components/Icon"
import { MENU_ITEM, MENU_LABEL, MENU_SURFACE } from "@/lib/menuSurface"
import { cn } from "@/lib/utils"

const TRIGGER =
  "flex min-w-0 cursor-pointer items-center justify-between gap-2 border text-left text-foreground transition-[color,box-shadow,background-color] outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 data-disabled:pointer-events-none data-disabled:opacity-50"

export const SELECT_SM = `${TRIGGER} h-[30px] w-auto rounded-lg border-border bg-background px-2.5 text-[13px] font-medium`

/** Pass `items` on the Root so SelectValue renders labels instead of raw values. */
export function Select<Value>(props: SelectPrimitive.Root.Props<Value>) {
  return <SelectPrimitive.Root data-slot="select" {...props} />
}

export function SelectTrigger({
  className,
  children,
  size = "default",
  ...props
}: SelectPrimitive.Trigger.Props & { size?: "default" | "sm" }) {
  const sm = size === "sm"
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      className={cn(
        sm ? SELECT_SM : `${TRIGGER} h-9 w-full rounded-md border-transparent bg-input/50 px-3 py-1 text-sm`,
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon className="flex shrink-0">
        {sm ? (
          <ChevronsUpDown className="size-3 text-muted-foreground" />
        ) : (
          <Icon icon={ArrowDown01Icon} className="size-4 text-muted-foreground"/>
        )}
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  )
}

export function SelectValue({ className, ...props }: SelectPrimitive.Value.Props) {
  return (
    <SelectPrimitive.Value
      data-slot="select-value"
      className={cn("truncate data-placeholder:text-muted-foreground", className)}
      {...props}
    />
  )
}

export function SelectContent({ className, ...props }: SelectPrimitive.Popup.Props) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Positioner className="isolate z-50 outline-none select-none" sideOffset={4}>
        <SelectPrimitive.Popup
          data-slot="select-content"
          className={cn(
            "z-50 max-h-(--available-height) w-(--anchor-width) min-w-40 origin-(--transform-origin) overflow-x-hidden overflow-y-auto",
            MENU_SURFACE,
            "duration-100 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:overflow-hidden data-closed:fade-out-0 data-closed:zoom-out-95",
            className,
          )}
          {...props}
        />
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  )
}

export function SelectItem({ className, children, ...props }: SelectPrimitive.Item.Props) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(MENU_ITEM, "w-full pr-8", className)}
      {...props}
    >
      <SelectPrimitive.ItemText className="min-w-0 flex-1 truncate">
        {children}
      </SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator className="absolute right-2.5 flex">
        <Icon icon={Tick01Icon} className="size-4"/>
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  )
}

export function SelectGroup(props: SelectPrimitive.Group.Props) {
  return <SelectPrimitive.Group data-slot="select-group" {...props} />
}

export function SelectGroupLabel({ className, ...props }: SelectPrimitive.GroupLabel.Props) {
  return (
    <SelectPrimitive.GroupLabel
      data-slot="select-group-label"
      className={cn(MENU_LABEL, className)}
      {...props}
    />
  )
}
