// The plaintext lives only in EnvEditor's `rows` state - never the query cache,
// a URL, a toast or a log.
import {useEffect, useRef, useState} from "react";
import {useMutation, useQuery, useQueryClient} from "@tanstack/react-query";
import {
    SourceCodeIcon as SourceCode,
    AlertCircleIcon as Alert,
    ArrowLeft01Icon as ArrowLeft,
    Undo02Icon as Undo,
} from "@hugeicons/core-free-icons";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import {Button} from "@/components/ui/button";
import {Icon} from "@/components/Icon";
import {AddEnvRowButton, EnvVarRow} from "@/components/reef/envRows";
import {
    buildEnvPatch,
    envApplyOptions,
    envApplyReach,
    envDraftProblem,
    envPatchIsEmpty,
    envReadOnlyCause,
    toDraftRows,
    type EnvApplyReach,
    type EnvDraftRow,
} from "@/components/reef/envKeys";
import {
    reefAgentEnv, reefPatchEnv, ReefAuthRejected, ReefRequestError,
    ReefSandboxBusyError, retryReefAuthOnce, REEF_AUTH_RETRY_DELAY_MS,
    type ReefAgentEnvView, type ReefEnvApplyMode,
} from "@/lib/reefApi";
import {queryKeys} from "@/lib/queryKeys";
import {toast} from "@/lib/toast";
import {cn} from "@/lib/utils";

// 422 and 503 fall through to reef's own detail, which names the remedy.
function envErrorMessage(e: unknown): string {
    // Only reachable while a rejection is NON-final (the final one closes the
    // dialog), so it reads as a retryable hiccup rather than "your token is wrong".
    if (e instanceof ReefAuthRejected) return "Reef didn't accept that request - try again";
    if (e instanceof ReefSandboxBusyError) return "This agent is busy - try again in a moment";
    if (e instanceof ReefRequestError) {
        if (e.status === 404) return "Reef no longer manages this VM";
        if (e.status === 502) return "Reef runtime unavailable";
    }
    return e instanceof Error ? e.message : "Couldn't save these variables";
}

function storedHint(length: number): string {
    return length === 0 ? "unchanged (empty)" : `unchanged (${String(length)} chars)`;
}

function confirmLabel(mode: ReefEnvApplyMode, reach: EnvApplyReach): string {
    if (mode === "recreate") return "Recreate agent";
    if (mode === "none") return "Save without applying";
    return reach === "now" ? "Restart and apply" : "Save";
}

export function ManageEnvDialog({
    sandboxId,
    managed,
    apiUrl,
    orgId,
    onClose,
    onAuthReject,
}: {
    sandboxId: string;
    /** The fleet row's flag - `GET /env` doesn't report it. See `envReadOnlyCause`. */
    managed: boolean;
    apiUrl: string | null;
    orgId: string;
    onClose: () => void;
    /** Report a failed reef call; true ⇒ the token was dropped (so this dialog
     *  closes and the page re-prompts), false ⇒ possibly a blip, stay open. */
    onAuthReject: (e: unknown) => boolean;
}) {
    // Never polled or refetched on focus: it would clobber a half-typed draft.
    const envQuery = useQuery({
        queryKey: ["reef-agent-env", apiUrl, sandboxId],
        queryFn: () => reefAgentEnv(apiUrl ?? "", sandboxId),
        enabled: Boolean(apiUrl),
        // One shot, so it carries its own auth retry — without a second round the
        // rejection policy could never reach a verdict for this dialog.
        retry: retryReefAuthOnce,
        retryDelay: REEF_AUTH_RETRY_DELAY_MS,
        refetchOnWindowFocus: false,
        staleTime: Infinity,
    });

    // Close only when the rejection is FINAL — a blip leaves the dialog open with
    // its own error state instead of slamming shut and losing the operator's place.
    useEffect(() => {
        if (!(envQuery.error instanceof ReefAuthRejected)) return;
        if (!onAuthReject(envQuery.error)) return;
        toast.error("Reef rejected the token - re-enter it");
        onClose();
    }, [envQuery.error, onAuthReject, onClose]);

    const view = envQuery.data;

    return (
        <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
            <DialogContent className="sm:max-w-xl">
                <DialogHeader>
                    <DialogTitle>
                        <Icon icon={SourceCode} className="text-muted-foreground"/>
                        Environment variables
                    </DialogTitle>
                    <DialogDescription>
                        <span className="font-mono text-foreground">{sandboxId}</span>
                        {" "}- anything you set here is readable by the agent and by anyone
                        with its web terminal. Use scoped, revocable, spend-limited
                        credentials.
                    </DialogDescription>
                </DialogHeader>

                {view ? (
                    <EnvEditor
                        view={view}
                        sandboxId={sandboxId}
                        managed={managed}
                        apiUrl={apiUrl}
                        orgId={orgId}
                        onClose={onClose}
                        onAuthReject={onAuthReject}
                    />
                ) : (
                    <>
                        {envQuery.isError ? (
                            <p className="text-sm text-destructive">{envErrorMessage(envQuery.error)}</p>
                        ) : (
                            <div className="space-y-2.5">
                                <div className="h-9 animate-pulse rounded-md bg-muted"/>
                                <div className="h-9 animate-pulse rounded-md bg-muted"/>
                            </div>
                        )}
                        <DialogFooter>
                            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
                        </DialogFooter>
                    </>
                )}
            </DialogContent>
        </Dialog>
    );
}

