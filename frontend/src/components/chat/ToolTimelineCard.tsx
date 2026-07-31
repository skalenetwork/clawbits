import { useState } from "react";
import {
  Alert02Icon,
  ArrowRight01Icon,
  CheckmarkCircle02Icon,
} from "@hugeicons/core-free-icons";

import { Icon } from "@/components/Icon";
import type { ToolStep } from "@/hooks/useChannelEvents";
import { formatDuration, toolPresentation } from "@/lib/toolPresentation";
import { cn } from "@/lib/utils";

/**
 * Minimal "tool use" footer for an agent turn — Claude-Code style. Collapsed it
 * is a single quiet line ("Using tools…" while running, "Used N tools" when
 * done) with a disclosure chevron; there is NO command or card chrome at rest.
 * Unfolding reveals a narrow panel listing each step's verb + duration + full
 * command. Rendered at the END of the message (after the answer) so it reads as
 * a footnote, not a header.
 *
 * Data is {@link ToolStep}[] — live per-turn while streaming (from
 * useChannelEvents), and the snapshotted ``finishedToolTraces`` on a published
 * reply so the footer persists on the finished message.
 */

function StepIcon({ status }: { status: ToolStep["status"] }) {
  if (status === "done") {
    return <Icon icon={CheckmarkCircle02Icon} className="size-3.5 shrink-0 text-emerald-500" />;
  }
  if (status === "error") {
    return <Icon icon={Alert02Icon} className="size-3.5 shrink-0 text-amber-500" />;
  }
  return (
    <span
      aria-hidden
      className="size-3.5 shrink-0 animate-spin rounded-full border-2 border-sky-500/70 border-t-transparent motion-reduce:animate-none"
    />
  );
}

/** One expanded row: icon + verb + duration, then the full command below. */
function StepDetail({ step }: { step: ToolStep }) {
  const { verb } = toolPresentation(step.tool);
  const running = step.status === "running";
  const dur = formatDuration(step.duration_ms);
  return (
    <li className="min-w-0">
      <div className="flex min-w-0 items-center gap-1.5 text-[12px] leading-none">
        <StepIcon status={step.status} />
        <span className={cn("min-w-0 truncate font-medium", running ? "t-shimmer" : "text-foreground/90")}>
          {verb}
        </span>
        {dur && (
          <span className="ml-auto shrink-0 pl-1 font-normal tabular-nums text-muted-foreground/60">
            {dur}
          </span>
        )}
      </div>
      {step.label && step.label.trim() && (
        <p
          title={step.label}
          // Show the command in full; ``overflow-wrap:anywhere`` force-breaks a
          // long unbreakable token (path / heredoc) so it wraps inside the panel
          // instead of being clipped by the disclosure's overflow-hidden.
          className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere] pl-5 font-mono text-[11px] leading-snug text-muted-foreground/80"
        >
          {step.label.trim()}
        </p>
      )}
    </li>
  );
}

export function ToolTimelineCard({
  steps,
  className,
}: {
  steps: ToolStep[];
  className?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  if (steps.length === 0) return null;

  const running = steps.some((s) => s.status === "running");
  const n = steps.length;
  const label = running ? "Using tools…" : `Used ${String(n)} tool${n === 1 ? "" : "s"}`;

  return (
    // More breathing room above (separates it from the answer), none below so it
    // hugs the timestamp/meta row that follows.
    <div className={cn("mt-2 max-w-full first:mt-0", className)}>
      {/* Collapsed = one quiet line. No border/bg, no command. */}
      <button
        type="button"
        onClick={() => { setExpanded((e) => !e); }}
        aria-expanded={expanded}
        className="inline-flex items-center gap-1 rounded text-[12px] text-muted-foreground/70 outline-none transition-colors hover:text-muted-foreground focus-visible:text-muted-foreground"
      >
        <span className={running ? "t-shimmer" : undefined}>{label}</span>
        <Icon
          icon={ArrowRight01Icon}
          className={cn("size-3 shrink-0 transition-transform duration-200", expanded && "rotate-90")}
        />
      </button>

      {/* Unfolded detail — narrow panel, grid-rows height animation. */}
      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-200 ease-out",
          expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
      >
        <div className="overflow-hidden">
          <ul className="mt-1.5 max-w-sm space-y-2 rounded-lg border border-border/50 bg-muted/20 px-2.5 py-2">
            {steps.map((s) => (
              <StepDetail key={s.id} step={s} />
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
