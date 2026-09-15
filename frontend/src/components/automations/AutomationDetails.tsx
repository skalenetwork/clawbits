import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { PlayIcon } from "@hugeicons/core-free-icons";
import { Icon } from "@/components/Icon";
import { AutomationWell } from "@/components/automations/AutomationWell";
import { DeleteAutomationDialog } from "@/components/automations/DeleteAutomationDialog";
import { PromptSection } from "@/components/automations/PromptSection";
import { RunHistory } from "@/components/automations/RunHistory";
import { useAutomationMutations } from "@/components/automations/useAutomationMutations";
import { SettingsStatus } from "@/components/settings/Settings";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { listAgentChannels, type AgentDeliveryChannel, type Automation } from "@/lib/api";
import { automationAccent, type AutomationVisualState } from "@/lib/automations";
import { formatRelativeAgo } from "@/lib/formatting";
import { queryKeys } from "@/lib/queryKeys";
import { describeSchedule, formatInstant, parseSchedule } from "@/lib/schedule";
import { cn } from "@/lib/utils";

interface Delivery {
  mode?: string;
  to?: string;
  channel?: string;
}

function deliveryLabel(
  delivery: Delivery | undefined,
  external: boolean,
  agentName: string,
  channels: AgentDeliveryChannel[] | undefined,
): string {
  if (delivery?.mode === "none") return "Nowhere, the output is discarded";
  if (delivery?.mode === "webhook") return "A webhook outside Clawbits";
  if (delivery?.channel != null && delivery.channel !== "clawbits") return `Another surface (${delivery.channel})`;
  if (!delivery?.to) return external ? "Managed outside Clawbits" : "Your DM";
  const channel = channels?.find((c) => c.channel_id === delivery.to);
  if (!channel) return channels ? `A channel ${agentName} has left` : "The configured channel";
  const name = channel.display_name ?? channel.name;
  return channel.channel_type === "direct" ? name : `#${name}`;
}

function Alert({ bad = false, children }: { bad?: boolean; children: ReactNode }) {
  return (
    <p
      className={cn(
        "rounded-[10px] px-3 py-2.5 text-[12.5px] leading-normal wrap-anywhere",
        bad ? "bg-destructive/9 text-destructive" : "bg-amber-500/10 text-amber-700 dark:text-amber-400",
      )}
    >
      {children}
    </p>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-3 border-foreground/8 py-2 text-[13px] not-first:border-t">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-right font-medium">{children}</dd>
    </div>
  );
}

export function AutomationDetails({
  orgId,
  agentName,
  automation: a,
  state,
  now,
  editable,
  onEdit,
  onRemoved,
}: {
  orgId: string;
  agentName: string;
  automation: Automation;
  state: AutomationVisualState;
  now: number;
  editable: boolean;
  onEdit: () => void;
  onRemoved: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const { runNow, toggleEnabled, remove } = useAutomationMutations(orgId, onRemoved);
  const channelsQuery = useQuery({
    queryKey: queryKeys.agentChannels(orgId, a.agent_id),
    queryFn: () => listAgentChannels(orgId, a.agent_id),
  });

  const spec = a.desired_spec ?? a.reported_spec;
  const schedule = parseSchedule(spec?.schedule);
  const prompt = (spec?.payload as { message?: string } | undefined)?.message;
  const external = state.key === "external";
  const manageable = !external && state.key !== "removing";
  const nextRunAtMs = a.reported_state?.nextRunAtMs;
  const nextRun =
    state.key !== "paused" && nextRunAtMs != null && nextRunAtMs > now ? formatInstant(nextRunAtMs) : null;
  const lastRun = formatRelativeAgo(a.reported_state?.lastRunAtMs);
  const failure =
    state.lastError != null || state.failing
      ? `${state.failStreak > 1 ? `The last ${String(state.failStreak)} runs failed` : "The last run failed"}${lastRun ? ` (${lastRun})` : ""}${state.lastError ? `: ${state.lastError}` : ""}`
      : null;

  return (
    <div className="flex flex-col gap-[18px] px-2.5 pb-4">
      <div className="flex items-center gap-3">
        <AutomationWell accent={automationAccent(a)} large />
        <div className="min-w-0 leading-snug">
          <h3 className="truncate text-base font-semibold tracking-tight">{a.name ?? "Untitled automation"}</h3>
          <p className="truncate text-[13px] text-muted-foreground">{describeSchedule(schedule)}</p>
        </div>
      </div>

      <div className="flex min-h-11 items-center justify-between gap-3 border-y border-foreground/8 py-2.5">
        <SettingsStatus tone={state.tone}>{state.label}</SettingsStatus>
        {manageable && editable && (
          <Switch
            aria-label="Run on schedule"
            checked={a.enabled !== false}
            onCheckedChange={(enabled) => {
              toggleEnabled.mutate({ a, enabled });
            }}
          />
        )}
      </div>

      {state.key === "failed" && <Alert bad>{state.detail ?? "The agent couldn't apply this automation."}</Alert>}
      {failure && <Alert bad>{failure}</Alert>}
      {state.drifted && !external && (
        <Alert>Changed outside Clawbits. The desired version re-applies on {agentName}'s next reconcile.</Alert>
      )}
      {state.key === "pending" && state.detail && <Alert>{state.detail}</Alert>}

      {prompt && <PromptSection prompt={prompt} />}

      <dl>
        {nextRun && <Fact label="Next run">{nextRun}</Fact>}
        <Fact label="Delivery">
          {deliveryLabel(spec?.delivery as Delivery | undefined, external, agentName, channelsQuery.data?.channels)}
        </Fact>
      </dl>

      <RunHistory orgId={orgId} automation={a} lastFailed={state.failStreak > 0} />

      {manageable && (
        <div className="flex flex-wrap gap-2">
          {editable && a.gateway_job_id != null && (
            <Button
              variant="outline"
              size="sm"
              disabled={a.run_pending || runNow.isPending}
              onClick={() => {
                runNow.mutate(a);
              }}
            >
              <Icon icon={PlayIcon} />
              {a.run_pending ? "Run queued…" : "Run now"}
            </Button>
          )}
          {editable && (
            <Button variant="outline" size="sm" onClick={onEdit}>
              Edit
            </Button>
          )}
          <Button
            variant="destructive"
            size="sm"
            onClick={() => {
              setConfirming(true);
            }}
          >
            Remove
          </Button>
        </div>
      )}

      <DeleteAutomationDialog
        automation={confirming ? a : null}
        isPending={remove.isPending}
        onOpenChange={(open) => {
          if (!open && !remove.isPending) setConfirming(false);
        }}
        onConfirm={() => {
          remove.mutate(a);
        }}
      />
    </div>
  );
}
