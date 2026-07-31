import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Cancel01Icon, UserMultiple02Icon } from "@hugeicons/core-free-icons";
import { Icon } from "@/components/Icon";
import { useAuth } from "@/context/AuthContext";
import { useAgentPresence } from "@/hooks/useAgentPresence";
import { useUserPresence } from "@/hooks/useUserPresence";
import {
  getMmChannel,
  listMmChannelMembers,
  type MmChannelMember,
} from "@/lib/api";
import { formatChannelTitle, parseUtcTimestamp } from "@/lib/formatting";
import { agentLivenessStatus } from "@/lib/agentLiveness";
import { queryKeys } from "@/lib/queryKeys";
import { errMsg } from "@/lib/toast";
import { ChannelMemberRow, type MemberKind } from "./ChannelMemberRow";
import ManageMembersDialog from "./AddMemberDialog";
import { ProfileMenuProvider, useProfileMenuTrigger } from "@/components/ProfileMenu";
import { mentionHandle } from "@/lib/messageHelpers";

interface ChatInfoSidebarProps {
  channelId: string;
  open: boolean;
  onClose: () => void;
}

function memberKind(m: MmChannelMember): MemberKind {
  return m.agent_id ? "agent" : "human";
}

function memberRefId(m: MmChannelMember): string {
  return m.agent_id ?? String(m.human_id ?? "");
}

function memberName(m: MmChannelMember): string {
  if (m.display_name) return m.display_name;
  if (m.agent_id) return m.agent_id;
  if (m.human_id != null) return `User ${String(m.human_id)}`;
  return "Unknown";
}

function memberCaption(m: MmChannelMember, selfId: number | undefined): string | undefined {
  if (m.human_id != null && m.human_id === selfId) return "You";
  // Agents: leave undefined so ChannelMemberRow auto-fills the live status
  // caption ("Agent · Available" / "Offline" / "Setting up…"), mirroring how
  // humans get "Online" / "Idle" / "Last seen …".
  return undefined;
}

/** Wrapping each member row in its own component lets us call the
 *  ``useProfileMenuTrigger`` hook per row without breaking the rules of
 *  hooks (hooks can't run inside a ``.map`` callback directly). The
 *  hook returns the click handler; we forward it as the row's onClick
 *  so the whole row becomes the trigger button. */
function MemberRowTrigger({
  member,
  caption,
}: {
  member: MmChannelMember;
  caption: string | undefined;
}) {
  const handleText = `@${mentionHandle(member)}`;
  const onClick = useProfileMenuTrigger(member, handleText);
  return (
    <ChannelMemberRow
      name={memberName(member)}
      caption={caption}
      kind={memberKind(member)}
      seed={memberSeed(member)}
      avatarUrl={member.avatar?.url}
      humanId={member.human_id}
      agentId={member.agent_id}
      onClick={onClick}
    />
  );
}

function memberSeed(m: MmChannelMember): string {
  // Humans: stable numeric id so the same person renders identically across
  // every viewer's account (display_name and email aren't stable cross-account).
  if (m.human_id != null) return String(m.human_id);
  // For agents, the backend already resolved display_name through the
  // profile→nickname→agent_id chain. Use that as the avatar seed so a
  // renamed agent picks a new face.
  return m.display_name ?? m.agent_id ?? "user";
}

