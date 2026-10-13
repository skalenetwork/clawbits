import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";

import type { Widget } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import {
  applyWidget,
  boardsBySeat,
  endOf,
  notesOf,
  panelGameOf,
  resultOf,
  seatOf,
  statusOf,
  waitingOn,
  waitsOn,
} from "@/lib/widgets";

const widget = (over: Partial<Widget> = {}): Widget => ({
  widget_id: "w1",
  channel_id: "c1",
  kind: "chess",
  status: "active",
  rev: 1,
  turn: "white",
  seats: [
    { seat: "white", human_id: 1, agent_id: null, display_name: "Alice" },
    { seat: "black", human_id: 2, agent_id: null, display_name: "Bob" },
  ],
  scene: { v: 1 },
  outcome: null,
  created_by_human_id: 1,
  created_at: "2026-10-07T10:00:00Z",
  updated_at: "2026-10-07T10:00:00Z",
  ...over,
});

describe("applyWidget", () => {
  it("never lets an older rev overwrite a newer one", () => {
    const qc = new QueryClient();
    applyWidget(qc, widget({ rev: 3 }));
    applyWidget(qc, widget({ rev: 2 }));
    expect(qc.getQueryData<Widget>(queryKeys.mm.widget("w1"))?.rev).toBe(3);
    expect(qc.getQueryData<Widget[]>(queryKeys.mm.activeWidgets("c1"))?.map((w) => w.rev)).toEqual([3]);
  });

  it("drops an ended widget from the chat's active list", () => {
    const qc = new QueryClient();
    applyWidget(qc, widget());
    applyWidget(qc, widget({ rev: 2, status: "finished", turn: null }));
    expect(qc.getQueryData<Widget[]>(queryKeys.mm.activeWidgets("c1"))).toEqual([]);
    expect(qc.getQueryData<Widget>(queryKeys.mm.widget("w1"))?.status).toBe("finished");
  });

  it("never brings an ended widget back on an event that arrives late", () => {
    const qc = new QueryClient();
    applyWidget(qc, widget());
    applyWidget(qc, widget({ rev: 2, status: "finished", turn: null }));
    // The move before the end, delivered after it.
    applyWidget(qc, widget({ rev: 1 }));
    expect(qc.getQueryData<Widget[]>(queryKeys.mm.activeWidgets("c1"))).toEqual([]);
    expect(qc.getQueryData<Widget>(queryKeys.mm.widget("w1"))?.status).toBe("finished");
  });
});

describe("seatOf", () => {
  it("finds the viewer's seat, or none for a spectator", () => {
    expect(seatOf(widget(), 2)).toBe("black");
    expect(seatOf(widget(), 3)).toBeNull();
    expect(seatOf(widget(), null)).toBeNull();
  });
});

describe("endOf", () => {
  const ended = (status: "active" | "finished" | "aborted", outcome: Record<string, unknown> | null) =>
    ({ status, outcome }) as Parameters<typeof endOf>[0];
  it("tells the viewer how a widget ended, the same way for every kind", () => {
    expect(endOf(ended("active", null), "white")).toBeNull();
    expect(endOf(ended("aborted", { reason: "idle" }), "white")).toBe("ended");
    expect(endOf(ended("finished", { winner: "white" }), "white")).toBe("won");
    expect(endOf(ended("finished", { winner: "blue" }), "red")).toBe("lost");
    expect(endOf(ended("finished", { winner: null }), "red")).toBe("draw");
    expect(endOf(ended("finished", { winner: "red" }), null)).toBe("finished");
  });
});

describe("boardsBySeat", () => {
  const board = (id: string, seat?: string) => ({ id, seat, cols: ["A"], rows: ["1"] });
  it("sets players beneath their boards only where every board is a seat's own", () => {
    expect(boardsBySeat({ v: 1, boards: [board("red", "red"), board("blue", "blue")] })).toBe(true);
    expect(boardsBySeat({ v: 1, boards: [board("red", "red"), board("sea")] })).toBe(false);
    expect(boardsBySeat({ v: 1, boards: [board("red", "red")] })).toBe(false);
    expect(boardsBySeat({ v: 1, board: { cols: ["a"], rows: ["1"] } })).toBe(false);
  });
});

