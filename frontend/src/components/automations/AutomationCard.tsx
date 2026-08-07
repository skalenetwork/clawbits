import {useRef} from "react";
import {useNavigate} from "react-router-dom";
import {
    Clock05Icon as Clock,
    Delete02Icon as Trash,
    MoreHorizontalIcon as More,
    PauseIcon as Pause,
    PencilEdit02Icon as Pencil,
    PlayIcon as Play,
    RepeatIcon as Repeat,
} from "@hugeicons/core-free-icons";
import type {IconSvgElement} from "@hugeicons/react";
import {Icon} from "@/components/Icon";
import {AgentFaceAvatar} from "@/components/AgentFaceAvatar";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {StatusChip, DriftChip, ExternalChip, FailStreakChip} from "@/components/automations/AutomationStatusChips";
import {useAgentStatus} from "@/hooks/useAgentPresence";
import {agentDisplay} from "@/lib/agentDisplay";
import type {AgentUser, Automation} from "@/lib/api";
import {
    ACCENT_BG,
    accentForId,
    automationDetailPath,
    automationVisualState,
    humanizeSchedule,
} from "@/lib/automations";
import {formatRelativeAgo} from "@/lib/formatting";
import {AUTOMATION_VT_NAME, morphHeroNavigation, waitForElement} from "@/lib/viewTransition";
import {cn} from "@/lib/utils";

export interface AutomationCardActions {
    onEdit: (a: Automation) => void;
    onRunNow: (a: Automation) => void;
    onToggleEnabled: (a: Automation, enabled: boolean) => void;
    onDelete: (a: Automation) => void;
}

/**
 * The automation as a tangible object: accent icon well (owner badge on its
 * corner), name, cadence sentence, honest status chip. The whole card morphs
 * into the detail route (view-transition hero); pause/run-now/menu sit
 * bottom-right and surface on hover (always visible on coarse pointers).
 */
export function AutomationCard({automation, agentName, agentAvatarUrl, now, actions, icon, scopeAgentId}: {
    automation: Automation;
    /** Display name of the owning agent (for "will apply when X reconnects"). */
    agentName: string;
    /** Owner's avatar — badged on the icon well's corner. */
    agentAvatarUrl?: string | null;
    /** Shared ticking clock (useNow) so a grid of cards renders one instant. */
    now: number;
    actions: AutomationCardActions;
    /** Tile glyph — defaults to the clock. */
    icon?: IconSvgElement;
    /** Set on the agent's Automations tab: detail opens in the agent context. */
    scopeAgentId?: string;
}) {
    const a = automation;
    const navigate = useNavigate();
    const cardRef = useRef<HTMLDivElement>(null);
    const agentStatus = useAgentStatus(a.agent_id);
    const state = automationVisualState(a, agentStatus, agentName, now);

    const isExternal = state.key === "external";
    const isRemoving = state.key === "removing";
    const spec = a.desired_spec ?? a.reported_spec;
    const cadence = humanizeSchedule(spec);
    const lastRan = formatRelativeAgo(a.reported_state?.lastRunAtMs ?? null);
    const canRunNow = !isExternal && !isRemoving && a.gateway_job_id != null;
    const paused = state.key === "paused";
    const name = a.name ?? "Untitled automation";

    // The card leads with identity (name + cadence); state lives in the chip.
    // The state's one crucial sentence ("will apply when X reconnects",
    // the sync error) surfaces via the card tooltip + the detail page.
    const cardTitle = state.detail ?? undefined;

    const openDetail = () => {
        morphHeroNavigation({
            name: AUTOMATION_VT_NAME,
            navigate: () => { void navigate(automationDetailPath(a, scopeAgentId)); },
            waitForTarget: () => waitForElement(".vt-automation-hero"),
            nameSource: cardRef.current,
        });
    };

    return (
        <div
            ref={cardRef}
            // The tooltip lives on the container: the whole-card overlay
            // button would swallow hover on inner elements' titles.
            title={cardTitle}
            className={cn(
                "group relative flex flex-col rounded-xl border bg-card p-4",
                "transition duration-150 ease-out",
                isExternal
                    ? "border-dashed border-border/60"
                    : "border-border/60 hover:border-border hover:bg-muted/40",
                isRemoving && "pointer-events-none opacity-50",
            )}
        >
            {/* Whole-card click target under the interactive controls. */}
            <button
                type="button"
                aria-label={`Open ${name}`}
                onClick={openDetail}
                className="absolute inset-0 z-0 cursor-pointer rounded-xl outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
            />

            <div className="flex items-start gap-3">
                <span
                    className={cn(
                        "relative flex size-12 shrink-0 items-center justify-center rounded-xl text-white",
                        "transition-[filter,opacity] duration-200",
                        isExternal ? "bg-muted text-muted-foreground" : ACCENT_BG[accentForId(a.automation_id)],
                        paused && "opacity-70 saturate-0",
                    )}
                >
                    <Icon icon={icon ?? Clock} className="size-6"/>
                    {/* Owner badge — reads as a cut-out on the tile corner. */}
                    <AgentFaceAvatar
                        size={18}
                        name={agentName}
                        src={agentAvatarUrl}
                        className="absolute -bottom-1 -right-1 rounded-full ring-2 ring-card"
                    />
                </span>

                <div className="min-w-0 flex-1 self-center">
                    <p className="truncate text-base font-semibold leading-snug tracking-tight text-foreground">{name}</p>
                    <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-caption text-muted-foreground">
                        <Icon icon={Repeat} className="size-3.5 shrink-0 opacity-70"/>
                        <span className="truncate">{cadence}</span>
                    </p>
                </div>

                {isExternal && <ExternalChip className="relative z-10"/>}
            </div>

            {/* Footer: honest state left; actions bottom-right, inline with the
                chip - the "ran …" meta yields to them on hover (always on touch).
                The slot is h-8 so the swap never changes the card's height. */}
            <div className="mt-3 flex h-8 items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-1.5">
                    <StatusChip
                        state={state}
                        labelOverride={a.run_pending && state.key === "active" ? "Run requested…" : null}
                        className="min-w-0"
                    />
                    {state.drifted && !isExternal && <DriftChip/>}
                    {state.failStreak > 1 && <FailStreakChip count={state.failStreak}/>}
                </span>

                <span className="relative flex h-8 shrink-0 items-center">
                    {state.failStreak <= 1 && !state.drifted && lastRan && state.key === "active" && (
                        <span
                            className={cn(
                                "text-[11px] text-muted-foreground/80 transition-opacity duration-150",
                                !isExternal && !isRemoving &&
                                    "group-focus-within:opacity-0 group-hover:opacity-0 pointer-coarse:opacity-0",
                            )}
                        >
                            ran {lastRan}
                        </span>
                    )}
                    {!isExternal && !isRemoving && (
                        <div
                            className={cn(
                                "absolute right-0 z-10 flex items-center gap-1 transition-opacity duration-150",
                                "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100",
                            )}
                        >
                            <DropdownMenu>
                                <DropdownMenuTrigger
                                    aria-label={`Actions for ${name}`}
                                    className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                                >
                                    <Icon icon={More} className="size-4"/>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                    <DropdownMenuItem onClick={() => { actions.onEdit(a); }}>
                                        <Icon icon={Pencil}/> Edit
                                    </DropdownMenuItem>
                                    {canRunNow && (
                                        <DropdownMenuItem
                                            disabled={a.run_pending}
                                            onClick={() => { actions.onRunNow(a); }}
                                        >
                                            <Icon icon={Play}/>
                                            {a.run_pending ? "Run queued…" : "Run now"}
                                        </DropdownMenuItem>
                                    )}
                                    <DropdownMenuItem onClick={() => { actions.onToggleEnabled(a, paused); }}>
                                        <Icon icon={paused ? Play : Pause}/>
                                        {paused ? "Resume" : "Pause"}
                                    </DropdownMenuItem>
                                    <DropdownMenuItem variant="destructive" onClick={() => { actions.onDelete(a); }}>
                                        <Icon icon={Trash}/> Remove
                                    </DropdownMenuItem>
                                </DropdownMenuContent>
                            </DropdownMenu>
                        </div>
                    )}
                </span>
            </div>
        </div>
    );
}

