import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { Bot, TriangleAlert } from "lucide-react";
import { AgentFaceAvatar } from "@/components/AgentFaceAvatar";
import { PageHeader } from "@/components/PageHeader";
import { PresenceDot } from "@/components/PresenceDot";
import { ProfileMenuProvider, ProfileMenuTrigger } from "@/components/ProfileMenu";
import { UserAvatar } from "@/components/UserAvatar";
import { SettingsPage, SettingsRow, SettingsSection } from "@/components/settings/Settings";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/context/AuthContext";
import { useActiveOrg } from "@/hooks/useActiveOrg";
import { updateAgentPresence, useAgentStatus } from "@/hooks/useAgentPresence";
import { agentDisplay } from "@/lib/agentDisplay";
import { agentStatusLabel } from "@/lib/agentLiveness";
import {
  approveAgentSignupRequest,
  createOrGetMmDirect,
  getAgentProfile,
  getAgents,
  getReef,
  listMmChannels,
  listOrgSignupRequests,
  rejectAgentSignupRequest,
  type AgentUser,
  type MmChannel,
  type ReefHostAgent,
} from "@/lib/api";
import {
  RUNTIME_LOGO,
  fleetKey,
  formatAgentVersion,
  formatRelativeAgo,
  parseAgentImage,
  reefAttention,
} from "@/lib/formatting";
import { mentionHandle } from "@/lib/messageHelpers";
import { queryKeys } from "@/lib/queryKeys";
import { errMsg, toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

const DIVIDER = "relative before:absolute before:inset-x-4 before:top-0 before:h-px before:bg-foreground/8";

interface Fleet {
  row: ReefHostAgent;
  failure?: string;
}

export default function AgentsPage() {
  const { activeOrgId, user } = useAuth();
  const orgId = activeOrgId ?? "";
  const enabled = Boolean(activeOrgId);
  const { org } = useActiveOrg();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const agentsQuery = useQuery({ queryKey: queryKeys.agents(orgId), queryFn: () => getAgents(orgId), enabled });
  const requestsQuery = useQuery({
    queryKey: queryKeys.orgSignupRequests(orgId),
    queryFn: () => listOrgSignupRequests(orgId),
    enabled,
  });
  const reefQuery = useQuery({
    queryKey: queryKeys.reef(orgId),
    queryFn: () => getReef(orgId),
    enabled: enabled && Boolean(org?.reef_connected),
    refetchInterval: 30_000,
  });
  const channelsQuery = useQuery({
    queryKey: queryKeys.mm.channels(orgId),
    queryFn: () => listMmChannels(orgId),
    enabled,
  });

  const agentsData = agentsQuery.data;
  useEffect(() => {
    if (!agentsData) return;
    updateAgentPresence(
      agentsData.agents
        .filter((a) => a.last_alive_at !== undefined)
        .map((a) => ({ agentId: a.agent_id, lastAliveAt: a.last_alive_at ?? null })),
    );
  }, [agentsData]);

  const review = useMutation({
    mutationFn: ({ id, approve }: { id: string; approve: boolean }) =>
      (approve ? approveAgentSignupRequest : rejectAgentSignupRequest)(orgId, id),
    onSuccess: (request, { approve }) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.orgSignupRequests(orgId) });
      if (approve) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.agents(orgId) });
        void queryClient.invalidateQueries({ queryKey: queryKeys.mm.channelsAll });
      }
      toast.success(`${approve ? "Approved" : "Rejected"} ${request.agent_id}`);
    },
    onError: (err) => {
      toast.error(errMsg(err, "Couldn't review the request"));
    },
  });

  if (!activeOrgId) {
    return <div className="text-sm text-muted-foreground">Select an organization.</div>;
  }

  const fleet = new Map<string | null, Fleet>();
  for (const { host, agents, events } of reefQuery.data?.hosts ?? []) {
    for (const row of agents) {
      const failure =
        row.state === "failed" ? events.find((e) => e.agent === row.name && e.kind === "failed")?.detail : undefined;
      fleet.set(fleetKey(host, row.name), { row, failure });
    }
  }
  const agents = (agentsData?.agents ?? []).toSorted((a, b) =>
    (b.creation_time ?? "").localeCompare(a.creation_time ?? ""),
  );
  const keyOf = (a: AgentUser) => (a.reef_host && a.reef_name ? fleetKey(a.reef_host, a.reef_name) : null);
  const enrolled = new Set(agents.map(keyOf));
  const waiting = (reefQuery.data?.declared ?? []).filter((d) => !enrolled.has(fleetKey(d.host, d.name)));
  const requests = requestsQuery.data?.requests ?? [];
  const dms = new Map(
    (channelsQuery.data?.channels ?? []).flatMap((c) => (c.dm_peer_agent_id ? [[c.dm_peer_agent_id, c] as const] : [])),
  );
  const yours = agents.filter((a) => a.is_operator);
  const others = agents.filter((a) => !a.is_operator);

  const section = (label: string, list: AgentUser[]) =>
    list.length > 0 && (
      <SettingsSection label={label} stack>
        {list.map((agent) => (
          <AgentCard
            key={agent.agent_id}
            orgId={orgId}
            agent={agent}
            fleet={fleet.get(keyOf(agent))}
            dm={dms.get(agent.agent_id)}
          />
        ))}
      </SettingsSection>
    );

  return (
    <ProfileMenuProvider orgId={orgId} currentUserId={user?.id ?? null}>
      <SettingsPage>
        <PageHeader
          breadcrumb={[{ label: "Agents", icon: Bot }]}
          actions={
            <Button
              size="compact"
              onClick={() => {
                void navigate("/setup/agent");
              }}
            >
              New agent
            </Button>
          }
        />

        {requests.length + waiting.length > 0 && (
          <SettingsSection label="Joining">
            {requests.map((r) => (
              <SettingsRow
                key={r.request_id}
                leading={<AgentFaceAvatar name={r.agent_id} />}
                title={r.agent_id}
                description={`Asked to join ${formatRelativeAgo(r.created_at)}`}
                control={
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={review.isPending}
                      onClick={() => {
                        review.mutate({ id: r.request_id, approve: false });
                      }}
                    >
                      Reject
                    </Button>
                    <Button
                      size="sm"
                      disabled={review.isPending}
                      onClick={() => {
                        review.mutate({ id: r.request_id, approve: true });
                      }}
                    >
                      Approve
                    </Button>
                  </>
                }
              />
            ))}
            {waiting.map((d) => (
              <SettingsRow
                key={fleetKey(d.host, d.name)}
                leading={<AgentFaceAvatar name={d.name} />}
                title={d.name}
                description={`Waiting to join ${d.host}`}
              />
            ))}
          </SettingsSection>
        )}

        {agentsQuery.isPending ? (
          <SettingsSection stack>
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-28 rounded-[14px]" />
            ))}
          </SettingsSection>
        ) : agentsQuery.isError ? (
          <SettingsSection>
            <SettingsRow title="Couldn't load agents" error={errMsg(agentsQuery.error, "Try again in a moment")} />
          </SettingsSection>
        ) : agents.length === 0 ? (
          <SettingsSection>
            <SettingsRow title="No agents yet" />
          </SettingsSection>
        ) : (
          <>
            {section("Your agents", yours)}
            {section(yours.length > 0 ? "Other agents" : "In the org", others)}
          </>
        )}
      </SettingsPage>
    </ProfileMenuProvider>
  );
}

