import {useState} from "react";
import {useMutation, useQuery, useQueryClient, type UseMutationResult} from "@tanstack/react-query";
import {
    HashtagIcon as Hash,
    LockIcon as Lock,
    Megaphone01Icon as Megaphone,
} from "@hugeicons/core-free-icons";
import {ChannelGlyph} from "@/components/ChannelGlyph";
import {EmptyState} from "@/components/EmptyState";
import {PageHeader} from "@/components/PageHeader";
import {SettingsPage, SettingsRow, SettingsRowSkeleton, SettingsSection, SettingsStatus} from "@/components/settings/Settings";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {Select, SelectContent, SelectItem, SelectTrigger, SelectValue} from "@/components/ui/select";
import {Stepper} from "@/components/ui/stepper";
import {Switch} from "@/components/ui/switch";
import {useAuth} from "@/context/AuthContext";
import {useActiveOrg} from "@/hooks/useActiveOrg";
import {
    checkOrgLobstertalkEndpoint,
    getOrgLobstertalk,
    listAllOrgChannels,
    setOrgLobstertalk,
    setOrgLobstertalkChannel,
    type OrgLobstertalkHealth,
    type OrgLobstertalkSettings,
    type SetOrgLobstertalkBody,
} from "@/lib/api";
import {formatChannelTitle} from "@/lib/formatting";
import {queryKeys} from "@/lib/queryKeys";
import {errMsg, toast} from "@/lib/toast";

type AttentionMode = OrgLobstertalkSettings["mode"];

type Save = (body: SetOrgLobstertalkBody, quiet?: boolean) => void;

const MODE_OPTIONS: {value: AttentionMode; label: string; line: string}[] = [
    {value: "embedding", label: "Embedding only", line: "A free local embedding gate picks the messages"},
    {value: "cascade", label: "Embedding + LLM", line: "The LLM confirms each embedding gate hit"},
    {value: "llm_only", label: "LLM only", line: "The LLM reads every message, one call each"},
    {value: "all", label: "All messages", line: "No triage: every message nudges and the agent decides"},
];

/** Modes that use the org-configured LLM endpoint, so they need the form and
 *  the post-save probe. ``all`` has no triage: the agent itself decides. */
const LLM_MODES: readonly AttentionMode[] = ["cascade", "llm_only"];

const storedBody = (s: OrgLobstertalkSettings): SetOrgLobstertalkBody => ({
    enabled: s.enabled,
    mode: s.mode,
    base_url: s.base_url,
    model: s.model,
    cooldown_seconds: s.cooldown_seconds,
});

