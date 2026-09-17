import { useQuery } from "@tanstack/react-query";
import { getAgentModels } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";

export function useAgentModels(orgId: string, agentId: string) {
  return useQuery({
    queryKey: queryKeys.agentModels(orgId, agentId),
    queryFn: () => getAgentModels(orgId, agentId),
    staleTime: 10 * 60_000,
  });
}
