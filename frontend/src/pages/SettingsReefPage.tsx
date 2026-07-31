import {useEffect, useMemo, useRef, useState, type ReactNode} from "react";
import {useNavigate} from "react-router-dom";
import {useMutation, useQuery, useQueryClient} from "@tanstack/react-query";
import {
    CloudServerIcon as CloudServer,
    ConnectIcon as Connect,
    Unlink01Icon as Disconnect,
    AlertCircleIcon as Offline,
    CpuIcon as Vm,
    LinkSquare02Icon as OpenExternal,
    TerminalIcon as Terminal,
    KeyIcon as Key,
    PackageIcon as Package,
    SparklesIcon as Sparkles,
    RefreshIcon as Refresh,
    Tick01Icon as Check,
    ArrowUp01Icon as ArrowUp,
    ArrowDown01Icon as ChevronDown,
    ArrowRight01Icon as ArrowRight,
    Cancel01Icon as Close,
} from "@hugeicons/core-free-icons";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {Switch} from "@/components/ui/switch";
import {Tooltip, TooltipContent, TooltipTrigger} from "@/components/ui/tooltip";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import {Icon} from "@/components/Icon";
import {EmptyState} from "@/components/EmptyState";
import {PageHeader} from "@/components/PageHeader";
import {useAuth} from "@/context/AuthContext";
import {useActiveOrg} from "@/hooks/useActiveOrg";
import {getReefConnection, setReefConnection, deleteReefConnection, getAgents, type AgentUser} from "@/lib/api";
import {AgentFaceAvatar} from "@/components/AgentFaceAvatar";
import {
    reefHealth, reefFleet, reefDetail, setReefToken, hasReefToken,
    ReefAuthError, ReefRequestError, ReefBuildInProgressError,
    reefImages, reefImageStatus, reefStartBuild, reefBuildJob, reefBuildJobs, reefActivateImage, reefUpgrade,
    type ReefFleetEntry, type ReefState, type ReefImage, type ReefBuildBody,
    type ReefImageStatus, type ReefRuntimeImageStatus, type ReefBuildJob,
} from "@/lib/reefApi";
import {OpenSurfaceDialog} from "@/components/reef/OpenSurfaceDialog";
import {queryKeys} from "@/lib/queryKeys";
import {toast} from "@/lib/toast";
import {cn} from "@/lib/utils";
import {ClawbitsGlyph, ReefGlyph} from "@/components/BrandGlyphs";

/** Per-state pill colors + the leading status dot. */
const STATE_UI: Record<ReefState, {pill: string; dot: string}> = {
    running: {pill: "bg-green-500/10 text-green-600 dark:text-green-400", dot: "bg-green-500"},
    creating: {pill: "bg-amber-500/10 text-amber-600 dark:text-amber-400", dot: "bg-amber-500 animate-pulse"},
    failed: {pill: "bg-red-500/10 text-red-600 dark:text-red-400", dot: "bg-red-500"},
    stopped: {pill: "bg-muted text-muted-foreground", dot: "bg-muted-foreground/50"},
    destroyed: {pill: "bg-muted text-muted-foreground", dot: "bg-muted-foreground/40"},
};

/** Operator accent (reef AGENT_COLORS) → gradient tint for the agent's identity
 *  tile (mirrors reef admin-ui's avatar tiles). Literal class strings so
 *  Tailwind's JIT keeps them; null ⇒ a neutral foreground wash. */
const TILE_TINT: Record<string, string> = {
    red: "bg-gradient-to-br from-red-500/25 to-red-500/5",
    green: "bg-gradient-to-br from-green-500/25 to-green-500/5",
    blue: "bg-gradient-to-br from-blue-500/25 to-blue-500/5",
    orange: "bg-gradient-to-br from-orange-500/25 to-orange-500/5",
    yellow: "bg-gradient-to-br from-yellow-500/25 to-yellow-500/5",
    violet: "bg-gradient-to-br from-violet-500/25 to-violet-500/5",
};
const tileTint = (color?: string | null): string =>
    (color && TILE_TINT[color]) || "bg-gradient-to-br from-foreground/[0.09] to-foreground/[0.02]";

/** Usage → bar color: calm under load, warns as it climbs. */
function loadBarClass(pct: number): string {
    if (pct >= 90) return "bg-red-500";
    if (pct >= 70) return "bg-amber-500";
    return "bg-emerald-500";
}

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

/** Bytes → a compact GiB/MiB label. */
function formatBytes(n: number): string {
    if (!n || n < 0) return "—";
    if (n >= GIB) {
        const g = n / GIB;
        return `${g.toFixed(g >= 10 ? 0 : 1)} GiB`;
    }
    return `${String(Math.round(n / MIB))} MiB`;
}

/** "1.2 / 4 GiB" used-over-limit, both in GiB. */
function memLabel(used: number, limit: number): string {
    if (!limit || limit < 0) return formatBytes(used);
    const u = used / GIB;
    const l = limit / GIB;
    return `${u.toFixed(u >= 10 ? 0 : 1)} / ${l.toFixed(l >= 10 ? 0 : 1)} GiB`;
}

function formatDate(iso: string | null | undefined): string | null {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleDateString(undefined, {month: "short", day: "numeric"});
}

/** Compact "just now / 5m / 3h / 2d ago" for a build timestamp; past a week it
 *  falls back to a short date so an old image reads as a real day, not "40d ago". */
function relativeTime(iso: string | null | undefined): string | null {
    if (!iso) return null;
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) return null;
    const secs = Math.round((Date.now() - t) / 1000);
    if (secs < 45) return "just now";
    const mins = Math.round(secs / 60);
    if (mins < 60) return `${String(mins)}m ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${String(hrs)}h ago`;
    const days = Math.round(hrs / 24);
    if (days < 7) return `${String(days)}d ago`;
    return formatDate(iso);
}

function agentLabel(a: AgentUser): string {
    return a.display_name?.trim() || a.nickname?.trim() || a.agent_id;
}

/** Friendly copy for an upgrade failure (auth is handled separately by the
 *  caller). 404 ⇒ reef forgot this VM; 422 ⇒ this agent can't be upgraded;
 *  503 (or a 502 from the tunnel) ⇒ reef/runtime unavailable. */
function upgradeErrorMessage(e: unknown): string {
    if (e instanceof ReefRequestError) {
        if (e.status === 404) return "Reef no longer manages this VM";
        if (e.status === 422) return "This agent can't be upgraded";
        if (e.status === 502 || e.status === 503) return "Reef runtime unavailable";
    }
    return e instanceof Error ? e.message : "Couldn't upgrade this agent";
}

const CONNECT_STEPS: {text: string; code?: string}[] = [
    {text: "Start Reef on the machine that will host your agents."},
    {text: "Expose it with a tunnel:", code: "cloudflared tunnel --url http://127.0.0.1:8787"},
    {text: "Paste the tunnel URL below — it's checked from your browser before saving."},
];

/** Runtime brand marks — the shipped mascots (the same art the New Agent wizard
 *  and Images panel show), rendered as images rather than vector glyphs. Hermes'
 *  mark is a single-colour silhouette, so it's masked into its brand violet
 *  instead (an <img> would pin it to the file's own fill and lose it on dark). */
function OpenClawGlyph({className}: {className?: string}) {
    return <img src="/openclaw.png" alt="" className={cn("object-contain", className)}/>;
}
function IronClawGlyph({className}: {className?: string}) {
    return <img src="/ironclaw.webp" alt="" className={cn("object-contain", className)}/>;
}
function HermesGlyph({className}: {className?: string}) {
    return (
        <span
            aria-hidden="true"
            className={cn("inline-block shrink-0 bg-current text-foreground", className)}
            style={{
                maskImage: "url(/hermes.svg)",
                maskRepeat: "no-repeat",
                maskPosition: "center",
                maskSize: "contain",
            }}
        />
    );
}

/** The runtimes reef ships images for, in a fixed display order. `engineLabel`
 *  / `componentLabel` name the two version axes per runtime (OpenClaw + Plugin,
 *  IronClaw + Channel, Hermes + Plugin — Hermes bakes the clawbits *plugin*, so
 *  it shares OpenClaw's component axis); `logo` is the shipped mascot (the same
 *  mark the New Agent wizard shows) and `glow`/`tile` are its brand accents for
 *  the big identity tile — OpenClaw red, IronClaw sky, Hermes violet. Literal
 *  class strings so Tailwind's JIT keeps them. */
