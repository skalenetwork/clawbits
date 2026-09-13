import { useQuery } from "@tanstack/react-query";

import { useAuth } from "@/context/AuthContext";
import { getAgents, listOrgMembers } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";

export interface DirectoryEntry {
  key: string;
  kind: "agent" | "human";
  id: string;
  name: string;
  avatarUrl?: string | null;
}

/** Peer agents then people in the active org, never the viewer. `sections` keeps only groups with matches;
 *  `dmOnly` keeps only the agents this viewer may message. Search also matches an email or the word "agent". */
export function useOrgDirectory({ enabled, needle, dmOnly = false }: {
  enabled: boolean;
  needle: string;
  dmOnly?: boolean;
}) {
  const { user, activeOrgId } = useAuth();
  const orgId = activeOrgId ?? "";
  const ready = enabled && orgId !== "";
  const members = useQuery({
    queryKey: queryKeys.orgMembers(orgId),
    queryFn: () => listOrgMembers(orgId),
    enabled: ready,
  }).data?.members ?? [];
  const agents = useQuery({
    queryKey: queryKeys.agents(orgId),
    queryFn: () => getAgents(orgId),
    enabled: ready,
  }).data?.agents ?? [];

  const all = [
    ...agents
      .filter(a => !dmOnly || a.can_dm !== false)
      .map(a => ({
        kind: "agent" as const,
        id: a.agent_id,
        name: a.display_name ?? a.nickname ?? a.agent_id,
        avatarUrl: a.avatar?.url,
        hint: "agent",
      })),
    ...members
      .filter(m => m.human_id !== user?.id)
      .map(m => ({
        kind: "human" as const,
        id: String(m.human_id),
        name: m.display_name ?? m.email,
        avatarUrl: m.avatar?.url,
        hint: m.email,
      })),
  ].map(({ hint, ...e }) => ({ ...e, key: `${e.kind}:${e.id}`, search: `${e.name}\n${hint}`.toLowerCase() }));

  const q = needle.trim().toLowerCase();
  const matched = all.filter(e => e.search.includes(q));
  return {
    all,
    sections: [
      { label: "Agents", entries: matched.filter(e => e.kind === "agent") },
      { label: "People", entries: matched.filter(e => e.kind === "human") },
    ].filter(s => s.entries.length > 0),
  };
}
