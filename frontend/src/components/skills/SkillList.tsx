import {NavLink} from "react-router-dom";
import type {Skill} from "@/lib/api";
import {SkillGlyph} from "@/components/skills/SkillGlyph";
import {skillDetailPath} from "@/lib/skills";
import {
    groupSkillsByRecency,
    skillRowMark,
    skillRowMarkLabel,
    type SkillRowMark,
} from "@/lib/skillScopes";
import {cn} from "@/lib/utils";

/**
 * The library list: two-line rows, emoji first, one state mark on the right.
 *
 * Shared by the desktop contextual sidebar and the mobile library screen, so it
 * is plain markup rather than the sidebar primitives — those need a
 * SidebarProvider the mobile shell doesn't mount, and they are single-line by
 * construction.
 *
 * Groups are real recency ("edited this week" vs not), not an arbitrary top-N,
 * and their labels only appear when there is more than one group to tell apart.
 */
export function SkillList({
    skills,
    activeSkillId,
    grouped = true,
    className,
}: {
    skills: Skill[];
    activeSkillId?: string | null;
    /** Off while searching: results are ranked by the query, not by age. */
    grouped?: boolean;
    className?: string;
}) {
    const groups = grouped
        ? groupSkillsByRecency(skills)
        : [{id: "recent" as const, label: "", skills}];
    const showLabels = grouped && groups.length > 1;

    return (
        <div className={cn("flex flex-col", className)}>
            {groups.map(group => (
                <div key={group.id} className="flex flex-col">
                    {showLabels && (
                        <div className="px-2.5 pt-3 pb-1 text-caption text-muted-foreground">
                            {group.label}
                        </div>
                    )}
                    <ul className="flex w-full min-w-0 flex-col gap-0.5">
                        {group.skills.map(skill => (
                            <li key={skill.skill_id}>
                                <SkillRow
                                    skill={skill}
                                    isActive={skill.skill_id === activeSkillId}
                                />
                            </li>
                        ))}
                    </ul>
                </div>
            ))}
        </div>
    );
}

function SkillRow({skill, isActive}: {skill: Skill; isActive: boolean}) {
    const mark = skillRowMark(skill);
    return (
        <NavLink
            to={skillDetailPath(skill)}
            viewTransition
            className={cn(
                "flex w-full min-w-0 items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left",
                "outline-hidden transition-colors hover:bg-[var(--sb-hover)]",
                "focus-visible:ring-2 focus-visible:ring-sidebar-ring",
                isActive && "bg-sidebar-foreground/10",
            )}
        >
            <SkillGlyph skill={skill} size="md"/>
            <span className="min-w-0 flex-1">
                {/* Weight stays put across selection: the row's fill already
                    marks it, and reflowing the name on click reads as a jump. */}
                <span className="block truncate text-[13px] font-medium leading-tight text-sidebar-foreground">
                    {skill.display_name}
                </span>
                <span className="mt-0.5 block truncate text-caption leading-tight text-muted-foreground">
                    {skill.summary}
                </span>
            </span>
            {mark && <SkillMark mark={mark}/>}
        </NavLink>
    );
}

/** One mark, chosen by ``skillRowMark``. The dot states carry their meaning in
 *  a title + screen-reader text, since a dot alone says nothing. */
function SkillMark({mark}: {mark: SkillRowMark}) {
    const label = skillRowMarkLabel(mark);

    if (mark.kind === "version") {
        return (
            <span className="shrink-0 text-caption text-muted-foreground tabular-nums">
                v{mark.version}
            </span>
        );
    }
    if (mark.kind === "draft") {
        return (
            <span
                title={label}
                className="shrink-0 text-caption font-medium text-amber-700 dark:text-amber-400"
            >
                Draft
            </span>
        );
    }
    return (
        <span title={label} className="flex shrink-0 items-center">
            <span
                className={cn(
                    "size-1.5 rounded-full",
                    mark.kind === "installed"
                        ? "bg-emerald-600 dark:bg-emerald-400"
                        // In flight, so it gets the same amber as every other
                        // "we asked, the agent hasn't confirmed" state.
                        : "bg-amber-600 dark:bg-amber-400",
                )}
            />
            <span className="sr-only">{label}</span>
        </span>
    );
}