const IMAGE_RUNTIMES = [
    {
        id: "openclaw",
        label: "OpenClaw",
        engineLabel: "OpenClaw",
        componentLabel: "Plugin",
        logo: "/openclaw.png",
        glow: "bg-red-500/25",
        tile: "from-red-500/15 to-red-500/[0.02] ring-red-500/15",
    },
    {
        id: "ironclaw",
        label: "IronClaw",
        engineLabel: "IronClaw",
        componentLabel: "Channel",
        logo: "/ironclaw.webp",
        glow: "bg-sky-500/25",
        tile: "from-sky-500/15 to-sky-500/[0.02] ring-sky-500/15",
    },
    {
        id: "hermes",
        label: "Hermes",
        engineLabel: "Hermes",
        componentLabel: "Plugin",
        logo: "/hermes.svg",
        glow: "bg-violet-500/25",
        tile: "from-violet-500/15 to-violet-500/[0.02] ring-violet-500/15",
    },
] as const;

/** The brand-tinted mascot tile shared by the runtime hero + its empty state: a
 *  soft blurred brand glow behind a gradient app-icon tile holding the logo.
 *  Hermes' mark is a silhouette (masked + tinted); the others are colour rasters. */
function RuntimeLogoTile({runtime}: {runtime: (typeof IMAGE_RUNTIMES)[number]}) {
    return (
        <span className="relative flex size-16 shrink-0 items-center justify-center">
            <span aria-hidden className={cn("absolute inset-1 -z-10 rounded-full blur-2xl", runtime.glow)}/>
            <span className={cn("flex size-16 items-center justify-center rounded-2xl bg-gradient-to-br ring-1 ring-inset", runtime.tile)}>
                {runtime.id === "hermes"
                    ? <HermesGlyph className="size-11"/>
                    : <img src={runtime.logo} alt="" className="size-11 object-contain"/>}
            </span>
        </span>
    );
}

