/**
 * IdentitySection — the controls that act on the agent's identity: rename,
 * manual description edit, and description regeneration. Deliberately NOT an
 * identity display (no avatar, presence, or contact details — the Card page
 * owns those); the name and description appear here only as the objects of
 * their controls.
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  PencilEdit02Icon,
  RefreshIcon,
  Robot02Icon,
  SparklesIcon,
} from "@hugeicons/core-free-icons";
import { setAgentDescription, type AgentProfile } from "@/lib/api";
import { generateAgentDescription } from "@/lib/agentDescription";
import { agentDisplay } from "@/lib/agentDisplay";
import { formatRelativeAgo } from "@/lib/formatting";
import { queryKeys } from "@/lib/queryKeys";
import { errMsg, toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SectionHeader } from "@/components/automations/SectionHeader";
import { ManageTile } from "./ManageTile";

const DESCRIPTION_MAX = 280;

/** Honest provenance for the description — only agent-generated text gets a
 *  label (with its age); manual, placeholder ("default"), and unknown sources
 *  render nothing. */
function provenance(profile: AgentProfile): string | null {
  switch (profile.description_source) {
    case "auto": {
      const when = profile.description_generated_at
        ? formatRelativeAgo(profile.description_generated_at)
        : "";
      return when ? `Auto-generated ${when}` : "Auto-generated";
    }
    default:
      return null;
  }
}

/** The edit form, keyed per open so an abandoned draft doesn't survive a
 *  reopen (the RenameAgentDialog pattern). */
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
    mutationFn: (description: string) =>
      setAgentDescription(orgId, agentId, description),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.agentProfile(orgId, agentId),
      });
      // The description also rides on the org agent list payloads (cards).
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents(orgId) });
      toast.success("Description updated");
      onClose();
    },
    onError: (err: unknown) => {
      toast.error(errMsg(err, "Couldn't update the description"));
    },
  });

  const trimmed = text.trim();
  const canSave =
    trimmed.length > 0 && trimmed !== initial.trim() && !mutation.isPending;

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          <Icon icon={PencilEdit02Icon} className="text-muted-foreground" />
          Edit description
        </DialogTitle>
        <DialogDescription>
          Shown on the agent&apos;s card. Stays until you regenerate or the
          agent rewrites it.
        </DialogDescription>
      </DialogHeader>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (canSave) mutation.mutate(trimmed);
        }}
      >
        <textarea
          autoFocus
          value={text}
          maxLength={DESCRIPTION_MAX}
          rows={4}
          onChange={(e) => {
            setText(e.target.value);
          }}
          aria-label="Agent description"
          placeholder="What is this agent for?"
          className={cn(
            "min-h-24 w-full min-w-0 resize-y rounded-xl bg-muted/40 p-3",
            "text-sm leading-relaxed text-foreground outline-none",
            "transition-shadow placeholder:text-muted-foreground/50",
            "focus-visible:ring-2 focus-visible:ring-ring/30",
          )}
        />
        <div className="mt-1 text-right text-label tabular-nums text-muted-foreground/60">
          {text.length}/{DESCRIPTION_MAX}
        </div>
        <DialogFooter className="mt-3">
          <Button
            type="button"
            variant="ghost"
            onClick={onClose}
            disabled={mutation.isPending}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={!canSave}>
            {mutation.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
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
  // Keys a fresh form per open so an abandoned draft doesn't stick around.
  const [editEpoch, setEditEpoch] = useState(0);

  const regenMutation = useMutation({
    mutationFn: () => generateAgentDescription(orgId, agentId),
    onSuccess: () => {
      toast.success("Asked the agent to refresh its description");
      void queryClient.invalidateQueries({
        queryKey: queryKeys.agentProfile(orgId, agentId),
      });
    },
    onError: (err: unknown) => {
      toast.error(errMsg(err, "Couldn't request a refresh"));
    },
  });

  const regenPending = Boolean(profile.description_regen_pending);
  const hasDescription = Boolean(profile.description);
  const sourceLabel = provenance(profile);

  return (
    <section className="space-y-3">
      <SectionHeader icon={Robot02Icon}>Identity</SectionHeader>
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
              {sourceLabel && (
                <div className="text-label font-medium uppercase tracking-wide text-muted-foreground/80">
                  {sourceLabel}
                </div>
              )}
              {hasDescription ? (
                <p className="line-clamp-2 leading-relaxed">
                  {profile.description}
                </p>
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
              {/* Stays clickable while a refresh is pending: the request only
                  re-stamps the server-side flag, and an agent that missed the
                  first ask (offline, crashed mid-generation) would otherwise
                  leave the operator stuck on a forever-disabled button. */}
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
                  className={cn(
                    "size-3.5",
                    (regenMutation.isPending || regenPending) && "animate-spin",
                  )}
                />
                {regenPending ? "Refreshing…" : hasDescription ? "Regenerate" : "Generate"}
              </Button>
            </div>
          }
        />
      </div>

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="sm:max-w-md">
          <EditDescriptionForm
            key={editEpoch}
            orgId={orgId}
            agentId={agentId}
            initial={profile.description ?? ""}
            onClose={() => {
              setEditOpen(false);
            }}
          />
        </DialogContent>
      </Dialog>
    </section>
  );
}
