import { notifyManager } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import {
  applyActivity,
  countOf,
  endChannelTurns,
  headlineOf,
  heldHeadline,
  keepTurn,
  keptTurn,
  liveTurns,
  memberStatus,
  offerHeadline,
  presenceSnapshot,
  replyPublished,
  currentSentence,
  segmentOf,
  toggleTrace,
  traceOpen,
  withThoughts,
  type LiveTurn,
  type Thought,
} from "./liveTurn";
import type { AgentActivity, Post, TurnStep } from "./models";

const fold = (events: AgentActivity[], from: LiveTurn = { key: "t", steps: [], thoughts: [] }): LiveTurn =>
  events.reduce(applyActivity, from);

const call = (id: string, ok: boolean | null = null): TurnStep => ({
  kind: "tool",
  id,
  label: `exec: '${id}'`,
  tool: "exec",
  ok,
  duration_ms: null,
});

const note = (id: string, label: string): TurnStep => ({ kind: "note", id, label, tool: null, ok: null, duration_ms: null });

function offer(key: string, steps: TurnStep[], thoughts: Thought[] = []): void {
  const next = headlineOf({ key, steps, thoughts });
  if (next) offerHeadline(key, next);
}

const thinking = (member_id: string, label: string) =>
  ({ member_kind: "agent", member_id, status: "generating", activity: { kind: "thinking", label } }) as const;

const reply = (channel_id: string, agent_id: string, post_id: number): Post => ({
  post_id,
  channel_id,
  agent_id,
  human_id: null,
  poster_display_name: null,
  message: "Done.",
  status: "published",
  created_at: "2026-09-28T16:10:00Z",
  updated_at: null,
  files: [],
});

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe("applyActivity", () => {
  test("keeps parallel calls apart by id and closes each with its own outcome", () => {
    const { steps } = fold([
      { kind: "tool", id: "a", tool: "exec", label: "gh issue list" },
      { kind: "tool", id: "b", tool: "exec", label: "gh pr list" },
      { kind: "tool_done", id: "b", tool: "exec", ok: true, duration_ms: 900 },
      { kind: "tool_done", id: "a", tool: "exec", ok: true, duration_ms: 1500 },
      { kind: "tool_done", id: "a", tool: "exec", ok: false },
    ]);
    expect(steps).toEqual([
      { kind: "tool", id: "a", label: "gh issue list", tool: "exec", ok: false, duration_ms: 1500 },
      { kind: "tool", id: "b", label: "gh pr list", tool: "exec", ok: true, duration_ms: 900 },
    ]);
  });

  test("pairs by order for plugins that send no ids, keeping the start's command", () => {
    const { steps } = fold([
      { kind: "tool", tool: "read", label: "a.md" },
      { kind: "tool", tool: "read", label: "a.md" },
      { kind: "tool_done", tool: "read", label: "read", ok: true },
      { kind: "tool", tool: "exec", label: "ls" },
      { kind: "tool_done", tool: "exec", ok: false },
    ]);
    expect(steps.map((s) => [s.tool, s.label, s.ok])).toEqual([
      ["read", "a.md", true],
      ["exec", "ls", false],
    ]);
  });

  test("stitches thinking into bursts beside the steps, each placed by how many steps came before it", () => {
    const thought = fold([
      { kind: "thinking", label: "The user wants the open issues" },
      { kind: "thinking", label: "…the open issues, so list them first." },
    ]);
    expect(thought.thoughts).toEqual([{ at: 0, text: "The user wants the open issues, so list them first." }]);
    const acted = fold(
      [
        { kind: "note", id: "m1", label: "Listing" },
        { kind: "note", id: "m1", label: "Listing the open issues." },
        { kind: "tool", id: "c1", tool: "exec", label: "gh issue list" },
        { kind: "thinking", label: "Three are in triage." },
        { kind: "thinking", label: "Three are in triage. Check the oldest." },
      ],
      thought,
    );
    expect(acted).toEqual({
      key: "t",
      steps: [note("m1", "Listing the open issues."), { ...call("c1"), label: "gh issue list" }],
      thoughts: [
        { at: 0, text: "The user wants the open issues, so list them first." },
        { at: 2, text: "Three are in triage. Check the oldest." },
      ],
    });
  });

  test("keeps the burst going when a call only finishes", () => {
    const turn = fold([
      { kind: "tool", id: "c1", tool: "exec", label: "ls" },
      { kind: "thinking", label: "Now read" },
      { kind: "tool_done", id: "c1", tool: "exec", ok: true },
      { kind: "thinking", label: "Now read the output." },
    ]);
    expect(turn.thoughts).toEqual([{ at: 1, text: "Now read the output." }]);
  });

  test("ignores an empty tail", () => {
    const turn = fold([{ kind: "thinking", label: "  " }]);
    expect(turn.thoughts).toEqual([]);
  });

  test("opens no burst for a tail the latest one already holds, as the heartbeat repeats it after a step", () => {
    const turn = fold([
      { kind: "thinking", label: "List the issues, then label them." },
      { kind: "tool", id: "c1", tool: "exec", label: "gh issue list" },
      { kind: "thinking", label: "…then label them." },
    ]);
    expect(turn.thoughts).toEqual([{ at: 0, text: "List the issues, then label them." }]);
    expect(headlineOf(turn)).toMatchObject({ kind: "tool", key: "c1" });
  });
});