describe("notesOf", () => {
  it("keeps a game's notes, and none for a card game", () => {
    expect(notesOf({ v: 1, log: ["1. e4"] })).toEqual(["1. e4"]);
    expect(notesOf({ v: 1, table: { rows: [] }, log: ["Hand 1."] })).toEqual([]);
    expect(notesOf({ v: 1 })).toEqual([]);
  });
});

describe("resultOf", () => {
  it("heads the result from the viewer's side, and names the winner for a spectator", () => {
    const over = widget({ status: "finished", outcome: { winner: "white", termination: "resign" } });
    expect(resultOf(over, "white")).toEqual({ end: "won", headline: "You won" });
    expect(resultOf(over, "black")).toEqual({ end: "lost", headline: "You lost" });
    expect(resultOf(over, null)).toEqual({ end: "finished", headline: "Alice won" });
    expect(resultOf(widget({ status: "aborted", outcome: { reason: "idle" } }), "white")?.headline).toBe("Ended");
    expect(resultOf(widget(), "white")).toBeNull();
  });
});

describe("waitingOn", () => {
  it("waits on the seats the server lists, the turn alone where it lists none, and nobody once over", () => {
    const setup = widget({ turn: "white", waiting_on: ["white", "black"] });
    expect(waitingOn(setup)).toEqual(["white", "black"]);
    expect(waitsOn(setup, "black")).toBe(true);
    // An older server: the turn stands in.
    expect(waitingOn(widget({ turn: "black" }))).toEqual(["black"]);
    expect(waitsOn(widget({ turn: "black" }), "white")).toBe(false);
    expect(waitsOn(widget({ turn: "black" }), null)).toBe(false);
    expect(waitingOn(widget({ turn: null }))).toEqual([]);
    expect(waitingOn(widget({ status: "finished", turn: "white", waiting_on: ["white"] }))).toEqual([]);
  });
});

describe("statusOf", () => {
  it("says the scene's status while the game runs, and how it ended and why once over", () => {
    const scene = { v: 1, status: { text: "White to move", tone: "neutral" } };
    expect(statusOf(widget({ scene }), "white")).toBe("White to move");
    const stopped = { v: 1, status: { text: "A player ended it", tone: "neutral" } };
    expect(statusOf(widget({ status: "aborted", outcome: { reason: "stopped" }, scene: stopped }), "white"))
      .toBe("Ended · A player ended it");
    // A reason that only repeats the headline is said once.
    const drawn = { v: 1, status: { text: "Draw", tone: "neutral" } };
    expect(statusOf(widget({ status: "finished", outcome: { winner: null }, scene: drawn }), "white")).toBe("Draw");
    expect(statusOf(widget({ status: "aborted", outcome: { reason: "stopped" } }), "white")).toBe("Ended");
    expect(statusOf(widget(), "white")).toBe("");
  });
});

describe("panelGameOf", () => {
  const none = { picked: null, active: null, posted: null, lastActive: null };
  it("shows the running game, else the latest posted, else the one last seen running", () => {
    expect(panelGameOf(none)).toBeNull();
    expect(panelGameOf({ ...none, active: "w2", posted: "w2", lastActive: "w2" })).toBe("w2");
    // Ended, its message loaded: it stays as its strip.
    expect(panelGameOf({ ...none, posted: "w2", lastActive: "w2" })).toBe("w2");
    // Ended with its message too far back to be loaded: the game last seen running keeps its result in view.
    expect(panelGameOf({ ...none, lastActive: "w2" })).toBe("w2");
  });

  it("shows a game picked from the chat over the running one, until another game starts", () => {
    const picked = { widgetId: "w1", over: "w2" };
    expect(panelGameOf({ ...none, picked, active: "w2", posted: "w2" })).toBe("w1");
    expect(panelGameOf({ ...none, picked, active: "w3", posted: "w3" })).toBe("w3");
    expect(panelGameOf({ ...none, picked: { widgetId: "w1", over: null }, posted: "w2" })).toBe("w1");
  });
});
