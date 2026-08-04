import {useState} from "react";
import {useMutation, useQuery, useQueryClient, type UseMutationResult} from "@tanstack/react-query";
import {Icon} from "@/components/Icon";
import {
    LockIcon as Lock,
    Megaphone01Icon as Megaphone,
} from "@hugeicons/core-free-icons";
import {EmptyState} from "@/components/EmptyState";
import {PageHeader} from "@/components/PageHeader";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {Switch} from "@/components/ui/switch";
import {useAuth} from "@/context/AuthContext";
import {useActiveOrg} from "@/hooks/useActiveOrg";
import {
    checkOrgLobstertalkEndpoint,
    getOrgLobstertalk,
    setOrgLobstertalk,
    type OrgLobstertalkHealth,
    type OrgLobstertalkSettings,
    type SetOrgLobstertalkBody,
} from "@/lib/api";
import {queryKeys} from "@/lib/queryKeys";
import {errMsg, toast} from "@/lib/toast";
import {cn} from "@/lib/utils";

type AttentionMode = OrgLobstertalkSettings["mode"];

const MODE_OPTIONS: {value: AttentionMode; label: string}[] = [
    {value: "embedding", label: "Embedding only"},
    {value: "cascade", label: "Embedding + LLM confirm"},
    {value: "llm_only", label: "LLM only"},
    {value: "all", label: "All messages"},
];

/** Modes that use the org-configured LLM endpoint (and so need the form and
 *  the post-save probe). ``all`` deliberately isn't one: it has no triage —
 *  every post is delivered and the agent itself decides. */
const LLM_MODES: readonly AttentionMode[] = ["cascade", "llm_only"];

