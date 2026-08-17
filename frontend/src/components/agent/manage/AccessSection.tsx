/**
 * AccessSection — the agent's contact allowlist ("who can reach it").
 * Contact is closed by default (see the backend ``AgentContactPermission``):
 * nobody may DM or ``@``-tag the agent until granted here; the operator is
 * always implicitly allowed and shows as a pinned read-only row.
 *
 * Grants ride a single PUT — flipping a chip re-sends both flags, and both
 * flags off removes the principal. Rows resolve avatars by joining the org
 * member + agent lists (the permission payload itself carries only ids and
 * names), degrading to the initial-letter chip for anyone unresolved.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AtIcon,
  Cancel01Icon,
  LockIcon,
  Mail01Icon,
  RefreshIcon,
  Robot02Icon,
  UserIcon,
  UserMultiple02Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
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
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** A principal (human or agent) the operator can grant contact to. */
interface Candidate {
  type: ContactPrincipalType;
  id: string;
  label: string;
  avatarUrl: string | null;
}

/** First non-blank, trimmed value — lets an empty display name fall through to
 *  the next fallback (which ``??`` wouldn't, since ``""`` isn't nullish). */
function pickName(...vals: (string | null | undefined)[]): string {
  for (const v of vals) {
    const t = v?.trim();
    if (t) return t;
  }
  return "";
}

/** One DM/Tag toggle chip: pressed = granted. The label keeps it scannable;
 *  the tooltip carries the full meaning. */
function PermChip({
  icon,
  label,
  tooltip,
  active,
  disabled,
  onToggle,
}: {
  icon: IconSvgElement;
  label: string;
  tooltip: string;
  active: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-pressed={active}
            aria-label={tooltip}
            disabled={disabled}
            onClick={onToggle}
            className={cn(
              "flex h-9 items-center gap-1 rounded-lg border border-transparent px-2 text-xs font-medium transition-colors outline-none",
              "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30",
              "disabled:pointer-events-none disabled:opacity-50",
              active
                ? "bg-primary/10 text-foreground"
                : "text-muted-foreground/50 hover:bg-muted hover:text-muted-foreground",
            )}
          >
            <Icon icon={icon} className="size-3.5" />
            {label}
          </button>
        }
      />
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}

/** Small person/robot marker after the name — the row's only type signal. */
function TypeIcon({ type }: { type: ContactPrincipalType }) {
  const human = type === "human";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="shrink-0 text-muted-foreground/60">
            <Icon icon={human ? UserIcon : Robot02Icon} className="size-3.5" />
          </span>
        }
      />
      <TooltipContent>{human ? "Person" : "Agent"}</TooltipContent>
    </Tooltip>
  );
}

