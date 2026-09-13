import {useEffect, useState, type ReactNode} from "react";
import {useQuery} from "@tanstack/react-query";
import {
    Alert02Icon as Alert,
    CheckListIcon as Assigned,
    Clock05Icon as Automation,
    Idea01Icon as Idea,
    LinkSquare02Icon as External,
    AddSquareIcon,
} from "@hugeicons/core-free-icons";
import {Icon} from "@/components/Icon";
import {Button} from "@/components/ui/button";
import {AgentAvatarWithPresence} from "@/components/AgentStatus";
import {ForgeDialog} from "@/components/automations/ForgeDialog";
import {DeleteAutomationDialog} from "@/components/automations/DeleteAutomationDialog";
import {RecipeShelf} from "@/components/automations/RecipeShelf";
import {AttentionRow, AutomationCard} from "@/components/automations/AutomationCard";
import {SectionHeader} from "@/components/automations/SectionHeader";
import {useAutomationMutations} from "@/components/automations/useAutomationMutations";
import {Stagger} from "@/components/agent/manage/Stagger";
import {updateAgentPresence} from "@/hooks/useAgentPresence";
import {useNow} from "@/hooks/useNow";
import {
    getAgents,
    listAgentAutomations,
    listOrgAutomations,
    type Automation as AutomationType,
} from "@/lib/api";
import {
    BLANK_TEMPLATE,
    automationVisualState,
    supportsAutomations,
    type AutomationTemplate,
} from "@/lib/automations";
import {automationsRefetchInterval} from "@/lib/automationsPolling";
import {agentLivenessStatus} from "@/lib/agentLiveness";
import {agentDisplay} from "@/lib/agentDisplay";
import {queryKeys} from "@/lib/queryKeys";

const GRID = "grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3";

