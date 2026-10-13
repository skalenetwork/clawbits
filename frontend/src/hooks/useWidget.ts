import { useEffect } from "react";
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

/** The chat's active widget, if any (the server allows one), for its game panel. */
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
