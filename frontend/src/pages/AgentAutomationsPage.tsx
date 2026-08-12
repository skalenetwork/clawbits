/**
 * AgentAutomationsPage — one agent's scheduled automations on its own route
 * (`/agents/:id/automations`), with breadcrumbs. Operator-managed; renders the
 * same {@link AutomationsManager} the org-wide page uses, scoped to this agent.
 * The profile is loaded by {@link AgentShell}. The manager renders the header
 * so its New-automation action docks at the header bar's right end.
 */
import { useOutletContext } from "react-router-dom";
import { PageHeader } from "@/components/PageHeader";
import { agentBreadcrumbs } from "@/components/agent/agentBreadcrumbs";
import type { AgentOutletContext } from "@/components/agent/AgentShell";
import { AutomationsManager } from "@/components/automations/AutomationsManager";
import { automationsUnsupportedReason } from "@/lib/automations";

export default function AgentAutomationsPage() {
  const { orgId, agentId, profile, isLoading } = useOutletContext<AgentOutletContext>();
  const breadcrumb = agentBreadcrumbs(agentId, profile, "automations");

  if (!profile?.is_operator) {
    return (
      <div className="space-y-6 pb-16">
        <PageHeader breadcrumb={breadcrumb} />
        <div className="py-12 text-center text-sm text-muted-foreground">
          {!profile
            ? isLoading
              ? "Loading…"
              : "Couldn't load this agent."
            : "Only this agent's operator can manage its automations."}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 pb-16">
      {/* Runtimes without a cron reconciler (ironclaw, or a pre-0.7.0 hermes plugin) can't apply
          Clawbits-managed automations. The manager gets the reason and runs in
          honest mode: no create affordances, existing stuck rows stay
          removable. */}
      <AutomationsManager
        orgId={orgId}
        scopeAgentId={profile.agent_id}
        unsupportedReason={automationsUnsupportedReason(profile.agent_type, profile.plugin_version)}
        renderPageHeader={(actions) => (
          <PageHeader breadcrumb={breadcrumb} actions={actions} />
        )}
      />
    </div>
  );
}
