import {useState} from "react";
import {useMutation, useQueryClient} from "@tanstack/react-query";
import {BookOpen01Icon as Book} from "@hugeicons/core-free-icons";
import {Icon} from "@/components/Icon";
import {useAuth} from "@/context/AuthContext";
import {useIsMobile} from "@/hooks/use-mobile";
import {createSkill, publishSkillVersion, type Skill} from "@/lib/api";
import {
    DESCRIPTION_MAX,
    SKILL_ACCENT_BG,
    accentForSkill,
    buildManifest,
    slugProblem,
    slugify,
} from "@/lib/skills";
import {queryKeys} from "@/lib/queryKeys";
import {errMsg, toast} from "@/lib/toast";
import {cn} from "@/lib/utils";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {Label} from "@/components/ui/label";
import {Dialog, DialogContent, DialogTitle} from "@/components/ui/dialog";
import {Drawer, DrawerContent, DrawerTitle} from "@/components/ui/drawer";

/** Create a skill, or publish an edit as a new version. The slug is
 *  create-only: it is the directory name on every agent that has the skill. */
function ForgeForm({editing, onOpenChange}: {
    editing: Skill | null;
    onOpenChange: (open: boolean) => void;
}) {
    const {activeOrgId} = useAuth();
    const isMobile = useIsMobile();
    const queryClient = useQueryClient();
    const isEdit = editing != null;
    const current = editing?.current_version;

    const [displayName, setDisplayName] = useState(editing?.display_name ?? "");
    const [slug, setSlug] = useState(editing?.slug ?? "");
    const [slugTouched, setSlugTouched] = useState(isEdit);
    const [description, setDescription] = useState(
        editing?.summary ?? "",
    );
    const [emoji, setEmoji] = useState(editing?.icon_emoji ?? "");
    const [bodyMd, setBodyMd] = useState(current?.body_md ?? "");
    const [changelog, setChangelog] = useState("");

    const effectiveSlug = isEdit ? (editing.slug) : (slugTouched ? slug : slugify(displayName));
    const slugIssue = isEdit ? null : slugProblem(effectiveSlug);
    // Blocks Save regardless; just not shown on an untouched form.
    const showSlugIssue = slugIssue != null && (slugTouched || displayName.trim().length > 0);
    const descTooLong = description.trim().length > DESCRIPTION_MAX;
    const canSave =
        Boolean(activeOrgId) &&
        displayName.trim().length > 0 &&
        description.trim().length > 0 &&
        bodyMd.trim().length > 0 &&
        !descTooLong &&
        slugIssue == null;

    const save = useMutation({
        mutationFn: async () => {
            if (!activeOrgId) throw new Error("No organization selected");
            const manifest = buildManifest({
                slug: effectiveSlug,
                description,
                emoji,
            });
            if (editing) {
                return publishSkillVersion(activeOrgId, editing.skill_id, {
                    manifest,
                    body_md: bodyMd,
                    // Reference files are carried forward untouched: this form
                    // edits the document, and dropping them silently on every
                    // publish would be a data-loss bug wearing a save button.
                    // Carried forward: this form edits the document only.
                    files: (current?.files ?? [])
                        .filter((f): f is typeof f & {content: string} => typeof f.content === "string")
                        .map(f => ({path: f.path, content: f.content})),
                    changelog: changelog.trim() || undefined,
                });
            }
            return createSkill(activeOrgId, {
                slug: effectiveSlug,
                display_name: displayName.trim(),
                manifest,
                body_md: bodyMd,
            });
        },
        onSuccess: () => {
            void queryClient.invalidateQueries({queryKey: queryKeys.skills(activeOrgId ?? "")});
            toast.success(isEdit ? "New version published" : "Skill created");
            onOpenChange(false);
        },
        onError: (e) => { toast.error(errMsg(e)); },
    });

    const accent = accentForSkill(editing ? editing.skill_id : (effectiveSlug || "new"));
    const Title = isMobile ? DrawerTitle : DialogTitle;

    return (
        <>
            <div className={cn("flex items-center gap-3 border-b border-border/60", isMobile ? "px-4 py-3" : "p-6 pb-4")}>
                <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-xl text-white", SKILL_ACCENT_BG[accent])}>
                    {emoji.trim()
                        ? <span className="text-xl leading-none">{emoji.trim()}</span>
                        : <Icon icon={Book} className="size-5"/>}
                </span>
                <Title className="text-lg font-semibold tracking-tight">
                    {editing ? `Edit ${editing.display_name}` : "New skill"}
                </Title>
            </div>

            <div className={cn("min-h-0 space-y-4 overflow-y-auto", isMobile ? "flex-1 px-4 py-3" : "p-6")}>
                <div className="space-y-2">
                    <Label htmlFor="skill-name">Name</Label>
                    <Input
                        id="skill-name"
                        value={displayName}
                        onChange={(e) => { setDisplayName(e.target.value); }}
                        placeholder="Invoice triage"
                        autoFocus={!isEdit}
                    />
                </div>

                <div className="space-y-2">
                    <Label htmlFor="skill-slug">Identifier</Label>
                    <Input
                        id="skill-slug"
                        value={effectiveSlug}
                        onChange={(e) => {
                            setSlugTouched(true);
                            setSlug(e.target.value.toLowerCase());
                        }}
                        disabled={isEdit}
                        className="font-mono"
                        placeholder="invoice-triage"
                    />
                    <p className={cn("text-xs", showSlugIssue ? "text-destructive" : "text-muted-foreground")}>
                        {(showSlugIssue ? slugIssue : null) ??
                            (isEdit
                                ? "The identifier can't change — it's the folder name on every agent that has this skill."
                                : "The folder name on the agent, and the name the model sees.")}
                    </p>
                </div>

                <div className="space-y-2">
                    <Label htmlFor="skill-emoji">Icon</Label>
                    <Input
                        id="skill-emoji"
                        value={emoji}
                        onChange={(e) => { setEmoji(e.target.value); }}
                        placeholder="🧾"
                        className="w-24 text-center text-lg"
                    />
                </div>

                <div className="space-y-2">
                    <div className="flex items-baseline justify-between">
                        <Label htmlFor="skill-desc">When to use it</Label>
                        <span className={cn("text-caption tabular-nums", descTooLong ? "text-destructive" : "text-muted-foreground")}>
                            {description.trim().length}/{DESCRIPTION_MAX}
                        </span>
                    </div>
                    <textarea
                        id="skill-desc"
                        className={cn(
                            "min-h-[72px] w-full min-w-0 resize-y rounded-xl bg-muted/40 p-3",
                            "text-sm leading-relaxed text-foreground outline-none",
                            "transition-shadow placeholder:text-muted-foreground/50",
                            "focus-visible:ring-2 focus-visible:ring-ring/30",
                        )}
                        value={description}
                        onChange={(e) => { setDescription(e.target.value); }}
                        placeholder="Triage inbound invoices and flag the ones over budget."
                    />
                    <p className="text-xs text-muted-foreground">
                        The agent reads this in every conversation to decide whether to use the skill, so keep it short and specific.
                    </p>
                </div>

                <div className="space-y-2">
                    <Label htmlFor="skill-body">Instructions</Label>
                    <textarea
                        id="skill-body"
                        className={cn(
                            "min-h-[220px] w-full min-w-0 resize-y rounded-xl bg-muted/40 p-4",
                            "font-mono text-sm leading-relaxed text-foreground outline-none",
                            "transition-shadow placeholder:text-muted-foreground/50",
                            "focus-visible:ring-2 focus-visible:ring-ring/30",
                        )}
                        value={bodyMd}
                        onChange={(e) => { setBodyMd(e.target.value); }}
                        placeholder={"# Invoice triage\n\nRead the invoice, compare it to the budget, flag anything over."}
                    />
                    <p className="text-xs text-muted-foreground">
                        Markdown. The agent reads this only once it has decided to use the skill.
                    </p>
                </div>

                {isEdit && (
                    <div className="space-y-2">
                        <Label htmlFor="skill-changelog">What changed (optional)</Label>
                        <Input
                            id="skill-changelog"
                            value={changelog}
                            onChange={(e) => { setChangelog(e.target.value); }}
                            placeholder="sharper wording"
                        />
                        <p className="text-xs text-muted-foreground">
                            Publishing creates version {nextVersionHint(editing.latest_version)} — the current one stays, so you can roll back.
                        </p>
                    </div>
                )}
            </div>

            <div className={cn("flex items-center justify-end gap-2 border-t border-border/60", isMobile ? "px-4 py-3" : "p-6 pt-4")}>
                <Button variant="ghost" onClick={() => { onOpenChange(false); }}>Cancel</Button>
                <Button
                    onClick={() => { save.mutate(); }}
                    disabled={!canSave || save.isPending}
                >
                    {save.isPending ? "Saving…" : isEdit ? "Publish version" : "Create skill"}
                </Button>
            </div>
        </>
    );
}