export function AccessSection({
  orgId,
  agentId,
  operator,
}: {
  orgId: string;
  agentId: string;
  /** The agent's operator — always allowed, rendered pinned + read-only. */
  operator: AgentOperator | null;
}) {
  const queryClient = useQueryClient();
  const permsKey = queryKeys.agentContactPermissions(agentId);
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");

  const permsQuery = useQuery({
    queryKey: permsKey,
    queryFn: () => listAgentContactPermissions(agentId),
    enabled: Boolean(agentId),
  });
  // Both lists power the row avatars (and the add picker), so they stay
  // enabled for the section's whole life — cheap, and usually already cached
  // by the sidebar / members surfaces.
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

  const grants = useMemo(
    () => permsQuery.data?.permissions ?? [],
    [permsQuery.data],
  );
  const grantedKeys = useMemo(
    () => new Set(grants.map((g) => `${g.principal_type}:${g.principal_id}`)),
    [grants],
  );

  /** ``type:id`` → avatar + label, joined from the member/agent lists. */
  const directory = useMemo(() => {
    const map = new Map<string, { label: string; avatarUrl: string | null }>();
    for (const m of membersQuery.data?.members ?? []) {
      map.set(`human:${String(m.human_id)}`, {
        label: pickName(m.display_name, m.email),
        avatarUrl: m.avatar?.url ?? null,
      });
    }
    for (const a of agentsQuery.data?.agents ?? []) {
      map.set(`agent:${a.agent_id}`, {
        label: pickName(a.display_name, a.nickname, a.agent_id),
        avatarUrl: a.avatar?.url ?? null,
      });
    }
    return map;
  }, [membersQuery.data, agentsQuery.data]);

  // Candidates for the add picker: every org member + peer agent that isn't
  // the operator, the agent itself, or already granted.
  const candidates = useMemo<Candidate[]>(() => {
    const humans: Candidate[] = (membersQuery.data?.members ?? [])
      .filter((m) => m.human_id !== operator?.human_id)
      .map((m) => ({
        type: "human" as const,
        id: String(m.human_id),
        label: pickName(m.display_name, m.email),
        avatarUrl: m.avatar?.url ?? null,
      }));
    const agents: Candidate[] = (agentsQuery.data?.agents ?? [])
      .filter((a) => a.agent_id !== agentId)
      .map((a) => ({
        type: "agent" as const,
        id: a.agent_id,
        label: pickName(a.display_name, a.nickname, a.agent_id),
        avatarUrl: a.avatar?.url ?? null,
      }));
    const q = query.trim().toLowerCase();
    return [...humans, ...agents].filter(
      (c) =>
        !grantedKeys.has(`${c.type}:${c.id}`) &&
        (!q || c.label.toLowerCase().includes(q)),
    );
  }, [membersQuery.data, agentsQuery.data, operator?.human_id, agentId, grantedKeys, query]);

  const mutation = useMutation({
    mutationFn: (vars: {
      type: ContactPrincipalType;
      id: string;
      can_dm: boolean;
      can_tag: boolean;
    }) =>
      setAgentContactPermission(agentId, vars.type, vars.id, {
        can_dm: vars.can_dm,
        can_tag: vars.can_tag,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: permsKey });
      // The viewer-scoped can_dm/can_tag flags on the agent payloads change too.
      void queryClient.invalidateQueries({ queryKey: ["agentProfile"] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents(orgId) });
    },
    onError: (err: unknown) => {
      toast.error(errMsg(err, "Couldn't update permission"));
      void queryClient.invalidateQueries({ queryKey: permsKey });
    },
  });

  // Scope the in-flight disable to the touched principal's row.
  const pendingPrincipal = mutation.isPending
    ? `${mutation.variables.type}:${mutation.variables.id}`
    : null;

  const update = (
    entry: ContactPermissionEntry,
    patch: { can_dm?: boolean; can_tag?: boolean },
  ) => {
    mutation.mutate({
      type: entry.principal_type,
      id: entry.principal_id,
      can_dm: patch.can_dm ?? entry.can_dm,
      can_tag: patch.can_tag ?? entry.can_tag,
    });
  };

  const addCandidate = (c: Candidate) => {
    // New grants default to Tag (channel mentions); the operator can flip on DM.
    mutation.mutate({ type: c.type, id: c.id, can_dm: false, can_tag: true });
    setAdding(false);
    setQuery("");
  };

  const humanCandidates = candidates.filter((c) => c.type === "human");
  const agentCandidates = candidates.filter((c) => c.type === "agent");

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <SectionHeader icon={UserMultiple02Icon}>
          <span className="truncate">Who can reach this agent</span>
          {grants.length > 0 && (
            <span className="tabular-nums text-muted-foreground/70">
              {grants.length}
            </span>
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
          {/* Pinned operator — always allowed, no controls. */}
          {operator && (
            <div className="flex items-center gap-3 px-4 py-2.5">
              <Avatar
                src={operator.avatar?.url}
                name={operator.display_name ?? "Operator"}
                size={32}
                className="rounded-full"
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-foreground">
                  {operator.display_name ?? "Operator"}
                </div>
                <div className="text-label text-muted-foreground">Operator</div>
              </div>
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-muted/60 px-2.5 py-1 text-label font-medium text-muted-foreground">
                <Icon icon={LockIcon} className="size-3" />
                Always allowed
              </span>
            </div>
          )}

          {/* Granted principals. */}
          {permsQuery.isLoading ? (
            <div className="space-y-2 px-4 py-3">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          ) : permsQuery.isError ? (
            <div className="flex items-center justify-between gap-3 px-4 py-3">
              <span className="text-caption text-muted-foreground">
                Couldn&apos;t load the allowlist.
              </span>
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
              const label =
                pickName(entry.display_name, info?.label) || entry.principal_id;
              const rowPending = pendingPrincipal === key;
              return (
                <div key={key} className="group flex items-center gap-3 px-4 py-2.5">
                  <Avatar
                    src={info?.avatarUrl}
                    name={label}
                    size={32}
                    className="rounded-full"
                  />
                  <div className="flex min-w-0 flex-1 items-center gap-1.5">
                    <span className="truncate text-sm text-foreground">{label}</span>
                    <TypeIcon type={entry.principal_type} />
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <PermChip
                      icon={Mail01Icon}
                      label="DM"
                      tooltip="Can open a direct message"
                      active={entry.can_dm}
                      disabled={rowPending}
                      onToggle={() => {
                        update(entry, { can_dm: !entry.can_dm });
                      }}
                    />
                    <PermChip
                      icon={AtIcon}
                      label="Tag"
                      tooltip="Can @-mention in channels"
                      active={entry.can_tag}
                      disabled={rowPending}
                      onToggle={() => {
                        update(entry, { can_tag: !entry.can_tag });
                      }}
                    />
                    <button
                      type="button"
                      disabled={rowPending}
                      onClick={() => {
                        update(entry, { can_dm: false, can_tag: false });
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

      {/* Add picker — search + grouped candidates, granting Tag on pick. */}
      <Dialog
        open={adding}
        onOpenChange={(next) => {
          setAdding(next);
          if (!next) setQuery("");
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              <Icon icon={UserMultiple02Icon} className="text-muted-foreground" />
              Grant access
            </DialogTitle>
            <DialogDescription>
              Contact is closed by default. New grants start with{" "}
              <strong>Tag</strong> (@mentions in channels); switch on{" "}
              <strong>DM</strong> from the list after.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Input
              autoFocus
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
              }}
              placeholder="Search people and agents…"
              aria-label="Search people and agents"
            />
            <div className="max-h-72 overflow-y-auto rounded-lg border border-border/50">
              {membersQuery.isLoading || agentsQuery.isLoading ? (
                <div className="space-y-2 p-2">
                  <Skeleton className="h-7 w-full" />
                  <Skeleton className="h-7 w-full" />
                </div>
              ) : candidates.length === 0 ? (
                <div className="px-3 py-4 text-xs text-muted-foreground">
                  No one left to add.
                </div>
              ) : (
                (
                  [
                    ["People", humanCandidates],
                    ["Agents", agentCandidates],
                  ] as const
                ).map(
                  ([group, list]) =>
                    list.length > 0 && (
                      <div key={group}>
                        <div className="px-3 pb-1 pt-2 text-label font-medium uppercase tracking-wide text-muted-foreground/70">
                          {group}
                        </div>
                        <ul>
                          {list.map((c) => (
                            <li key={`${c.type}:${c.id}`}>
                              <button
                                type="button"
                                disabled={mutation.isPending}
                                onClick={() => {
                                  addCandidate(c);
                                }}
                                className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-muted/60 disabled:opacity-60"
                              >
                                <Avatar
                                  src={c.avatarUrl}
                                  name={c.label}
                                  size={24}
                                  className="rounded-full"
                                />
                                <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                                  {c.label}
                                </span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ),
                )
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
