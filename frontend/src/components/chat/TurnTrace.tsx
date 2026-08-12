import { useMemo, useState } from "react";
import { ArrowRight01Icon } from "@hugeicons/core-free-icons";

import { Icon } from "@/components/Icon";
import type { ThinkingStep, ToolStep } from "@/hooks/useChannelEvents";
import { formatDuration } from "@/lib/toolPresentation";
import { roomOf, splitCommand } from "@/lib/traceRooms";
import { cn } from "@/lib/utils";

/**
 * The agent's turn, as one merged chronological trace.
 *
 * Replaces the two separate ToolTimelineCard / ThinkingTimelineCard footers.
 * Reasoning and tool steps interleave in the order they happened, because
 * `thought → ran → failed → reconsidered → ran` is the story, and two
 * identically-shaped counters ("4 thoughts" beside "Used 11 tools") told none
 * of it. Ordering comes from the shared `id` counter in useChannelEvents.
 *
 * The three things carrying hierarchy, since everything is 13px Inter:
 *  - a tinted CHIP whose hue is the step's ROOM (see lib/traceRooms) — what it
 *    could affect, which is the one thing the label text cannot say;
 *  - three text tiers (ink / quiet / faint);
 *  - one 16px indent, bracketed by a hairline rail.
 *
 * THE INDENT ASSERTS: these steps ran after this note and before the next note.
 * It is a temporal bracket. It does NOT claim the note caused the steps — we
 * have no parent-child field, only order. That is also why there are no elbow
 * connectors, no chevron on the note, no count badge, and no second level.
 */

type Beat =
  | { kind: "note"; id: number; step: ThinkingStep }
  | { kind: "tool"; id: number; step: ToolStep };

/** Runs of consecutive tool beats become one bracketed group. */
type Group = { note: ThinkingStep } | { steps: ToolStep[]; failed: boolean };

function buildGroups(tools: ToolStep[], notes: ThinkingStep[]): Group[] {
  const beats: Beat[] = [
    ...tools.map((step) => ({ kind: "tool" as const, id: step.id, step })),
    ...notes.map((step) => ({ kind: "note" as const, id: step.id, step })),
  ].sort((a, b) => a.id - b.id);

  const out: Group[] = [];
  let run: ToolStep[] | null = null;
  for (const beat of beats) {
    if (beat.kind === "note") {
      out.push({ note: beat.step });
      run = null;
      continue;
    }
    if (!run) {
      run = [];
      out.push({ steps: run, failed: false });
    }
    run.push(beat.step);
  }
  return out.map((g) =>
    "steps" in g ? { ...g, failed: g.steps.some((s) => s.status === "error") } : g,
  );
}

function Chip({ step }: { step: ToolStep }) {
  const { room, icon, label } = roomOf(step.tool);
  const failed = step.status === "error";
  return (
    <span
      // Failure INVERTS polarity — solid fill, paper glyph — rather than taking
      // another hue. Tint-vs-solid is a different KIND of chip, so it still
      // wins among coloured siblings. The tool glyph is deliberately unchanged:
      // polarity carries the failure, the glyph keeps carrying the room.
      className={cn(
        "grid size-5 shrink-0 place-items-center rounded-md",
        failed ? "bg-[var(--trace-error)] text-[var(--trace-on-error)]" : "bg-(--room-chip) text-(--room-ink)",
      )}
      style={failed ? undefined : ({ "--room-chip": `var(--room-${room}-chip)`, "--room-ink": `var(--room-${room}-ink)` } as React.CSSProperties)}
    >
      <Icon icon={icon} className="size-3.5 [&_*]:[stroke-width:var(--trace-stroke)]" />
      <span className="sr-only">{failed ? "failed" : label}</span>
    </span>
  );
}