export default function SettingsReefPage() {
    const navigate = useNavigate();
    const {activeOrgId} = useAuth();
    const {isOwner} = useActiveOrg();
    const queryClient = useQueryClient();
    const orgId = activeOrgId ?? "";

    const connQuery = useQuery({
        queryKey: orgId ? queryKeys.reefConnection(orgId) : ["org", "none", "reef-connection"],
        queryFn: () => getReefConnection(orgId),
        enabled: Boolean(orgId),
    });
    const apiUrl = connQuery.data?.api_url ?? null;

    // Browser-direct liveness probe (unauthenticated) → online/offline badge.
    const healthQuery = useQuery({
        queryKey: queryKeys.reefHealth(orgId),
        queryFn: () => reefHealth(apiUrl ?? ""),
        enabled: Boolean(apiUrl),
        retry: false,
        refetchInterval: 30_000,
    });
    const offline = Boolean(apiUrl) && healthQuery.isError;

    const [urlInput, setUrlInput] = useState("");
    const connectMutation = useMutation({
        // Validate the pasted URL straight from the browser (GET /healthz over the
        // tunnel) BEFORE we ask the backend to store it — fail fast on a typo or a
        // down tunnel. Only the URL is ever sent to clawbits.
        mutationFn: async (url: string) => {
            await reefHealth(url);
            return setReefConnection(orgId, url);
        },
        onSuccess: () => {
            setUrlInput("");
            void queryClient.invalidateQueries({queryKey: queryKeys.reefConnection(orgId)});
            void queryClient.invalidateQueries({queryKey: queryKeys.reefHealth(orgId)});
            toast.success("Reef connected");
        },
        onError: (e) => {
            toast.error(e instanceof Error ? e.message : "Couldn't connect to that Reef");
        },
    });

    const disconnectMutation = useMutation({
        mutationFn: () => deleteReefConnection(orgId),
        onSuccess: () => {
            setReefToken(null);
            setTokenSet(false);
            void queryClient.invalidateQueries({queryKey: queryKeys.reefConnection(orgId)});
            toast.success("Reef disconnected");
        },
        onError: (e) => {
            toast.error(e instanceof Error ? e.message : "Couldn't disconnect");
        },
    });

    // The admin token lives in sessionStorage (lib/reefApi) — it survives a reload
    // in-tab (hydrated on load) and is wiped when the tab closes. `tokenSet`
    // mirrors it into React so the fleet query re-runs on entry / after reload.
    const [tokenSet, setTokenSet] = useState(hasReefToken());
    const [tokenInput, setTokenInput] = useState("");

    const fleetQuery = useQuery({
        queryKey: queryKeys.reefFleet(orgId),
        queryFn: () => reefFleet(apiUrl ?? ""),
        // Gated on the health probe: when the Reef is unreachable the fleet section
        // shows an offline state instead of firing a request that can't succeed.
        enabled: Boolean(apiUrl) && tokenSet && !offline,
        retry: false,
        // Live state + metrics (CPU/mem/uptime) without a manual refresh — the
        // list is cheap and only polls while the tab is focused.
        refetchInterval: 8_000,
    });

    // Map each reef VM → the clawbits agent that runs in it (the link is set at
    // "Run on Reef" create time). Lets each fleet card show which agent it hosts.
    // This is a clawbits call (not reef), so it needs only the org + a visible fleet.
    const agentsQuery = useQuery({
        queryKey: queryKeys.agents(orgId),
        queryFn: () => getAgents(orgId),
        enabled: Boolean(orgId) && Boolean(apiUrl) && tokenSet && !offline,
        refetchInterval: 30_000,
    });
    const agentBySandbox = useMemo(() => {
        const m = new Map<string, AgentUser>();
        for (const a of agentsQuery.data?.agents ?? []) {
            if (a.reef_sandbox_id) m.set(a.reef_sandbox_id, a);
        }
        return m;
    }, [agentsQuery.data]);

    // Per-runtime build signal (server-computed `build_available` + the from→to
    // versions) drives the Image panel. Fetched ONCE at the page level and passed
    // down; the server owns the semver, so the client renders booleans + strings.
    // Gated on the same connected+unlocked state as the Image panel.
    const imageStatusQuery = useQuery({
        queryKey: ["reef-image-status", apiUrl],
        queryFn: () => reefImageStatus(apiUrl ?? ""),
        enabled: Boolean(apiUrl) && tokenSet && !offline,
        retry: false,
        staleTime: 30 * 60_000,
        refetchInterval: 60 * 60_000,
        refetchOnWindowFocus: false,
    });

    // A rejected token (401/403) → drop it and re-prompt rather than show "down".
    const authRejected = fleetQuery.error instanceof ReefAuthError;
    useEffect(() => {
        if (authRejected) {
            setReefToken(null);
            setTokenSet(false);
        }
    }, [authRejected]);

    const submitToken = (e: React.SyntheticEvent) => {
        e.preventDefault();
        const t = tokenInput.trim();
        if (!t) return;
        setReefToken(t);
        setTokenInput("");
        setTokenSet(true);
        void queryClient.invalidateQueries({queryKey: queryKeys.reefFleet(orgId)});
    };

    const forgetToken = () => {
        setReefToken(null);
        setTokenSet(false);
        queryClient.removeQueries({queryKey: queryKeys.reefFleet(orgId)});
    };

    // Opening a surface needs the one-time access password (reef no longer reveals
    // it), so a small dialog collects it and builds the authed URL client-side.
    // Driven by state — the actual window.open fires on the dialog's submit
    // gesture, which also dodges the popup blocker (no preceding await).
    const [openTarget, setOpenTarget] = useState<{id: string; surface: "ui" | "terminal"} | null>(null);

    if (!activeOrgId) {
        return <div className="text-sm text-muted-foreground">Select an organization.</div>;
    }

    const fleet: ReefFleetEntry[] = fleetQuery.data ?? [];
    const fleetVisible = Boolean(apiUrl) && tokenSet && !offline;

    return (
        <div>
            <PageHeader
                icon={CloudServer}
                title="Reef"
            />

            {/* Sub-sections are separated by divider lines + spacing rather than
                nested cards — the content card itself is the surface (same
                structure as the Profile page). */}
            <div className="divide-y divide-border/60">
                {/* ── Connection ─────────────────────────────────────────── */}
                <section className="space-y-5 py-8 first:pt-0">
                    {/* The first-run connect hero carries its own heading, so the
                        small section label is hidden for that one state. */}
                    {!(isOwner && !apiUrl && !connQuery.isLoading) && (
                        <div className="space-y-0.5">
                            <h2 className="text-sm font-semibold">Connection</h2>
                            <p className="text-xs text-muted-foreground">
                                Run agent VMs on your own machine. Your browser talks to Reef directly;
                                clawbits only stores the URL.
                            </p>
                        </div>
                    )}

                    {connQuery.isLoading ? (
                        <div className="flex items-center gap-3">
                            <div className="size-5 shrink-0 animate-pulse rounded-full bg-muted"/>
                            <div className="flex-1 space-y-2">
                                <div className="h-3.5 w-64 animate-pulse rounded bg-muted"/>
                                <div className="h-3 w-40 animate-pulse rounded bg-muted"/>
                            </div>
                        </div>
                    ) : apiUrl ? (
                        <div className="relative overflow-hidden rounded-2xl border border-border/60 bg-card p-4">
                            {/* A quiet red wash only when the Reef is unreachable —
                                an error cue; the online state stays clean. */}
                            {offline && (
                                <div
                                    aria-hidden
                                    className="pointer-events-none absolute inset-0 bg-gradient-to-br from-red-500/[0.05] via-transparent to-transparent"
                                />
                            )}
                            <div className="relative flex items-center gap-3.5">
                                <span
                                    className="flex size-11 shrink-0 items-center justify-center rounded-2xl ring-1 ring-inset ring-white/10"
                                    style={{background: "linear-gradient(180deg, #FF8781, #FF5451)"}}
                                >
                                    <img src="/reef.svg" alt="" className="size-7"/>
                                </span>
                                <div className="min-w-0 flex-1">
                                    <p className="truncate text-sm font-medium text-foreground">{apiUrl}</p>
                                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                                        <span className="inline-flex items-center gap-1.5">
                                            <span className="relative flex size-2">
                                                {!offline && !healthQuery.isLoading && (
                                                    <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500/60"/>
                                                )}
                                                <span className={cn(
                                                    "relative inline-flex size-2 rounded-full",
                                                    healthQuery.isLoading ? "bg-amber-500" : offline ? "bg-red-500" : "bg-emerald-500",
                                                )}/>
                                            </span>
                                            <span className={cn(
                                                "font-medium",
                                                healthQuery.isLoading
                                                    ? "text-amber-600 dark:text-amber-400"
                                                    : offline
                                                        ? "text-red-600 dark:text-red-400"
                                                        : "text-emerald-600 dark:text-emerald-400",
                                            )}>
                                                {healthQuery.isLoading ? "Checking…" : offline ? "Offline" : "Online"}
                                            </span>
                                        </span>
                                        {offline && (
                                            <span className="text-muted-foreground">can't reach this Reef from your browser</span>
                                        )}
                                    </div>
                                </div>
                                {isOwner && (
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        className="shrink-0 self-center text-muted-foreground hover:text-destructive"
                                        onClick={() => { disconnectMutation.mutate(); }}
                                        disabled={disconnectMutation.isPending}
                                    >
                                        <Icon icon={Disconnect} className="size-4"/>
                                        <span className="hidden sm:inline">Disconnect</span>
                                    </Button>
                                )}
                            </div>
                        </div>
                    ) : isOwner ? (
                        <div className="flex flex-col items-center gap-6 rounded-2xl border border-dashed border-border/70 bg-card px-6 py-12 text-center">
                            {/* Reef logo with a soft glow. */}
                            <div className="relative">
                                <div aria-hidden className="absolute inset-0 -z-10 rounded-full bg-violet-500/15 blur-2xl"/>
                                <div className="flex size-16 items-center justify-center rounded-2xl bg-gradient-to-br from-foreground/[0.1] to-foreground/[0.02] ring-1 ring-inset ring-border/50">
                                    <ReefGlyph className="size-9 text-foreground/80"/>
                                </div>
                            </div>

                            <div className="space-y-1.5">
                                <h3 className="text-lg font-semibold tracking-tight text-foreground">Connect your Reef</h3>
                                <p className="mx-auto max-w-md text-sm text-muted-foreground">
                                    Run isolated agent VMs on your own machine. Paste your Reef's tunnel URL —
                                    your browser talks to it directly, so clawbits only ever stores the URL.
                                </p>
                            </div>

                            <form
                                onSubmit={(e) => { e.preventDefault(); const u = urlInput.trim(); if (u) connectMutation.mutate(u); }}
                                className="flex w-full max-w-md flex-col gap-2 sm:flex-row"
                            >
                                <Input
                                    id="reef-url"
                                    type="url"
                                    inputMode="url"
                                    autoComplete="off"
                                    aria-label="Reef API URL"
                                    value={urlInput}
                                    onChange={(e) => { setUrlInput(e.target.value); }}
                                    placeholder="https://reef.your-host.example.com"
                                    disabled={connectMutation.isPending}
                                    className="h-11 text-center sm:text-left"
                                />
                                <Button
                                    type="submit"
                                    size="lg"
                                    className="h-11 shrink-0"
                                    disabled={!urlInput.trim() || connectMutation.isPending}
                                >
                                    <Icon icon={Connect} className="size-4"/>
                                    {connectMutation.isPending ? "Connecting…" : "Connect"}
                                </Button>
                            </form>

                            {/* How to expose it — secondary guidance, subtle inset (no border). */}
                            <div className="w-full max-w-md rounded-xl bg-muted/30 p-4 text-left">
                                <p className="mb-2.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/80">
                                    How to expose it
                                </p>
                                <ol className="space-y-2">
                                    {CONNECT_STEPS.map((step, i) => (
                                        <li key={i} className="flex items-start gap-2.5 text-xs text-muted-foreground">
                                            <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-background text-[10px] font-medium tabular-nums ring-1 ring-border/60">
                                                {i + 1}
                                            </span>
                                            <span className="min-w-0">
                                                {step.text}
                                                {step.code && (
                                                    <>
                                                        {" "}
                                                        <code className="rounded bg-background px-1.5 py-0.5 font-mono text-[11px] text-foreground/80 ring-1 ring-border/50 select-all">
                                                            {step.code}
                                                        </code>
                                                    </>
                                                )}
                                            </span>
                                        </li>
                                    ))}
                                </ol>
                            </div>
                        </div>
                    ) : (
                        <EmptyState
                            className="py-8"
                            icon={CloudServer}
                            title="No Reef connected"
                            description="Ask an organization owner to connect your Reef instance."
                        />
                    )}
                </section>

                {/* ── Image ──────────────────────────────────────────────── */}
                {fleetVisible && apiUrl && (
                    <section className="space-y-5 py-8">
                        <div className="space-y-0.5">
                            <h2 className="text-sm font-semibold">Images</h2>
                            <p className="text-xs text-muted-foreground">
                                The images new agents boot, per runtime. Rebuild when the engine or the
                                clawbits component updates.
                            </p>
                        </div>
                        <ReefImagePanel
                            apiUrl={apiUrl}
                            orgId={orgId}
                            imageStatus={imageStatusQuery.data}
                            fleet={fleet}
                            onAuthReject={forgetToken}
                        />
                    </section>
                )}

                {/* ── Fleet ──────────────────────────────────────────────── */}
                {apiUrl && (
                    <section className="space-y-5 py-8">
                        <div className="flex items-center justify-between gap-2">
                            <h2 className="flex items-center gap-2 text-sm font-semibold">
                                Fleet
                                {fleetVisible && fleetQuery.isSuccess && (
                                    <span className="text-xs font-normal text-muted-foreground tabular-nums">
                                        {fleet.length}
                                    </span>
                                )}
                            </h2>
                            {fleetVisible && (
                                <button
                                    type="button"
                                    onClick={forgetToken}
                                    className="text-xs font-medium text-muted-foreground hover:text-foreground"
                                >
                                    Forget token
                                </button>
                            )}
                        </div>

                        {offline ? (
                            <EmptyState
                                className="py-8"
                                icon={Offline}
                                title="Reef is unreachable"
                                description="Reconnect the tunnel to see and manage this fleet."
                            />
                        ) : !tokenSet ? (
                            // Same visual language as the shared EmptyState (icon chip,
                            // expressive hero (same language as the connect state):
                            // a glowing key tile, a tight lead, and the unlock form.
                            <div className="flex flex-col items-center gap-6 rounded-2xl border border-dashed border-border/70 bg-card px-6 py-12 text-center">
                                <div className="relative">
                                    <div aria-hidden className="absolute inset-0 -z-10 rounded-full bg-amber-500/15 blur-2xl"/>
                                    <div className="flex size-16 items-center justify-center rounded-2xl bg-gradient-to-br from-amber-500/15 to-amber-500/[0.03] text-amber-600 ring-1 ring-inset ring-amber-500/20 dark:text-amber-400">
                                        <Icon icon={Key} className="size-8"/>
                                    </div>
                                </div>
                                <div className="space-y-1.5">
                                    <h3 className="text-lg font-semibold tracking-tight text-foreground">Unlock the fleet</h3>
                                    <p className="mx-auto max-w-md text-sm text-muted-foreground">
                                        Enter your Reef admin token to view and manage agents. It stays in this
                                        browser session only — never stored or sent to clawbits.
                                    </p>
                                </div>
                                <form onSubmit={submitToken} className="flex w-full max-w-md flex-col gap-2 sm:flex-row">
                                    <Input
                                        id="reef-token"
                                        type="password"
                                        autoComplete="off"
                                        aria-label="Reef admin token"
                                        value={tokenInput}
                                        onChange={(e) => { setTokenInput(e.target.value); }}
                                        placeholder="Reef admin token"
                                        className="h-11 text-center sm:text-left"
                                    />
                                    <Button type="submit" size="lg" className="h-11 shrink-0" disabled={!tokenInput.trim()}>
                                        <Icon icon={Key} className="size-4"/>
                                        Unlock
                                    </Button>
                                </form>
                            </div>
                        ) : fleetQuery.isLoading ? (
                            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                                {Array.from({length: 2}).map((_, i) => (
                                    <div key={i} className="rounded-2xl border border-border/60 bg-card p-4">
                                        <div className="flex items-center gap-3">
                                            <div className="size-10 shrink-0 animate-pulse rounded-xl bg-muted"/>
                                            <div className="flex-1 space-y-2">
                                                <div className="h-3.5 w-40 animate-pulse rounded bg-muted"/>
                                                <div className="h-3 w-28 animate-pulse rounded bg-muted"/>
                                            </div>
                                        </div>
                                        <div className="mt-4 flex gap-1.5">
                                            <div className="h-6 w-24 animate-pulse rounded-lg bg-muted"/>
                                            <div className="h-6 w-20 animate-pulse rounded-lg bg-muted"/>
                                        </div>
                                        <div className="mt-4 h-10 animate-pulse rounded-lg bg-muted"/>
                                    </div>
                                ))}
                            </div>
                        ) : fleetQuery.isError ? (
                            authRejected ? null : (
                                <EmptyState
                                    className="py-8"
                                    icon={Offline}
                                    title="Couldn't load the fleet"
                                    description={fleetQuery.error instanceof Error ? fleetQuery.error.message : "Something went wrong."}
                                />
                            )
                        ) : fleet.length === 0 ? (
                            <EmptyState
                                className="py-8"
                                icon={Vm}
                                title="No agents yet"
                                description="Agents you create in clawbits run on this Reef."
                                action={
                                    <Button size="sm" variant="outline" onClick={() => { void navigate("/agents"); }}>
                                        Go to Agents
                                    </Button>
                                }
                            />
                        ) : (
                            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                                {fleet.map((vm) => (
                                    <FleetCard
                                        key={vm.sandbox_id}
                                        vm={vm}
                                        apiUrl={apiUrl}
                                        orgId={orgId}
                                        linkedAgent={agentBySandbox.get(vm.sandbox_id) ?? null}
                                        onOpen={(surface) => { setOpenTarget({id: vm.sandbox_id, surface}); }}
                                        onAuthReject={forgetToken}
                                    />
                                ))}
                            </div>
                        )}
                    </section>
                )}
            </div>

            {openTarget && (
                <OpenSurfaceDialog
                    target={openTarget}
                    apiUrl={apiUrl}
                    onClose={() => { setOpenTarget(null); }}
                    onAuthReject={forgetToken}
                />
            )}
        </div>
    );
}

