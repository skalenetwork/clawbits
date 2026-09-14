import { useOutletContext } from "react-router-dom";
import type { AgentProfile } from "@/lib/api";

export interface AgentTabContext {
  orgId: string;
  agentId: string;
  profile: AgentProfile;
}

export const useAgentTab = () => useOutletContext<AgentTabContext>();
