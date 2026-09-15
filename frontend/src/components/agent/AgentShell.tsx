import { useEffect } from "react";
import { Outlet, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/context/AuthContext";
import { updateAgentPresence } from "@/hooks/useAgentPresence";
import { getAgentProfile, type AgentProfile } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";

export interface AgentOutletContext {
  orgId: string;
  agentId: string | null;
  profile: AgentProfile | null;
  isLoading: boolean;
  isError: boolean;
}

export function AgentShell() {
  const params = useParams<{ agentId: string }>();
  const { activeOrgId } = useAuth();
  const orgId = activeOrgId ?? "";
  const agentId =
    params.agentId === "undefined" || params.agentId === "null" ? null : (params.agentId ?? null);

  const { data: profile = null, isLoading, isError } = useQuery({
    queryKey: queryKeys.agentProfile(orgId, agentId ?? ""),
    queryFn: () => getAgentProfile(orgId, agentId ?? ""),
    enabled: Boolean(activeOrgId && agentId),
  });

  useEffect(() => {
    if (profile?.last_alive_at !== undefined) {
      updateAgentPresence([{ agentId: profile.agent_id, lastAliveAt: profile.last_alive_at }]);
    }
  }, [profile]);

  return <Outlet context={{ orgId, agentId, profile, isLoading, isError } satisfies AgentOutletContext} />;
}
