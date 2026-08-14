import { useEffect, useState, type CSSProperties } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
    Add01Icon as Plus,
    ArrowDown01Icon as ArrowDown,
    BubbleChatIcon,
    Clock05Icon,
    IdIcon,
    Mail01Icon,
    PencilEdit02Icon,
    Settings02Icon,
} from "@hugeicons/core-free-icons";
import { Icon } from "@/components/Icon";
import { useAuth } from "@/context/AuthContext";
import {
    createOrGetMmDirect,
    getAgentInboxCount,
    getAgents,
    listAgentAutomations,
    type AgentUser,
} from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import { useAgentPresence, useAgentStatus } from "@/hooks/useAgentPresence";
import { agentStatusLabel } from "@/lib/agentLiveness";
import { agentDisplay } from "@/lib/agentDisplay";
import { errMsg, toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { AgentFaceAvatar } from "@/components/AgentFaceAvatar";
import { PresenceDot } from "@/components/PresenceDot";
import { RenameAgentDialog } from "@/components/RenameAgentDialog";
import { Skeleton } from "@/components/ui/skeleton";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { openCreate } from "@/components/command/createStore";
import { supportsAutomations } from "@/lib/automations";
import { CollapsibleGroup } from "./CollapsibleGroup";
import { ContextualHeader } from "./ContextualHeader";
import { SidebarNavItem } from "./SidebarNavItem";

/**
 * The Agents contextual sidebar — a ROSTER of every agent in the org (avatar +
 * live presence dot + unread-inbox badge), always present, replacing the old
 * one-agent nav + empty state. The roster row itself is the agent's "Card"
 * link; the SELECTED agent expands in place (the shared `.disclosure` motion)
 * to reveal its operator sections — Inbox (with its unread count), Automations,
 * Manage. Selection ⇢ expansion: exactly one agent is ever open, and switching
 * agents glides the tree from one row to the next.
 *
 * Rows carry a right-click menu (open / chat / sections / rename). Operated
 * rows show a rotating chevron as the expand affordance; the nested sections
 * hang off lightweight tree guide lines.
 */
export function AgentsSidebar() {
    const { pathname } = useLocation();
    const match = /^\/agents\/([^/]+)/.exec(pathname);
    const selectedId = match?.[1] ? decodeURIComponent(match[1]) : null;
    const { activeOrgId } = useAuth();
    const [renameTarget, setRenameTarget] = useState<AgentUser | null>(null);

    const agentsQuery = useQuery({
        queryKey: activeOrgId ? queryKeys.agents(activeOrgId) : ["agents", "none"],
        queryFn: () => getAgents(activeOrgId ?? ""),
        enabled: Boolean(activeOrgId),
    });

    // Seed the liveness provider from the list payload so every row's dot has
    // data (SSE + the 30s clock keep it fresh afterwards). Entries without the
    // field are skipped — "no data" must not read as "setup".
    const { seed } = useAgentPresence();
    const agentsData = agentsQuery.data;
    useEffect(() => {
        seed(
            (agentsData?.agents ?? [])
                .filter(a => a.last_alive_at !== undefined)
                .map(a => ({ agentId: a.agent_id, lastAliveAt: a.last_alive_at ?? null })),
        );
    }, [agentsData, seed]);

    const agents = agentsData?.agents ?? [];
    // Newest agents first within each group (missing creation_time sinks to the end).
    const byNewest = (a: AgentUser, b: AgentUser) =>
        (b.creation_time ?? "").localeCompare(a.creation_time ?? "");
    const yours = agents.filter(a => a.is_operator).sort(byNewest);
    const others = agents.filter(a => !a.is_operator).sort(byNewest);
    const bothGroups = yours.length > 0 && others.length > 0;

    return (
        <>
            <ContextualHeader title="Agents" action={<AddAgentButton />} />
            {/* Same scroll-region metrics as the Chats sidebar (p-1 + header
                clearance); groups reuse the shared CollapsibleGroup header. */}
            <div data-vt-contextual="" className="no-scrollbar flex-1 overflow-y-auto p-1 pt-13">
                {agentsQuery.isLoading ? (
                    <RosterSkeleton />
                ) : agents.length === 0 ? (
                    <RosterEmpty />
                ) : bothGroups ? (
                    <>
                        <CollapsibleGroup id="agents-yours" label="Your agents">
                            {yours.map(agent => (
                                <RosterRow
                                    key={agent.agent_id}
                                    agent={agent}
                                    orgId={activeOrgId ?? ""}
                                    selected={agent.agent_id === selectedId}
                                    pathname={pathname}
                                    onRename={() => { setRenameTarget(agent); }}
                                />
                            ))}
                        </CollapsibleGroup>
                        <CollapsibleGroup id="agents-org" label="Org agents">
                            {others.map(agent => (
                                <RosterRow
                                    key={agent.agent_id}
                                    agent={agent}
                                    orgId={activeOrgId ?? ""}
                                    selected={agent.agent_id === selectedId}
                                    pathname={pathname}
                                    onRename={null}
                                />
                            ))}
                        </CollapsibleGroup>
                    </>
                ) : (
                    <SidebarMenu>
                        {[...yours, ...others].map(agent => (
                            <RosterRow
                                key={agent.agent_id}
                                agent={agent}
                                orgId={activeOrgId ?? ""}
                                selected={agent.agent_id === selectedId}
                                pathname={pathname}
                                onRename={agent.is_operator ? () => { setRenameTarget(agent); } : null}
                            />
                        ))}
                    </SidebarMenu>
                )}
            </div>
            <RenameAgentDialog
                agent={renameTarget ? { agent_id: renameTarget.agent_id, nickname: renameTarget.nickname } : null}
                onOpenChange={(open) => { if (!open) setRenameTarget(null); }}
            />
        </>
    );
}

function AddAgentButton() {
    return (
        <button
            type="button"
            onClick={() => { openCreate("agent"); }}
            title="New agent"
            aria-label="New agent"
            className="relative flex size-6 items-center justify-center rounded-md bg-primary text-primary-foreground transition duration-100 after:absolute after:-inset-2 hover:bg-primary/90 active:scale-90"
        >
            <Icon icon={Plus} className="size-4" />
        </button>
    );
}

function RosterSkeleton() {
    return (
        <div className="flex flex-col gap-0.5">
            {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex h-11 items-center gap-2 rounded-lg px-2.5">
                    <Skeleton className="size-[26px] rounded-md" />
                    <Skeleton className="h-3 rounded" style={{ width: `${String(88 - (i % 3) * 16)}px` }} />
                </div>
            ))}
        </div>
    );
}

