import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";

import type { Widget, WidgetScore } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import {
  applyWidget,
  applyWidgetEvent,
  boardsBySeat,
  endOf,
  linkedGameOf,
  notesOf,
  panelGameOf,
  resultOf,
  scoreLabel,
  scoreLine,
  scoreOf,
  scoreTitle,
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

describe("linkedGameOf", () => {
  it("opens the running game, which is the one waiting, even from an older game's ping", () => {
    expect(linkedGameOf("w1", "w1")).toBe("w1");
    expect(linkedGameOf("w1", "w2")).toBe("w2");
  });

  it("opens the linked game while none runs, to show how it ended", () => {
    expect(linkedGameOf("w1", null)).toBe("w1");
  });
});

describe("scoreOf", () => {
  const scored = (white: number | undefined, black: number | undefined, draws: number | undefined) => widget({
    seats: [
      { seat: "white", human_id: 1, agent_id: null, display_name: "Alice", wins: white },
      { seat: "black", human_id: 2, agent_id: null, display_name: "Bob", wins: black },
    ],
    draws,
  });

  it("reads the chat's score from each player's seat", () => {
    expect(scoreOf(scored(3, 2, 1), 1)).toEqual({ mine: 3, theirs: 2, draws: 1, them: "Bob" });
    expect(scoreOf(scored(3, 2, 1), 2)).toEqual({ mine: 2, theirs: 3, draws: 1, them: "Alice" });
    // Draws alone are a score too.
    expect(scoreOf(scored(0, 0, 2), 1)).toEqual({ mine: 0, theirs: 0, draws: 2, them: "Bob" });
  });

  it("has none for a spectator, a game short of a seat, a chat with nothing finished, or an older server", () => {
    expect(scoreOf(scored(3, 2, 1), 3)).toBeNull();
    expect(scoreOf(scored(3, 2, 1), null)).toBeNull();
    const alone = widget({ seats: [{ seat: "white", human_id: 1, agent_id: null, display_name: "Alice", wins: 3 }], draws: 1 });
    expect(scoreOf(alone, 1)).toBeNull();
    expect(scoreOf(scored(0, 0, 0), 1)).toBeNull();
    expect(scoreOf(scored(undefined, undefined, undefined), 1)).toBeNull();
    expect(scoreOf(widget(), 1)).toBeNull();
  });

  it("says the score in words, the draws only when there are some", () => {
    expect(scoreLabel({ mine: 3, theirs: 2, draws: 1, them: "Bob" })).toBe("score you 3, Bob 2, 1 draw");
    expect(scoreLabel({ mine: 1, theirs: 0, draws: 0, them: null })).toBe("score you 1, opponent 0");
    expect(scoreTitle({ mine: 3, theirs: 2, draws: 2, them: "Bob" })).toBe("You 3 – 2 Bob · 2 draws");
    expect(scoreTitle({ mine: 0, theirs: 1, draws: 0, them: "" })).toBe("You 0 – 1 Opponent");
  });
});

describe("scoreLine", () => {
  const player = (human_id: number | null, display_name: string | null, wins: number, agent_id: string | null = null) =>
    ({ human_id, agent_id, display_name, wins });
  const score = (over: Partial<WidgetScore> = {}): WidgetScore =>
    ({ channel_id: "c1", players: [player(2, "Bob", 3), player(1, "Alice", 2)], draws: 1, finished: 6, ...over });

  it("puts the viewer first, whoever leads", () => {
    expect(scoreLine(score(), 1)).toBe("You 2 – 3 Bob · 1 draw");
    expect(scoreLine(score({ draws: 0 }), 2)).toBe("You 3 – 2 Alice");
    expect(scoreLine(score({ draws: 3 }), 2)).toBe("You 3 – 2 Alice · 3 draws");
  });

  it("names both players for someone not among them, and each player's wins where more have played", () => {
    expect(scoreLine(score(), 9)).toBe("Bob 3 – 2 Alice · 1 draw");
    const three = score({ players: [player(2, "Bob", 3), player(1, "Alice", 2), player(null, null, 1, "helper")], draws: 0 });
    expect(scoreLine(three, 1)).toBe("You 2, Bob 3, helper 1");
  });

  it("has none before a game here has finished, nor once fewer than two players are left", () => {
    expect(scoreLine(undefined, 1)).toBeNull();
    expect(scoreLine(score({ players: [], draws: 0, finished: 0 }), 1)).toBeNull();
    expect(scoreLine(score({ players: [player(1, "Alice", 2)] }), 1)).toBeNull();
  });
});

describe("applyWidgetEvent", () => {
  it("refetches the chat's score when a game finishes there, not on a move or an early end", () => {
    const qc = new QueryClient();
    qc.setQueryData(queryKeys.mm.widgetScore("c1"), { channel_id: "c1", players: [], draws: 0, finished: 0 });
    const stale = () => qc.getQueryState(queryKeys.mm.widgetScore("c1"))?.isInvalidated;
    applyWidgetEvent(qc, widget({ rev: 2 }));
    applyWidgetEvent(qc, widget({ rev: 3, status: "aborted", outcome: { reason: "stopped" } }));
    expect(stale()).toBe(false);
    applyWidgetEvent(qc, widget({ rev: 4, status: "finished", outcome: { winner: "white" } }));
    expect(stale()).toBe(true);
  });
});
