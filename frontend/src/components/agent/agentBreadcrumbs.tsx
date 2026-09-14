import { Bot } from "lucide-react";
import type { Crumb } from "@/components/Breadcrumbs";
import { AgentFaceAvatar } from "@/components/AgentFaceAvatar";
import { agentDisplay } from "@/lib/agentDisplay";
import type { AgentProfile } from "@/lib/api";

export function agentBreadcrumbs(agentId: string | null, profile: AgentProfile | null): Crumb[] {
  const name = profile ? agentDisplay(profile) : (agentId ?? "Agent");
  return [
    { label: "Agents", to: "/agents", icon: Bot },
    {
      label: name,
      leading: <AgentFaceAvatar size={18} name={name} src={profile?.avatar?.url} className="rounded-full" />,
    },
  ];
}
