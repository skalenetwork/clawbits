import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import WidgetPanel from "./WidgetPanel";
import { actOnWidget, type Widget, type WidgetSceneAction } from "@/lib/api";
import { setPieceSet } from "@/lib/pieceSet";

vi.mock("@/lib/api", async (original) => ({
  ...await original<typeof import("@/lib/api")>(),
  // Never answers: the test looks only at what was sent.
  actOnWidget: vi.fn(() => new Promise<never>(() => undefined)),
}));

const chess = (actions: WidgetSceneAction[]): Widget => ({
  widget_id: "w1",
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
    board: { cols: ["a", "b"], rows: ["1", "2"], pattern: "checker", show_labels: true },
    tokens: [],
    marks: [],
    flip_for: "black",
    actions: { white: actions },
    status: { text: "Black offers a draw · White to move", tone: "neutral" },
  },
  outcome: null,
  created_by_human_id: 1,
  created_at: "2026-10-07T10:00:00Z",
  updated_at: "2026-10-07T10:00:00Z",
});

const fleets = (): Widget => ({
  ...chess([]),
  kind: "battleship",
  turn: "red",
  seats: [
    { seat: "red", human_id: 1, agent_id: null, display_name: "Alice" },
    { seat: "blue", human_id: 2, agent_id: null, display_name: "Bob" },
  ],
  scene: {
    v: 1,
    title: "Battleship",
    boards: [
      { id: "red", seat: "red", label: "Your fleet, 10 afloat", cols: ["A"], rows: ["1"], style: "notebook", origin: "top" },
      { id: "blue", seat: "blue", label: "Enemy waters, 10 afloat", cols: ["A"], rows: ["1"], style: "notebook", origin: "top" },
    ],
    actions: { red: [{ type: "resign", label: "Resign", tone: "danger", confirm: "Resign this game?" }] },
    status: { text: "Your shot", tone: "neutral" },
  },
});

function panel(widget: Widget) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <WidgetPanel widget={widget} userId={1} />
    </QueryClientProvider>,
  );
}

