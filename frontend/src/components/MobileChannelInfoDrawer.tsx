import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { useAuth } from "@/context/AuthContext";
import { useAgentPresence } from "@/hooks/useAgentPresence";
import { useUserPresence } from "@/hooks/useUserPresence";
import {
  getMmChannel,
  listMmChannelMembers,
  type MmChannelMember,
} from "@/lib/api";
import { parseUtcTimestamp } from "@/lib/formatting";
import { agentLivenessStatus } from "@/lib/agentLiveness";
import { queryKeys } from "@/lib/queryKeys";
import { errMsg } from "@/lib/toast";
import { ChannelMemberRow, type MemberKind } from "@/components/ChannelMemberRow";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";

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

function memberSeed(m: MmChannelMember): string {
  if (m.human_id != null) return String(m.human_id);
  return m.display_name ?? m.agent_id ?? "user";
}

interface MobileChannelInfoDrawerProps {
  channelId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Mobile "channel info" bottom sheet — the touch counterpart to the desktop
 * ChatInfoSidebar. Opened from the channel header's members pill (which the
 * mobile shell now wires up via outlet context). Lists the channel's members
 * with live presence dots, online-first. Shares the members/channel query keys
 * with ChannelPage + ChatInfoSidebar, so the data is already warm on open.
 */
export function MobileChannelInfoDrawer({
  channelId,
  open,
  onOpenChange,
}: MobileChannelInfoDrawerProps) {
  const { user } = useAuth();
  const { seed } = useUserPresence();
  const { seed: seedAgents } = useAgentPresence();

  const channelQuery = useQuery({
    queryKey: queryKeys.mm.channel(channelId),
    queryFn: () => getMmChannel(channelId),
    enabled: Boolean(channelId) && open,
  });
  const channel = channelQuery.data;

  const membersQuery = useQuery({
    queryKey: queryKeys.mm.channelMembers(channelId),
    queryFn: () => listMmChannelMembers(channelId),
    enabled: Boolean(channelId) && open,
  });
  const members = useMemo(
    () => membersQuery.data?.members ?? [],
    [membersQuery.data],
  );
  const total = membersQuery.data?.total ?? members.length;

  // Online first, then most-recently-seen; stable name tiebreak. Mirrors
  // ChatInfoSidebar so desktop + mobile order members identically.
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

  // Seed the shared presence context so dots paint on first open; SSE keeps
  // them live afterwards.
  useEffect(() => {
    if (members.length === 0) return;
    seed(
      members
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
  }, [members, seed]);

  useEffect(() => {
    if (members.length === 0) return;
    seedAgents(
      members
        .filter((m): m is MmChannelMember & { agent_id: string } => m.agent_id != null)
        .map((m) => ({ agentId: m.agent_id, lastAliveAt: m.last_alive_at ?? null })),
    );
  }, [members, seedAgents]);

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>Members</DrawerTitle>
          <p className="text-sm text-muted-foreground">
            {total === 1 ? "1 member" : `${String(total)} members`}
            {channel?.channel_type && (
              <span className="capitalize">{` · ${channel.channel_type}`}</span>
            )}
          </p>
        </DrawerHeader>

        <div className="flex flex-col pb-2">
          {membersQuery.isLoading && (
            <p className="px-1 py-6 text-center text-sm text-muted-foreground">
              Loading…
            </p>
          )}
          {membersQuery.isError && (
            <p className="px-1 py-6 text-center text-sm text-destructive">
              {errMsg(membersQuery.error, "Couldn't load members")}
            </p>
          )}
          {!membersQuery.isLoading &&
            !membersQuery.isError &&
            members.length === 0 && (
              <p className="px-1 py-6 text-center text-sm text-muted-foreground">
                No members yet.
              </p>
            )}

          {sortedMembers.map((m) => (
            <ChannelMemberRow
              key={`member:${memberKind(m)}:${memberRefId(m)}`}
              name={memberName(m)}
              caption={
                m.human_id != null && m.human_id === user?.id ? "You" : undefined
              }
              kind={memberKind(m)}
              seed={memberSeed(m)}
              avatarUrl={m.avatar?.url}
              humanId={m.human_id}
              agentId={m.agent_id}
            />
          ))}
        </div>
      </DrawerContent>
    </Drawer>
  );
}