describe("keepTurn", () => {
  test("anchors each burst to the id of the step that followed it", () => {
    const steps = [note("m1", "Listing."), call("a")];
    const thoughts = [
      { at: 0, text: "First." },
      { at: 2, text: "Last." },
    ];
    expect(keepTurn({ key: "t", steps, thoughts })).toEqual({
      steps,
      thoughts: [
        { before: "m1", text: "First." },
        { before: undefined, text: "Last." },
      ],
    });
  });
});

describe("withThoughts", () => {
  test("puts each burst just before the step that followed it, and after the last when that step is not here", () => {
    const steps = [note("m1", "Listing."), call("a"), call("b")];
    const thoughts = [
      { before: "m1", text: "First." },
      { before: "b", text: "Between." },
      { before: "gone", text: "Before a step never saved." },
      { before: undefined, text: "After." },
    ];
    expect(withThoughts(steps, thoughts)).toEqual([
      thoughts[0],
      steps[0],
      steps[1],
      thoughts[1],
      steps[2],
      thoughts[2],
      thoughts[3],
    ]);
  });
});

describe("countOf", () => {
  test("counts tool steps, else reads Thought once the segment stops saying it, else nothing", () => {
    const hm = [{ before: undefined, text: "Hm." }];
    expect(countOf([call("a"), note("m1", "Listing."), call("b")], [], true)).toBe("2 steps");
    expect(countOf([call("a")], hm, true)).toBe("1 step");
    expect(countOf([], hm, false)).toBe("Thought");
    expect(countOf([note("m1", "Listing.")], [], false)).toBe("Thought");
    expect(countOf([], hm, true)).toBeUndefined();
    expect(countOf([note("m1", "Listing.")], [], true)).toBeUndefined();
    expect(countOf([], [], false)).toBeUndefined();
  });
});

