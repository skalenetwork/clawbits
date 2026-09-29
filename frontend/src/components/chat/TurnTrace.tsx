import { useEffect, useMemo, useState } from "react";
import { ArrowRight01Icon } from "@hugeicons/core-free-icons";

import { Icon } from "@/components/Icon";
import { UnicodeSpinner } from "@/components/UnicodeSpinner";
import { useAgentGeneratingWord } from "@/hooks/useGeneratingWord";
import { toggleTrace, useTraceOpen, useTurnHeadline } from "@/hooks/useTraceState";
import { formatDuration } from "@/lib/formatting";
import { spinnerForAgent, warmingWordForAgent } from "@/lib/generatingWords";
import { roomOf, stepLabel } from "@/lib/traceRooms";
import {
  type Headline,
  keepTurn,
  type KeptThought,
  type LiveTurn,
  type NoteStep,
  type ToolStep,
  type TurnStep,
} from "@/lib/turnSteps";
import { cn } from "@/lib/utils";

/**
 * The agent's turn as one line above its reply: the same element from the first heartbeat through the settle, with
 * the turn's steps, and the thinking this session watched between them, opening under it and above the reply.
 *
 * Its slot spins for as long as the turn is live, so a held step never reads as stalled; the chevron takes over
 * when the line opens and once the turn settles. The line opens from the first row it has to show.
 *
 * The line reads "N steps · K failed", then one segment: while live, the turn's newest signal (the agent's word,
 * thinking, narration, or a running tool behind its room chip); once settled, how long the turn spanned. A turn that
 * only reasoned reads "Thought" in place of the count once the segment stops saying so: while the reply streams, and
 * once settled. Exactly one thing shimmers while live, the segment while it is live and otherwise the
 * count; "failed" never does. At settle the count, the failure and the line's height hold still, except that a
 * thought-only turn whose reply never streamed gains its "Thought" there. A settled turn with nothing to open has no line.
 *
 * Everything is 13px Inter, so hierarchy comes from a tinted CHIP whose hue is the step's ROOM (see lib/traceRooms),
 * three text tiers, and one 16px indent bracketed by a hairline rail.
 *
 * THE INDENT ASSERTS: these steps ran after this note and before the next note. It is a temporal bracket, order and
 * not causality: there is no parent-child field, only order. That is also why the rail starts and ends inside the
 * first and last chip rather than descending from the note, and why there are no elbow connectors, no chevron on the
 * note, no count badge and no second level.
 */

/** A turn in flight, as its line reads it. */
interface LiveLine {
  turn?: LiveTurn;
  /** Picks the spinner and the agent's shared word. */
  agentId: string;
  /** Sent, but no real signal yet: the agent's warming word. */
  optimistic?: boolean;
  /** The reply's text has started, so the segment shows only a running tool. */
  replying?: boolean;
}

/** What follows the count, keyed so a new one crossfades in and the same one updates in place. A text segment's
 *  separator is fixed when it is built, so an outgoing one never gains a separator during its fade. */
type Segment = { key: string; live: boolean } & ({ text: string; dot: boolean } | { step: ToolStep; more: number });

/** Timestamps are whole seconds, so the span shows from 10s, where a second either way still reads true. */
const SPANNED_FROM_MS = 10_000;
/** Matches .headline-in and .headline-out in index.css. */
const FADE_MS = 200;
const NO_STEPS: TurnStep[] = [];
const NO_THOUGHTS: KeptThought[] = [];

/** Reasoning reads as prose: the agent's narration, or a burst of its thinking. */
type Prose = NoteStep | (KeptThought & { kind: "thought" });

/** Runs of consecutive tool steps become one bracketed group. */
type Group = { prose: Prose } | { steps: ToolStep[]; failed: boolean };

/** Each burst of thinking sits just before the step that followed it, or after the last step when that step is not
 *  here. */
function buildGroups(steps: TurnStep[], thoughts: KeptThought[]): Group[] {
  const ids = new Set(steps.map((s) => s.id));
  const prose = (t: KeptThought): Prose => ({ kind: "thought", ...t });
  const rows: (ToolStep | Prose)[] = [
    ...steps.flatMap((s) => [...thoughts.filter((t) => t.before === s.id).map(prose), s]),
    ...thoughts.filter((t) => !(t.before && ids.has(t.before))).map(prose),
  ];
  const out: Group[] = [];
  let run: ToolStep[] | null = null;
  for (const row of rows) {
    if (row.kind !== "tool") {
      out.push({ prose: row });
      run = null;
      continue;
    }
    if (!run) {
      run = [];
      out.push({ steps: run, failed: false });
    }
    run.push(row);
  }
  return out.map((g) =>
    "steps" in g ? { ...g, failed: g.steps.some((s) => s.status === "error") } : g,
  );
}

/** A live turn's segment. A running tool is live, with how many parallel calls run beside it; a finished one holds,
 *  static, until the next signal. Once the reply's text starts, only a running tool shows. Text follows a separator
 *  only behind a count: the agent's word comes before any signal, and thinking or narration before the first tool
 *  leaves the count empty. */