// Mounted only once the read has landed, so the draft is seeded exactly once.
function EnvEditor({
    view,
    sandboxId,
    managed,
    apiUrl,
    orgId,
    onClose,
    onAuthReject,
}: {
    view: ReefAgentEnvView;
    sandboxId: string;
    managed: boolean;
    apiUrl: string | null;
    orgId: string;
    onClose: () => void;
    onAuthReject: (e: unknown) => boolean;
}) {
    const queryClient = useQueryClient();
    const [rows, setRows] = useState<EnvDraftRow[]>(() => toDraftRows(view.vars));
    const reach = envApplyReach(view.state, view.desired_state);
    const offered = envApplyOptions(view.apply_modes, reach);
    const [mode, setMode] = useState<ReefEnvApplyMode>(() => offered[0]);
    const [confirming, setConfirming] = useState(false);
    // Not `save.error`: the mutation is reset on every settle, which clears it.
    const [saveError, setSaveError] = useState<string | null>(null);
    const nextId = useRef(0);

    const editable = view.editable;
    const readOnlyCause = envReadOnlyCause(editable, managed);
    const canRestart = view.apply_modes.includes("restart");
    const applyMode: ReefEnvApplyMode = offered.includes(mode) ? mode : offered[0];

    const patch = buildEnvPatch(rows, applyMode);
    const problem = envDraftProblem(rows);
    const empty = envPatchIsEmpty(patch);

    const save = useMutation({
        mutationFn: () => reefPatchEnv(apiUrl ?? "", sandboxId, patch),
        onSuccess: (res) => {
            void queryClient.invalidateQueries({queryKey: queryKeys.reefFleet(orgId)});
            void queryClient.invalidateQueries({queryKey: ["reef-agent-env", apiUrl, sandboxId]});
            void queryClient.invalidateQueries({queryKey: ["reef-surface-detail", apiUrl, sandboxId]});
            toast.success(
                !res.changed
                    ? "No changes to apply"
                    : res.takes_effect === "now"
                        ? `Saved - ${sandboxId} is ${res.applied === "recreate" ? "being recreated" : "restarting"}`
                        : `Saved - takes effect the next time ${sandboxId} starts`,
            );
            onClose();
        },
        onError: (e) => {
            if (e instanceof ReefAuthRejected && onAuthReject(e)) {
                toast.error("Reef rejected the token - re-enter it");
                onClose();
                return;
            }
            const msg = envErrorMessage(e);
            toast.error(msg);
            setSaveError(msg);
            setConfirming(false);
        },
        onSettled: () => {
            // A settled mutation retains `data` and `variables` until it is reset.
            save.reset();
        },
    });

    const patchRow = (id: string, next: Partial<EnvDraftRow>) => {
        setRows((prev) => prev.map((r) => (r.id === id ? {...r, ...next} : r)));
    };

    const addRow = () => {
        nextId.current += 1;
        setRows((prev) => [
            ...prev,
            {id: `new:${String(nextId.current)}`, key: "", value: "", storedLength: null, removed: false, existing: false, tier: null},
        ]);
    };

    const removeRow = (r: EnvDraftRow) => {
        if (r.existing) patchRow(r.id, {removed: true});
        else setRows((prev) => prev.filter((x) => x.id !== r.id));
    };

    const trimmedKey = (r: EnvDraftRow) => r.key.trim();
    const addedKeys = rows.filter((r) => !r.existing && !r.removed && trimmedKey(r).length > 0).map(trimmedKey);
    const changedKeys = rows.filter((r) => r.existing && !r.removed && r.value !== null).map(trimmedKey);
    const removedKeys = rows.filter((r) => r.existing && r.removed).map(trimmedKey);

    const busy = save.isPending;
    const blocked = !editable || problem !== null || empty || busy;

    return (
        <>
            {confirming ? (
                <ConfirmStep
                    sandboxId={sandboxId}
                    mode={applyMode}
                    reach={reach}
                    desiredRunning={view.desired_state === "running"}
                    added={addedKeys}
                    changed={changedKeys}
                    removed={removedKeys}
                />
            ) : (
                <div className="max-h-[52vh] space-y-4 overflow-y-auto">
                    {readOnlyCause === "drift" && (
                        <p className="rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
                            Reef has no record for this VM - it found it in the runtime rather
                            than creating it - so its variables are read-only here. The list
                            below is complete.
                        </p>
                    )}
                    {readOnlyCause === "degraded" && (
                        <p className="rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
                            Reef couldn't read this agent's image, so this list is incomplete:
                            it shows the variables reef has written itself, not the ones baked
                            in when the agent was created. Editing is off until that read
                            recovers - a save would fail rather than risk pinning stale values.
                        </p>
                    )}

                    <div className="flex flex-col gap-2.5">
                        {rows.length === 0 && (
                            <p className="text-[13px] text-muted-foreground">
                                No variables of your own yet.
                            </p>
                        )}
                        {rows.map((r) => (r.removed ? (
                            <div key={r.id} className="flex items-center gap-2 rounded-lg bg-destructive/[0.06] px-3 py-2">
                                <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-muted-foreground line-through">
                                    {r.key}
                                </span>
                                <span className="shrink-0 text-[11px] font-medium text-destructive">
                                    will be removed
                                </span>
                                <button
                                    type="button"
                                    onClick={() => { patchRow(r.id, {removed: false}); }}
                                    disabled={busy}
                                    aria-label={`Keep ${r.key}`}
                                    className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                                >
                                    <Icon icon={Undo} className="size-3.5"/>
                                </button>
                            </div>
                        ) : (
                            <EnvVarRow
                                key={r.id}
                                row={{key: r.key, value: r.value ?? ""}}
                                disabled={busy || !editable}
                                lockKey={r.existing}
                                secret
                                valuePlaceholder={r.existing && r.storedLength !== null ? storedHint(r.storedLength) : "value"}
                                removeLabel={`Remove ${r.key || "variable"}`}
                                onChange={(next) => {
                                    // Cleared box = untouched, not "set to empty".
                                    patchRow(r.id, {
                                        key: r.existing ? r.key : next.key,
                                        value: r.existing && next.value === "" ? null : next.value,
                                    });
                                }}
                                onRemove={() => { removeRow(r); }}
                            />
                        )))}
                        {editable && <AddEnvRowButton disabled={busy} onClick={addRow}/>}
                    </div>

                    {rows.some((r) => r.existing && !r.removed) && (
                        <p className="px-1 text-xs text-muted-foreground">
                            Values are never shown. Leave a box empty to keep the stored value
                            as it is - clearing it doesn't blank it. To make one empty on
                            purpose, remove the variable and add it back.
                        </p>
                    )}

                    {problem !== null && <p className="px-1 text-xs text-destructive">{problem}</p>}

                    {editable && (
                        <ApplyModePicker
                            offered={offered}
                            value={applyMode}
                            canRestart={canRestart}
                            reach={reach}
                            disabled={busy}
                            onChange={setMode}
                        />
                    )}
                </div>
            )}

            {saveError !== null && (
                <p className="flex items-start gap-2 rounded-lg bg-destructive/[0.07] px-3 py-2.5 text-[13px] text-destructive">
                    <Icon icon={Alert} className="mt-0.5 size-4 shrink-0"/>
                    <span>{saveError}</span>
                </p>
            )}

            <DialogFooter>
                {confirming ? (
                    <>
                        <Button
                            type="button"
                            variant="ghost"
                            disabled={busy}
                            onClick={() => { setConfirming(false); setSaveError(null); }}
                        >
                            <Icon icon={ArrowLeft} className="size-4"/>
                            Back
                        </Button>
                        <Button
                            type="button"
                            variant={applyMode === "recreate" ? "destructive" : "default"}
                            disabled={busy}
                            onClick={() => { setSaveError(null); save.mutate(); }}
                        >
                            {busy ? "Applying…" : confirmLabel(applyMode, reach)}
                        </Button>
                    </>
                ) : (
                    <>
                        <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
                            Cancel
                        </Button>
                        <Button
                            type="button"
                            disabled={blocked}
                            onClick={() => { setSaveError(null); setConfirming(true); }}
                        >
                            Save changes
                        </Button>
                    </>
                )}
            </DialogFooter>
        </>
    );
}

