import {useState} from "react";
import {useNavigate, useParams} from "react-router-dom";
import {useMutation, useQuery, useQueryClient} from "@tanstack/react-query";
import {
    BookOpen01Icon as Book,
    GitForkIcon as Fork,
    PencilEdit02Icon as Pencil,
} from "@hugeicons/core-free-icons";
import {Icon} from "@/components/Icon";
import {PageHeader} from "@/components/PageHeader";
import {SkillForge} from "@/components/skills/SkillForge";
import {Button} from "@/components/ui/button";
import {useAuth} from "@/context/AuthContext";
import {
    forkSkill,
    getSkill,
    listSkillVersions,
    renderSkillVersion,
    type SkillRuntime,
} from "@/lib/api";
import {
    RENDERABLE_RUNTIMES,
    RUNTIME_CAN_RECEIVE,
    RUNTIME_LABELS,
    SKILL_ACCENT_BG,
    accentForSkill,
    formatBytes,
} from "@/lib/skills";
import {formatRelativeAgo} from "@/lib/formatting";
import {queryKeys} from "@/lib/queryKeys";
import {errMsg, toast} from "@/lib/toast";
import {cn} from "@/lib/utils";

/** One skill: what it says, what it becomes on disk, and how it got here. */
export default function SkillDetailPage() {
    const {skillId = ""} = useParams();
    const {activeOrgId} = useAuth();
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const [editing, setEditing] = useState(false);
    const [runtime, setRuntime] = useState<SkillRuntime>("openclaw");

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

    const fork = useMutation({
        mutationFn: () => forkSkill(activeOrgId ?? "", skillId),
        onSuccess: (created) => {
            void queryClient.invalidateQueries({queryKey: queryKeys.skills(activeOrgId ?? "")});
            toast.success(`Forked as ${created.slug}`);
            void navigate(`/skills/${encodeURIComponent(created.skill_id)}`);
        },
        onError: (e) => { toast.error(errMsg(e)); },
    });

    if (!activeOrgId) {
        return <div className="text-sm text-muted-foreground">Select an organization.</div>;
    }
    if (skillQuery.isPending) {
        return <div className="text-sm text-muted-foreground">Loading…</div>;
    }
    if (skillQuery.isError || !skill) {
        return <div className="text-sm text-destructive">{errMsg(skillQuery.error, "Skill not found")}</div>;
    }

    const accent = accentForSkill(skill.skill_id);
    const versions = versionsQuery.data?.versions ?? [];

    return (
        <div className="space-y-6 pb-16">
            <PageHeader
                icon={Book}
                title={skill.display_name}
                actions={
                    <div className="flex items-center gap-2">
                        <Button
                            size="sm"
                            variant="ghost"
                            disabled={skill.is_draft || fork.isPending}
                            onClick={() => { fork.mutate(); }}
                        >
                            <Icon icon={Fork} className="size-4"/>
                            Fork
                        </Button>
                        <Button size="sm" onClick={() => { setEditing(true); }}>
                            <Icon icon={Pencil} className="size-4"/>
                            Edit
                        </Button>
                    </div>
                }
            />

            <div className="flex items-start gap-4">
                <span className={cn("flex size-14 shrink-0 items-center justify-center rounded-2xl text-white", SKILL_ACCENT_BG[accent])}>
                    {skill.icon_emoji
                        ? <span className="text-3xl leading-none">{skill.icon_emoji}</span>
                        : <Icon icon={Book} className="size-7"/>}
                </span>
                <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-sm text-muted-foreground">{skill.slug}</span>
                        {skill.is_draft ? (
                            <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-caption font-medium text-amber-700 dark:text-amber-400">
                                Draft
                            </span>
                        ) : (
                            <span className="rounded-full bg-muted px-2 py-0.5 font-mono text-caption text-muted-foreground">
                                v{skill.latest_version}
                            </span>
                        )}
                        {skill.origin === "forked" && (
                            <span className="rounded-full bg-muted px-2 py-0.5 text-caption text-muted-foreground">
                                Forked
                            </span>
                        )}
                    </div>
                    <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{skill.summary}</p>
                </div>
            </div>

            <section className="space-y-2">
                <h2 className="text-sm font-semibold tracking-tight text-foreground">Instructions</h2>
                <pre className="overflow-x-auto rounded-xl bg-muted/40 p-4 text-sm leading-relaxed whitespace-pre-wrap break-words text-foreground">
                    {skill.current_version?.body_md ?? ""}
                </pre>
            </section>

            <section className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <h2 className="text-sm font-semibold tracking-tight text-foreground">
                        On the agent
                    </h2>
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
                </div>
                {!RUNTIME_CAN_RECEIVE[runtime] && (
                    <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs leading-snug text-amber-700 dark:text-amber-400">
                        This is a preview. {RUNTIME_LABELS[runtime]} agents can't receive
                        skills from Clawbits yet.
                    </p>
                )}
                {renderQuery.isPending ? (
                    <div className="text-sm text-muted-foreground">Rendering…</div>
                ) : renderQuery.isError ? (
                    <div className="text-sm text-destructive">{errMsg(renderQuery.error)}</div>
                ) : (
                    <div className="overflow-hidden rounded-xl border border-border/60">
                        <div className="flex items-center justify-between border-b border-border/60 bg-muted/40 px-3 py-1.5">
                            <span className="truncate font-mono text-caption text-muted-foreground">
                                {renderQuery.data.path}
                            </span>
                            <span className="shrink-0 text-caption text-muted-foreground">
                                {formatBytes(new TextEncoder().encode(renderQuery.data.content).length)}
                            </span>
                        </div>
                        <pre className="overflow-x-auto p-4 text-xs leading-relaxed text-foreground">
                            {renderQuery.data.content}
                        </pre>
                    </div>
                )}
            </section>

            <section className="space-y-2">
                <h2 className="text-sm font-semibold tracking-tight text-foreground">History</h2>
                <p className="text-xs text-muted-foreground">
                    Every edit publishes a new version. Older ones are kept, so nothing is lost.
                </p>
                <ul className="divide-y divide-border/60 rounded-xl border border-border/60">
                    {versions.map(v => (
                        <li key={v.version_id} className="flex items-center gap-3 px-3 py-2">
                            <span className="font-mono text-caption text-foreground">v{v.version}</span>
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
                        <li className="px-3 py-2 text-caption text-muted-foreground">No versions yet.</li>
                    )}
                </ul>
            </section>

            <SkillForge
                open={editing}
                editing={skill}
                onOpenChange={(open) => {
                    setEditing(open);
                    if (!open) {
                        void queryClient.invalidateQueries({queryKey: queryKeys.skills(activeOrgId)});
                    }
                }}
            />
        </div>
    );
}
