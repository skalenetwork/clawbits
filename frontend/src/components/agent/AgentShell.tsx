/**
 * AgentShell — the layout route for `/agents/:agentId` and its subpages
 * (index Card / inbox / automations / manage). It sanitizes the `:agentId`
 * param and fetches the agent profile ONCE, then shares it with every subpage
 * through the router outlet context — so the four pages no longer each
 * re-sanitize the id, re-declare the identical profile query, and re-guard
 * loading/error. Because the shell stays mounted across section switches,
 * navigating Card → Inbox → Manage never remounts or refetches the profile.
 */
import { useEffect } from "react";
import { Outlet, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/context/AuthContext";
import { useAgentPresence } from "@/hooks/useAgentPresence";
import { getAgentProfile, type AgentProfile } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";

export interface AgentOutletContext {
  orgId: string;
  /** The sanitized agent id, or null when the route param is missing/invalid. */
  agentId: string | null;
  /** The loaded profile, or null while loading / on error / when disabled. */
  profile: AgentProfile | null;
  /** Profile-query flags, so each subpage can render its own bespoke loading
   *  and empty states (the card has a card-shaped skeleton; the others a line). */
  isLoading: boolean;
  isError: boolean;
}

/** The router can hand us the literal strings "undefined"/"null" when a link is
 *  built from a missing id — treat those as no selection. */
function normalizeAgentId(raw: string | undefined): string | null {
  return raw !== undefined && raw !== "undefined" && raw !== "null" ? raw : null;
}

export function AgentShell() {
  const { agentId } = useParams<{ agentId: string }>();
  const { activeOrgId } = useAuth();
  const validAgentId = normalizeAgentId(agentId);

  const profileQuery = useQuery({
    queryKey: queryKeys.agentProfile(activeOrgId ?? "", validAgentId ?? ""),
    queryFn: () => getAgentProfile(activeOrgId ?? "", validAgentId ?? ""),
    enabled: Boolean(activeOrgId && validAgentId),
  });

  // Seed the liveness provider from the profile snapshot so every agent
  // surface (card dot, sidebar) shares one source that SSE then keeps fresh.
  // Skipped when the field is absent — "no data" must not read as "setup".
  const { seed } = useAgentPresence();
  const loadedProfile = profileQuery.data;
  useEffect(() => {
    if (loadedProfile && loadedProfile.last_alive_at !== undefined) {
      seed([{ agentId: loadedProfile.agent_id, lastAliveAt: loadedProfile.last_alive_at }]);
    }
  }, [loadedProfile, seed]);

  const context: AgentOutletContext = {
    orgId: activeOrgId ?? "",
    agentId: validAgentId,
    profile: profileQuery.data ?? null,
    isLoading: profileQuery.isLoading,
    isError: profileQuery.isError,
  };
  return <Outlet context={context} />;
}
