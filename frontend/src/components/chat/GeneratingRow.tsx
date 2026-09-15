import { useState } from "react";

import { AgentFaceAvatar } from "@/components/AgentFaceAvatar";
import { GeneratingIndicator } from "@/components/chat/GeneratingIndicator";
import { formatTimeOnly } from "@/lib/formatting";
import type { AgentActivity, ThinkingStep, ToolStep } from "@/hooks/useChannelEvents";
import type { MmChannelMember } from "@/lib/api";

export function GeneratingRow({
  agentId,
  member,
  activity,
  toolSteps,
  thinkingSteps,
  optimistic,
}: {
  agentId: string;
  member: MmChannelMember | null;
  activity?: AgentActivity;
  toolSteps?: ToolStep[];
  thinkingSteps?: ThinkingStep[];
  optimistic: boolean;
}) {
  const name = member?.display_name ?? agentId;
  const [time] = useState(() => formatTimeOnly(new Date().toISOString()));

  return (
    <div className="mx-0.5 mt-4 pl-2.5 pr-3 pt-1.5 pb-0.5">
      <div className="mb-1 flex h-5 items-center gap-2 text-[13px]">
        <AgentFaceAvatar size={20} name={name} src={member?.avatar?.url} animated className="shrink-0" />
        <span className="relative -top-px truncate font-medium text-muted-foreground">{name}</span>
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{time}</span>
      </div>
      <div className="text-message text-muted-foreground">
        <GeneratingIndicator
          activity={activity}
          toolSteps={toolSteps}
          thinkingSteps={thinkingSteps}
          agentId={agentId}
          optimistic={optimistic}
        />
      </div>
    </div>
  );
}
