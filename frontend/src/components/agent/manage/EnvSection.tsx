/**
 * EnvSection — per-agent environment variables on the agent Manage page, for
 * reef-backed agents only (gated on ``profile.reef_sandbox_id`` by the caller).
 *
 * Deliberately narrower than the operator panel in Settings → Reef:
 *
 * - **One apply mode, never shown.** Saves always go out as ``apply:"restart"``.
 *   Recreate is not offered at any price: it destroys ``~/.openclaw`` (config,
 *   sessions, device identity) and silently re-pins the model, which is not a
 *   thing to put behind a save button on a page like this. An agent whose image
 *   predates the in-place reader therefore reads as read-only rather than being
 *   handed the destructive path.
 * - **Two tiers, defaulted by name.** A "secret" is write-only: reef holds the
 *   plaintext but hands it back to nobody, so it shows as dots forever. A
 *   "regular" value can be read again. The default comes from the KEY NAME
 *   (``defaultTierFor``, the same heuristic reef uses), because a flat
 *   regular-by-default would publish a pasted credential for want of a ticked
 *   box. The lock per row is an override, not a required decision.
 *
 * The draft/diff logic is shared with the operator panel via ``envKeys`` so the
 * two cannot disagree about what a given edit means on the wire.
 */
import {useMemo, useRef, useState} from "react";
import {useMutation, useQuery, useQueryClient} from "@tanstack/react-query";
import {
    Alert02Icon,
    Delete02Icon,
    KeyIcon,
    MoreHorizontalIcon,
    Copy01Icon,
    LockIcon,
    PencilEdit02Icon,
    RefreshIcon,
    SquareUnlock02Icon,
    Tick02Icon,
    ViewIcon,
    ViewOffSlashIcon,
} from "@hugeicons/core-free-icons";
import {getReefConnection} from "@/lib/api";
import type {ReefEnvTier} from "@/lib/reefApi";
import {
    ReefAuthError,
    ReefUnreachableError,
    hasReefToken,
    reefAgentEnv,
    reefPatchEnv,
    setReefToken,
} from "@/lib/reefApi";
import {
    buildEnvPatch,
    effectiveTier,
    envDraftProblem,
    envPatchIsEmpty,
    toDraftRows,
    type EnvDraftRow,
} from "@/components/reef/envKeys";
import {queryKeys} from "@/lib/queryKeys";
import {errMsg, toast} from "@/lib/toast";
import {cn} from "@/lib/utils";
import {Icon} from "@/components/Icon";
import {SectionHeader} from "@/components/automations/SectionHeader";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {ManageAddButton} from "./ManageAddButton";

/** A quiet framed state: one icon, one line, an optional action. Every
 *  not-yet-a-list state uses this so they read as one family. */
function EnvNotice({
    icon,
    children,
    action,
}: {
    icon: typeof KeyIcon;
    children: React.ReactNode;
    action?: React.ReactNode;
}) {
    return (
        <div className="flex items-center gap-3 rounded-xl border border-border/60 bg-card px-4 py-3.5">
            <Icon icon={icon} className="size-4 shrink-0 text-muted-foreground"/>
            <p className="min-w-0 flex-1 text-caption text-muted-foreground">{children}</p>
            {action}
        </div>
    );
}

