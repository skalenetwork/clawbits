/**
 * AgentAutomationDetailPage — one automation, opened FROM an agent's
 * Automations tab (`/agents/:agentId/automations/:automationId`). Mounted
 * under {@link AgentShell}, so the user keeps the agent context (same
 * sidebar, agent breadcrumbs) instead of being teleported to the org-level
 * automations section.
 */
import { useOutletContext, useParams } from "react-router-dom";
import { PageHeader } from "@/components/PageHeader";
import { agentBreadcrumbs } from "@/components/agent/agentBreadcrumbs";
import type { AgentOutletContext } from "@/components/agent/AgentShell";
import { AutomationDetailView } from "./AutomationDetailPage";

export default function AgentAutomationDetailPage() {
  const { orgId, agentId, profile } = useOutletContext<AgentOutletContext>();
  const { automationId } = useParams<{ automationId: string }>();
  const base = `/agents/${encodeURIComponent(agentId ?? "")}/automations`;

  return (
    <AutomationDetailView
      orgId={orgId}
      automationId={automationId}
      backTo={base}
      renderHeader={(name) => {
        // The standard agent trail, with the Automations crumb made a link
        // and the automation's name appended as the current page.
        const crumbs = agentBreadcrumbs(agentId, profile, "automations");
        const last = crumbs[crumbs.length - 1];
        if (last) last.to = base;
        crumbs.push({ label: name ?? "Automation" });
        return <PageHeader breadcrumb={crumbs} />;
      }}
    />
  );
}
