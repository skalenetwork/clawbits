import {useState} from "react";
import {useMutation, useQuery, useQueryClient} from "@tanstack/react-query";
import {Squircle} from "@/components/home/tiles";
import {ModalButton, ModalField, ModalFooter, ModalHeader, ModalPanel} from "@/components/modals/Modal";
import {Input} from "@/components/ui/input";
import {Skeleton} from "@/components/ui/skeleton";
import {useAuth} from "@/context/AuthContext";
import {createSkill, getSkill, publishSkillVersion, type Skill, type SkillDraft} from "@/lib/api";
import {DESCRIPTION_MAX, buildManifest, skillMonogram, slugProblem, slugify} from "@/lib/skills";
import {queryKeys} from "@/lib/queryKeys";
import {toast} from "@/lib/toast";
import {cn} from "@/lib/utils";

const BODY = "flex flex-col gap-4 p-4";
const HELP = "text-[12px] text-muted-foreground";
const TEXTAREA =
    "w-full min-w-0 resize-y rounded-md border border-transparent bg-input/50 px-3 py-2 text-base leading-relaxed outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 md:text-sm";

/** Create a skill, or publish an edit as a new version. The slug is
 *  create-only: it is the directory name on every agent that has the skill.
 *  A draft prefills create; one read from an agent keeps its slug, since adopt
 *  needs the library skill to match the agent's folder. */
function ForgeForm({editing, draft, onOpenChange, onCreated}: {
    editing?: Skill;
    draft?: SkillDraft;
    onOpenChange: (open: boolean) => void;
    onCreated?: (skill: Skill) => void;
}) {
    const {activeOrgId} = useAuth();
    const orgId = activeOrgId ?? "";
    const queryClient = useQueryClient();
    const current = editing?.current_version;
    const source = draft?.source;
    const slugLocked = editing != null || source?.kind === "agent";

    const [displayName, setDisplayName] = useState(editing?.display_name ?? draft?.display_name ?? "");
    // Null while the slug follows the name.
    const [slug, setSlug] = useState(editing?.slug ?? draft?.slug ?? null);
    const [description, setDescription] = useState(editing?.summary ?? draft?.manifest.description ?? "");
    const [emoji, setEmoji] = useState(editing?.icon_emoji ?? draft?.manifest.emoji ?? "");
    const [bodyMd, setBodyMd] = useState(current?.body_md ?? draft?.body_md ?? "");
    const [changelog, setChangelog] = useState("");

    const effectiveSlug = slug ?? slugify(displayName);
    const slugIssue = editing ? null : slugProblem(effectiveSlug);
    // Blocks Save regardless; just not shown on an untouched form.
    const showSlugIssue = slugIssue != null && (slug != null || displayName.trim().length > 0);
    const descTooLong = description.trim().length > DESCRIPTION_MAX;
    const canSave = [displayName, description, bodyMd].every(v => v.trim()) && !descTooLong && slugIssue == null;
    // Mirrors spec.next_patch_version.
    const semver = editing?.latest_version?.match(/^(\d+)\.(\d+)\.(\d+)$/);
    const nextVersion = semver ? `${Number(semver[1])}.${Number(semver[2])}.${Number(semver[3]) + 1}` : "1.0.0";

    const save = useMutation({
        mutationFn: async () => {
            const base = current?.manifest ?? draft?.manifest;
            const manifest = buildManifest({slug: effectiveSlug, description, emoji, base});
            if (editing) {
                await publishSkillVersion(orgId, editing.skill_id, {
                    manifest,
                    body_md: bodyMd,
                    // Carried forward without the server's hash and size: this form edits the document only.
                    files: (current?.files ?? []).map(({path, content}) => ({path, content})),
                    changelog: changelog.trim() || undefined,
                });
                return null;
            }
            return createSkill(orgId, {
                slug: effectiveSlug,
                display_name: displayName.trim(),
                manifest,
                body_md: bodyMd,
                files: draft?.files ?? [],
            });
        },
        onSuccess: (created) => {
            void queryClient.invalidateQueries({queryKey: queryKeys.skills(orgId)});
            toast.success(editing ? "New version published" : "Skill created");
            if (created) onCreated?.(created);
            onOpenChange(false);
        },
    });

    return (
        <>
            <ModalHeader
                title={
                    editing
                        ? `Edit ${editing.display_name}`
                        : source?.kind === "agent" ? "Adopt a skill" : source ? "Import a skill" : "New skill"
                }
                subtitle={source?.kind === "url" ? source.url : undefined}
            />
            <form
                onSubmit={(e) => {
                    e.preventDefault();
                    if (canSave && !save.isPending) save.mutate();
                }}
            >
                <div className={BODY}>
                    <div className="grid grid-cols-[36px_minmax(0,1fr)] gap-3">
                        <ModalField label="Icon" htmlFor="skill-emoji">
                            <Squircle
                                size={36}
                                glass={false}
                                className="bg-muted text-muted-foreground focus-within:bg-foreground/10"
                            >
                                <input
                                    id="skill-emoji"
                                    value={emoji}
                                    onChange={(e) => { setEmoji(e.target.value); }}
                                    placeholder={skillMonogram(effectiveSlug || "new-skill")}
                                    className="size-full bg-transparent text-center text-[20px] leading-none outline-none placeholder:text-[13px] placeholder:font-medium placeholder:text-muted-foreground"
                                />
                            </Squircle>
                        </ModalField>
                        <ModalField label="Name" htmlFor="skill-name">
                            <Input
                                id="skill-name"
                                value={displayName}
                                onChange={(e) => { setDisplayName(e.target.value); }}
                                placeholder="Invoice triage"
                                autoFocus={!editing}
                            />
                        </ModalField>
                    </div>

                    <ModalField label="Identifier" htmlFor="skill-slug">
                        <Input
                            id="skill-slug"
                            className="font-mono"
                            value={effectiveSlug}
                            onChange={(e) => { setSlug(e.target.value.toLowerCase()); }}
                            disabled={slugLocked}
                            placeholder="invoice-triage"
                        />
                        <p className={cn(HELP, showSlugIssue && "text-destructive")}>
                            {showSlugIssue
                                ? slugIssue
                                : editing
                                    ? "The folder name on every agent that has this skill, so it can't change."
                                    : slugLocked
                                        ? "Matches the folder on the agent, so the library copy can replace it."
                                        : "The folder name on the agent, and the name the model sees. It can't change later."}
                        </p>
                    </ModalField>

                    <ModalField label="When to use it" htmlFor="skill-desc">
                        <textarea
                            id="skill-desc"
                            rows={3}
                            className={TEXTAREA}
                            value={description}
                            onChange={(e) => { setDescription(e.target.value); }}
                            placeholder="Triage inbound invoices and flag the ones over budget."
                        />
                        <div className={cn(HELP, "flex items-baseline justify-between gap-3")}>
                            <p>
                                The agent reads this in every conversation to decide whether to use the skill, so keep it short and specific.
                            </p>
                            <span className={cn("shrink-0 tabular-nums", descTooLong && "text-destructive")}>
                                {description.trim().length}/{DESCRIPTION_MAX}
                            </span>
                        </div>
                    </ModalField>

                    <ModalField label="Instructions" htmlFor="skill-body">
                        <textarea
                            id="skill-body"
                            rows={6}
                            className={cn(TEXTAREA, "font-mono")}
                            value={bodyMd}
                            onChange={(e) => { setBodyMd(e.target.value); }}
                            placeholder={"# Invoice triage\n\nRead the invoice, compare it to the budget, flag anything over."}
                        />
                        <p className={HELP}>Markdown. The agent reads this only once it has decided to use the skill.</p>
                    </ModalField>

                    {draft && draft.dropped.length > 0 && (
                        <ModalField label="Left out">
                            <ul className="flex flex-wrap gap-x-3 font-mono text-[12px] text-muted-foreground">
                                {draft.dropped.map(d => (
                                    <li key={d.path} title={d.reason} className="max-w-full truncate">
                                        {d.path}
                                    </li>
                                ))}
                            </ul>
                            <p className={HELP}>Skills are text only, so scripts and assets are not imported.</p>
                        </ModalField>
                    )}

                    {editing && (
                        <ModalField label="What changed (optional)" htmlFor="skill-changelog">
                            <Input
                                id="skill-changelog"
                                value={changelog}
                                onChange={(e) => { setChangelog(e.target.value); }}
                                placeholder="Sharper wording"
                            />
                            <p className={HELP}>
                                Publishing creates version {nextVersion}. The current one stays, so you can roll back.
                            </p>
                        </ModalField>
                    )}
                </div>
                <ModalFooter>
                    <ModalButton onClick={() => { onOpenChange(false); }} disabled={save.isPending}>Cancel</ModalButton>
                    <ModalButton type="submit" tone="primary" disabled={!canSave || save.isPending}>
                        {save.isPending ? "Saving…" : editing ? "Publish version" : "Create skill"}
                    </ModalButton>
                </ModalFooter>
            </form>
        </>
    );
}

