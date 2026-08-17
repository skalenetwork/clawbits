import {useCallback, useState} from "react";
import {
    BookOpen01Icon,
    Globe02Icon,
    Robot02Icon,
    UserIcon,
} from "@hugeicons/core-free-icons";
import type {IconSvgElement} from "@hugeicons/react";
import type {Skill} from "@/lib/api";

/**
 * The scope filter behind the skills sidebar's title-as-menu control.
 *
 * There is deliberately no separate "all" scope: the library IS the org's
 * skills, so an All row and an Org row would filter to the same set and one of
 * them would be a lie about the product. ``org`` is the superset and ``mine``
 * is a slice of it — filters, not partitions.
 *
 * ``public`` is listed but never selectable, because nothing publishes outside
 * an org yet: every skills route is org-scoped, ``Skill.visibility`` is a
 * reserved column no code path writes, and there is no cross-org discovery
 * read. Showing it greyed is honest about where the product is going; a scope
 * that silently returned nothing would not be.
 */
export type SkillScope = "org" | "mine" | "agents" | "public";

export interface SkillScopeDescriptor {
    id: SkillScope;
    /** Menu row label. Doubles as the sidebar title when selected. */
    label: string;
    icon: IconSvgElement;
    /** Listed in the menu but not pickable — see the note above. */
    disabled?: boolean;
}

export const SKILL_SCOPES: SkillScopeDescriptor[] = [
    {id: "org", label: "Org library", icon: BookOpen01Icon},
    {id: "mine", label: "Mine", icon: UserIcon},
    {id: "agents", label: "On agents", icon: Robot02Icon},
    {id: "public", label: "Public", icon: Globe02Icon, disabled: true},
];

export const SELECTABLE_SKILL_SCOPES = SKILL_SCOPES.filter(s => !s.disabled);

export function skillScopeLabel(scope: SkillScope): string {
    return SKILL_SCOPES.find(s => s.id === scope)?.label ?? "Org library";
}

/** The skills matching a scope. ``userId`` is the signed-in human's id — with
 *  no user in hand, "mine" can only honestly be empty. */
export function filterSkillsByScope(
    skills: Skill[],
    scope: SkillScope,
    userId: number | null,
): Skill[] {
    if (scope === "mine") {
        return userId == null ? [] : skills.filter(s => s.created_by === userId);
    }
    if (scope === "agents") {
        // Confirmed only. A skill an agent hasn't acknowledged is not "on" it.
        return skills.filter(s => s.installed_agent_count > 0);
    }
    // ``public`` can't be selected, so it falls through with everything else.
    return skills;
}

/** Substring match over the three things a person searches by: what it's
 *  called, what it's called on disk, and what it says it does. */
export function matchesSkillQuery(skill: Skill, query: string): boolean {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return (
        skill.display_name.toLowerCase().includes(q) ||
        skill.slug.toLowerCase().includes(q) ||
        skill.summary.toLowerCase().includes(q)
    );
}

const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface SkillGroup {
    id: "recent" | "earlier";
    label: string;
    skills: Skill[];
}

/**
 * Split by real recency (edited within a week), not an arbitrary top-N. Groups
 * with nothing in them are dropped, so a young library renders one unlabelled
 * list instead of an empty heading — the caller hides labels when only one
 * group comes back.
 */
export function groupSkillsByRecency(skills: Skill[], now = Date.now()): SkillGroup[] {
    const recent: Skill[] = [];
    const earlier: Skill[] = [];
    for (const skill of skills) {
        const at = skill.updated_at ? new Date(skill.updated_at).getTime() : 0;
        if (Number.isFinite(at) && now - at <= RECENT_WINDOW_MS) recent.push(skill);
        else earlier.push(skill);
    }
    return [
        {id: "recent" as const, label: "Recently edited", skills: recent},
        {id: "earlier" as const, label: "Earlier", skills: earlier},
    ].filter(g => g.skills.length > 0);
}

/**
 * The one state mark a row is allowed to show. Never two: a second mark buys
 * no information and costs the row's whole right edge.
 *
 * Priority is by what would change what you do next. A draft is installable
 * nowhere, so it outranks everything. Work in flight outranks a settled state
 * because it is the thing that might still fail. "Live on an agent" outranks
 * the version number, because the version is one click away in the inspector
 * and "is this actually anywhere" is not.
 */
export type SkillRowMark =
    | {kind: "draft"}
    | {kind: "pending"; agents: number}
    | {kind: "installed"; agents: number}
    | {kind: "version"; version: string};

export function skillRowMark(skill: Skill): SkillRowMark | null {
    if (skill.is_draft) return {kind: "draft"};
    if (skill.pending_agent_count > 0) {
        return {kind: "pending", agents: skill.pending_agent_count};
    }
    if (skill.installed_agent_count > 0) {
        return {kind: "installed", agents: skill.installed_agent_count};
    }
    if (skill.latest_version) return {kind: "version", version: skill.latest_version};
    return null;
}

/** What the mark means, spelled out for a tooltip and for screen readers —
 *  a bare dot has to say what it is somewhere. */
export function skillRowMarkLabel(mark: SkillRowMark): string {
    if (mark.kind === "draft") return "Draft — not published, so no agent can have it";
    if (mark.kind === "pending") {
        return `Syncing on ${String(mark.agents)} agent${mark.agents === 1 ? "" : "s"}`;
    }
    if (mark.kind === "installed") {
        return `On ${String(mark.agents)} agent${mark.agents === 1 ? "" : "s"}`;
    }
    return `Version ${mark.version}`;
}

const SCOPE_STORAGE_KEY = "fc_skills_scope";

function isSelectableScope(v: string | null): v is SkillScope {
    return SELECTABLE_SKILL_SCOPES.some(s => s.id === v);
}

/**
 * The persisted scope selection, mirroring ``useChatTab``. Stored so the filter
 * survives a reload and follows the user between the desktop sidebar and the
 * mobile library screen — they are never mounted at once, so one key is enough.
 */
export function useSkillScope(): [SkillScope, (scope: SkillScope) => void] {
    const [scope, setScopeState] = useState<SkillScope>(() => {
        const stored = localStorage.getItem(SCOPE_STORAGE_KEY);
        return isSelectableScope(stored) ? stored : "org";
    });
    const setScope = useCallback((next: SkillScope) => {
        // Guards against a disabled scope being persisted and then loaded back
        // as a filter nothing can satisfy.
        if (!isSelectableScope(next)) return;
        setScopeState(next);
        localStorage.setItem(SCOPE_STORAGE_KEY, next);
    }, []);
    return [scope, setScope];
}
