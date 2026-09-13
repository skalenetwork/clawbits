import {useEffect, useRef} from "react";
import {useMutation, useQuery, useQueryClient} from "@tanstack/react-query";
import {Link, useNavigate} from "react-router-dom";
import {
    Calendar03Icon as Calendar,
    UserAdd01Icon as AddAgent,
    Tick01Icon as Check,
    Cancel01Icon as Reject,
} from "@hugeicons/core-free-icons";
import {Bot} from "lucide-react";
import {Icon} from "@/components/Icon";
import {AgentFaceAvatar} from "@/components/AgentFaceAvatar";
import {PageHeader} from "@/components/PageHeader";
import {Button} from "@/components/ui/button";
import {AddAgentCard, AgentCollectibleCard} from "@/components/agent-card";
import {useAuth} from "@/context/AuthContext";
import {updateAgentPresence, useAgentStatus} from "@/hooks/useAgentPresence";
import {agentDisplay} from "@/lib/agentDisplay";
import {
    approveAgentSignupRequest,
    getAgentProfile,
    getAgents,
    listOrgSignupRequests,
    rejectAgentSignupRequest,
    type AgentSignupRequest,
    type AgentUser,
} from "@/lib/api";
import {formatRelativeShort} from "@/lib/formatting";
import {queryKeys} from "@/lib/queryKeys";
import {errMsg, toast} from "@/lib/toast";
import {cn} from "@/lib/utils";
import {morphAgentCardNavigation, waitForElement} from "@/lib/viewTransition";

const TILTS = ["-rotate-3", "-rotate-1", "rotate-2", "rotate-3", "-rotate-2", "rotate-1"];
const GRID = "grid grid-cols-1 justify-items-center gap-x-6 gap-y-12 sm:grid-cols-2 lg:grid-cols-3";
const BINDER_CARD =
    "group relative block w-full max-w-[360px] outline-none transition-transform duration-300 ease-out will-change-transform hover:z-10 focus-visible:z-10 focus-visible:-translate-y-1 focus-visible:scale-[1.02]";

function tiltFor(id: string): string {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h + id.charCodeAt(i)) % TILTS.length;
    return TILTS[h] ?? "";
}

export default function SettingsAgentsPage() {
    const navigate = useNavigate();
    const {activeOrgId} = useAuth();
    const orgId = activeOrgId ?? "";
    const queryClient = useQueryClient();

    const agentsQuery = useQuery({
        queryKey: queryKeys.agents(orgId),
        queryFn: () => getAgents(orgId),
        enabled: Boolean(activeOrgId),
    });

    const pendingQuery = useQuery({
        queryKey: queryKeys.orgSignupRequests(orgId),
        queryFn: () => listOrgSignupRequests(orgId),
        enabled: Boolean(activeOrgId),
    });

    const agentsData = agentsQuery.data;
    useEffect(() => {
        if (!agentsData) return;
        updateAgentPresence(
            agentsData.agents
                .filter(a => a.last_alive_at !== undefined)
                .map(a => ({agentId: a.agent_id, lastAliveAt: a.last_alive_at ?? null})),
        );
    }, [agentsData]);

    const approveMutation = useMutation({
        mutationFn: (requestId: string) => approveAgentSignupRequest(orgId, requestId),
        onSuccess: (req) => {
            void queryClient.invalidateQueries({queryKey: queryKeys.agents(orgId)});
            void queryClient.invalidateQueries({queryKey: queryKeys.orgSignupRequests(orgId)});
            void queryClient.invalidateQueries({queryKey: queryKeys.mm.channelsAll});
            toast.success(`Approved ${req.agent_id}`);
        },
        onError: (err) => { toast.error(errMsg(err, "Failed to approve")); },
    });

    const rejectMutation = useMutation({
        mutationFn: (requestId: string) => rejectAgentSignupRequest(orgId, requestId),
        onSuccess: (req) => {
            void queryClient.invalidateQueries({queryKey: queryKeys.orgSignupRequests(orgId)});
            toast.success(`Rejected ${req.agent_id}`);
        },
        onError: (err) => { toast.error(errMsg(err, "Failed to reject")); },
    });

    if (!activeOrgId) {
        return <div className="text-sm text-muted-foreground">Select an organization.</div>;
    }

    const agents = [...(agentsData?.agents ?? [])].sort(
        (a, b) =>
            Number(b.is_operator ?? false) - Number(a.is_operator ?? false) ||
            (b.creation_time ?? "").localeCompare(a.creation_time ?? ""),
    );
    const pending = pendingQuery.data?.requests ?? [];
    const isLoading = agentsQuery.isLoading || pendingQuery.isLoading;
    const isError = agentsQuery.isError || pendingQuery.isError;
    const isBusyApproval = approveMutation.isPending || rejectMutation.isPending;

    return (
        <div className="space-y-8 pb-16">
            <PageHeader breadcrumb={[{label: "Agents", icon: Bot}]}/>

            {isLoading && (
                <div className={GRID}>
                    {Array.from({length: 6}).map((_, i) => (
                        <div
                            key={i}
                            className={cn(
                                "aspect-[360/568] w-full max-w-[360px] animate-pulse rounded-[2rem] bg-muted/50",
                                TILTS[i % TILTS.length],
                            )}
                        />
                    ))}
                </div>
            )}

            {isError && (
                <div className="rounded-xl border border-border/50 bg-card p-8 text-center text-sm text-destructive">
                    {agentsQuery.error?.message || pendingQuery.error?.message || "Failed to load agents"}
                </div>
            )}

            {!isLoading && !isError && agents.length + pending.length === 0 && (
                <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border bg-card px-6 py-16 text-center">
                    <div className="flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
                        <Icon icon={Bot} className="size-6"/>
                    </div>
                    <div className="space-y-1">
                        <p className="text-sm font-medium">No agents yet</p>
                        <p className="mx-auto max-w-xs text-xs text-muted-foreground">
                            Agents registered to this organization will appear here as collectible cards.
                        </p>
                    </div>
                    <Button size="sm" className="mt-1" onClick={() => { void navigate("/setup/agent"); }}>
                        <Icon icon={AddAgent} className="size-4"/>
                        New agent
                    </Button>
                </div>
            )}

            {pending.length > 0 && (
                <section className="space-y-3">
                    <h2 className="text-xs font-semibold text-muted-foreground">
                        Pending approval
                    </h2>
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                        {pending.map(request => (
                            <PendingCard
                                key={`p:${request.request_id}`}
                                request={request}
                                onApprove={() => { approveMutation.mutate(request.request_id); }}
                                onReject={() => { rejectMutation.mutate(request.request_id); }}
                                isBusy={isBusyApproval}
                            />
                        ))}
                    </div>
                </section>
            )}

            {/* `isolate` scopes a hovered card's z-index to the grid, below the page header. */}
            {agents.length > 0 && (
                <div className={cn("isolate pt-2", GRID)}>
                    {agents.map(agent => (
                        <BinderCard key={`a:${agent.agent_id}`} agent={agent}/>
                    ))}
                    <button
                        type="button"
                        onClick={() => { void navigate("/setup/agent"); }}
                        aria-label="Add new agent"
                        className={cn(BINDER_CARD, "cursor-pointer", tiltFor("add-new-agent"))}
                    >
                        <div className="w-full">
                            <AddAgentCard size="lg"/>
                        </div>
                    </button>
                </div>
            )}
        </div>
    );
}

