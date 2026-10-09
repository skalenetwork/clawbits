import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";

import { useActiveWidgets, useWidget, useWidgetLive } from "./useWidget";
import { getWidget, listActiveWidgets, type Widget } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import { openSseStream } from "@/lib/sse";
import { applyWidget } from "@/lib/widgets";

vi.mock("@/lib/sse", () => ({ openSseStream: vi.fn(() => ({ close: vi.fn() })) }));
vi.mock("@/lib/api", async (original) => ({
  ...await original<typeof import("@/lib/api")>(),
  getWidget: vi.fn(),
  listActiveWidgets: vi.fn(),
}));

const wrap = (client: QueryClient) => ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
);

/** A request held open until the test answers it, as a slow server would. */
function held<T>() {
  let answer: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => { answer = resolve; });
  return { promise, answer: (value: T) => { answer(value); } };
}

const widget = (rev: number): Widget => ({
  widget_id: "w1",
  channel_id: "c1",
  kind: "chess",
  status: "active",
  rev,
  turn: "white",
  seats: [],
  scene: { v: 1 },
  outcome: null,
  created_by_human_id: 1,
  created_at: "2026-10-08T10:00:00Z",
  updated_at: "2026-10-08T10:00:00Z",
});

describe("useWidgetLive", () => {
  it("follows the chat's stream for widget events, and refetches on every opening, the first too", () => {
    const client = new QueryClient();
    const refetch = vi.spyOn(client, "invalidateQueries");
    renderHook(() => { useWidgetLive("w1", "c1"); }, {
      wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
    });
    const [url, onEvent, options] = vi.mocked(openSseStream).mock.lastCall!;
    expect(url).toBe("/api/human/mm/channels/c1/events");
    act(() => { onEvent({ type: "widget.updated", data: widget(4) }); });
    expect(client.getQueryData<Widget>(queryKeys.mm.widget("w1"))?.rev).toBe(4);
    act(() => { onEvent({ type: "post.created", data: {} }); });
    expect(refetch).not.toHaveBeenCalled();
    options?.onOpen?.();
    expect(refetch).toHaveBeenCalledWith({ queryKey: queryKeys.mm.widget("w1") });
    options?.onOpen?.();
    expect(refetch).toHaveBeenCalledTimes(2);
  });
});

describe("answers that arrive late", () => {
  it("keeps a newer rev an event brought while a slow fetch of the widget was out", async () => {
    const reply = held<Widget>();
    vi.mocked(getWidget).mockReturnValue(reply.promise);
    const client = new QueryClient();
    const { result } = renderHook(() => useWidget("w1"), { wrapper: wrap(client) });
    act(() => { applyWidget(client, widget(2)); });
    await act(async () => { reply.answer(widget(1)); await reply.promise; });
    await waitFor(() => { expect(result.current.isFetching).toBe(false); });
    expect(client.getQueryData<Widget>(queryKeys.mm.widget("w1"))?.rev).toBe(2);
  });

  it("keeps a game that ended while a slow list was out off the list, so a new one can start", async () => {
    const reply = held<Widget[]>();
    vi.mocked(listActiveWidgets).mockReturnValue(reply.promise);
    const client = new QueryClient();
    const { result } = renderHook(() => useActiveWidgets("c1", true), { wrapper: wrap(client) });
    act(() => { applyWidget(client, { ...widget(2), status: "finished", turn: null }); });
    await act(async () => { reply.answer([widget(1)]); await reply.promise; });
    await waitFor(() => { expect(result.current.isFetching).toBe(false); });
    expect(result.current.data).toEqual([]);
    expect(client.getQueryData<Widget>(queryKeys.mm.widget("w1"))?.status).toBe("finished");
  });
});
