import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { endLiveTurn, toggleTrace, useTraceOpen, useTurnHeadline } from "./useTraceState";
import type { LiveTurn, ToolStep, TurnStep } from "@/lib/turnSteps";

const call = (id: string, status: ToolStep["status"] = "running"): ToolStep => ({
  kind: "tool",
  id,
  tool: "exec",
  label: `exec: '${id}'`,
  status,
});

/** A turn whose thinking, if any, is one burst that began after its steps. */
function follow(key: string, steps: TurnStep[], thinking = "") {
  const turn = (nextSteps: TurnStep[], text: string): LiveTurn => ({
    key,
    steps: nextSteps,
    thoughts: text ? [{ at: nextSteps.length, text }] : [],
  });
  const hook = renderHook((props: { turn: LiveTurn }) => useTurnHeadline(props.turn), {
    initialProps: { turn: turn(steps, thinking) },
  });
  return {
    shown: () => hook.result.current,
    next: (nextSteps: TurnStep[], nextThinking = "") => {
      hook.rerender({ turn: turn(nextSteps, nextThinking) });
    },
    wait: (ms: number) => {
      act(() => { vi.advanceTimersByTime(ms); });
    },
    unmount: hook.unmount,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useTurnHeadline", () => {
  it("shows the first signal at once, holds each headline 500ms and lets the latest pending win", () => {
    const turn = follow("turn:hold", [call("a")]);
    expect(turn.shown()?.key).toBe("a");
    turn.next([call("a"), call("b")]);
    turn.next([call("a"), call("b"), call("c")]);
    expect(turn.shown()?.key).toBe("a");
    turn.wait(500);
    expect(turn.shown()?.key).toBe("c");
  });

  it("never shows a tool that starts and ends inside the hold", () => {
    const turn = follow("turn:blink", [call("a")]);
    turn.next([call("a"), call("b")]);
    turn.next([call("a"), call("b", "done")]);
    turn.wait(500);
    turn.next([call("a"), call("b", "done")]);
    expect(turn.shown()?.key).toBe("a");
    turn.next([call("a"), call("b", "done"), call("c")]);
    expect(turn.shown()?.key).toBe("c");
  });

  it("keeps a finished tool until the next signal, then moves forward", () => {
    const turn = follow("turn:rest", [call("a")]);
    turn.wait(600);
    turn.next([call("a", "done")]);
    expect(turn.shown()).toEqual({ kind: "tool", key: "a", step: call("a", "done") });
    turn.next([call("a", "done")], "Checking the output. Then");
    expect(turn.shown()).toEqual({ kind: "thinking", key: "thinking:1:1", text: "Then" });
  });

  it("shows a parallel call finishing even when a shorter one came and went during its hold", () => {
    const turn = follow("turn:parallel", [call("a")]);
    turn.next([call("a"), call("b")]);
    turn.next([call("a"), call("b", "done")]);
    turn.wait(500);
    turn.next([call("a", "done"), call("b", "done")]);
    expect(turn.shown()).toEqual({ kind: "tool", key: "a", step: call("a", "done") });
  });

  it("refreshes thinking at most every 1.5s, as its sentence grows and when the next begins", () => {
    const turn = follow("turn:think", [], "One. Two");
    turn.next([], "One. Two is");
    turn.wait(1000);
    expect(turn.shown()).toMatchObject({ text: "Two" });
    turn.next([], "One. Two is done. Three");
    turn.wait(499);
    expect(turn.shown()).toMatchObject({ text: "Two" });
    turn.wait(1);
    expect(turn.shown()).toEqual({ kind: "thinking", key: "thinking:0:2", text: "Three" });
    turn.next([], "One. Two is done. Three and");
    turn.wait(1499);
    expect(turn.shown()).toMatchObject({ text: "Three" });
    turn.wait(1);
    expect(turn.shown()).toMatchObject({ text: "Three and" });
  });

  it("survives a remount and clears when the turn ends", () => {
    follow("turn:handoff", [call("a")]).unmount();
    const turn = follow("turn:handoff", [call("a"), call("b")]);
    expect(turn.shown()?.key).toBe("a");
    turn.unmount();
    act(() => { endLiveTurn("turn:handoff"); });
    expect(follow("turn:handoff", [call("c")]).shown()?.key).toBe("c");
  });

  it("shows the first signal in the render that brings it", () => {
    const seen: (string | undefined)[] = [];
    const hook = renderHook(
      (props: { turn?: LiveTurn }) => {
        const headline = useTurnHeadline(props.turn);
        seen.push(headline?.key);
        return headline;
      },
      { initialProps: {} },
    );
    hook.rerender({ turn: { key: "turn:first", steps: [call("a")], thoughts: [] } });
    expect(seen[0]).toBeUndefined();
    expect(new Set(seen.slice(1))).toEqual(new Set(["a"]));
  });
});

describe("endLiveTurn", () => {
  it("hands an open live trace to the reply it published", () => {
    act(() => { toggleTrace("turn:c:agent:a"); });
    const live = renderHook(() => useTraceOpen("turn:c:agent:a"));
    const reply = renderHook(() => useTraceOpen("42"));
    expect([live.result.current, reply.result.current]).toEqual([true, false]);
    act(() => { endLiveTurn("turn:c:agent:a", "42"); });
    expect([live.result.current, reply.result.current]).toEqual([false, true]);
  });
});
