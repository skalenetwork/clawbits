import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { PencilEdit02Icon, RefreshIcon, SparklesIcon } from "@hugeicons/core-free-icons";
import { Bot } from "lucide-react";
import { setAgentDescription, type AgentProfile } from "@/lib/api";
import { generateAgentDescription } from "@/lib/agentDescription";
import { agentDisplay } from "@/lib/agentDisplay";
import { formatRelativeAgo } from "@/lib/formatting";
import { queryKeys } from "@/lib/queryKeys";
import { errMsg, toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/button";
import { DialogDescription } from "@/components/ui/dialog";
import { ModalButton, ModalField, ModalFooter, ModalHeader, ModalPanel } from "@/components/modals/Modal";
import { SectionHeader } from "@/components/automations/SectionHeader";
import { ManageTile } from "./ManageTile";

const DESCRIPTION_MAX = 280;

function EditDescriptionForm({
  orgId,
  agentId,
  initial,
  onClose,
}: {
  orgId: string;
  agentId: string;
  initial: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [text, setText] = useState(initial);

  const mutation = useMutation({
    mutationFn: (description: string) => setAgentDescription(orgId, agentId, description),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.agentProfile(orgId, agentId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents(orgId) });
      toast.success("Description updated");
      onClose();
    },
    onError: (err) => {
      toast.error(errMsg(err, "Couldn't update the description"));
    },
  });

  const trimmed = text.trim();
  const canSave = trimmed.length > 0 && trimmed !== initial.trim() && !mutation.isPending;

  return (
    <>
      <ModalHeader title="Edit description" />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (canSave) mutation.mutate(trimmed);
        }}
      >
        <div className="p-4">
          <ModalField label="Description" htmlFor="agent-description">
            <textarea
              id="agent-description"
              autoFocus
              value={text}
              maxLength={DESCRIPTION_MAX}
              rows={4}
              onChange={(e) => {
                setText(e.target.value);
              }}
              placeholder="What is this agent for?"
              className={cn(
                "min-h-24 w-full min-w-0 resize-y rounded-xl bg-muted/40 p-3",
                "text-sm leading-relaxed text-foreground outline-none",
                "transition-shadow placeholder:text-muted-foreground/50",
                "focus-visible:ring-2 focus-visible:ring-ring/30",
              )}
            />
            <div className="flex items-baseline justify-between gap-3 text-[12px] text-muted-foreground">
              <DialogDescription className="text-[12px] text-muted-foreground">
                Shown on the agent&apos;s card. Stays until you regenerate or the agent rewrites it.
              </DialogDescription>
              <span className="shrink-0 tabular-nums">
                {text.length}/{DESCRIPTION_MAX}
              </span>
            </div>
          </ModalField>
        </div>
        <ModalFooter>
          <ModalButton onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </ModalButton>
          <ModalButton type="submit" tone="primary" disabled={!canSave}>
            {mutation.isPending ? "Saving…" : "Save"}
          </ModalButton>
        </ModalFooter>
      </form>
    </>
  );
}

export function IdentitySection({
  orgId,
  profile,
  onRename,
}: {
  orgId: string;
  profile: AgentProfile;
  onRename: () => void;
}) {
  const queryClient = useQueryClient();
  const agentId = profile.agent_id;
  const [editOpen, setEditOpen] = useState(false);
  const [editEpoch, setEditEpoch] = useState(0);

  const regenMutation = useMutation({
    mutationFn: () => generateAgentDescription(orgId, agentId),
    onSuccess: () => {
      toast.success("Asked the agent to refresh its description");
      void queryClient.invalidateQueries({ queryKey: queryKeys.agentProfile(orgId, agentId) });
    },
    onError: (err) => {
      toast.error(errMsg(err, "Couldn't request a refresh"));
    },
  });

  const regenPending = Boolean(profile.description_regen_pending);
  const hasDescription = Boolean(profile.description);
  const generated =
    profile.description_source === "auto" ? formatRelativeAgo(profile.description_generated_at) : null;

  return (
    <section className="space-y-3">
      <SectionHeader icon={Bot}>Identity</SectionHeader>
      <div className="space-y-3">
        {profile.is_operator && (
          <ManageTile
            icon={PencilEdit02Icon}
            title="Name"
            caption={
              <span className="block truncate">
                {agentDisplay(profile)} · @{agentId}
              </span>
            }
            control={
              <Button variant="outline" size="sm" onClick={onRename}>
                <Icon icon={PencilEdit02Icon} className="size-3.5" />
                Rename
              </Button>
            }
          />
        )}

        <ManageTile
          icon={SparklesIcon}
          title="Description"
          align="start"
          caption={
            <div className="mt-0.5 space-y-1">
              {generated != null && (
                <div className="text-label font-medium text-muted-foreground/80">
                  {generated ? `Auto-generated ${generated}` : "Auto-generated"}
                </div>
              )}
              {hasDescription ? (
                <p className="line-clamp-2 leading-relaxed">{profile.description}</p>
              ) : (
                <p>No description yet</p>
              )}
            </div>
          }
          control={
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setEditEpoch((e) => e + 1);
                  setEditOpen(true);
                }}
                title="Write the description yourself"
              >
                <Icon icon={PencilEdit02Icon} className="size-3.5" />
                Edit
              </Button>
              {/* Never disabled while pending: an agent that missed the first ask would strand the operator. */}
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  regenMutation.mutate();
                }}
                disabled={regenMutation.isPending}
                title={
                  regenPending
                    ? "Refresh already requested - click to ask again"
                    : "Ask the agent to rewrite its description from recent activity"
                }
              >
                <Icon
                  icon={RefreshIcon}
                  className={cn("size-3.5", (regenMutation.isPending || regenPending) && "animate-spin")}
                />
                {regenPending ? "Refreshing…" : hasDescription ? "Regenerate" : "Generate"}
              </Button>
            </div>
          }
        />
      </div>

      <ModalPanel open={editOpen} onOpenChange={setEditOpen} kind="form">
        <EditDescriptionForm
          key={editEpoch}
          orgId={orgId}
          agentId={agentId}
          initial={profile.description ?? ""}
          onClose={() => {
            setEditOpen(false);
          }}
        />
      </ModalPanel>
    </section>
  );
}