describe("headlineOf", () => {
  test("heads the turn with its newest signal, without closing punctuation", () => {
    const done = call("c1", true);
    expect(headlineOf({ key: "t", steps: [], thoughts: [] })).toBeUndefined();
    expect(headlineOf({ key: "t", steps: [done], thoughts: [{ at: 1, text: "Checking the output. Then the" }] })).toEqual({
      kind: "thinking",
      key: "thinking:1:1",
      text: "Then the",
    });
    expect(headlineOf({ key: "t", steps: [done], thoughts: [{ at: 1, text: "Checking the output." }] })).toEqual({
      kind: "thinking",
      key: "thinking:1:0",
      text: "Checking the output",
    });
    expect(headlineOf({ key: "t", steps: [done], thoughts: [{ at: 0, text: "Before the call." }] })).toEqual({
      kind: "tool",
      key: "c1",
      step: done,
    });
    expect(headlineOf({ key: "t", steps: [done, note("m1", "Listing.")], thoughts: [] })).toEqual({
      kind: "note",
      key: "m1",
      text: "Listing",
    });
  });

  test("drops a leading stitch gap, and closing punctuation inside a closing quote or bracket", () => {
    const text = (thought: string) => {
      const headline = headlineOf({ key: "t", steps: [], thoughts: [{ at: 0, text: thought }] });
      return headline?.kind === "thinking" ? headline.text : undefined;
    };
    expect(text("One. … two three")).toBe("two three");
    expect(text('…It said "done."')).toBe('It said "done"');
    expect(text("Check the log (see above.)")).toBe("Check the log (see above)");
  });
});

describe("currentSentence", () => {
  test("is the sentence being written, keeping dotted names and versions whole", () => {
    expect(currentSentence("Reading SKILL.md for the v2.3 rules. Then e.g")).toEqual({ index: 1, text: "Then e.g" });
    expect(currentSentence("First; second: third")).toEqual({ index: 0, text: "First; second: third" });
    expect(currentSentence('I ran it (see the log.) It said "done." Next')).toEqual({ index: 2, text: "Next" });
  });

  test("is the last complete sentence when the text stops at one, and nothing for no text", () => {
    expect(currentSentence("Reading SKILL.md for the v2.3 rules.")).toEqual({
      index: 0,
      text: "Reading SKILL.md for the v2.3 rules.",
    });
    expect(currentSentence('I ran it. It said "done." ')).toEqual({ index: 1, text: 'It said "done."' });
    expect(currentSentence(" ")).toBeUndefined();
  });
});

describe("segmentOf", () => {
  test("warms up before the first signal, then reads thinking behind its label and narration bare", () => {
    expect(segmentOf([], undefined, false)).toEqual({ kind: "text", key: "word", text: "Warming up", live: true });
    expect(segmentOf([], { kind: "thinking", key: "k", text: "Checking how triage works" }, false)).toEqual({
      kind: "text",
      key: "k",
      text: "Thinking · Checking how triage works",
      live: true,
    });
    expect(segmentOf([], { kind: "note", key: "m1", text: "Pulling this week's issues" }, false)).toEqual({
      kind: "text",
      key: "m1",
      text: "Pulling this week's issues",
      live: true,
    });
  });

  test("counts the other calls running beside the shown one", () => {
    const steps = [call("a"), call("b"), call("c", true)];
    expect(segmentOf(steps, { kind: "tool", key: "b", step: call("b") }, false)).toEqual({
      kind: "tool",
      key: "b",
      step: call("b"),
      more: 1,
      live: true,
    });
  });

  test("holds a finished tool static, so the count carries the effect, even beside running calls", () => {
    const failed = call("a", false);
    expect(segmentOf([failed], { kind: "tool", key: "a", step: failed }, false)).toMatchObject({ more: 0, live: false });
    expect(segmentOf([failed, call("b")], { kind: "tool", key: "a", step: failed }, false)).toMatchObject({
      more: 0,
      live: false,
    });
    expect(segmentOf([failed, call("b")], { kind: "tool", key: "a", step: failed }, true)).toBeUndefined();
  });

  test("says nothing while the reply streams unless a tool runs", () => {
    expect(segmentOf([], undefined, true)).toBeUndefined();
    expect(segmentOf([], { kind: "thinking", key: "k", text: "Done" }, true)).toBeUndefined();
    expect(segmentOf([call("a", true)], { kind: "tool", key: "a", step: call("a", true) }, true)).toBeUndefined();
    expect(segmentOf([call("a")], { kind: "tool", key: "a", step: call("a") }, true)).toMatchObject({ key: "a", live: true });
  });
});

