import {useState} from "react";
import {useQuery} from "@tanstack/react-query";
import {
    BookOpen01Icon as Book,
    PlusSignIcon as Plus,
    Search01Icon as Search,
} from "@hugeicons/core-free-icons";
import {Icon} from "@/components/Icon";
import {PageHeader} from "@/components/PageHeader";
import {SkillForge} from "@/components/skills/SkillForge";
import {SkillList} from "@/components/skills/SkillList";
import {SkillScopeMenu} from "@/components/skills/SkillScopeMenu";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {useAuth} from "@/context/AuthContext";
import {listOrgSkills} from "@/lib/api";
import {queryKeys} from "@/lib/queryKeys";
import {
    SELECTABLE_SKILL_SCOPES,
    filterSkillsByScope,
    matchesSkillQuery,
    useSkillScope,
    type SkillScope,
} from "@/lib/skillScopes";
import {errMsg} from "@/lib/toast";

/** ``/skills``: the org's library as a full page, with the scope menu in the
 *  page header, search, and the list. */
export default function SkillsPage() {
    const {user, activeOrgId} = useAuth();
    const [scope, setScope] = useSkillScope();
    const [query, setQuery] = useState("");
    const [forgeOpen, setForgeOpen] = useState(false);

    const skillsQuery = useQuery({
        queryKey: queryKeys.skills(activeOrgId ?? ""),
        queryFn: () => listOrgSkills(activeOrgId ?? ""),
        enabled: Boolean(activeOrgId),
    });

    if (!activeOrgId) {
        return <div className="text-sm text-muted-foreground">Select an organization.</div>;
    }

    const all = skillsQuery.data?.skills ?? [];
    const userId = user?.id ?? null;
    const counts = Object.fromEntries(
        SELECTABLE_SKILL_SCOPES.map(s => [s.id, filterSkillsByScope(all, s.id, userId).length]),
    ) as Record<SkillScope, number>;
    counts.public = 0;

    const scoped = filterSkillsByScope(all, scope, userId);
    const visible = query.trim() ? scoped.filter(s => matchesSkillQuery(s, query)) : scoped;

    return (
        <div className="flex flex-col gap-3 pb-16">
            <PageHeader
                title={
                    <SkillScopeMenu scope={scope} onScopeChange={setScope} counts={counts}/>
                }
                actions={
                    <Button size="compact" onClick={() => { setForgeOpen(true); }}>
                        <Icon icon={Plus}/>
                        New
                    </Button>
                }
            />
            <div className="relative">
                <Icon
                    icon={Search}
                    className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                />
                <Input
                    value={query}
                    onChange={(e) => { setQuery(e.target.value); }}
                    placeholder="Search skills"
                    aria-label="Search skills"
                    className="pl-9"
                />
            </div>
            {skillsQuery.isPending ? (
                <p className="px-1 text-sm text-muted-foreground">Loading skills…</p>
            ) : skillsQuery.isError ? (
                <p className="px-1 text-sm text-destructive">{errMsg(skillsQuery.error)}</p>
            ) : all.length === 0 ? (
                <ZeroState onCreate={() => { setForgeOpen(true); }}/>
            ) : visible.length > 0 ? (
                <SkillList skills={visible} grouped={!query.trim()}/>
            ) : (
                <p className="px-1 py-8 text-center text-sm text-muted-foreground">
                    {query.trim() ? "No skill matches that." : "Nothing in this view."}
                </p>
            )}
            <SkillForge open={forgeOpen} editing={null} onOpenChange={setForgeOpen}/>
        </div>
    );
}

function ZeroState({onCreate}: {onCreate: () => void}) {
    return (
        <div className="flex flex-col items-center justify-center px-6 py-20 text-center">
            <span className="flex size-12 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                <Icon icon={Book} className="size-6"/>
            </span>
            <h2 className="mt-4 text-base font-semibold tracking-tight text-foreground">
                No skills yet
            </h2>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                A skill is a set of instructions your agents can follow — how your team writes changelogs, how to triage an invoice, the house style for a report.
            </p>
            <Button className="mt-4" size="sm" onClick={onCreate}>
                <Icon icon={Plus} className="size-4"/>
                New skill
            </Button>
        </div>
    );
}