export default function ChatInfoSidebar({ channelId, open, onClose }: ChatInfoSidebarProps) {
  const { user } = useAuth();
  const { seed } = useUserPresence();
  const { seed: seedAgents } = useAgentPresence();
  const [manageOpen, setManageOpen] = useState(false);

  const channelQuery = useQuery({
    queryKey: queryKeys.mm.channel(channelId),
    queryFn: () => getMmChannel(channelId),
    enabled: Boolean(channelId),
  });
  const channel = channelQuery.data;
  const orgId = channel?.org_id ?? null;
  const channelLabel = formatChannelTitle(channel?.display_name ?? channel?.name, "channel");

  const membersQuery = useQuery({
    queryKey: queryKeys.mm.channelMembers(channelId),
    queryFn: () => listMmChannelMembers(channelId),
    enabled: Boolean(channelId),
  });
  const members = membersQuery.data?.members ?? [];

  // Sort members: online first, then by most-recent last-seen. Humans use
  // ``status`` + ``last_seen_at``; agents re-derive liveness from
  // ``last_alive_at`` through the same rule the presence dot uses, ordered by
  // that ping. Name is a stable final tiebreak. Sorts off the fetched payload
  // (not live SSE) so the list doesn't reshuffle on every heartbeat.
  const sortedMembers = useMemo(() => {
    const isOnline = (m: MmChannelMember): boolean =>
      m.agent_id != null
        ? agentLivenessStatus(m.last_alive_at ?? null) === "available"
        : m.status === "online";
    const lastSeenTs = (m: MmChannelMember): number => {
      const raw = m.agent_id != null ? m.last_alive_at : m.last_seen_at;
      if (!raw) return 0;
      const t = parseUtcTimestamp(raw).getTime();
      return Number.isNaN(t) ? 0 : t;
    };
    return [...members].sort((a, b) => {
      const ao = isOnline(a);
      const bo = isOnline(b);
      if (ao !== bo) return ao ? -1 : 1;
      const at = lastSeenTs(a);
      const bt = lastSeenTs(b);
      if (at !== bt) return bt - at;
      return memberName(a).localeCompare(memberName(b));
    });
  }, [members]);

  // Push the server-seeded statuses into the shared presence context so
  // the dots paint on first render. SSE keeps them live afterwards.
  useEffect(() => {
    if (members.length === 0) return;
    seed(
      members
        .filter(
          (m): m is MmChannelMember & { human_id: number } =>
            m.human_id != null && m.status != null,
        )
        .map((m) => ({
          humanId: m.human_id,
          status: m.status!,
          lastSeenAt: m.last_seen_at,
          lastSeenLabel: m.last_seen_label ?? null,
        })),
    );
  }, [members, seed]);

  // Seed agent liveness from the same payload so agent dots paint on first
  // render; the agent.status SSE event keeps them live afterwards.
  useEffect(() => {
    if (members.length === 0) return;
    seedAgents(
      members
        .filter((m): m is MmChannelMember & { agent_id: string } => m.agent_id != null)
        .map((m) => ({ agentId: m.agent_id, lastAliveAt: m.last_alive_at ?? null })),
    );
  }, [members, seedAgents]);

  const canManage = channel?.channel_type !== "direct" && orgId !== null;

  // Local provider so members in this sidebar can open the shared
  // ProfileMenu without depending on a parent provider — ChatInfoSidebar
  // is a sibling of ``Outlet`` in AppShell, so a provider rooted in
  // ChannelPage doesn't reach it. ``onMentionInsert`` is intentionally
  // omitted here (the sidebar isn't near a composer); the action just
  // doesn't render.
  return (
    <ProfileMenuProvider
      orgId={orgId}
      currentUserId={user?.id ?? null}
    >
      <aside
        data-state={open ? "expanded" : "collapsed"}
        aria-hidden={!open}
        className="hidden shrink-0 justify-end overflow-hidden pb-2 pt-[max(var(--titlebar-height),0.5rem)] transition-[width] duration-200 ease-linear md:flex data-[state=collapsed]:w-0 data-[state=expanded]:w-[calc(var(--sidebar-width)+3.5rem)]"
      >
        <div className="relative mr-2 flex h-full w-[calc(var(--sidebar-width)+3rem)] shrink-0 flex-col overflow-hidden rounded-xl border border-sidebar-border bg-panel text-sidebar-foreground">
          {/* Overlaid header — the same h-12 frosted bar as the sidebar's
              ContextualHeader and the content card's page-header, so all three
              line up as one header row across the card. The member list scrolls
              behind it; the scroll region below clears it with top padding. */}
          <header className="absolute inset-x-0 top-0 z-10 flex h-12 items-center justify-between gap-2 border-b border-sidebar-border bg-panel/80 px-3 backdrop-blur-xl supports-[backdrop-filter]:bg-panel/65">
            <h2 className="truncate text-sm font-semibold text-sidebar-foreground">Channel info</h2>
            <div className="flex shrink-0 items-center gap-1.5">
              {channel?.channel_type && (
                <span className="rounded-full border border-sidebar-border bg-sidebar-accent/40 px-2 py-0.5 text-[11px] font-medium capitalize text-muted-foreground">
                  {channel.channel_type}
                </span>
              )}
              <button
                type="button"
                onClick={onClose}
                aria-label="Close channel info"
                className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Icon icon={Cancel01Icon} className="size-4" />
              </button>
            </div>
          </header>

          <div className="no-scrollbar flex-1 overflow-y-auto px-2 pb-3 pt-14">
            {membersQuery.isLoading && (
              <p className="px-3 py-4 text-center text-xs text-muted-foreground">Loading…</p>
            )}
            {membersQuery.isError && (
              <p className="px-3 py-4 text-center text-xs text-destructive">
                {errMsg(membersQuery.error, "Couldn't load members")}
              </p>
            )}
            {!membersQuery.isLoading && !membersQuery.isError && members.length === 0 && (
              <p className="px-3 py-4 text-center text-xs text-muted-foreground">No members yet.</p>
            )}

            {sortedMembers.map(m => (
              <MemberRowTrigger
                key={`member:${memberKind(m)}:${memberRefId(m)}`}
                member={m}
                caption={memberCaption(m, user?.id)}
              />
            ))}
          </div>

          {canManage && (
            <div className="shrink-0 p-2">
              <button
                type="button"
                onClick={() => { setManageOpen(true); }}
                className="flex w-full items-center justify-center gap-1.5 rounded-md border border-sidebar-border bg-sidebar-accent/40 px-2.5 py-1 text-[12px] font-medium text-sidebar-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              >
                <Icon icon={UserMultiple02Icon} className="size-3 text-muted-foreground" />
                <span className="truncate">Manage members</span>
              </button>
            </div>
          )}
        </div>
      </aside>

      {canManage && orgId && (
        <ManageMembersDialog
          open={manageOpen}
          onOpenChange={setManageOpen}
          channelId={channelId}
          orgId={orgId}
          channelLabel={channelLabel}
        />
      )}
    </ProfileMenuProvider>
  );
}
