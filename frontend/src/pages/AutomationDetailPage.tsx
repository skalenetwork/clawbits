import {useState, type ReactNode} from "react";
import {useNavigate, useParams} from "react-router-dom";
import {useQuery} from "@tanstack/react-query";
import {
    ActivityIcon as Activity,
    Alert02Icon as Alert,
    ArrowDataTransferHorizontalIcon as Diff,
    Calendar03Icon as Calendar,
    CheckmarkCircle02Icon as Check,
    Clock05Icon as Clock,
    Delete02Icon as Trash,
    MoreHorizontalIcon as More,
    PencilEdit02Icon as Pencil,
    PlayIcon as Play,
    RefreshIcon as Sync,
    SentIcon as Sent,
} from "@hugeicons/core-free-icons";
import {Icon} from "@/components/Icon";
import {PageHeader} from "@/components/PageHeader";
import {UserAvatar} from "@/components/UserAvatar";
import {AgentFaceAvatar} from "@/components/AgentFaceAvatar";
import {Button} from "@/components/ui/button";
import {Switch} from "@/components/ui/switch";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {AgentAvatarWithPresence} from "@/components/AgentStatus";
import {ForgeDialog} from "@/components/automations/ForgeDialog";
import {DeleteAutomationDialog} from "@/components/automations/DeleteAutomationDialog";
import {RunList, RunStrip} from "@/components/automations/RunHistory";
import {SectionHeader} from "@/components/automations/SectionHeader";
import {StatusChip, DriftChip, ExternalChip, FailStreakChip} from "@/components/automations/AutomationStatusChips";
import {useAutomationMutations} from "@/components/automations/useAutomationMutations";
import {useAuth} from "@/context/AuthContext";
import {useAgentStatus} from "@/hooks/useAgentPresence";
import {useNow} from "@/hooks/useNow";
import {
    getAgents,
    listAgentChannels,
    listAutomationRuns,
    listOrgAutomations,
    type Automation,
} from "@/lib/api";
import {
    ACCENT_BG,
    accentForId,
    automationVisualState,
    humanizeSchedule,
} from "@/lib/automations";
import {automationsRefetchInterval} from "@/lib/automationsPolling";
import {agentDisplay} from "@/lib/agentDisplay";
import {queryKeys} from "@/lib/queryKeys";
import {cn} from "@/lib/utils";

/**
 * One automation, fully inspected. Context-agnostic: the org page and the
 * agent's Automations tab both mount it with their own header (breadcrumbs)
 * and back destination, so opening an automation never switches the user's
 * navigation context.
 */
