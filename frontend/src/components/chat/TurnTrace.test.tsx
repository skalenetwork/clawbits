import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { SettleBody } from "./SettleBody";
import { TurnTrace } from "./TurnTrace";
import { endLiveTurn } from "@/hooks/useTraceState";
import { warmingWordForAgent } from "@/lib/generatingWords";
import { keepTurn, type LiveTurn, type NoteStep, type Thought, type ToolStep, type TurnStep } from "@/lib/turnSteps";

const note: NoteStep = { kind: "note", id: "m1", text: "Pulling this week's untriaged issues." };
const read = (status: ToolStep["status"]): ToolStep => ({
  kind: "tool",
  id: "c1",
  tool: "read",
  label: "read: '/home/node/.openclaw/workspace/skills/linear/SKILL.md'",
  status,
});
const list = (status: ToolStep["status"], id = "c2"): ToolStep => ({
  kind: "tool",
  id,
  tool: "exec",
  label: "exec: 'linear issue list --state triage'",
  status,
  duration_ms: 2100,
});
const update = (status: ToolStep["status"]): ToolStep => ({
  kind: "tool",
  id: "c3",
  tool: "exec",
  label: "exec: 'linear issue update ENG-412 --label bug'",
  status,
  duration_ms: 800,
});
const done: TurnStep[] = [note, read("done"), list("done"), update("error")];

const turn = (name: string, steps: TurnStep[], thoughts: Thought[] = []): LiveTurn => ({
  key: `turn:test:${name}`,
  steps,
  thoughts,
});

/** The line's words as a sighted reader sees them: no screen-reader text, outgoing segment or spinner glyph. */
function shown(el: Element): string {
  const copy = el.cloneNode(true) as Element;
  for (const hidden of copy.querySelectorAll(".sr-only, [aria-hidden], [role=img]")) hidden.remove();
  return copy.textContent;
}

const shimmers = (root: Element) => [...root.querySelectorAll(".t-shimmer")].map((el) => el.textContent);

/** Whether each text shows after the one before it. */
function inOrder(...texts: string[]): boolean {
  const els = texts.map((text) => screen.getByText(text));
  return els.every((el, i) => i === 0 || els[i - 1]?.compareDocumentPosition(el) === Node.DOCUMENT_POSITION_FOLLOWING);
}

