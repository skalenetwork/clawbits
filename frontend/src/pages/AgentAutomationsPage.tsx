import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ArrowRight01Icon, PlusSignIcon } from "@hugeicons/core-free-icons";
import { Icon } from "@/components/Icon";
import { useAgentTab } from "@/components/agent/agentTabContext";
import { AutomationDetails } from "@/components/automations/AutomationDetails";
import { AutomationWell } from "@/components/automations/AutomationWell";
import { ForgeDialog } from "@/components/automations/ForgeDialog";
import { RecipePreview } from "@/components/automations/RecipePreview";
import { RecipeShelf } from "@/components/automations/RecipeShelf";
import { useAutomationMutations } from "@/components/automations/useAutomationMutations";
import { SettingsRow, SettingsRowSkeleton, SettingsSection, SettingsStatus } from "@/components/settings/Settings";
import { SidePanel } from "@/components/sidebars/SidePanel";
import { Switch } from "@/components/ui/switch";
import { useAgentStatus } from "@/hooks/useAgentPresence";
import { useNow } from "@/hooks/useNow";
import { agentDisplay } from "@/lib/agentDisplay";
import { listAgentAutomations, type Automation } from "@/lib/api";
import {
  AUTOMATION_TEMPLATES,
  BLANK_TEMPLATE,
  automationAccent,
  automationVisualState,
  automationsUnsupportedReason,
  humanizeSchedule,
  type AutomationTemplate,
  type AutomationVisualState,
} from "@/lib/automations";
import { automationsRefetchInterval } from "@/lib/automationsPolling";
import { formatRelativeAgo } from "@/lib/formatting";
import { queryKeys } from "@/lib/queryKeys";
import type { StatusTone } from "@/lib/status";
import { errMsg } from "@/lib/toast";

interface Row {
  automation: Automation;
  state: AutomationVisualState;
}

function attention({ state }: Row): { tone: StatusTone; label: string; reason: string } {
  if (state.key === "failed") {
    return { tone: "bad", label: "Sync failed", reason: state.detail ?? "The agent couldn't apply this automation" };
  }
  if (state.failing) {
    return {
      tone: "bad",
      label: "Failing",
      reason: `${String(state.failStreak)} runs in a row failed${state.lastError ? `: ${state.lastError}` : ""}`,
    };
  }
  return {
    tone: "warn",
    label: "Drifted",
    reason: "Changed outside Clawbits. The desired version re-applies on the next reconcile.",
  };
}

function cadence(a: Automation): string {
  const ran = formatRelativeAgo(a.reported_state?.lastRunAtMs);
  return `${humanizeSchedule(a.desired_spec ?? a.reported_spec)}${ran ? ` · ran ${ran}` : ""}`;
}