function liveSegment(headline: Headline | undefined, word: string, steps: TurnStep[], replying: boolean): Segment | undefined {
  if (headline?.kind === "tool") {
    const live = headline.step.status === "running";
    const beside = (s: TurnStep) => s.kind === "tool" && s.status === "running" && s.id !== headline.key;
    const more = live ? steps.filter(beside).length : 0;
    return live || !replying ? { key: headline.key, live, step: headline.step, more } : undefined;
  }
  if (replying) return undefined;
  if (!headline) return { key: `word:${word}`, live: true, text: word, dot: false };
  const text = headline.kind === "thinking" ? `Thinking · ${headline.text}` : headline.text;
  return { key: headline.key, live: true, text, dot: steps.some((s) => s.kind === "tool") };
}

function spannedSegment(ms: number | undefined): Segment | undefined {
  return ms !== undefined && ms >= SPANNED_FROM_MS
    ? { key: "spanned", live: false, text: `spanned ${formatDuration(ms) ?? ""}`, dot: true }
    : undefined;
}

function Dot() {
  return <span className="shrink-0 whitespace-pre text-(--trace-faint)"> · </span>;
}

/** A tool step's room chip. Failure INVERTS polarity (solid fill, paper glyph) rather than taking another hue, so it
 *  wins among coloured siblings, and the glyph keeps carrying the room. */
function StepChip({ step }: { step: ToolStep }) {
  const { room, icon, label } = roomOf(step.tool);
  const failed = step.status === "error";
  return (
    <span
      className={cn(
        "grid size-5 shrink-0 place-items-center rounded-sm",
        failed ? "bg-[var(--trace-error)] text-[var(--trace-on-error)]" : "bg-(--room-chip) text-(--room-ink)",
      )}
      style={failed ? undefined : ({ "--room-chip": `var(--room-${room}-chip)`, "--room-ink": `var(--room-${room}-ink)` } as React.CSSProperties)}
    >
      <Icon icon={icon} className="size-3.5 [&_*]:[stroke-width:var(--trace-stroke)]" />
      <span className="sr-only">{failed ? "failed" : label}</span>
    </span>
  );
}

/** A tool step's label: its head at weight 500 in the parent's colour, its tail quiet. */
function StepText({ step }: { step: ToolStep }) {
  const { head, tail } = stepLabel(step.label?.trim() || step.tool, roomOf(step.tool).room);
  return (
    <>
      <span className="font-medium">{head}</span>
      {tail && <span className="text-(--trace-quiet)"> {tail}</span>}
    </>
  );
}

/** A segment's text: behind the separator when a count leads it, or behind its room chip for a tool. `still` for the
 *  outgoing one, so only the incoming segment shimmers. */
function SegmentText({ segment, still = false }: { segment: Segment; still?: boolean }) {
  const tone = segment.live && !still ? "t-shimmer" : "text-(--trace-quiet)";
  if ("text" in segment) {
    return (
      <>
        {segment.dot && <Dot />}
        <span className={cn("truncate", tone)}>{segment.text}</span>
      </>
    );
  }
  return (
    <span className="ms-2 flex min-w-0 items-center gap-2">
      <StepChip step={segment.step} />
      <span className={cn("flex min-w-0 [font-feature-settings:'calt'_0]", tone)}>
        <span className="truncate">
          <StepText step={segment.step} />
        </span>
        {segment.more > 0 && <span className="shrink-0 whitespace-pre"> and {segment.more} more</span>}
      </span>
    </span>
  );
}

/** Full content: wraps, never truncated. Durations show from 500ms and always on a failure: the silence on fast steps
 *  is what makes a slow one legible. */
function ToolRow({ step }: { step: ToolStep }) {
  const failed = step.status === "error";
  const dur = failed || (step.duration_ms ?? 0) >= 500 ? formatDuration(step.duration_ms) : null;

  return (
    <div className="grid min-h-6 grid-cols-[1.25rem_minmax(0,1fr)_auto_3rem] items-start gap-x-2 py-0.5">
      <StepChip step={step} />
      <span className="min-w-0 text-foreground [overflow-wrap:anywhere] whitespace-pre-wrap [font-feature-settings:'calt'_0]">
        <StepText step={step} />
      </span>
      <span className={cn("whitespace-nowrap font-medium", failed && "text-[var(--trace-error)]")}>
        {failed ? "failed" : ""}
      </span>
      <span className="whitespace-nowrap text-right tabular-nums text-(--trace-faint)">{dur}</span>
    </div>
  );
}

const LINE = "flex min-h-6 w-full items-center gap-2 py-0.5 text-left";

