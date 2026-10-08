import {useState} from "react";
import {BookOpen01Icon, UserIcon} from "@hugeicons/core-free-icons";
import {Bot} from "lucide-react";
import type {AppIcon} from "@/components/Icon";
import type {Skill} from "@/lib/api";

/** The library's scope filter. There is no "all": the library is the org's skills, so `org` is the superset and the
 *  others are slices of it. Public is not a scope, since nothing publishes outside an org yet. */
export type SkillScope = "org" | "mine" | "agents";

export const SKILL_SCOPES: {id: SkillScope; label: string; icon: AppIcon}[] = [
    {id: "org", label: "Org library", icon: BookOpen01Icon},
    {id: "mine", label: "Mine", icon: UserIcon},
    {id: "agents", label: "On agents", icon: Bot},
];

/** The skills in a scope. With no signed-in user, nothing is "mine". */
export function filterSkillsByScope(skills: Skill[], scope: SkillScope, userId: number | null): Skill[] {
    if (scope === "mine") return userId == null ? [] : skills.filter(s => s.created_by === userId);
    // Confirmed installs only: a skill an agent hasn't acknowledged is not on it.
    if (scope === "agents") return skills.filter(s => s.installed_agent_count > 0);
    return skills;
}

/** Case-insensitive substring match on the name, the slug and the summary. */
export function matchesSkillQuery(skill: Skill, query: string): boolean {
    const q = query.trim().toLowerCase();
    return [skill.display_name, skill.slug, skill.summary].some(text => text.toLowerCase().includes(q));
}

/** The library's sections, each naming where its skills stand, in the server's newest-first order. Empty sections
 *  are dropped. */
export function skillSections(skills: Skill[]): {label: string; skills: Skill[]}[] {
    const published = skills.filter(s => !s.is_draft);
    return [
        {label: "Used by agents", skills: published.filter(s => s.installed_agent_count > 0)},
        {label: "Not on any agent yet", skills: published.filter(s => s.installed_agent_count === 0)},
        {label: "Drafts", skills: skills.filter(s => s.is_draft)},
    ].filter(section => section.skills.length > 0);
}

const SCOPE_KEY = "fc_skills_scope";

/** The scope selection, persisted like `useChatTab` so it survives a reload. */
export function useSkillScope(): [SkillScope, (scope: SkillScope) => void] {
    const [scope, setScopeState] = useState<SkillScope>(() => {
        const stored = localStorage.getItem(SCOPE_KEY);
        return SKILL_SCOPES.find(s => s.id === stored)?.id ?? "org";
    });
    const setScope = (next: SkillScope) => {
        setScopeState(next);
        localStorage.setItem(SCOPE_KEY, next);
    };
    return [scope, setScope];
}
