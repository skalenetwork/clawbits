/**
 * "Add an agent" — a 4-step wizard (docs/protocol/AGENT_SETUP_WIZARD_PLAN.md):
 *
 *   reef:  Where → Runtime → Intelligence → Launch
 *   self:  Where → Runtime → Connect      → Launch
 *
 * The SummaryRail doubles as the stepper (chips of past choices, click to
 * revisit). This shell owns every query + the create mutation; steps stay
 * presentational. Error contract: reef-unreachable / token-rejected mid-wizard
 * surface as a rail-level banner with a one-click jump to step 1 (never a
 * silent branch swap); a failed create unfreezes the rail with Retry + Back.
 */
import {useEffect, useMemo, useRef, useState} from "react";
import {useNavigate} from "react-router-dom";
import {useMutation, useQuery, useQueryClient} from "@tanstack/react-query";
import {useSelector} from "@tanstack/react-store";
import {Alert02Icon as Alert, Cancel01Icon as Close, MinusSignIcon as Minimize} from "@hugeicons/core-free-icons";
import {Dialog, DialogContent, DialogTitle} from "@/components/ui/dialog";
import {Button} from "@/components/ui/button";
import {Icon} from "@/components/Icon";
import {useAuth} from "@/context/AuthContext";
import {useIsMobile} from "@/hooks/use-mobile";
import {
    getOrgs, getReefConnection, startHumanAgentSignup, linkReefVm, getAgents, createOrGetMmDirect,
    createMmChannelPost,
    type AgentUser, type MmChannel, type Org,
} from "@/lib/api";
import {
    reefCreate, reefProviders, reefImages, reefHealth, reefOllamaModels, getReefToken, setReefToken,
    terminalAuthUrl, ReefAuthError, ReefUnreachableError,
    type ReefCreateBody, type ReefProvider, type ReefImage,
} from "@/lib/reefApi";
import {queryKeys} from "@/lib/queryKeys";
import {agentLivenessStatus} from "@/lib/agentLiveness";
import {cn} from "@/lib/utils";
import {confirm} from "@/lib/confirm";
import {toast} from "@/lib/toast";
import {useWizard, stepsFor, agentLabel, STEP_TITLES, type Mode, type Runtime, type StepId} from "./useWizard";
import {SummaryRail} from "./SummaryRail";
import {AnimatedHeight} from "./AnimatedHeight";
import {DeployStep} from "./DeployStep";
import {RuntimeStep} from "./RuntimeStep";
import {ModelStep} from "./ModelStep";
import {OptionsStep} from "./OptionsStep";
import {ConnectStep} from "./ConnectStep";
import {LaunchStep, type TimelinePhase} from "./LaunchStep";
import {
    buildHermesSetupPrompt, buildIronClawSetupPrompt, buildOpenClawSetupPrompt, deriveClawbitsUrl,
} from "./prompts";
import {
    closeWizard, GUARD_COPY, minimizeOrCloseWizard, minimizeWizard, pinWizardOrg, publishWizardMeta,
    wizardSessionAtom, type WizardChipSummary, type WizardDismissGuard,
} from "./wizardSessionStore";

/** linkReefVm is best-effort — after this long with no attributed agent, the
 *  first joined agent is accepted as the hero (plan §2.2). */
const HERO_ATTRIBUTION_TIMEOUT_MS = 30_000;

/** The self-host onboarding prompt each runtime gets on the Connect step. */
const SELF_PROMPTS: Record<Runtime, (org: Org | null, signupToken: string) => string> = {
    openclaw: buildOpenClawSetupPrompt,
    ironclaw: buildIronClawSetupPrompt,
    hermes: buildHermesSetupPrompt,
};

/** ChatGPT-subscription (oauth) login, run by the owner in the agent's web terminal.
 *  Device-code in both cases — no browser is needed inside the VM. IronClaw doesn't
 *  offer the provider (see reef/providers.py), so its entry is never reached. */