export function EnvSection({orgId, sandboxId}: {orgId: string; sandboxId: string}) {
    const queryClient = useQueryClient();
    const connQuery = useQuery({
        queryKey: queryKeys.reefConnection(orgId),
        queryFn: () => getReefConnection(orgId),
        enabled: Boolean(orgId),
    });
    const apiUrl = connQuery.data?.api_url ?? null;

    // The admin token is session-held (lib/reefApi) and shared with Settings →
    // Reef, so unlocking in one place unlocks the other for this tab.
    const [tokenSet, setTokenSet] = useState(hasReefToken());
    const [tokenInput, setTokenInput] = useState("");

    const envQuery = useQuery({
        queryKey: queryKeys.reefAgentEnv(orgId, sandboxId),
        queryFn: () => reefAgentEnv(apiUrl ?? "", sandboxId),
        enabled: Boolean(apiUrl) && tokenSet,
        retry: false,
    });

    // A rejected token re-locks rather than reading as "reef is down".
    const authRejected = envQuery.error instanceof ReefAuthError;
    const unreachable =
        envQuery.error instanceof ReefUnreachableError ||
        (connQuery.isSuccess && apiUrl === null);

    const data = envQuery.data ?? null;
    const serverVars = data?.vars ?? [];
    // Read-only when reef says so, OR when this agent's image has no in-place
    // reader: the only other way in is recreate, which this page never offers.
    const canEdit = Boolean(data?.editable) && (data?.apply_modes ?? []).includes("restart");

    const [draft, setDraft] = useState<EnvDraftRow[] | null>(null);
    // Which rows are in edit mode. Purely presentational, so it stays out of the
    // draft rows (which are the shared wire shape in ``envKeys``).
    const [editingIds, setEditingIds] = useState<ReadonlySet<string>>(new Set());
    const nextId = useRef(0);
    const rows = draft ?? toDraftRows(serverVars);
    const dirty = draft !== null;

    const patch = useMemo(() => buildEnvPatch(rows, "restart"), [rows]);
    const problem = useMemo(() => envDraftProblem(rows), [rows]);
    const nothingToSave = envPatchIsEmpty(patch);

    const edit = (next: EnvDraftRow[]) => { setDraft(next); };
    const patchRow = (id: string, part: Partial<EnvDraftRow>) => {
        edit(rows.map(r => (r.id === id ? {...r, ...part} : r)));
    };
    const reset = () => {
        setDraft(null);
        setEditingIds(new Set());
    };

    const save = useMutation({
        mutationFn: () => reefPatchEnv(apiUrl ?? "", sandboxId, patch),
        onSuccess: (res) => {
            reset();
            void queryClient.invalidateQueries({
                queryKey: queryKeys.reefAgentEnv(orgId, sandboxId),
            });
            // Honest about the one thing the user can observe: the agent bounced.
            toast.success(
                res.takes_effect === "now" ? "Saved. The agent restarted." : "Saved. Applies on next start.",
            );
        },
        onError: (e: unknown) => {
            if (e instanceof ReefAuthError) {
                setReefToken(null);
                setTokenSet(false);
                return;
            }
            toast.error(errMsg(e, "Couldn't save"));
        },
    });

    const header = (
        <div className="flex items-center justify-between gap-3">
            <SectionHeader icon={KeyIcon}>Environment variables</SectionHeader>
            {canEdit && (
                <ManageAddButton
                    disabled={save.isPending}
                    onClick={() => {
                        nextId.current += 1;
                        const id = `new:${String(nextId.current)}`;
                        setEditingIds(prev => new Set(prev).add(id));
                        edit([
                            ...rows,
                            {
                                id,
                                key: "",
                                value: "",
                                storedLength: null,
                                removed: false,
                                existing: false,
                                tier: null,
                            },
                        ]);
                    }}
                />
            )}
        </div>
    );

    let body: React.ReactNode;
    if (unreachable) {
        body = (
            <EnvNotice
                icon={Alert02Icon}
                action={
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => { void envQuery.refetch(); void connQuery.refetch(); }}
                    >
                        <Icon icon={RefreshIcon} className="size-3.5"/>
                        Retry
                    </Button>
                }
            >
                Can&apos;t reach Reef.
            </EnvNotice>
        );
    } else if (!tokenSet || authRejected) {
        body = (
            <form
                className="flex items-center gap-2 rounded-xl border border-border/60 bg-card px-4 py-3"
                onSubmit={(e) => {
                    e.preventDefault();
                    const t = tokenInput.trim();
                    if (t.length === 0) return;
                    setReefToken(t);
                    setTokenInput("");
                    setTokenSet(true);
                }}
            >
                <Icon icon={LockIcon} className="size-4 shrink-0 text-muted-foreground"/>
                <Input
                    type="password"
                    value={tokenInput}
                    onChange={(e) => { setTokenInput(e.target.value); }}
                    placeholder={authRejected ? "Token rejected, try again" : "Reef admin token"}
                    autoComplete="off"
                    className="h-8 flex-1 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
                />
                <Button type="submit" size="sm" disabled={tokenInput.trim().length === 0}>
                    Unlock
                </Button>
            </form>
        );
    } else if (envQuery.isLoading) {
        body = (
            <div className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/60 bg-card">
                {[0, 1].map(i => (
                    <div key={i} className="flex items-center gap-3 px-4 py-3.5">
                        <div className="h-3.5 w-40 animate-pulse rounded bg-muted/70"/>
                        <div className="ml-auto h-3.5 w-16 animate-pulse rounded bg-muted/50"/>
                    </div>
                ))}
            </div>
        );
    } else if (envQuery.isError) {
        body = <EnvNotice icon={Alert02Icon}>{errMsg(envQuery.error, "Couldn't load variables.")}</EnvNotice>;
    } else if (rows.length === 0) {
        body = <EnvNotice icon={KeyIcon}>No variables yet.</EnvNotice>;
    } else {
        body = (
            <div className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/60 bg-card">
                {rows.map(r => (
                    <EnvRow
                        key={r.id}
                        row={r}
                        canEdit={canEdit}
                        busy={save.isPending}
                        editing={editingIds.has(r.id)}
                        onEdit={() => {
                            setEditingIds(prev => new Set(prev).add(r.id));
                            // A regular value is already on screen, so seed the
                            // input with it and let the user amend rather than
                            // retype. A secret has nothing to seed with.
                            if (r.storedValue != null) patchRow(r.id, {value: r.storedValue});
                        }}
                        onChange={(part) => { patchRow(r.id, part); }}
                        onRemove={() => {
                            // A row that was never on the server just disappears;
                            // an existing one is marked so the diff can unset it.
                            if (r.existing) patchRow(r.id, {removed: true});
                            else edit(rows.filter(x => x.id !== r.id));
                        }}
                        onRestore={() => { patchRow(r.id, {removed: false}); }}
                    />
                ))}
            </div>
        );
    }

    return (
        <section className="space-y-3">
            {header}
            {body}

            {!canEdit && data !== null && !envQuery.isError && (
                <p className="px-1 text-caption text-muted-foreground">
                    Read-only until this agent is updated.
                </p>
            )}

            {dirty && canEdit && (
                <div className="flex items-center justify-end gap-2 px-1">
                    {problem !== null && (
                        <p className="mr-auto text-caption text-destructive">{problem}</p>
                    )}
                    <Button variant="ghost" size="sm" onClick={reset} disabled={save.isPending}>
                        Cancel
                    </Button>
                    <Button
                        size="sm"
                        onClick={() => { save.mutate(); }}
                        disabled={save.isPending || problem !== null || nothingToSave}
                    >
                        {save.isPending ? "Saving…" : "Save"}
                    </Button>
                </div>
            )}
        </section>
    );
}

