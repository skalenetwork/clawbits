import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { RefreshIcon } from "@hugeicons/core-free-icons";
import { renameAgent, setAgentDescription, type AgentProfile } from "@/lib/api";
import { generateAgentDescription } from "@/lib/agentDescription";
import { agentDisplay } from "@/lib/agentDisplay";
import { formatRelativeAgo } from "@/lib/formatting";
import { queryKeys } from "@/lib/queryKeys";
import { errMsg, toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { Icon } from "@/components/Icon";
import { ModalButton, ModalField, ModalFooter, ModalHeader, ModalPanel } from "@/components/modals/Modal";
import { SettingsRow, SettingsSection } from "@/components/settings/Settings";
import { Button } from "@/components/ui/button";
import { DialogDescription } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

const NAME_MAX = 32;
const DESCRIPTION_MAX = 280;

type FormKind = "rename" | "description";

interface FormProps {
  orgId: string;
  agentId: string;
  initial: string;
  onClose: () => void;
}

function RenameForm({ orgId, agentId, initial, onClose }: FormProps) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(initial);

  const mutation = useMutation({
    mutationFn: (nickname: string) => renameAgent(orgId, agentId, nickname),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents(orgId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agentProfile(orgId, agentId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.mm.channelsAll });
      toast.success(`Renamed to ${data.nickname}`);
      onClose();
    },
    onError: (err) => {
      toast.error(errMsg(err, "Couldn't rename agent"));
    },
  });

  const trimmed = name.trim();
  const canSave = trimmed.length > 0 && trimmed !== initial && !mutation.isPending;

  return (
    <>
      <ModalHeader title="Rename agent" />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (canSave) mutation.mutate(trimmed);
        }}
      >
        <div className="p-4">
          <ModalField label="Name" htmlFor="rename-agent-name">
            <Input
              id="rename-agent-name"
              autoFocus
              value={name}
              maxLength={NAME_MAX}
              onChange={(e) => {
                setName(e.target.value);
              }}
              placeholder="Agent name"
            />
            <DialogDescription className="text-[12px] text-muted-foreground">
              Shown everywhere instead of the generated name. The handle @{agentId} stays the same.
            </DialogDescription>
          </ModalField>
        </div>
        <ModalFooter>
          <ModalButton onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </ModalButton>
          <ModalButton type="submit" tone="primary" disabled={!canSave}>
            {mutation.isPending ? "Renaming…" : "Rename"}
          </ModalButton>
        </ModalFooter>
      </form>
    </>
  );
}

function DescriptionForm({ orgId, agentId, initial, onClose }: FormProps) {
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
              className="min-h-24 w-full min-w-0 resize-y rounded-xl bg-muted/40 p-3 text-sm leading-relaxed text-foreground outline-none transition-shadow placeholder:text-muted-foreground/50 focus-visible:ring-2 focus-visible:ring-ring/30"
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

export function IdentitySection({ orgId, profile }: { orgId: string; profile: AgentProfile }) {
  const queryClient = useQueryClient();
  const agentId = profile.agent_id;
  const name = agentDisplay(profile);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<{ kind: FormKind; epoch: number }>({ kind: "description", epoch: 0 });

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

  const openForm = (kind: FormKind) => {
    setForm(({ epoch }) => ({ kind, epoch: epoch + 1 }));
    setOpen(true);
  };
  const formProps = {
    orgId,
    agentId,
    onClose: () => {
      setOpen(false);
    },
  };

  const regenPending = Boolean(profile.description_regen_pending);
  const description = [
    profile.description || "No description yet",
    profile.description_source === "auto" &&
      ["Auto-generated", formatRelativeAgo(profile.description_generated_at)].filter(Boolean).join(" "),
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <>
      <SettingsSection
        label="Identity"
        footer={
          profile.is_operator
            ? undefined
            : `Only ${profile.operator?.display_name ?? "the operator"} can rename ${name} or change how it behaves.`
        }
      >
        {profile.is_operator && (
          <SettingsRow
            title="Name"
            description={`${name} · @${agentId}`}
            control={
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  openForm("rename");
                }}
              >
                Rename
              </Button>
            }
          />
        )}
        <SettingsRow
          title="Description"
          description={description}
          control={
            <>
              <Button
                variant="outline"
                size="sm"
                title="Write the description yourself"
                onClick={() => {
                  openForm("description");
                }}
              >
                Edit
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={regenMutation.isPending}
                title={
                  regenPending
                    ? "Refresh already requested. Click to ask again"
                    : "Ask the agent to rewrite its description from recent activity"
                }
                onClick={() => {
                  regenMutation.mutate();
                }}
              >
                <Icon
                  icon={RefreshIcon}
                  className={cn("size-3.5", (regenMutation.isPending || regenPending) && "animate-spin")}
                />
                {regenPending ? "Refreshing…" : profile.description ? "Regenerate" : "Generate"}
              </Button>
            </>
          }
        />
      </SettingsSection>
      <ModalPanel open={open} onOpenChange={setOpen} kind="form">
        {form.kind === "rename" ? (
          <RenameForm key={form.epoch} {...formProps} initial={profile.nickname ?? agentId} />
        ) : (
          <DescriptionForm key={form.epoch} {...formProps} initial={profile.description ?? ""} />
        )}
      </ModalPanel>
    </>
  );
}