const CODEX_LOGIN_COMMAND: Record<Runtime, string> = {
    openclaw: "openclaw models auth login --provider openai --device-code",
    hermes: "hermes login --provider openai-codex --no-browser",
    ironclaw: "openclaw models auth login --provider openai --device-code",
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
                        onClose={closeWizard}
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
    onClose,
}: {
    orgId: string | null;
    /** False while the session is minimized (the subtree is display:none) —
     *  gates work that must not run against a hidden layout (confetti). */
    visible: boolean;
    /** Fully ends the session (dock chip and all) — the in-wizard leave
     *  paths; a plain visual close routes through minimizeOrCloseWizard. */
    onClose: () => void;
}) {
    const queryClient = useQueryClient();
    const navigate = useNavigate();
    const targetOrgId = orgId;
    const [state, dispatch] = useWizard();

    // ── Org + Reef connection + health ──
    const orgsQuery = useQuery({queryKey: queryKeys.orgs, queryFn: () => getOrgs()});
    const targetOrg = orgsQuery.data?.organizations.find(o => o.org_id === targetOrgId) ?? null;
    const connQuery = useQuery({
        queryKey: targetOrgId ? queryKeys.reefConnection(targetOrgId) : ["org", "none", "reef-connection"],
        queryFn: () => getReefConnection(targetOrgId ?? ""),
        enabled: Boolean(targetOrgId),
    });
    const reefUrl = connQuery.data?.api_url ?? null;
    const healthQuery = useQuery({
        queryKey: queryKeys.reefHealth(targetOrgId ?? ""),
        queryFn: () => reefHealth(reefUrl ?? ""),
        enabled: Boolean(reefUrl),
        retry: false,
        refetchInterval: 30_000,
        // Must keep self-healing while the tab is hidden — an errored health
        // probe would otherwise pin the Reef card disabled (and the rail
        // banner up) until the user happens to refocus.
        refetchIntervalInBackground: true,
    });
    const reefConnected = Boolean(reefUrl) && healthQuery.isSuccess;
    const checkingReef = Boolean(reefUrl) && !healthQuery.isSuccess && !healthQuery.isError;

    // ── Reef admin token (session-held) + the /providers probe as validator ──
    const [reefTokenInput, setReefTokenInput] = useState(getReefToken() ?? "");
    const [tokenPrefilled] = useState(() => (getReefToken() ?? "").trim().length > 0);
    const [debouncedToken, setDebouncedToken] = useState(reefTokenInput.trim());
    useEffect(() => {
        const t = setTimeout(() => { setDebouncedToken(reefTokenInput.trim()); }, 400);
        return () => { clearTimeout(t); };
    }, [reefTokenInput]);
    const providersQuery = useQuery({
        queryKey: [...queryKeys.reefProviders(targetOrgId ?? "none"), debouncedToken],
        queryFn: () => {
            setReefToken(debouncedToken); // share with the fleet page, as create does
            return reefProviders(reefUrl ?? "");
        },
        enabled: Boolean(reefUrl) && debouncedToken.length > 0,
        retry: false,
        staleTime: 60_000,
    });
    const providerList: ReefProvider[] | null = providersQuery.data?.providers ?? null;
    const features = providersQuery.data?.features ?? [];
    const envSupported = features.includes("env");
    const modelSupported = features.includes("model");
    // Older reefs drop unknown create fields silently, which would hand back an
    // agent less capable than the wizard just claimed — so hide, do not guess.
    const capabilitiesSupported = features.includes("capabilities");
    const tokenRejected = providersQuery.error instanceof ReefAuthError;
    const reefUnreachable = providersQuery.error instanceof ReefUnreachableError;
    // LOCKED: no legacy-reef degraded modes — anything else is "update your Reef".
    const reefTooOld = providersQuery.isError && !tokenRejected && !reefUnreachable;
    const providersReady = providerList !== null;

    const imagesQuery = useQuery({
        queryKey: ["org", targetOrgId ?? "none", "reef-images", debouncedToken],
        queryFn: () => reefImages(reefUrl ?? ""),
        enabled: Boolean(reefUrl) && debouncedToken.length > 0,
        retry: false,
        staleTime: 60_000,
    });
    const images: ReefImage[] | null = imagesQuery.data ?? null;

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

    // ── Self-host signup session + prompt ──
    const signupSessionQuery = useQuery({
        queryKey: ["agent-signup-session", targetOrgId],
        queryFn: () => startHumanAgentSignup(targetOrgId ?? ""),
        enabled: Boolean(targetOrgId),
    });
    const signupToken = signupSessionQuery.data?.session_token ?? "(loading)";

    // ── Ollama model discovery (probed REEF-side; see reefOllamaModels) ──
    // BYO hosts are debounced so half-typed URLs don't 502-spam; a
    // reef-configured ollama probes with no host param (REEF_OLLAMA_HOST).
    const ollamaProvider = providerList?.find(p => p.id === "ollama") ?? null;
    const ollamaByoHost = (state.byoValues.ollama ?? "").trim();
    const [debouncedOllamaHost, setDebouncedOllamaHost] = useState(ollamaByoHost);
    useEffect(() => {
        const t = setTimeout(() => { setDebouncedOllamaHost(ollamaByoHost); }, 500);
        return () => { clearTimeout(t); };
    }, [ollamaByoHost]);
    // Configured ollama probes the reef's own host by default, but honours a
    // typed override once it's a valid URL (same override the create sends).
    const overrideHostValid = /^https?:\/\/\S+$/i.test(debouncedOllamaHost);
    const probeHost = ollamaProvider?.configured
        ? (overrideHostValid ? debouncedOllamaHost : undefined)
        : debouncedOllamaHost;
    const probeReady =
        state.providerId === "ollama" && Boolean(reefUrl) && Boolean(ollamaProvider)
        && (ollamaProvider?.configured === true || overrideHostValid);
    const ollamaModelsQuery = useQuery({
        queryKey: ["org", targetOrgId ?? "none", "reef-ollama-models", probeHost ?? "(reef)", debouncedToken],
        queryFn: () => reefOllamaModels(reefUrl ?? "", probeHost),
        enabled: probeReady,
        retry: false,
        staleTime: 30_000,
    });
    // One onboarding prompt per runtime; an unpicked runtime falls back to OpenClaw
    // (the Connect step only renders once a runtime is chosen).
    const selfPrompt = SELF_PROMPTS[state.runtime ?? "openclaw"](targetOrg, signupToken);
    const [promptCopied, setPromptCopied] = useState(false);
    const copyPrompt = () => {
        void navigator.clipboard.writeText(selfPrompt);
        setPromptCopied(true);
        toast.success("Prompt copied");
    };

    // ── Deploy auto-advance: a FRESH pick advances once its gate clears; a
    //    rail revisit doesn't bounce (the flag is only set by a pick). ──
    const awaitingAdvance = useRef(false);
    const pickMode = (mode: Mode) => {
        dispatch({type: "pick-mode", mode});
        awaitingAdvance.current = true;
    };
    useEffect(() => {
        if (!awaitingAdvance.current || state.step !== "deploy" || state.mode === null) return;
        if (state.mode === "self" || providersReady) {
            awaitingAdvance.current = false;
            dispatch({type: "goto", step: "runtime"});
        }
    }, [state.step, state.mode, providersReady, dispatch]);

    // ── Provider invalidation: the pick must survive list refetches (token
    //    edits) and runtime changes only while it stays valid. ──
    useEffect(() => {
        if (state.providerId === null || state.providerId === "none" || providerList === null) return;
        const p = providerList.find(x => x.id === state.providerId);
        const unsupported = p?.runtimes && state.runtime !== null && !p.runtimes.includes(state.runtime);
        const lostKey = p && !p.configured && !(state.byoValues[p.id] ?? "").trim() && state.step === "launch";
        if (!p || unsupported || lostKey) dispatch({type: "invalidate-provider"});
    }, [providerList, state.runtime, state.providerId, state.byoValues, state.step, dispatch]);

    // ── Create ──
    const [createdPassword, setCreatedPassword] = useState<string | null>(null);
    const [createdSandboxId, setCreatedSandboxId] = useState<string | null>(null);
    // The scoped web-terminal URL from the create response — used by the Launch
    // step's "connect your ChatGPT plan" handoff (terminal + one-time password
    // are only revealed here, at create). null for non-exposed / older reefs.
    const [createdTerminalUrl, setCreatedTerminalUrl] = useState<string | null>(null);
    // Flips true HERO_ATTRIBUTION_TIMEOUT_MS after the create succeeds — the
    // signal to stop waiting for a reef_sandbox_id match and accept first-joined.
    const [attributionExpired, setAttributionExpired] = useState(false);
    const [pwCopied, setPwCopied] = useState(false);
    // Owner passed the password gate ("Copy & continue"). Lives here (not in
    // LaunchStep) because the dock chip's dismiss guard hangs off it.
    const [pwSaved, setPwSaved] = useState(false);
    const createMutation = useMutation({
        mutationFn: async () => {
            if (!reefUrl) throw new Error("No Reef connected");
            const token = reefTokenInput.trim();
            if (!token) throw new ReefAuthError("Enter your Reef admin token");
            setReefToken(token);
            const session = await startHumanAgentSignup(targetOrgId ?? "");
            const body: ReefCreateBody = {
                type: state.runtime ?? "openclaw",
                org_id: targetOrgId ?? undefined,
                signup_token: session.session_token,
                clawbits_url: deriveClawbitsUrl(),
            };
            if (state.imageTag) body.image = state.imageTag;
            if (state.providerId) {
                body.provider = state.providerId;
                const picked = providerList?.find(p => p.id === state.providerId);
                // Send a typed key/host whenever present — it wins over the reef-
                // level value server-side, so it overrides a configured provider too.
                if (picked) {
                    const own = (state.byoValues[picked.id] ?? "").trim();
                    if (own && picked.id === "openai") body.openai_api_key = own;
                    if (own && picked.id === "anthropic") body.anthropic_api_key = own;
                    if (own && picked.id === "gemini") body.gemini_api_key = own;
                    if (own && picked.id === "nearai") body.nearai_api_key = own;
                    if (own && picked.id === "ollama") body.ollama_host = own;
                }
                // Only send what THIS reef accepts — older Pydantic drops silently.
                if (modelSupported && state.model.trim()) body.model = state.model.trim();
            }
            if (envSupported) {
                const entries = state.envRows
                    .map(r => [r.key.trim(), r.value] as const)
                    .filter(([k]) => k.length > 0);
                if (entries.length > 0) body.env = Object.fromEntries(entries);
            }
            if (capabilitiesSupported && state.capabilities.length > 0) {
                body.capabilities = state.capabilities;
            }
            const res = await reefCreate(reefUrl, body);
            // Record which reef VM the signup token will enroll into — the hero
            // card attributes by this id. Best-effort: a linking hiccup must
            // never fail (or undo) the agent creation.
            try {
                await linkReefVm(session.session_token, res.sandbox_id);
            } catch (e) {
                console.warn("reef VM link failed (non-fatal):", e);
            }
            return res;
        },
        onSuccess: (res) => {
            if (targetOrgId) {
                void queryClient.invalidateQueries({queryKey: queryKeys.agents(targetOrgId)});
                void queryClient.invalidateQueries({queryKey: queryKeys.reefFleet(targetOrgId)});
            }
            setCreatedPassword(res.access?.password ?? null);
            setCreatedSandboxId(res.sandbox_id);
            setCreatedTerminalUrl(res.access?.terminal_url ?? null);
        },
    });
    useEffect(() => {
        if (createdSandboxId === null) return;
        const t = setTimeout(() => { setAttributionExpired(true); }, HERO_ATTRIBUTION_TIMEOUT_MS);
        return () => { clearTimeout(t); };
    }, [createdSandboxId]);
    const createError: string | null =
        state.launched && state.mode === "reef" && createMutation.isError
            ? createMutation.error instanceof ReefAuthError
                ? "Reef rejected the token - check it and retry."
                : createMutation.error instanceof ReefUnreachableError
                    ? "Can't reach Reef over its tunnel."
                    : createMutation.error instanceof Error
                        ? createMutation.error.message
                        : "Couldn't create the agent"
            : null;

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

    // ── Hero attribution (plan §2.2) ──
    const hero: AgentUser | null = useMemo(() => {
        if (joined.length === 0) return null;
        if (state.mode === "self") return joined[0] ?? null;
        const attributed = createdSandboxId
            ? joined.find(a => a.reef_sandbox_id === createdSandboxId)
            : undefined;
        if (attributed) return attributed;
        if (attributionExpired) return joined[0] ?? null;
        return null;
    }, [joined, state.mode, createdSandboxId, attributionExpired]);
    const others = joined.filter(a => a.agent_id !== hero?.agent_id);
    const heroOnline = hero !== null && agentLivenessStatus(hero.last_alive_at ?? null) === "available";

    // ── Validity ──
    const picked = providerList?.find(p => p.id === state.providerId) ?? null;
    const pickedEndpoint = (picked?.kind ?? "api_key") === "endpoint";
    const byoValue = picked ? (state.byoValues[picked.id] ?? "").trim() : "";
    const pickNeedsValue = Boolean(picked && !picked.configured && byoValue.length === 0);
    const byoBadUrl = Boolean(picked && pickedEndpoint && byoValue.length > 0 && !/^https?:\/\//i.test(byoValue));
    const pickNeedsModel = Boolean(picked && pickedEndpoint && state.model.trim().length === 0);
    // Model step's Continue; Options adds env validity itself before Create.
    const modelStepComplete =
        state.providerId !== null && !pickNeedsValue && !byoBadUrl && !pickNeedsModel;
    const createEnabled =
        reefConnected && providersReady && state.runtime !== null && modelStepComplete;

    // ── ChatGPT-subscription (oauth) handoff for the Launch step ──
    // Only when an oauth provider was picked AND the create returned an exposed
    // terminal + the one-time password (both live only in the create response).
    const codexConnect = useMemo(() => {
        if (picked?.kind !== "oauth") return null;
        if (!createdTerminalUrl || !createdPassword) return null;
        return {
            terminalOpenUrl: terminalAuthUrl(createdTerminalUrl, createdPassword),
            // Runtime-specific: each engine has its OWN device-code login command, and
            // handing a Hermes owner an `openclaw …` command is just a dead end.
            command: CODEX_LOGIN_COMMAND[state.runtime ?? "openclaw"],
        };
    }, [picked?.kind, createdTerminalUrl, createdPassword, state.runtime]);

    // ── Error banner (rail-level, never a silent branch swap) ──
    const pastDeploy = state.step !== "deploy" && state.mode === "reef";
    const banner: string | null =
        pastDeploy && healthQuery.isError ? "Reef unreachable - check its tunnel."
        : pastDeploy && tokenRejected ? "Reef rejected the admin token."
        : pastDeploy && reefTooOld ? "This Reef predates provider discovery - update it."
        : null;

    // Launch locks the rail on BOTH paths (it isn't a step of its own — the
    // frozen chips are the record of what was chosen); a failed reef create
    // unfreezes it for Retry/Back.
    const frozen = state.launched && createError === null;

    // ── Launch timeline ──
    const phases: TimelinePhase[] = useMemo(() => {
        const heroFound = hero !== null;
        // Short, human labels — these surface as the wizard button's waiting
        // text, so they read as "where am I in this" not internal machinery.
        if (state.mode === "self") {
            return [
                {label: "Prompt copied", state: "done"},
                {label: "Waiting for your agent…", state: heroFound ? "done" : "current"},
                {label: "Almost ready…", state: heroOnline ? "done" : heroFound ? "current" : "pending"},
            ];
        }
        const created = createMutation.isSuccess;
        return [
            {label: "Reaching your Reef…", state: createMutation.isPending ? "current" : "done"},
            {label: "Booting your agent…", state: created ? "done" : "pending"},
            {label: "Waking up your agent…", state: heroFound ? "done" : created ? "current" : "pending"},
            {label: "Almost ready…", state: heroOnline ? "done" : heroFound ? "current" : "pending"},
        ];
    }, [state.mode, createMutation.isPending, createMutation.isSuccess, hero, heroOnline]);

    // ── Dock-chip metadata (wizardSessionStore): only the body knows the
    //    wizard's real progress, so it publishes what the minimized chip
    //    shows and how closes behave — dirty routes Esc/backdrop to minimize,
    //    guard makes the chip's ✕ confirm before discarding the one-time
    //    password. The store value-compares, so the 2.5s poll re-publishing
    //    an unchanged summary is free. ──
    const dirty = state.mode !== null || state.launched;
    const guard: WizardDismissGuard = createMutation.isPending
        ? "creating"
        : createdPassword !== null && !pwSaved
            ? "password"
            : null;
    const heroName = hero !== null ? agentLabel(hero) : null;
    const phaseLabel = phases.find(p => p.state === "current")?.label ?? null;
    useEffect(() => {
        const seq = stepsFor(state.mode);
        const summary: WizardChipSummary =
            createError !== null || banner !== null
                ? {title: "Add agent", subtitle: createError ?? banner ?? "", status: "error", progress: null}
                : heroName !== null && heroOnline
                    ? {
                        title: heroName,
                        // "access code inside" only if there IS one (self-host
                        // creates have none; reef runtimes all mint a password).
                        subtitle: createdPassword !== null ? "Ready - access code inside" : "Ready to chat",
                        status: "ready",
                        progress: null,
                    }
                    : state.launched
                        ? {title: "Add agent", subtitle: phaseLabel ?? "Working…", status: "working", progress: null}
                        : {
                            title: "Add agent",
                            subtitle: STEP_TITLES[state.step],
                            status: "draft",
                            // Position, not completion: on step 1 of 5 the pie
                            // already shows a sliver — "you're in it", like the
                            // "Step 1 of 5" text it replaced.
                            progress: (seq.indexOf(state.step) + 1) / seq.length,
                        };
        publishWizardMeta({dirty, guard, summary});
    }, [dirty, guard, state.mode, state.step, state.launched, createError, banner, heroName, heroOnline, phaseLabel, createdPassword]);

    if (!targetOrgId) {
        return (
            <>
                <WizardHeader/>
                <p className="p-3 text-sm text-muted-foreground">Select an organization first.</p>
            </>
        );
    }

    const goto = (step: StepId) => {
        if (stepsFor(state.mode).includes(step)) dispatch({type: "goto", step});
    };

    return (
        <>
            <WizardHeader/>
            {/* The body carries the padding the p-0 dialog gave up. */}
            {/* gap matches the body's p-3 so content sits an equal distance
                below the rail as it does above the dialog's bottom edge. */}
            <div className="flex flex-col gap-3 p-3">
            <SummaryRail state={state} frozen={frozen} providers={providerList} onGoto={goto}/>

            {banner !== null && (
                <div className="flex animate-in items-center gap-2.5 rounded-xl border border-destructive/40 bg-destructive/5 px-3.5 py-2.5 fade-in slide-in-from-top-1 duration-200">
                    <Icon icon={Alert} className="size-4 shrink-0 text-destructive"/>
                    <span className="min-w-0 text-[13px] font-medium text-destructive">{banner}</span>
                    <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => { dispatch({type: "goto", step: "deploy"}); }}
                        className="ml-auto h-7 shrink-0 px-2.5 text-xs"
                    >
                        Go to step 1
                    </Button>
                </div>
            )}

            {/* Content-driven height, animated between steps (the dialog still
                scrolls before anything could overflow off-screen). */}
            <AnimatedHeight>
            <div
                key={state.step}
                className={cn(
                    "flex flex-col animate-in fade-in slide-in-from-right-2 duration-300",
                    banner !== null && "pointer-events-none opacity-60",
                )}
            >
                {state.step === "deploy" && (
                    <DeployStep
                        mode={state.mode}
                        onPick={pickMode}
                        reefUrl={reefUrl}
                        reefConnected={reefConnected}
                        checkingReef={checkingReef}
                        showTokenField={state.mode === "reef" && (!tokenPrefilled || tokenRejected || !providersReady)}
                        tokenValue={reefTokenInput}
                        onTokenChange={setReefTokenInput}
                        tokenChecking={providersQuery.isFetching && !providersReady}
                        tokenRejected={tokenRejected}
                        reefUnreachable={reefUnreachable}
                        onClose={onClose}
                    />
                )}
                {state.step === "runtime" && (
                    <RuntimeStep
                        mode={state.mode}
                        runtime={state.runtime}
                        onPick={(r) => { dispatch({type: "pick-runtime", runtime: r}); }}
                        images={state.mode === "reef" ? images : null}
                        imageTag={state.imageTag}
                        onImageTag={(tag) => { dispatch({type: "set-image", tag}); }}
                    />
                )}
                {state.step === "model" && (
                    <ModelStep
                        state={state}
                        providers={providerList}
                        providersLoading={providersQuery.isFetching && !providersReady}
                        onPick={(id) => {
                            dispatch({type: "pick-provider", id});
                            dispatch({type: "goto", step: "options"});
                        }}
                    />
                )}
                {state.step === "options" && (
                    <OptionsStep
                        state={state}
                        providers={providerList}
                        modelSupported={modelSupported}
                        envSupported={envSupported}
                        capabilitiesSupported={capabilitiesSupported}
                        onToggleCapability={(id: string) => {
                            dispatch({type: "toggle-capability", id});
                        }}
                        ollamaProbe={{
                            models: ollamaModelsQuery.data?.models ?? null,
                            loading: ollamaModelsQuery.isFetching,
                            error: ollamaModelsQuery.isError,
                        }}
                        onByo={(id, value) => { dispatch({type: "set-byo", id, value}); }}
                        onModel={(model) => { dispatch({type: "set-model", model}); }}
                        onEnvRows={(rows) => { dispatch({type: "set-env", rows}); }}
                        onCreate={() => {
                            dispatch({type: "launch"});
                            createMutation.mutate();
                        }}
                        createEnabled={createEnabled}
                        pending={createMutation.isPending}
                    />
                )}
                {state.step === "connect" && state.runtime !== null && (
                    <ConnectStep
                        runtime={state.runtime}
                        prompt={selfPrompt}
                        ready={Boolean(signupSessionQuery.data) && !signupSessionQuery.isFetching}
                        copied={promptCopied}
                        onCopy={() => {
                            copyPrompt();
                            dispatch({type: "launch"});
                        }}
                    />
                )}
                {state.step === "launch" && state.mode !== null && (
                    <LaunchStep
                        mode={state.mode}
                        visible={visible}
                        phases={phases}
                        createError={createError}
                        onRetry={() => { createMutation.mutate(); }}
                        onBack={() => {
                            createMutation.reset();
                            dispatch({type: "unlaunch"});
                            dispatch({type: "goto", step: "options"});
                        }}
                        password={createdPassword}
                        // Idle counts as pending: the retry path resets the mutation
                        // before re-firing, and a settled-with-no-password verdict is
                        // only meaningful once the create has actually run.
                        passwordPending={!createMutation.isSuccess && !createMutation.isError}
                        pwSaved={pwSaved}
                        onPwSaved={() => { setPwSaved(true); }}
                        pwCopied={pwCopied}
                        onCopyPassword={() => {
                            if (createdPassword) {
                                void navigator.clipboard.writeText(createdPassword);
                                setPwCopied(true);
                                toast.success("Access password copied");
                            }
                        }}
                        hero={hero}
                        others={others}
                        onSayHi={(id) => { sayHiMutation.mutate(id); }}
                        sayHiPendingId={sayHiMutation.isPending ? sayHiMutation.variables : null}
                        codex={codexConnect}
                    />
                )}
            </div>
            </AnimatedHeight>
            </div>
        </>
    );
}
