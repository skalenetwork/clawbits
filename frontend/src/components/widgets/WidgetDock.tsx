import { useActiveWidgets, useWidget, useWidgetOnScreen } from "@/hooks/useWidget";
import type { Widget } from "@/lib/api";
import { seatOf } from "@/lib/widgets";
import { KindGlyph } from "./KindGlyph";
import "./widgets.css";

/** The chat's active widget at the composer's corner: moves post nothing, so the message that started it scrolls
 *  away, and this round button brings it back. It sits over the chat, so it is glass; a tap scrolls the chat to that
 *  message, the one board, rather than opening a second. While that board is in view it steps aside, and while it
 *  shows it takes a lane of its own above the composer, so it never covers a message. */
export function WidgetDock({ channelId, userId, enabled, onShow }: {
  channelId: string;
  userId: number | null;
  enabled: boolean;
  /** Scrolls the chat to the widget's message. */
  onShow: (widget: Widget) => void;
}) {
  const { data } = useActiveWidgets(channelId, enabled);
  const listed = data?.[0];
  return listed ? <DockedWidget key={listed.widget_id} listed={listed} userId={userId} onShow={onShow} /> : null;
}

function DockedWidget({ listed, userId, onShow }: {
  listed: Widget;
  userId: number | null;
  onShow: (widget: Widget) => void;
}) {
  // The widget's own query stays fresh where the list may not: a private widget refetches only itself.
  const widget = useWidget(listed.widget_id).data ?? listed;
  const onScreen = useWidgetOnScreen(listed.widget_id);
  const mySeat = seatOf(widget, userId);
  const opponent = widget.seats.find((s) => s.seat !== mySeat)?.display_name;
  const myTurn = mySeat != null && widget.turn === mySeat;
  const status = myTurn ? "Your move" : widget.scene.status?.text;
  const label = [widget.scene.title ?? widget.kind, opponent && `with ${opponent}`, status].filter(Boolean).join(", ");
  if (onScreen) return null;
  return (
    // The lane is part of the composer, which the chat measures and keeps clear of its latest message.
    <div className="wgt pointer-events-none flex justify-end pb-2">
      <button
        type="button"
        aria-label={label}
        title={label}
        onClick={() => { onShow(widget); }}
        className="wgt-glass pointer-events-auto relative grid size-12 place-items-center rounded-full outline-none animate-in fade-in duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--w-primary) motion-reduce:animate-none"
      >
        <KindGlyph kind={widget.kind} aria-hidden className="size-5 text-(--w-on-primary-container)" />
        {/* The turn, said by the label too, not only by this dot. */}
        {myTurn && (
          <span aria-hidden className="absolute top-0.5 right-0.5 size-3 rounded-full bg-(--w-primary) ring-2 ring-(--w-surface)" />
        )}
      </button>
    </div>
  );
}
