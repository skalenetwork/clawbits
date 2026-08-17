import {useState} from "react";
import {useNavigate, useParams} from "react-router-dom";
import {useMutation, useQuery, useQueryClient} from "@tanstack/react-query";
import {
    ArrowDown01Icon as ArrowDown,
    BookOpen01Icon as Book,
    Delete02Icon as Trash,
    GitForkIcon as Fork,
    MoreHorizontalIcon as More,
    PencilEdit02Icon as Pencil,
} from "@hugeicons/core-free-icons";
import {Icon} from "@/components/Icon";
import {PageHeader} from "@/components/PageHeader";
import {SkillForge} from "@/components/skills/SkillForge";
import {SkillGlyph} from "@/components/skills/SkillGlyph";
import {Button} from "@/components/ui/button";
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogTitle,
} from "@/components/ui/dialog";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {useAuth} from "@/context/AuthContext";
import {
    deleteSkill,
    forkSkill,
    getSkill,
    listSkillVersions,
    renderSkillVersion,
    type Skill,
    type SkillRuntime,
} from "@/lib/api";
import {
    RENDERABLE_RUNTIMES,
    RUNTIME_CAN_RECEIVE,
    RUNTIME_LABELS,
    formatBytes,
} from "@/lib/skills";
import {formatRelativeAgo} from "@/lib/formatting";
import {queryKeys} from "@/lib/queryKeys";
import {errMsg, toast} from "@/lib/toast";
import {cn} from "@/lib/utils";

/**
 * One skill, as an inspector rather than three equal headings.
 *
 * Identity and actions first, then the facts that decide what you do next — the
 * name agents invoke it by, where it lands on disk, how big it is, when it last
 * changed, how many agents actually have it. The instructions follow as a
 * document. The rendered per-runtime output and the version history are real
 * but rarely the reason you opened the page, so they sit collapsed.
 *
 * The list stays in the sidebar beside this, so this page never has to carry a
 * way back to it.
 */
