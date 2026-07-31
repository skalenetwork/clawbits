import { useEffect, useState } from "react";
import type { BrailleSpinnerName } from "unicode-animations";

import { AnimateHeight } from "@/components/AnimateHeight";
import { UnicodeSpinner } from "@/components/UnicodeSpinner";
import { ToolTimelineCard } from "@/components/chat/ToolTimelineCard";
import { ThinkingTimelineCard } from "@/components/chat/ThinkingTimelineCard";
import { useAgentGeneratingWord } from "@/hooks/useGeneratingWord";
import { spinnerForAgent, warmingWordForAgent } from "@/lib/generatingWords";
import type { AgentActivity, ThinkingStep, ToolStep } from "@/hooks/useChannelEvents";

/**
 * The inline "agent is replying" indicator — a SINGLE panel that morphs rather
 * than a set of components that swap. From the first heartbeat to the first
 * token it is always the same box:
 *
 *   ┌ (tool-timeline card, once any tool runs — grows in with animated height)
 *   └ status line: [spinner] + a shimmering label that CROSSFADES between the
 *     rotating gerund ("Pondering…") and "Thinking…" + a sanitized tail.
 *
 * Wrapped in {@link AnimateHeight} so every change (the gerund rotating, the
 * card unfolding, a step settling) is a gentle resize — never an abrupt jump.
 * The spinner is chosen deterministically from the agent id and the gerund is
 * shared per-agent, so the presence-derived {@link GeneratingRow} and the
 * empty-draft branch of MessageRow's ``DraftBody`` stay pixel-identical across
 * the handoff the instant the real streaming post lands.
 */

// The single label shown in the status line at any moment. A change in ``key``
// triggers the crossfade; a change in ``primary`` alone updates in place.
//
//  - ``word``: the rotating gerund ("Pondering…") — shimmering, with the
//    trailing ellipsis this component appends.
//  - ``thinking``: the agent's live reasoning tail shown IN PLACE of the default
//    "Thinking…" — shimmering, single line, width-capped so a long tail can't
//    stretch the message (the overflow clips with an ellipsis).
interface StatusLabel {
  key: string;
  variant: "word" | "thinking";
  primary: string;
}

function LabelBody({ label }: { label: StatusLabel }) {
  if (label.variant === "thinking") {
    return <span className="block max-w-[22rem] truncate t-shimmer">{label.primary}</span>;
  }
  return <span className="t-shimmer block truncate whitespace-nowrap">{label.primary}…</span>;
}

/**
 * The status line. One spinner slot (reserved width so hiding the spinner once a
 * tool card carries the motion doesn't shift the label) plus a single label slot
 * that crossfades on every ``primary`` change — gerund rotation, gerund→
 * "Thinking", "Thinking"→gerund — and updates the ``detail`` tail in place. One
 * element throughout, so a phase change is a morph, not a component swap.
 */
function StatusLine({
  spinner,
  showSpinner,
  label,
}: {
  spinner: BrailleSpinnerName;
  showSpinner: boolean;
  label: StatusLabel;
}) {
  const [current, setCurrent] = useState(label);
  const [previous, setPrevious] = useState<StatusLabel | null>(null);
  // React's sanctioned "adjust state during render": a new primary label becomes
  // the outgoing crossfade layer; a mere detail/primary tick under the same key
  // updates in place without re-triggering the fade.
  if (label.key !== current.key) {
    setPrevious(current);
    setCurrent(label);
  } else if (label.primary !== current.primary) {
    setCurrent(label);
  }
  // Retire the outgoing layer once its 600ms crossfade (see the
  // .thinking-word-out rule in index.css) has played.
  useEffect(() => {
    if (previous === null) return;
    const handle = window.setTimeout(() => { setPrevious(null); }, 600);
    return () => { window.clearTimeout(handle); };
  }, [previous]);

  return (
    <p className="my-1 flex min-w-0 items-center gap-2 first:mt-0 last:mb-0">
      <span aria-hidden className="flex w-4 shrink-0 justify-center">
        {showSpinner && (
          <UnicodeSpinner
            name={spinner}
            className="text-muted-foreground/90 tabular-nums"
            ariaLabel={current.variant === "thinking" ? "thinking…" : `${current.primary.toLowerCase()}…`}
          />
        )}
      </span>
      <span className="grid min-w-0">
        {previous !== null && (
          <span
            key={previous.key}
            aria-hidden
            className="thinking-word-out col-start-1 row-start-1 min-w-0"
          >
            <LabelBody label={previous} />
          </span>
        )}
        <span key={current.key} className="thinking-word-in col-start-1 row-start-1 min-w-0">
          <LabelBody label={current} />
        </span>
      </span>
    </p>
  );
}

export function GeneratingIndicator({
  activity,
  toolSteps,
  thinkingSteps,
  agentId,
  optimistic = false,
}: {
  activity?: AgentActivity | null;
  toolSteps?: ToolStep[];
  /** Ordered reasoning segments this turn — the unfoldable thinking-timeline
   *  card (self-hides while the only segment is the live one shown above). */
  thinkingSteps?: ThinkingStep[];
  /** Drives the deterministic spinner + shared per-agent gerund so the
   *  presence-row → streaming-draft handoff is visually seamless. */
  agentId?: string;
  /** Pre-init state: we optimistically showed "generating" on send but the
   *  agent hasn't produced any real signal yet. Shows the distinct "warming up"
   *  word set until the first real activity crossfades in. */
  optimistic?: boolean;
} = {}) {
  const word = useAgentGeneratingWord(agentId);
  const spinner: BrailleSpinnerName = agentId ? spinnerForAgent(agentId) : "braille";

  const hasTools = (toolSteps?.length ?? 0) > 0;
  const thinkingLine =
    activity?.kind === "thinking" && activity.label?.trim() ? activity.label.trim() : null;

  // The status line persists throughout (calm continuity). Pre-init (optimistic,
  // no real signal yet) → the "warming up" set; a live thinking tail → the
  // reasoning ITSELF (replacing the default "Thinking…", width-capped); otherwise
  // the rotating gerund. Each is a distinct ``key``, so the transition
  // crossfades. The braille spinner rides the line only until a tool card
  // appears — after that the card's own spinner carries the motion.
  const label: StatusLabel =
    optimistic && !hasTools && !thinkingLine
      ? (() => {
          const w = agentId ? warmingWordForAgent(agentId) : "Warming up";
          return { key: `warm:${w}`, variant: "word", primary: w };
        })()
      : thinkingLine
        ? { key: "thinking", variant: "thinking", primary: thinkingLine }
        : { key: `word:${word}`, variant: "word", primary: word };

  return (
    <AnimateHeight>
      <div className="animate-activity-in">
        <StatusLine spinner={spinner} showSpinner label={label} />
        {/* Footers sit BELOW the status line (end of the block): captured
            reasoning first, then tools — the order they happen in. Each is a
            quiet, self-hiding disclosure line. */}
        {thinkingSteps && <ThinkingTimelineCard steps={thinkingSteps} />}
        {hasTools && toolSteps && <ToolTimelineCard steps={toolSteps} />}
      </div>
    </AnimateHeight>
  );
}