export default function AgentAutomationsPage() {
  const { orgId, agentId, profile } = useAgentTab();
  const { automationId } = useParams<{ automationId: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const now = useNow(30_000);
  const agentStatus = useAgentStatus(agentId, profile.last_alive_at ?? null);
  const { toggleEnabled } = useAutomationMutations(orgId);
  const [template, setTemplate] = useState<AutomationTemplate | null>(null);
  const [editing, setEditing] = useState<Automation | null>(null);
  const query = useQuery({
    queryKey: queryKeys.automationsForAgent(orgId, agentId),
    queryFn: () => listAgentAutomations(orgId, agentId),
    refetchInterval: automationsRefetchInterval,
  });

  const base = `/agents/${encodeURIComponent(agentId)}/automations`;
  const agentName = agentDisplay(profile);
  const unsupported = automationsUnsupportedReason(profile.agent_type, profile.plugin_version);
  const rows: Row[] = (query.data?.automations ?? []).map((automation) => ({
    automation,
    state: automationVisualState(automation, agentStatus, agentName, now),
  }));
  const selected = rows.find((r) => r.automation.automation_id === automationId);
  const recipeId = searchParams.get("recipe");
  const recipe = AUTOMATION_TEMPLATES.find((t) => t.id === recipeId);
  const flagged = rows.filter((r) => r.state.needsAttention);
  const scheduled = rows.filter((r) => !r.state.needsAttention && r.state.key !== "external");
  const external = rows.filter((r) => !r.state.needsAttention && r.state.key === "external");

  if ((automationId && query.data && !selected) || (recipeId && !recipe)) return <Navigate to={base} replace />;

  const close = () => {
    void navigate(base, { replace: true });
  };

  const row = ({ automation: a }: Row, description: string, status: ReactNode, action?: ReactNode) => (
    <SettingsRow
      key={a.automation_id}
      to={`${base}/${encodeURIComponent(a.automation_id)}`}
      replace
      selected={a.automation_id === automationId}
      leading={<AutomationWell accent={automationAccent(a)} />}
      title={a.name ?? "Untitled automation"}
      description={description}
      control={
        <>
          <span className="pointer-events-none flex items-center gap-2">{status}</span>
          {action}
        </>
      }
    />
  );

  return (
    <>
      {!query.data ? (
        <SettingsSection>
          {query.isError ? (
            <SettingsRow title="Couldn't load automations" error={errMsg(query.error, "Try again in a moment")} />
          ) : (
            [0, 1, 2].map((i) => <SettingsRowSkeleton key={i} />)
          )}
        </SettingsSection>
      ) : (
        <>
          {flagged.length > 0 && (
            <SettingsSection label="Needs attention">
              {flagged.map((r) => {
                const { tone, label, reason } = attention(r);
                return row(
                  r,
                  agentStatus === "available" ? reason : `${reason} · agent offline`,
                  <>
                    <SettingsStatus tone={tone}>{label}</SettingsStatus>
                    <Icon icon={ArrowRight01Icon} className="size-4 text-muted-foreground" />
                  </>,
                );
              })}
            </SettingsSection>
          )}

          {unsupported && (
            <SettingsSection>
              <SettingsRow
                title="Automations unavailable"
                description={
                  rows.length > 0 ? `${unsupported} Existing ones will never run and can only be removed.` : unsupported
                }
              />
            </SettingsSection>
          )}

          {(scheduled.length > 0 || !unsupported) && (
            <SettingsSection
              label="Scheduled"
              aside={
                unsupported ? undefined : (
                  <button
                    type="button"
                    onClick={() => {
                      setTemplate(BLANK_TEMPLATE);
                    }}
                    className="inline-flex items-center gap-1 rounded font-medium text-foreground outline-none hover:opacity-70 focus-visible:ring-2 focus-visible:ring-ring/50"
                  >
                    <Icon icon={PlusSignIcon} className="size-[13px]" />
                    New automation
                  </button>
                )
              }
            >
              {scheduled.length > 0 ? (
                scheduled.map((r) =>
                  row(
                    r,
                    cadence(r.automation),
                    <SettingsStatus tone={r.state.tone}>{r.state.label}</SettingsStatus>,
                    !unsupported && r.state.key !== "removing" && (
                      <Switch
                        aria-label={`Run ${r.automation.name ?? "automation"} on schedule`}
                        checked={r.automation.enabled !== false}
                        onCheckedChange={(enabled) => {
                          toggleEnabled.mutate({ a: r.automation, enabled });
                        }}
                      />
                    ),
                  ),
                )
              ) : (
                <SettingsRow title={rows.length > 0 ? "No other automations" : "Nothing scheduled yet"} />
              )}
            </SettingsSection>
          )}

          {external.length > 0 && (
            <SettingsSection label="Managed elsewhere">
              {external.map((r) =>
                row(r, cadence(r.automation), <SettingsStatus tone={r.state.tone}>{r.state.label}</SettingsStatus>),
              )}
            </SettingsSection>
          )}

          {!unsupported && (
            <RecipeShelf
              automations={query.data.automations}
              base={base}
              selectedId={recipe?.id ?? null}
              onPick={setTemplate}
            />
          )}
        </>
      )}

      <ForgeDialog
        orgId={orgId}
        template={template}
        editing={editing}
        agent={profile}
        onOpenChange={(open) => {
          if (open) return;
          setTemplate(null);
          setEditing(null);
        }}
      />

      <SidePanel open={selected != null || recipe != null} title={recipe ? "Suggestion" : "Automation"} onClose={close}>
        {selected ? (
          <AutomationDetails
            key={selected.automation.automation_id}
            orgId={orgId}
            agentName={agentName}
            automation={selected.automation}
            state={selected.state}
            now={now}
            editable={!unsupported}
            onEdit={() => {
              setEditing(selected.automation);
            }}
            onRemoved={close}
          />
        ) : (
          recipe && (
            <RecipePreview
              key={recipe.id}
              template={recipe}
              onAdd={() => {
                close();
                setTemplate(recipe);
              }}
            />
          )
        )}
      </SidePanel>
    </>
  );
}
