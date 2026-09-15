import { AgentFaceAvatar } from "@/components/AgentFaceAvatar";
import { PresenceDot } from "@/components/PresenceDot";
import { UserAvatar } from "@/components/UserAvatar";
import { useAgentStatus } from "@/hooks/useAgentPresence";
import { useUserLastSeen, useUserLastSeenLabel, useUserStatus } from "@/hooks/useUserPresence";
import { agentStatusLabel } from "@/lib/agentLiveness";
import { formatRelativeShort, resolveLastSeen } from "@/lib/formatting";
import { cn } from "@/lib/utils";

export type MemberKind = "agent" | "human";

interface ChannelMemberRowProps {
  name: string;
  /** Short muted status on the right, e.g. "You". Omit to show live presence. */
  caption?: string;
  kind: MemberKind;
  /** Stable seed for the avatar (agent_id for agents; display_name/email for humans). */
  seed: string;
  /** Server-provided avatar URL; the initial-letter fallback otherwise. */
  avatarUrl?: string | null;
  /** Human user id: drives the human presence dot. Omit for agents. */
  humanId?: number | null;
  /** Agent id: drives the agent liveness dot. Omit for humans. */
  agentId?: string | null;
  /** Makes the whole row a button; ``currentTarget`` anchors the profile menu. */
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
}

/** One member, sized like a main-sidebar row: avatar with presence, name, and
 *  a short status on the right. */
export function ChannelMemberRow({
  name,
  caption,
  kind,
  seed,
  avatarUrl,
  humanId,
  agentId,
  onClick,
}: ChannelMemberRowProps) {
  const status = useUserStatus(humanId);
  const lastSeen = useUserLastSeen(humanId);
  const lastSeenLabel = useUserLastSeenLabel(humanId);
  const agentStatus = useAgentStatus(kind === "agent" ? agentId : null);
  const showHumanDot = kind === "human" && humanId != null;
  const showAgentDot = kind === "agent" && agentId != null;
  const dotStatus = showAgentDot ? agentStatus : status;
  const dotTitle = showAgentDot
    ? agentStatusLabel(agentStatus)
    : showHumanDot
      ? status === "offline"
        ? `Last seen ${resolveLastSeen(lastSeen, lastSeenLabel)}`
        : status
      : undefined;
  const presence = showHumanDot
    ? status === "online"
      ? "Online"
      : status === "idle"
        ? "Idle"
        : formatRelativeShort(lastSeen) || "Offline"
    : showAgentDot
      ? agentStatusLabel(agentStatus)
      : undefined;
  const trailing = caption ?? presence;

  const content = (
    <>
      <span className="relative flex shrink-0">
        {kind === "agent"
          ? <AgentFaceAvatar size={20} name={seed} src={avatarUrl}/>
          : <UserAvatar size={20} name={seed} src={avatarUrl}/>}
        {(showHumanDot || showAgentDot) && (
          <span className="pointer-events-none absolute -right-0.5 -bottom-0.5">
            <PresenceDot status={dotStatus} size={7} ringClassName="ring-sidebar" label={dotTitle}/>
          </span>
        )}
      </span>
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {trailing && <span className="shrink-0 text-[11px] font-normal text-muted-foreground tabular-nums">{trailing}</span>}
    </>
  );
  const row = "flex h-[34px] w-full items-center gap-2.5 rounded-md px-2.5 text-left text-[13px] font-medium max-md:h-11";

  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={cn(row, "transition-colors hover:bg-[var(--sb-hover)]")}>
        {content}
      </button>
    );
  }
  return <div className={row}>{content}</div>;
}
