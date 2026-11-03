import { lazy, Suspense } from "react";
import { useWidget } from "@/hooks/useWidget";
import { cn } from "@/lib/utils";
import { seatOf, statusOf, waitsOn } from "@/lib/widgets";
import { KindGlyph } from "./KindGlyph";
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

/** A widget on its own page. Its state comes from the server by id, never from the message that started it. */
export function WidgetCard({ widgetId, channelId, userId }: {
  widgetId: string;
  channelId: string;
  userId: number | null;
}) {
  const { data: widget, isError } = useWidget(widgetId);
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
    // Full width, as the panel was before it: a centring parent would shrink a bare box to nothing.
    <div className="w-full">
      <Suspense fallback={<WidgetSkeleton className="my-1" />}>
        <WidgetPanel widget={widget} userId={userId} className="my-1" />
      </Suspense>
    </div>
  );
}

/** A widget in the message that started it: one line, its glyph and how it stands (the scene's status while it runs,
 *  how it ended once over), live from the server by id. The board itself is in the chat's game panel, which a click
 *  opens. */
export function WidgetLine({ widgetId, channelId, userId, onOpen }: {
  widgetId: string;
  channelId: string;
  userId: number | null;
  onOpen: (widgetId: string) => void;
}) {
  const { data: widget, isError } = useWidget(widgetId);
  if (isError) {
    return <p className="wgt my-1 text-base leading-normal text-(--w-on-surface-variant)">This widget isn't available.</p>;
  }
  if (!widget) {
    return <div aria-hidden className="wgt my-1 h-10 w-56 max-w-full animate-pulse rounded-full bg-(--w-surface-container) motion-reduce:animate-none" />;
  }
  // A widget shows only in the chat it lives in.
  if (widget.channel_id !== channelId) return null;
  const seat = seatOf(widget, userId);
  const title = widget.scene.title ?? widget.kind;
  const status = statusOf(widget, seat);
  const myMove = waitsOn(widget, seat);
  return (
    <button
      type="button"
      aria-label={[title, status, myMove && "your move"].filter(Boolean).join(", ")}
      title="Show game"
      onClick={() => { onOpen(widgetId); }}
      className="wgt my-1 inline-flex h-10 max-w-full items-center gap-2 rounded-full bg-(--w-surface-container) pr-3.5 pl-3 text-[0.875rem] leading-none outline-none hover:bg-(--w-surface-container-high) focus-visible:shadow-[0_0_0_2px_var(--w-primary)]"
    >
      <span className="relative grid shrink-0 place-items-center">
        <KindGlyph kind={widget.kind} aria-hidden className="size-4 text-(--w-on-primary-container)" />
        {/* The turn, said by the label too, not only by this dot. */}
        {myMove && (
          <span aria-hidden className="absolute -top-1 -right-1 size-2 rounded-full bg-(--w-primary) ring-2 ring-(--w-surface-container)" />
        )}
      </span>
      <span className="shrink-0 font-medium">{title}</span>
      {status && (
        <>
          <span aria-hidden className="size-0.5 shrink-0 rounded-full bg-(--w-on-surface-variant)" />
          <span className="min-w-0 truncate text-(--w-on-surface-variant)">{status}</span>
        </>
      )}
    </button>
  );
}
