import {useRef, useState} from "react";
import {useNavigate} from "react-router-dom";
import {useQuery} from "@tanstack/react-query";
import {BookOpen01Icon as Book, Search01Icon as Search} from "@hugeicons/core-free-icons";
import {BookOpen} from "lucide-react";
import {Icon} from "@/components/Icon";
import {PageHeader} from "@/components/PageHeader";
import {Squircle, SquircleDefs} from "@/components/home/tiles";
import {SettingsPage, SettingsRow, SettingsSection, SettingsTile, TileGrid} from "@/components/settings/Settings";
import {AddToAgentsDialog} from "@/components/skills/AddToAgentsDialog";
import {ImportSkillDialog} from "@/components/skills/ImportSkillDialog";
import {SkillForge} from "@/components/skills/SkillForge";
import {SkillMenu} from "@/components/skills/SkillMenu";
import {SkillScopeMenu} from "@/components/skills/SkillScopeMenu";
import {SkillTile} from "@/components/skills/SkillTile";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {Skeleton} from "@/components/ui/skeleton";
import {useAuth} from "@/context/AuthContext";
import {listOrgSkills, type Skill, type SkillDraft} from "@/lib/api";
import {queryKeys} from "@/lib/queryKeys";
import {useShortcut} from "@/lib/shortcuts";
import {skillDetailPath} from "@/lib/skills";
import {filterSkillsByScope, matchesSkillQuery, skillSections, useSkillScope} from "@/lib/skillScopes";
import {errMsg} from "@/lib/toast";

const PHONE_FIELD = "max-md:h-10 max-md:rounded-xl max-md:border-transparent max-md:bg-[var(--field)]";

/** ``/skills``: the org's library in the settings column, a scope and search
 *  toolbar, then the skills sectioned by where each one stands. */
