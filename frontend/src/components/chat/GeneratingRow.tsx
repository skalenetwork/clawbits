import { useMemo } from "react";

import { AgentFaceAvatar } from "@/components/AgentFaceAvatar";
import { GeneratingIndicator } from "@/components/chat/GeneratingIndicator";
import { useBubbleMode } from "@/hooks/useBubbleMode";
import { formatTimeOnly } from "@/lib/formatting";
import type { AgentActivity, ThinkingStep, ToolStep } from "@/hooks/useChannelEvents";
import type { MmChannelMember, MmChannelType } from "@/lib/api";

/**
 * Ephemeral "agent is replying" row, rendered purely from the agent's
 * ``generating`` presence entry — never a fabricated post in the cache.
 * Because presence self-expires (TTL) and is cleared the moment a finished
 * post lands, this row can't get stranded the way the old placeholder post
 * could. Visually it matches a group-start {@link MessageRow}: avatar +
 * author line + the same {@link GeneratingIndicator} an empty streaming draft
 * shows.
 */
export function GeneratingRow({
  agentId,
  member,
  activity,
  toolSteps,
  thinkingSteps,
  channelType,
  optimistic = false,
}: {
  agentId: string;
  member: MmChannelMember | null;
  /** Live agent-reported detail ("Thinking…", "Using web_search…"). */
  activity?: AgentActivity | null;
  /** Ordered tool calls this turn — rendered as the unfoldable timeline card. */
  toolSteps?: ToolStep[];
  /** Ordered reasoning segments this turn — the unfoldable thinking card. */
  thinkingSteps?: ThinkingStep[];
  channelType?: MmChannelType;
  /** Pre-init (optimistic) state — forwarded to the indicator for the distinct
   *  "warming up" label. */
  optimistic?: boolean;
}) {
  const name = member?.display_name ?? agentId;
  const bubbleMode = useBubbleMode();
  // Shape-match a real message: group-start rows carry a timestamp (next to the
  // name in the classic layout, a trailing meta row in bubble mode). Freeze it
  // at mount so the row doesn't jump when the real reply (with its own
  // ``created_at`` a second or two later) swaps in.
  const time = useMemo(() => formatTimeOnly(new Date().toISOString()), []);

  // Bubble mode: a left-aligned neutral bubble with the same indicator, so the
  // agent's "typing" state reads as an incoming bubble. In a group chat the
  // agent's avatar rides the bottom-left, matching a posted message.
  if (bubbleMode) {
    const showAvatar = channelType !== "direct";
    return (
      <div
        data-generating-agent={agentId}
        className="group/row relative mx-0.5 mt-3 flex min-w-0 items-end justify-start gap-2 px-2"
      >
        {showAvatar && (
          <div className="w-7 shrink-0 self-end">
            <AgentFaceAvatar size={28} name={name} src={member?.avatar?.url} animated />
          </div>
        )}
        <div className="flex max-w-[80%] flex-col items-start gap-1">
          <div className="flex flex-col rounded-2xl rounded-bl-md bg-black/[0.055] px-3 py-2 dark:bg-white/[0.09]">
            {showAvatar && (
              <span className="mb-0.5 truncate text-[13px] font-semibold text-muted-foreground">
                {name}
              </span>
            )}
            <div className="text-[15px] leading-relaxed text-muted-foreground">
              <GeneratingIndicator
                activity={activity}
                toolSteps={toolSteps}
                thinkingSteps={thinkingSteps}
                agentId={agentId}
                optimistic={optimistic}
              />
            </div>
            {/* Trailing meta row mirrors a real message bubble so the handoff to
                the finished reply doesn't grow the bubble by a row. */}
            <div className="mt-2 flex w-full items-center justify-end">
              <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                {time}
              </span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      data-generating-agent={agentId}
      className="group/row relative mx-0.5 mt-4 flex items-start gap-3 rounded-lg pl-2 pr-3 pt-1.5 pb-0.5"
    >
      <span className="relative mt-0.5 inline-flex shrink-0">
        <AgentFaceAvatar size={34} name={name} src={member?.avatar?.url} animated />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-sm font-semibold tracking-tight">{name}</span>
          {/* Match a real group-start header, which carries the timestamp here. */}
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{time}</span>
        </div>
        <div className="text-[15px] leading-relaxed text-muted-foreground">
          <GeneratingIndicator
            activity={activity}
            toolSteps={toolSteps}
            thinkingSteps={thinkingSteps}
            agentId={agentId}
            optimistic={optimistic}
          />
        </div>
      </div>
    </div>
  );
}
