import {useNavigate} from "react-router-dom";
import {
    BookOpen01Icon as Book,
    Delete02Icon as Trash,
    GitForkIcon as Fork,
    MoreHorizontalIcon as More,
    PencilEdit02Icon as Pencil,
} from "@hugeicons/core-free-icons";
import {Icon} from "@/components/Icon";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type {Skill} from "@/lib/api";
import {
    SKILL_ACCENT_BG,
    accentForSkill,
    originLabel,
    skillDetailPath,
} from "@/lib/skills";
import {cn} from "@/lib/utils";

export interface SkillCardActions {
    onEdit: (s: Skill) => void;
    onFork: (s: Skill) => void;
    onDelete: (s: Skill) => void;
}

/** A catalog skill. No sync chip: here a skill is a document, not something
 *  attached to an agent. `Draft` means no published version yet. */
export function SkillCard({skill, actions}: {skill: Skill; actions: SkillCardActions}) {
    const navigate = useNavigate();
    const accent = accentForSkill(skill.skill_id);
    const origin = originLabel(skill);

    return (
        <div
            role="button"
            tabIndex={0}
            onClick={() => { void navigate(skillDetailPath(skill)); }}
            onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    void navigate(skillDetailPath(skill));
                }
            }}
            className={cn(
                "group relative flex cursor-pointer flex-col rounded-xl border border-border/60 bg-card p-4 text-left",
                "transition duration-150 ease-out hover:border-border hover:bg-muted/40",
                "active:scale-[0.99] motion-reduce:transition-none",
            )}
        >
            <div className="flex items-start gap-3">
                <span
                    className={cn(
                        "flex size-12 shrink-0 items-center justify-center rounded-xl text-white",
                        SKILL_ACCENT_BG[accent],
                    )}
                >
                    {skill.icon_emoji ? (
                        <span className="text-2xl leading-none">{skill.icon_emoji}</span>
                    ) : (
                        <Icon icon={Book} className="size-6"/>
                    )}
                </span>
                <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-base font-semibold leading-snug tracking-tight text-foreground">
                            {skill.display_name}
                        </span>
                        {skill.is_draft ? (
                            <span className="shrink-0 rounded-full bg-amber-500/15 px-2 py-0.5 text-caption font-medium text-amber-700 dark:text-amber-400">
                                Draft
                            </span>
                        ) : (
                            <span className="shrink-0 font-mono text-caption text-muted-foreground">
                                v{skill.latest_version}
                            </span>
                        )}
                    </div>
                    <div className="mt-0.5 truncate font-mono text-caption text-muted-foreground">
                        {skill.slug}
                    </div>
                </div>
            </div>

            <p className="mt-3 line-clamp-2 text-sm leading-snug text-muted-foreground">
                {skill.summary}
            </p>

            <div className="mt-3 flex items-center gap-2">
                {origin && (
                    <span className="rounded-full bg-muted px-2 py-0.5 text-caption text-muted-foreground">
                        {origin}
                    </span>
                )}
                <div
                    className="ml-auto opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 [@media(pointer:coarse)]:opacity-100"
                    onClick={(e) => { e.stopPropagation(); }}
                >
                    <DropdownMenu>
                        <DropdownMenuTrigger
                            aria-label={`Actions for ${skill.display_name}`}
                            className="flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
                        >
                            <Icon icon={More} className="size-4"/>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => { actions.onEdit(skill); }}>
                                <Icon icon={Pencil} className="size-4"/>
                                Edit
                            </DropdownMenuItem>
                            <DropdownMenuItem
                                onClick={() => { actions.onFork(skill); }}
                                disabled={skill.is_draft}
                            >
                                <Icon icon={Fork} className="size-4"/>
                                Fork
                            </DropdownMenuItem>
                            <DropdownMenuItem
                                variant="destructive"
                                onClick={() => { actions.onDelete(skill); }}
                            >
                                <Icon icon={Trash} className="size-4"/>
                                Delete
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
            </div>
        </div>
    );
}
