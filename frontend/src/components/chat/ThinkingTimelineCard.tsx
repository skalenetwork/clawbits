import { useState } from "react";
import { ArrowRight01Icon } from "@hugeicons/core-free-icons";

import { Icon } from "@/components/Icon";
import type { ThinkingStep } from "@/hooks/useChannelEvents";
import { cn } from "@/lib/utils";

/**
 * Minimal "reasoning" footer for an agent turn — the thinking counterpart of
 * {@link ToolTimelineCard} and deliberately identical in shape. Collapsed it is
 * a single quiet line ("Thinking…" while a burst is open, "N thoughts" once
 * settled) with a disclosure chevron; unfolding reveals each captured reasoning
 * segment as a quoted line.
 *
 * Data is {@link ThinkingStep}[] — the sanitized tail of each reasoning burst,
 * coalesced in useChannelEvents. Purely page-side: live per-turn while the agent
 * streams, and the snapshotted ``finishedThinkingTraces`` on a published reply so
 * the footer persists. NEVER sent to or stored on the server.
 */

/** One expanded row: a quoted reasoning tail. */
function ThoughtDetail({ step, sealed }: { step: ThinkingStep; sealed: boolean }) {
  const running = !sealed && step.status === "running";
  return (
    <li className="flex min-w-0 gap-2">
      {/* Quote bar — reads as "the agent's own words", and (while open) shimmers
          with the reasoning it belongs to. */}
      <span
        aria-hidden
        className={cn(
          "mt-0.5 w-0.5 shrink-0 self-stretch rounded-full",
          running ? "bg-sky-500/60" : "bg-border/70",
        )}
      />
      <p
        // Show the reasoning tail in full; ``overflow-wrap:anywhere`` force-breaks
        // a long unbreakable token so it wraps inside the panel.
        className={cn(
          "min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere] text-[11px] leading-snug",
          running ? "t-shimmer" : "italic text-muted-foreground/80",
        )}
      >
        {step.text}
      </p>
    </li>
  );
}

export function ThinkingTimelineCard({
  steps,
  /** The reasoning is over (a streaming answer or a finished reply): every
   *  segment renders as settled — no shimmer — and the collapsed label shows the
   *  count rather than "Thinking…". */
  sealed = false,
  className,
}: {
  steps: ThinkingStep[];
  sealed?: boolean;
  className?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  if (steps.length === 0) return null;

  const running = !sealed && steps.some((s) => s.status === "running");
  // Live (unsealed): while the ONLY reasoning captured is the still-open current
  // burst, stay hidden — the status line above already surfaces it verbatim.
  // Reveal once there's an earlier, settled burst worth unfolding.
  if (!sealed && !steps.some((s) => s.status === "done")) return null;

  const n = steps.length;
  const label = running ? "Thinking…" : `${String(n)} thought${n === 1 ? "" : "s"}`;

  return (
    // Match ToolTimelineCard's spacing so the two footers stack evenly.
    <div className={cn("mt-2 max-w-full first:mt-0", className)}>
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

      {/* Unfolded detail — grid-rows height animation, matching the tool card. */}
      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-200 ease-out",
          expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
      >
        <div className="overflow-hidden">
          <ul className="mt-1.5 max-w-sm space-y-2 rounded-lg border border-border/50 bg-muted/20 px-2.5 py-2">
            {steps.map((s) => (
              <ThoughtDetail key={s.id} step={s} sealed={sealed} />
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