export default function SkillsPage() {
    const {user, activeOrgId} = useAuth();
    const orgId = activeOrgId ?? "";
    const [scope, setScope] = useSkillScope();
    const [query, setQuery] = useState("");
    const [importOpen, setImportOpen] = useState(false);
    const [forge, setForge] = useState<{editing?: Skill; draft?: SkillDraft} | null>(null);
    const [adding, setAdding] = useState<Skill | null>(null);
    const searchRef = useRef<HTMLInputElement>(null);
    const navigate = useNavigate();

    useShortcut({id: "skills-search", keys: "/", run: () => { searchRef.current?.focus(); }});

    const skillsQuery = useQuery({
        queryKey: queryKeys.skills(orgId),
        queryFn: () => listOrgSkills(orgId),
        enabled: Boolean(activeOrgId),
    });

    if (!activeOrgId) {
        return <div className="text-sm text-muted-foreground">Select an organization.</div>;
    }

    const all = skillsQuery.data?.skills ?? [];
    const empty = skillsQuery.isSuccess && all.length === 0;
    const userId = user?.id ?? null;
    const sections = skillSections(filterSkillsByScope(all, scope, userId).filter(s => matchesSkillQuery(s, query)));
    const openNew = () => { setForge({}); };
    const createActions = (size: "compact" | "sm") => (
        <>
            <Button variant="secondary" size={size} onClick={() => { setImportOpen(true); }}>Import</Button>
            <Button size={size} onClick={openNew}>New skill</Button>
        </>
    );
    const noMatch = query.trim()
        ? {title: "No skill matches that search", action: "Clear search", run: () => { setQuery(""); }}
        : scope === "mine"
          ? {title: "You haven't made a skill yet", action: "New skill", run: openNew}
          : {title: "No skill is on an agent yet", action: "Show org library", run: () => { setScope("org"); }};

    return (
        <SettingsPage>
            <SquircleDefs/>
            <PageHeader
                breadcrumb={[{label: "Skills", icon: BookOpen}]}
                actions={!empty && createActions("compact")}
            />

            {skillsQuery.isPending ? (
                <SettingsSection stack>
                    <TileGrid>
                        {[0, 1, 2, 3].map(i => (
                            <SettingsTile
                                key={i}
                                leading={<Skeleton className="size-10 rounded-[12px]"/>}
                                title={<Skeleton className="h-3.5 w-32 rounded"/>}
                                subtitle={<Skeleton className="mt-1.5 h-3 w-48 rounded"/>}
                            />
                        ))}
                    </TileGrid>
                </SettingsSection>
            ) : skillsQuery.isError ? (
                <SettingsSection>
                    <SettingsRow title="Couldn't load skills" error={errMsg(skillsQuery.error, "Try again in a moment")}/>
                </SettingsSection>
            ) : empty ? (
                <SettingsSection>
                    <div className="grid grid-cols-[40px_minmax(0,1fr)] items-start gap-x-[11px] p-3">
                        <Squircle size={40} glass={false} className="bg-muted text-muted-foreground">
                            <Icon icon={Book} className="size-5"/>
                        </Squircle>
                        <div>
                            <p className="text-sm font-medium">No skills yet</p>
                            <p className="text-[13px] text-muted-foreground">
                                A skill is a short set of written instructions, like how to triage an incident, that your agents follow when that task comes up.
                            </p>
                            <div className="mt-3 flex gap-2">{createActions("sm")}</div>
                        </div>
                    </div>
                </SettingsSection>
            ) : (
                <div className="flex flex-col gap-4">
                    <div className="flex gap-2 sm:grid sm:grid-cols-2">
                        <SkillScopeMenu
                            skills={all}
                            userId={userId}
                            scope={scope}
                            onScopeChange={setScope}
                            className={`${PHONE_FIELD} max-md:text-sm`}
                        />
                        <div className="relative min-w-0 flex-1">
                            <Icon
                                icon={Search}
                                className="pointer-events-none absolute top-1/2 left-2.5 size-[15px] -translate-y-1/2 text-muted-foreground"
                            />
                            <Input
                                ref={searchRef}
                                size="sm"
                                value={query}
                                onChange={(e) => { setQuery(e.target.value); }}
                                placeholder="Search skills"
                                aria-label="Search skills"
                                aria-keyshortcuts="/"
                                className={`peer w-full px-8 max-md:text-base ${PHONE_FIELD}`}
                            />
                            {!query && (
                                <kbd className="pointer-events-none absolute top-1/2 right-1.5 grid h-5 min-w-5 -translate-y-1/2 place-items-center rounded-sm border border-border px-1 font-sans text-[11px] font-medium leading-none text-muted-foreground peer-focus:invisible max-md:hidden">
                                    /
                                </kbd>
                            )}
                        </div>
                    </div>
                    <div className="flex flex-col gap-7">
                        {sections.length > 0 ? sections.map(section => (
                            <SettingsSection key={section.label} label={section.label} stack>
                                <TileGrid>
                                    {section.skills.map(skill => (
                                        <SkillTile
                                            key={skill.skill_id}
                                            skill={skill}
                                            menu={
                                                <SkillMenu
                                                    skill={skill}
                                                    onAdd={() => { setAdding(skill); }}
                                                    onEdit={() => { setForge({editing: skill}); }}
                                                />
                                            }
                                        />
                                    ))}
                                </TileGrid>
                            </SettingsSection>
                        )) : (
                            <SettingsSection>
                                <SettingsRow
                                    title={noMatch.title}
                                    control={<Button variant="outline" size="sm" onClick={noMatch.run}>{noMatch.action}</Button>}
                                />
                            </SettingsSection>
                        )}
                    </div>
                </div>
            )}

            <ImportSkillDialog
                open={importOpen}
                onOpenChange={setImportOpen}
                onDraft={(draft) => {
                    setImportOpen(false);
                    setForge({draft});
                }}
            />
            <SkillForge
                open={forge !== null}
                editing={forge?.editing}
                draft={forge?.draft}
                onOpenChange={() => { setForge(null); }}
                onCreated={(skill) => { void navigate(skillDetailPath(skill)); }}
            />
            {adding && <AddToAgentsDialog open onOpenChange={() => { setAdding(null); }} skill={adding}/>}
        </SettingsPage>
    );
}