function BinderCard({agent}: {agent: AgentUser}) {
    const name = agentDisplay(agent);
    const to = `/agents/${encodeURIComponent(agent.agent_id)}`;
    const navigate = useNavigate();
    const {activeOrgId} = useAuth();
    const queryClient = useQueryClient();
    const cardRef = useRef<HTMLDivElement>(null);
    const status = useAgentStatus(agent.agent_id, agent.last_alive_at);

    const prefetchProfile = () => {
        if (!activeOrgId) return;
        void queryClient.prefetchQuery({
            queryKey: queryKeys.agentProfile(activeOrgId, agent.agent_id),
            queryFn: () => getAgentProfile(activeOrgId, agent.agent_id),
            staleTime: 30_000,
        });
    };

    const openWithMorph = (e: React.MouseEvent) => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        morphAgentCardNavigation({
            navigate: () => { void navigate(to); },
            waitForTarget: () => waitForElement(".vt-agent-card"),
            nameSource: cardRef.current,
        });
    };

    return (
        <Link
            to={to}
            onClick={openWithMorph}
            onPointerEnter={prefetchProfile}
            onFocus={prefetchProfile}
            aria-label={`Open ${name}`}
            className={cn(BINDER_CARD, tiltFor(agent.agent_id))}
        >
            <div ref={cardRef} data-agent-card-id={agent.agent_id} className="w-full">
                <AgentCollectibleCard
                    presentational
                    tilt
                    variant="grid"
                    size="lg"
                    seed={agent.agent_id}
                    name={name}
                    handle={agent.agent_id}
                    joined={agent.creation_time}
                    avatarUrl={agent.avatar?.url}
                    description={agent.description}
                    status={status}
                    runsOnReef={Boolean(agent.reef_host)}
                    agentType={agent.agent_type}
                    pluginVersion={agent.plugin_version}
                    operator={
                        agent.operator
                            ? {
                                name: agent.is_operator ? "You" : (agent.operator.display_name ?? "operator"),
                                avatarUrl: agent.operator.avatar?.url,
                            }
                            : null
                    }
                />
            </div>
        </Link>
    );
}

function PendingCard({
    request,
    onApprove,
    onReject,
    isBusy,
}: {
    request: AgentSignupRequest;
    onApprove: () => void;
    onReject: () => void;
    isBusy: boolean;
}) {
    return (
        <div className="flex flex-col rounded-xl border border-amber-500/30 bg-amber-500/[0.03] p-5">
            <div className="flex items-start gap-3.5">
                <AgentFaceAvatar size={44} name={request.agent_id} className="opacity-80"/>
                <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate text-[15px] font-semibold leading-tight">
                            {request.agent_id}
                        </p>
                        <span className="inline-flex shrink-0 items-center rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-700 ring-1 ring-amber-500/20 dark:text-amber-300">
                            Pending approval
                        </span>
                    </div>
                    {request.created_at && (
                        <p className="mt-1 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                            <Icon icon={Calendar} className="size-3.5"/>
                            Requested {formatRelativeShort(request.created_at)}
                        </p>
                    )}
                </div>
            </div>
            <div className="mt-4 flex items-center gap-2">
                <Button size="sm" variant="outline" className="flex-1" onClick={onReject} disabled={isBusy}>
                    <Icon icon={Reject} className="size-4"/>
                    Reject
                </Button>
                <Button size="sm" className="flex-1" onClick={onApprove} disabled={isBusy}>
                    <Icon icon={Check} className="size-4"/>
                    Approve
                </Button>
            </div>
        </div>
    );
}
