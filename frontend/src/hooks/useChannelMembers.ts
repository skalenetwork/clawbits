import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import type { MemberKind } from "@/components/ChannelMemberRow";
import { seedMemberPresence } from "@/hooks/useUserPresence";
import { agentLivenessStatus } from "@/lib/agentLiveness";
import { listMmChannelMembers, type MmChannelMember } from "@/lib/api";
import { parseUtcTimestamp } from "@/lib/formatting";
import { queryKeys } from "@/lib/queryKeys";

const isOnline = (m: MmChannelMember) =>
  m.agent_id != null ? agentLivenessStatus(m.last_alive_at ?? null) === "available" : m.status === "online";

const lastSeen = (m: MmChannelMember) => {
  const raw = m.agent_id != null ? m.last_alive_at : m.last_seen_at;
  return raw ? parseUtcTimestamp(raw).getTime() || 0 : 0;
};

const memberName = (m: MmChannelMember) =>
  m.display_name || m.agent_id || (m.human_id != null ? `User ${String(m.human_id)}` : "Unknown");

// Sorted off the fetched payload, so live presence never reshuffles the list.
export function useChannelMembers(channelId: string, enabled = true) {
  const query = useQuery({
    queryKey: queryKeys.mm.channelMembers(channelId),
    queryFn: () => listMmChannelMembers(channelId),
    enabled,
  });
  const members = [...(query.data?.members ?? [])].sort(
    (a, b) =>
      Number(isOnline(b)) - Number(isOnline(a)) ||
      lastSeen(b) - lastSeen(a) ||
      memberName(a).localeCompare(memberName(b)),
  );
  useEffect(() => {
    seedMemberPresence(members);
  }, [members]);
  return { query, members };
}

export const memberKey = (m: MmChannelMember) =>
  `member:${m.agent_id ? "agent" : "human"}:${m.agent_id ?? String(m.human_id ?? "")}`;

export function memberRowProps(m: MmChannelMember, selfId: number | undefined) {
  const kind: MemberKind = m.agent_id ? "agent" : "human";
  return {
    kind,
    name: memberName(m),
    caption: m.human_id != null && m.human_id === selfId ? "You" : undefined,
    seed: m.human_id != null ? String(m.human_id) : (m.display_name ?? m.agent_id ?? "user"),
    avatarUrl: m.avatar?.url,
    humanId: m.human_id,
    agentId: m.agent_id,
  };
}