function AgentCard({ orgId, agent, fleet, dm }: { orgId: string; agent: AgentUser; fleet?: Fleet; dm?: MmChannel }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const status = useAgentStatus(agent.agent_id, agent.last_alive_at);
  const openChat = useMutation({
    mutationFn: () => createOrGetMmDirect(orgId, "agent", agent.agent_id),
    onSuccess: (channel) => {
      void navigate(`/channels/${channel.channel_id}`);
    },
    onError: (err) => {
      toast.error(errMsg(err, "Couldn't open chat"));
    },
  });

  const name = agentDisplay(agent);
  const image = fleet && parseAgentImage(fleet.row.image);
  const place = image ? null : (agent.reef_host ?? "Self-hosted");
  const version = image
    ? formatAgentVersion(image, agent.plugin_version)
    : agent.plugin_version && `plugin ${agent.plugin_version}`;
  const flag = fleet && reefAttention(fleet.row);
  const phrase = flag?.label ?? (status === "setup" ? "not connected yet" : null);
  const unread = dm?.unread_count ?? 0;
  const operator = agent.operator;
  const owner = operator && {
    agent_id: null,
    human_id: operator.human_id,
    display_name: operator.display_name ?? null,
    status: null,
    avatar: operator.avatar ?? null,
  };
  const ownerLabel = agent.is_operator ? "You" : (operator?.display_name ?? "");

  const prefetch = () => {
    void queryClient.prefetchQuery({
      queryKey: queryKeys.agentProfile(orgId, agent.agent_id),
      queryFn: () => getAgentProfile(orgId, agent.agent_id),
      staleTime: 30_000,
    });
  };

  return (
    <article className="relative rounded-[14px] bg-card has-[a:not([data-slot=button]):focus-visible]:bg-[color-mix(in_oklch,var(--card),var(--foreground)_4%)] has-[a:not([data-slot=button]):hover]:bg-[color-mix(in_oklch,var(--card),var(--foreground)_4%)]">
      <div className="flex items-center gap-3 p-4">
        <span className="relative flex shrink-0">
          <AgentFaceAvatar src={agent.avatar?.url} name={name} size={40} />
          <PresenceDot
            status={status}
            label={agentStatusLabel(status)}
            ringClassName="ring-2 ring-card"
            className="absolute -right-0.5 -bottom-0.5"
          />
        </span>
        <span className="min-w-0 flex-1 leading-5">
          <Link
            to={`/agents/${encodeURIComponent(agent.agent_id)}`}
            onPointerEnter={prefetch}
            onFocus={prefetch}
            className="block truncate text-[15px] font-medium outline-none after:absolute after:inset-0"
          >
            {name}
          </Link>
          <span className="block truncate text-[13px] text-muted-foreground">
            {agent.description ?? "No description yet"}
          </span>
        </span>
        <span className="relative flex w-20 shrink-0 justify-end">
          <Button
            variant="outline"
            size="sm"
            disabled={!agent.can_dm || openChat.isPending}
            onClick={() => {
              if (dm) void navigate(`/channels/${dm.channel_id}`);
              else openChat.mutate();
            }}
          >
            Chat
            {unread > 0 && (
              <span className="grid h-4 min-w-4 place-items-center rounded-full bg-primary px-1 text-[11px] font-semibold text-primary-foreground tabular-nums">
                {unread}
              </span>
            )}
          </Button>
        </span>
      </div>

      <div className={cn(DIVIDER, "flex h-10 items-center gap-4 px-4 text-[13px] tabular-nums")}>
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <img
            src={RUNTIME_LOGO[agent.agent_type ?? image?.scheme?.runtime ?? ""] ?? "/unknown-agent.svg"}
            alt=""
            className="size-4 shrink-0"
          />
          <span className="truncate text-muted-foreground">
            {place && <span className="text-foreground">{place}</span>}
            {place && version && " · "}
            {version}
          </span>
          {phrase && (
            <span className={cn("shrink-0", flag?.bad ? "text-destructive" : "text-muted-foreground")}>· {phrase}</span>
          )}
        </span>
        {owner && (
          <ProfileMenuTrigger
            member={owner}
            handleText={`@${mentionHandle(owner)}`}
            ariaLabel={`${ownerLabel} profile`}
            className="relative flex max-w-[45%] shrink-0 items-center gap-2 rounded-md outline-none transition-opacity hover:opacity-70 focus-visible:ring-2 focus-visible:ring-ring"
          >
            <UserAvatar name={ownerLabel} src={operator.avatar?.url} size={16} />
            <span className="truncate">{ownerLabel}</span>
          </ProfileMenuTrigger>
        )}
      </div>

      {fleet?.failure && (
        <div className={cn(DIVIDER, "flex min-h-12 items-center gap-2 px-4 text-[13px]")}>
          <TriangleAlert className="size-4 shrink-0 text-destructive" />
          <span className="min-w-0 flex-1 truncate">{fleet.failure}</span>
          <Button variant="outline" size="sm" className="relative" nativeButton={false} render={<Link to="/settings/reef" />}>
            Open Reef
          </Button>
        </div>
      )}
    </article>
  );
}
