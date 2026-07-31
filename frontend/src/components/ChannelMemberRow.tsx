import type { ReactNode } from "react";
import { AgentFaceAvatar } from "@/components/AgentFaceAvatar";
import { PresenceDot } from "@/components/PresenceDot";
import { UserAvatar } from "@/components/UserAvatar";
import { useAgentStatus } from "@/hooks/useAgentPresence";
import { useUserLastSeen, useUserLastSeenLabel, useUserStatus } from "@/hooks/useUserPresence";
import { agentStatusLabel } from "@/lib/agentLiveness";
import { resolveLastSeen } from "@/lib/formatting";
import { cn } from "@/lib/utils";

export type MemberKind = "agent" | "human";

interface ChannelMemberRowProps {
  name: string;
  /** Small muted caption under the name — e.g. "Agent" or "you@domain". Omit for a plain row. */
  caption?: string;
  kind: MemberKind;
  /** Stable seed for the avatar (agent_id for agents; display_name/email for humans). */
  seed: string;
  /** Server-provided avatar URL. When present, renders the R2-stored
   *  SVG; otherwise the initial-letter fallback. */
  avatarUrl?: string | null;
  /** Human user id — drives the human presence dot. Omit for agents. */
  humanId?: number | null;
  /** Agent id — drives the agent liveness dot. Omit for humans. */
  agentId?: string | null;
  trailing?: ReactNode;
  /** If provided, the whole row becomes a clickable button (used for
   *  the add-member list and the profile-menu trigger in ChatInfoSidebar).
   *  The event carries the button element as ``currentTarget``, which
   *  ProfileMenu uses as the popover anchor. */
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
}

export function ChannelMemberRow({
  name,
  caption,
  kind,
  seed,
  avatarUrl,
  humanId,
  agentId,
  trailing,
  onClick,
  disabled,
}: ChannelMemberRowProps) {
  const status = useUserStatus(humanId);
  const lastSeen = useUserLastSeen(humanId);
  const lastSeenLabel = useUserLastSeenLabel(humanId);
  // Agent global liveness. Always called (rules of hooks); returns "offline"
  // for non-agent rows since we pass null there.
  const agentStatus = useAgentStatus(kind === "agent" ? agentId : null);
  const showHumanDot = kind === "human" && humanId != null;
  const showAgentDot = kind === "agent" && agentId != null;
  const showDot = showHumanDot || showAgentDot;
  const dotStatus = showAgentDot ? agentStatus : status;
  // Tooltip text — agent label for agents; for offline humans the absolute
  // last-seen fallback; otherwise the raw status string.
  const dotTitle = showAgentDot
    ? agentStatusLabel(agentStatus)
    : showHumanDot
      ? status === "offline"
        ? `Last seen ${resolveLastSeen(lastSeen, lastSeenLabel)}`
        : status
      : undefined;

  // Auto-populated status caption. The caller can still override via the
  // `caption` prop (e.g. "You" for the current user) — we only fill the slot
  // when the caller leaves it empty.
  const presenceCaption = showHumanDot
    ? status === "online"
      ? "Online"
      : status === "idle"
        ? "Idle"
        : `Last seen ${resolveLastSeen(lastSeen, lastSeenLabel)}`
    : showAgentDot
      ? `Agent · ${agentStatusLabel(agentStatus)}`
      : undefined;
  const effectiveCaption = caption ?? presenceCaption;

  const avatar =
    kind === "agent"
      ? <AgentFaceAvatar size={28} name={seed} src={avatarUrl} />
      : <UserAvatar size={28} name={seed} src={avatarUrl} />;

  const avatarWrap = (
    <span className="relative flex shrink-0 items-center justify-center">
      {avatar}
      {showDot && (
        <span
          className="pointer-events-none absolute bottom-0 right-0"
          title={dotTitle}
        >
          <PresenceDot
            status={dotStatus}
            size={8}
            ringClassName="ring-sidebar"
            label={dotTitle}
          />
        </span>
      )}
    </span>
  );

  const content = (
    <>
      {avatarWrap}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium leading-tight">{name}</span>
        {effectiveCaption && (
          <span className="block truncate text-[11px] text-muted-foreground leading-tight">{effectiveCaption}</span>
        )}
      </span>
      {trailing && <span className="shrink-0">{trailing}</span>}
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className={cn(
          "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors",
          "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
          "disabled:pointer-events-none disabled:opacity-50",
        )}
      >
        {content}
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2.5 rounded-md px-2 py-1.5">
      {content}
    </div>
  );
}
