import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import type { Channel, Organization } from "./models";
import {
  actionKey,
  activeWidgetsKey,
  applyWidget,
  applyWidgetEvent,
  boardCells,
  boardsBySeat,
  canPlay,
  cardLabel,
  drawsChessPieces,
  endOf,
  displayOf,
  freshActiveWidgets,
  freshWidget,
  fanMargin,
  logLine,
  normalizeBoards,
  notesOf,
  parseCard,
  resultOf,
  seatOf,
  snapAmount,
  spriteLabel,
  widgetKey,
  widgetPostIndex,
  type Widget,
  type WidgetBoardLayout,
} from "./widgets";

const widget = (rev: number, status: Widget["status"] = "active", hidden = false): Widget => ({
  widget_id: "w1",
  channel_id: "c1",
  kind: "chess",
  status,
  rev,
  turn: "white",
  seats: [
    { seat: "white", human_id: 1, agent_id: null, display_name: "Alice" },
    { seat: "black", human_id: 2, agent_id: null, display_name: "Bob" },
  ],
  scene: { v: 1 },
  private: hidden,
  outcome: null,
  created_by_human_id: 1,
  created_at: "2026-10-08T10:00:00Z",
  updated_at: "2026-10-08T10:00:00Z",
});

const chess: WidgetBoardLayout = {
  cols: ["a", "b", "c", "d", "e", "f", "g", "h"],
  rows: ["1", "2", "3", "4", "5", "6", "7", "8"],
  pattern: "checker",
};

describe("widget caches", () => {
  test("a newer rev wins, an older one is ignored, and an ended widget leaves the dock", () => {
    const client = new QueryClient();
    applyWidget(client, widget(3));
    applyWidget(client, widget(2));
    expect(client.getQueryData<Widget>(widgetKey("w1"))?.rev).toBe(3);
    expect(client.getQueryData<Widget[]>(activeWidgetsKey("c1"))?.map((w) => w.rev)).toEqual([3]);
    applyWidget(client, widget(4, "finished"));
    expect(client.getQueryData<Widget[]>(activeWidgetsKey("c1"))).toEqual([]);
    // The move before the end, delivered after it, doesn't bring the game back.
    applyWidget(client, widget(3));
    expect(client.getQueryData<Widget[]>(activeWidgetsKey("c1"))).toEqual([]);
    expect(client.getQueryData<Widget>(widgetKey("w1"))?.status).toBe("finished");
  });

  test("a private widget's event refetches the viewer's own scene instead of showing the public one", () => {
    const client = new QueryClient();
    applyWidget(client, widget(3, "active", true));
    applyWidgetEvent(client, widget(3, "active", true));
    expect(client.getQueryState(widgetKey("w1"))?.isInvalidated).toBe(false);
    applyWidgetEvent(client, { ...widget(4, "active", true), scene: { v: 1, title: "public" } });
    expect(client.getQueryData<Widget>(widgetKey("w1"))?.rev).toBe(3);
    expect(client.getQueryState(widgetKey("w1"))?.isInvalidated).toBe(true);
  });
});

describe("seats and where games run", () => {
  test("the viewer's seat, or none for a spectator", () => {
    expect(seatOf(widget(1), 2)).toBe("black");
    expect(seatOf(widget(1), 9)).toBeNull();
  });

  test("a game needs a chat between two people in an org that allows them", () => {
    const dm = { channel_type: "direct", dm_peer_human_id: 2 } as Channel;
    const org = { widgets_enabled: true } as Organization;
    expect(canPlay(dm, org)).toBe(true);
    expect(canPlay(dm, { widgets_enabled: false } as Organization)).toBe(false);
    expect(canPlay({ channel_type: "direct", dm_peer_human_id: null } as Channel, org)).toBe(false);
    expect(canPlay({ channel_type: "agent_chat" } as Channel, org)).toBe(false);
  });
});

describe("boards", () => {
  test("white sees a1 at the bottom left, black sees it at the top right", () => {
    expect(displayOf(chess, false, 0, 0)).toEqual({ dx: 0, dy: 7 });
    expect(displayOf(chess, true, 0, 0)).toEqual({ dx: 7, dy: 0 });
    const cells = boardCells(chess, false);
    expect(cells[0]).toMatchObject({ name: "a8", dx: 0, dy: 0, dark: false });
    expect(cells.at(-1)).toMatchObject({ name: "h1", dx: 7, dy: 7, dark: false });
    expect(cells.find((c) => c.name === "a1")?.dark).toBe(true);
  });

  test("a notebook counts its rows down from the top", () => {
    const notebook: WidgetBoardLayout = { cols: ["A", "B"], rows: ["1", "2"], origin: "top", style: "notebook" };
    expect(boardCells(notebook, false).map((c) => c.name)).toEqual(["A1", "B1", "A2", "B2"]);
  });

  test("one board folds its tokens in; several stay as they are", () => {
    const tokens = [{ id: "Ke1", sprite: "chess.wK", at: "e1" }];
    expect(normalizeBoards({ v: 1, board: chess, tokens })).toEqual([{ id: "main", ...chess, tokens, marks: undefined }]);
    expect(normalizeBoards({ v: 1 })).toEqual([]);
  });

  test("sprites and cards read out in words", () => {
    expect(spriteLabel("chess.bN")).toBe("black knight");
    expect(spriteLabel("notebook.sunk")).toBe("sunk ship");
    expect(parseCard("Td")).toEqual({ rank: "10", suit: "d" });
    expect(parseCard("back")).toBeNull();
    expect([cardLabel("As"), cardLabel("back"), cardLabel(null)]).toEqual(["ace of spades", "face-down card", "empty place"]);
  });
});

