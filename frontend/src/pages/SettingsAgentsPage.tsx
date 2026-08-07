import {useEffect, useMemo, useRef} from "react";
import {useMutation, useQuery, useQueryClient} from "@tanstack/react-query";
import {Link, useNavigate} from "react-router-dom";
import {Icon} from "@/components/Icon";
import {
    Robot02Icon as Bot,
    Calendar03Icon as Calendar,
    UserAdd01Icon as AddAgent,
    Tick01Icon as Check,
    Cancel01Icon as Reject,
} from "@hugeicons/core-free-icons";
import {AgentFaceAvatar} from "@/components/AgentFaceAvatar";
import {agentDisplay} from "@/lib/agentDisplay";
import {PageHeader} from "@/components/PageHeader";
import {Button} from "@/components/ui/button";
import {openCreate} from "@/components/command/createStore";
import {useAuth} from "@/context/AuthContext";
import {
    approveAgentSignupRequest,
    getAgentProfile,
    getAgents,
    listOrgSignupRequests,
    rejectAgentSignupRequest,
    type AgentSignupRequest,
    type AgentUser,
} from "@/lib/api";
import {queryKeys} from "@/lib/queryKeys";
import {useAgentPresence, useAgentStatus} from "@/hooks/useAgentPresence";
import {formatRelativeShort} from "@/lib/formatting";
import {errMsg, toast} from "@/lib/toast";
import {cn} from "@/lib/utils";
import {morphAgentCardNavigation, waitForElement} from "@/lib/viewTransition";
import {AddAgentCard, AgentCollectibleCard} from "@/components/agent-card";

// Resting tilts for the binder — a small deterministic set so each card sits at
// a slightly different angle (like cards slipped into a collector's binder).
const TILTS = ["-rotate-3", "-rotate-1", "rotate-2", "rotate-3", "-rotate-2", "rotate-1"];
function tiltFor(id: string): string {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h + id.charCodeAt(i)) % TILTS.length;
    return TILTS[h] ?? "";
}