export default function SkillDetailPage() {
    const {skillId = ""} = useParams();
    const {activeOrgId} = useAuth();
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const [editing, setEditing] = useState(false);
    const [pendingDelete, setPendingDelete] = useState(false);
    const [runtime, setRuntime] = useState<SkillRuntime>("openclaw");
    const [showRendered, setShowRendered] = useState(false);
    const [showHistory, setShowHistory] = useState(false);

    const skillQuery = useQuery({
        queryKey: queryKeys.skill(activeOrgId ?? "", skillId),
        queryFn: () => getSkill(activeOrgId ?? "", skillId),
        enabled: Boolean(activeOrgId) && Boolean(skillId),
    });
    const versionsQuery = useQuery({
        queryKey: queryKeys.skillVersions(activeOrgId ?? "", skillId),
        queryFn: () => listSkillVersions(activeOrgId ?? "", skillId),
        enabled: Boolean(activeOrgId) && Boolean(skillId),
    });

    const skill = skillQuery.data;
    const versionId = skill?.latest_version_id ?? "";

    const renderQuery = useQuery({
        queryKey: queryKeys.skillRender(activeOrgId ?? "", skillId, versionId, runtime),
        queryFn: () => renderSkillVersion(activeOrgId ?? "", skillId, versionId, runtime),
        enabled: Boolean(activeOrgId) && Boolean(skillId) && Boolean(versionId),
    });

    const invalidateLibrary = () => {
        void queryClient.invalidateQueries({queryKey: queryKeys.skills(activeOrgId ?? "")});
    };

    const fork = useMutation({
        mutationFn: () => forkSkill(activeOrgId ?? "", skillId),
        onSuccess: (created) => {
            invalidateLibrary();
            toast.success(`Forked as ${created.slug}`);
            void navigate(`/skills/${encodeURIComponent(created.skill_id)}`);
        },
        onError: (e) => { toast.error(errMsg(e)); },
    });

    const remove = useMutation({
        mutationFn: () => deleteSkill(activeOrgId ?? "", skillId),
        onSuccess: () => {
            invalidateLibrary();
            setPendingDelete(false);
            toast.success("Skill deleted");
            void navigate("/skills");
        },
        onError: (e) => { toast.error(errMsg(e)); },
    });

    if (!activeOrgId) {
        return <div className="pt-4 text-sm text-muted-foreground">Select an organization.</div>;
    }
    if (skillQuery.isPending) {
        return <div className="pt-4 text-sm text-muted-foreground">Loading…</div>;
    }
    if (skillQuery.isError || !skill) {
        return (
            <div className="pt-4 text-sm text-destructive">
                {errMsg(skillQuery.error, "Skill not found")}
            </div>
        );
    }

    const versions = versionsQuery.data?.versions ?? [];
    const bodyMd = skill.current_version?.body_md ?? "";
    const renderedBytes = renderQuery.data
        ? new TextEncoder().encode(renderQuery.data.content).length
        : null;

    return (
        <div className="space-y-8 pb-16">
            <PageHeader
                // A trail rather than the name again: the identity block below
                // already says what this is, and the "Skills" crumb is the only
                // way back to the library on mobile, where there is no sidebar.
                breadcrumb={[
                    {label: "Skills", to: "/skills", icon: Book},
                    {label: skill.display_name, leading: <SkillGlyph skill={skill} size="sm"/>},
                ]}
                actions={
                    <div className="flex items-center gap-1.5">
                        <Button size="sm" onClick={() => { setEditing(true); }}>
                            <Icon icon={Pencil} className="size-4"/>
                            Edit
                        </Button>
                        <DropdownMenu>
                            <DropdownMenuTrigger
                                aria-label={`More actions for ${skill.display_name}`}
                                className="flex size-8 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
                            >
                                <Icon icon={More} className="size-4"/>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                                <DropdownMenuItem
                                    disabled={skill.is_draft || fork.isPending}
                                    onClick={() => { fork.mutate(); }}
                                >
                                    <Icon icon={Fork} className="size-4"/>
                                    Fork
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                    variant="destructive"
                                    onClick={() => { setPendingDelete(true); }}
                                >
                                    <Icon icon={Trash} className="size-4"/>
                                    Delete
                                </DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>
                    </div>
                }
            />

            <header className="flex items-start gap-4">
                <SkillGlyph skill={skill} size="lg"/>
                <div className="min-w-0 flex-1">
                    <h2 className="text-lg font-semibold leading-tight tracking-tight text-foreground">
                        {skill.display_name}
                    </h2>
                    <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                        {skill.summary}
                    </p>
                </div>
            </header>

            <Properties skill={skill} renderedPath={renderQuery.data?.path ?? null} bytes={renderedBytes}/>

            <section className="space-y-2">
                <h3 className="text-sm font-semibold tracking-tight text-foreground">Instructions</h3>
                {bodyMd ? (
                    <pre className="overflow-x-auto rounded-xl bg-muted/40 p-4 font-sans text-sm leading-relaxed whitespace-pre-wrap break-words text-foreground">
                        {bodyMd}
                    </pre>
                ) : (
                    <p className="text-sm text-muted-foreground">
                        Nothing published yet — this skill has no instructions an agent could follow.
                    </p>
                )}
            </section>

            <Disclosure
                open={showRendered}
                onToggle={() => { setShowRendered(v => !v); }}
                title="What lands on the agent"
                hint={renderQuery.data?.path ?? undefined}
            >
                <div className="mt-3 space-y-2">
                    <div className="flex items-center gap-1 rounded-lg bg-muted/60 p-0.5">
                        {RENDERABLE_RUNTIMES.map(rt => (
                            <button
                                key={rt}
                                type="button"
                                onClick={() => { setRuntime(rt); }}
                                className={cn(
                                    "rounded-md px-2.5 py-1 text-caption font-medium transition-colors",
                                    runtime === rt
                                        ? "bg-background text-foreground shadow-sm"
                                        : "text-muted-foreground hover:text-foreground",
                                )}
                            >
                                {RUNTIME_LABELS[rt]}
                            </button>
                        ))}
                    </div>
                    {!RUNTIME_CAN_RECEIVE[runtime] && (
                        <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs leading-snug text-amber-700 dark:text-amber-400">
                            This is a preview. {RUNTIME_LABELS[runtime]} agents can't receive
                            skills from Clawbits yet.
                        </p>
                    )}
                    {renderQuery.isPending ? (
                        <p className="text-sm text-muted-foreground">Rendering…</p>
                    ) : renderQuery.isError ? (
                        <p className="text-sm text-destructive">{errMsg(renderQuery.error)}</p>
                    ) : (
                        <pre className="overflow-x-auto rounded-xl border border-border/60 p-4 font-sans text-xs leading-relaxed whitespace-pre-wrap break-words text-foreground">
                            {renderQuery.data.content}
                        </pre>
                    )}
                </div>
            </Disclosure>

            <Disclosure
                open={showHistory}
                onToggle={() => { setShowHistory(v => !v); }}
                title="History"
                hint={
                    versions.length > 0
                        ? `${String(versions.length)} version${versions.length === 1 ? "" : "s"}`
                        : "No versions yet"
                }
            >
                <p className="mt-3 text-xs text-muted-foreground">
                    Every edit publishes a new version. Older ones are kept, so nothing is lost.
                </p>
                <ul className="mt-2 divide-y divide-border/60 rounded-xl border border-border/60">
                    {versions.map(v => (
                        <li key={v.version_id} className="flex items-center gap-3 px-3 py-2">
                            <span className="text-caption text-foreground tabular-nums">v{v.version}</span>
                            {v.version_id === skill.latest_version_id && (
                                <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-caption font-medium text-emerald-700 dark:text-emerald-400">
                                    Current
                                </span>
                            )}
                            <span className="min-w-0 flex-1 truncate text-caption text-muted-foreground">
                                {v.changelog ?? ""}
                            </span>
                            <span className="shrink-0 text-caption text-muted-foreground">
                                {formatRelativeAgo(v.created_at)}
                            </span>
                        </li>
                    ))}
                    {versions.length === 0 && (
                        <li className="px-3 py-2 text-caption text-muted-foreground">
                            No versions yet.
                        </li>
                    )}
                </ul>
            </Disclosure>

            <SkillForge
                open={editing}
                editing={skill}
                onOpenChange={(open) => {
                    setEditing(open);
                    if (!open) invalidateLibrary();
                }}
            />

            <Dialog
                open={pendingDelete}
                onOpenChange={(open) => { if (!open) setPendingDelete(false); }}
            >
                <DialogContent className="sm:max-w-md">
                    <DialogTitle>Delete {skill.display_name}?</DialogTitle>
                    <DialogDescription>
                        It's removed from the library and from every agent that has it. Its
                        version history is kept, and the name{" "}
                        <span className="font-medium text-foreground">{skill.slug}</span> becomes available again.
                    </DialogDescription>
                    <DialogFooter>
                        <DialogClose render={<Button variant="ghost"/>}>Cancel</DialogClose>
                        <Button
                            variant="destructive"
                            disabled={remove.isPending}
                            onClick={() => { remove.mutate(); }}
                        >
                            {remove.isPending ? "Deleting…" : "Delete"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}

/** The facts that decide what you do next, as a table rather than prose. */
function Properties({skill, renderedPath, bytes}: {
    skill: Skill;
    renderedPath: string | null;
    bytes: number | null;
}) {
    const manifest = skill.current_version?.manifest;
    const rows: {label: string; value: React.ReactNode}[] = [];

    // Only claim a slash command exists when the manifest actually asks for
    // one — most skills are model-invoked and have nothing to type.
    if (manifest?.user_invocable) {
        rows.push({label: "Invoke", value: `/${skill.slug}`});
    }
    rows.push({label: "Name on disk", value: skill.slug});
    if (renderedPath) rows.push({label: "File", value: renderedPath});
    rows.push({
        label: "Runtimes",
        value: skill.runtimes.map(rt => RUNTIME_LABELS[rt]).join(", "),
    });
    rows.push({label: "Status", value: <StatusValue skill={skill}/>});
    rows.push({label: "On agents", value: <AgentsValue skill={skill}/>});
    if (bytes != null) rows.push({label: "Size", value: formatBytes(bytes)});
    rows.push({
        label: "Updated",
        value: skill.updated_at ? formatRelativeAgo(skill.updated_at) : "—",
    });
    if (skill.origin !== "authored") {
        rows.push({
            label: "Origin",
            value: skill.origin === "forked" ? "Forked from another skill" : "Imported",
        });
    }

    return (
        <dl className="border-t border-border/60">
            {rows.map(row => (
                <div
                    key={row.label}
                    className="flex items-baseline gap-4 border-b border-border/60 py-2"
                >
                    <dt className="w-32 shrink-0 text-caption text-muted-foreground">{row.label}</dt>
                    <dd className="min-w-0 flex-1 truncate text-sm text-foreground">
                        {row.value}
                    </dd>
                </div>
            ))}
        </dl>
    );
}

function StatusValue({skill}: {skill: Skill}) {
    if (skill.is_draft) {
        return (
            <span className="text-amber-700 dark:text-amber-400">
                Draft — no published version, so no agent can have it
            </span>
        );
    }
    return <span>Published, v{skill.latest_version}</span>;
}

/** Confirmed installs and in-flight work are shown apart on purpose: an
 *  install the agent hasn't acknowledged is not a skill it has. */
function AgentsValue({skill}: {skill: Skill}) {
    const {installed_agent_count: live, pending_agent_count: pending} = skill;
    if (live === 0 && pending === 0) return <span className="text-muted-foreground">Nowhere yet</span>;
    return (
        <span>
            {live > 0 ? `${String(live)} agent${live === 1 ? "" : "s"}` : "None confirmed"}
            {pending > 0 && (
                <span className="text-amber-700 dark:text-amber-400">
                    {" · "}{String(pending)} syncing
                </span>
            )}
        </span>
    );
}

/** A section that is real but rarely why you opened the page. The hint on the
 *  closed row carries enough that opening it is a choice, not a probe. */
function Disclosure({open, onToggle, title, hint, children}: {
    open: boolean;
    onToggle: () => void;
    title: string;
    hint?: string;
    children: React.ReactNode;
}) {
    return (
        <section>
            <button
                type="button"
                onClick={onToggle}
                aria-expanded={open}
                className="group flex w-full items-center gap-2 rounded-lg py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
                <span className="disclosure-chevron inline-flex text-muted-foreground" data-open={open ? "true" : "false"}>
                    <Icon icon={ArrowDown} className="size-4"/>
                </span>
                <span className="text-sm font-semibold tracking-tight text-foreground">{title}</span>
                {hint && (
                    <span className="min-w-0 truncate text-caption text-muted-foreground">
                        {hint}
                    </span>
                )}
            </button>
            {open && children}
        </section>
    );
}