describe("live turns", () => {
  test("fold an agent's status lane and end on any other status", () => {
    memberStatus("c1", { member_kind: "human", member_id: "7", status: "typing" });
    memberStatus("c1", { member_kind: "agent", member_id: "a", status: "generating" });
    expect(liveTurns("c1")).toEqual({ a: { key: "turn:c1:agent:a", steps: [], thoughts: [] } });
    memberStatus("c1", {
      member_kind: "agent",
      member_id: "a",
      status: "generating",
      activity: { kind: "tool", id: "x", tool: "exec", label: "ls" },
    });
    expect(liveTurns("c1").a?.steps).toEqual([{ ...call("x"), label: "ls" }]);
    memberStatus("c1", { member_kind: "agent", member_id: "a", status: "online" });
    expect(liveTurns("c1")).toEqual({});
  });

  test("end 15s after the agent's last generating status", () => {
    memberStatus("c2", { member_kind: "agent", member_id: "a", status: "generating" });
    jest.advanceTimersByTime(10_000);
    memberStatus("c2", { member_kind: "agent", member_id: "a", status: "generating" });
    jest.advanceTimersByTime(14_999);
    expect(liveTurns("c2").a).toBeDefined();
    jest.advanceTimersByTime(1);
    expect(liveTurns("c2").a).toBeUndefined();
  });

  test("end when the agent's reply publishes, handing an open trace and the turn to it", () => {
    memberStatus("c3", thinking("a", "Checking the folder."));
    memberStatus("c3", {
      member_kind: "agent",
      member_id: "a",
      status: "generating",
      activity: { kind: "tool", id: "x", tool: "exec", label: "ls" },
    });
    toggleTrace("turn:c3:agent:a");
    offer("turn:c3:agent:a", [call("x")]);
    replyPublished(reply("c3", "a", 42));
    expect(liveTurns("c3").a).toBeUndefined();
    expect(heldHeadline("turn:c3:agent:a")).toBeUndefined();
    expect([traceOpen("turn:c3:agent:a"), traceOpen("42")]).toEqual([false, true]);
    expect(keptTurn("c3", "42")).toEqual({
      steps: [{ ...call("x"), label: "ls" }],
      thoughts: [{ before: "x", text: "Checking the folder." }],
    });
  });

  test("keep nothing for a turn that ends without a reply", () => {
    memberStatus("c7", thinking("a", "Checking the folder."));
    memberStatus("c7", { member_kind: "agent", member_id: "a", status: "online" });
    replyPublished(reply("c7", "a", 43));
    expect(keptTurn("c7", "43")).toBeUndefined();
  });

  test("hand a reply its turn when the agent's next status follows in the same tick, as the event stream orders them", () => {
    memberStatus("c8", thinking("a", "Checking the folder."));
    toggleTrace("turn:c8:agent:a");
    notifyManager.batch(() => {
      notifyManager.schedule(() => {
        replyPublished(reply("c8", "a", 44));
      });
    });
    notifyManager.schedule(() => {
      memberStatus("c8", { member_kind: "agent", member_id: "a", status: "online" });
    });
    expect(liveTurns("c8").a).toBeDefined();
    jest.runAllTimers();
    expect(liveTurns("c8").a).toBeUndefined();
    expect(traceOpen("44")).toBe(true);
    expect(keptTurn("c8", "44")?.thoughts).toEqual([{ before: undefined, text: "Checking the folder." }]);
  });

  test("follow a presence snapshot: a followed turn keeps its steps, a mid-turn join seeds, the rest end", () => {
    memberStatus("c4", {
      member_kind: "agent",
      member_id: "a",
      status: "generating",
      activity: { kind: "tool", id: "x", tool: "exec", label: "ls" },
    });
    memberStatus("c4", { member_kind: "agent", member_id: "b", status: "generating" });
    presenceSnapshot("c4", [
      { member_kind: "agent", member_id: "a", status: "generating", activity: { kind: "tool", id: "y", tool: "exec" } },
      { member_kind: "agent", member_id: "b", status: "idle" },
      { member_kind: "agent", member_id: "c", status: "generating", activity: { kind: "note", id: "m", label: "Looking." } },
    ]);
    expect(Object.keys(liveTurns("c4"))).toEqual(["a", "c"]);
    expect(liveTurns("c4").a?.steps.map((s) => s.id)).toEqual(["x"]);
    expect(liveTurns("c4").c?.steps).toEqual([note("m", "Looking.")]);
  });

  test("end with the channel, with their headlines, open traces and the turns its replies kept", () => {
    memberStatus("c5", thinking("b", "Checking the folder."));
    replyPublished(reply("c5", "b", 45));
    memberStatus("c5", { member_kind: "agent", member_id: "a", status: "generating" });
    memberStatus("c6", thinking("a", "Checking the folder."));
    replyPublished(reply("c6", "a", 46));
    memberStatus("c6", { member_kind: "agent", member_id: "a", status: "generating" });
    offer("turn:c5:agent:a", [call("x")]);
    toggleTrace("turn:c5:agent:a");
    endChannelTurns("c5");
    expect(liveTurns("c5")).toEqual({});
    expect(heldHeadline("turn:c5:agent:a")).toBeUndefined();
    expect(traceOpen("turn:c5:agent:a")).toBe(false);
    expect(keptTurn("c5", "45")).toBeUndefined();
    expect(liveTurns("c6").a).toBeDefined();
    expect(keptTurn("c6", "46")).toBeDefined();
  });
});

