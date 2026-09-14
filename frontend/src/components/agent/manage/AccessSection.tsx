import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Add01Icon, AtIcon, Cancel01Icon, LockIcon, Mail01Icon } from "@hugeicons/core-free-icons";
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
import { AgentFaceAvatar } from "@/components/AgentFaceAvatar";
import { Icon } from "@/components/Icon";
import { UserAvatar } from "@/components/UserAvatar";
import {
  ModalHeader,
  ModalList,
  ModalNote,
  ModalPanel,
  ModalRow,
  ModalSearch,
  ModalSection,
} from "@/components/modals/Modal";
import { SettingsRow, SettingsRowSkeleton, SettingsSection } from "@/components/settings/Settings";
import { Button } from "@/components/ui/button";
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

const CHIP =
  "inline-flex h-[26px] items-center gap-[5px] rounded-[7px] border border-border px-[9px] text-xs font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-pressed:border-transparent aria-pressed:bg-foreground/8 aria-pressed:text-foreground";

function pickName(...vals: (string | null | undefined)[]): string {
  return vals.map((v) => v?.trim()).find(Boolean) ?? "";
}

export function AccessSection({
  orgId,
  agentId,
  agentName,
  operator,
}: {
  orgId: string;
  agentId: string;
  agentName: string;
  operator?: AgentOperator | null;
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
  });
  const agentsQuery = useQuery({
    queryKey: queryKeys.agents(orgId),
    queryFn: () => getAgents(orgId),
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
      void queryClient.invalidateQueries({ queryKey: queryKeys.agentProfile(orgId, agentId) });
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
    <>
      <SettingsSection
        label={`Who can reach ${agentName}`}
        aside={
          <button
            type="button"
            onClick={() => {
              setAdding(true);
            }}
            className="inline-flex items-center gap-1 rounded-sm font-medium text-foreground outline-none transition-colors hover:text-foreground/70 focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <Icon icon={Add01Icon} className="size-3.5" />
            Add
          </button>
        }
      >
        {operator && (
          <SettingsRow
            leading={<UserAvatar name={operatorName} src={operator.avatar?.url} />}
            title={operatorName}
            description="Operator"
            control={
              <span className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground">
                <Icon icon={LockIcon} className="size-3.5" />
                Always allowed
              </span>
            }
          />
        )}
        {permsQuery.isPending ? (
          Array.from({ length: 2 }, (_, i) => <SettingsRowSkeleton key={i} />)
        ) : permsQuery.isError ? (
          <SettingsRow
            title="Couldn't load the allowlist"
            control={
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  void permsQuery.refetch();
                }}
              >
                Retry
              </Button>
            }
          />
        ) : grants.length === 0 ? (
          <SettingsRow
            title={<span className="font-normal text-muted-foreground">No one else can reach {agentName} yet</span>}
          />
        ) : (
          grants.map((entry) => {
            const key = `${entry.principal_type}:${entry.principal_id}`;
            const info = directory.get(key);
            const label = pickName(entry.display_name, info?.label) || entry.principal_id;
            const human = entry.principal_type === "human";
            const rowPending = pendingPrincipal === key;
            return (
              <SettingsRow
                key={key}
                leading={
                  human ? (
                    <UserAvatar name={label} src={info?.avatarUrl} />
                  ) : (
                    <AgentFaceAvatar name={label} src={info?.avatarUrl} />
                  )
                }
                title={label}
                description={human ? "Person" : "Agent"}
                control={
                  <>
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
                              className={CHIP}
                            >
                              <Icon icon={p.icon} className="size-3.5" />
                              {p.label}
                            </button>
                          }
                        />
                        <TooltipContent>{p.tooltip}</TooltipContent>
                      </Tooltip>
                    ))}
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="text-muted-foreground"
                      disabled={rowPending}
                      aria-label={`Remove ${label}`}
                      title="Remove access"
                      onClick={() => {
                        mutation.mutate({ ...entry, can_dm: false, can_tag: false });
                      }}
                    >
                      <Icon icon={Cancel01Icon} className="size-4" />
                    </Button>
                  </>
                }
              />
            );
          })
        )}
      </SettingsSection>

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
          {membersQuery.isPending || agentsQuery.isPending ? (
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
    </>
  );
}