function wait(ms: number) {
  act(() => { vi.advanceTimersByTime(ms); });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("ResizeObserver", class { observe = vi.fn(); disconnect = vi.fn(); });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("TurnTrace", () => {
  it("warms up on the agent's word beside a spinner, with nothing to open yet", () => {
    const { container } = render(<TurnTrace live={{ agentId: "a", optimistic: true }} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByRole("img", { name: "working" })).toBeInTheDocument();
    expect(shimmers(container)).toEqual([warmingWordForAgent("a")]);
  });

  it("opens from the first burst of thinking, which reads as the sentence being written", () => {
    const text = "The user wants the new bugs triaged. Checking how the Linear skill";
    const { container } = render(<TurnTrace live={{ agentId: "a", turn: turn("thinking", [], [{ at: 0, text }]) }} />);
    wait(200);
    const line = screen.getByRole("button");
    expect(shown(line)).toBe("Thinking · Checking how the Linear skill");
    expect(shimmers(container)).toEqual(["Thinking · Checking how the Linear skill"]);
  });

  it("gives the word no separator as the first signal fades it out", () => {
    const { container, rerender } = render(<TurnTrace live={{ agentId: "a", optimistic: true }} />);
    rerender(<TurnTrace live={{ agentId: "a", turn: turn("first", [], [{ at: 0, text: "Reading the" }]) }} />);
    const outgoing = container.querySelector(".headline-out");
    expect(outgoing?.textContent).toBe(warmingWordForAgent("a"));
    expect(shown(screen.getByRole("button"))).toBe("Thinking · Reading the");
  });

  it("spins for as long as the turn is live, and shows the chevron once the line opens or the turn settles", () => {
    const live = turn("spin", [read("done")]);
    const { rerender } = render(<TurnTrace live={{ agentId: "a", turn: live }} />);
    wait(200);
    expect(screen.getByRole("img", { name: "working" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button"));
    expect(screen.queryByRole("img", { name: "working" })).toBeNull();
    fireEvent.click(screen.getByRole("button"));
    rerender(<TurnTrace steps={live.steps} traceKey="spin-post" />);
    expect(screen.queryByRole("img", { name: "working" })).toBeNull();
    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "false");
  });

  it("reads narration bare", () => {
    const { container } = render(<TurnTrace live={{ agentId: "a", turn: turn("note", [note]) }} />);
    wait(200);
    const line = screen.getByRole("button");
    expect(line).toHaveAttribute("aria-expanded", "false");
    expect(shown(line)).toBe("Pulling this week's untriaged issues");
    expect(shimmers(container)).toEqual(["Pulling this week's untriaged issues"]);
  });

  it("leads a running tool with its room chip, after a count that holds still", () => {
    const { container } = render(<TurnTrace live={{ agentId: "a", turn: turn("read", [note, read("running")]) }} />);
    wait(200);
    const line = screen.getByRole("button");
    expect(within(line).getByText("read", { selector: ".sr-only" })).toBeInTheDocument();
    expect(within(line).getByText("1 step")).not.toHaveClass("t-shimmer");
    expect(shimmers(container)).toEqual(["SKILL.md …/skills/linear"]);
  });

  it("reads parallel calls as the newest label and how many more run", () => {
    const { container } = render(
      <TurnTrace live={{ agentId: "a", turn: turn("parallel", [read("done"), list("running"), update("running")]) }} />,
    );
    wait(200);
    expect(shimmers(container)).toEqual(["linear issue update ENG-412 --label bug and 1 more"]);
  });

  it("holds a finished step still beside a running call, and the count carries the shimmer", () => {
    const { container } = render(
      <TurnTrace live={{ agentId: "a", turn: turn("held", [list("running"), update("done")]) }} />,
    );
    wait(200);
    const line = screen.getByRole("button");
    expect(within(line).getByText("linear issue update")).toBeInTheDocument();
    expect(shown(line)).not.toContain("more");
    expect(shimmers(container)).toEqual(["2 steps"]);
  });

  it("holds a failed step still and hands the shimmer to the count, never to the failure", () => {
    const { container } = render(<TurnTrace live={{ agentId: "a", turn: turn("failed", done) }} />);
    wait(200);
    const line = screen.getByRole("button");
    expect(within(line).getByText("failed", { selector: ".sr-only" })).toBeInTheDocument();
    expect(within(line).getByText("1 failed").closest(".t-shimmer")).toBeNull();
    expect(shimmers(container)).toEqual(["3 steps"]);
  });

  it("empties the segment while the reply streams unless a tool runs, and the count carries the shimmer", () => {
    const streaming = (steps: TurnStep[]) => <TurnTrace live={{ agentId: "a", turn: turn("streaming", steps), replying: true }} />;
    const { container, rerender } = render(streaming(done));
    expect(shown(screen.getByRole("button"))).toBe("3 steps · 1 failed");
    expect(shimmers(container)).toEqual(["3 steps"]);
    rerender(streaming([...done, list("running", "c4")]));
    wait(500);
    expect(shimmers(container)).toEqual(["linear issue list --state triage"]);
  });

  it("settles into how long the turn spanned, from 10s, with the count and the failure in place", () => {
    const { container, rerender } = render(
      <TurnTrace live={{ agentId: "a", turn: turn("settle", done), replying: true }} traceKey="42" />,
    );
    const count = screen.getByText("3 steps");
    rerender(<TurnTrace steps={done} spannedMs={42_000} traceKey="42" />);
    expect(screen.getByText("3 steps")).toBe(count);
    expect(screen.getByText("spanned 42s").closest(".headline-in")).not.toBeNull();
    expect(shown(screen.getByRole("button"))).toBe("3 steps · 1 failed · spanned 42s");
    expect(shimmers(container)).toEqual([]);

    const brief = render(<TurnTrace steps={done} spannedMs={9_000} traceKey="43" />);
    expect(shown(within(brief.container).getByRole("button"))).toBe("3 steps · 1 failed");
    const history = render(<TurnTrace steps={done} spannedMs={42_000} traceKey="44" />);
    expect(within(history.container).getByText("spanned 42s").closest(".headline-in")).toBeNull();
  });

  it("keeps the line of a turn that ran no tools through its reply, and settles it as a thought", () => {
    const quiet = turn("quiet", [note], [{ at: 1, text: "Nothing to run." }]);
    const { container, rerender } = render(
      <TurnTrace live={{ agentId: "a", turn: quiet, replying: true }} traceKey="45" />,
    );
    expect(shown(screen.getByRole("button"))).toBe("Thought");
    expect(shimmers(container)).toEqual(["Thought"]);
    rerender(<TurnTrace {...keepTurn(quiet)} spannedMs={42_000} traceKey="45" />);
    expect(shown(screen.getByRole("button"))).toBe("Thought · spanned 42s");
    expect(shimmers(container)).toEqual([]);
  });

  it("keeps a turn with nothing to open on its spinner through the reply, and drops it at settle", () => {
    const { container, rerender } = render(<TurnTrace live={{ agentId: "a", replying: true }} traceKey="47" />);
    expect(screen.getByRole("img", { name: "working" })).toBeInTheDocument();
    rerender(<TurnTrace spannedMs={42_000} traceKey="47" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("opens thinking at its place between the steps, and keeps it through the settle", () => {
    const steps = [note, read("done"), list("done")];
    const early: Thought = { at: 0, text: "The user wants this week's bugs triaged." };
    const late: Thought = { at: 2, text: "Two are bugs. Label them." };
    const order = [early.text, note.text, "SKILL.md", late.text, "linear issue list"];
    const live = turn("rows", steps, [early, late]);
    const { rerender } = render(<TurnTrace live={{ agentId: "a", turn: live, replying: true }} />);
    fireEvent.click(screen.getByRole("button"));
    const first = screen.getByText(early.text);
    expect(within(first).getByText("Thinking ·")).toHaveClass("text-(--trace-faint)");
    expect(first).toHaveClass("text-(--trace-quiet)");
    expect(inOrder(...order)).toBe(true);

    act(() => { endLiveTurn("turn:test:rows", "48"); });
    rerender(<TurnTrace {...keepTurn(live)} spannedMs={42_000} traceKey="48" />);
    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(early.text)).toBe(first);
    expect(inOrder(...order)).toBe(true);
  });

  it("places kept thinking by the step that followed it when the saved steps count differently", () => {
    const joined = turn("joined", [list("done")], [
      { at: 0, text: "Listing the triage queue." },
      { at: 1, text: "Two are bugs." },
    ]);
    render(
      <TurnTrace steps={[note, read("done"), list("done")]} thoughts={keepTurn(joined).thoughts} traceKey="50" />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(inOrder(note.text, "SKILL.md", "Listing the triage queue.", "linear issue list", "Two are bugs.")).toBe(true);
  });

  it("keeps closed rows out of reach and the line on the app's focus ring", () => {
    render(<TurnTrace steps={done} spannedMs={42_000} traceKey="49" />);
    const line = screen.getByRole("button");
    expect(line).not.toHaveClass("outline-none");
    expect(line.nextElementSibling).toHaveAttribute("inert");
    fireEvent.click(line);
    expect(line.nextElementSibling).not.toHaveAttribute("inert");
  });

  it("opens its rows under the line and above the reply, and keeps them open across a remount", () => {
    const reply = (
      <SettleBody isStreaming={false} lead={<TurnTrace steps={done} spannedMs={42_000} traceKey="46" />}>
        <p>Four untriaged issues this week.</p>
      </SettleBody>
    );
    const first = render(reply);
    fireEvent.click(screen.getByRole("button"));
    first.unmount();
    render(reply);
    const line = screen.getByRole("button");
    const row = screen.getByText("Pulling this week's untriaged issues.");
    expect(line).toHaveAttribute("aria-expanded", "true");
    expect(line.compareDocumentPosition(row)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(row.compareDocumentPosition(screen.getByText("Four untriaged issues this week."))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(screen.getByText("linear issue list")).toHaveClass("font-medium");
    expect(document.body.textContent).not.toContain("exec:");
  });
});

describe("SettleBody", () => {
  it("ends the settle on its own boxes' events, not on ones bubbling up from the line or the reply", () => {
    let height = 40;
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(() => height);
    const settle = (isStreaming: boolean) => (
      <SettleBody isStreaming={isStreaming} lead={<span>line</span>}>
        <p>reply</p>
      </SettleBody>
    );
    const { container, rerender } = render(settle(true));
    height = 64;
    rerender(settle(false));
    const outer = container.firstElementChild as HTMLElement;
    const body = screen.getByText("reply").parentElement!;

    fireEvent.transitionEnd(screen.getByText("line"));
    fireEvent.animationEnd(screen.getByText("reply"));
    expect(outer.style.height).toBe("64px");
    expect(body).toHaveClass("animate-settle-fade");

    fireEvent.transitionEnd(outer);
    fireEvent.animationEnd(body);
    expect(outer.style.height).toBe("");
    expect(body).not.toHaveClass("animate-settle-fade");
  });
});
