/**
 * BehaviorSection — the operator-only runtime switches, instant-apply (no
 * save buttons). The PATCH response is merged straight into the profile cache
 * so the tiles (and their tinted wells) settle to the server's truth
 * immediately; the in-flight disable is scoped to the touched control so the
 * other tiles stay live. LobsterTalk rides the same grid as a toggle.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  BubbleChatIcon,
  InformationCircleIcon,
  Megaphone01Icon,
  Moon02Icon,
  RepeatIcon,
  Settings02Icon,
} from "@hugeicons/core-free-icons";
import { updateAgentSettings, type AgentProfile } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import { errMsg, toast } from "@/lib/toast";
import { SectionHeader } from "@/components/automations/SectionHeader";
import { Icon } from "@/components/Icon";
import { Stepper } from "@/components/ui/stepper";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ManageTile } from "./ManageTile";

const LIMIT_MIN = 1;
const LIMIT_MAX = 50;

type SettingsPatch = Parameters<typeof updateAgentSettings>[2];

export function BehaviorSection({
  orgId,
  profile,
}: {
  orgId: string;
  profile: AgentProfile;
}) {
  const queryClient = useQueryClient();
  const agentId = profile.agent_id;

  const settingsMutation = useMutation({
    mutationFn: (settings: SettingsPatch) =>
      updateAgentSettings(orgId, agentId, settings),
    onSuccess: (data) => {
      // The PATCH echoes the authoritative settings — merge them in rather
      // than waiting a refetch round-trip, then revalidate in the background.
      queryClient.setQueryData<AgentProfile>(
        queryKeys.agentProfile(orgId, agentId),
        (old) => (old ? { ...old, ...data } : old),
      );
      void queryClient.invalidateQueries({
        queryKey: queryKeys.agentProfile(orgId, agentId),
      });
      // Snooze / inter-agent flags also ride on the org agent list payloads.
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents(orgId) });
    },
    onError: (err: unknown) => {
      toast.error(errMsg(err, "Couldn't update settings"));
    },
  });

  // Scope "disabled while in flight" to the control that fired the PATCH.
  const pendingField = settingsMutation.isPending
    ? (Object.keys(settingsMutation.variables)[0] ?? null)
    : null;

  const snoozed = Boolean(profile.snoozed);
  const interAgent = Boolean(profile.inter_agent_mode_enabled);
  const limit = profile.inter_agent_message_limit ?? 10;

  const lobstertalk = Boolean(profile.lobstertalk_enabled);

  return (
    <section className="space-y-3">
      <SectionHeader icon={Settings02Icon}>Behavior</SectionHeader>
      <div className="grid gap-3 sm:grid-cols-2">
        {profile.snoozed !== undefined && (
          <ManageTile
            icon={Moon02Icon}
            wellClassName={
              snoozed
                ? "bg-amber-400/20 text-amber-600 dark:bg-amber-400/15 dark:text-amber-300"
                : undefined
            }
            title="Snooze"
            caption={
              <span className="block truncate">
                {snoozed
                  ? "Ignoring requests until switched off"
                  : "Pause requests without disconnecting"}
              </span>
            }
            control={
              <Switch
                checked={snoozed}
                disabled={pendingField === "snoozed"}
                onCheckedChange={(next) => {
                  settingsMutation.mutate({ snoozed: next });
                }}
              />
            }
          />
        )}

        {profile.inter_agent_mode_enabled !== undefined && (
          <ManageTile
            icon={BubbleChatIcon}
            wellClassName={
              interAgent
                ? "bg-blue-500/15 text-blue-600 dark:bg-blue-500/15 dark:text-blue-300"
                : undefined
            }
            title="Inter-agent mode"
            caption={
              <span className="block truncate">
                Can process other agents&apos; messages
              </span>
            }
            control={
              <Switch
                checked={interAgent}
                disabled={pendingField === "inter_agent_mode_enabled"}
                onCheckedChange={(next) => {
                  settingsMutation.mutate({ inter_agent_mode_enabled: next });
                }}
              />
            }
          />
        )}

        {profile.inter_agent_message_limit !== undefined && (
          <ManageTile
            icon={RepeatIcon}
            title="Agent-to-agent limit"
            caption={
              <span className="block truncate">Max consecutive replies</span>
            }
            control={
              <Stepper
                aria-label="Agent-to-agent limit"
                value={limit}
                min={LIMIT_MIN}
                max={LIMIT_MAX}
                disabled={pendingField === "inter_agent_message_limit"}
                onChange={(next) => {
                  settingsMutation.mutate({ inter_agent_message_limit: next });
                }}
              />
            }
          />
        )}

        {profile.lobstertalk_enabled !== undefined && (
          <ManageTile
            icon={Megaphone01Icon}
            title="LobsterTalk"
            titleAdornment={
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span
                      className="inline-flex text-muted-foreground/60 transition-colors hover:text-muted-foreground focus-visible:text-muted-foreground focus-visible:outline-none"
                      tabIndex={0}
                      aria-label="What is LobsterTalk?"
                    >
                      <Icon icon={InformationCircleIcon} className="size-3.5" />
                    </span>
                  }
                />
                <TooltipContent>
                  Semantic attention gate - scores messages for relevance
                </TooltipContent>
              </Tooltip>
            }
            caption={
              <span className="block truncate">
                Surface channel messages that need the agent
              </span>
            }
            control={
              <Switch
                checked={lobstertalk}
                disabled={pendingField === "lobstertalk_enabled"}
                onCheckedChange={(next) => {
                  settingsMutation.mutate({ lobstertalk_enabled: next });
                }}
              />
            }
          />
        )}
      </div>

    </section>
  );
}
