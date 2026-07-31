import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import {
  Logout01Icon,
  PlusSignIcon,
  UserMinus01Icon,
  UserMultiple02Icon,
} from "@hugeicons/core-free-icons";
import { AgentFaceAvatar } from "@/components/AgentFaceAvatar";
import { UserAvatar } from "@/components/UserAvatar";
import { agentDisplay } from "@/lib/agentDisplay";
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
import { useAuth } from "@/context/AuthContext";
import {
  addMmChannelMember,
  getAgents,
  listMmChannelMembers,
  listOrgMembers,
  removeMmChannelMember,
  type MmChannelMember,
} from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import { errMsg, toast } from "@/lib/toast";

interface ManageMembersDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  channelId: string;
  orgId: string;
  channelLabel: string;
}

type Kind = "agent" | "human";

function memberKind(m: MmChannelMember): Kind {
  return m.agent_id ? "agent" : "human";
}
function memberRefId(m: MmChannelMember): string {
  return m.agent_id ?? String(m.human_id ?? "");
}
function memberName(m: MmChannelMember): string {
  if (m.display_name) return m.display_name;
  if (m.agent_id) return m.agent_id;
  if (m.human_id != null) return `User ${String(m.human_id)}`;
  return "Unknown";
}

function Avatar({ kind, seed, src }: { kind: Kind; seed: string; src?: string | null }) {
  return kind === "agent"
    ? <AgentFaceAvatar size={28} name={seed} src={src} />
    : <UserAvatar size={28} name={seed} src={src} />;
}