describe("offerHeadline", () => {
  test("shows the first signal at once, holds each headline 500ms and lets the latest pending win", () => {
    offer("turn:hold", [call("a")]);
    expect(heldHeadline("turn:hold")?.key).toBe("a");
    offer("turn:hold", [call("a"), call("b")]);
    offer("turn:hold", [call("a"), call("b"), call("c")]);
    expect(heldHeadline("turn:hold")?.key).toBe("a");
    jest.advanceTimersByTime(500);
    expect(heldHeadline("turn:hold")?.key).toBe("c");
  });

  test("never shows a tool that starts and ends inside the hold", () => {
    offer("turn:blink", [call("a")]);
    offer("turn:blink", [call("a"), call("b")]);
    offer("turn:blink", [call("a"), call("b", true)]);
    jest.advanceTimersByTime(500);
    expect(heldHeadline("turn:blink")?.key).toBe("a");
    offer("turn:blink", [call("a"), call("b", true), call("c")]);
    expect(heldHeadline("turn:blink")?.key).toBe("c");
  });

  test("keeps a finished tool until the next signal, then moves forward", () => {
    offer("turn:rest", [call("a")]);
    jest.advanceTimersByTime(600);
    offer("turn:rest", [call("a", false)]);
    expect(heldHeadline("turn:rest")).toEqual({ kind: "tool", key: "a", step: call("a", false) });
    offer("turn:rest", [call("a", false)], [{ at: 1, text: "Checking the output. Then" }]);
    expect(heldHeadline("turn:rest")).toEqual({ kind: "thinking", key: "thinking:1:1", text: "Then" });
  });

  test("refreshes thinking at most every 1.5s, a growing sentence in place", () => {
    const text = () => {
      const shown = heldHeadline("turn:think");
      return shown?.kind === "thinking" ? shown.text : undefined;
    };
    offer("turn:think", [], [{ at: 0, text: "One. Tw" }]);
    jest.advanceTimersByTime(600);
    offer("turn:think", [], [{ at: 0, text: "One. Two. Thr" }]);
    jest.advanceTimersByTime(800);
    expect(text()).toBe("Tw");
    jest.advanceTimersByTime(100);
    expect(heldHeadline("turn:think")).toEqual({ kind: "thinking", key: "thinking:0:2", text: "Thr" });
    offer("turn:think", [], [{ at: 0, text: "One. Two. Three is" }]);
    jest.advanceTimersByTime(1499);
    expect(text()).toBe("Thr");
    jest.advanceTimersByTime(1);
    expect(heldHeadline("turn:think")).toEqual({ kind: "thinking", key: "thinking:0:2", text: "Three is" });
  });
});
