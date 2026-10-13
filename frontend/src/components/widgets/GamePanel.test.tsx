import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { GameBar, GameColumn } from "./GamePanel";
import { WidgetLine } from "./WidgetCard";
import { RightPanelSlotContext } from "@/components/sidebars/rightPanelContext";
import { actOnWidget, type Widget } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import { applyWidget } from "@/lib/widgets";

vi.mock("@/lib/api", async (original) => ({
  ...await original<typeof import("@/lib/api")>(),
  getWidget: vi.fn(() => new Promise<never>(() => undefined)),
  // Never answers: the test looks only at what was sent.
  actOnWidget: vi.fn(() => new Promise<never>(() => undefined)),
}));

// A cache update reaches its readers at once, as an event's would, rather than on React Query's next tick.
notifyManager.setScheduler((notify) => { notify(); });

// Each test plays its own game: the panel's view of a game outlives a render, as it does a page.
let games = 0;
const chess = (over: Partial<Widget> = {}): Widget => ({
  widget_id: `g${String(++games)}`,
  channel_id: "c1",
  kind: "chess",
  status: "active",
  rev: 3,
  turn: "white",
  seats: [
    { seat: "white", human_id: 1, agent_id: null, display_name: "Alice" },
    { seat: "black", human_id: 2, agent_id: null, display_name: "Bob" },
  ],
  scene: {
    v: 1,
    title: "Chess",
    board: { cols: ["a", "b"], rows: ["1", "2"], pattern: "checker" },
    tokens: [],
    status: { text: "White to move", tone: "neutral" },
  },
  outcome: null,
  created_by_human_id: 1,
  created_at: "2026-10-12T10:00:00Z",
  updated_at: "2026-10-12T10:00:00Z",
  ...over,
});

/** Storage that works under any Node: the page's own may be missing or blocked. */
function stubStorage(seed: Record<string, string> = {}) {
  const items = new Map(Object.entries(seed));
  const storage = {
    getItem: vi.fn((key: string) => items.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { items.set(key, value); }),
    removeItem: vi.fn((key: string) => { items.delete(key); }),
  };
  vi.stubGlobal("localStorage", storage);
  return storage;
}

/** A window this wide, for the panel's width queries; the test DOM answers none by itself. */
function stubWidth(px: number) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: px >= Number(/min-width: (\d+)px/.exec(query)?.[1] ?? 0),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

const ended = (over: Partial<Widget> = {}) => chess({ status: "finished", turn: null, outcome: { winner: "white" }, ...over });

function withCache(widget: Widget) {
  const client = new QueryClient();
  client.setQueryData(queryKeys.mm.widget(widget.widget_id), widget);
  const slot = document.createElement("div");
  document.body.append(slot);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <RightPanelSlotContext value={slot}>{children}</RightPanelSlotContext>
    </QueryClientProvider>
  );
  return { client, wrapper };
}

function column(widget: Widget, { userId = 1, covered = false, picked = false, onDismiss = vi.fn() } = {}) {
  const { client, wrapper } = withCache(widget);
  const props = { widgetId: widget.widget_id, channelId: "c1", userId, picked, onDismiss };
  const view = render(<GameColumn {...props} covered={covered} />, { wrapper });
  // Hidden while covered or dismissed, when it has no name to find it by.
  const aside = () => document.querySelector<HTMLElement>('aside[aria-label="Game"]');
  return { client, aside, rerender: (next: { covered: boolean }) => { view.rerender(<GameColumn {...props} {...next} />); } };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.mocked(actOnWidget).mockClear();
});

