import { useState } from "react";

import { AgentFaceAvatar } from "@/components/AgentFaceAvatar";
import { TurnTrace } from "@/components/chat/TurnTrace";
import { formatTimeOnly } from "@/lib/formatting";
import type { MmChannelMember } from "@/lib/api";
import type { LiveTurn } from "@/lib/turnSteps";

export function GeneratingRow({
  agentId,
  member,
  turn,
  optimistic,
}: {
  agentId: string;
  member: MmChannelMember | null;
  turn?: LiveTurn;
  optimistic: boolean;
}) {
  const name = member?.display_name ?? agentId;
  const [time] = useState(() => formatTimeOnly(new Date().toISOString()));

  return (
    <div className="relative mx-0.5 mt-4 pl-14 pr-3 pt-1.5 pb-0.5">
      <AgentFaceAvatar size={36} name={name} src={member?.avatar?.url} animated className="absolute top-2.5 left-2.5" />
      <div className="flex h-5 items-center gap-2 text-[13px]">
        <span className="truncate font-medium text-muted-foreground">{name}</span>
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{time}</span>
      </div>
      <TurnTrace live={{ turn, agentId, optimistic }} />
    </div>
  );
}
