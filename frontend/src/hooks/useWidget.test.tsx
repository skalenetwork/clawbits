import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";

import { useActiveWidgets, useWidget, useWidgetAction, useWidgetLive } from "./useWidget";
import { actOnWidget, getWidget, HttpError, listActiveWidgets, type Widget } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import { openSseStream } from "@/lib/sse";
import { toast } from "@/lib/toast";
import { applyWidget } from "@/lib/widgets";

vi.mock("@/lib/sse", () => ({ openSseStream: vi.fn(() => ({ close: vi.fn() })) }));
vi.mock("@/lib/api", async (original) => ({
  ...await original<typeof import("@/lib/api")>(),
  getWidget: vi.fn(),
  listActiveWidgets: vi.fn(),
  actOnWidget: vi.fn(),
}));
vi.mock("@/lib/toast", async (original) => ({
  ...await original<typeof import("@/lib/toast")>(),
  toast: { error: vi.fn() },
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

describe("useWidgetAction", () => {
  // White to move on a1-a2 boards, with a resign button: what the fresh board offers or doesn't.
  const board = (rev: number, over: Partial<Widget> = {}): Widget => ({
    ...widget(rev),
    seats: [
      { seat: "white", human_id: 1, agent_id: null, display_name: "Alice" },
      { seat: "black", human_id: null, agent_id: "a1", display_name: "Deep Blue" },
    ],
    scene: {
      v: 1,
      input: { white: { action: "move", pick: { a1: ["a2"] } } },
      actions: { white: [{ type: "resign", label: "Resign" }] },
    },
    ...over,
  });
  const conflict = () => new HttpError(409, "The widget changed meanwhile; try again");

  function act409(fresh: Widget, then: Widget | Error) {
    vi.mocked(actOnWidget).mockReset().mockRejectedValueOnce(conflict());
    if (then instanceof Error) vi.mocked(actOnWidget).mockRejectedValueOnce(then);
    else vi.mocked(actOnWidget).mockResolvedValueOnce(then);
    vi.mocked(getWidget).mockReset().mockResolvedValue(fresh);
    vi.mocked(toast.error).mockClear();
    const client = new QueryClient();
    const { result } = renderHook(() => useWidgetAction(), { wrapper: wrap(client) });
    return { client, result };
  }

  it("sends a move refused as stale once more on the fresh board while that board still offers it", async () => {
    const { client, result } = act409(board(5), board(6, { turn: "black" }));
    act(() => { result.current.mutate({ widget: board(3), seat: "white", action: { type: "move", args: { from: "a1", to: "a2" } } }); });
    await waitFor(() => { expect(result.current.isSuccess).toBe(true); });
    expect(vi.mocked(actOnWidget).mock.calls.map(([, , rev]) => rev)).toEqual([3, 5]);
    expect(client.getQueryData<Widget>(queryKeys.mm.widget("w1"))?.rev).toBe(6);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("drops it without a word where the fresh board no longer offers it, and shows that board", async () => {
    const moved = board(5, { scene: { v: 1, input: { white: { action: "move", pick: { b1: ["b2"] } } } } });
    const { client, result } = act409(moved, board(99));
    act(() => { result.current.mutate({ widget: board(3), seat: "white", action: { type: "move", args: { from: "a1", to: "a2" } } }); });
    await waitFor(() => { expect(result.current.isSuccess).toBe(true); });
    expect(actOnWidget).toHaveBeenCalledOnce();
    expect(client.getQueryData<Widget>(queryKeys.mm.widget("w1"))?.rev).toBe(5);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("drops it too once the game is over, and retries only once", async () => {
    const over = act409(board(5, { status: "finished" }), board(99));
    act(() => { over.result.current.mutate({ widget: board(3), seat: "white", action: { type: "resign" } }); });
    await waitFor(() => { expect(over.result.current.isSuccess).toBe(true); });
    expect(actOnWidget).toHaveBeenCalledOnce();
    // Refused again on the fresh board: that one is said.
    const twice = act409(board(5), conflict());
    act(() => { twice.result.current.mutate({ widget: board(3), seat: "white", action: { type: "resign" } }); });
    await waitFor(() => { expect(twice.result.current.isError).toBe(true); });
    expect(actOnWidget).toHaveBeenCalledTimes(2);
    expect(toast.error).toHaveBeenCalledWith("The widget changed meanwhile; try again");
  });

  it("says any other refusal at once, with no second try", async () => {
    vi.mocked(actOnWidget).mockReset().mockRejectedValueOnce(new HttpError(422, "Illegal move"));
    vi.mocked(getWidget).mockReset();
    vi.mocked(toast.error).mockClear();
    const { result } = renderHook(() => useWidgetAction(), { wrapper: wrap(new QueryClient()) });
    act(() => { result.current.mutate({ widget: board(3), seat: "white", action: { type: "resign" } }); });
    await waitFor(() => { expect(result.current.isError).toBe(true); });
    expect(actOnWidget).toHaveBeenCalledOnce();
    expect(getWidget).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith("Illegal move");
  });
});
