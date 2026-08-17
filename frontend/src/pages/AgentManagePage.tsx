/**
 * AgentManagePage — operator/owner management for an agent on its own route
 * (`/agents/:id/manage`), with breadcrumbs. One scrolling column of staggered
 * management sections — identity controls, behavior switches, the contact
 * allowlist, and the danger zone. Deliberately NOT an identity display (no
 * hero, no stats): the Card page owns showing the agent; this page only acts
 * on it. Gated to the operator or an org owner. The profile is loaded by
 * {@link AgentShell}.
 */
import { useState } from "react";
import { useNavigate, useOutletContext } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { removeAgentFromOrg } from "@/lib/api";
import { agentDisplay } from "@/lib/agentDisplay";
import { queryKeys } from "@/lib/queryKeys";
import { errMsg, toast } from "@/lib/toast";
import { useActiveOrg } from "@/hooks/useActiveOrg";
import { PageHeader } from "@/components/PageHeader";
import { RenameAgentDialog } from "@/components/RenameAgentDialog";
import { DeleteAgentDialog } from "@/components/agent/DeleteAgentDialog";
import { agentBreadcrumbs } from "@/components/agent/agentBreadcrumbs";
import type { AgentOutletContext } from "@/components/agent/AgentShell";
import { Stagger } from "@/components/agent/manage/Stagger";
import { IdentitySection } from "@/components/agent/manage/IdentitySection";
import { BehaviorSection } from "@/components/agent/manage/BehaviorSection";
import { AccessSection } from "@/components/agent/manage/AccessSection";
import { EnvSection } from "@/components/agent/manage/EnvSection";
import { DangerZone } from "@/components/agent/manage/DangerZone";

export default function AgentManagePage() {
  const { orgId, agentId, profile, isLoading } = useOutletContext<AgentOutletContext>();
  const { isOwner: isOrgOwner } = useActiveOrg();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [renameOpen, setRenameOpen] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  const deleteMutation = useMutation({
    mutationFn: (keepContent: boolean) =>
      removeAgentFromOrg(orgId, profile?.agent_id ?? "", keepContent),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents(orgId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.mm.channelsAll });
      setShowDeleteDialog(false);
      toast.success("Agent deleted");
      void navigate("/agents");
    },
    onError: (err: unknown) => {
      toast.error(errMsg(err, "Couldn't delete agent"));
    },
  });

  const canManage = Boolean(profile?.is_operator) || isOrgOwner;
  const name = profile ? agentDisplay(profile) : "";

  return (
    <div className="pb-16">
      <PageHeader breadcrumb={agentBreadcrumbs(agentId, profile, "manage")} />
      {!profile ? (
        <div className="py-12 text-center text-sm text-muted-foreground">
          {isLoading ? "Loading…" : "Couldn't load this agent."}
        </div>
      ) : !canManage ? (
        <div className="py-12 text-center text-sm text-muted-foreground">
          You don&apos;t have permission to manage this agent.
        </div>
      ) : (
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

          {profile.reef_sandbox_id && (
            <Stagger delay={160}>
              <EnvSection orgId={orgId} sandboxId={profile.reef_sandbox_id} />
            </Stagger>
          )}

          {profile.can_manage_contacts && (
            <Stagger delay={240}>
              <AccessSection
                orgId={orgId}
                agentId={profile.agent_id}
                operator={profile.operator ?? null}
              />
            </Stagger>
          )}

          <Stagger delay={320}>
            <DangerZone
              agentName={name}
              isPending={deleteMutation.isPending}
              onDelete={() => {
                setShowDeleteDialog(true);
              }}
            />
          </Stagger>
        </div>
      )}

      {profile && (
        <>
          <RenameAgentDialog
            agent={renameOpen ? { agent_id: profile.agent_id, nickname: profile.nickname } : null}
            onOpenChange={setRenameOpen}
          />
          <DeleteAgentDialog
            open={showDeleteDialog}
            onOpenChange={setShowDeleteDialog}
            agentName={name}
            isPending={deleteMutation.isPending}
            onConfirm={(keepContent) => {
              deleteMutation.mutate(keepContent);
            }}
          />
        </>
      )}
    </div>
  );
}
