import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { WidgetDock } from "./WidgetDock";
import { WidgetCard } from "./WidgetCard";
import type { Widget } from "@/lib/api";

const game: Widget = {
  widget_id: "w1",
  channel_id: "c1",
  kind: "battleship",
  status: "active",
  rev: 2,
  turn: "red",
  seats: [
    { seat: "red", human_id: 1, agent_id: null, display_name: "Alice" },
    { seat: "blue", human_id: 2, agent_id: null, display_name: "Bob" },
  ],
  scene: { v: 1, title: "Battleship", status: { text: "Your shot", tone: "neutral" } },
  post_id: 42,
  outcome: null,
  created_by_human_id: 1,
  created_at: "2026-10-09T10:00:00Z",
  updated_at: "2026-10-09T10:00:00Z",
};

vi.mock("@/lib/api", async (original) => ({
  ...await original<typeof import("@/lib/api")>(),
  listActiveWidgets: vi.fn(() => Promise.resolve([game])),
  getWidget: vi.fn(() => Promise.resolve(game)),
}));

describe("WidgetDock", () => {
  it("takes the chat to the game's message, and opens no board of its own", async () => {
    const onShow = vi.fn();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <WidgetDock channelId="c1" userId={1} enabled onShow={onShow} />
      </QueryClientProvider>,
    );
    const dock = await screen.findByRole("button", { name: "Battleship, with Bob, Your move" });
    fireEvent.click(dock);
    expect(onShow).toHaveBeenCalledWith(expect.objectContaining({ widget_id: "w1", post_id: 42 }));
    expect(dock).not.toHaveAttribute("aria-expanded");
    expect(screen.queryByRole("region")).toBeNull();
  });

  it("steps aside while the game's own board is on screen", async () => {
    let report: IntersectionObserverCallback = () => undefined;
    vi.stubGlobal("IntersectionObserver", class {
      constructor(callback: IntersectionObserverCallback) { report = callback; }
      observe() { return undefined; }
      disconnect() { return undefined; }
    });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <WidgetCard widgetId="w1" channelId="c1" userId={1} />
        <WidgetDock channelId="c1" userId={1} enabled onShow={vi.fn()} />
      </QueryClientProvider>,
    );
    const dock = await screen.findByRole("button", { name: "Battleship, with Bob, Your move" });
    const seen = (height: number) => [{
      isIntersecting: height > 0,
      intersectionRect: { height },
      boundingClientRect: { height: 400 },
      rootBounds: { height: 800 },
    }] as unknown as IntersectionObserverEntry[];
    act(() => { report(seen(300), {} as IntersectionObserver); });
    expect(dock).not.toBeInTheDocument();
    act(() => { report(seen(100), {} as IntersectionObserver); });
    expect(await screen.findByRole("button", { name: "Battleship, with Bob, Your move" })).toBeInTheDocument();
    vi.unstubAllGlobals();
  });
});