function ApplyModePicker({
    offered,
    value,
    canRestart,
    reach,
    disabled,
    onChange,
}: {
    offered: ReefEnvApplyMode[];
    value: ReefEnvApplyMode;
    canRestart: boolean;
    reach: EnvApplyReach;
    disabled: boolean;
    onChange: (m: ReefEnvApplyMode) => void;
}) {
    const options: {id: ReefEnvApplyMode; label: string; line: string}[] = [
        {id: "restart", label: "Restart", line: "In place. Config, sessions and identity survive."},
        {id: "recreate", label: "Recreate", line: "Rebuilds the container. ~/.openclaw is lost."},
        {id: "none", label: "Don't apply", line: "Write only; takes effect on the next start."},
    ];
    const shown = options.filter((o) => offered.includes(o.id));
    return (
        <div className="space-y-2">
            {!canRestart && (
                <p className="flex items-start gap-2 rounded-lg bg-amber-500/[0.08] px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                    <Icon icon={Alert} className="mt-px size-3.5 shrink-0"/>
                    <span>
                        This agent's image can't read variables from disk, so there is no way
                        to hand it one without rebuilding the container - saving without
                        applying would write a file it never reads. Upgrade it (one recreate
                        now, restarts forever after), or accept a recreate this once.
                    </span>
                </p>
            )}
            {canRestart && reach === "stopping" && (
                <p className="rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
                    You stopped this agent, so reef writes the change and starts nothing -
                    not even the restart it would normally do. The agent reads it the next
                    time you start it.
                </p>
            )}
            {canRestart && reach === "down" && (
                <p className="rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
                    This agent isn't running, so there is nothing to restart. The change is
                    written now and the agent reads it the next time it boots.
                </p>
            )}
            {shown.length > 1 && (
            <div className="grid gap-2 sm:grid-cols-3">
                {shown.map((o) => (
                    <button
                        key={o.id}
                        type="button"
                        disabled={disabled}
                        aria-pressed={value === o.id}
                        onClick={() => { onChange(o.id); }}
                        className={cn(
                            "rounded-xl border p-2.5 text-left transition-colors disabled:opacity-50",
                            value === o.id
                                ? "border-foreground/40 bg-foreground/[0.05]"
                                : "border-border/50 hover:border-foreground/25",
                        )}
                    >
                        <span className="block text-[13px] font-medium">{o.label}</span>
                        <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">{o.line}</span>
                    </button>
                ))}
            </div>
            )}
        </div>
    );
}

