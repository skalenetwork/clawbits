import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Message01Icon } from "@hugeicons/core-free-icons";
import { AgentFaceAvatar } from "@/components/AgentFaceAvatar";
import { PresenceDot } from "@/components/PresenceDot";
import { UserAvatar } from "@/components/UserAvatar";
import { Icon } from "@/components/Icon";
import { useAuth } from "@/context/AuthContext";
import { useAgentPresence, useAgentStatus } from "@/hooks/useAgentPresence";
import { useUserPresence, useUserStatus } from "@/hooks/useUserPresence";
import { agentStatusLabel } from "@/lib/agentLiveness";
import { listMmChannelMembers, type MmChannelMember } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";

interface ChatAvatarProps {
  channelId: string;
  /** Outer box size in px. Stacked sub-avatars are ~70% of this. */
  size?: number;
  /** Tailwind ring color class matching the row's background so the stacked
      avatar reads as overlapping. Examples: "ring-sidebar", "ring-card". */
  ringClassName?: string;
  /** When false, suppress the top-right presence dot on human DM peers.
   *  Used by the DM channel-page header pill, which renders its own
   *  trailing dot at the end of the pill instead. Default true. */
  showPresenceDot?: boolean;
  className?: string;
}

function MemberAvatar({ member, size }: { member: MmChannelMember; size: number }) {
  // Both DiceBear styles we use (bottts-neutral for agents, glass for
  // humans) ship with their own background — no need to inset the
  // SVG within the parent frame any more. Render edge-to-edge and let
  // the parent ChatAvatar frame (rounded-lg overflow-hidden) clip the
  // corners. framed={false} suppresses the Avatar component's own
  // muted-bg wrapper since the parent already provides it.
  // ``rounded-none`` so the avatar art fills the box edge-to-edge; the parent
  // ChatAvatar frame (overflow-hidden + its own radius) is the sole clipper.
  // Otherwise the inner Avatar's default ``rounded-lg`` (10px) over-rounds past
  // a smaller frame radius (e.g. the rail's ``rounded-md`` 8px), leaving a
  // muted-bg sliver in each corner.
  if (member.agent_id) {
    return (
      <AgentFaceAvatar
        src={member.avatar?.url}
        size={size}
        name={member.display_name ?? member.agent_id}
        framed={false}
        className="rounded-none"
      />
    );
  }
  const seed = member.human_id != null ? String(member.human_id) : (member.display_name ?? "user");
  return <UserAvatar size={size} name={seed} src={member.avatar?.url} className="rounded-none" />;
}

/** Top-right presence dot for a human DM peer. Rendered as a sibling
 *  of the avatar frame — not inside — so the frame's overflow-hidden
 *  doesn't clip it. */
function DmPeerDot({
  humanId,
  avatarSize,
  ringClassName,
}: {
  humanId: number;
  avatarSize: number;
  ringClassName: string;
}) {
  const status = useUserStatus(humanId);
  // Scale the dot to roughly a fifth of the avatar with a 7px floor so
  // it stays readable on the small (26px) sidebar avatars without
  // crowding the avatar art at larger sizes.
  const dotSize = Math.max(7, Math.round(avatarSize * 0.22));
  return (
    <span
      className="pointer-events-none absolute bottom-0 right-0"
      title={status}
    >
      <PresenceDot status={status} size={dotSize} ringClassName={ringClassName} />
    </span>
  );
}

/** Top-right liveness dot for an agent DM peer (Available / Offline /
 *  Setting up…). Mirror of ``DmPeerDot`` but keyed on agent liveness. */
function AgentDmPeerDot({
  agentId,
  avatarSize,
  ringClassName,
}: {
  agentId: string;
  avatarSize: number;
  ringClassName: string;
}) {
  const status = useAgentStatus(agentId);
  const dotSize = Math.max(7, Math.round(avatarSize * 0.22));
  return (
    <span
      className="pointer-events-none absolute bottom-0 right-0"
      title={agentStatusLabel(status)}
    >
      <PresenceDot
        status={status}
        size={dotSize}
        ringClassName={ringClassName}
        label={agentStatusLabel(status)}
      />
    </span>
  );
}