describe("tables and amounts", () => {
  test("a row past five cards fans to the width of five", () => {
    expect(fanMargin(5)).toBeNull();
    expect(fanMargin(6)).toBeCloseTo(-0.12);
    const seven = fanMargin(7)!;
    expect(1 + 6 * (1 + seven)).toBeCloseTo(5.4);
  });

  test("an amount snaps to its steps and keeps its bounds", () => {
    const raise = { arg: "to", min: 40, max: 995, step: 10, value: 40 };
    expect(snapAmount(raise, 63)).toBe(60);
    expect(snapAmount(raise, 10)).toBe(40);
    expect(snapAmount(raise, 991)).toBe(990);
    expect(snapAmount(raise, 995)).toBe(995);
    expect(snapAmount(raise, 2000)).toBe(995);
  });

  test("actions of one type are told apart by their args", () => {
    expect(actionKey({ type: "raise", label: "Raise to 40", args: { to: 40 } })).not.toBe(
      actionKey({ type: "raise", label: "Raise to 60", args: { to: 60 } }),
    );
  });

  test("the log's tail reads as one line", () => {
    expect(logLine(undefined)).toBe("");
    expect(logLine(["a.", "b.", "c."], 2)).toBe("… b. c.");
  });
});

describe("piece-set switch", () => {
  test("shows beside a scene that draws chess pieces, and nowhere else", () => {
    expect(drawsChessPieces({ v: 1, tokens: [{ id: "Ke1", sprite: "chess.wK", at: "e1" }] })).toBe(true);
    expect(drawsChessPieces({ v: 1, boards: [{ id: "red", cols: ["A"], rows: ["1"], tokens: [{ id: "s", sprite: "notebook.ship", at: "A1" }] }] })).toBe(false);
    expect(drawsChessPieces({ v: 1, table: { rows: [] } })).toBe(false);
  });
});

describe("how a widget ended", () => {
  test("the same few ways for every kind, from the viewer's seat", () => {
    expect(endOf(widget(1), "white")).toBeNull();
    expect(endOf({ ...widget(1, "aborted"), outcome: { reason: "idle" } }, "white")).toBe("ended");
    expect(endOf({ ...widget(1, "finished"), outcome: { winner: "white" } }, "white")).toBe("won");
    expect(endOf({ ...widget(1, "finished"), outcome: { winner: "white" } }, "black")).toBe("lost");
    expect(endOf({ ...widget(1, "finished"), outcome: { winner: null } }, "black")).toBe("draw");
    expect(endOf({ ...widget(1, "finished"), outcome: { winner: "white" } }, null)).toBe("finished");
  });
});

describe("players beneath their boards", () => {
  const board = (id: string, seat?: string) => ({ id, seat, cols: ["A"], rows: ["1"] });
  test("only where every board is a seat's own", () => {
    expect(boardsBySeat({ v: 1, boards: [board("red", "red"), board("blue", "blue")] })).toBe(true);
    expect(boardsBySeat({ v: 1, boards: [board("red", "red"), board("sea")] })).toBe(false);
    expect(boardsBySeat({ v: 1, boards: [board("red", "red")] })).toBe(false);
    expect(boardsBySeat({ v: 1, board: { cols: ["a"], rows: ["1"] } })).toBe(false);
  });
});

describe("the dock's jump", () => {
  const posts = [{ post_id: 7 }, { post_id: 9, widget_id: "w1" }, { post_id: 12 }];
  test("finds the message that started the game, by its id or else by the game", () => {
    expect(widgetPostIndex(posts, { ...widget(1), post_id: 9 })).toBe(1);
    expect(widgetPostIndex(posts, { ...widget(1), post_id: null })).toBe(1);
    expect(widgetPostIndex(posts, { ...widget(1), post_id: 3 })).toBe(-1);
  });
});

describe("game notes", () => {
  test("a game keeps its notes, a card game none", () => {
    expect(notesOf({ v: 1, log: ["1. e4"] })).toEqual(["1. e4"]);
    expect(notesOf({ v: 1, table: { rows: [] }, log: ["Hand 1."] })).toEqual([]);
    expect(notesOf({ v: 1 })).toEqual([]);
  });
});

describe("the result", () => {
  test("heads it from the viewer's side, and names the winner for a spectator", () => {
    const over = { ...widget(1, "finished"), outcome: { winner: "white", termination: "resign" } };
    expect(resultOf(over, "white")).toEqual({ end: "won", headline: "You won" });
    expect(resultOf(over, "black")).toEqual({ end: "lost", headline: "You lost" });
    expect(resultOf(over, null)?.end).toBe("finished");
    expect(resultOf(widget(1), "white")).toBeNull();
  });
});

describe("answers that arrive late", () => {
  test("a slow fetch never undoes a newer rev an event brought while it was out", () => {
    const client = new QueryClient();
    applyWidget(client, widget(2));
    expect(freshWidget(client, widget(1)).rev).toBe(2);
    expect(freshWidget(client, widget(3)).rev).toBe(3);
  });

  test("a slow active list keeps a game that ended meanwhile off, and seeds the widgets it brings", () => {
    const client = new QueryClient();
    applyWidget(client, widget(2, "finished"));
    expect(freshActiveWidgets(client, [widget(1)])).toEqual([]);
    expect(client.getQueryData<Widget>(widgetKey("w1"))?.status).toBe("finished");
    const other = { ...widget(5), widget_id: "w2" };
    expect(freshActiveWidgets(client, [other])).toEqual([other]);
    expect(client.getQueryData<Widget>(widgetKey("w2"))?.rev).toBe(5);
  });
});