export function TurnTrace({
  live,
  steps: finishedSteps = NO_STEPS,
  thoughts: finishedThoughts = NO_THOUGHTS,
  spannedMs,
  traceKey,
}: {
  /** Present while the turn runs. */
  live?: LiveLine;
  /** A finished turn's steps. */
  steps?: TurnStep[];
  /** The thinking this session watched a finished turn do. */
  thoughts?: KeptThought[];
  /** Wall-clock from dispatch to reply, never a sum of step durations: steps overlap. */
  spannedMs?: number;
  /** Keeps the rows open across unmounts: a reply's post id, which a live turn's own key hands off to. */
  traceKey?: string;
}) {
  const turn = live?.turn;
  const isLive = live !== undefined;
  const steps = isLive ? (turn?.steps ?? NO_STEPS) : finishedSteps;
  const thoughts = useMemo(
    () => (isLive ? (turn ? keepTurn(turn).thoughts : NO_THOUGHTS) : finishedThoughts),
    [isLive, turn, finishedThoughts],
  );
  const key = turn?.key ?? traceKey ?? "";
  const open = useTraceOpen(key);
  const headline = useTurnHeadline(turn);
  const rotating = useAgentGeneratingWord(live?.agentId);
  const word = live?.optimistic ? warmingWordForAgent(live.agentId) : rotating;
  const replying = live?.replying ?? false;
  const segment = useMemo(
    () => (isLive ? liveSegment(headline, word, steps, replying) : spannedSegment(spannedMs)),
    [isLive, headline, word, steps, replying, spannedMs],
  );
  const [seen, setSeen] = useState(segment);
  const [fade, setFade] = useState<{ from?: Segment } | null>(null);
  if (segment !== seen) {
    setSeen(segment);
    if (segment?.key !== seen?.key) setFade({ from: seen });
  }
  useEffect(() => {
    if (!fade) return;
    const handle = window.setTimeout(() => { setFade(null); }, FADE_MS);
    return () => { window.clearTimeout(handle); };
  }, [fade]);
  const groups = useMemo(() => buildGroups(steps, thoughts), [steps, thoughts]);

  const rows = steps.length + thoughts.length;
  if (!live && rows === 0) return null;

  const tools = steps.filter((s) => s.kind === "tool");
  const failures = tools.filter((s) => s.status === "error").length;
  const count = tools.length > 0
    ? `${String(tools.length)} step${tools.length === 1 ? "" : "s"}`
    : rows > 0 && !(isLive && segment) ? "Thought" : undefined;
  const openable = rows > 0;
  const spinner = live && !open ? spinnerForAgent(live.agentId) : undefined;
  const line = (
    <>
      {spinner ? (
        <UnicodeSpinner name={spinner} className="grid size-5 shrink-0 place-items-center text-(--trace-faint)" ariaLabel="working" />
      ) : (
        <span className="grid size-5 shrink-0 place-items-center text-(--trace-faint)">
          <Icon icon={ArrowRight01Icon} className={cn("size-3 transition-transform duration-200", open && "rotate-90")} />
        </span>
      )}
      <span className="flex min-w-0 flex-1 items-center whitespace-nowrap">
        {count && (
          <span className={cn("shrink-0 font-medium", isLive && !segment?.live ? "t-shimmer" : "text-foreground")}>
            {count}
          </span>
        )}
        {failures > 0 && (
          <>
            <Dot />
            <span className="shrink-0 font-medium text-[var(--trace-error)]">{failures} failed</span>
          </>
        )}
        <span className="grid min-w-0 flex-1 grid-cols-1">
          {fade?.from && (
            <span key={fade.from.key} aria-hidden className="headline-out col-start-1 row-start-1 flex min-w-0">
              <SegmentText segment={fade.from} still />
            </span>
          )}
          {segment && (
            <span key={segment.key} className={cn("col-start-1 row-start-1 flex min-w-0", fade && "headline-in")}>
              <SegmentText segment={segment} />
            </span>
          )}
        </span>
      </span>
    </>
  );

  return (
    <div className="mb-1 max-w-full text-[13px]/5 tracking-normal">
      {openable ? (
        <button type="button" onClick={() => { toggleTrace(key); }} aria-expanded={open} className={LINE}>
          {line}
        </button>
      ) : (
        <div className={LINE}>{line}</div>
      )}
      {openable && (
        <div
          inert={!open}
          className={cn(
            "grid transition-[grid-template-rows] duration-200 ease-out",
            open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
          )}
        >
          <div className="overflow-hidden">
            <div className="pt-2 pb-1">
              {groups.map((g, i) =>
                "prose" in g ? (
                  <p
                    key={g.prose.kind === "note" ? `n${g.prose.id}` : `t${g.prose.before ?? ""}`}
                    className="mt-3 select-text py-0.5 text-(--trace-quiet) [text-wrap:pretty] first:mt-0"
                  >
                    {g.prose.kind === "thought" && <span className="text-(--trace-faint)">Thinking · </span>}
                    {g.prose.text}
                  </p>
                ) : (
                  <div
                    key={`g${g.steps[0]?.id ?? String(i)}`}
                    className={cn(
                      "relative ps-4",
                      "before:absolute before:inset-y-1.5 before:start-[7px] before:w-px before:rounded-full before:bg-(--trace-rail)",
                      g.failed && "before:w-0.5 before:start-[6.5px] before:bg-[var(--trace-error)]",
                    )}
                  >
                    {g.steps.map((s) => (
                      <ToolRow key={s.id} step={s} />
                    ))}
                  </div>
                ),
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
