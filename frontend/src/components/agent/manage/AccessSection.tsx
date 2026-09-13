import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AtIcon,
  Cancel01Icon,
  LockIcon,
  Mail01Icon,
  RefreshIcon,
  UserIcon,
  UserMultiple02Icon,
} from "@hugeicons/core-free-icons";
import { Bot } from "lucide-react";
import {
  getAgents,
  listAgentContactPermissions,
  listOrgMembers,
  setAgentContactPermission,
  type AgentOperator,
  type ContactPermissionEntry,
  type ContactPrincipalType,
} from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import { errMsg, toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { Icon } from "@/components/Icon";
import { Avatar } from "@/components/Avatar";
import { SectionHeader } from "@/components/automations/SectionHeader";
import { ManageAddButton } from "./ManageAddButton";
import {
  ModalHeader,
  ModalList,
  ModalNote,
  ModalPanel,
  ModalRow,
  ModalSearch,
  ModalSection,
} from "@/components/modals/Modal";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface Candidate {
  key: string;
  type: ContactPrincipalType;
  id: string;
  label: string;
  avatarUrl: string | null;
}

type Grant = Pick<ContactPermissionEntry, "principal_type" | "principal_id" | "can_dm" | "can_tag">;

const PERMS = [
  { field: "can_dm", icon: Mail01Icon, label: "DM", tooltip: "Can open a direct message" },
  { field: "can_tag", icon: AtIcon, label: "Tag", tooltip: "Can @-mention in channels" },
] as const;

function pickName(...vals: (string | null | undefined)[]): string {
  return vals.map((v) => v?.trim()).find(Boolean) ?? "";
}

export function AccessSection({
  orgId,
  agentId,
  operator,
}: {
  orgId: string;
  agentId: string;
  operator: AgentOperator | null;
}) {
  const queryClient = useQueryClient();
  const permsKey = queryKeys.agentContactPermissions(agentId);
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");

  const permsQuery = useQuery({
    queryKey: permsKey,
    queryFn: () => listAgentContactPermissions(agentId),
  });
  const membersQuery = useQuery({
    queryKey: queryKeys.orgMembers(orgId),
    queryFn: () => listOrgMembers(orgId),
    enabled: Boolean(orgId),
  });
  const agentsQuery = useQuery({
    queryKey: queryKeys.agents(orgId),
    queryFn: () => getAgents(orgId),
    enabled: Boolean(orgId),
  });

  const grants = permsQuery.data?.permissions ?? [];
  const grantedKeys = new Set(grants.map((g) => `${g.principal_type}:${g.principal_id}`));

  const principals: Candidate[] = [
    ...(membersQuery.data?.members ?? []).map((m): Candidate => ({
      key: `human:${String(m.human_id)}`,
      type: "human",
      id: String(m.human_id),
      label: pickName(m.display_name, m.email),
      avatarUrl: m.avatar?.url ?? null,
    })),
    ...(agentsQuery.data?.agents ?? []).map((a): Candidate => ({
      key: `agent:${a.agent_id}`,
      type: "agent",
      id: a.agent_id,
      label: pickName(a.display_name, a.nickname, a.agent_id),
      avatarUrl: a.avatar?.url ?? null,
    })),
  ];
  const directory = new Map(principals.map((c) => [c.key, c]));

  const operatorKey = operator ? `human:${String(operator.human_id)}` : null;
  const operatorName = operator?.display_name ?? "Operator";
  const needle = query.trim().toLowerCase();
  const candidates = principals.filter(
    (c) =>
      c.key !== operatorKey &&
      c.key !== `agent:${agentId}` &&
      !grantedKeys.has(c.key) &&
      (!needle || c.label.toLowerCase().includes(needle)),
  );
  const groups = [
    { label: "People", entries: candidates.filter((c) => c.type === "human") },
    { label: "Agents", entries: candidates.filter((c) => c.type === "agent") },
  ];

  const mutation = useMutation({
    mutationFn: (g: Grant) =>
      setAgentContactPermission(agentId, g.principal_type, g.principal_id, {
        can_dm: g.can_dm,
        can_tag: g.can_tag,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: permsKey });
      void queryClient.invalidateQueries({ queryKey: ["agentProfile"] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents(orgId) });
    },
    onError: (err) => {
      toast.error(errMsg(err, "Couldn't update permission"));
      void queryClient.invalidateQueries({ queryKey: permsKey });
    },
  });

  const pendingPrincipal = mutation.isPending
    ? `${mutation.variables.principal_type}:${mutation.variables.principal_id}`
    : null;

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <SectionHeader icon={UserMultiple02Icon}>
          <span className="truncate">Who can reach this agent</span>
          {grants.length > 0 && (
            <span className="tabular-nums text-muted-foreground/70">{grants.length}</span>
          )}
        </SectionHeader>
        <ManageAddButton
          onClick={() => {
            setAdding(true);
          }}
        />
      </div>

      <div className="overflow-hidden rounded-xl border border-border/60 bg-card">
        <div className="divide-y divide-border/60">
          {operator && (
            <div className="flex items-center gap-3 px-4 py-2.5">
              <Avatar src={operator.avatar?.url} name={operatorName} size={32} className="rounded-full" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-foreground">{operatorName}</div>
                <div className="text-label text-muted-foreground">Operator</div>
              </div>
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-muted/60 px-2.5 py-1 text-label font-medium text-muted-foreground">
                <Icon icon={LockIcon} className="size-3" />
                Always allowed
              </span>
            </div>
          )}

          {permsQuery.isLoading ? (
            <div className="space-y-2 px-4 py-3">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          ) : permsQuery.isError ? (
            <div className="flex items-center justify-between gap-3 px-4 py-3">
              <span className="text-caption text-muted-foreground">Couldn&apos;t load the allowlist.</span>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => {
                  void permsQuery.refetch();
                }}
              >
                <Icon icon={RefreshIcon} className="size-3.5" />
                Retry
              </Button>
            </div>
          ) : grants.length === 0 ? (
            <div className="px-4 py-4 text-caption text-muted-foreground">
              No one else can reach this agent yet - grant access with{" "}
              <span className="font-medium">Add</span>.
            </div>
          ) : (
            grants.map((entry) => {
              const key = `${entry.principal_type}:${entry.principal_id}`;
              const info = directory.get(key);
              const label = pickName(entry.display_name, info?.label) || entry.principal_id;
              const human = entry.principal_type === "human";
              const rowPending = pendingPrincipal === key;
              return (
                <div key={key} className="group flex items-center gap-3 px-4 py-2.5">
                  <Avatar src={info?.avatarUrl} name={label} size={32} className="rounded-full" />
                  <div className="flex min-w-0 flex-1 items-center gap-1.5">
                    <span className="truncate text-sm text-foreground">{label}</span>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <span className="shrink-0 text-muted-foreground/60">
                            <Icon icon={human ? UserIcon : Bot} className="size-3.5" />
                          </span>
                        }
                      />
                      <TooltipContent>{human ? "Person" : "Agent"}</TooltipContent>
                    </Tooltip>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {PERMS.map((p) => (
                      <Tooltip key={p.field}>
                        <TooltipTrigger
                          render={
                            <button
                              type="button"
                              aria-pressed={entry[p.field]}
                              aria-label={p.tooltip}
                              disabled={rowPending}
                              onClick={() => {
                                mutation.mutate({ ...entry, [p.field]: !entry[p.field] });
                              }}
                              className={cn(
                                "flex h-9 items-center gap-1 rounded-lg border border-transparent px-2 text-xs font-medium transition-colors outline-none",
                                "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30",
                                "disabled:pointer-events-none disabled:opacity-50",
                                entry[p.field]
                                  ? "bg-primary/10 text-foreground"
                                  : "text-muted-foreground/50 hover:bg-muted hover:text-muted-foreground",
                              )}
                            >
                              <Icon icon={p.icon} className="size-3.5" />
                              {p.label}
                            </button>
                          }
                        />
                        <TooltipContent>{p.tooltip}</TooltipContent>
                      </Tooltip>
                    ))}
                    <button
                      type="button"
                      disabled={rowPending}
                      onClick={() => {
                        mutation.mutate({ ...entry, can_dm: false, can_tag: false });
                      }}
                      className={cn(
                        "ml-1 flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-[color,background-color,opacity] outline-none",
                        "opacity-0 focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100",
                        "hover:bg-muted hover:text-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30",
                        "disabled:pointer-events-none disabled:opacity-40",
                      )}
                      aria-label={`Remove ${label}`}
                      title="Remove access"
                    >
                      <Icon icon={Cancel01Icon} className="size-4" />
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      <ModalPanel
        open={adding}
        onOpenChange={(next) => {
          setAdding(next);
          if (!next) setQuery("");
        }}
        kind="picker"
      >
        <ModalHeader
          title="Grant access"
          description="Contact is closed by default. New grants start with Tag (@mentions in channels); switch on DM from the list after."
        >
          <ModalSearch value={query} onChange={setQuery} placeholder="Search people and agents" />
        </ModalHeader>
        <ModalList>
          {membersQuery.isLoading || agentsQuery.isLoading ? (
            <ModalNote>Loading…</ModalNote>
          ) : candidates.length === 0 ? (
            <ModalNote>No one left to add.</ModalNote>
          ) : (
            groups.map(
              (g) =>
                g.entries.length > 0 && (
                  <ModalSection key={g.label} label={g.label}>
                    {g.entries.map((c) => (
                      <ModalRow
                        key={c.key}
                        kind={c.type}
                        name={c.label}
                        avatarUrl={c.avatarUrl}
                        disabled={mutation.isPending}
                        onSelect={() => {
                          mutation.mutate({ principal_type: c.type, principal_id: c.id, can_dm: false, can_tag: true });
                          setAdding(false);
                          setQuery("");
                        }}
                      />
                    ))}
                  </ModalSection>
                ),
            )
          )}
        </ModalList>
      </ModalPanel>
    </section>
  );
}