/**
 * Compact full-width row for the needs-attention shelf: what broke, in words,
 * with the object one tap away. Reuses the same visual-state language.
 */
export function AttentionRow({automation, agent, now, scopeAgentId}: {
    automation: Automation;
    agent: AgentUser | null;
    now: number;
    /** Set on the agent's Automations tab: detail opens in the agent context. */
    scopeAgentId?: string;
}) {
    const a = automation;
    const navigate = useNavigate();
    const rowRef = useRef<HTMLDivElement>(null);
    const agentStatus = useAgentStatus(a.agent_id);
    const agentName = agent ? agentDisplay(agent) : a.agent_id;
    const state = automationVisualState(a, agentStatus, agentName, now);
    const name = a.name ?? "Untitled automation";

    const baseReason =
        state.key === "failed"
            ? state.detail ?? "The agent couldn't apply this automation."
            : state.drifted
              ? "Changed outside Clawbits - the desired version re-applies on the next reconcile."
              : state.detail ?? "Waiting for the agent.";
    // The shelf strips rows out of their agent group, so the group header's
    // offline note must travel with them.
    const reason =
        agentStatus !== "available" ? `${baseReason} · agent offline` : baseReason;

    return (
        <div
            ref={rowRef}
            className="group relative flex items-center gap-3 rounded-xl border border-border/60 bg-card px-4 py-3 transition-colors hover:border-border hover:bg-muted/40"
        >
            <button
                type="button"
                aria-label={`Open ${name}`}
                onClick={() => {
                    morphHeroNavigation({
                        name: AUTOMATION_VT_NAME,
                        navigate: () => { void navigate(automationDetailPath(a, scopeAgentId)); },
                        waitForTarget: () => waitForElement(".vt-automation-hero"),
                        nameSource: rowRef.current,
                    });
                }}
                className="absolute inset-0 z-0 cursor-pointer rounded-xl outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
            />
            <span
                aria-hidden
                className={cn(
                    "size-2 shrink-0 rounded-full",
                    state.key === "failed" ? "bg-red-500" : "bg-amber-400",
                )}
            />
            <div className="min-w-0 flex-1">
                <p className="flex min-w-0 items-baseline gap-2">
                    <span className="truncate text-sm font-medium text-foreground">{name}</span>
                    <span className="shrink-0 text-[11px] text-muted-foreground">{agentName}</span>
                </p>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">{reason}</p>
            </div>
            <span className="shrink-0 text-xs font-medium text-muted-foreground transition-colors group-hover:text-foreground">
                {state.key === "failed" ? "Sync failed" : state.drifted ? "Drifted" : "Pending"}
            </span>
        </div>
    );
}