export default function SettingsAgentsPage() {
    const {activeOrgId} = useAuth();
    const queryClient = useQueryClient();

    const agentsQuery = useQuery({
        queryKey: activeOrgId ? queryKeys.agents(activeOrgId) : ["agents", "none"],
        queryFn: () => getAgents(activeOrgId ?? ""),
        enabled: Boolean(activeOrgId),
    });

    const pendingQuery = useQuery({
        queryKey: activeOrgId ? queryKeys.orgSignupRequests(activeOrgId) : ["signup-requests", "none"],
        queryFn: () => listOrgSignupRequests(activeOrgId ?? ""),
        enabled: Boolean(activeOrgId),
    });

    // Show the viewer's OWN agents (those they operate) first, then the rest;
    // within each group, newest first (agents missing a creation_time sink to
    // the end).
    const agents = useMemo(() => {
        const list = agentsQuery.data?.agents ?? [];
        return [...list].sort(
            (a, b) =>
                Number(b.is_operator ?? false) - Number(a.is_operator ?? false) ||
                (b.creation_time ?? "").localeCompare(a.creation_time ?? ""),
        );
    }, [agentsQuery.data]);
    const pending = pendingQuery.data?.requests ?? [];

    // Seed the liveness provider from the list payload so every card's dot has
    // data (SSE keeps it fresh afterwards). Entries without the field are
    // skipped — "no data" must not read as "setup".
    const {seed} = useAgentPresence();
    const agentsData = agentsQuery.data;
    useEffect(() => {
        seed(
            (agentsData?.agents ?? [])
                .filter(a => a.last_alive_at !== undefined)
                .map(a => ({agentId: a.agent_id, lastAliveAt: a.last_alive_at ?? null})),
        );
    }, [agentsData, seed]);

    const approveMutation = useMutation({
        mutationFn: (requestId: string) => approveAgentSignupRequest(activeOrgId ?? "", requestId),
        onSuccess: (req) => {
            if (!activeOrgId) return;
            void queryClient.invalidateQueries({queryKey: queryKeys.agents(activeOrgId)});
            void queryClient.invalidateQueries({queryKey: queryKeys.orgSignupRequests(activeOrgId)});
            void queryClient.invalidateQueries({queryKey: queryKeys.mm.channelsAll});
            toast.success(`Approved ${req.agent_id}`);
        },
        onError: (err: unknown) => { toast.error(errMsg(err, "Failed to approve")); },
    });

    const rejectMutation = useMutation({
        mutationFn: (requestId: string) => rejectAgentSignupRequest(activeOrgId ?? "", requestId),
        onSuccess: (req) => {
            if (!activeOrgId) return;
            void queryClient.invalidateQueries({queryKey: queryKeys.orgSignupRequests(activeOrgId)});
            toast.success(`Rejected ${req.agent_id}`);
        },
        onError: (err: unknown) => { toast.error(errMsg(err, "Failed to reject")); },
    });

    if (!activeOrgId) {
        return <div className="text-sm text-muted-foreground">Select an organization.</div>;
    }

    const isLoading = agentsQuery.isLoading || pendingQuery.isLoading;
    const isError = agentsQuery.isError || pendingQuery.isError;
    const errorMessage =
        (agentsQuery.error instanceof Error && agentsQuery.error.message) ||
        (pendingQuery.error instanceof Error && pendingQuery.error.message) ||
        "Failed to load agents";

    const totalCount = agents.length + pending.length;
    const isBusyApproval = approveMutation.isPending || rejectMutation.isPending;

    return (
        <div className="space-y-8 pb-16">
            <PageHeader breadcrumb={[{label: "All", icon: Bot}]}/>

            {isLoading && (
                <div className="grid grid-cols-1 justify-items-center gap-x-6 gap-y-12 sm:grid-cols-2 lg:grid-cols-3">
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
                    {errorMessage}
                </div>
            )}

            {!isLoading && !isError && totalCount === 0 && (
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
                    <Button size="sm" className="mt-1" onClick={() => { openCreate("agent"); }}>
                        <Icon icon={AddAgent} className="size-4"/>
                        New agent
                    </Button>
                </div>
            )}

            {/* Pending signup requests — need action, so they sit above the binder. */}
            {pending.length > 0 && (
                <section className="space-y-3">
                    <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
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

            {/* The binder — every agent as a slightly-tilted collectible card,
                three-up on desktop. `isolate` keeps a hovered card's z-index
                scoped to the grid so it can't paint over the page header. */}
            {agents.length > 0 && (
                <div className="isolate grid grid-cols-1 justify-items-center gap-x-6 gap-y-12 pt-2 sm:grid-cols-2 lg:grid-cols-3">
                    {agents.map(agent => (
                        <BinderCard key={`a:${agent.agent_id}`} agent={agent}/>
                    ))}
                    <AddAgentBinderCard/>
                </div>
            )}
        </div>
    );
}

/** The "Add new agent" CTA — a sibling collectible card that closes the binder;
 *  clicking it opens the create-agent dialog. Mirrors BinderCard's resting tilt
 *  + hover lift so it sits in the grid like every other card. */
function AddAgentBinderCard() {
    return (
        <button
            type="button"
            onClick={() => { openCreate("agent"); }}
            aria-label="Add new agent"
            className={cn(
                "group relative block w-full max-w-[360px] cursor-pointer outline-none transition-transform duration-300 ease-out will-change-transform hover:z-10 focus-visible:z-10 focus-visible:-translate-y-1 focus-visible:scale-[1.02]",
                tiltFor("add-new-agent"),
            )}
        >
            <div className="w-full">
                <AddAgentCard size="lg"/>
            </div>
        </button>
    );
}

function BinderCard({agent}: {agent: AgentUser}) {
    const name = agentDisplay(agent);
    const to = `/agents/${encodeURIComponent(agent.agent_id)}`;
    const navigate = useNavigate();
    const {activeOrgId} = useAuth();
    const queryClient = useQueryClient();
    const cardRef = useRef<HTMLDivElement>(null);
    // Live dot; the list snapshot bridges the pre-seed frame.
    const status = useAgentStatus(agent.agent_id, agent.last_alive_at);

    // Warm the agent-profile cache on hover/focus so a click usually lands on the
    // real card (not the loading skeleton) — letting the hero morph glide the
    // clicked card straight into its full self instead of into a placeholder.
    const prefetchProfile = () => {
        if (!activeOrgId) return;
        void queryClient.prefetchQuery({
            queryKey: queryKeys.agentProfile(activeOrgId, agent.agent_id),
            queryFn: () => getAgentProfile(activeOrgId, agent.agent_id),
            staleTime: 30_000,
        });
    };

    // Forward hero morph: grow + glide the clicked card into the centered card
    // on the detail page. The clicked card is the "old" snapshot; the detail card
    // names itself (the `.vt-agent-card` class) as the "new" one.
    const openWithMorph = (e: React.MouseEvent) => {
        // Leave modified / non-primary clicks alone (open-in-new-tab, etc.).
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
            className={cn(
                // Resting binder angle + z-lift; the 3D pointer tilt (below) is the
                // hover flourish. Keyboard focus (no pointer) still gets a visible lift.
                "group relative block w-full max-w-[360px] outline-none transition-transform duration-300 ease-out will-change-transform hover:z-10 focus-visible:z-10 focus-visible:-translate-y-1 focus-visible:scale-[1.02]",
                tiltFor(agent.agent_id),
            )}
        >
            {/* Wrapper (not the card itself) carries the transient morph name so a
                plain ref is enough - the card is `w-full`, so this box == card box.
                `data-agent-card-id` lets the REVERSE morph (detail → grid) find and
                name this exact card as its target. */}
            <div ref={cardRef} data-agent-card-id={agent.agent_id} className="w-full">
                {/* Seed by agent_id (not display name) so the theme survives
                    renames and matches the detail page + sidebar tint. */}
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
                    runsOnReef={Boolean(agent.reef_sandbox_id)}
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
                    {request.created_at != null && request.created_at !== "" && (
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
