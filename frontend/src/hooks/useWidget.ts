import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  actOnWidget,
  getWidget,
  listActiveWidgets,
  type Widget,
  type WidgetAction,
} from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import { openSseStream } from "@/lib/sse";
import { errMsg, toast } from "@/lib/toast";
import { applyWidget, applyWidgetEvent, freshActiveWidgets, freshWidget } from "@/lib/widgets";

// The widgets whose board is on screen now, so the dock steps aside while the board itself is in view.
const onScreen = new Set<string>();
const onScreenListeners = new Set<() => void>();

function setWidgetOnScreen(widgetId: string, shown: boolean): void {
  if (onScreen.has(widgetId) === shown) return;
  if (shown) onScreen.add(widgetId);
  else onScreen.delete(widgetId);
  for (const listener of onScreenListeners) listener();
}

/** Whether a widget's board is on screen now. */
export function useWidgetOnScreen(widgetId: string): boolean {
  return useSyncExternalStore(
    (listener) => {
      onScreenListeners.add(listener);
      return () => { onScreenListeners.delete(listener); };
    },
    () => onScreen.has(widgetId),
  );
}

/** A ref for the element that shows a widget's board, telling `useWidgetOnScreen` while most of it shows: half of
 *  it, or half the screen for a board taller than that. The glass header and composer don't count as showing. */
export function useWidgetOnScreenRef(widgetId: string): (el: HTMLElement | null) => (() => void) | undefined {
  return useCallback((el: HTMLElement | null) => {
    if (!el) return undefined;
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry) return;
      const whole = Math.min(entry.boundingClientRect.height, entry.rootBounds?.height ?? window.innerHeight);
      setWidgetOnScreen(widgetId, entry.isIntersecting && entry.intersectionRect.height >= whole / 2);
    }, { rootMargin: "-64px 0px -160px 0px", threshold: Array.from({ length: 11 }, (_, i) => i / 10) });
    observer.observe(el);
    return () => {
      observer.disconnect();
      setWidgetOnScreen(widgetId, false);
    };
  }, [widgetId]);
}

/** One widget; `widget.updated` keeps it live, so no polling. A slow answer never undoes a newer rev an event brought
 *  while it was out. */
export function useWidget(widgetId: string) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: queryKeys.mm.widget(widgetId),
    queryFn: async () => freshWidget(qc, await getWidget(widgetId)),
    staleTime: 60_000,
  });
}

/** Keeps a widget live where its chat isn't open (the widget's own page): the chat's stream, widget events only.
 *  The bus keeps no history, so every connect refetches the widget, the first too: one cached before the page opened
 *  counts as fresh for a minute, and may have missed the moves made meanwhile. */
export function useWidgetLive(widgetId: string, channelId: string | undefined) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!channelId) return;
    const conn = openSseStream(
      `/api/human/mm/channels/${encodeURIComponent(channelId)}/events`,
      (raw) => {
        const evt = raw as { type?: string; data?: Widget };
        if (evt.type === "widget.updated" && evt.data) applyWidgetEvent(qc, evt.data);
      },
      {
        onOpen: () => {
          void qc.invalidateQueries({ queryKey: queryKeys.mm.widget(widgetId) });
        },
      },
    );
    return () => { conn.close(); };
  }, [qc, widgetId, channelId]);
}

/** The chat's active widget, if any (the server allows one), for the dock. */
export function useActiveWidgets(channelId: string, enabled: boolean) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: queryKeys.mm.activeWidgets(channelId),
    queryFn: async () => freshActiveWidgets(qc, await listActiveWidgets(channelId)),
    enabled,
    staleTime: 60_000,
  });
}

/** Act as the viewer's seat. A rejected action refetches, since the board it was taken on may be stale. */
export function useWidgetAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ widget, action }: { widget: Widget; action: WidgetAction }) =>
      actOnWidget(widget.widget_id, action, widget.rev),
    onSuccess: (fresh) => { applyWidget(qc, fresh); },
    onError: (e, { widget }) => {
      toast.error(errMsg(e, "That didn't go through"));
      void qc.invalidateQueries({ queryKey: queryKeys.mm.widget(widget.widget_id) });
      void qc.invalidateQueries({ queryKey: queryKeys.mm.activeWidgets(widget.channel_id) });
    },
  });
}
