import { useState } from "react";
import { useNavigate, useOutletContext } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { removeAgentFromOrg } from "@/lib/api";
import { agentDisplay } from "@/lib/agentDisplay";
import { queryKeys } from "@/lib/queryKeys";
import { errMsg, toast } from "@/lib/toast";
import { useActiveOrg } from "@/hooks/useActiveOrg";
import { useAgentDmExport } from "@/hooks/useAgentDmExport";
import { PageHeader } from "@/components/PageHeader";
import { RenameAgentDialog } from "@/components/RenameAgentDialog";
import { DeleteAgentDialog } from "@/components/agent/DeleteAgentDialog";
import { agentBreadcrumbs } from "@/components/agent/agentBreadcrumbs";
import type { AgentOutletContext } from "@/components/agent/AgentShell";
import { Stagger } from "@/components/agent/manage/Stagger";
import { IdentitySection } from "@/components/agent/manage/IdentitySection";
import { BehaviorSection } from "@/components/agent/manage/BehaviorSection";
import { MachineSection } from "@/components/agent/manage/MachineSection";
import { AccessSection } from "@/components/agent/manage/AccessSection";
import { DangerZone } from "@/components/agent/manage/DangerZone";

export default function AgentManagePage() {
  const { orgId, agentId, profile, isLoading } = useOutletContext<AgentOutletContext>();
  const { isOwner } = useActiveOrg();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const deleteMutation = useMutation({
    mutationFn: (keepContent: boolean) => removeAgentFromOrg(orgId, profile?.agent_id ?? "", keepContent),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents(orgId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.mm.channelsAll });
      setDeleteOpen(false);
      toast.success("Agent deleted");
      void navigate("/agents");
    },
    onError: (err) => {
      toast.error(errMsg(err, "Couldn't delete agent"));
    },
  });

  const exportAction = useAgentDmExport(orgId, profile?.agent_id);

  return (
    <div className="pb-16">
      <PageHeader breadcrumb={agentBreadcrumbs(agentId, profile, "manage")} />
      {!profile || !(profile.is_operator || isOwner) ? (
        <div className="py-12 text-center text-sm text-muted-foreground">
          {profile
            ? "You don't have permission to manage this agent."
            : isLoading
              ? "Loading…"
              : "Couldn't load this agent."}
        </div>
      ) : (
        <>
          <div className="mx-auto w-full max-w-3xl space-y-8">
            <Stagger delay={0}>
              <IdentitySection
                orgId={orgId}
                profile={profile}
                onRename={() => {
                  setRenameOpen(true);
                }}
              />
            </Stagger>

            {profile.is_operator && (
              <Stagger delay={80}>
                <BehaviorSection orgId={orgId} profile={profile} />
              </Stagger>
            )}

            {profile.reef_host && (
              <Stagger delay={160}>
                <MachineSection orgId={orgId} profile={profile} />
              </Stagger>
            )}

            {profile.can_manage_contacts && (
              <Stagger delay={240}>
                <AccessSection orgId={orgId} agentId={profile.agent_id} operator={profile.operator ?? null} />
              </Stagger>
            )}

            <Stagger delay={320}>
              <DangerZone
                agentName={agentDisplay(profile)}
                isPending={deleteMutation.isPending}
                onDelete={() => {
                  setDeleteOpen(true);
                }}
              />
            </Stagger>
          </div>

          <RenameAgentDialog
            agent={renameOpen ? { agent_id: profile.agent_id, nickname: profile.nickname } : null}
            onOpenChange={setRenameOpen}
          />
          <DeleteAgentDialog
            open={deleteOpen}
            onOpenChange={setDeleteOpen}
            agentName={agentDisplay(profile)}
            isPending={deleteMutation.isPending}
            onConfirm={(keepContent) => {
              deleteMutation.mutate(keepContent);
            }}
            exportAction={exportAction}
          />
        </>
      )}
    </div>
  );
}