/** One agent VM as a prominent card: identity + status, version chips (OpenClaw
 *  / Clawbits plugin / image), live CPU·memory·uptime, resource limits, and the
 *  Control UI / terminal actions. Versions + limits come from the per-agent
 *  detail endpoint (the fleet list stays lean); the query key is shared with
 *  OpenSurfaceDialog so opening a surface reuses this cache. */
function FleetCard({
    vm,
    apiUrl,
    orgId,
    linkedAgent,
    onOpen,
    onAuthReject,
}: {
    vm: ReefFleetEntry;
    apiUrl: string | null;
    orgId: string;
    linkedAgent: AgentUser | null;
    onOpen: (surface: "ui" | "terminal") => void;
    onAuthReject: () => void;
}) {
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const detailQuery = useQuery({
        queryKey: ["reef-surface-detail", apiUrl, vm.sandbox_id],
        queryFn: () => reefDetail(apiUrl ?? "", vm.sandbox_id),
        enabled: Boolean(apiUrl),
        retry: false,
        staleTime: 15_000,
        // Versions/resources change rarely — refresh on a slow cadence so an
        // in-place upgrade surfaces without a manual reload.
        refetchInterval: 30_000,
    });
    const detail = detailQuery.data;
    const versions = detail?.status?.versions ?? null;

    // Version-based signal (server-computed): the agent's reported versions vs the
    // active image's baked versions for its runtime. Only managed, non-creating
    // agents can actually be upgraded (reef owns their volumes + ports).
    const canUpgrade = Boolean(vm.upgrade_available) && vm.managed && vm.state !== "creating";

    const upgrade = useMutation({
        mutationFn: () => reefUpgrade(apiUrl ?? "", vm.sandbox_id),
        onSuccess: () => {
            toast.success(`Upgrading ${vm.sandbox_id}…`);
            // State flips creating→running and the digests converge on the next
            // poll; nudge both caches so the strip disappears promptly.
            void queryClient.invalidateQueries({queryKey: queryKeys.reefFleet(orgId)});
            void queryClient.invalidateQueries({queryKey: ["reef-surface-detail", apiUrl, vm.sandbox_id]});
        },
        onError: (e) => {
            if (e instanceof ReefAuthError) {
                onAuthReject();
                toast.error("Reef rejected the token — re-enter it");
                return;
            }
            toast.error(upgradeErrorMessage(e));
        },
    });

    const running = vm.state === "running";
    const m = vm.metrics;
    const memFrac = m && m.memory_limit_bytes > 0 ? m.memory_bytes / m.memory_limit_bytes : 0;

    const meta: string[] = [];
    if (detail?.cpus) meta.push(`${String(detail.cpus)} vCPU`);
    if (detail?.memory_mib) meta.push(`${formatBytes(detail.memory_mib * MIB)} RAM`);
    const created = formatDate(vm.created_at);
    if (created) meta.push(`created ${created}`);
    // The truthful "what's running" stack string (server-derived from the agent's
    // reported versions) over the floating tag reef records.
    const image = vm.image_version ?? detail?.image ?? vm.image;
    const openAgent = linkedAgent ? () => { void navigate(`/agents/${linkedAgent.agent_id}`); } : null;

    return (
        <div
            className={cn(
                "group relative flex flex-col overflow-hidden rounded-2xl border border-border/60 bg-card transition-colors hover:border-border",
                openAgent && "cursor-pointer hover:bg-muted/20",
            )}
            {...(openAgent
                ? {
                    role: "button",
                    tabIndex: 0,
                    onClick: openAgent,
                    onKeyDown: (e: React.KeyboardEvent) => {
                        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openAgent(); }
                    },
                }
                : {})}
        >
            <div className="flex flex-1 flex-col gap-5 p-5">
                {/* Identity + status — the agent's avatar when linked, else the runtime mark. */}
                <div className="flex items-center gap-3.5">
                    {linkedAgent ? (
                        <AgentFaceAvatar
                            size={48}
                            name={agentLabel(linkedAgent)}
                            src={linkedAgent.avatar?.url}
                            className="shrink-0"
                        />
                    ) : (
                        <span className={cn("flex size-12 shrink-0 items-center justify-center rounded-2xl ring-1 ring-inset ring-border/40", tileTint(vm.color))}>
                            {vm.agent_type === "openclaw"
                                ? <OpenClawGlyph className="size-7"/>
                                : vm.agent_type === "ironclaw"
                                    ? <IronClawGlyph className="size-7"/>
                                    : vm.agent_type === "hermes"
                                        ? <HermesGlyph className="size-7"/>
                                        : <Icon icon={Vm} className="size-6 text-foreground/70"/>}
                        </span>
                    )}
                    <div className="min-w-0 flex-1">
                        <p className="truncate text-base font-semibold tracking-tight text-foreground">{vm.sandbox_id}</p>
                        <p className="truncate text-[13px] text-muted-foreground">
                            {linkedAgent ? agentLabel(linkedAgent) : vm.agent_type}
                            {image ? <span className="text-muted-foreground/60"> · {image}</span> : null}
                        </p>
                    </div>
                    <StatusPill state={vm.state}/>
                </div>

                {/* Version stack — OpenClaw / plugin / reef image */}
                {detailQuery.isLoading ? (
                    <div className="grid grid-cols-3 gap-2">
                        <div className="h-[58px] animate-pulse rounded-xl bg-muted"/>
                        <div className="h-[58px] animate-pulse rounded-xl bg-muted"/>
                        <div className="h-[58px] animate-pulse rounded-xl bg-muted"/>
                    </div>
                ) : versions ? (
                    <div className="grid grid-cols-3 gap-2">
                        {vm.agent_type === "ironclaw" ? (
                            <>
                                <VersionChip brand="ironclaw" value={versions.ironclaw}/>
                                <VersionChip brand="channel" value={versions.clawbitsChannel}/>
                            </>
                        ) : vm.agent_type === "hermes" ? (
                            // Hermes reports its own engine but the same clawbits PLUGIN
                            // as OpenClaw — the engine chip is the only axis that differs.
                            <>
                                <VersionChip brand="hermes" value={versions.hermes}/>
                                <VersionChip brand="plugin" value={versions.clawbitsPlugin}/>
                            </>
                        ) : (
                            <>
                                <VersionChip brand="openclaw" value={versions.openclaw}/>
                                <VersionChip brand="plugin" value={versions.clawbitsPlugin}/>
                            </>
                        )}
                        <VersionChip brand="image" value={versions.image}/>
                    </div>
                ) : (
                    <p className="text-xs text-muted-foreground">
                        {running ? "Versions not reported yet" : "Versions appear once the agent is running"}
                    </p>
                )}

                {/* Upgrade affordance — shown when this VM's reported versions are
                    behind the active image's baked versions (server-computed). */}
                {canUpgrade && (
                    <div className="flex items-center justify-between gap-3 rounded-xl bg-amber-500/[0.07] px-3 py-2.5">
                        <span className="inline-flex min-w-0 items-center gap-2 text-xs font-medium text-amber-700 dark:text-amber-400">
                            <span className="size-1.5 shrink-0 rounded-full bg-amber-500"/>
                            Newer image available
                        </span>
                        <Tooltip>
                            <TooltipTrigger
                                render={
                                    <Button
                                        type="button"
                                        size="sm"
                                        variant="outline"
                                        className="shrink-0 border-amber-500/30 text-amber-700 hover:bg-amber-500/10 hover:text-amber-800 dark:text-amber-400 dark:hover:text-amber-300"
                                        disabled={upgrade.isPending}
                                        onClick={(e) => { e.stopPropagation(); upgrade.mutate(); }}
                                    >
                                        <Icon icon={Refresh} className={cn("size-3.5", upgrade.isPending && "animate-spin")}/>
                                        {upgrade.isPending ? "Upgrading…" : "Upgrade"}
                                    </Button>
                                }
                            />
                            <TooltipContent className="max-w-xs text-xs">
                                Recreate this agent on the newest image. Workspace, clawbits identity,
                                and access password are preserved; brief downtime.
                            </TooltipContent>
                        </Tooltip>
                    </div>
                )}

                {/* Live usage — secondary + compact (CPU + memory only). */}
                {running && m && (
                    <div className="grid grid-cols-2 gap-4">
                        <Stat label="CPU" value={`${m.cpu_percent.toFixed(0)}%`} fraction={m.cpu_percent / 100}/>
                        <Stat label="Memory" value={memLabel(m.memory_bytes, m.memory_limit_bytes)} fraction={memFrac}/>
                    </div>
                )}

                {/* Footer: meta + actions */}
                <div className="mt-auto flex items-center justify-between gap-3 border-t border-border/40 pt-3">
                    <p className="min-w-0 flex-1 text-[11px] leading-relaxed text-muted-foreground tabular-nums">
                        {meta.length > 0 ? meta.join("  ·  ") : " "}
                    </p>
                    <div className="flex shrink-0 items-center gap-1.5">
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={!running}
                            onClick={(e) => { e.stopPropagation(); onOpen("ui"); }}
                        >
                            <Icon icon={OpenExternal} className="size-3.5"/>
                            {vm.agent_type === "hermes" ? "Dashboard" : "Control UI"}
                        </Button>
                        <Tooltip>
                            <TooltipTrigger
                                render={
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon-sm"
                                        aria-label="Open terminal"
                                        disabled={!running}
                                        onClick={(e) => { e.stopPropagation(); onOpen("terminal"); }}
                                    >
                                        <Icon icon={Terminal} className="size-4"/>
                                    </Button>
                                }
                            />
                            <TooltipContent className="text-xs">Open terminal</TooltipContent>
                        </Tooltip>
                    </div>
                </div>
            </div>
        </div>
    );
}

