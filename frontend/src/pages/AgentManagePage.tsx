import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { removeAgentFromOrg } from "@/lib/api";
import { agentDisplay } from "@/lib/agentDisplay";
import { queryKeys } from "@/lib/queryKeys";
import { errMsg, toast } from "@/lib/toast";
import { useAgentDmExport } from "@/hooks/useAgentDmExport";
import { useAgentTab } from "@/components/agent/agentTabContext";
import { DeleteAgentDialog } from "@/components/agent/DeleteAgentDialog";
import { AccessSection } from "@/components/agent/manage/AccessSection";
import { ModelSection } from "@/components/agent/manage/ModelSection";
import { BehaviorSection } from "@/components/agent/manage/BehaviorSection";
import { IdentitySection } from "@/components/agent/manage/IdentitySection";
import { MachineSection } from "@/components/agent/manage/MachineSection";
import { SettingsRow, SettingsSection } from "@/components/settings/Settings";
import { Button } from "@/components/ui/button";

export default function AgentManagePage() {
  const { orgId, agentId, profile } = useAgentTab();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const exportAction = useAgentDmExport(orgId, agentId);
  const name = agentDisplay(profile);

  const deleteMutation = useMutation({
    mutationFn: (keepContent: boolean) => removeAgentFromOrg(orgId, agentId, keepContent),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents(orgId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.mm.channelsAll });
      queryClient.removeQueries({ queryKey: queryKeys.agentProfile(orgId, agentId) });
      setDeleteOpen(false);
      toast.success("Agent deleted");
      void navigate("/agents", { replace: true });
    },
    onError: (err) => {
      toast.error(errMsg(err, "Couldn't delete agent"));
    },
  });

  return (
    <>
      <IdentitySection orgId={orgId} profile={profile} />
      {profile.is_operator && <ModelSection orgId={orgId} agentId={agentId} />}
      {profile.is_operator && <BehaviorSection orgId={orgId} profile={profile} />}
      {profile.reef_host && profile.reef_name ? (
        <MachineSection orgId={orgId} host={profile.reef_host} name={profile.reef_name} />
      ) : null}
      {profile.can_manage_contacts && (
        <AccessSection orgId={orgId} agentId={agentId} agentName={name} operator={profile.operator} />
      )}
      <SettingsSection label="Danger zone">
        <SettingsRow
          title="Delete agent"
          description={`Removes ${name} and its identity. Its messages can stay`}
          control={
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                setDeleteOpen(true);
              }}
            >
              Delete agent
            </Button>
          }
        />
      </SettingsSection>
      <DeleteAgentDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        agentName={name}
        isPending={deleteMutation.isPending}
        onConfirm={(keepContent) => {
          deleteMutation.mutate(keepContent);
        }}
        exportAction={exportAction}
      />
    </>
  );
}
