import type { ComponentProps } from "react"
import { Drawer as DrawerPrimitive } from "@base-ui/react/drawer"

import { cn } from "@/lib/utils"

export function Drawer(props: ComponentProps<typeof DrawerPrimitive.Root>) {
  return <DrawerPrimitive.Root data-slot="drawer" {...props} />
}

export function DrawerBackdrop({ className, ...props }: ComponentProps<typeof DrawerPrimitive.Backdrop>) {
  return (
    <DrawerPrimitive.Backdrop
      data-slot="drawer-backdrop"
      className={cn(
        "fixed inset-0 z-50 bg-black/20 transition-opacity duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0 supports-backdrop-filter:backdrop-blur-[2px]",
        className,
      )}
      {...props}
    />
  )
}

/** Gesture bottom sheet (drag to dismiss); ui/sheet.tsx is the gesture-less slide-over. */
export function DrawerContent({ className, children, ...props }: ComponentProps<typeof DrawerPrimitive.Popup>) {
  return (
    <DrawerPrimitive.Portal data-slot="drawer-portal">
      <DrawerBackdrop />
      <DrawerPrimitive.Viewport className="pointer-events-none fixed inset-0 z-50 flex flex-col justify-end">
        <DrawerPrimitive.Popup
          data-slot="drawer-content"
          className={cn(
            "pointer-events-auto mx-auto flex max-h-[92dvh] w-full max-w-content flex-col rounded-t-3xl border-t border-sidebar-border bg-popover text-popover-foreground shadow-2xl outline-none supports-backdrop-filter:bg-popover/80 supports-backdrop-filter:backdrop-blur-2xl supports-backdrop-filter:backdrop-saturate-150 pb-[max(0.5rem,var(--safe-bottom))] transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] data-ending-style:translate-y-full data-starting-style:translate-y-full",
            className,
          )}
          {...props}
        >
          <div
            aria-hidden
            className="mx-auto mt-2.5 mb-1 h-1.5 w-10 shrink-0 rounded-full bg-foreground/20"
          />
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-1">
            {children}
          </div>
        </DrawerPrimitive.Popup>
      </DrawerPrimitive.Viewport>
    </DrawerPrimitive.Portal>
  )
}

export function DrawerHeader({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="drawer-header"
      className={cn("flex flex-col gap-1 px-1 pb-3 pt-1", className)}
      {...props}
    />
  )
}

export function DrawerTitle({ className, ...props }: ComponentProps<typeof DrawerPrimitive.Title>) {
  return (
    <DrawerPrimitive.Title
      data-slot="drawer-title"
      className={cn("text-lg font-medium text-foreground", className)}
      {...props}
    />
  )
}
