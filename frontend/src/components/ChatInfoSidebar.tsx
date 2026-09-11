import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, Users } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { useAgentPresence } from "@/hooks/useAgentPresence";
import { useUserPresence } from "@/hooks/useUserPresence";
import { useChannelActions } from "@/hooks/useChannelActions";
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
import { ProfileMenuProvider } from "@/components/ProfileMenu";
import { useProfileMenuTrigger } from "@/components/profileMenuContext";
import { mentionHandle } from "@/lib/messageHelpers";
import { PanelNote, RightPanel } from "@/components/sidebars/RightPanel";
import { CollapsibleGroup } from "@/components/sidebars/CollapsibleGroup";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";

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

/** One component per row so each can call ``useProfileMenuTrigger``. */
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
  const channelActions = useChannelActions();

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

  // Own provider: this panel renders beside the routed page, outside
  // ChannelPage's. No ``onMentionInsert``, as there is no composer here.
  return (
    <ProfileMenuProvider
      orgId={orgId}
      currentUserId={user?.id ?? null}
    >
      <RightPanel
        open={open}
        title="Channel info"
        meta={channel?.channel_type && (
          <span className="shrink-0 rounded-full bg-foreground/6 px-1.5 py-0.5 text-[11px] leading-none text-muted-foreground capitalize">
            {channel.channel_type}
          </span>
        )}
        onClose={onClose}
        footer={channel && (
          <SidebarMenu>
            {canManage && (
              <SidebarMenuItem>
                <SidebarMenuButton onClick={() => { setManageOpen(true); }} className="text-muted-foreground">
                  <Users/>
                  <span>Manage members</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            )}
            <SidebarMenuItem>
              <SidebarMenuButton onClick={() => { channelActions.exportChat(channel); }} className="text-muted-foreground">
                <Download/>
                <span>Export chat</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        )}
      >
        {membersQuery.isLoading && <PanelNote>Loading…</PanelNote>}
        {membersQuery.isError && <PanelNote error>{errMsg(membersQuery.error, "Couldn't load members")}</PanelNote>}
        {!membersQuery.isLoading && !membersQuery.isError && members.length === 0 && (
          <PanelNote>No members yet.</PanelNote>
        )}
        {members.length > 0 && (
          <CollapsibleGroup id="channel_members" label="Members">
            {sortedMembers.map(m => (
              <SidebarMenuItem key={`member:${memberKind(m)}:${memberRefId(m)}`}>
                <MemberRowTrigger member={m} caption={m.human_id === user?.id ? "You" : undefined}/>
              </SidebarMenuItem>
            ))}
          </CollapsibleGroup>
        )}
      </RightPanel>

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