export function ChatAvatar({
  channelId,
  size = 20,
  ringClassName = "ring-sidebar",
  showPresenceDot = true,
  className,
}: ChatAvatarProps) {
  const { user } = useAuth();
  const { seed } = useUserPresence();
  const { seed: seedAgents } = useAgentPresence();

  const membersQuery = useQuery({
    queryKey: queryKeys.mm.channelMembers(channelId),
    queryFn: () => listMmChannelMembers(channelId),
    enabled: Boolean(channelId),
  });

  // Seed presence from the member-list payload — the server includes a
  // best-effort status snapshot from Redis. SSE will keep it fresh
  // afterwards.
  useEffect(() => {
    const ms = membersQuery.data?.members;
    if (!ms || ms.length === 0) return;
    seed(
      ms
        .filter(
          (
            m,
          ): m is MmChannelMember & {
            human_id: number;
            status: NonNullable<MmChannelMember["status"]>;
          } => m.human_id != null && m.status != null,
        )
        .map((m) => ({
          humanId: m.human_id,
          status: m.status,
          lastSeenAt: m.last_seen_at,
          lastSeenLabel: m.last_seen_label ?? null,
        })),
    );
  }, [membersQuery.data, seed]);

  // Seed agent liveness from the same payload (covers the DM-peer agent dot).
  useEffect(() => {
    const ms = membersQuery.data?.members;
    if (!ms || ms.length === 0) return;
    seedAgents(
      ms
        .filter((m): m is MmChannelMember & { agent_id: string } => m.agent_id != null)
        .map((m) => ({ agentId: m.agent_id, lastAliveAt: m.last_alive_at ?? null })),
    );
  }, [membersQuery.data, seedAgents]);

  const containerStyle = { width: size, height: size };
  // Always frame inside a rounded muted box so agent-face avatars (whose
  // SVGs are transparent outside the character outline) read as a single
  // tile, matching the public/private channel glyph treatment. The
  // frame itself is overflow-hidden; the presence dot is rendered as a
  // sibling of the frame (inside an outer relative wrapper) so it
  // overhangs without being clipped.
  //
  // We deliberately do NOT add a border here: with ``box-sizing:
  // border-box`` (Tailwind default), a 1px border on each side shrinks
  // the content area to ``size-2`` while the inner ``<img>`` is still
  // rendered at full ``size``, so it overflows and gets clipped from
  // the top-left → the avatar visibly shifts up/left inside the frame.
  // The ``bg-muted`` fill plus ``rounded-lg`` is enough visual framing.
  const frameClass = cn(
    "relative shrink-0 overflow-hidden rounded-lg bg-muted",
    className,
  );

  // Loading: quiet rounded placeholder. Don't flash the fallback icon.
  if (membersQuery.isLoading) {
    return (
      <div
        className={cn(frameClass, "bg-muted/60")}
        style={containerStyle}
      />
    );
  }

  const members = membersQuery.data?.members ?? [];
  const others = members.filter(
    m => !(m.human_id != null && user?.id != null && m.human_id === user.id),
  );

  // 0 others: the user is alone (or fetch failed). Fall back to the generic icon,
  // sized proportional to the container.
  if (others.length === 0) {
    return (
      <div
        className={cn(frameClass, "flex items-center justify-center text-muted-foreground")}
        style={containerStyle}
      >
        <Icon icon={Message01Icon} style={{ width: size * 0.8, height: size * 0.8 }} />
      </div>
    );
  }

  // Exactly one other: render their avatar filling the box. For human
  // peers, overlay a top-right presence dot on the outer wrapper so it
  // visually corner-attaches without being clipped by the frame's
  // overflow-hidden.
  const [a, b] = others;
  if (others.length === 1 && a) {
    return (
      <div className="relative shrink-0" style={containerStyle}>
        <div className={frameClass} style={containerStyle}>
          <MemberAvatar member={a} size={size} />
        </div>
        {showPresenceDot && a.human_id != null && (
          <DmPeerDot
            humanId={a.human_id}
            avatarSize={size}
            ringClassName={ringClassName}
          />
        )}
        {showPresenceDot && a.agent_id != null && (
          <AgentDmPeerDot
            agentId={a.agent_id}
            avatarSize={size}
            ringClassName={ringClassName}
          />
        )}
      </div>
    );
  }

  if (!a || !b) return null;

  // Two or more: stack the first two, second ringed with the row background so it reads
  // as in-front. Sub-avatars are 70% of the container; placed at top-left and bottom-right.
  const inner = Math.round(size * 0.7);
  const innerStyle = { width: inner, height: inner };
  return (
    <div className={frameClass} style={containerStyle}>
      <div
        className="absolute left-0 top-0 flex items-center justify-center overflow-hidden rounded-lg bg-muted"
        style={innerStyle}
      >
        <MemberAvatar member={a} size={inner} />
      </div>
      <div
        className={cn(
          "absolute bottom-0 right-0 flex items-center justify-center overflow-hidden rounded-lg bg-muted ring-2",
          ringClassName,
        )}
        style={innerStyle}
      >
        <MemberAvatar member={b} size={inner} />
      </div>
    </div>
  );
}