export function SkillForge({open, editing, draft, onOpenChange, onCreated}: {
    open: boolean;
    editing?: Skill;
    /** Prefills create mode, e.g. from an import. */
    draft?: SkillDraft;
    onOpenChange: (open: boolean) => void;
    onCreated?: (skill: Skill) => void;
}) {
    const {activeOrgId} = useAuth();
    // Held through the close transition, which still renders the form after the parent clears its props.
    const [held, setHeld] = useState({editing, draft});
    if (open && (held.editing !== editing || held.draft !== draft)) setHeld({editing, draft});

    // A list row has no current_version, which seeds the body and reference
    // files, so an edit mounts the form only once the full record is in hand.
    const skillId = held.editing?.skill_id ?? "";
    const detailQuery = useQuery({
        queryKey: queryKeys.skill(activeOrgId ?? "", skillId),
        queryFn: () => getSkill(activeOrgId ?? "", skillId),
        enabled: open && skillId !== "",
    });

    return (
        <ModalPanel open={open} onOpenChange={onOpenChange} kind="form">
            {held.editing && !detailQuery.data ? (
                <>
                    <ModalHeader title={`Edit ${held.editing.display_name}`}/>
                    <div className={BODY}>
                        {detailQuery.isError ? (
                            <p className="text-[13px] text-destructive">
                                This skill couldn't be loaded, so it isn't safe to edit here.
                            </p>
                        ) : (
                            [0, 1, 2].map(i => <Skeleton key={i} className="h-9 w-full rounded-md"/>)
                        )}
                    </div>
                </>
            ) : (
                <ForgeForm
                    editing={held.editing && detailQuery.data}
                    draft={held.draft}
                    onOpenChange={onOpenChange}
                    onCreated={onCreated}
                />
            )}
        </ModalPanel>
    );
}