function StatusPill({state}: {state: ReefState}) {
    const ui = STATE_UI[state];
    return (
        <span className={cn("inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium capitalize", ui.pill)}>
            <span className={cn("size-2 rounded-full", ui.dot)}/>
            {state}
        </span>
    );
}

/** Fleet-global IMAGE axis, per runtime: whether a newer agent image is worth
 *  building (server `build_available` + the from→to versions), a one-click build
 *  with a live log, and the local image list with a confirm-gated rollback. */
function ReefImagePanel({
    apiUrl,
    orgId,
    imageStatus,
    fleet,
    onAuthReject,
}: {
    apiUrl: string;
    orgId: string;
    imageStatus: ReefImageStatus | undefined;
    fleet: ReefFleetEntry[];
    onAuthReject: () => void;
}) {
    const queryClient = useQueryClient();
    const [jobId, setJobId] = useState<string | null>(null);
    const [activateTarget, setActivateTarget] = useState<ReefImage | null>(null);
    // The runtime whose "Advanced" build dialog is open (pin engine/plugin, force
    // fresh) — the per-card primary button skips this and builds the newest stack.
    const [advancedFor, setAdvancedFor] = useState<string | null>(null);

    const imagesQuery = useQuery({
        queryKey: ["reef-images", apiUrl],
        queryFn: () => reefImages(apiUrl),
        enabled: Boolean(apiUrl),
        retry: false,
        // The set only changes on a build or activate — a slow poll keeps it fresh.
        refetchInterval: 15_000,
    });
    const images = imagesQuery.data ?? [];
    const statusByType = new Map((imageStatus?.runtimes ?? []).map((r) => [r.agent_type, r]));

    const buildJobQuery = useQuery({
        queryKey: ["reef-build-job", apiUrl, jobId],
        queryFn: () => reefBuildJob(apiUrl, jobId ?? ""),
        enabled: Boolean(apiUrl) && Boolean(jobId),
        retry: false,
        refetchInterval: (q) => (q.state.data?.status === "running" ? 1500 : false),
    });
    const job = buildJobQuery.data ?? null;
    const building = job?.status === "running";

    // A settled build auto-promotes the active tag → refresh /images (the banner
    // clears) AND the fleet (every VM flips upgradeable). A reef restart evicts
    // the in-memory job (404) even when the image finished, so an errored poll
    // degrades to the same refresh rather than reporting a build failure.
    const jobSettled = (job != null && job.status !== "running") || buildJobQuery.isError;
    useEffect(() => {
        if (jobId && jobSettled) {
            void queryClient.invalidateQueries({queryKey: ["reef-images", apiUrl]});
            void queryClient.invalidateQueries({queryKey: ["reef-image-status", apiUrl]});
            void queryClient.invalidateQueries({queryKey: queryKeys.reefFleet(orgId)});
        }
    }, [jobId, jobSettled, apiUrl, orgId, queryClient]);

    const startBuild = useMutation({
        mutationFn: (body: ReefBuildBody) => reefStartBuild(apiUrl, body),
        onSuccess: (newJob) => {
            setJobId(newJob.id);
            toast.success("Build started");
        },
        onError: (e) => {
            // A rejected token must clear it + re-prompt (the page only watches the
            // fleet query for auth, so a mutation auth error has to do it itself).
            if (e instanceof ReefAuthError) {
                onAuthReject();
                toast.error("Reef rejected the token — re-enter it");
                return;
            }
            // One build at a time — on a 409, attach to the running job instead of
            // surfacing an error the operator can do nothing about.
            if (e instanceof ReefBuildInProgressError) {
                void (async () => {
                    try {
                        const jobs = await reefBuildJobs(apiUrl);
                        const runningJob = jobs.find((j) => j.status === "running");
                        if (runningJob) {
                            setJobId(runningJob.id);
                            toast.info("A build is already running — attached to it");
                            return;
                        }
                    } catch (err) {
                        // A token rejected mid-attach must re-prompt, not masquerade
                        // as "a build is already running".
                        if (err instanceof ReefAuthError) {
                            onAuthReject();
                            toast.error("Reef rejected the token — re-enter it");
                            return;
                        }
                        /* otherwise fall through to the generic message */
                    }
                    toast.error("A build is already running");
                })();
                return;
            }
            toast.error(e instanceof Error ? e.message : "Couldn't start the build");
        },
    });

    // One-click build the newest stack for a runtime. The server owns "what's
    // latest"; for ironclaw both floors are null ⇒ build from source. Smart cache
    // by default (base layers cached, plugin/channel re-resolved).
    const buildLatest = (runtimeId: string) => {
        const st = statusByType.get(runtimeId);
        startBuild.mutate({
            agent_type: runtimeId,
            runtime_version: st?.latest_runtime.latest ?? undefined,
            component_version: st?.latest_component.latest ?? undefined,
            force_fresh: false,
        });
    };

    const activate = useMutation({
        mutationFn: (tag: string) => reefActivateImage(apiUrl, tag),
        onSuccess: (_r, tag) => {
            toast.success(`Active image → ${tag}`);
            setActivateTarget(null);
            void queryClient.invalidateQueries({queryKey: ["reef-images", apiUrl]});
            void queryClient.invalidateQueries({queryKey: ["reef-image-status", apiUrl]});
            // The active image moves → re-check the per-runtime signal + the fleet.
            void queryClient.invalidateQueries({queryKey: queryKeys.reefFleet(orgId)});
        },
        onError: (e) => {
            if (e instanceof ReefAuthError) {
                onAuthReject();
                toast.error("Reef rejected the token — re-enter it");
                return;
            }
            toast.error(e instanceof Error ? e.message : "Couldn't set the active image");
        },
    });

    const buildBusy = startBuild.isPending || building;

    return (
        <div className="space-y-4">
            {imagesQuery.isLoading ? (
                <div className="space-y-4">
                    {Array.from({length: 2}).map((_, i) => (
                        <div key={i} className="h-[196px] animate-pulse rounded-2xl bg-muted"/>
                    ))}
                </div>
            ) : imagesQuery.isError ? (
                <div className="rounded-2xl border border-border/60 bg-card px-4 py-6 text-center text-sm text-muted-foreground">
                    Couldn't load images
                    {imagesQuery.error instanceof Error && !(imagesQuery.error instanceof ReefAuthError)
                        ? ` — ${imagesQuery.error.message}`
                        : ""}
                    .
                </div>
            ) : (
                <>
                    {jobId && (
                        <BuildLogPanel
                            job={job}
                            errored={buildJobQuery.isError}
                            onDismiss={() => { setJobId(null); }}
                        />
                    )}
                    {IMAGE_RUNTIMES.map((rt) => (
                        <RuntimeImageBlock
                            key={rt.id}
                            runtime={rt}
                            images={images}
                            status={statusByType.get(rt.id)}
                            fleet={fleet}
                            building={building}
                            buildBusy={buildBusy}
                            onBuildLatest={() => { buildLatest(rt.id); }}
                            onAdvanced={() => { setAdvancedFor(rt.id); }}
                            onSetActive={(img) => { setActivateTarget(img); }}
                            activatePending={activate.isPending}
                        />
                    ))}
                </>
            )}

            {advancedFor && (
                <BuildDialog
                    runtimeId={advancedFor}
                    status={statusByType.get(advancedFor)}
                    pending={startBuild.isPending}
                    onClose={() => { setAdvancedFor(null); }}
                    onBuild={(body) => { startBuild.mutate(body, {onSuccess: () => { setAdvancedFor(null); }}); }}
                />
            )}

            {activateTarget && (
                <ConfirmActivateDialog
                    img={activateTarget}
                    pending={activate.isPending}
                    onCancel={() => { setActivateTarget(null); }}
                    onConfirm={() => { activate.mutate(activateTarget.tag); }}
                />
            )}
        </div>
    );
}