export default function SettingsLobstertalkPage() {
    const {activeOrgId} = useAuth();
    const queryClient = useQueryClient();

    // Owner-only page. Role comes from the active org's ``my_role`` (a
    // light query that's already cached by the org switcher) so non-owners
    // see the empty state instead of a flash-of-403 from the lobstertalk
    // endpoint. The API enforces the same check independently.
    const {isOwner, isLoading: roleLoading} = useActiveOrg();

    const settingsQuery = useQuery({
        queryKey: activeOrgId ? queryKeys.orgLobstertalk(activeOrgId) : ["org", "none", "lobstertalk"],
        queryFn: () => getOrgLobstertalk(activeOrgId ?? ""),
        enabled: Boolean(activeOrgId) && isOwner,
    });
    const settings = settingsQuery.data;

    // Fired automatically after every save that leaves an LLM mode armed: one
    // live probe against the just-stored config (guard, dial, auth, model,
    // JSON shape — the stages a real triage call runs). The result renders
    // inline, not as a toast: the failure detail is the whole point, and a
    // stored-but-broken endpoint is otherwise invisible until agents go quiet.
    // ``saveNote`` (the mutation variable) is what the save just did — the
    // card's pending line shows it, so these saves get no separate success
    // toast that would declare victory before the verdict is in.
    const healthMutation = useMutation({
        mutationFn: (saveNote: string) => {
            void saveNote; // rendered from mutation.variables, not used here
            return checkOrgLobstertalkEndpoint(activeOrgId ?? "");
        },
    });

    const saveMutation = useMutation({
        mutationFn: (body: SetOrgLobstertalkBody) => setOrgLobstertalk(activeOrgId ?? "", body),
        // The org list is the source of truth for ``attention_enabled``
        // (useActiveOrg reads it), so refetch it alongside our own config.
        // Success feedback: a save that arms an LLM endpoint hands off to the
        // health card (its pending line carries the "saved" note, the verdict
        // follows) — a toast here would declare success moments before the
        // probe can contradict it. Saves with no endpoint in play (embedding,
        // toggle-off) show no card, so they keep the toast; without it the
        // form remount (key input clears by design — it's write-only) reads
        // as a reset, not a confirmed save.
        onSuccess: (_data, body) => {
            const saveNote =
                body.clear_api_key ? "Settings saved, API key removed"
                : body.api_key ? "Settings saved, API key stored"
                : "Settings saved";
            if (body.enabled && LLM_MODES.includes(body.mode)) {
                healthMutation.mutate(saveNote);
            } else {
                toast.success("LobsterTalk settings saved");
                healthMutation.reset(); // no endpoint in play — drop stale status
            }
            if (!activeOrgId) return;
            void queryClient.invalidateQueries({queryKey: queryKeys.orgLobstertalk(activeOrgId)});
            void queryClient.invalidateQueries({queryKey: queryKeys.orgs});
        },
        onError: (err: unknown) => {
            toast.error(err instanceof Error ? err.message : "Failed to update LobsterTalk settings");
        },
    });

    // The toggle persists the server-stored state — not the possibly-dirty
    // triage form — so an unfinished cascade draft can never 422 the flip.
    const toggleEnabled = (next: boolean) => {
        if (!settings) return;
        saveMutation.mutate({
            enabled: next,
            mode: settings.mode,
            base_url: settings.base_url,
            model: settings.model,
            cooldown_seconds: settings.cooldown_seconds,
        });
    };

    if (!activeOrgId) {
        return <div className="text-sm text-muted-foreground">Select an organization.</div>;
    }

    if (roleLoading) {
        return <div className="py-16 text-center text-sm text-muted-foreground">Loading…</div>;
    }

    if (!isOwner) {
        return (
            <div className="space-y-6">
                <PageHeader icon={Megaphone} title="LobsterTalk"/>
                <EmptyState
                    icon={Lock}
                    title="Owner-only"
                    description="LobsterTalk settings are restricted to organization owners. Ask an owner if the attention setup needs a change."
                />
            </div>
        );
    }

    return (
        <div className="space-y-6">
            <PageHeader icon={Megaphone} title="LobsterTalk"/>

            {settingsQuery.isLoading && (
                <div className="py-16 text-center text-sm text-muted-foreground">Loading…</div>
            )}
            {settingsQuery.isError && (
                <p className="py-16 text-center text-sm text-destructive">
                    {settingsQuery.error instanceof Error
                        ? settingsQuery.error.message
                        : "Failed to load LobsterTalk settings"}
                </p>
            )}

            {settings && (
                <>
                    <div className="flex items-start justify-between gap-4 rounded-lg border border-border bg-card px-4 py-3.5">
                        <div className="flex min-w-0 items-start gap-3">
                            <Icon icon={Megaphone} className="mt-0.5 size-4 shrink-0 text-muted-foreground"/>
                            <div className="min-w-0">
                                <p className="text-sm font-medium">LobsterTalk attention</p>
                                <p className="mt-0.5 text-xs text-muted-foreground">
                                    Let agents chime into channel messages they weren't tagged in when a
                                    triage step flags one they can help with. Each agent's operator still
                                    opts in per agent.
                                </p>
                            </div>
                        </div>
                        <Switch
                            checked={settings.enabled}
                            disabled={saveMutation.isPending}
                            onCheckedChange={toggleEnabled}
                            aria-label="LobsterTalk attention for this organization"
                        />
                    </div>

                    {/* Triage config only matters while the gate is armed —
                        with it off nothing runs, so don't show knobs for it.
                        Keyed on the saved config so a successful save (or an
                        outside change) re-seeds the form by remount — the
                        server's normalized values win, the key input clears. */}
                    {settings.enabled && (
                        <>
                            <TriageSection
                                key={[settings.mode, settings.base_url ?? "", settings.model ?? "", String(settings.api_key_set)].join("\0")}
                                settings={settings}
                                pending={saveMutation.isPending}
                                onSave={(body) => { saveMutation.mutate(body); }}
                            />
                            <EndpointHealth mutation={healthMutation}/>
                            <CooldownSection
                                key={String(settings.cooldown_seconds ?? "default")}
                                settings={settings}
                                pending={saveMutation.isPending}
                                onSave={(body) => { saveMutation.mutate(body); }}
                            />
                        </>
                    )}
                </>
            )}
        </div>
    );
}