/** The version number a publish will produce. */
function nextVersionHint(current: string | null | undefined): string {
    if (!current) return "1.0.0";
    const parts = current.split(".");
    if (parts.length !== 3 || parts.some(p => !/^\d+$/.test(p))) return "1.0.0";
    const [major, minor, patch] = parts as [string, string, string];
    return `${major}.${minor}.${String(Number(patch) + 1)}`;
}

export function SkillForge({open, editing, onOpenChange}: {
    open: boolean;
    editing?: Skill | null;
    onOpenChange: (open: boolean) => void;
}) {
    const isMobile = useIsMobile();
    // Cache across the close transition; key a fresh form per open.
    const [cached, setCached] = useState<Skill | null>(null);
    const [epoch, setEpoch] = useState(0);
    const [wasOpen, setWasOpen] = useState(false);
    if (open !== wasOpen) {
        setWasOpen(open);
        if (open) {
            setCached(editing ?? null);
            setEpoch(e => e + 1);
        }
    }

    const form = (
        <ForgeForm
            key={`${cached?.skill_id ?? "new"}:${String(epoch)}`}
            editing={cached}
            onOpenChange={onOpenChange}
        />
    );

    if (isMobile) {
        return (
            <Drawer open={open} onOpenChange={onOpenChange}>
                <DrawerContent>{form}</DrawerContent>
            </Drawer>
        );
    }
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent
                className="grid-rows-[auto_minmax(0,1fr)_auto] gap-0 p-0 sm:max-w-xl"
                style={{maxHeight: "min(44rem, calc(100dvh - 4rem))"}}
            >
                {form}
            </DialogContent>
        </Dialog>
    );
}
