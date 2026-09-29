import type { MmTurnStep } from "@/lib/api";
import { currentSentence, stitchThinkingTail } from "@/lib/thinkingStitch";

/** What an agent is doing right now, from its status lane. `id` keys one step across all of its events. */
export interface AgentActivity {
  kind: "generating" | "thinking" | "tool" | "tool_done" | "note";
  id?: string;
  label?: string;
  tool?: string;
  ok?: boolean;
  duration_ms?: number;
}

export interface ToolStep {
  kind: "tool";
  id: string;
  tool: string;
  label?: string;
  status: "running" | "done" | "error";
  duration_ms?: number;
}

/** The agent's narration between steps. */
export interface NoteStep {
  kind: "note";
  id: string;
  text: string;
}

/** One step of an agent's turn, in the order it happened: the same steps a finished post keeps. */
export type TurnStep = ToolStep | NoteStep;

/** A burst of thinking, stitched from its rolling tails. `at` counts the steps before it began, which places it among
 *  them. It is never a step: nothing stores it, so it lives only in the session that watched it. */
export interface Thought {
  at: number;
  text: string;
}

/** A burst of thinking as a reply keeps it: `before` is the id of the step that followed it, none when nothing did. */
export interface KeptThought {
  before: string | undefined;
  text: string;
}

/** What a finished turn did, in order: its steps, and the thinking this session watched between them. */
export interface Turn {
  steps: TurnStep[];
  thoughts: KeptThought[];
}

/** A turn in flight. `key` names it to the state that outlives its rows. */
export interface LiveTurn {
  key: string;
  steps: TurnStep[];
  thoughts: Thought[];
}

/** What a live turn's headline says: its newest signal. */
export type Headline =
  | { kind: "thinking" | "note"; key: string; text: string }
  | { kind: "tool"; key: string; step: ToolStep };

function upsert(steps: TurnStep[], step: TurnStep): TurnStep[] {
  const i = steps.findIndex((s) => s.id === step.id);
  return i < 0 ? [...steps, step] : steps.with(i, step);
}

/** Fold one step event. Events carry the step's id; older plugins send none, so there a start merges into a
 *  still-running call of the same tool and an end closes the last running call. An end's label is usually the bare
 *  tool name, so the start's command stays unless only the end carries detail. */
function applyStep(steps: TurnStep[], act: AgentActivity, label?: string): TurnStep[] {
  if (act.kind === "note") {
    return label ? upsert(steps, { kind: "note", id: act.id ?? `note:${String(steps.length)}`, text: label }) : steps;
  }
  if (act.kind !== "tool" && act.kind !== "tool_done") return steps;
  const running = steps.findLast((s) => s.kind === "tool" && s.status === "running");
  if (act.kind === "tool") {
    const tool = act.tool ?? "";
    const prev = act.id
      ? steps.find((s) => s.id === act.id)
      : running?.kind === "tool" && running.tool === tool && steps.at(-1) === running ? running : undefined;
    const id = prev?.id ?? act.id ?? `tool:${String(steps.length)}`;
    return upsert(
      steps,
      prev?.kind === "tool" ? { ...prev, label: label || prev.label } : { kind: "tool", id, tool, label, status: "running" },
    );
  }
  const prev = act.id ? steps.find((s) => s.id === act.id) : running;
  if (prev?.kind !== "tool") return steps;
  const detailed = (text?: string) => Boolean(text && text !== prev.tool);
  return upsert(steps, {
    ...prev,
    status: act.ok === false ? "error" : "done",
    duration_ms: act.duration_ms ?? prev.duration_ms,
    label: detailed(prev.label) ? prev.label : detailed(label) ? label : (prev.label ?? label),
  });
}

/** Fold one status-lane event into the turn. A thinking tail welds onto the latest burst while no step has followed it,
 *  and otherwise begins the next burst, unless the latest burst already holds it: the status heartbeat repeats the
 *  last tail. */
export function applyActivity(turn: LiveTurn, act: AgentActivity): LiveTurn {
  const label = act.label?.trim();
  if (act.kind !== "thinking") {
    const steps = applyStep(turn.steps, act, label);
    return steps === turn.steps ? turn : { ...turn, steps };
  }
  if (!label) return turn;
  const at = turn.steps.length;
  const burst = turn.thoughts.at(-1);
  const text = burst ? stitchThinkingTail(burst.text, label) : label;
  if (text === burst?.text) return turn;
  const thoughts = burst?.at === at ? turn.thoughts.with(-1, { at, text }) : [...turn.thoughts, { at, text: label }];
  return { ...turn, thoughts };
}

/** The turn a published reply keeps: each burst anchored to the id of the step that followed it, since the reply's saved
 *  steps may be counted differently (a mid-turn join, a reconnect, notes never sent). */
export function keepTurn({ steps, thoughts }: LiveTurn): Turn {
  return { steps, thoughts: thoughts.map(({ at, text }) => ({ before: steps[at]?.id, text })) };
}

/** A headline drops a leading stitch gap and its sentence's closing punctuation, even inside a closing quote or
 *  bracket; the open rows keep both. */
const bare = (text: string) => text.replace(/^…\s*/u, "").replace(/[.;:!?…]+(["'”’)\]]?)$/u, "$1");

/** The newest signal: a burst of thinking no step has followed yet, as the sentence it is writing; else the last step,
 *  which a finished tool keeps until something follows. */
export function headlineOf({ steps, thoughts }: LiveTurn): Headline | undefined {
  const burst = thoughts.at(-1);
  if (burst?.at === steps.length) {
    const sentence = currentSentence(burst.text);
    if (sentence) return { kind: "thinking", key: `thinking:${burst.at}:${sentence.index}`, text: bare(sentence.text) };
  }
  const last = steps.at(-1);
  if (last?.kind === "note") return { kind: "note", key: last.id, text: bare(last.text) };
  return last && { kind: "tool", key: last.id, step: last };
}

/** The turn as a finished post keeps it. */
export function postSteps(steps: MmTurnStep[]): TurnStep[] {
  return steps.map((s) =>
    s.kind === "note"
      ? { kind: "note", id: s.id, text: s.label }
      : {
          kind: "tool",
          id: s.id,
          tool: s.tool ?? "",
          label: s.label || undefined,
          status: s.ok === false ? "error" : "done",
          ...(s.duration_ms == null ? {} : { duration_ms: s.duration_ms }),
        },
  );
}