/** Per-(agent, channel) nudge cooldown. Applies in every mode — it is the
 *  throttle in front of triage/delivery, and in "All messages" mode it is the
 *  ONLY throttle. Empty inherits the server default; messages landing inside
 *  a window are caught up when it expires. */
function CooldownSection({
    settings,
    pending,
    onSave,
}: {
    settings: OrgLobstertalkSettings;
    pending: boolean;
    onSave: (body: SetOrgLobstertalkBody) => void;
}) {
    const [raw, setRaw] = useState(
        settings.cooldown_seconds === null ? "" : String(settings.cooldown_seconds),
    );
    const parsed = raw.trim() === "" ? null : Number(raw);
    const invalid = parsed !== null && (!Number.isInteger(parsed) || parsed < 5 || parsed > 3600);
    const dirty = parsed !== settings.cooldown_seconds;

    const submit = (e: React.SyntheticEvent) => {
        e.preventDefault();
        if (invalid) return;
        onSave({
            enabled: settings.enabled,
            mode: settings.mode,
            base_url: settings.base_url,
            model: settings.model,
            cooldown_seconds: parsed,
        });
    };

    return (
        <section className="space-y-4 rounded-xl border border-border/50 bg-card p-5">
            <div className="space-y-0.5">
                <h2 className="text-sm font-semibold">Nudge cooldown</h2>
                <p className="text-xs text-muted-foreground">
                    Minimum seconds between nudges per agent per channel — the spend
                    throttle in every mode. Messages arriving inside the window are
                    caught up when it expires. Leave empty for the server default
                    ({settings.default_cooldown_seconds}s).
                </p>
            </div>
            <form onSubmit={submit} className="flex max-w-md items-center gap-2">
                <Input
                    id="lobstertalk-cooldown"
                    type="number"
                    inputMode="numeric"
                    min={5}
                    max={3600}
                    step={1}
                    value={raw}
                    onChange={(e) => { setRaw(e.target.value); }}
                    placeholder={`${String(settings.default_cooldown_seconds)} (server default)`}
                    aria-label="Nudge cooldown in seconds"
                    disabled={pending}
                    className="max-w-[180px]"
                />
                <Button type="submit" disabled={pending || invalid || !dirty}>
                    {pending ? "Saving…" : "Save cooldown"}
                </Button>
            </form>
            {invalid && (
                <p className="text-xs text-destructive">
                    Must be a whole number between 5 and 3600 seconds.
                </p>
            )}
        </section>
    );
}

/** Inline result of the post-save endpoint probe, in the same visual language
 *  as the Reef connection card: status dot (pinging halo when healthy, amber
 *  while checking, red on failure), colored verdict, muted detail, latency
 *  pill. Failures stay on screen (unlike a toast) because the detail — bad
 *  key, wrong URL, unusable model — is what the owner acts on. */
function EndpointHealth({
    mutation,
}: {
    mutation: UseMutationResult<OrgLobstertalkHealth, Error, string>;
}) {
    if (mutation.status === "idle") return null;
    const health = mutation.data;
    const pending = mutation.isPending;
    const failed = !pending && (mutation.isError || (health !== undefined && !health.ok));
    const title = pending ? "Checking endpoint…" : failed ? "Endpoint check failed" : "Endpoint OK";
    // While pending, the save confirmation lives here (these saves toast
    // nothing) — the note then yields to the verdict's detail.
    const detail = pending
        ? `${mutation.variables ?? "Settings saved"} — testing the endpoint with one live call.`
        : mutation.isError
            ? errMsg(mutation.error)
            : health?.detail ?? "";
    return (
        <div
            role="status"
            className={cn(
                "flex items-start gap-3 rounded-lg border bg-card px-4 py-3.5",
                failed ? "border-red-500/30" : "border-border",
            )}
        >
            <span className="relative mt-1 flex size-2 shrink-0">
                {!pending && !failed && (
                    <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500/60"/>
                )}
                <span
                    className={cn(
                        "relative inline-flex size-2 rounded-full",
                        pending ? "bg-amber-500" : failed ? "bg-red-500" : "bg-emerald-500",
                    )}
                />
            </span>
            <div className="min-w-0 flex-1">
                <p
                    className={cn(
                        "text-sm font-medium",
                        pending
                            ? "text-amber-600 dark:text-amber-400"
                            : failed
                                ? "text-red-600 dark:text-red-400"
                                : "text-emerald-600 dark:text-emerald-400",
                    )}
                >
                    {title}
                </p>
                {detail && (
                    <p className="mt-0.5 break-words text-xs text-muted-foreground">{detail}</p>
                )}
            </div>
            {health !== undefined && (
                <span
                    className={cn(
                        "shrink-0 rounded-full px-2 py-0.5 text-xs tabular-nums",
                        failed
                            ? "bg-red-500/10 text-red-600 dark:text-red-400"
                            : "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
                    )}
                >
                    {String(health.latency_ms)} ms
                </span>
            )}
        </div>
    );
}