/** The value box for a value the user is actually entering. Visible by default:
 *  masking your own keystrokes buys nothing (you typed it, and it is not stored
 *  anywhere yet) while making a long key impossible to check for typos. The eye
 *  is there for when someone is watching the screen.
 *
 *  Only ever rendered for an ENTERED value. A stored one has no toggle because
 *  reef does not return values - there is nothing to un-hide. */
function ValueField({
    value,
    disabled,
    onChange,
}: {
    value: string;
    disabled: boolean;
    onChange: (v: string) => void;
}) {
    const [hidden, setHidden] = useState(false);
    return (
        <div className="relative min-w-0 flex-1">
            <Input
                type={hidden ? "password" : "text"}
                value={value}
                onChange={(e) => { onChange(e.target.value); }}
                placeholder="value"
                autoComplete="off"
                spellCheck={false}
                disabled={disabled}
                className="h-9 pr-9 font-mono text-sm"
            />
            <button
                type="button"
                onClick={() => { setHidden(h => !h); }}
                disabled={disabled}
                aria-label={hidden ? "Show value" : "Hide value"}
                className="absolute top-1/2 right-1 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-muted/60 hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
            >
                <Icon icon={hidden ? ViewOffSlashIcon : ViewIcon} className="size-3.5"/>
            </button>
        </div>
    );
}


/** Every cell is this tall, in both states. A row that grows when you edit it
 *  makes the list jump under the cursor, so the view-mode text sits in a box the
 *  exact height of the input that replaces it. */
const CELL = "flex h-9 min-w-0 items-center";

/** The tier control: one quiet lock, shown ONLY while editing. Locked = secret
 *  (write-only forever), unlocked = regular (readable later). Defaulted by name
 *  upstream, so this is an override, not a required decision. */
function TierToggle({
    tier,
    disabled,
    needsValue,
    onChange,
}: {
    tier: ReefEnvTier;
    disabled: boolean;
    needsValue: boolean;
    onChange: (next: ReefEnvTier) => void;
}) {
    const secret = tier === "secret";
    return (
        <button
            type="button"
            disabled={disabled}
            aria-label={secret ? "Make this value readable" : "Keep this value hidden"}
            title={
                secret
                    ? needsValue
                        ? "Hidden. Making it readable needs the value re-entered."
                        : "Hidden: never shown again after saving."
                    : "Readable: you can see this value later."
            }
            onClick={() => { onChange(secret ? "regular" : "secret"); }}
            className={cn(
                "flex size-7 shrink-0 items-center justify-center rounded-md transition-colors",
                secret ? "text-muted-foreground/70" : "text-muted-foreground/40",
                "hover:bg-muted/60 hover:text-foreground disabled:pointer-events-none disabled:opacity-40",
            )}
        >
            <Icon icon={secret ? LockIcon : SquareUnlock02Icon} className="size-3.5"/>
        </button>
    );
}

/** One row. Reading and editing are distinct modes: a click anywhere in the row
 *  does nothing, and editing starts only from the menu. That keeps a list you are
 *  scanning from turning into a form under a stray click. */
