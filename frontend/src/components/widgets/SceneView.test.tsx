import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { SceneView } from "./SceneView";
import type { WidgetScene } from "@/lib/api";

const scene = (over: Partial<WidgetScene> = {}): WidgetScene => ({
  v: 1,
  board: { cols: ["a", "b", "c", "d", "e", "f", "g", "h"], rows: ["1", "2", "3", "4", "5", "6", "7", "8"], pattern: "checker", show_labels: true },
  tokens: [
    { id: "Pe2", sprite: "chess.wP", at: "e2" },
    { id: "Ke1", sprite: "chess.wK", at: "e1" },
    { id: "ke8", sprite: "chess.bK", at: "e8" },
  ],
  marks: [],
  turn: "white",
  flip_for: "black",
  input: { white: { action: "move", pick: { e2: ["e3", "e4"] } } },
  ...over,
});

const square = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name}\\b`) });

describe("SceneView", () => {
  it("lets the seat to move pick a piece and a target", () => {
    const onAct = vi.fn();
    render(<SceneView scene={scene()} seat="white" busy={false} onAct={onAct} />);
    expect(square("e2")).toHaveAccessibleName("e2, white pawn");
    // A click with no pointer behind it is a key press.
    fireEvent.click(square("e2"));
    expect(square("e2")).toHaveAttribute("aria-pressed", "true");
    expect(square("e4")).toHaveAccessibleName("e4, available");
    fireEvent.click(square("e4"));
    expect(onAct).toHaveBeenCalledWith({ type: "move", args: { from: "e2", to: "e4" } });
  });

  it("asks which piece before a promotion", () => {
    const onAct = vi.fn();
    const promoting = scene({
      tokens: [{ id: "Pe2", sprite: "chess.wP", at: "b7" }],
      input: {
        white: {
          action: "move",
          pick: { b7: ["b8"] },
          choose: { b7b8: [{ value: "q", sprite: "chess.wQ" }, { value: "n", sprite: "chess.wN" }] },
        },
      },
    });
    render(<SceneView scene={promoting} seat="white" busy={false} onAct={onAct} />);
    fireEvent.click(square("b7"));
    fireEvent.click(square("b8"));
    expect(onAct).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "white knight" }));
    expect(onAct).toHaveBeenCalledWith({ type: "move", args: { from: "b7", to: "b8", choice: "n" } });
  });

  it("gives a spectator and a waiting seat nothing to act on", () => {
    const { rerender } = render(<SceneView scene={scene()} seat={null} busy={false} onAct={vi.fn()} />);
    expect(square("e2")).toHaveAttribute("tabindex", "-1");
    rerender(<SceneView scene={scene()} seat="black" busy={false} onAct={vi.fn()} />);
    expect(square("e2")).toHaveAttribute("tabindex", "-1");
  });

  it("turns the board for the seat it flips for", () => {
    const { rerender } = render(<SceneView scene={scene()} seat="white" busy={false} onAct={vi.fn()} />);
    expect(screen.getAllByRole("button")[0]).toHaveAccessibleName(/^a8/);
    rerender(<SceneView scene={scene()} seat="black" busy={false} onAct={vi.fn()} />);
    expect(screen.getAllByRole("button")[0]).toHaveAccessibleName(/^h1/);
  });

  it("fires at a tapped cell of the board its input names, in notebook style", () => {
    const onAct = vi.fn();
    const cols = ["A", "B", "C"];
    const rows = ["1", "2", "3"];
    const notebook: WidgetScene = {
      v: 1,
      boards: [
        {
          id: "red", title: "Your fleet · 1 afloat", cols, rows, style: "notebook", origin: "top", show_labels: true,
          tokens: [{ id: "red-0", sprite: "notebook.ship", at: "A1", span: [2, 1] }],
          marks: [{ at: "C3", tone: "hit" }],
        },
        { id: "blue", title: "Enemy waters · 1 afloat", cols, rows, style: "notebook", origin: "top", show_labels: true },
      ],
      input: { red: { action: "fire", board: "blue", tap: ["B2"] } },
    };
    render(<SceneView scene={notebook} seat="red" busy={false} onAct={onAct} />);
    const own = screen.getByRole("grid", { name: "Your fleet · 1 afloat" });
    const enemy = screen.getByRole("grid", { name: "Enemy waters · 1 afloat" });
    // The viewer's own fleet is never a target, and a ship reads as one along its whole length.
    const ownCells = own.querySelectorAll("button");
    expect(ownCells[0]).toHaveAccessibleName("A1, ship");
    expect(ownCells[1]).toHaveAccessibleName("B1, ship");
    expect(ownCells[2]).toHaveAccessibleName("C1");
    expect([...ownCells].every((cell) => cell.getAttribute("tabindex") === "-1")).toBe(true);
    const target = [...enemy.querySelectorAll("button")].find((cell) => cell.getAttribute("aria-label") === "B2, available");
    expect(target).toBeDefined();
    fireEvent.click(target!);
    expect(onAct).toHaveBeenCalledWith({ type: "fire", args: { at: "B2" } });
  });

  it("lays a card table out: faces, backs, empty places, notes, and a winning hand lifted", () => {
    const table: WidgetScene = {
      v: 1,
      table: {
        rows: [
          { id: "blue", seat: "blue", label: "Their cards", cards: ["back", "back"], note: "Bet 40" },
          { id: "board", label: "Board", cards: ["As", "Td", "7c", null, null], note: "Pot 80", lift: [0, 1] },
          { id: "red", seat: "red", label: "Your cards", cards: ["Ah", "Kd"], lift: [0] },
        ],
      },
    };
    render(<SceneView scene={table} seat="red" busy={false} onAct={vi.fn()} />);
    expect(screen.queryByRole("grid")).toBeNull();
    const board = screen.getByRole("group", { name: "Board" });
    expect([...board.querySelectorAll("[role=img]")].map((c) => c.getAttribute("aria-label"))).toEqual([
      "ace of spades", "ten of diamonds", "seven of clubs",
    ]);
    expect(board).toHaveTextContent("Pot 80");
    expect(screen.getByRole("img", { name: "seven of clubs" })).toHaveClass("opacity-55");
    expect(screen.getByRole("img", { name: "ace of hearts" })).toHaveClass("wgt-card-lift");
    expect(screen.getAllByRole("img", { name: "face-down card" })).toHaveLength(2);
    expect(screen.getByRole("group", { name: "Their cards" })).toHaveTextContent("Bet 40");
  });

  it("fans a hand longer than five cards and marks the hand in play", () => {
    const blackjack: WidgetScene = {
      v: 1,
      table: {
        rows: [
          { id: "dealer", label: "Dealer", cards: ["Td", "back"], note: "Dealer shows 10♦" },
          { id: "red-0", label: "Your cards", cards: ["2c", "3d", "2h", "4s", "Ac", "2d", "3c"], note: "17 · bet 100", active: true },
        ],
      },
    };
    render(<SceneView scene={blackjack} seat="red" busy={false} onAct={vi.fn()} />);
    const mine = screen.getByRole("group", { name: "Your cards" });
    expect(mine).toHaveAttribute("aria-current", "true");
    expect(mine.querySelectorAll("[role=img]")).toHaveLength(7);
    expect(mine.firstElementChild?.className).not.toContain("gap-");
    expect(screen.getByRole("group", { name: "Dealer" })).not.toHaveAttribute("aria-current");
  });

  it("takes hold of a ship by any of its cells, moves it by the cell held, and turns it on a second tap", () => {
    const fleet = (): WidgetScene => ({
      v: 1,
      boards: [{
        id: "red",
        label: "Your fleet",
        cols: ["A", "B", "C", "D"],
        rows: ["1", "2", "3", "4"],
        style: "notebook",
        origin: "top",
        tokens: [{ id: "red-0", sprite: "notebook.ship", at: "A1", span: [2, 1] }],
      }],
      input: { red: { action: "move", board: "red", pick: { A1: ["C3", "A1"] } } },
    });
    const cell = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name}\\b`) });
    const onAct = vi.fn();
    const { unmount } = render(<SceneView scene={fleet()} seat="red" busy={false} onAct={onAct} />);
    expect(screen.getByRole("grid", { name: "Your fleet" })).toBeInTheDocument();
    fireEvent.click(cell("B1"));
    expect(cell("A1")).toHaveAttribute("aria-pressed", "true");
    expect(cell("B1")).toHaveAttribute("aria-pressed", "true");
    // Held by its second cell: the first cell may go to C3, so the held cell lands on D3.
    expect(cell("D3")).toHaveAccessibleName("D3, available");
    fireEvent.click(cell("D3"));
    expect(onAct).toHaveBeenLastCalledWith({ type: "move", args: { from: "A1", to: "C3" } });
    unmount();
    render(<SceneView scene={fleet()} seat="red" busy={false} onAct={onAct} />);
    fireEvent.click(cell("A1"));
    fireEvent.click(cell("B1"));
    expect(onAct).toHaveBeenLastCalledWith({ type: "move", args: { from: "A1", to: "A1" } });
  });

  it("turns a held ship with its own button, and keeps it held to turn again", () => {
    const ship = (at: string, span: [number, number], turnable = true): WidgetScene => ({
      v: 1,
      boards: [{
        id: "red",
        label: "Your fleet",
        cols: ["A", "B", "C", "D", "E"],
        rows: ["1", "2", "3", "4", "5"],
        style: "notebook",
        origin: "top",
        tokens: [{ id: "red-0", sprite: "notebook.ship", at, span }],
      }],
      input: { red: { action: "move", board: "red", pick: { [at]: turnable ? ["A5", at] : ["A5"] } } },
    });
    const cell = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name}\\b`) });
    const onAct = vi.fn();
    const { rerender } = render(<SceneView scene={ship("B3", [3, 1])} seat="red" busy={false} onAct={onAct} />);
    expect(screen.queryByRole("button", { name: "Turn the ship" })).toBeNull();
    fireEvent.click(cell("C3"));
    fireEvent.click(screen.getByRole("button", { name: "Turn the ship" }));
    expect(onAct).toHaveBeenLastCalledWith({ type: "move", args: { from: "B3", to: "B3" } });
    // The server turned it about its middle, C3: it is still held there, its button ready to turn it back.
    rerender(<SceneView scene={ship("C2", [1, 3])} seat="red" busy={false} onAct={onAct} />);
    expect(cell("C2")).toHaveAttribute("aria-pressed", "true");
    expect(cell("C4")).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Turn the ship" }));
    expect(onAct).toHaveBeenLastCalledWith({ type: "move", args: { from: "C2", to: "C2" } });
    // Turned back, and still held; hemmed in now, the button stays to say so, and does nothing.
    rerender(<SceneView scene={ship("B3", [3, 1], false)} seat="red" busy={false} onAct={onAct} />);
    expect(cell("B3")).toHaveAttribute("aria-pressed", "true");
    const blocked = screen.getByRole("button", { name: "No room to turn the ship here" });
    expect(blocked).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(blocked);
    expect(onAct).toHaveBeenCalledTimes(2);
  });

  it("drags a piece that moves slowly, a pixel or two at a time", () => {
    const onAct = vi.fn();
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      { left: 0, top: 0, width: 400, height: 400, right: 400, bottom: 400, x: 0, y: 0, toJSON: () => ({}) },
    );
    HTMLElement.prototype.setPointerCapture = vi.fn();
    try {
      const { container } = render(<SceneView scene={scene()} seat="white" busy={false} onAct={onAct} />);
      const grid = screen.getByRole("grid");
      // e2 is the fifth file and the second rank: its centre at (225, 325) on a 400px board.
      fireEvent.pointerDown(grid, { button: 0, clientX: 225, clientY: 325 });
      for (let step = 1; step <= 6; step++) fireEvent.pointerMove(grid, { clientX: 225, clientY: 325 - step * 2 });
      expect(container.querySelector(".will-change-transform")).not.toBeNull();
      // On to e4, slowly still, and let go there.
      for (let y = 311; y >= 225; y -= 3) fireEvent.pointerMove(grid, { clientX: 225, clientY: y });
      fireEvent.pointerUp(grid, { clientX: 225, clientY: 225 });
      expect(onAct).toHaveBeenCalledWith({ type: "move", args: { from: "e2", to: "e4" } });
    } finally {
      rect.mockRestore();
    }
  });

  it("keeps a dragged piece's middle under the pointer, lifted about it", () => {
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      { left: 0, top: 0, width: 400, height: 400, right: 400, bottom: 400, x: 0, y: 0, toJSON: () => ({}) },
    );
    HTMLElement.prototype.setPointerCapture = vi.fn();
    try {
      const { container } = render(<SceneView scene={scene()} seat="white" busy={false} onAct={vi.fn()} />);
      const grid = screen.getByRole("grid");
      fireEvent.pointerDown(grid, { button: 0, clientX: 225, clientY: 325 });
      fireEvent.pointerMove(grid, { clientX: 140, clientY: 190 });
      // Moved by the pointer less half a 50px cell, then grown in place: grown first, the move would grow too.
      const piece = container.querySelector<HTMLElement>(".will-change-transform");
      expect(piece?.style.transform).toBe("translate(115px, 165px) scale(1.1)");
      expect(piece?.className).not.toMatch(/\bscale-/);
    } finally {
      rect.mockRestore();
    }
  });
});