function RosterEmpty() {
    return (
        <div className="flex h-full flex-col items-center justify-center gap-3 px-6 pb-8 text-center">
            <div className="space-y-1">
                <p className="text-sm font-medium text-sidebar-foreground">No agents yet</p>
                <p className="mx-auto max-w-[15rem] text-xs leading-relaxed text-muted-foreground">
                    Agents you add will line up here.
                </p>
            </div>
            <button
                type="button"
                onClick={() => { openCreate("agent"); }}
                className="rounded-full border border-border/70 bg-card px-3.5 py-1.5 text-xs font-medium text-foreground shadow-xs transition hover:border-border hover:bg-muted/30 active:scale-[0.97]"
            >
                New agent
            </button>
        </div>
    );
}

function RosterRow({
    agent,
    orgId,
    selected,
    pathname,
    onRename,
}: {
    agent: AgentUser;
    orgId: string;
    selected: boolean;
    pathname: string;
    /** Present only when the viewer may rename (operator). */
    onRename: (() => void) | null;
}) {
    const navigate = useNavigate();
    const isOperator = Boolean(agent.is_operator);
    const name = agentDisplay(agent);
    const base = `/agents/${encodeURIComponent(agent.agent_id)}`;
    const rest = pathname.startsWith(base) ? pathname.slice(base.length) : null;
    const onCard = rest === "" || rest === "/";
    const status = useAgentStatus(agent.agent_id, agent.last_alive_at);

    // Ambient "needs attention": unread inbox count for agents you operate.
    // Polled gently — faster while the agent is open, slower in the background.
    const inboxCountQuery = useQuery({
        queryKey: queryKeys.agentInbox.count(orgId, agent.agent_id),
        queryFn: () => getAgentInboxCount(orgId, agent.agent_id),
        enabled: Boolean(orgId && isOperator),
        refetchInterval: selected ? 30_000 : 120_000,
    });
    const unread = inboxCountQuery.data?.unread ?? 0;

    // Section data is only fetched for the OPEN agent (the tree is rendered for
    // every operated row so collapse/expand can animate, but stays dormant).
    const automationsQuery = useQuery({
        queryKey: queryKeys.automationsForAgent(orgId, agent.agent_id),
        queryFn: () => listAgentAutomations(orgId, agent.agent_id),
        enabled: Boolean(orgId && isOperator && selected),
    });
    const automationCount = automationsQuery.data?.automations.length;
    // Hermes/IronClaw runtimes can't apply Clawbits automations — hide the
    // entry unless stuck rows still exist to clean up (the page then runs in
    // delete-only mode).
    const showAutomations =
        supportsAutomations(agent.agent_type, agent.plugin_version) ||
        (automationCount ?? 0) > 0;

    const openChat = useMutation({
        mutationFn: () => createOrGetMmDirect(orgId, "agent", agent.agent_id),
        onSuccess: (channel) => { void navigate(`/channels/${channel.channel_id}`); },
        onError: (err: unknown) => { toast.error(errMsg(err, "Couldn't open chat")); },
    });

    return (
        <SidebarMenuItem>
            <ContextMenu>
                <ContextMenuTrigger
                    render={
                        <SidebarMenuButton
                            size="lg"
                            render={<Link to={base} viewTransition />}
                            isActive={selected && onCard}
                            tooltip={name}
                            className="h-11 items-center gap-2 rounded-lg px-2.5 text-[12px]"
                        >
                            <span className="relative inline-flex shrink-0">
                                <AgentFaceAvatar size={26} name={name} src={agent.avatar?.url} />
                                <span className="pointer-events-none absolute -bottom-0.5 -right-0.5">
                                    <PresenceDot
                                        status={status}
                                        size={8}
                                        ringClassName="ring-sidebar"
                                        label={agentStatusLabel(status)}
                                    />
                                </span>
                            </span>
                            <span className={cn("min-w-0 flex-1 truncate text-[13px]", selected && "font-semibold")}>
                                {name}
                            </span>
                            {/* Collapsed into the tree's Inbox row while open. */}
                            {unread > 0 && !selected && (
                                <span
                                    className="rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold tabular-nums leading-none text-primary-foreground shadow-sm"
                                    aria-label={`${String(unread)} unread message${unread === 1 ? "" : "s"}`}
                                >
                                    {unread > 99 ? "99+" : unread}
                                </span>
                            )}
                            {/* Expand affordance — passive: the row itself is the
                                target; selection is what expands. Hidden until
                                hover (or while expanded); opacity-only so rows
                                never shift. */}
                            {isOperator && (
                                <span
                                    aria-hidden
                                    className={cn(
                                        "disclosure-chevron inline-flex shrink-0 text-muted-foreground/60 transition-opacity duration-150",
                                        selected ? "opacity-100" : "opacity-0 group-hover/menu-button:opacity-100",
                                    )}
                                    data-open={selected ? "true" : "false"}
                                >
                                    <Icon icon={ArrowDown} />
                                </span>
                            )}
                        </SidebarMenuButton>
                    }
                />
                <ContextMenuContent>
                    <ContextMenuItem onClick={() => { void navigate(base); }}>
                        <Icon icon={IdIcon} className="size-4" />
                        Open card
                    </ContextMenuItem>
                    {Boolean(agent.can_dm) && (
                        <ContextMenuItem
                            disabled={openChat.isPending}
                            onClick={() => { openChat.mutate(); }}
                        >
                            <Icon icon={BubbleChatIcon} className="size-4" />
                            Chat
                        </ContextMenuItem>
                    )}
                    {isOperator && (
                        <>
                            <ContextMenuSeparator />
                            <ContextMenuItem onClick={() => { void navigate(`${base}/inbox`); }}>
                                <Icon icon={Mail01Icon} className="size-4" />
                                Inbox
                            </ContextMenuItem>
                            {showAutomations && (
                                <ContextMenuItem onClick={() => { void navigate(`${base}/automations`); }}>
                                    <Icon icon={Clock05Icon} className="size-4" />
                                    Automations
                                </ContextMenuItem>
                            )}
                            <ContextMenuItem onClick={() => { void navigate(`${base}/manage`); }}>
                                <Icon icon={Settings02Icon} className="size-4" />
                                Manage
                            </ContextMenuItem>
                            {onRename && (
                                <>
                                    <ContextMenuSeparator />
                                    <ContextMenuItem onClick={onRename}>
                                        <Icon icon={PencilEdit02Icon} className="size-4" />
                                        Rename
                                    </ContextMenuItem>
                                </>
                            )}
                        </>
                    )}
                </ContextMenuContent>
            </ContextMenu>

            {/* The section tree — mounted for every operated row (so open/close
                both animate), fetching only while open. Selection == expansion:
                no chevron, no second affordance to learn. */}
            {isOperator && (
                <div className="disclosure" data-open={selected ? "true" : "false"}>
                    <div className="disclosure-inner">
                        {/* Tree guide: a hairline dropping from under the avatar
                            column (px-2.5 + half of the 26px avatar ≈ 22px);
                            sections hang off it. */}
                        <ul className="ml-[22px] flex flex-col gap-0.5 border-l border-sidebar-border py-1.5 pl-2.5 pr-0.5">
                            {Boolean(agent.can_dm) && (
                                <SidebarMenuItem className="disclosure-item" style={{ "--i": 0 } as CSSProperties}>
                                    <SidebarMenuButton
                                        disabled={openChat.isPending}
                                        onClick={() => { openChat.mutate(); }}
                                        tooltip="Chat"
                                    >
                                        <Icon icon={BubbleChatIcon} />
                                        <span className="flex-1 truncate">Chat</span>
                                    </SidebarMenuButton>
                                </SidebarMenuItem>
                            )}
                            <SidebarNavItem
                                id={`inbox-${agent.agent_id}`}
                                icon={Mail01Icon}
                                label="Inbox"
                                to={`${base}/inbox`}
                                isActive={Boolean(rest?.startsWith("/inbox"))}
                                count={unread}
                                className="disclosure-item"
                                style={{ "--i": 1 } as CSSProperties}
                            />
                            {showAutomations && (
                                <SidebarNavItem
                                    id={`automations-${agent.agent_id}`}
                                    icon={Clock05Icon}
                                    label="Automations"
                                    to={`${base}/automations`}
                                    isActive={Boolean(rest?.startsWith("/automations"))}
                                    count={automationCount}
                                    className="disclosure-item"
                                    style={{ "--i": 2 } as CSSProperties}
                                />
                            )}
                            <SidebarNavItem
                                id={`manage-${agent.agent_id}`}
                                icon={Settings02Icon}
                                label="Manage"
                                to={`${base}/manage`}
                                isActive={Boolean(rest?.startsWith("/manage"))}
                                className="disclosure-item"
                                style={{ "--i": 3 } as CSSProperties}
                            />
                        </ul>
                    </div>
                </div>
            )}
        </SidebarMenuItem>
    );
}