describe("WidgetPanel actions", () => {
  it("puts the answer to a draw offer first, and resign behind a confirmation", () => {
    panel(chess([
      { type: "accept_draw", label: "Accept draw", tone: "primary" },
      { type: "decline_draw", label: "Decline" },
      { type: "resign", label: "Resign", tone: "danger", confirm: "Resign this game?" },
    ]));
    const named = screen.getAllByRole("button").map((b) => b.getAttribute("aria-label"));
    expect(named.filter((n) => ["Accept draw", "Decline", "Resign"].includes(n ?? ""))).toEqual(["Accept draw", "Decline", "Resign"]);
    // Icons, not words: the name is the label, and the button shows its glyph alone.
    expect(screen.getByRole("button", { name: "Accept draw" })).toHaveTextContent("");
    fireEvent.click(screen.getByRole("button", { name: "Resign" }));
    expect(screen.getByText("Resign this game?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("shows a draw it already offered as a state, not a button", () => {
    panel(chess([
      { type: "offer_draw", label: "Draw offered", disabled: true },
      { type: "resign", label: "Resign", tone: "danger", confirm: "Resign this game?" },
    ]));
    expect(screen.getByRole("img", { name: "Draw offered" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Draw offered" })).toBeNull();
    expect(screen.getByRole("button", { name: "Resign" })).toBeInTheDocument();
  });

  it("sends a preset's args, tells same-type actions apart, and shows a seat's note for its name", async () => {
    const widget = chess([
      { type: "raise", label: "Raise to 40", args: { to: 40 } },
      { type: "raise", label: "Raise to 60", args: { to: 60 } },
      { type: "allin", label: "All-in 990", confirm: "Go all-in for 990?" },
    ]);
    panel({ ...widget, scene: { ...widget.scene, seat_notes: { white: "990 chips · dealer" } } });
    expect(screen.getByText("990 chips · dealer")).toBeInTheDocument();
    expect(screen.getByText("black")).toBeInTheDocument();
    // All in on luck: a four-leaf clover.
    expect(screen.getByRole("button", { name: "All-in 990" }).querySelector(".lucide-clover")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Raise to 60" }));
    await waitFor(() => { expect(actOnWidget).toHaveBeenCalledWith("w1", { type: "raise", args: { to: 60 } }, 3); });
  });

  it("picks an amount with a quick pick and a step, then sends it in the action's arg", async () => {
    panel(chess([
      { type: "raise", label: "Raise to", amount: { arg: "to", min: 40, max: 990, step: 10, value: 40, presets: [{ label: "Pot", value: 60 }] } },
    ]));
    expect(screen.getByRole("button", { name: "Less, by 10" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Pot" }));
    expect(screen.getByRole("button", { name: "Pot" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "More, by 10" }));
    expect(screen.getByRole<HTMLInputElement>("slider", { name: "Raise to, amount" }).value).toBe("70");
    fireEvent.click(screen.getByRole("button", { name: "Raise to 70" }));
    await waitFor(() => { expect(actOnWidget).toHaveBeenCalledWith("w1", { type: "raise", args: { to: 70 } }, 3); });
  });

  it("puts the piece-set switch beside a chess board, and flips this device's set from there", () => {
    const widget = chess([]);
    panel({ ...widget, scene: { ...widget.scene, tokens: [{ id: "Ka1", sprite: "chess.wK", at: "a1" }] } });
    const classic = screen.getByRole("button", { name: "Classic pieces" });
    expect(screen.getByRole("button", { name: "Sea pieces" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(classic);
    expect(classic).toHaveAttribute("aria-pressed", "true");
    setPieceSet("sea");
  });

  it("leaves the switch out where no chess pieces are drawn", () => {
    panel(chess([]));
    expect(screen.queryByRole("group", { name: "Chess pieces" })).toBeNull();
  });

  it("keeps the numbers on icon buttons, shows no title or game glyph, and shows how it ended", () => {
    const widget = chess([{ type: "call", label: "Call 980 · all-in" }]);
    const { unmount } = panel(widget);
    expect(screen.getByRole("button", { name: "Call 980 · all-in" })).toHaveTextContent("980");
    // Named for a screen reader; the dock's glyph names it on screen.
    expect(screen.getByRole("region", { name: "Chess" })).toBeInTheDocument();
    expect(screen.queryByText("Chess")).toBeNull();
    expect(screen.queryByRole("img", { name: "Chess" })).toBeNull();
    unmount();
    panel({
      ...widget,
      status: "finished",
      outcome: { winner: "white", termination: "checkmate" },
      scene: { ...widget.scene, status: { text: "Checkmate", tone: "info" } },
    });
    // One line in the middle: a cup and whose win it is; the reason for a screen reader.
    const result = screen.getByRole("status");
    expect(result).toHaveTextContent("You won, Checkmate");
    expect(result.querySelector(".lucide-trophy")).not.toBeNull();
  });

  it("lets the notes take the middle, over the moves, until they're switched off", () => {
    const widget = chess([{ type: "resign", label: "Resign", tone: "danger", confirm: "Resign this game?" }]);
    panel({ ...widget, scene: { ...widget.scene, log: ["1. e4", "e5"] } });
    expect(screen.getByRole("group", { name: "Your moves" })).toContainElement(screen.getByRole("button", { name: "Resign" }));
    fireEvent.click(screen.getByRole("button", { name: "Game notes" }));
    expect(screen.getByText("1. e4 e5")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resign" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Game notes" }));
    expect(screen.queryByText("1. e4 e5")).toBeNull();
    expect(screen.getByRole("button", { name: "Resign" })).toBeInTheDocument();
  });

  it("keeps the game notes behind a button, and marks the seat to move on its avatar", () => {
    const widget = chess([]);
    panel({ ...widget, scene: { ...widget.scene, log: ["1. e4", "e5"] } });
    expect(screen.queryByText("1. e4 e5")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Game notes" }));
    expect(screen.getByText("1. e4 e5")).toBeInTheDocument();
    expect(screen.queryByText("To move")).toBeNull();
    expect(screen.getByText(", to move")).toHaveClass("sr-only");
  });

  it("keeps no notes for a card game", () => {
    const widget = chess([]);
    panel({ ...widget, kind: "poker", scene: { ...widget.scene, table: { rows: [] }, log: ["Hand 1.", "You call 10."] } });
    expect(screen.queryByRole("button", { name: "Game notes" })).toBeNull();
    expect(screen.queryByText(/You call 10/)).toBeNull();
  });

  it("sets the players at either end of a row beneath the boards, named, the moves between them, and no status on show", () => {
    panel(fleets());
    const alice = screen.getByRole("img", { name: "Alice (you), to move" });
    const bob = screen.getByRole("img", { name: "Bob" });
    const resign = screen.getByRole("button", { name: "Resign" });
    // The viewer at the left, the other player at the right, the moves grouped between them.
    const row = alice.parentElement?.parentElement;
    expect(row).toBe(bob.parentElement?.parentElement);
    expect(row?.firstElementChild).toContainElement(alice);
    expect(row?.lastElementChild).toContainElement(bob);
    expect(screen.getByRole("group", { name: "Your moves" })).toContainElement(resign);
    expect(row).toContainElement(resign);
    // Each name beside its avatar, facing the middle.
    expect(alice.parentElement).toHaveTextContent("Alice (you)");
    expect(bob.parentElement).toHaveTextContent("Bob");
    expect(bob.parentElement).toHaveClass("flex-row-reverse");
    // Each player in their seat's own tone, which no button wears; the one to move ringed.
    expect(alice).toHaveClass("bg-(--w-seat-1)");
    expect(alice.className).toContain("var(--w-primary)");
    expect(bob).toHaveClass("bg-(--w-seat-2)");
    expect(bob.className).not.toContain("var(--w-primary)");
    expect(resign.className).not.toContain("--w-seat");
    expect(screen.getByRole("status")).toHaveClass("sr-only");
  });

  it("ends in one line between the players, a loss with a broken heart of its own", () => {
    const widget = fleets();
    panel({
      ...widget,
      status: "finished",
      outcome: { termination: "sunk", winner: "blue" },
      scene: { ...widget.scene, actions: {}, status: { text: "Your fleet is sunk", tone: "info" } },
    });
    const result = screen.getByRole("status");
    expect(screen.getByRole("img", { name: "Alice (you)" }).parentElement?.parentElement).toContainElement(result);
    expect(result.querySelector(".lucide-heart-crack")).not.toBeNull();
    expect(result.querySelector(".lucide-trophy")).toBeNull();
    expect(result).toHaveTextContent("You lost, Your fleet is sunk");
    expect(screen.queryByRole("group", { name: "Your moves" })).toBeNull();
  });
});