export default function SettingsLobstertalkPage() {
    const {activeOrgId} = useAuth();
    const queryClient = useQueryClient();

    // The lobstertalk endpoint is admin-only on the server, so the fetch waits
    // on the cheap cached role check and non-admins never flash a 403.
    const {isOwner, isLoading: roleLoading} = useActiveOrg();

    const settingsQuery = useQuery({
        queryKey: activeOrgId ? queryKeys.orgLobstertalk(activeOrgId) : ["org", "none", "lobstertalk"],
        queryFn: () => getOrgLobstertalk(activeOrgId ?? ""),
        enabled: Boolean(activeOrgId) && isOwner,
    });
    const settings = settingsQuery.data;

    // Both mutations carry their org in the variables, bound at click time,
    // so switching orgs mid-save can't make the follow-up probe spend the new
    // org's metered LLM call or write the wrong cache key.
    const healthMutation = useMutation({
        mutationFn: ({orgId}: {orgId: string; note: string}) =>
            checkOrgLobstertalkEndpoint(orgId),
    });

    const saveMutation = useMutation({
        mutationFn: ({orgId, body}: {orgId: string; body: SetOrgLobstertalkBody; quiet?: boolean}) =>
            setOrgLobstertalk(orgId, body),
        // The PUT is whole-state, so store the result before the controls
        // re-enable. An LLM save reports through the probe, since a toast would
        // declare success before the verdict; quiet saves (cooldown steps) skip
        // both, as re-probing an unchanged endpoint spends a metered call.
        onSuccess: (data, {orgId, body, quiet}) => {
            queryClient.setQueryData(queryKeys.orgLobstertalk(orgId), data);
            void queryClient.invalidateQueries({queryKey: queryKeys.orgs});
            if (quiet) return;
            if (body.enabled && LLM_MODES.includes(body.mode)) {
                const note =
                    body.clear_api_key ? "Settings saved, API key removed"
                    : body.api_key ? "Settings saved, API key stored"
                    : "Settings saved";
                healthMutation.mutate({orgId, note});
            } else {
                toast.success("LobsterTalk settings saved");
                healthMutation.reset();
            }
        },
        onError: (err: unknown) => {
            toast.error(err instanceof Error ? err.message : "Failed to update LobsterTalk settings");
        },
    });

    if (!activeOrgId) {
        return <div className="text-sm text-muted-foreground">Select an organization.</div>;
    }

    if (roleLoading) {
        return <div className="py-16 text-center text-sm text-muted-foreground">Loading…</div>;
    }

    if (!isOwner) {
        return (
            <>
                <PageHeader icon={Megaphone} title="LobsterTalk"/>
                <EmptyState
                    icon={Lock}
                    title="Admins only"
                    description="LobsterTalk settings are restricted to organization admins. Ask an admin if the attention setup needs a change."
                />
            </>
        );
    }

    const save: Save = (body, quiet) => { saveMutation.mutate({orgId: activeOrgId, body, quiet}); };

    return (
        <>
            <PageHeader icon={Megaphone} title="LobsterTalk"/>

            <SettingsPage>
                {settingsQuery.isLoading && (
                    <SettingsSection>
                        {Array.from({length: 3}, (_, i) => <SettingsRowSkeleton key={i} leading={false}/>)}
                    </SettingsSection>
                )}
                {settingsQuery.isError && (
                    <SettingsSection>
                        <SettingsRow
                            title="Couldn't load LobsterTalk settings"
                            error={errMsg(settingsQuery.error, "Failed to load LobsterTalk settings")}
                        />
                    </SettingsSection>
                )}

                {settings && (
                    <>
                        <SettingsSection
                            footer={
                                <>
                                    Private channels and DMs are never read, and each agent's operator opts in separately.
                                    {!settings.enabled && " LobsterTalk is off: approvals and triage settings are kept and take effect when you turn it on."}
                                </>
                            }
                        >
                            <SettingsRow
                                title="LobsterTalk attention"
                                description="Agents chime in on untagged messages in approved channels"
                                htmlFor="lobstertalk-enabled"
                                control={
                                    <Switch
                                        id="lobstertalk-enabled"
                                        checked={settings.enabled}
                                        disabled={saveMutation.isPending}
                                        // Persists the stored config, not the possibly dirty
                                        // triage draft, so an unfinished draft never 422s the flip.
                                        onCheckedChange={(next) => { save({...storedBody(settings), enabled: next}); }}
                                    />
                                }
                            />
                        </SettingsSection>

                        <ChannelsSection orgId={activeOrgId}/>

                        {/* Stays editable while LobsterTalk is off: a stored endpoint
                            that went bad must remain repairable. Keyed on the saved
                            config so a save re-seeds the draft by remount. */}
                        <TriageSection
                            key={[settings.mode, settings.base_url ?? "", settings.model ?? "", String(settings.api_key_set)].join("\0")}
                            settings={settings}
                            pending={saveMutation.isPending}
                            onSave={save}
                        />
                        {settings.enabled && <EndpointStatus mutation={healthMutation}/>}
                    </>
                )}
            </SettingsPage>
        </>
    );
}

/** Result of the post-save probe. It stays on screen, unlike a toast, because
 *  the failure detail (bad key, wrong URL, unusable model) is what the owner
 *  acts on. */
function EndpointStatus({
    mutation,
}: {
    mutation: UseMutationResult<OrgLobstertalkHealth, Error, {orgId: string; note: string}>;
}) {
    if (mutation.status === "idle") return null;
    const health = mutation.data;
    const pending = mutation.isPending;
    const failed = !pending && (mutation.isError || (health !== undefined && !health.ok));
    const detail = pending
        ? `${mutation.variables?.note ?? "Settings saved"}, testing the endpoint with one live call`
        : mutation.isError
            ? errMsg(mutation.error)
            : health?.detail ?? "";
    return (
        <div role="status">
            <SettingsSection>
                <SettingsRow
                    title={pending ? "Checking endpoint…" : failed ? "Endpoint check failed" : "Endpoint OK"}
                    description={failed ? undefined : detail}
                    error={failed ? detail : undefined}
                    control={
                        <SettingsStatus tone={pending ? "warn" : failed ? "bad" : "ok"}>
                            {health ? `${health.latency_ms} ms` : pending ? "Checking" : "Error"}
                        </SettingsStatus>
                    }
                />
            </SettingsSection>
        </div>
    );
}