describe("GameColumn", () => {
  it("shows the chat's running game beside the chat, open, and gives way while another panel is open", async () => {
    stubStorage();
    const { aside, rerender } = column(chess());
    expect(aside()).toHaveAttribute("data-state", "open");
    expect(await screen.findByRole("region", { name: "Chess" })).toBeInTheDocument();
    rerender({ covered: true });
    expect(aside()).toHaveAttribute("data-state", "none");
    expect(aside()).toHaveAttribute("aria-hidden", "true");
    rerender({ covered: false });
    expect(aside()).toHaveAttribute("data-state", "open");
  });

  it("collapses to a strip that this device remembers, and never opens by itself", async () => {
    const storage = stubStorage();
    const game = chess();
    const { client, aside } = column(game);
    await screen.findByRole("region", { name: "Chess" });
    fireEvent.click(screen.getByRole("button", { name: "Collapse game" }));
    expect(aside()).toHaveAttribute("data-state", "strip");
    expect(storage.setItem).toHaveBeenCalledWith(`fc_widget_view_${game.widget_id}`, "collapsed");
    // The strip: the game's glyph and how it stands, the turn said in words too.
    const strip = screen.getByRole("button", { name: "Chess, White to move, your move" });
    expect(strip).toHaveAttribute("aria-expanded", "false");
    // Moves come and go, and the strip stays a strip, even when the move comes back to you.
    act(() => { applyWidget(client, { ...game, rev: 4, turn: "black", scene: { ...game.scene, status: { text: "Black to move", tone: "neutral" } } }); });
    expect(screen.getByRole("button", { name: "Chess, Black to move" })).toBeInTheDocument();
    act(() => { applyWidget(client, { ...game, rev: 5 }); });
    expect(aside()).toHaveAttribute("data-state", "strip");
    fireEvent.click(screen.getByRole("button", { name: "Chess, White to move, your move" }));
    expect(aside()).toHaveAttribute("data-state", "open");
    expect(storage.setItem).toHaveBeenLastCalledWith(`fc_widget_view_${game.widget_id}`, "open");
  });

  it("opens a game as its strip where this device collapsed it before", () => {
    const game = chess();
    stubStorage({ [`fc_widget_view_${game.widget_id}`]: "collapsed" });
    const { aside } = column(game);
    expect(aside()).toHaveAttribute("data-state", "strip");
    expect(screen.queryByRole("region", { name: "Chess" })).toBeNull();
  });

  it("offers End game only to a player while the game runs, and sends `end` once confirmed", async () => {
    stubStorage();
    const game = chess();
    column(game);
    fireEvent.click(screen.getByRole("button", { name: "End game" }));
    const confirm = await screen.findByRole("dialog");
    expect(actOnWidget).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole("button", { name: "End game" }));
    await waitFor(() => { expect(actOnWidget).toHaveBeenCalledWith(game.widget_id, { type: "end", args: {} }, 3); });
  });

  it("offers a spectator no End game, nor anyone once the game is over", () => {
    stubStorage();
    column(chess(), { userId: 3 });
    expect(screen.queryByRole("button", { name: "End game" })).toBeNull();
    const over = chess({ status: "finished", turn: null, outcome: { winner: "white" } });
    stubStorage({ [`fc_widget_view_${over.widget_id}`]: "open" });
    column(over);
    expect(screen.queryByRole("button", { name: "End game" })).toBeNull();
  });

  it("keeps a game that ends in view with its result, then folds it to a strip that may be dismissed", async () => {
    const storage = stubStorage();
    const game = chess();
    const onDismiss = vi.fn();
    const { client, aside } = column(game, { onDismiss });
    await screen.findByRole("region", { name: "Chess" });
    vi.useFakeTimers();
    act(() => {
      applyWidget(client, {
        ...game,
        rev: 9,
        status: "finished",
        turn: null,
        outcome: { winner: "white", termination: "checkmate" },
        scene: { ...game.scene, status: { text: "Checkmate", tone: "info" } },
      });
    });
    expect(aside()).toHaveAttribute("data-state", "open");
    expect(screen.getByRole("status")).toHaveTextContent("You won");
    act(() => { vi.advanceTimersByTime(6_000); });
    expect(aside()).toHaveAttribute("data-state", "strip");
    expect(screen.getByRole("button", { name: "Chess, You won · Checkmate" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss game" }));
    expect(aside()).toHaveAttribute("data-state", "none");
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(storage.setItem).toHaveBeenLastCalledWith(`fc_widget_view_${game.widget_id}`, "dismissed");
  });

  it("leaves a collapsed game collapsed when it ends", () => {
    const game = chess();
    stubStorage({ [`fc_widget_view_${game.widget_id}`]: "collapsed" });
    const { client, aside } = column(game);
    const stopped = { ...game.scene, status: { text: "A player ended it", tone: "neutral" } };
    act(() => { applyWidget(client, { ...game, rev: 4, status: "aborted", turn: null, outcome: { reason: "stopped" }, scene: stopped }); });
    expect(aside()).toHaveAttribute("data-state", "strip");
    expect(screen.getByRole("button", { name: "Chess, Ended · A player ended it" })).toBeInTheDocument();
  });

  it("shows the result once of a game found over where it would be open, then folds it", () => {
    const over = ended();
    const storage = stubStorage({ [`fc_widget_view_${over.widget_id}`]: "open" });
    vi.useFakeTimers();
    const { aside } = column(over);
    expect(aside()).toHaveAttribute("data-state", "open");
    act(() => { vi.advanceTimersByTime(6_000); });
    expect(aside()).toHaveAttribute("data-state", "strip");
    expect(storage.setItem).toHaveBeenLastCalledWith(`fc_widget_view_${over.widget_id}`, "collapsed");
  });

  it("keeps a game over open where its player picked it from the chat", () => {
    const over = ended();
    stubStorage({ [`fc_widget_view_${over.widget_id}`]: "open" });
    vi.useFakeTimers();
    const { aside } = column(over, { picked: true });
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(aside()).toHaveAttribute("data-state", "open");
  });

  it("holds a result that came while a panel covered the column until it's been in view", () => {
    stubStorage();
    const game = chess();
    vi.useFakeTimers();
    const { client, aside, rerender } = column(game, { covered: true });
    act(() => { applyWidget(client, { ...game, rev: 4, status: "finished", turn: null, outcome: { winner: "white" } }); });
    act(() => { vi.advanceTimersByTime(60_000); });
    rerender({ covered: false });
    expect(aside()).toHaveAttribute("data-state", "open");
    act(() => { vi.advanceTimersByTime(6_000); });
    expect(aside()).toHaveAttribute("data-state", "strip");
  });

  it("sits beside an open panel on a very wide screen", () => {
    stubStorage();
    stubWidth(1700);
    const { aside } = column(chess(), { covered: true });
    expect(aside()).toHaveAttribute("data-state", "open");
  });

  it("waits as its strip where the window has no room for the chat beside it", () => {
    stubStorage();
    stubWidth(1000);
    const { aside, rerender } = column(chess());
    expect(aside()).toHaveAttribute("data-state", "strip");
    rerender({ covered: true });
    expect(aside()).toHaveAttribute("data-state", "none");
  });

  it("hands focus to the strip on Collapse, and back to Collapse when the strip opens", () => {
    stubStorage();
    column(chess());
    const collapse = screen.getByRole("button", { name: "Collapse game" });
    expect(collapse).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(collapse);
    const strip = screen.getByRole("button", { name: "Chess, White to move, your move" });
    expect(strip).toHaveFocus();
    fireEvent.click(strip);
    expect(screen.getByRole("button", { name: "Collapse game" })).toHaveFocus();
  });

  it("says it's your move by the seats the game waits on, the turn where a server sends none", () => {
    // Fleets placed together: both seats are waited on, though the turn names one.
    const setup = chess({
      kind: "battleship",
      turn: "red",
      waiting_on: ["red", "blue"],
      seats: [
        { seat: "red", human_id: 2, agent_id: null, display_name: "Bob" },
        { seat: "blue", human_id: 1, agent_id: null, display_name: "Alice" },
      ],
      scene: { v: 1, title: "Battleship", status: { text: "Place your fleet", tone: "neutral" } },
    });
    stubStorage({ [`fc_widget_view_${setup.widget_id}`]: "collapsed" });
    column(setup);
    expect(screen.getByRole("button", { name: "Battleship, Place your fleet, your move" })).toBeInTheDocument();
    const older = chess({ turn: "black" });
    stubStorage({ [`fc_widget_view_${older.widget_id}`]: "collapsed" });
    column({ ...older, scene: { ...older.scene, status: { text: "Black to move", tone: "neutral" } } }, { userId: 2 });
    expect(screen.getByRole("button", { name: "Chess, Black to move, your move" })).toBeInTheDocument();
  });
});

describe("GameBar", () => {
  it("waits as a slim bar at the top of the chat, and opens into the board on a tap", async () => {
    stubStorage();
    const game = chess();
    const { wrapper } = withCache(game);
    render(<GameBar widgetId={game.widget_id} channelId="c1" userId={1} picked={false} onDismiss={vi.fn()} />, { wrapper });
    const bar = screen.getByRole("button", { name: "Chess, White to move, your move" });
    expect(bar).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("region", { name: "Chess" })).toBeNull();
    expect(screen.queryByRole("button", { name: "End game" })).toBeNull();
    fireEvent.click(bar);
    expect(bar).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findByRole("region", { name: "Chess" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "End game" })).toBeInTheDocument();
    fireEvent.click(bar);
    expect(bar).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("region", { name: "Chess" })).toBeNull();
  });

  it("shows a game's result once, folds it into the bar, and puts it away on Dismiss", () => {
    const over = ended({ status: "aborted", outcome: { reason: "stopped" }, scene: { v: 1, title: "Chess", status: { text: "A player ended it", tone: "neutral" } } });
    const storage = stubStorage({ [`fc_widget_view_${over.widget_id}`]: "open" });
    const { wrapper } = withCache(over);
    const onDismiss = vi.fn();
    vi.useFakeTimers();
    render(<GameBar widgetId={over.widget_id} channelId="c1" userId={1} picked={false} onDismiss={onDismiss} />, { wrapper });
    const bar = screen.getByRole("button", { name: "Chess, Ended · A player ended it" });
    expect(bar).toHaveAttribute("aria-expanded", "true");
    expect(screen.queryByRole("button", { name: "End game" })).toBeNull();
    act(() => { vi.advanceTimersByTime(6_000); });
    expect(bar).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss game" }));
    expect(screen.queryByRole("button", { name: /^Chess/ })).toBeNull();
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(storage.setItem).toHaveBeenLastCalledWith(`fc_widget_view_${over.widget_id}`, "dismissed");
  });
});

describe("WidgetLine", () => {
  it("draws the game's message as one line, its status while it runs and its result once over", () => {
    const game = chess();
    const { client, wrapper } = withCache(game);
    const onOpen = vi.fn();
    render(<WidgetLine widgetId={game.widget_id} channelId="c1" userId={1} onOpen={onOpen} />, { wrapper });
    const line = screen.getByRole("button", { name: "Chess, White to move, your move" });
    expect(line).toHaveTextContent("White to move");
    // No board in the chat: that's the panel's.
    expect(screen.queryByRole("region")).toBeNull();
    fireEvent.click(line);
    expect(onOpen).toHaveBeenCalledWith(game.widget_id);
    const mate = { ...game.scene, status: { text: "Checkmate", tone: "info" } };
    act(() => { applyWidget(client, { ...game, rev: 8, status: "finished", turn: null, outcome: { winner: "black" }, scene: mate }); });
    expect(screen.getByRole("button", { name: "Chess, You lost · Checkmate" })).toHaveTextContent("You lost · Checkmate");
  });
});
