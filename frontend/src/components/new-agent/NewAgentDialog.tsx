/**
 * "Add an agent" — a 3-step wizard: Runtime → Connect → Launch.
 *
 * The SummaryRail doubles as the stepper (chips of past choices, click to
 * revisit). This shell owns every query; the steps stay presentational. The
 * agent enrols itself with the one-time signup token carried by the prompt,
 * so the finale just watches for it to join.
 */
import {useEffect, useMemo, useState} from "react";
import {useNavigate} from "react-router-dom";
import {useMutation, useQuery, useQueryClient} from "@tanstack/react-query";
import {useSelector} from "@tanstack/react-store";
import {Cancel01Icon as Close, MinusSignIcon as Minimize} from "@hugeicons/core-free-icons";
import {Dialog, DialogContent, DialogTitle} from "@/components/ui/dialog";
import {Button} from "@/components/ui/button";
import {Icon} from "@/components/Icon";
import {useAuth} from "@/context/AuthContext";
import {useIsMobile} from "@/hooks/use-mobile";
import {
    getOrgs, startHumanAgentSignup, getAgents,
    createOrGetMmDirect, createMmChannelPost,
    type AgentUser, type MmChannel, type Org,
} from "@/lib/api";
import {queryKeys} from "@/lib/queryKeys";
import {agentLivenessStatus} from "@/lib/agentLiveness";
import {confirm} from "@/lib/confirm";
import {toast} from "@/lib/toast";
import {useWizard, STEPS, agentLabel, STEP_TITLES, type Runtime, type StepId} from "./useWizard";
import {SummaryRail} from "./SummaryRail";
import {AnimatedHeight} from "./AnimatedHeight";
import {RuntimeStep} from "./RuntimeStep";
import {ConnectStep} from "./ConnectStep";
import {LaunchStep, type TimelinePhase} from "./LaunchStep";
import {
    buildHermesSetupPrompt, buildIronClawSetupPrompt, buildOpenClawSetupPrompt,
} from "./prompts";
import {
    closeWizard, GUARD_COPY, minimizeOrCloseWizard, minimizeWizard, pinWizardOrg, publishWizardMeta,
    wizardSessionAtom, type WizardChipSummary, type WizardDismissGuard,
} from "./wizardSessionStore";

/** The onboarding prompt each runtime gets on the Connect step. */
const PROMPTS: Record<Runtime, (org: Org | null, signupToken: string) => string> = {
    openclaw: buildOpenClawSetupPrompt,
    ironclaw: buildIronClawSetupPrompt,
    hermes: buildHermesSetupPrompt,
};

export function NewAgentDialog() {
    const {activeOrgId} = useAuth();
    const isMobile = useIsMobile();
    const session = useSelector(wizardSessionAtom);
    const active = session.phase !== "closed";
    // The session pins the org it started under — an org switch while
    // minimized must not re-target the signup token / queries mid-flight.
    // The live org only seeds the pin on the session's first render.
    const orgId = session.orgId ?? activeOrgId;
    useEffect(() => {
        if (active && session.orgId === null && activeOrgId) pinWizardOrg(activeOrgId);
    }, [active, session.orgId, activeOrgId]);
    return (
        <Dialog
            open={session.phase === "open"}
            onOpenChange={(open) => { if (!open) minimizeOrCloseWizard(); }}
        >
            {/* Esc / backdrop MINIMIZE a dirty session (the dock chip at the
                sidebar's foot restores it) and fully close an untouched one;
                the corner ✕ is the explicit "end it now" - it skips the chip
                entirely (guard-confirmed while a create is in flight or the
                one-time password is unsaved). Height is content-driven and
                animates per step. */}
            {/* Slightly more opaque than the shared dialog surface — the wizard
                sits over the busy card gallery. p-0 so the header's bottom
                border runs edge to edge (the body carries its own padding). */}
            <DialogContent
                showCloseButton={false}
                // Constant, not phase-derived: flipping keepMounted while the
                // exit animation runs strands Base UI mid-transition (stuck
                // backdrop). Closed = the designed hidden end-state; the tree
                // below is just the header placeholder when no session runs.
                keepMounted
                className="max-h-[calc(100dvh-3rem)] gap-0 overflow-y-auto bg-popover/95 p-0 supports-[backdrop-filter]:bg-popover/90 sm:max-w-2xl"
            >
                {/* The body is mounted per SESSION, not per open: keepMounted
                    keeps this subtree alive (hidden) while minimized so every
                    query, the booting poll, and the create result's one-time
                    password survive; sessionId keys a fresh session to a
                    fresh mount so state still resets cleanly between runs. */}
                {active ? (
                    <WizardBody
                        key={session.sessionId}
                        orgId={orgId}
                        visible={session.phase === "open"}
                    />
                ) : (
                    <WizardHeader/>
                )}
                {/* Ghost window controls in the slot the suppressed shared
                    close button vacates (see ui/dialog.tsx): minimize-to-chip
                    (desktop only - the mobile shell has no dock for the chip)
                    and the explicit close. */}
                {active && (
                    <div className="absolute top-4 right-4 flex items-center gap-1">
                        {!isMobile && (
                            <Button
                                variant="ghost"
                                size="icon-sm"
                                onClick={() => { minimizeWizard(); }}
                                className="text-muted-foreground hover:bg-muted hover:text-foreground"
                            >
                                <Icon icon={Minimize}/>
                                <span className="sr-only">Minimize</span>
                            </Button>
                        )}
                        <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => {
                                void (async () => {
                                    if (session.guard !== null) {
                                        const ok = await confirm({
                                            ...GUARD_COPY[session.guard],
                                            confirmLabel: "Discard",
                                            destructive: true,
                                        });
                                        if (!ok) return;
                                    }
                                    closeWizard();
                                })();
                            }}
                            className="text-muted-foreground hover:bg-muted hover:text-foreground"
                        >
                            <Icon icon={Close}/>
                            <span className="sr-only">Close and discard the agent setup</span>
                        </Button>
                    </div>
                )}
            </DialogContent>
        </Dialog>
    );
}