/** One runtime's image, as a big expressive hero: the mascot on a brand-tinted
 *  glow tile, the active image + freshness, the two version axes as large stat
 *  tiles (an amber "→ next" when a build would move one forward), Advanced + build
 *  affordances, the fleet footprint, and the collapsed older-image rollback list.
 *  An empty runtime keeps the same footprint with a single "build one" action. */
function RuntimeImageBlock({
    runtime,
    images,
    status,
    fleet,
    building,
    buildBusy,
    onBuildLatest,
    onAdvanced,
    onSetActive,
    activatePending,
}: {
    runtime: (typeof IMAGE_RUNTIMES)[number];
    images: ReefImage[];
    status: ReefRuntimeImageStatus | undefined;
    fleet: ReefFleetEntry[];
    building: boolean;
    buildBusy: boolean;
    onBuildLatest: () => void;
    onAdvanced: () => void;
    onSetActive: (img: ReefImage) => void;
    activatePending: boolean;
}) {
    const [showOlder, setShowOlder] = useState(false);
    const typeImages = images.filter((i) => (i.agent_type ?? "openclaw") === runtime.id);
    // Prefer the self-describing stack tag over the floating tag (which never moves).
    const activeTags = typeImages.filter((i) => i.is_active);
    const active =
        activeTags.find((i) => /^reef-(oc|ic):(oc|ic).+-(pl|ch)/.test(i.tag)) ??
        activeTags.find((i) => !i.tag.endsWith(":plugin") && !i.tag.endsWith(":channel")) ??
        activeTags[0] ??
        null;
    const older = typeImages.filter((i) => !i.is_active);

    const buildAvailable = Boolean(status?.build_available);
    // A floor to compare against exists (openclaw when checks are on; ironclaw has
    // none yet, so it shows no freshness dot — honest).
    const hasFloor = Boolean(status?.latest_runtime.latest) || Boolean(status?.latest_component.latest);
    const staleCount = fleet.filter((e) => e.agent_type === runtime.id && e.upgrade_available).length;

    // The version each axis would move to when a build is worth it (server floor
    // differs from the baked value) — rendered as an amber "→ next" on the tile.
    const engineNext =
        buildAvailable && status?.latest_runtime.latest && active?.runtime_version !== status.latest_runtime.latest
            ? status.latest_runtime.latest
            : null;
    const componentNext =
        buildAvailable && status?.latest_component.latest && active?.component_version !== status.latest_component.latest
            ? status.latest_component.latest
            : null;

    // Empty runtime: the same hero footprint, one call to action (the mascot is
    // dimmed to read as "nothing here yet" without losing its identity).
    if (typeImages.length === 0) {
        return (
            <div className="flex flex-col items-center gap-4 rounded-2xl border border-dashed border-border/70 bg-card p-6 text-center sm:flex-row sm:text-left">
                <span className="opacity-60 grayscale"><RuntimeLogoTile runtime={runtime}/></span>
                <div className="min-w-0 flex-1">
                    <p className="text-lg font-semibold tracking-tight text-foreground">No {runtime.label} image yet</p>
                    <p className="mt-0.5 text-sm text-muted-foreground">Build one so {runtime.label} agents have something to boot.</p>
                </div>
                <Button onClick={onBuildLatest} disabled={buildBusy} size="lg" className="shrink-0">
                    <Icon icon={building ? Refresh : Sparkles} className={cn("size-4", building && "animate-spin")}/>
                    {building ? "Building…" : "Build"}
                </Button>
            </div>
        );
    }

    const built = relativeTime(active?.created_at);

    return (
        <div
            className={cn(
                "relative overflow-hidden rounded-2xl border bg-card p-5 transition-colors sm:p-6",
                buildAvailable ? "border-amber-500/25" : "border-border/60",
            )}
        >
            {/* When a newer build is a click away, a soft amber wash gives the
                card a quiet "wants attention" glow (echoes the connection card). */}
            {buildAvailable && (
                <div aria-hidden className="pointer-events-none absolute inset-0 bg-gradient-to-br from-amber-500/[0.06] via-transparent to-transparent"/>
            )}

            <div className="relative flex flex-col gap-4 sm:flex-row sm:items-center">
                <RuntimeLogoTile runtime={runtime}/>
                <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                        <h3 className="text-xl font-semibold tracking-tight text-foreground">{runtime.label}</h3>
                        {buildAvailable ? (
                            <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
                                <span className="size-1.5 rounded-full bg-amber-500"/>
                                Update available
                            </span>
                        ) : hasFloor ? (
                            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                                <span className="size-1.5 rounded-full bg-emerald-500"/>
                                Up to date
                            </span>
                        ) : null}
                        {built && <span className="text-xs text-muted-foreground">updated {built}</span>}
                    </div>
                    <p className="mt-1 truncate font-mono text-[13px] text-muted-foreground">
                        {active ? active.tag : `${runtime.label} — no active image`}
                    </p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5 self-start sm:self-center">
                    <Button onClick={onAdvanced} disabled={buildBusy} size="lg" variant="ghost" className="text-muted-foreground">
                        Advanced
                    </Button>
                    <Button
                        onClick={onBuildLatest}
                        disabled={buildBusy}
                        size="lg"
                        variant={buildAvailable ? "default" : "outline"}
                    >
                        <Icon icon={building ? Refresh : Sparkles} className={cn("size-4", building && "animate-spin")}/>
                        {building ? "Building…" : buildAvailable ? "Build latest" : "Rebuild"}
                    </Button>
                </div>
            </div>

            {/* The two version axes, big — the substance of the card. */}
            <div className="relative mt-5 grid grid-cols-2 gap-3">
                <VersionStat
                    label={runtime.engineLabel}
                    icon={<img src={runtime.logo} alt="" className="size-4 shrink-0 object-contain"/>}
                    value={active?.runtime_version}
                    next={engineNext}
                />
                <VersionStat
                    label={runtime.componentLabel}
                    icon={<ClawbitsGlyph className="size-3.5 shrink-0 text-sky-600 dark:text-sky-400"/>}
                    value={active?.component_version}
                    next={componentNext}
                />
            </div>

            {/* Foot of the card: the stale-agent nudge and a compact older-image
                disclosure, both folded in under one quiet divider. */}
            {(staleCount > 0 || older.length > 0) && (
                <div className="relative mt-4 space-y-3 border-t border-border/50 pt-3">
                    {staleCount > 0 && (
                        <div className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
                            <span className="size-1.5 shrink-0 rounded-full bg-amber-500"/>
                            <span className="tabular-nums">
                                <span className="font-medium">{staleCount}</span> {staleCount === 1 ? "agent is" : "agents are"} on an older image — upgrade in the fleet below.
                            </span>
                        </div>
                    )}
                    {older.length > 0 && (
                        <div>
                            <button
                                type="button"
                                onClick={() => { setShowOlder((s) => !s); }}
                                className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground"
                            >
                                {showOlder ? "Hide" : "Show"} {older.length} older image{older.length === 1 ? "" : "s"}
                                <Icon icon={showOlder ? ArrowUp : ChevronDown} className="size-3"/>
                            </button>
                            {showOlder && (
                                <div className="mt-2.5 overflow-hidden rounded-xl border border-border/50">
                                    {older.map((img) => (
                                        <ImageRow
                                            key={img.tag}
                                            img={img}
                                            onSetActive={() => { onSetActive(img); }}
                                            disabled={activatePending}
                                        />
                                    ))}
                                </div>
                            )}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

/** One version axis as a big stat tile: a small brand glyph + label → the baked
 *  version, large; an amber "→ next" when a build would move it forward. */
function VersionStat({label, icon, value, next}: {label: string; icon: ReactNode; value?: string | null; next?: string | null}) {
    return (
        <div className="rounded-xl bg-muted/40 px-3.5 py-3">
            <p className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                {icon}
                <span className="truncate">{label}</span>
            </p>
            <p className="mt-1 truncate text-2xl font-semibold tracking-tight tabular-nums text-foreground">
                {value ?? "—"}
            </p>
            {next && (
                <p className="mt-0.5 flex items-center gap-1 truncate text-xs font-medium tabular-nums text-amber-600 dark:text-amber-400">
                    <Icon icon={ArrowRight} className="size-3 shrink-0"/>
                    {next}
                </p>
            )}
        </div>
    );
}

/** The streaming build log: a status header (spinner while building) + the log
 *  tail, collapsible, dismissable once the build settles. `job` is null while the
 *  first poll is in flight, or when reef evicted the in-memory job (errored). */
function BuildLogPanel({job, errored, onDismiss}: {job: ReefBuildJob | null; errored: boolean; onDismiss: () => void}) {
    const [open, setOpen] = useState(true);
    const logRef = useRef<HTMLPreElement>(null);
    const logLen = job?.log.length ?? 0;
    // Keep the log pinned to the newest line as it streams.
    useEffect(() => {
        if (open && logRef.current) logRef.current.scrollTo({top: logRef.current.scrollHeight});
    }, [logLen, open]);

    if (!job) {
        return errored ? (
            <div className="flex items-center justify-between gap-2 rounded-2xl border border-border/60 bg-card px-4 py-3 text-xs text-muted-foreground">
                <span>Build status unavailable — refreshed the image list.</span>
                <button type="button" onClick={onDismiss} className="font-medium text-foreground hover:underline">
                    Dismiss
                </button>
            </div>
        ) : (
            <div className="flex items-center gap-2 rounded-2xl border border-border/60 bg-card px-4 py-3 text-xs text-muted-foreground">
                <Icon icon={Refresh} className="size-3.5 animate-spin"/>
                <span>Starting build…</span>
            </div>
        );
    }

    const running = job.status === "running";
    const tone =
        job.status === "succeeded"
            ? "text-emerald-600 dark:text-emerald-400"
            : job.status === "failed"
                ? "text-destructive"
                : "text-muted-foreground";
    const statusIcon = running ? Refresh : job.status === "succeeded" ? Check : Package;

    return (
        <div className="overflow-hidden rounded-2xl border border-border/60 bg-card">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border/50 px-4 py-2.5">
                <Icon icon={statusIcon} className={cn("size-4 shrink-0", running && "animate-spin", tone)}/>
                <span className={cn("text-sm font-medium", tone)}>
                    {running ? "Building…" : job.status === "succeeded" ? "Build succeeded" : "Build failed"}
                </span>
                {job.agent_type && <span className="text-xs text-muted-foreground">{job.agent_type}</span>}
                {job.runtime_version && <span className="text-xs text-muted-foreground">engine {job.runtime_version}</span>}
                {job.error && <span className="truncate text-xs text-destructive">· {job.error}</span>}
                <div className="ml-auto flex shrink-0 items-center gap-1">
                    <button
                        type="button"
                        onClick={() => { setOpen((o) => !o); }}
                        className="rounded-md px-2 py-0.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                        {open ? "Hide log" : "Show log"}
                    </button>
                    {!running && (
                        <button
                            type="button"
                            aria-label="Dismiss"
                            onClick={onDismiss}
                            className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                        >
                            <Icon icon={Close} className="size-3.5"/>
                        </button>
                    )}
                </div>
            </div>
            {open && (
                <pre
                    ref={logRef}
                    className="max-h-64 overflow-auto px-4 py-3 font-mono text-[11px] leading-relaxed text-muted-foreground"
                >
                    {job.log.length ? job.log.join("\n") : "Waiting for output…"}
                </pre>
            )}
        </div>
    );
}

/** One local image row (collapsed older list): tag (+ Active pill), the two baked
 *  versions, size · age, and a confirm-gated Set active for non-active rows. */
function ImageRow({
    img,
    onSetActive,
    disabled,
}: {
    img: ReefImage;
    onSetActive: () => void;
    disabled: boolean;
}) {
    return (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border/40 px-4 py-3 transition-colors last:border-b-0 hover:bg-muted/20">
            <div className="flex min-w-0 flex-1 items-center gap-2">
                <span className="truncate font-mono text-[13px] text-foreground">{img.tag}</span>
                {img.is_active && (
                    <span className="shrink-0 rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-600 dark:text-emerald-400">
                        Active
                    </span>
                )}
            </div>
            <div className="flex shrink-0 items-center gap-3 text-xs tabular-nums text-muted-foreground">
                <span title="engine version">{img.runtime_version ?? "—"}</span>
                <span title="component version">{img.component_version ?? "—"}</span>
                <span>{formatBytes(img.size_bytes)}</span>
                <span>{relativeTime(img.created_at) ?? "—"}</span>
                {img.is_active ? (
                    <span className="w-[68px]"/>
                ) : (
                    <Button
                        size="xs"
                        variant="outline"
                        onClick={onSetActive}
                        disabled={disabled}
                        title="Re-point this runtime's active tag at this image (new agents boot it)"
                    >
                        Set active
                    </Button>
                )}
            </div>
        </div>
    );
}

/** Rollback / promote confirm — activating affects every newly-created VM. */
function ConfirmActivateDialog({
    img,
    pending,
    onCancel,
    onConfirm,
}: {
    img: ReefImage;
    pending: boolean;
    onCancel: () => void;
    onConfirm: () => void;
}) {
    return (
        <Dialog open onOpenChange={(next) => { if (!next) onCancel(); }}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>
                        <Icon icon={Package} className="text-muted-foreground"/>
                        Set active image
                    </DialogTitle>
                    <DialogDescription>
                        New agents — and every in-place upgrade — will boot{" "}
                        <span className="font-mono text-foreground">{img.tag}</span>. This affects all
                        newly-created VMs fleet-wide. Existing agents keep running until you upgrade them.
                    </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                    <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
                        Cancel
                    </Button>
                    <Button type="button" onClick={onConfirm} disabled={pending}>
                        <Icon icon={Check} className="size-4"/>
                        {pending ? "Setting…" : "Set active"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

/** Advanced build — pin a specific engine / clawbits-component version (OpenClaw
 *  only; IronClaw derives both from source) and optionally force a from-scratch
 *  rebuild. The per-card "Build latest" / "Rebuild" button skips this and builds
 *  the newest stack; this dialog is the escape hatch for a specific pin. */
function BuildDialog({
    runtimeId,
    status,
    pending,
    onClose,
    onBuild,
}: {
    runtimeId: string;
    status: ReefRuntimeImageStatus | undefined;
    pending: boolean;
    onClose: () => void;
    onBuild: (body: ReefBuildBody) => void;
}) {
    const rt = IMAGE_RUNTIMES.find((r) => r.id === runtimeId);
    const isOpenclaw = runtimeId === "openclaw";
    // Prefill from the server's latest floors so a bare "Build" matches "Build
    // latest"; the operator edits only to pin something older/specific.
    const [engine, setEngine] = useState(status?.latest_runtime.latest ?? "");
    const [component, setComponent] = useState(status?.latest_component.latest ?? "");
    const [forceFresh, setForceFresh] = useState(false);

    const submit = (e: React.SyntheticEvent) => {
        e.preventDefault();
        onBuild({
            agent_type: runtimeId,
            runtime_version: isOpenclaw ? engine.trim() || undefined : undefined,
            component_version: isOpenclaw ? component.trim() || undefined : undefined,
            force_fresh: forceFresh,
        });
    };

    return (
        <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>
                        <Icon icon={Sparkles} className="text-muted-foreground"/>
                        Build {rt?.label ?? ""} image
                    </DialogTitle>
                    <DialogDescription>
                        {isOpenclaw
                            ? "Pin a specific engine or plugin version, or leave them at the latest. New agents boot the image once it's built and set active."
                            : "IronClaw builds from the pinned submodule and the clawbits channel in this tree — the engine and channel versions come from source, so there's nothing to pin."}
                    </DialogDescription>
                </DialogHeader>

                <form onSubmit={submit} className="space-y-4">
                    {isOpenclaw && (
                        <>
                            <label className="block space-y-1.5">
                                <span className="text-xs font-medium text-foreground">OpenClaw version</span>
                                <Input
                                    value={engine}
                                    onChange={(e) => { setEngine(e.target.value); }}
                                    placeholder="latest pinned (Dockerfile default)"
                                    autoComplete="off"
                                    spellCheck={false}
                                />
                            </label>
                            <label className="block space-y-1.5">
                                <span className="text-xs font-medium text-foreground">Clawbits plugin version</span>
                                <Input
                                    value={component}
                                    onChange={(e) => { setComponent(e.target.value); }}
                                    placeholder="latest from clawhub"
                                    autoComplete="off"
                                    spellCheck={false}
                                />
                            </label>
                        </>
                    )}
                    <label className="flex items-center justify-between gap-3 rounded-xl bg-muted/40 px-3.5 py-3">
                        <span className="min-w-0">
                            <span className="block text-[13px] font-medium text-foreground">Force fresh</span>
                            <span className="block text-xs text-muted-foreground">Full no-cache rebuild — slower, ignores cached layers.</span>
                        </span>
                        <Switch checked={forceFresh} onCheckedChange={setForceFresh}/>
                    </label>
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={pending}>
                            <Icon icon={Sparkles} className="size-4"/>
                            {pending ? "Starting…" : "Build"}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

/** The three layers of an agent's software stack. Neutral tiles keep the card
 *  calm; the small brand glyph (OpenClaw red · plugin sky · reef-image violet)
 *  carries the only color, as a quiet identity accent. */
const VERSION_BRANDS = {
    openclaw: {label: "OpenClaw", glyph: <OpenClawGlyph className="size-6"/>},
    plugin: {label: "Plugin", glyph: <ClawbitsGlyph className="size-5 text-sky-600 dark:text-sky-400"/>},
    ironclaw: {label: "IronClaw", glyph: <IronClawGlyph className="size-6"/>},
    channel: {label: "Channel", glyph: <ClawbitsGlyph className="size-5 text-sky-600 dark:text-sky-400"/>},
    hermes: {label: "Hermes", glyph: <HermesGlyph className="size-6"/>},
    image: {label: "Image", glyph: <ReefGlyph className="size-5 text-violet-600 dark:text-violet-400"/>},
} as const;

function VersionChip({brand, value}: {brand: keyof typeof VERSION_BRANDS; value?: string | null}) {
    const b = VERSION_BRANDS[brand];
    return (
        <div
            title={`${b.label} ${value ?? "version unknown"}`}
            className="flex items-center gap-2 rounded-xl bg-muted/50 px-3 py-2.5"
        >
            <span className="shrink-0">{b.glyph}</span>
            <div className="flex min-w-0 flex-col leading-tight">
                <span className="truncate text-[11px] font-medium text-muted-foreground">{b.label}</span>
                <span className="truncate text-[15px] font-semibold tabular-nums text-foreground">{value ?? "—"}</span>
            </div>
        </div>
    );
}

function Stat({label, value, fraction}: {label: string; value: string; fraction?: number}) {
    const pct = fraction != null ? Math.max(0, Math.min(1, fraction)) * 100 : null;
    return (
        <div className="min-w-0">
            <div className="flex items-baseline justify-between gap-2">
                <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">{label}</span>
                <span className="truncate text-xs font-medium tabular-nums text-muted-foreground">{value}</span>
            </div>
            {pct != null && (
                <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted">
                    <div
                        className={cn("h-full rounded-full transition-all", loadBarClass(pct))}
                        style={{width: `${String(pct)}%`}}
                    />
                </div>
            )}
        </div>
    );
}

// OpenSurfaceDialog now lives in @/components/reef/OpenSurfaceDialog (shared with
// the agent home page).