function EnvRow({
    row,
    canEdit,
    busy,
    editing,
    onEdit,
    onChange,
    onRemove,
    onRestore,
}: {
    row: EnvDraftRow;
    canEdit: boolean;
    busy: boolean;
    editing: boolean;
    onEdit: () => void;
    onChange: (part: Partial<EnvDraftRow>) => void;
    onRemove: () => void;
    onRestore: () => void;
}) {
    const tier = effectiveTier(row);
    // Only ever non-null for a regular var: reef withholds a secret's value.
    const storedValue = row.storedValue ?? null;
    const [copied, setCopied] = useState(false);

    if (row.removed) {
        return (
            <div className="flex items-center gap-3 px-4 py-2">
                <span className={cn(CELL, "flex-1")}>
                    <span className="truncate font-mono text-sm text-muted-foreground line-through">
                        {row.key}
                    </span>
                </span>
                <span className="text-caption text-muted-foreground">Removing</span>
                <button
                    type="button"
                    onClick={onRestore}
                    disabled={busy}
                    className="rounded-md px-1.5 py-1 text-caption text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                >
                    Undo
                </button>
                <span className="size-7 shrink-0"/>
            </div>
        );
    }

    return (
        <div className="flex items-center gap-3 px-4 py-2 transition-colors hover:bg-muted/25">
            {/* The key is the variable's identity, so it is editable only on a row
                that does not exist server-side yet. */}
            {row.existing ? (
                <span className={cn(CELL, "flex-1")}>
                    <span className="truncate font-mono text-sm text-foreground">{row.key}</span>
                </span>
            ) : (
                <Input
                    value={row.key}
                    onChange={(e) => { onChange({key: e.target.value}); }}
                    placeholder="name"
                    autoComplete="off"
                    spellCheck={false}
                    autoFocus
                    className="h-9 min-w-0 flex-1 font-mono text-sm"
                />
            )}

            <div className={cn(CELL, "w-[46%] gap-1")}>
                {editing ? (
                    <ValueField
                        value={row.value ?? ""}
                        disabled={!canEdit || busy}
                        onChange={(v) => { onChange({value: v}); }}
                    />
                ) : (
                    <>
                        <span
                            className={cn(
                                "min-w-0 flex-1 truncate px-2 text-sm",
                                storedValue === null
                                    ? "tracking-[0.2em] text-muted-foreground"
                                    : "font-mono text-foreground/80",
                            )}
                        >
                            {storedValue !== null && storedValue.length > 0
                                ? storedValue
                                : row.storedLength === 0
                                  ? <span className="text-caption text-muted-foreground">empty</span>
                                  : "••••••••••••"}
                        </span>
                        {storedValue !== null && storedValue.length > 0 && (
                            <button
                                type="button"
                                aria-label="Copy value"
                                onClick={() => {
                                    void navigator.clipboard.writeText(storedValue).then(() => {
                                        setCopied(true);
                                        setTimeout(() => { setCopied(false); }, 1200);
                                    });
                                }}
                                className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground/50 transition-colors hover:bg-muted/60 hover:text-foreground"
                            >
                                <Icon icon={copied ? Tick02Icon : Copy01Icon} className="size-3.5"/>
                            </button>
                        )}
                    </>
                )}
            </div>

            {/* Tier is an editing decision, not list furniture: shown only while
                this row is being edited. */}
            {editing && canEdit ? (
                <TierToggle
                    tier={tier}
                    disabled={busy}
                    // Revealing a stored secret needs the value re-entered - reef
                    // refuses the flip otherwise, so collect it here rather than
                    // letting the save come back a 422.
                    needsValue={row.existing && row.serverTier === "secret" && row.value === null}
                    onChange={(next) => { onChange({tier: next}); }}
                />
            ) : (
                <span className="size-7 shrink-0"/>
            )}

            {canEdit ? (
                <RowMenu
                    label={row.key || "variable"}
                    busy={busy}
                    editing={editing}
                    onEdit={onEdit}
                    onRemove={onRemove}
                />
            ) : (
                <span className="size-7 shrink-0"/>
            )}
        </div>
    );
}

/** Edit and Delete live behind one menu so the row keeps a single trailing
 *  control at every width, and neither destructive nor mode-switching actions
 *  sit under a stray click. */
function RowMenu({
    label,
    busy,
    editing,
    onEdit,
    onRemove,
}: {
    label: string;
    busy: boolean;
    editing: boolean;
    onEdit: () => void;
    onRemove: () => void;
}) {
    return (
        <DropdownMenu>
            <DropdownMenuTrigger
                disabled={busy}
                aria-label={`Actions for ${label}`}
                className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground/50 transition-colors hover:bg-muted/60 hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
            >
                <Icon icon={MoreHorizontalIcon} className="size-4"/>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-36">
                <DropdownMenuItem disabled={editing} onClick={onEdit}>
                    <Icon icon={PencilEdit02Icon} className="size-3.5"/>
                    Edit
                </DropdownMenuItem>
                <DropdownMenuItem variant="destructive" onClick={onRemove}>
                    <Icon icon={Delete02Icon} className="size-3.5"/>
                    Delete
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