/** Mode and cooldown, plus the LLM endpoint form for cascade and llm_only.
 *  The draft is seeded from the saved config once per mount. */
function TriageSection({
    settings,
    pending,
    onSave,
}: {
    settings: OrgLobstertalkSettings;
    pending: boolean;
    onSave: Save;
}) {
    const [mode, setMode] = useState<AttentionMode>(settings.mode);
    const [baseUrl, setBaseUrl] = useState(settings.base_url ?? "");
    const [model, setModel] = useState(settings.model ?? "");
    // Write-only: a stored key is never shown, only replaced or removed.
    const [keyState, setKeyState] = useState<"saved" | "editing" | "removing">(
        settings.api_key_set ? "saved" : "editing",
    );
    const [apiKey, setApiKey] = useState("");

    const selectMode = (next: AttentionMode) => {
        setMode(next);
        // Embedding and All need no LLM fields, so they save right away; the
        // LLM modes wait for Save because the server requires URL and model.
        if (next !== settings.mode && !LLM_MODES.includes(next)) {
            onSave({...storedBody(settings), mode: next});
        }
    };

    const submit = (e: React.SyntheticEvent) => {
        e.preventDefault();
        const body: SetOrgLobstertalkBody = {
            ...storedBody(settings),
            mode,
            base_url: baseUrl.trim() || null,
            model: model.trim() || null,
        };
        const key = apiKey.trim();
        if (keyState === "removing") body.clear_api_key = true;
        else if (key) body.api_key = key;
        onSave(body);
    };

    const cooldown = settings.cooldown_seconds ?? settings.default_cooldown_seconds;

    return (
        <>
            <SettingsSection label="Triage">
                <SettingsRow
                    title="Mode"
                    description={MODE_OPTIONS.find((o) => o.value === mode)?.line}
                    control={
                        <Select
                            value={mode}
                            items={MODE_OPTIONS}
                            onValueChange={(next) => { if (next) selectMode(next); }}
                            disabled={pending}
                        >
                            <SelectTrigger size="sm" aria-label="Triage mode">
                                <SelectValue/>
                            </SelectTrigger>
                            <SelectContent>
                                {MODE_OPTIONS.map((o) => (
                                    <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    }
                />
                <SettingsRow
                    title="Nudge cooldown"
                    description={`Seconds between nudges per agent and channel, default ${settings.default_cooldown_seconds}`}
                    control={
                        <Stepper
                            aria-label="Nudge cooldown in seconds"
                            value={cooldown}
                            min={30}
                            max={3600}
                            step={30}
                            disabled={pending}
                            onChange={(next) => {
                                onSave({
                                    ...storedBody(settings),
                                    cooldown_seconds: next === settings.default_cooldown_seconds ? null : next,
                                }, true);
                            }}
                        />
                    }
                />
            </SettingsSection>

            {LLM_MODES.includes(mode) && (
                <form onSubmit={submit}>
                    <SettingsSection
                        label={mode === "cascade" ? "LLM confirm" : "LLM triage"}
                        footer={
                            <div className="flex items-start justify-between gap-4">
                                <p>
                                    {mode === "cascade"
                                        ? "Falls back to the embedding gate if the endpoint is down."
                                        : "It alone decides, so no nudges are sent while the endpoint is down."}
                                    {" "}Private and local addresses need this server's allowlist.
                                </p>
                                <Button
                                    type="submit"
                                    size="sm"
                                    disabled={pending || !baseUrl.trim() || !model.trim()}
                                >
                                    {pending ? "Saving…" : "Save"}
                                </Button>
                            </div>
                        }
                    >
                        <SettingsRow
                            title="Base URL"
                            description="Any OpenAI-compatible https endpoint"
                            htmlFor="lobstertalk-base-url"
                            control={
                                <Input
                                    size="sm"
                                    id="lobstertalk-base-url"
                                    type="url"
                                    inputMode="url"
                                    autoComplete="off"
                                    value={baseUrl}
                                    onChange={(e) => { setBaseUrl(e.target.value); }}
                                    placeholder="https://api.openai.com/v1"
                                    disabled={pending}
                                    className="w-60"
                                />
                            }
                        />
                        <SettingsRow
                            title="Model"
                            description="A small, fast model: one yes or no per message"
                            htmlFor="lobstertalk-model"
                            control={
                                <Input
                                    size="sm"
                                    id="lobstertalk-model"
                                    autoComplete="off"
                                    value={model}
                                    onChange={(e) => { setModel(e.target.value); }}
                                    placeholder="gpt-4o-mini"
                                    disabled={pending}
                                />
                            }
                        />
                        <SettingsRow
                            title="API key"
                            description={
                                keyState === "removing"
                                    ? "The stored key is removed when you save"
                                    : "Stored encrypted and never shown"
                            }
                            htmlFor={keyState === "editing" ? "lobstertalk-api-key" : undefined}
                            control={
                                keyState === "editing" ? (
                                    <Input
                                        size="sm"
                                        id="lobstertalk-api-key"
                                        type="password"
                                        autoComplete="off"
                                        autoFocus={settings.api_key_set}
                                        value={apiKey}
                                        onChange={(e) => { setApiKey(e.target.value); }}
                                        placeholder={settings.api_key_set ? "Leave blank to keep" : "sk-…"}
                                        disabled={pending}
                                    />
                                ) : keyState === "removing" ? (
                                    <Button type="button" variant="outline" size="sm" onClick={() => { setKeyState("saved"); }}>
                                        Undo
                                    </Button>
                                ) : (
                                    <>
                                        <span className="text-[13px] text-muted-foreground">Saved</span>
                                        <Button
                                            type="button"
                                            variant="outline"
                                            size="sm"
                                            onClick={() => { setKeyState("editing"); }}
                                            disabled={pending}
                                        >
                                            Replace
                                        </Button>
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            size="sm"
                                            className="text-destructive hover:text-destructive"
                                            onClick={() => { setKeyState("removing"); }}
                                            disabled={pending}
                                        >
                                            Remove
                                        </Button>
                                    </>
                                )
                            }
                        />
                    </SettingsSection>
                </form>
            )}
        </>
    );
}

/** Per-channel allowlist, the "where" of LobsterTalk. Closed by default: new
 *  channels start unapproved. Only public channels are eligible (the server
 *  refuses the rest). Shown while the master switch is off so approvals can
 *  be staged before turning it on. */
function ChannelsSection({orgId}: {orgId: string}) {
    const queryClient = useQueryClient();
    const channelsQuery = useQuery({
        queryKey: queryKeys.orgChannels(orgId),
        queryFn: () => listAllOrgChannels(orgId),
    });
    // The admin channels list is the source of truth for the switches
    // (SettingsChannelsPage shares its cache), so refetch rather than patch.
    const approveMutation = useMutation({
        mutationFn: ({orgId, channelId, approved}: {orgId: string; channelId: string; approved: boolean}) =>
            setOrgLobstertalkChannel(orgId, channelId, approved),
        onSuccess: (_data, {orgId}) => {
            void queryClient.invalidateQueries({queryKey: queryKeys.orgChannels(orgId)});
        },
        onError: (err: unknown) => {
            toast.error(err instanceof Error ? err.message : "Failed to update channel approval");
        },
    });
    const publicChannels = (channelsQuery.data?.channels ?? []).filter(
        (c) => c.channel_type === "public",
    );
    const approvedCount = publicChannels.filter((c) => c.lobstertalk_approved).length;
    return (
        <SettingsSection
            label="Approved channels"
            aside={publicChannels.length > 0
                ? `${approvedCount} of ${publicChannels.length} approved`
                : undefined}
            footer="Only public channels are eligible, and new channels start unapproved."
        >
            {channelsQuery.isLoading && Array.from({length: 3}, (_, i) => (
                <SettingsRowSkeleton key={i} description={false}/>
            ))}
            {channelsQuery.isError && (
                <SettingsRow
                    title="Couldn't load channels"
                    error={errMsg(channelsQuery.error, "Failed to load channels")}
                />
            )}
            {channelsQuery.isSuccess && publicChannels.length === 0 && (
                <EmptyState
                    icon={Hash}
                    title="No public channels"
                    description="Public channels in this organization will appear here for approval."
                    className="py-10"
                />
            )}
            {publicChannels.map((channel) => {
                const label = formatChannelTitle(channel.display_name ?? channel.name);
                return (
                    <SettingsRow
                        key={channel.channel_id}
                        leading={<ChannelGlyph channel={channel} size={32}/>}
                        title={label}
                        control={
                            <Switch
                                checked={channel.lobstertalk_approved}
                                disabled={approveMutation.isPending}
                                onCheckedChange={(approved) => {
                                    approveMutation.mutate({orgId, channelId: channel.channel_id, approved});
                                }}
                                aria-label={`LobsterTalk in ${label}`}
                            />
                        }
                    />
                );
            })}
        </SettingsSection>
    );
}
