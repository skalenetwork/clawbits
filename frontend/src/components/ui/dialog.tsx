"use client"

import * as React from "react"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Icon } from "@/components/Icon"
import { Cancel01Icon } from "@hugeicons/core-free-icons"

function Dialog({ ...props }: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({ ...props }: DialogPrimitive.Portal.Props) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({ ...props }: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({
  className,
  ...props
}: DialogPrimitive.Backdrop.Props) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 isolate z-50 bg-black/20 backdrop-blur-[2px] duration-100 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
        className
      )}
      {...props}
    />
  )
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  overlayClassName,
  keepMounted = false,
  ...props
}: DialogPrimitive.Popup.Props & {
  showCloseButton?: boolean
  /** Override the backdrop styling (e.g. drop the app-blur for a frosted popup). */
  overlayClassName?: string
  /** Keep the popup's React subtree mounted (hidden) while closed — for
   *  dialogs whose live component state must survive a visual close, like
   *  the minimized Add Agent wizard. */
  keepMounted?: boolean
}) {
  return (
    <DialogPortal keepMounted={keepMounted}>
      <DialogOverlay className={overlayClassName} />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        className={cn(
          // ``[&>*]:min-w-0`` is load-bearing: this is a grid, and grid items
          // default to ``min-width:auto`` so they refuse to shrink below their
          // content's min size. A long unbreakable name (agent id, channel
          // name) in any child would otherwise blow the whole dialog past its
          // ``max-w`` and off-screen, defeating the inner ``truncate``/
          // ``min-w-0`` chains. Pinning every grid item to ``min-w-0`` lets
          // those constraints actually engage in *all* dialogs.
          //
          // Surface: frosted glass — a translucent popover wash over a hard
          // backdrop blur (opaque-r fallback when backdrop-filter is off).
          "fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-5 rounded-2xl bg-popover/90 p-5 text-sm text-popover-foreground shadow-xl ring-1 ring-foreground/10 backdrop-blur-2xl backdrop-saturate-150 duration-100 outline-none supports-[backdrop-filter]:bg-popover/82 sm:max-w-md data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 [&>*]:min-w-0",
          className
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            render={
              <Button
                variant="ghost"
                className="absolute top-4 right-4 text-muted-foreground hover:bg-muted hover:text-foreground"
                size="icon-sm"
              />
            }
          >
            <Icon icon={Cancel01Icon} />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-1.5", className)}
      {...props}
    />
  )
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close render={<Button variant="outline" />}>
          Close
        </DialogPrimitive.Close>
      )}
    </div>
  )
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn(
        // Title owns its leading icon's size so every dialog matches the
        // PageHeader/ContextualHeader rhythm: a `size-4` glyph optically the
        // same height as the `text-base` title beside it (call sites just set
        // the icon's colour). `shrink-0` keeps it from squishing on overflow.
        "flex items-center gap-2 font-heading text-base font-semibold tracking-tight [&>svg]:size-4 [&>svg]:shrink-0",
        className
      )}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(
        "text-sm text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground",
        className
      )}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
