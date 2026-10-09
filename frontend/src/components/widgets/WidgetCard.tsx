import { lazy, Suspense } from "react";
import { useWidget, useWidgetOnScreenRef } from "@/hooks/useWidget";
import { cn } from "@/lib/utils";
import "./widgets.css";

const WidgetPanel = lazy(() => import("./WidgetPanel"));

/** The panel's footprint while its chunk or its data loads, so the message list doesn't jump. */
export function WidgetSkeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn(
        "wgt wgt-card @container w-full max-w-[42rem]",
        className,
      )}
    >
      <div className="grid gap-y-2 @lg:grid-cols-[minmax(0,1fr)_12rem] @lg:gap-x-3">
        <div className="aspect-square w-full animate-pulse rounded-(--w-radius-inner) bg-(--w-surface-container) motion-reduce:animate-none" />
        <div className="space-y-3 px-1.5 pt-1">
          <div className="flex items-center gap-2.5">
            <span className="size-8 shrink-0 rounded-full bg-(--w-surface-container-high)" />
            <span className="h-4 w-20 rounded-full bg-(--w-surface-container-high)" />
          </div>
          <div className="h-4 w-28 rounded-full bg-(--w-surface-container)" />
          <div className="h-9 w-full rounded-full bg-(--w-surface-container)" />
        </div>
      </div>
    </div>
  );
}

/** A widget inside the message that started it. Its state comes from the server by id, never from the message. */
export function WidgetCard({ widgetId, channelId, userId }: {
  widgetId: string;
  channelId: string;
  userId: number | null;
}) {
  const { data: widget, isError } = useWidget(widgetId);
  const onScreenRef = useWidgetOnScreenRef(widgetId);
  if (isError) {
    return (
      <p className="wgt wgt-card my-1 w-full max-w-[42rem] px-3 text-base leading-normal text-(--w-on-surface-variant)">
        This widget isn't available.
      </p>
    );
  }
  if (!widget) return <WidgetSkeleton className="my-1" />;
  // A widget shows only in the chat it lives in.
  if (widget.channel_id !== channelId) return null;
  return (
    // Watched, so the dock steps aside while the board itself is in view. Full width, as the panel was before it:
    // a centring parent would shrink a bare box to nothing.
    <div ref={onScreenRef} className="w-full">
      <Suspense fallback={<WidgetSkeleton className="my-1" />}>
        <WidgetPanel widget={widget} userId={userId} className="my-1" />
      </Suspense>
    </div>
  );
}