/** The modal's header: the page-header type treatment, centered, no icon and
 *  no separator — the rail below anchors the rhythm. */
function WizardHeader() {
    return (
        <div className="flex shrink-0 items-center justify-center px-3 pt-4">
            <DialogTitle className="font-sans text-sm font-semibold tracking-tight">
                Add agent
            </DialogTitle>
        </div>
    );
}

function WizardBody({
    orgId,
    visible,
}: {
    orgId: string | null;
    /** False while the session is minimized (the subtree is display:none) —
     *  gates work that must not run against a hidden layout (confetti). */
    visible: boolean;
}) {
    const queryClient = useQueryClient();
    const navigate = useNavigate();
    const targetOrgId = orgId;
    const [state, dispatch] = useWizard();

    // ── Org ──
    const orgsQuery = useQuery({queryKey: queryKeys.orgs, queryFn: () => getOrgs()});
    const targetOrg = orgsQuery.data?.organizations.find(o => o.org_id === targetOrgId) ?? null;

    // ── Watch for agents joining while the dialog is open ──
    const agentsQuery = useQuery({
        queryKey: targetOrgId ? queryKeys.agents(targetOrgId) : ["agents", "none"],
        queryFn: () => getAgents(targetOrgId ?? ""),
        enabled: Boolean(targetOrgId),
        refetchInterval: 2500,
        // The user tabs away exactly while waiting for the agent to boot; the
        // Launch step must keep hydrating (refetchOnWindowFocus is globally
        // off, so a paused interval would freeze the finale forever).
        refetchIntervalInBackground: true,
    });
    const allAgents = agentsQuery.data?.agents;
    const [baseline, setBaseline] = useState<Set<string> | null>(null);
    if (baseline === null && agentsQuery.isSuccess) {
        // Guarded setState-in-render — React's "adjust state on data" idiom.
        setBaseline(new Set((allAgents ?? []).map(a => a.agent_id)));
    }
    const joined: AgentUser[] = useMemo(
        () => (baseline === null ? [] : (allAgents ?? []).filter(a => !baseline.has(a.agent_id))),
        [baseline, allAgents],
    );

    // ── Signup session + prompt ──
    const signupSessionQuery = useQuery({
        queryKey: ["agent-signup-session", targetOrgId],
        queryFn: () => startHumanAgentSignup(targetOrgId ?? ""),
        enabled: Boolean(targetOrgId),
    });
    const signupToken = signupSessionQuery.data?.session_token ?? "(loading)";
    // One onboarding prompt per runtime; an unpicked runtime falls back to OpenClaw
    // (the Connect step only renders once a runtime is chosen).
    const prompt = PROMPTS[state.runtime ?? "openclaw"](targetOrg, signupToken);
    const [promptCopied, setPromptCopied] = useState(false);
    const copyPrompt = () => {
        void navigator.clipboard.writeText(prompt);
        setPromptCopied(true);
        toast.success("Prompt copied");
    };

    // ── Say hi ──
    const sayHiMutation = useMutation({
        mutationFn: async (agentId: string) => {
            const channel = await createOrGetMmDirect(targetOrgId ?? "", "agent", agentId);
            await createMmChannelPost(channel.channel_id, "Hi! 👋");
            return channel;
        },
        onSuccess: (channel: MmChannel, agentId: string) => {
            // Navigating to the chat doesn't END the session — the ready chip
            // stays docked so the access code is one click away until the
            // owner dismisses it.
            minimizeWizard();
            void queryClient.invalidateQueries({queryKey: queryKeys.mm.channelsAll});
            // sayHiAgentId: the channel page seeds the same optimistic
            // "generating" presence the composer's send path does. Without it
            // the very first reply shows no shimmer: this send happens BEFORE
            // the channel page exists, so the page's SSE usually connects just
            // after the agent's initial "generating" ping was published (the
            // bus is lossy, and the snapshot is taken at subscribe time) — the
            // next signal is the agent's 10s heartbeat, which on a short first
            // turn arrives roughly when the reply does.
            void navigate(`/channels/${channel.channel_id}`, {state: {sayHiAgentId: agentId}});
        },
        onError: (e) => { toast.error(e instanceof Error ? e.message : "Couldn't open the chat"); },
    });

    // ── Hero: the first agent to join while this wizard is open ──
    const hero: AgentUser | null = joined[0] ?? null;
    const others = joined.filter(a => a.agent_id !== hero?.agent_id);
    const heroOnline = hero !== null && agentLivenessStatus(hero.last_alive_at ?? null) === "available";

    // Launch locks the rail (it isn't a step of its own — the frozen chips are
    // the record of what was chosen).
    const frozen = state.launched;

    // ── Launch timeline ──
    // Short, human labels — these surface as the wizard button's waiting text,
    // so they read as "where am I in this" not internal machinery.
    const phases: TimelinePhase[] = useMemo(() => {
        const heroFound = hero !== null;
        return [
            {label: "Prompt copied", state: "done"},
            {label: "Waiting for your agent…", state: heroFound ? "done" : "current"},
            {label: "Almost ready…", state: heroOnline ? "done" : heroFound ? "current" : "pending"},
        ];
    }, [hero, heroOnline]);

    // ── Dock-chip metadata (wizardSessionStore): only the body knows the
    //    wizard's real progress, so it publishes what the minimized chip
    //    shows and how closes behave — dirty routes Esc/backdrop to minimize.
    //    The store value-compares, so the 2.5s poll re-publishing an unchanged
    //    summary is free. ──
    const dirty = state.runtime !== null || state.launched;
    const guard: WizardDismissGuard = null;
    const heroName = hero !== null ? agentLabel(hero) : null;
    const phaseLabel = phases.find(p => p.state === "current")?.label ?? null;
    useEffect(() => {
        const summary: WizardChipSummary =
            heroName !== null && heroOnline
                ? {title: heroName, subtitle: "Ready to chat", status: "ready", progress: null}
                : state.launched
                    ? {title: "Add agent", subtitle: phaseLabel ?? "Working…", status: "working", progress: null}
                    : {
                        title: "Add agent",
                        subtitle: STEP_TITLES[state.step],
                        status: "draft",
                        // Position, not completion: on step 1 of 3 the pie
                        // already shows a sliver — "you're in it", like the
                        // "Step 1 of 3" text it replaced.
                        progress: (STEPS.indexOf(state.step) + 1) / STEPS.length,
                    };
        publishWizardMeta({dirty, guard, summary});
    }, [dirty, guard, state.step, state.launched, heroName, heroOnline, phaseLabel]);

    if (!targetOrgId) {
        return (
            <>
                <WizardHeader/>
                <p className="p-3 text-sm text-muted-foreground">Select an organization first.</p>
            </>
        );
    }

    const goto = (step: StepId) => { dispatch({type: "goto", step}); };

    return (
        <>
            <WizardHeader/>
            {/* The body carries the padding the p-0 dialog gave up. */}
            {/* gap matches the body's p-3 so content sits an equal distance
                below the rail as it does above the dialog's bottom edge. */}
            <div className="flex flex-col gap-3 p-3">
            <SummaryRail state={state} frozen={frozen} onGoto={goto}/>

            {/* Content-driven height, animated between steps (the dialog still
                scrolls before anything could overflow off-screen). */}
            <AnimatedHeight>
            <div
                key={state.step}
                className="flex flex-col animate-in fade-in slide-in-from-right-2 duration-300"
            >
                {state.step === "runtime" && (
                    <RuntimeStep
                        runtime={state.runtime}
                        onPick={(r) => { dispatch({type: "pick-runtime", runtime: r}); }}
                    />
                )}
                {state.step === "connect" && state.runtime !== null && (
                    <ConnectStep
                        runtime={state.runtime}
                        prompt={prompt}
                        ready={Boolean(signupSessionQuery.data) && !signupSessionQuery.isFetching}
                        copied={promptCopied}
                        onCopy={() => {
                            copyPrompt();
                            dispatch({type: "launch"});
                        }}
                    />
                )}
                {state.step === "launch" && (
                    <LaunchStep
                        visible={visible}
                        phases={phases}
                        hero={hero}
                        others={others}
                        onSayHi={(id) => { sayHiMutation.mutate(id); }}
                        sayHiPendingId={sayHiMutation.isPending ? sayHiMutation.variables : null}
                    />
                )}
            </div>
            </AnimatedHeight>
            </div>
        </>
    );
}
