import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { updateAgentSettings, type AgentProfile } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import { errMsg, toast } from "@/lib/toast";
import { agentModelsQuery, ModelPicker } from "@/components/composer/ModelPicker";
import { SettingsRow, SettingsSection } from "@/components/settings/Settings";
import { Stepper } from "@/components/ui/stepper";
import { Switch } from "@/components/ui/switch";

type SettingsPatch = Parameters<typeof updateAgentSettings>[2];

export function BehaviorSection({ orgId, profile }: { orgId: string; profile: AgentProfile }) {
  const queryClient = useQueryClient();
  const agentId = profile.agent_id;
  const profileKey = queryKeys.agentProfile(orgId, agentId);
  const [modelOpen, setModelOpen] = useState(false);

  const models = useQuery(agentModelsQuery(orgId, agentId)).data;

  const mutation = useMutation({
    mutationFn: (patch: SettingsPatch) => updateAgentSettings(orgId, agentId, patch),
    onSuccess: (data) => {
      queryClient.setQueryData<AgentProfile>(profileKey, (old) => (old ? { ...old, ...data } : old));
      void queryClient.invalidateQueries({ queryKey: profileKey });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents(orgId) });
    },
    onError: (err) => {
      toast.error(errMsg(err, "Couldn't update settings"));
    },
  });

  const pending = mutation.isPending ? Object.keys(mutation.variables)[0] : undefined;
  const snoozed = Boolean(profile.snoozed);

  return (
    <SettingsSection label="Behavior">
      {models?.models && (
        <SettingsRow
          title="Model"
          description="Used when a conversation has no choice of its own"
          control={
            <ModelPicker
              orgId={orgId}
              agentId={agentId}
              channelId={null}
              value={models.default}
              variant="select"
              align="end"
              open={modelOpen}
              onOpenChange={setModelOpen}
            />
          }
        />
      )}
      <SettingsRow
        title="Snooze"
        description={snoozed ? "Ignoring requests until switched off" : "Pause requests without disconnecting"}
        htmlFor="agent-snoozed"
        control={
          <Switch
            id="agent-snoozed"
            checked={snoozed}
            disabled={pending === "snoozed"}
            onCheckedChange={(next) => {
              mutation.mutate({ snoozed: next });
            }}
          />
        }
      />
      <SettingsRow
        title="Inter-agent mode"
        description="Can process other agents' messages"
        htmlFor="agent-inter-agent-mode"
        control={
          <Switch
            id="agent-inter-agent-mode"
            checked={Boolean(profile.inter_agent_mode_enabled)}
            disabled={pending === "inter_agent_mode_enabled"}
            onCheckedChange={(next) => {
              mutation.mutate({ inter_agent_mode_enabled: next });
            }}
          />
        }
      />
      <SettingsRow
        title="Agent-to-agent limit"
        description="Max consecutive replies"
        control={
          <Stepper
            aria-label="Agent-to-agent limit"
            value={profile.inter_agent_message_limit ?? 10}
            min={1}
            max={50}
            disabled={pending === "inter_agent_message_limit"}
            onChange={(next) => {
              mutation.mutate({ inter_agent_message_limit: next });
            }}
          />
        }
      />
      <SettingsRow
        title="LobsterTalk"
        description="Surface channel messages that need the agent"
        htmlFor="agent-lobstertalk"
        control={
          <Switch
            id="agent-lobstertalk"
            checked={Boolean(profile.lobstertalk_enabled)}
            disabled={pending === "lobstertalk_enabled"}
            onCheckedChange={(next) => {
              mutation.mutate({ lobstertalk_enabled: next });
            }}
          />
        }
      />
    </SettingsSection>
  );
}
