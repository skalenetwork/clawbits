import {useRef, useState} from "react";
import {useLocation} from "react-router-dom";
import {useQuery} from "@tanstack/react-query";
import {
    Add01Icon as Plus,
    Cancel01Icon as Cancel,
    Search01Icon as Search,
} from "@hugeicons/core-free-icons";
import {Icon} from "@/components/Icon";
import {SkillForge} from "@/components/skills/SkillForge";
import {SkillList} from "@/components/skills/SkillList";
import {SkillScopeMenu} from "@/components/skills/SkillScopeMenu";
import {Skeleton} from "@/components/ui/skeleton";
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
import {ContextualHeader} from "./ContextualHeader";

/**
 * The Skills contextual sidebar — the org's library as a list you never leave.
 *
 * The header's TITLE is the scope menu (Org library / Mine / On agents, plus a
 * disabled Public that says what it is waiting for). At 15rem, stacking a
 * select and a search field above the list would cost roughly two visible
 * skills, so the control lives in the row the header already had, and search
 * expands into that same row instead of claiming another.
 *
 * Rows are two-line and emoji-first, with exactly one state mark on the right
 * (see ``skillRowMark``). The selected skill's detail renders in the content
 * pane beside this list, so comparing two skills is one click, not two
 * navigations and a Back.
 */
export function SkillsSidebar() {
    const {user, activeOrgId} = useAuth();
    const {pathname} = useLocation();
    const match = /^\/skills\/([^/]+)/.exec(pathname);
    const activeSkillId = match?.[1] ? decodeURIComponent(match[1]) : null;

    const [scope, setScope] = useSkillScope();
    const [searching, setSearching] = useState(false);
    const [query, setQuery] = useState("");
    const [forgeOpen, setForgeOpen] = useState(false);
    const searchRef = useRef<HTMLInputElement>(null);

    const skillsQuery = useQuery({
        queryKey: queryKeys.skills(activeOrgId ?? ""),
        queryFn: () => listOrgSkills(activeOrgId ?? ""),
        enabled: Boolean(activeOrgId),
    });

    const all = skillsQuery.data?.skills ?? [];
    const userId = user?.id ?? null;
    // Counts describe the whole library, not the current search — the menu
    // answers "what would picking this give me", and a query is a second,
    // temporary filter on top.
    const counts = Object.fromEntries(
        SELECTABLE_SKILL_SCOPES.map(s => [s.id, filterSkillsByScope(all, s.id, userId).length]),
    ) as Record<SkillScope, number>;
    counts.public = 0;

    const scoped = filterSkillsByScope(all, scope, userId);
    const visible = query.trim() ? scoped.filter(s => matchesSkillQuery(s, query)) : scoped;

    const closeSearch = () => {
        setSearching(false);
        setQuery("");
    };

    return (
        <>
            <ContextualHeader
                title={
                    searching ? (
                        <input
                            ref={searchRef}
                            autoFocus
                            value={query}
                            onChange={(e) => { setQuery(e.target.value); }}
                            onKeyDown={(e) => { if (e.key === "Escape") closeSearch(); }}
                            // Blurring with nothing typed means the search was
                            // opened by accident; hand the row back to the title.
                            onBlur={() => { if (!query.trim()) closeSearch(); }}
                            placeholder="Search skills"
                            aria-label="Search skills"
                            className="w-full min-w-0 bg-transparent text-sm text-sidebar-foreground outline-none placeholder:text-muted-foreground"
                        />
                    ) : (
                        <SkillScopeMenu scope={scope} onScopeChange={setScope} counts={counts}/>
                    )
                }
                action={
                    <>
                        <button
                            type="button"
                            aria-label={searching ? "Close search" : "Search skills"}
                            onClick={() => {
                                if (searching) closeSearch();
                                else setSearching(true);
                            }}
                            className="flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-[var(--sb-hover)] hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
                        >
                            <Icon icon={searching ? Cancel : Search} className="size-4"/>
                        </button>
                        {!searching && (
                            <button
                                type="button"
                                aria-label="New skill"
                                onClick={() => { setForgeOpen(true); }}
                                className="flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-[var(--sb-hover)] hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
                            >
                                <Icon icon={Plus} className="size-4"/>
                            </button>
                        )}
                    </>
                }
            />

            <div data-vt-contextual="" className="no-scrollbar flex-1 overflow-y-auto p-1 pt-13">
                {!activeOrgId ? (
                    <Empty>Select an organization.</Empty>
                ) : skillsQuery.isPending ? (
                    <ul className="flex flex-col gap-0.5" aria-hidden="true">
                        {Array.from({length: 6}, (_, i) => (
                            <li key={i} className="flex items-center gap-2.5 px-2.5 py-1.5">
                                <Skeleton className="size-7 shrink-0 rounded-lg"/>
                                <div className="flex min-w-0 flex-1 flex-col gap-1">
                                    <Skeleton className="h-3 w-2/3"/>
                                    <Skeleton className="h-2.5 w-full"/>
                                </div>
                            </li>
                        ))}
                    </ul>
                ) : skillsQuery.isError ? (
                    <Empty tone="error">{errMsg(skillsQuery.error)}</Empty>
                ) : visible.length > 0 ? (
                    <SkillList
                        skills={visible}
                        activeSkillId={activeSkillId}
                        // While searching, order is the query's business, so
                        // recency headings would be noise.
                        grouped={!query.trim()}
                    />
                ) : (
                    <Empty>{emptyMessage({total: all.length, scope, searching: Boolean(query.trim())})}</Empty>
                )}
            </div>

            <SkillForge
                open={forgeOpen}
                editing={null}
                onOpenChange={setForgeOpen}
            />
        </>
    );
}

/** Says which of the three empties this is — no library, no matches for the
 *  scope, or no matches for the query — so the next action is obvious. */
function emptyMessage({total, scope, searching}: {
    total: number;
    scope: SkillScope;
    searching: boolean;
}): string {
    if (searching) return "No skill matches that.";
    if (total === 0) return "No skills yet. Write the first one.";
    if (scope === "mine") return "You haven't written one yet.";
    if (scope === "agents") return "None of these are on an agent yet.";
    return "Nothing here.";
}

function Empty({children, tone}: {children: React.ReactNode; tone?: "error"}) {
    return (
        <p
            className={`px-3 py-6 text-center text-caption ${
                tone === "error" ? "text-destructive" : "text-muted-foreground"
            }`}
        >
            {children}
        </p>
    );
}