/** Mode picker + the LLM connection form (cascade and llm_only). Form state is seeded
 *  from the saved config once per mount (the parent remounts it on change). */
function TriageSection({
    settings,
    pending,
    onSave,
}: {
    settings: OrgLobstertalkSettings;
    pending: boolean;
    onSave: (body: SetOrgLobstertalkBody) => void;
}) {
    const [mode, setMode] = useState<AttentionMode>(settings.mode);
    const [baseUrl, setBaseUrl] = useState(settings.base_url ?? "");
    const [model, setModel] = useState(settings.model ?? "");
    // The key input is write-only: it starts blank even when a key is stored.
    const [apiKey, setApiKey] = useState("");
    const [clearKey, setClearKey] = useState(false);

    const selectMode = (next: AttentionMode) => {
        setMode(next);
        if (next === settings.mode) return;
        // Embedding and All need no LLM fields — persist right away. The LLM
        // modes only take effect on Save (the server requires base URL + model).
        if (!LLM_MODES.includes(next)) {
            onSave({
                enabled: settings.enabled,
                mode: next,
                base_url: settings.base_url,
                model: settings.model,
                cooldown_seconds: settings.cooldown_seconds,
            });
        }
    };

    // Submits whichever LLM mode is selected (cascade or llm_only) — both
    // need the endpoint form, so they share the Save path.
    const submitLlmMode = (e: React.SyntheticEvent) => {
        e.preventDefault();
        const body: SetOrgLobstertalkBody = {
            enabled: settings.enabled,
            mode,
            base_url: baseUrl.trim() || null,
            model: model.trim() || null,
            cooldown_seconds: settings.cooldown_seconds,
        };
        const key = apiKey.trim();
        if (clearKey) body.clear_api_key = true;
        else if (key) body.api_key = key;
        onSave(body);
    };

    return (
        <>
            <section className="space-y-5 rounded-xl border border-border/50 bg-card p-5">
                <div className="space-y-0.5">
                    <h2 className="text-sm font-semibold">Triage mode</h2>
                    <p className="text-xs text-muted-foreground">
                        How messages are picked for a nudge. The embedding gate is a free
                        local filter; the LLM reads the recent conversation — precise, but
                        one model call each time it's consulted. Cascade asks it only about
                        gate hits; LLM only skips the gate and asks about every message.
                        All messages skips triage entirely — each message becomes a nudge
                        (one per cooldown window) and the agent itself decides whether to
                        reply.
                    </p>
                </div>

                <div
                    role="radiogroup"
                    aria-label="Triage mode"
                    className="inline-flex w-full max-w-xl gap-1 rounded-lg border border-border bg-muted/40 p-1"
                >
                    {MODE_OPTIONS.map(opt => {
                        const active = mode === opt.value;
                        return (
                            <button
                                key={opt.value}
                                type="button"
                                role="radio"
                                aria-checked={active}
                                disabled={pending}
                                onClick={() => { selectMode(opt.value); }}
                                className={cn(
                                    "flex flex-1 items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                                    active
                                        ? "bg-background text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.06)] ring-1 ring-border/60"
                                        : "text-muted-foreground hover:bg-background/40 hover:text-foreground",
                                )}
                            >
                                {opt.label}
                            </button>
                        );
                    })}
                </div>
            </section>

            {LLM_MODES.includes(mode) && (
                <section className="space-y-5 rounded-xl border border-border/50 bg-card p-5">
                    <div className="space-y-0.5">
                        <h2 className="text-sm font-semibold">
                            {mode === "cascade" ? "LLM confirm" : "LLM triage"}
                        </h2>
                        <p className="text-xs text-muted-foreground">
                            {mode === "cascade"
                                ? "Any OpenAI-compatible chat endpoint. If it's misconfigured or down, LobsterTalk falls back to the embedding gate's verdict — agents are never silently muted."
                                : "Any OpenAI-compatible chat endpoint. It alone decides which agents to nudge, so if it's misconfigured or down, no nudges are sent until it recovers."}
                        </p>
                    </div>

                    <form onSubmit={submitLlmMode} className="max-w-md space-y-4">
                        <div className="space-y-1.5">
                            <label htmlFor="lobstertalk-base-url" className="block text-sm font-medium">
                                Base URL
                            </label>
                            <Input
                                id="lobstertalk-base-url"
                                type="url"
                                inputMode="url"
                                autoComplete="off"
                                value={baseUrl}
                                onChange={(e) => { setBaseUrl(e.target.value); }}
                                placeholder="https://api.openai.com/v1"
                                disabled={pending}
                            />
                            <p className="text-xs text-muted-foreground">
                                Anthropic: <code>https://api.anthropic.com/v1</code>. Must be
                                https and resolve to a public address — a self-hosted model
                                (e.g. Ollama on <code>localhost</code>) has to be allowed by
                                whoever runs this server.
                            </p>
                        </div>

                        <div className="space-y-1.5">
                            <label htmlFor="lobstertalk-model" className="block text-sm font-medium">
                                Model
                            </label>
                            <Input
                                id="lobstertalk-model"
                                autoComplete="off"
                                value={model}
                                onChange={(e) => { setModel(e.target.value); }}
                                placeholder="gpt-4o-mini"
                                disabled={pending}
                            />
                            <p className="text-xs text-muted-foreground">
                                A small, fast model works best — it answers one yes/no question per
                                flagged message.
                            </p>
                        </div>

                        <div className="space-y-1.5">
                            <label htmlFor="lobstertalk-api-key" className="block text-sm font-medium">
                                API key
                            </label>
                            <div className="flex items-center gap-2">
                                <Input
                                    id="lobstertalk-api-key"
                                    type="password"
                                    autoComplete="off"
                                    value={apiKey}
                                    onChange={(e) => {
                                        setApiKey(e.target.value);
                                        // Typing a replacement cancels a pending removal —
                                        // the two are mutually exclusive on the server.
                                        if (e.target.value) setClearKey(false);
                                    }}
                                    placeholder={
                                        settings.api_key_set && !clearKey
                                            ? "Saved — leave blank to keep"
                                            : "sk-…"
                                    }
                                    disabled={pending}
                                />
                                {settings.api_key_set && !clearKey && (
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="sm"
                                        className="shrink-0 text-muted-foreground hover:text-destructive"
                                        onClick={() => { setClearKey(true); setApiKey(""); }}
                                        disabled={pending}
                                    >
                                        Remove key
                                    </Button>
                                )}
                            </div>
                            {clearKey ? (
                                <p className="text-xs text-amber-600 dark:text-amber-400">
                                    The stored key will be removed when you save.{" "}
                                    <button
                                        type="button"
                                        className="font-medium underline underline-offset-2"
                                        onClick={() => { setClearKey(false); }}
                                    >
                                        Undo
                                    </button>
                                </p>
                            ) : (
                                <p className="text-xs text-muted-foreground">
                                    Stored encrypted and never shown again. Leave empty for local
                                    servers like Ollama.
                                </p>
                            )}
                        </div>

                        <Button
                            type="submit"
                            disabled={pending || !baseUrl.trim() || !model.trim()}
                        >
                            {pending ? "Saving…" : "Save"}
                        </Button>
                    </form>
                </section>
            )}
        </>
    );
}