// Names keys only, never a value.
function ConfirmStep({
    sandboxId,
    mode,
    reach,
    desiredRunning,
    added,
    changed,
    removed,
}: {
    sandboxId: string;
    mode: ReefEnvApplyMode;
    reach: EnvApplyReach;
    desiredRunning: boolean;
    added: string[];
    changed: string[];
    removed: string[];
}) {
    const lines = [
        {label: "Add", keys: added},
        {label: "Replace", keys: changed},
        {label: "Remove", keys: removed},
    ].filter((l) => l.keys.length > 0);
    return (
        <div className="space-y-3.5">
            <ul className="space-y-1.5 rounded-xl border border-border/50 p-3 text-[13px]">
                {lines.map((l) => (
                    <li key={l.label} className="flex gap-2">
                        <span className="shrink-0 font-medium text-muted-foreground">{l.label}</span>
                        <span className="min-w-0 flex-1 break-words font-mono text-[12px]">{l.keys.join(", ")}</span>
                    </li>
                ))}
            </ul>
            {mode === "recreate" ? (
                <p className="flex items-start gap-2 rounded-lg bg-destructive/[0.07] px-3 py-2.5 text-[13px] text-destructive">
                    <Icon icon={Alert} className="mt-0.5 size-4 shrink-0"/>
                    <span>
                        The container is destroyed and rebuilt. The workspace volume, clawbits
                        identity and access password survive, but <span className="font-mono">~/.openclaw</span>{" "}
                        does not: the config store, chat sessions, device identity and any skill
                        installed after boot are lost, and the default model is re-pinned.
                        {desiredRunning
                            ? reach !== "now" && " Reef brings it back up as part of the rebuild."
                            : " It stays stopped afterwards, with the new values in place for the next start."}
                    </span>
                </p>
            ) : reach === "stopping" ? (
                <p className="text-[13px] text-muted-foreground">
                    You stopped {sandboxId}, and an env edit never starts an agent back up -
                    reef writes the change and leaves it alone. It takes effect the next time
                    you start it.
                </p>
            ) : reach === "down" ? (
                <p className="text-[13px] text-muted-foreground">
                    {sandboxId} isn't running, and an env edit never starts an agent that is
                    down. The change is written now and takes effect{" "}
                    {desiredRunning ? "the next time it comes up." : "the next time you start it."}
                </p>
            ) : mode === "restart" ? (
                <p className="text-[13px] text-muted-foreground">
                    The agent restarts in place. Its workspace, config, chat sessions and
                    identity are preserved; expect a few seconds of downtime.
                </p>
            ) : (
                <p className="text-[13px] text-muted-foreground">
                    Nothing is applied now: the change is written and this agent picks it up
                    the next time it restarts, whenever that is.
                </p>
            )}
        </div>
    );
}