export function AutomationDetailView({orgId, automationId, backTo, renderHeader}: {
    orgId: string;
    automationId: string | undefined;
    /** Where "back"/post-delete lands — the mount's own automations list. */
    backTo: string;
    /** Render the page header (portals into the shell bar) for this mount. */
    renderHeader: (automationName: string | null) => ReactNode;
}) {
    const navigate = useNavigate();
    const now = useNow(30_000);
    const {user} = useAuth();

    const automationsQuery = useQuery({
        queryKey: queryKeys.automations(orgId),
        queryFn: () => listOrgAutomations(orgId),
        enabled: Boolean(orgId),
        refetchInterval: automationsRefetchInterval,
    });
    const agentsQuery = useQuery({
        queryKey: queryKeys.agents(orgId),
        queryFn: () => getAgents(orgId),
        enabled: Boolean(orgId),
    });

    const automation = automationsQuery.data?.automations.find(
        x => x.automation_id === automationId,
    ) ?? null;
    const agent = agentsQuery.data?.agents.find(x => x.agent_id === automation?.agent_id) ?? null;
    const agentName = agent ? agentDisplay(agent) : automation?.agent_id ?? "the agent";

    const runsQuery = useQuery({
        queryKey: automation
            ? queryKeys.automationRuns(orgId, automation.agent_id, automation.automation_id)
            : ["automation-runs", "none"],
        queryFn: () =>
            listAutomationRuns(orgId, automation?.agent_id ?? "", automation?.automation_id ?? ""),
        enabled: Boolean(orgId) && automation != null,
        refetchInterval: automationsRefetchInterval,
    });
    const channelsQuery = useQuery({
        queryKey: queryKeys.agentChannels(orgId, automation?.agent_id ?? ""),
        queryFn: () => listAgentChannels(orgId, automation?.agent_id ?? ""),
        enabled: Boolean(orgId) && automation != null,
    });

    const [toEdit, setToEdit] = useState<Automation | null>(null);
    const [toDelete, setToDelete] = useState<Automation | null>(null);
    const mutations = useAutomationMutations(orgId, {
        onDeleted: () => { void navigate(backTo); },
    });

    // Fallback keeps presence honest on deep links, where nothing has seeded
    // the presence provider yet.
    const agentStatus = useAgentStatus(automation?.agent_id ?? "", agent?.last_alive_at ?? null);
    const runs = runsQuery.data?.runs ?? [];

    const spec = automation?.desired_spec ?? automation?.reported_spec ?? null;
    const state = automation ? automationVisualState(automation, agentStatus, agentName, now) : null;

    const deliveryTo = (spec?.delivery as {to?: string} | undefined)?.to ?? null;
    const deliveryChannel = channelsQuery.data?.channels.find(c => c.channel_id === deliveryTo) ?? null;
    // "Agent has left" is only a fact once the channels query SUCCEEDED
    // without the target; while loading/errored, stay neutral.
    const deliveryLabel = deliveryTo
        ? deliveryChannel
            ? (deliveryChannel.channel_type === "direct"
                ? deliveryChannel.display_name ?? deliveryChannel.name
                : `#${deliveryChannel.display_name ?? deliveryChannel.name}`)
            : channelsQuery.isSuccess
              ? "a channel the agent has left"
              : "the configured channel"
        : "your direct message with the agent";

    // Only the true default (no explicit target) is YOUR DM; a picked direct
    // channel is the agent's DM with someone and keeps its own name.
    const isOwnerDm = !deliveryTo;
    const isExternal = automation?.managed_by === "external";
    const canRunNow = automation != null && !isExternal && automation.gateway_job_id != null;
    const prompt = (spec?.payload as {message?: string} | undefined)?.message ?? null;
    const specMismatch =
        automation?.reported_spec != null &&
        automation.desired_spec != null &&
        JSON.stringify(automation.desired_spec.schedule) !== JSON.stringify(automation.reported_spec.schedule);

    const header = renderHeader(automation?.name ?? null);

    if (automationsQuery.isLoading) {
        return (
            <div className="space-y-6 pb-16">
                {header}
                <div className="mx-auto w-full max-w-3xl space-y-4">
                    <div className="h-40 animate-pulse rounded-2xl bg-muted"/>
                    <div className="h-24 animate-pulse rounded-xl bg-muted"/>
                </div>
            </div>
        );
    }
    // A failed fetch is not evidence of deletion — say "couldn't load", never
    // the false "gone" state.
    if (automationsQuery.isError) {
        return (
            <div className="space-y-6 pb-16">
                {header}
                <div className="mx-auto flex w-full max-w-3xl flex-col items-center gap-3 rounded-xl border border-border/60 bg-card px-6 py-16 text-center">
                    <p className="text-sm font-medium">Couldn't load this automation</p>
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={() => { void automationsQuery.refetch(); }}
                    >
                        Try again
                    </Button>
                </div>
            </div>
        );
    }
    if (!automation || !state) {
        return (
            <div className="space-y-6 pb-16">
                {header}
                <div className="mx-auto flex w-full max-w-3xl flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-card px-6 py-16 text-center">
                    <p className="text-sm font-medium">This automation is gone</p>
                    <p className="text-xs text-muted-foreground">
                        It may have finished removing, or you may not operate its agent.
                    </p>
                    <Button variant="outline" size="sm" onClick={() => { void navigate(backTo); }}>
                        Back to automations
                    </Button>
                </div>
            </div>
        );
    }

    const a = automation;
    const name = a.name ?? "Untitled automation";
    const paused = state.key === "paused";
    // One visual line for the whole reconcile story; details live in the hero.
    const syncSummary = {
        applied: {
            icon: <Icon icon={Check} className="size-4 text-emerald-600 dark:text-emerald-400"/>,
            label: "Synced",
        },
        requested: {
            icon: <Icon icon={Clock} className="size-4 text-amber-600 dark:text-amber-400"/>,
            label: `Waiting for ${agentName}`,
        },
        failed: {
            icon: <Icon icon={Alert} className="size-4 text-red-600 dark:text-red-400"/>,
            label: "Sync failed",
        },
        removing: {
            icon: <Icon icon={Clock} className="size-4 text-muted-foreground"/>,
            label: "Removing…",
        },
    }[a.sync_status];

    return (
        <div className="space-y-6 pb-16">
            {header}

            {/* space-y-4 matches the facts grid's gap-4, so every card sits
                16px from its neighbors on all sides. */}
            <div className="mx-auto w-full max-w-3xl space-y-4">
                {/* Hero — carries the morph name statically. */}
                <section className="vt-automation-hero rounded-2xl border border-border/60 bg-card p-6">
                    <div className="flex items-start gap-4">
                        <span
                            className={cn(
                                "flex size-14 shrink-0 items-center justify-center rounded-2xl text-white",
                                "transition-[filter,opacity] duration-200",
                                isExternal ? "bg-muted text-muted-foreground" : ACCENT_BG[accentForId(a.automation_id)],
                                paused && "opacity-70 saturate-0",
                            )}
                        >
                            <Icon icon={Clock} className="size-7"/>
                        </span>
                        <div className="min-w-0 flex-1">
                            <div className="flex min-w-0 items-center gap-2">
                                <h2 title={name} className="truncate text-2xl font-bold tracking-tight text-foreground">{name}</h2>
                                {isExternal && <ExternalChip/>}
                            </div>
                            <p title={`${humanizeSchedule(spec)} · ${agentName}`} className="mt-0.5 truncate text-sm text-muted-foreground">
                                {humanizeSchedule(spec)} · {agentName}
                            </p>
                        </div>
                        {canRunNow && state.key !== "removing" && (
                            <Button
                                variant="outline"
                                size="sm"
                                className="shrink-0 self-start"
                                disabled={a.run_pending || mutations.runNow.isPending}
                                onClick={() => { mutations.runNow.mutate(a); }}
                            >
                                <Icon icon={Play} className="size-4"/>
                                {a.run_pending ? "Run queued…" : "Run now"}
                            </Button>
                        )}
                    </div>

                    {/* The prompt — the automation's voice, typeset inside the
                        card, above the state/actions row. */}
                    {prompt && (
                        <p className="mt-5 whitespace-pre-wrap break-words font-serif text-xl leading-relaxed tracking-tight text-foreground">
                            {prompt}
                        </p>
                    )}

                    <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-border/40 pt-4">
                        <span className="flex min-w-0 items-center gap-2">
                            <StatusChip
                                size="lg"
                                state={state}
                                labelOverride={a.run_pending && state.key === "active" ? "Run requested…" : null}
                            />
                            {state.drifted && !isExternal && <DriftChip/>}
                            {state.failStreak > 1 && <FailStreakChip size="lg" count={state.failStreak}/>}
                        </span>
                        {!isExternal && state.key !== "removing" && (
                            <span className="flex shrink-0 items-center gap-2">
                                <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-muted-foreground">
                                    <Switch
                                        size="sm"
                                        checked={a.enabled !== false}
                                        onCheckedChange={(checked) => { mutations.toggleEnabled.mutate({a, enabled: checked}); }}
                                    />
                                    {paused ? "Paused" : "On"}
                                </label>
                                <DropdownMenu>
                                    <DropdownMenuTrigger
                                        aria-label="More actions"
                                        className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                                    >
                                        <Icon icon={More} className="size-4"/>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align="end">
                                        <DropdownMenuItem onClick={() => { setToEdit(a); }}>
                                            <Icon icon={Pencil}/> Edit
                                        </DropdownMenuItem>
                                        <DropdownMenuItem variant="destructive" onClick={() => { setToDelete(a); }}>
                                            <Icon icon={Trash}/> Remove
                                        </DropdownMenuItem>
                                    </DropdownMenuContent>
                                </DropdownMenu>
                            </span>
                        )}
                    </div>

                    {state.key === "failed" && state.detail && (
                        <p className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-xs leading-relaxed text-red-700 dark:text-red-400">
                            {state.detail}
                        </p>
                    )}
                    {state.drifted && !isExternal && (
                        <p className="mt-3 rounded-lg bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-700 dark:text-amber-400">
                            This job changed outside Clawbits. The configuration below is the
                            desired one — it re-applies on {agentName}'s next reconcile.
                        </p>
                    )}
                </section>

                {/* Schedule + delivery + sync facts */}
                <section className="grid gap-4 sm:grid-cols-3">
                    <div className="min-w-0 space-y-2.5 rounded-xl border border-border/60 bg-card p-4">
                        <SectionHeader icon={Calendar}>Schedule</SectionHeader>
                        <p title={humanizeSchedule(spec)} className="truncate text-lg font-bold text-foreground">{humanizeSchedule(spec)}</p>
                    </div>

                    <div className="min-w-0 space-y-2.5 rounded-xl border border-border/60 bg-card p-4">
                        <SectionHeader icon={Sent}>Delivery</SectionHeader>
                        {isExternal && !deliveryTo ? (
                            // The mirror carries no delivery info — never
                            // fabricate the owner-DM default for it.
                            <p className="text-sm text-muted-foreground">Managed outside Clawbits</p>
                        ) : (
                            <button
                                type="button"
                                disabled={!deliveryTo}
                                onClick={() => {
                                    if (deliveryTo) void navigate(`/channels/${encodeURIComponent(deliveryTo)}`);
                                }}
                                className={cn(
                                    "flex w-full min-w-0 items-center gap-2.5 rounded-lg text-left",
                                    deliveryTo && "cursor-pointer transition-colors hover:bg-muted/40",
                                )}
                            >
                                {isOwnerDm ? (
                                    <UserAvatar
                                        size={28}
                                        name={user?.display_name ?? user?.email ?? "You"}
                                        src={user?.avatar?.url}
                                    />
                                ) : deliveryChannel?.channel_type === "direct" ? (
                                    <AgentFaceAvatar size={28} name={agentName} src={agent?.avatar?.url}/>
                                ) : (
                                    <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-sm font-semibold text-muted-foreground">
                                        #
                                    </span>
                                )}
                                <span className="min-w-0">
                                    <span
                                        title={isOwnerDm ? "Your DM" : deliveryLabel.replace(/^#/, "")}
                                        className="block truncate text-lg font-bold text-foreground"
                                    >
                                        {isOwnerDm ? "Your DM" : deliveryLabel.replace(/^#/, "")}
                                    </span>
                                </span>
                            </button>
                        )}
                    </div>

                    <div className="min-w-0 space-y-2.5 rounded-xl border border-border/60 bg-card p-4">
                        <SectionHeader icon={Sync}>Sync</SectionHeader>
                        <p title={syncSummary.label} className="truncate text-lg font-bold text-foreground">{syncSummary.label}</p>
                    </div>
                </section>

                {specMismatch && (
                    <section className="space-y-2">
                        <SectionHeader icon={Diff}>Desired vs live</SectionHeader>
                        <div className="grid gap-3 sm:grid-cols-2">
                            <div className="rounded-xl bg-muted/40 p-3">
                                <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">You asked</p>
                                <pre className="overflow-x-auto font-mono text-[11px] leading-relaxed text-foreground/80">
                                    {JSON.stringify(a.desired_spec?.schedule, null, 2)}
                                </pre>
                            </div>
                            <div className="rounded-xl bg-muted/40 p-3">
                                <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">The agent runs</p>
                                <pre className="overflow-x-auto font-mono text-[11px] leading-relaxed text-foreground/80">
                                    {JSON.stringify(a.reported_spec?.schedule, null, 2)}
                                </pre>
                            </div>
                        </div>
                    </section>
                )}

                {/* Runs — a card like its Schedule/Delivery/Sync siblings. */}
                <section className="space-y-3 rounded-xl border border-border/60 bg-card p-4">
                    <SectionHeader icon={Activity}>Runs</SectionHeader>
                    <RunStrip runs={runs} pendingGhost={a.run_pending}/>
                    <RunList runs={runs} isLoading={runsQuery.isLoading} isError={runsQuery.isError}/>
                </section>

                {/* Owner agent footer */}
                <section className="flex items-center gap-3 rounded-xl border border-border/60 bg-card p-4">
                    <AgentAvatarWithPresence
                        agentId={a.agent_id}
                        name={agentName}
                        src={agent?.avatar?.url}
                        size={36}
                    />
                    <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-foreground">{agentName}</p>
                        <p className="text-xs text-muted-foreground">runs this automation in its own runtime</p>
                    </div>
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => { void navigate(`/agents/${encodeURIComponent(a.agent_id)}/automations`); }}
                    >
                        View agent
                    </Button>
                </section>
            </div>

            <ForgeDialog
                editing={toEdit}
                agents={agent ? [agent] : []}
                onOpenChange={(open) => { if (!open) setToEdit(null); }}
            />
            <DeleteAutomationDialog
                automation={toDelete}
                isPending={mutations.remove.isPending}
                onOpenChange={(open) => { if (!open && !mutations.remove.isPending) setToDelete(null); }}
                onConfirm={() => { if (toDelete) mutations.remove.mutate(toDelete); }}
            />
        </div>
    );
}

/** Org-level mount: `/automations/:automationId`. */
export default function AutomationDetailPage() {
    const {automationId} = useParams<{automationId: string}>();
    const {activeOrgId} = useAuth();
    return (
        <AutomationDetailView
            orgId={activeOrgId ?? ""}
            automationId={automationId}
            backTo="/automations"
            renderHeader={(name) => (
                <PageHeader
                    breadcrumb={[
                        {label: "Automations", to: "/automations", icon: Clock},
                        {label: name ?? "Automation"},
                    ]}
                />
            )}
        />
    );
}