export function AutomationsManager({orgId, scopeAgentId, unsupportedReason, renderPageHeader}: {
    orgId: string;
    scopeAgentId?: string;
    unsupportedReason?: string | null;
    renderPageHeader: (actions: ReactNode) => ReactNode;
}) {
    const now = useNow(30_000);

    const [templateToCreate, setTemplateToCreate] = useState<AutomationTemplate | null>(null);
    const [toEdit, setToEdit] = useState<AutomationType | null>(null);
    const [toDelete, setToDelete] = useState<AutomationType | null>(null);

    const automationsQuery = useQuery({
        queryKey: scopeAgentId
            ? queryKeys.automationsForAgent(orgId, scopeAgentId)
            : queryKeys.automations(orgId),
        queryFn: () =>
            scopeAgentId
                ? listAgentAutomations(orgId, scopeAgentId)
                : listOrgAutomations(orgId),
        enabled: Boolean(orgId),
        refetchInterval: automationsRefetchInterval,
    });

    const agentsQuery = useQuery({
        queryKey: queryKeys.agents(orgId),
        queryFn: () => getAgents(orgId),
        enabled: Boolean(orgId),
    });

    const automations = automationsQuery.data?.automations ?? [];
    const agents = agentsQuery.data?.agents;
    const agentById = new Map((agents ?? []).map(a => [a.agent_id, a]));
    const nameFor = (agentId: string) => {
        const agent = agentById.get(agentId);
        return agent ? agentDisplay(agent) : agentId;
    };
    const livenessFor = (agentId: string) =>
        agentLivenessStatus(agentById.get(agentId)?.last_alive_at ?? null, now);

    const createAgents = (agents ?? []).filter(a =>
        a.is_operator
        && (!scopeAgentId || a.agent_id === scopeAgentId)
        && supportsAutomations(a.agent_type),
    );

    useEffect(() => {
        if (agents) updateAgentPresence(agents.map(a => ({agentId: a.agent_id, lastAliveAt: a.last_alive_at ?? null})));
    }, [agents]);

    const mutations = useAutomationMutations(orgId, {
        onDeleted: () => { setToDelete(null); },
    });

    const cardActions = {
        onEdit: (a: AutomationType) => { setToEdit(a); },
        onRunNow: (a: AutomationType) => { mutations.runNow.mutate(a); },
        onToggleEnabled: (a: AutomationType, enabled: boolean) => {
            mutations.toggleEnabled.mutate({a, enabled});
        },
        onDelete: (a: AutomationType) => { setToDelete(a); },
    };
    const card = (a: AutomationType) => (
        <AutomationCard
            key={a.automation_id}
            automation={a}
            agentName={nameFor(a.agent_id)}
            agentAvatarUrl={agentById.get(a.agent_id)?.avatar?.url}
            now={now}
            actions={cardActions}
            scopeAgentId={scopeAgentId}
        />
    );

    // Mirrors count too: a job Clawbits doesn't manage can still be failing every run.
    const attention = automations.filter(a =>
        automationVisualState(a, livenessFor(a.agent_id), nameFor(a.agent_id), now).needsAttention,
    );
    const attentionIds = new Set(attention.map(a => a.automation_id));
    const gallery = automations.filter(a => a.managed_by !== "external" && !attentionIds.has(a.automation_id));
    const externalRest = automations.filter(a => a.managed_by === "external" && !attentionIds.has(a.automation_id));

    const byAgent = new Map<string, AutomationType[]>();
    for (const a of gallery) {
        const list = byAgent.get(a.agent_id);
        if (list) list.push(a);
        else byAgent.set(a.agent_id, [a]);
    }
    const groups = [...byAgent.entries()]
        .map(([agentId, list]) => ({
            agentId,
            list: list.sort((x, y) => {
                const nx = x.reported_state?.nextRunAtMs ?? Number.POSITIVE_INFINITY;
                const ny = y.reported_state?.nextRunAtMs ?? Number.POSITIVE_INFINITY;
                return nx !== ny ? nx - ny : (y.created_at ?? "").localeCompare(x.created_at ?? "");
            }),
        }))
        .sort((x, y) => nameFor(x.agentId).localeCompare(nameFor(y.agentId)));

    const isLoading = automationsQuery.isLoading || agentsQuery.isLoading;
    const isError = automationsQuery.isError;
    const ready = !isLoading && !isError;
    const canCreate = createAgents.length > 0;

    return (
        <div className="space-y-8">
            {renderPageHeader(
                canCreate && (
                    <Button size="sm" onClick={() => { setTemplateToCreate(BLANK_TEMPLATE); }}>
                        <Icon icon={AddSquareIcon} className="size-4"/>
                        New
                    </Button>
                ),
            )}

            {ready && attention.length > 0 && (
                <Stagger delay={0} className="space-y-2">
                    <SectionHeader icon={Alert}>Needs attention</SectionHeader>
                    <div className="space-y-2">
                        {attention.map(a => (
                            <AttentionRow
                                key={a.automation_id}
                                automation={a}
                                agent={agentById.get(a.agent_id) ?? null}
                                now={now}
                                scopeAgentId={scopeAgentId}
                            />
                        ))}
                    </div>
                </Stagger>
            )}

            {isLoading && (
                <div className={GRID}>
                    {Array.from({length: 3}).map((_, i) => (
                        <div key={i} className="h-44 animate-pulse rounded-xl bg-muted"/>
                    ))}
                </div>
            )}

            {isError && (
                <div className="rounded-xl border border-border/50 bg-card p-8 text-center text-sm text-destructive">
                    Couldn't load automations.
                </div>
            )}

            {ready && unsupportedReason && automations.length > 0 && (
                <p className="rounded-xl border border-border/50 bg-card px-4 py-3 text-sm text-muted-foreground">
                    {unsupportedReason} Existing ones will never run and can only be removed.
                </p>
            )}

            {ready && gallery.length > 0 && (
                <div className="space-y-4">
                    <Stagger delay={60}>
                        <SectionHeader icon={Assigned}>Assigned</SectionHeader>
                    </Stagger>
                    {groups.map(({agentId, list}, gi) => (
                        <Stagger key={agentId} delay={Math.min(90 + gi * 60, 270)} className="space-y-3">
                            {!scopeAgentId && (
                                <div className="flex items-center gap-2">
                                    <AgentAvatarWithPresence
                                        agentId={agentId}
                                        name={nameFor(agentId)}
                                        src={agentById.get(agentId)?.avatar?.url}
                                        size={22}
                                        ringClassName="ring-background"
                                    />
                                    <span className="text-sm font-medium text-foreground">
                                        {nameFor(agentId)}
                                    </span>
                                    <span className="text-xs text-muted-foreground tabular-nums">
                                        {list.length}
                                    </span>
                                    {livenessFor(agentId) !== "available" && (
                                        <span className="text-xs text-muted-foreground">
                                            · offline, changes will wait
                                        </span>
                                    )}
                                </div>
                            )}
                            <div className={GRID}>{list.map(card)}</div>
                        </Stagger>
                    ))}
                </div>
            )}

            {ready && externalRest.length > 0 && (
                <Stagger delay={180} className="space-y-3">
                    <SectionHeader icon={External}>Managed elsewhere</SectionHeader>
                    <div className={GRID}>{externalRest.map(card)}</div>
                </Stagger>
            )}

            {ready && !canCreate && automations.length === 0 && (
                unsupportedReason ? (
                    <EmptyState title="Automations unavailable" body={unsupportedReason} />
                ) : (
                    <EmptyState
                        title="No agents to automate yet"
                        body="Create an agent you operate, then schedule automations for it here."
                    />
                )
            )}

            {ready && canCreate && (
                <Stagger delay={automations.length === 0 ? 0 : 240} className="space-y-3">
                    <SectionHeader icon={Idea}>Suggested</SectionHeader>
                    <RecipeShelf
                        automations={automations}
                        onPick={(t) => { setTemplateToCreate(t); }}
                    />
                    {automations.length === 0 && (
                        <EmptyState
                            title="Nothing scheduled yet"
                            body="Pick a recipe above or start from scratch. It runs in the agent's runtime and posts back where you choose."
                        />
                    )}
                </Stagger>
            )}

            <ForgeDialog
                template={templateToCreate}
                editing={toEdit}
                agents={createAgents}
                onOpenChange={(open) => { if (!open) { setTemplateToCreate(null); setToEdit(null); } }}
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

function EmptyState({title, body}: {title: string; body: string}) {
    return (
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border bg-card px-6 py-16 text-center">
            <div className="flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
                <Icon icon={Automation} className="size-6"/>
            </div>
            <div className="space-y-1">
                <p className="text-sm font-medium">{title}</p>
                <p className="mx-auto max-w-sm text-xs text-muted-foreground">{body}</p>
            </div>
        </div>
    );
}
