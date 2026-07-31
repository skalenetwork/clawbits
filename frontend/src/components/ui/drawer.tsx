import * as React from "react"
import { Drawer as DrawerPrimitive } from "@base-ui/react/drawer"

import { cn } from "@/lib/utils"

/**
 * Mobile bottom sheet — a thin wrapper over Base UI's gesture Drawer
 * (drag-to-dismiss, optional snap points via the Root's ``snapPoints`` prop).
 *
 * This is the mobile counterpart to ui/sheet.tsx, which is a plain Dialog with
 * NO gestures. Rule of thumb: use Drawer for anything that should feel like an
 * iOS sheet (channel info, compose, agent profile, picker); keep Sheet for
 * desktop edge slide-overs.
 *
 * Liquid glass: a translucent fill + backdrop blur/saturate where the engine
 * supports it, with an opaque ``bg-popover`` fallback (the base layer) so it
 * stays legible in Firefox / WebKitGTK where backdrop-filter is weak or off.
 */
function Drawer(props: React.ComponentProps<typeof DrawerPrimitive.Root>) {
  return <DrawerPrimitive.Root data-slot="drawer" {...props} />
}

function DrawerTrigger(
  props: React.ComponentProps<typeof DrawerPrimitive.Trigger>,
) {
  return <DrawerPrimitive.Trigger data-slot="drawer-trigger" {...props} />
}

function DrawerClose(props: React.ComponentProps<typeof DrawerPrimitive.Close>) {
  return <DrawerPrimitive.Close data-slot="drawer-close" {...props} />
}

function DrawerPortal(
  props: React.ComponentProps<typeof DrawerPrimitive.Portal>,
) {
  return <DrawerPrimitive.Portal data-slot="drawer-portal" {...props} />
}

function DrawerBackdrop({
  className,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Backdrop>) {
  return (
    <DrawerPrimitive.Backdrop
      data-slot="drawer-backdrop"
      className={cn(
        "fixed inset-0 z-50 bg-black/30 transition-opacity duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0 supports-backdrop-filter:backdrop-blur-sm",
        className,
      )}
      {...props}
    />
  )
}

function DrawerContent({
  className,
  children,
  showHandle = true,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Popup> & {
  showHandle?: boolean
}) {
  return (
    <DrawerPortal>
      <DrawerBackdrop />
      {/* Viewport is the positioning + scroll container that owns the swipe
          gesture; the Popup is the draggable sheet inside it. ``justify-end``
          pins the sheet to the bottom; pointer-events pass through the empty
          area above it so a tap there dismisses via the backdrop. */}
      <DrawerPrimitive.Viewport className="pointer-events-none fixed inset-0 z-50 flex flex-col justify-end">
        <DrawerPrimitive.Popup
          data-slot="drawer-content"
          className={cn(
            // Bottom sheet, capped to the reading column on large phones/tablets.
            "pointer-events-auto mx-auto flex max-h-[92dvh] w-full max-w-content flex-col rounded-t-3xl border-t border-sidebar-border bg-popover text-popover-foreground shadow-2xl outline-none",
            // Liquid glass where supported; the opaque bg-popover above is the fallback.
            "supports-backdrop-filter:bg-popover/80 supports-backdrop-filter:backdrop-blur-2xl supports-backdrop-filter:backdrop-saturate-150",
            // Home-indicator clearance + the open/close slide.
            "pb-[max(0.5rem,var(--safe-bottom))] transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] data-ending-style:translate-y-full data-starting-style:translate-y-full",
            className,
          )}
          {...props}
        >
          {showHandle && (
            <div
              aria-hidden
              className="mx-auto mt-2.5 mb-1 h-1.5 w-10 shrink-0 rounded-full bg-foreground/20"
            />
          )}
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-1">
            {children}
          </div>
        </DrawerPrimitive.Popup>
      </DrawerPrimitive.Viewport>
    </DrawerPortal>
  )
}

function DrawerHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="drawer-header"
      className={cn("flex flex-col gap-1 px-1 pb-3 pt-1", className)}
      {...props}
    />
  )
}

function DrawerFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="drawer-footer"
      className={cn("mt-auto flex flex-col gap-2 px-1 pt-3", className)}
      {...props}
    />
  )
}

function DrawerTitle({
  className,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Title>) {
  return (
    <DrawerPrimitive.Title
      data-slot="drawer-title"
      className={cn("text-lg font-medium text-foreground", className)}
      {...props}
    />
  )
}

function DrawerDescription({
  className,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Description>) {
  return (
    <DrawerPrimitive.Description
      data-slot="drawer-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Drawer,
  DrawerTrigger,
  DrawerClose,
  DrawerPortal,
  DrawerBackdrop,
  DrawerContent,
  DrawerHeader,
  DrawerFooter,
  DrawerTitle,
  DrawerDescription,
}
