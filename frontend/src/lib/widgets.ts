import type { QueryClient } from "@tanstack/react-query";
import type { MmChannel, Org, Widget, WidgetScene } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";

/** Fold a fresh widget into its caches; an older rev never overwrites a newer one. The widget's own entry keeps
 *  its newest rev, so a late event for a game that has since ended can't put it back in the chat's active list
 *  (where it no longer is to compare with). */
export function applyWidget(qc: QueryClient, widget: Widget): void {
  const known = qc.getQueryData<Widget>(queryKeys.mm.widget(widget.widget_id));
  if (known && known.rev > widget.rev) return;
  qc.setQueryData<Widget>(queryKeys.mm.widget(widget.widget_id), widget);
  qc.setQueryData<Widget[]>(queryKeys.mm.activeWidgets(widget.channel_id), (prev) => {
    const known = prev?.find((w) => w.widget_id === widget.widget_id);
    if (known && known.rev > widget.rev) return prev;
    const rest = (prev ?? []).filter((w) => w.widget_id !== widget.widget_id);
    return widget.status === "active" ? [widget, ...rest] : prev && rest;
  });
}

/** A widget a request answered with, unless the cache already holds a newer rev of it: a realtime event that beat a
 *  slow answer stays. */
export function freshWidget(qc: QueryClient, fetched: Widget): Widget {
  const known = qc.getQueryData<Widget>(queryKeys.mm.widget(fetched.widget_id));
  return known && known.rev > fetched.rev ? known : fetched;
}

/** A chat's active widgets as a request listed them, set against each widget's own cache: a newer rev there stands
 *  in for the listed one, and a widget that has ended since stays off the list, so a slow answer can't bring a
 *  finished game back (and with it block a new one). Each listed widget at least as new as its cache seeds it. */
export function freshActiveWidgets(qc: QueryClient, listed: Widget[]): Widget[] {
  return listed.flatMap((fetched) => {
    const widget = freshWidget(qc, fetched);
    if (widget === fetched) qc.setQueryData<Widget>(queryKeys.mm.widget(fetched.widget_id), fetched);
    return widget.status === "active" ? [widget] : [];
  });
}

/** A realtime `widget.updated`. A private widget's event carries only the public scene, so the viewer's own view
 *  is refetched instead, unless this rev is already here (the viewer's own action answered with it). */
export function applyWidgetEvent(qc: QueryClient, widget: Widget): void {
  if (!widget.private) {
    applyWidget(qc, widget);
    return;
  }
  const known = qc.getQueryData<Widget>(queryKeys.mm.widget(widget.widget_id));
  if (known && known.rev >= widget.rev) return;
  void qc.invalidateQueries({ queryKey: queryKeys.mm.widget(widget.widget_id) });
  qc.setQueryData<Widget[]>(queryKeys.mm.activeWidgets(widget.channel_id), (prev) =>
    prev && widget.status !== "active" ? prev.filter((w) => w.widget_id !== widget.widget_id) : prev,
  );
  if (widget.status === "active" && !qc.getQueryData<Widget[]>(queryKeys.mm.activeWidgets(widget.channel_id))?.length) {
    void qc.invalidateQueries({ queryKey: queryKeys.mm.activeWidgets(widget.channel_id) });
  }
}

/** How a widget ended for its viewer, the same few ways for every kind: won, lost, a draw, ended early (aborted), or
 *  just finished, for a spectator or an outcome that names no winner. Null while it runs. */
export type WidgetEnd = "won" | "lost" | "draw" | "ended" | "finished";

export function endOf(widget: Widget, seat: string | null): WidgetEnd | null {
  if (widget.status === "active") return null;
  if (widget.status === "aborted") return "ended";
  const winner = widget.outcome?.winner;
  if (winner === null) return "draw";
  if (typeof winner !== "string" || seat == null) return "finished";
  return winner === seat ? "won" : "lost";
}

const HEADLINE: Record<WidgetEnd, string> = {
  won: "You won",
  lost: "You lost",
  draw: "Draw",
  ended: "Ended",
  finished: "Finished",
};

/** How a widget ended, as its result heads it: from the viewer's side, the winner named for a spectator. Null while
 *  it runs; the reason is the scene's status. */
export function resultOf(widget: Widget, seat: string | null): { end: WidgetEnd; headline: string } | null {
  const end = endOf(widget, seat);
  if (!end) return null;
  const winner = end === "finished" ? widget.seats.find((s) => s.seat === widget.outcome?.winner)?.display_name : null;
  return { end, headline: winner ? `${winner} won` : HEADLINE[end] };
}

/** Whether a scene draws chess pieces, so the piece-set switch belongs beside it. */
export function drawsChessPieces(scene: WidgetScene): boolean {
  return [scene.tokens ?? [], ...(scene.boards ?? []).map((board) => board.tokens ?? [])]
    .flat()
    .some((token) => token.sprite.startsWith("chess."));
}

/** The game's notes, behind their button. A card game keeps none: its table tells the hand. */
export function notesOf(scene: WidgetScene): string[] {
  return scene.table ? [] : scene.log ?? [];
}

/** Whether every board is a seat's own (a fleet each), so each player sits beneath their board. */
export function boardsBySeat(scene: WidgetScene): boolean {
  const boards = scene.boards ?? [];
  return boards.length > 1 && boards.every((board) => board.seat != null);
}

/** The viewer's seat, or null for a spectator. */
export function seatOf(widget: Widget, userId: number | null): string | null {
  return widget.seats.find((s) => s.human_id != null && s.human_id === userId)?.seat ?? null;
}

/** Widgets run in one-to-one chats between people, with both the org's and the chat's switch on. */
export function isWidgetChat(channel: MmChannel | undefined): boolean {
  return channel?.channel_type === "direct" && channel.dm_peer_human_id != null;
}

export function widgetsAvailable(channel: MmChannel | undefined, org: Org | null): boolean {
  return isWidgetChat(channel) && Boolean(channel?.widgets_enabled) && Boolean(org?.widgets_enabled);
}
