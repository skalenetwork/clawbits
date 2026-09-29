import { describe, expect, it } from "vitest";
import {
  type AgentActivity,
  applyActivity,
  headlineOf,
  keepTurn,
  type LiveTurn,
  postSteps,
  type Thought,
  type TurnStep,
} from "@/lib/turnSteps";

const fold = (events: AgentActivity[], from: LiveTurn = { key: "t", steps: [], thoughts: [] }): LiveTurn =>
  events.reduce(applyActivity, from);

describe("turn steps", () => {
  it("keeps parallel calls apart by id and closes each with its own outcome", () => {
    const { steps } = fold([
      { kind: "tool", id: "a", tool: "exec", label: "gh issue list" },
      { kind: "tool", id: "b", tool: "exec", label: "gh pr list" },
      { kind: "tool_done", id: "b", tool: "exec", ok: true, duration_ms: 900 },
      { kind: "tool_done", id: "a", tool: "exec", ok: true, duration_ms: 1500 },
      { kind: "tool_done", id: "a", tool: "exec", ok: false },
    ]);
    expect(steps).toEqual([
      { kind: "tool", id: "a", tool: "exec", label: "gh issue list", status: "error", duration_ms: 1500 },
      { kind: "tool", id: "b", tool: "exec", label: "gh pr list", status: "done", duration_ms: 900 },
    ]);
  });

  it("pairs by order for plugins that send no ids", () => {
    const { steps } = fold([
      { kind: "tool", tool: "read", label: "a.md" },
      { kind: "tool", tool: "read", label: "a.md" },
      { kind: "tool_done", tool: "read", ok: true },
      { kind: "tool", tool: "exec", label: "ls" },
      { kind: "tool_done", tool: "exec", ok: false },
    ]);
    expect(steps.map((s) => (s.kind === "tool" ? [s.tool, s.status] : s.kind))).toEqual([
      ["read", "done"],
      ["exec", "error"],
    ]);
  });

  it("keeps each burst of thinking at its place among the steps, stitching its tails", () => {
    const turn = fold([
      { kind: "thinking", label: "The user wants the open issues" },
      { kind: "thinking", label: "the open issues, so list them first." },
      { kind: "note", id: "m1", label: "Listing" },
      { kind: "note", id: "m1", label: "Listing the open issues." },
      { kind: "tool", id: "c1", tool: "exec", label: "gh issue list" },
      { kind: "thinking", label: "Two are bugs." },
      { kind: "tool_done", id: "c1", tool: "exec", ok: true },
      { kind: "thinking", label: "…are bugs. Label them." },
      { kind: "tool", id: "c2", tool: "exec", label: "gh issue edit 7" },
      { kind: "thinking", label: "Done." },
    ]);
    expect(turn).toEqual({
      key: "t",
      steps: [
        { kind: "note", id: "m1", text: "Listing the open issues." },
        { kind: "tool", id: "c1", tool: "exec", label: "gh issue list", status: "done" },
        { kind: "tool", id: "c2", tool: "exec", label: "gh issue edit 7", status: "running" },
      ],
      thoughts: [
        { at: 0, text: "The user wants the open issues, so list them first." },
        { at: 2, text: "Two are bugs. Label them." },
        { at: 3, text: "Done." },
      ],
    });
  });

  it("opens no burst for a tail the latest one already holds, as the heartbeat repeats it after a step", () => {
    const turn = fold([
      { kind: "thinking", label: "List the issues, then label them." },
      { kind: "tool", id: "c1", tool: "exec", label: "gh issue list" },
      { kind: "thinking", label: "…then label them." },
    ]);
    expect(turn.thoughts).toEqual([{ at: 0, text: "List the issues, then label them." }]);
    expect(headlineOf(turn)).toMatchObject({ kind: "tool", key: "c1" });
  });

  it("anchors each kept burst to the id of the step that followed it", () => {
    const steps: TurnStep[] = [
      { kind: "note", id: "m1", text: "Listing." },
      { kind: "tool", id: "c1", tool: "exec", label: "ls", status: "done" },
    ];
    expect(keepTurn({ key: "t", steps, thoughts: [{ at: 0, text: "First." }, { at: 2, text: "Last." }] })).toEqual({
      steps,
      thoughts: [
        { before: "m1", text: "First." },
        { before: undefined, text: "Last." },
      ],
    });
  });

  it("heads the turn with its newest signal, without its closing punctuation", () => {
    const tool = { kind: "tool", id: "c1", tool: "exec", label: "ls", status: "done" } as const;
    const turn = (steps: TurnStep[], thoughts: Thought[] = []): LiveTurn => ({ key: "t", steps, thoughts });
    expect(headlineOf(turn([]))).toBeUndefined();
    expect(headlineOf(turn([tool], [{ at: 1, text: "Checking the output. Then the" }]))).toEqual({
      kind: "thinking",
      key: "thinking:1:1",
      text: "Then the",
    });
    expect(headlineOf(turn([tool], [{ at: 1, text: "Checking the output." }]))).toEqual({
      kind: "thinking",
      key: "thinking:1:0",
      text: "Checking the output",
    });
    expect(headlineOf(turn([tool], [{ at: 0, text: "Checking the output." }]))).toEqual({
      kind: "tool",
      key: "c1",
      step: tool,
    });
    expect(headlineOf(turn([tool, { kind: "note", id: "m1", text: "Listing v2.3…" }]))).toEqual({
      kind: "note",
      key: "m1",
      text: "Listing v2.3",
    });
  });

  it("drops a leading stitch gap, and closing punctuation inside a closing quote or bracket", () => {
    const text = (thought: string) => {
      const headline = headlineOf({ key: "t", steps: [], thoughts: [{ at: 0, text: thought }] });
      return headline?.kind === "thinking" ? headline.text : undefined;
    };
    expect(text("One. … two three")).toBe("two three");
    expect(text('…It said "done."')).toBe('It said "done"');
    expect(text("Check the log (see above.)")).toBe("Check the log (see above)");
  });

  it("reads a finished post's steps", () => {
    expect(
      postSteps([
        { kind: "note", id: "m1", label: "Listing issues.", tool: null, ok: null, duration_ms: null },
        { kind: "tool", id: "c1", label: "gh issue list", tool: "exec", ok: false, duration_ms: 1200 },
      ]),
    ).toEqual([
      { kind: "note", id: "m1", text: "Listing issues." },
      { kind: "tool", id: "c1", tool: "exec", label: "gh issue list", status: "error", duration_ms: 1200 },
    ]);
  });
});