function ToolRow({ step }: { step: ToolStep }) {
  const failed = step.status === "error";
  const { room } = roomOf(step.tool);
  // Durations render above 500ms, plus always on a failure — the silence on
  // fast steps is what makes a slow one legible.
  const dur = failed || (step.duration_ms ?? 0) >= 500 ? formatDuration(step.duration_ms) : null;

  let body = <span className="text-(--trace-quiet)">{step.tool}</span>;
  const label = step.label?.trim();
  if (label) {
    if (room === "read" || room === "write" || room === "find") {
      body = <span className="font-medium text-foreground">{label}</span>;
    } else {
      const { head, tail } = splitCommand(label);
      body = (
        <>
          <span className="font-medium text-foreground">{head}</span>
          {tail && <span className="text-(--trace-quiet)"> {tail}</span>}
        </>
      );
    }
  }

  return (
    <div className="grid min-h-6 grid-cols-[1.25rem_minmax(0,1fr)_auto_3rem] items-start gap-x-2 py-0.5">
      <Chip step={step} />
      {/* Full content: wraps, never truncated, never elided. */}
      <span className="min-w-0 [overflow-wrap:anywhere] whitespace-pre-wrap [font-feature-settings:'calt'_0]">
        {body}
      </span>
      <span className={cn("whitespace-nowrap font-medium", failed && "text-[var(--trace-error)]")}>
        {failed ? "failed" : ""}
      </span>
      <span className="whitespace-nowrap text-right tabular-nums text-(--trace-faint)">{dur}</span>
    </div>
  );
}

export function TurnTrace({
  toolSteps,
  thinkingSteps,
  /** The turn is over: no shimmer, and the count label rather than a live one. */
  sealed = false,
  className,
}: {
  toolSteps?: ToolStep[];
  thinkingSteps?: ThinkingStep[];
  sealed?: boolean;
  className?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const tools = useMemo(() => toolSteps ?? [], [toolSteps]);
  const notes = useMemo(() => thinkingSteps ?? [], [thinkingSteps]);
  const groups = useMemo(() => buildGroups(tools, notes), [tools, notes]);

  if (tools.length === 0 && notes.length === 0) return null;

  const failures = tools.filter((s) => s.status === "error").length;
  const running = !sealed && tools.some((s) => s.status === "running");
  // The count is TOOL STEPS only — reasoning is the agent's voice, not a step,
  // and the resting number must match the chips you can count once open.
  const n = tools.length;

  return (
    <div className={cn("mt-2 max-w-full text-[13px]/5 tracking-normal first:mt-0", className)}>
      <button
        type="button"
        onClick={() => { setExpanded((e) => !e); }}
        aria-expanded={expanded}
        className="grid min-h-6 w-full grid-cols-[1.25rem_minmax(0,1fr)] items-start gap-x-2 py-0.5 text-left outline-none"
      >
        <span className="grid size-5 shrink-0 place-items-center text-(--trace-faint)">
          <Icon
            icon={ArrowRight01Icon}
            className={cn("size-3 transition-transform duration-200", expanded && "rotate-90")}
          />
        </span>
        <span className={cn("min-w-0", running && "t-shimmer")}>
          <span className="font-medium text-foreground">
            {n} step{n === 1 ? "" : "s"}
          </span>
          {/* Failure escapes the fold: it is on the resting line, because a
              signal that needs an expand is already past one second. */}
          {failures > 0 && (
            <span className="font-medium text-[var(--trace-error)]"> · {failures} failed</span>
          )}
        </span>
      </button>

      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-200 ease-out",
          expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
      >
        <div className="overflow-hidden">
          <div className="pt-2">
            {groups.map((g, i) =>
              "note" in g ? (
                <p
                  key={`n${String(g.note.id)}`}
                  className="mt-3 select-text py-0.5 text-(--trace-quiet) [text-wrap:pretty] first:mt-0"
                >
                  {g.note.text}
                </p>
              ) : (
                <div
                  key={`g${String(g.steps[0]?.id ?? i)}`}
                  // The bracket: one hairline in the 16px gutter, inset 4px top
                  // and bottom so it begins and ends INSIDE the first and last
                  // chip. That inset is what stops it reading as a descent line
                  // from the note above — it is a bracket, not a graph edge.
                  className={cn(
                    "relative ps-4",
                    "before:absolute before:inset-y-1 before:start-[7px] before:w-px before:rounded-full before:bg-(--trace-rail)",
                    // Any failure in the bracket escalates the rail to 2px of
                    // solid error red. A 20px chip does not survive peripheral
                    // vision; a high-aspect vertical bar does.
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
    </div>
  );
}