export default function ManageMembersDialog({
  open,
  onOpenChange,
  channelId,
  orgId,
  channelLabel,
}: ManageMembersDialogProps) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const membersQuery = useQuery({
    queryKey: queryKeys.mm.channelMembers(channelId),
    queryFn: () => listMmChannelMembers(channelId),
    enabled: Boolean(channelId && open),
  });

  const orgMembersQuery = useQuery({
    queryKey: queryKeys.orgMembers(orgId),
    queryFn: () => listOrgMembers(orgId),
    enabled: Boolean(orgId && open),
  });

  const orgAgentsQuery = useQuery({
    queryKey: queryKeys.agents(orgId),
    queryFn: () => getAgents(orgId),
    enabled: Boolean(orgId && open),
  });

  const addMutation = useMutation({
    mutationFn: (v: { memberId: string; memberType: Kind }) =>
      addMmChannelMember(channelId, v.memberId, v.memberType),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.mm.channelMembers(channelId),
      });
      toast.success("Member added");
    },
    onError: (err: unknown) => {
      toast.error(errMsg(err, "Couldn't add member"));
    },
  });

  const removeMutation = useMutation({
    mutationFn: (m: MmChannelMember) =>
      removeMmChannelMember(channelId, memberRefId(m), memberKind(m)),
    onSuccess: (_data, removed) => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.mm.channelMembers(channelId),
      });
      const isSelf = removed.human_id != null && removed.human_id === user?.id;
      if (isSelf) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.mm.channelsAll });
        toast.success("You left the channel");
        onOpenChange(false);
        void navigate("/home", { replace: true });
      } else {
        toast.success("Member removed");
      }
    },
    onError: (err: unknown) => {
      toast.error(errMsg(err, "Failed to remove"));
    },
  });

  const members = membersQuery.data?.members ?? [];
  const currentHumanIds = new Set(
    members.map(m => m.human_id).filter((id): id is number => id != null),
  );
  const currentAgentIds = new Set(
    members.map(m => m.agent_id).filter((id): id is string => id != null),
  );
  const humansToAdd = (orgMembersQuery.data?.members ?? []).filter(
    m => !currentHumanIds.has(m.human_id),
  );
  const agentsToAdd = (orgAgentsQuery.data?.agents ?? []).filter(
    a => !currentAgentIds.has(a.agent_id),
  );
  const hasAnyToAdd = humansToAdd.length > 0 || agentsToAdd.length > 0;
  const anyListLoading = orgMembersQuery.isLoading || orgAgentsQuery.isLoading;
  const anyListError = orgMembersQuery.isError || orgAgentsQuery.isError;
  const busy = addMutation.isPending || removeMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            <Icon icon={UserMultiple02Icon} className="text-muted-foreground" />
            <span className="truncate">Manage members · {channelLabel}</span>
          </DialogTitle>
          <DialogDescription className="sr-only">
            Add or remove members of this channel.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[75vh] space-y-4 overflow-y-auto">
          {/* Current members */}
          <section className="space-y-2">
            <h3 className="text-xs font-medium text-muted-foreground">
              In this channel ({members.length})
            </h3>
            <div className="overflow-hidden rounded-lg border border-border/50 bg-background/40">
              {membersQuery.isLoading && (
                <div className="p-3 text-sm text-muted-foreground">Loading…</div>
              )}
              {!membersQuery.isLoading && members.length === 0 && (
                <div className="p-3 text-sm text-muted-foreground">No members yet.</div>
              )}
              {members.length > 0 && (
                <ul className="divide-y divide-border/50">
                  {members.map(m => {
                    const kind = memberKind(m);
                    const isSelf = m.human_id != null && m.human_id === user?.id;
                    const seed = kind === "human"
                      ? (m.human_id != null ? String(m.human_id) : "user")
                      : (m.display_name ?? m.agent_id ?? "agent");
                    return (
                      <li key={`cur:${kind}:${memberRefId(m)}`} className="flex items-center gap-3 p-3">
                        <Avatar kind={kind} seed={seed} src={m.avatar?.url} />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium">{memberName(m)}</div>
                          <div className="truncate text-xs text-muted-foreground">
                            {isSelf ? "You" : kind === "agent" ? "Agent" : "Human"}
                          </div>
                        </div>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="bg-destructive/10 text-destructive hover:bg-destructive/15 hover:text-destructive"
                          disabled={busy}
                          onClick={() => { removeMutation.mutate(m); }}
                        >
                          <Icon icon={isSelf ? Logout01Icon : UserMinus01Icon} className="size-4" />
                          {isSelf ? "Leave" : "Remove"}
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </section>

          {/* Available to add */}
          <section className="space-y-2">
            <h3 className="text-xs font-medium text-muted-foreground">
              Add from org
            </h3>
            <div className="overflow-hidden rounded-lg border border-border/50 bg-background/40">
              {anyListLoading && (
                <div className="p-3 text-sm text-muted-foreground">Loading…</div>
              )}
              {!anyListLoading && anyListError && (
                <div className="p-3 text-sm text-destructive">
                  Couldn't load directory:{" "}
                  {errMsg(orgMembersQuery.error ?? orgAgentsQuery.error)}
                </div>
              )}
              {!anyListLoading && !anyListError && !hasAnyToAdd && (
                <div className="p-3 text-sm text-muted-foreground">
                  Everyone in the org is already in this channel.
                </div>
              )}
              {hasAnyToAdd && (
                <ul className="divide-y divide-border/50">
                  {humansToAdd.map(m => (
                    <li key={`hu:${String(m.human_id)}`} className="flex items-center gap-3 p-3">
                      <Avatar kind="human" seed={m.display_name ?? m.email} src={m.avatar?.url} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">
                          {m.display_name ?? m.email}
                        </div>
                        <div className="truncate text-xs text-muted-foreground">{m.email}</div>
                      </div>
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() => {
                          addMutation.mutate({
                            memberId: String(m.human_id),
                            memberType: "human",
                          });
                        }}
                      >
                        <Icon icon={PlusSignIcon} className="size-4" />
                        Add
                      </Button>
                    </li>
                  ))}
                  {agentsToAdd.map(a => (
                    <li key={`ag:${a.agent_id}`} className="flex items-center gap-3 p-3">
                      <Avatar kind="agent" seed={agentDisplay(a)} src={a.avatar?.url} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">
                          {agentDisplay(a)}
                        </div>
                        <div className="truncate text-xs text-muted-foreground">Agent</div>
                      </div>
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() => {
                          addMutation.mutate({
                            memberId: a.agent_id,
                            memberType: "agent",
                          });
                        }}
                      >
                        <Icon icon={PlusSignIcon} className="size-4" />
                        Add
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => { onOpenChange(false); }}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
