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
import {useSidebar} from "@/components/ui/sidebar";
import {useIsMobile} from "@/hooks/use-mobile";
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

/**
 * ``/skills`` with nothing selected.
 *
 * On desktop the library lives in the contextual sidebar, so this route is the
 * zero state that tells you to pick one (or write the first). On mobile there
 * is no sidebar — the shell renders one full-screen column — so the same route
 * IS the library, built from the same list and the same scope menu, hosted in
 * the page header instead of a sidebar header.
 */
export default function SkillsPage() {
    const isMobile = useIsMobile();
    // Two components rather than one conditional hook: useSidebar() throws
    // outside a SidebarProvider, and the mobile shell mounts none.
    return isMobile ? <SkillsLibrary/> : <DesktopSkillsPage/>;
}

/** Desktop: the sidebar normally holds the library, so this route is the zero
 *  state. Collapse the sidebar (⌘B) and that would be a dead end with no way to
 *  reach a skill, so the list moves inline instead. */
function DesktopSkillsPage() {
    const {open} = useSidebar();
    return open ? <SkillsZeroState/> : <SkillsLibrary/>;
}

function SkillsZeroState() {
    const {activeOrgId} = useAuth();
    const [forgeOpen, setForgeOpen] = useState(false);
    const skillsQuery = useQuery({
        queryKey: queryKeys.skills(activeOrgId ?? ""),
        queryFn: () => listOrgSkills(activeOrgId ?? ""),
        enabled: Boolean(activeOrgId),
    });

    if (!activeOrgId) {
        return <div className="text-sm text-muted-foreground">Select an organization.</div>;
    }
    const empty = !skillsQuery.isPending && (skillsQuery.data?.skills.length ?? 0) === 0;

    return (
        <div className="pb-16">
            <PageHeader
                icon={Book}
                title="Skills"
                actions={
                    <Button size="sm" onClick={() => { setForgeOpen(true); }}>
                        <Icon icon={Plus} className="size-4"/>
                        New skill
                    </Button>
                }
            />
            <ZeroState empty={empty} onCreate={() => { setForgeOpen(true); }}/>
            <SkillForge open={forgeOpen} editing={null} onOpenChange={setForgeOpen}/>
        </div>
    );
}

/** The library as a full page: scope menu in the page header, search, list.
 *  Used on mobile, and on desktop whenever the sidebar is collapsed. */
function SkillsLibrary() {
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

    const forge = (
        <SkillForge open={forgeOpen} editing={null} onOpenChange={setForgeOpen}/>
    );

    return (
        <div className="flex flex-col gap-3 pb-16">
            <PageHeader
                title={
                    <SkillScopeMenu scope={scope} onScopeChange={setScope} counts={counts}/>
                }
                actions={
                    <Button size="sm" onClick={() => { setForgeOpen(true); }}>
                        <Icon icon={Plus} className="size-4"/>
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
                <ZeroState empty onCreate={() => { setForgeOpen(true); }}/>
            ) : visible.length > 0 ? (
                <SkillList skills={visible} grouped={!query.trim()}/>
            ) : (
                <p className="px-1 py-8 text-center text-sm text-muted-foreground">
                    {query.trim() ? "No skill matches that." : "Nothing in this view."}
                </p>
            )}
            {forge}
        </div>
    );
}

/** Two different nothings: an empty library (write one) and a library you
 *  simply haven't picked from yet (pick one). */
function ZeroState({empty, onCreate}: {empty: boolean; onCreate: () => void}) {
    return (
        <div className="flex flex-col items-center justify-center px-6 py-20 text-center">
            <span className="flex size-12 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                <Icon icon={Book} className="size-6"/>
            </span>
            <h2 className="mt-4 text-base font-semibold tracking-tight text-foreground">
                {empty ? "No skills yet" : "Pick a skill"}
            </h2>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                {empty
                    ? "A skill is a set of instructions your agents can follow — how your team writes changelogs, how to triage an invoice, the house style for a report."
                    : "Choose one from the library to read it, edit it, or see which agents have it."}
            </p>
            {empty && (
                <Button className="mt-4" size="sm" onClick={onCreate}>
                    <Icon icon={Plus} className="size-4"/>
                    New skill
                </Button>
            )}
        </div>
    );
}
