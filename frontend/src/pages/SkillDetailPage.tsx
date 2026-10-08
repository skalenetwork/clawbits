import {Fragment, useState} from "react";
import {Link, useParams} from "react-router-dom";
import {useQuery} from "@tanstack/react-query";
import {BookOpen} from "lucide-react";
import {ArrowDown01Icon as ArrowDown} from "@hugeicons/core-free-icons";
import {Icon} from "@/components/Icon";
import {PageHeader} from "@/components/PageHeader";
import {SquircleDefs} from "@/components/home/tiles";
import {SettingsPage, SettingsRow, SettingsRowSkeleton, SettingsSection, SettingsTile, TileGrid} from "@/components/settings/Settings";
import {AddToAgentsDialog} from "@/components/skills/AddToAgentsDialog";
import {SkillAgents} from "@/components/skills/SkillAgents";
import {SkillDocument} from "@/components/skills/SkillDocument";
import {SkillForge} from "@/components/skills/SkillForge";
import {SkillGlyph} from "@/components/skills/SkillGlyph";
import {SkillMenu} from "@/components/skills/SkillMenu";
import {VersionDiff} from "@/components/skills/VersionDiff";
import {Button} from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {Skeleton} from "@/components/ui/skeleton";
import {useAuth} from "@/context/AuthContext";
import {agentDisplay} from "@/lib/agentDisplay";
import {
    getAgents,
    getSkill,
    listOrgSkills,
    listSkillVersions,
    renderSkillVersion,
    type SkillOrigin,
    type SkillRuntime,
} from "@/lib/api";
import {formatRelativeAgo, humanSize} from "@/lib/formatting";
import {queryKeys} from "@/lib/queryKeys";
import {RENDERABLE_RUNTIMES, RUNTIME_CAN_RECEIVE, RUNTIME_LABELS, skillDetailPath} from "@/lib/skills";
import {errMsg} from "@/lib/toast";
import {cn} from "@/lib/utils";

const PENDING = new Set(["requested", "removing"]);
const NAMES = new Intl.ListFormat("en", {type: "conjunction"});
const ORIGIN: Record<SkillOrigin, string> = {
    authored: "written in Clawbits",
    forked: "forked",
    imported: "imported",
};
const VALUE = "block max-w-80 truncate text-[13px] text-muted-foreground tabular-nums";
const MONO = cn(VALUE, "font-mono text-[12.5px]");
const SKELETON_GLYPH = <Skeleton className="size-10 rounded-[12px]"/>;

/** One skill in the settings column: who it is, where it runs and whether that is healthy, what it says, how it got
 *  here, then the facts. Adding it to agents is the one primary action, since that is what gives a skill any effect. */
export default function SkillDetailPage() {
    const {skillId = ""} = useParams();
    const {activeOrgId} = useAuth();
    const orgId = activeOrgId ?? "";
    const [editing, setEditing] = useState(false);
    const [adding, setAdding] = useState(false);
    const [view, setView] = useState<SkillRuntime | "written">("written");
    const [openVersionId, setOpenVersionId] = useState<string | null>(null);

    const skillQuery = useQuery({
        queryKey: queryKeys.skill(orgId, skillId),
        queryFn: () => getSkill(orgId, skillId),
        enabled: Boolean(activeOrgId),
        refetchInterval: (q) => (q.state.data?.agents?.some(a => PENDING.has(a.sync_status)) ? 5_000 : false),
    });
    const versionsQuery = useQuery({
        queryKey: queryKeys.skillVersions(orgId, skillId),
        queryFn: () => listSkillVersions(orgId, skillId),
        enabled: Boolean(activeOrgId),
    });
    const agentsQuery = useQuery({
        queryKey: queryKeys.agents(orgId),
        queryFn: () => getAgents(orgId),
        enabled: Boolean(activeOrgId),
    });

    const skill = skillQuery.data;
    const versionId = skill?.latest_version_id ?? "";

    const renderQuery = useQuery({
        queryKey: queryKeys.skillRender(orgId, skillId, versionId, view),
        queryFn: () => renderSkillVersion(orgId, skillId, versionId, view === "written" ? undefined : view),
        enabled: Boolean(versionId) && view !== "written",
    });
    const libraryQuery = useQuery({
        queryKey: queryKeys.skills(orgId),
        queryFn: () => listOrgSkills(orgId),
        enabled: Boolean(activeOrgId) && skill?.forked_from_skill_id != null,
    });

    if (!activeOrgId) {
        return <div className="text-sm text-muted-foreground">Select an organization.</div>;
    }

    const crumbs = [{label: "Skills", to: "/skills", icon: BookOpen}];

    if (!skill) {
        return (
            <SettingsPage>
                <PageHeader breadcrumb={crumbs}/>
                {skillQuery.isPending ? (
                    <>
                        <div className="flex items-center gap-[11px] px-3">
                            {SKELETON_GLYPH}
                            <Skeleton className="h-4 w-40 rounded"/>
                        </div>
                        <SettingsSection label="Agents" stack>
                            <TileGrid>
                                {[0, 1].map(i => (
                                    <SettingsTile
                                        key={i}
                                        leading={SKELETON_GLYPH}
                                        title={<Skeleton className="h-3.5 w-24 rounded"/>}
                                        subtitle={<Skeleton className="mt-1.5 h-3 w-16 rounded"/>}
                                    />
                                ))}
                            </TileGrid>
                        </SettingsSection>
                    </>
                ) : (
                    <SettingsSection>
                        <SettingsRow title="Couldn't load this skill" error={errMsg(skillQuery.error, "Skill not found")}/>
                    </SettingsSection>
                )}
            </SettingsPage>
        );
    }

    const versions = versionsQuery.data?.versions ?? [];
    const current = skill.current_version;
    const installs = skill.agents ?? [];
    const byId = new Map((agentsQuery.data?.agents ?? []).map(a => [a.agent_id, a]));
    const names = (list: typeof installs) => NAMES.format(list.map(a => agentDisplay(byId.get(a.agent_id) ?? a)));
    const firstAuthor = versions.at(-1)?.author;
    const parent = libraryQuery.data?.skills.find(s => s.skill_id === skill.forked_from_skill_id);
    const facts = [
        skill.latest_version ? `v${skill.latest_version}` : "Draft",
        versions[0]?.author,
        skill.updated_at && `updated ${formatRelativeAgo(skill.updated_at)}`,
        ORIGIN[skill.origin],
    ].filter(Boolean).join(" · ");
    const files = ["SKILL.md", ...(current?.files ?? []).map(f => f.path)].join(", ");
    const runtimes = skill.runtimes
        .map(rt => RUNTIME_CAN_RECEIVE[rt] ? RUNTIME_LABELS[rt] : `${RUNTIME_LABELS[rt]} preview only`)
        .join(", ");
    const markdown = view === "written" ? current?.body_md : renderQuery.data?.content;

    return (
        <SettingsPage>
            <SquircleDefs/>
            <PageHeader
                breadcrumb={[...crumbs, {label: skill.display_name, leading: <SkillGlyph skill={skill} size={16}/>}]}
                actions={
                    <>
                        <Button variant="secondary" size="compact" onClick={() => { setEditing(true); }}>Edit</Button>
                        <SkillMenu skill={skill}/>
                        <Button size="compact" disabled={skill.is_draft} onClick={() => { setAdding(true); }}>Add to agents</Button>
                    </>
                }
            />

            <div className="grid grid-cols-[40px_minmax(0,1fr)] items-start gap-x-[11px] px-3">
                <SkillGlyph skill={skill} className="row-span-3"/>
                <h1 className="text-lg leading-7 font-semibold">{skill.display_name}</h1>
                <p className="col-start-2 mt-1 text-sm">{skill.summary}</p>
                <p className="col-start-2 mt-1 text-[13px] text-muted-foreground tabular-nums">{facts}</p>
            </div>

            <SkillAgents skill={skill} versions={versions} agents={byId} onAdd={() => { setAdding(true); }}/>

            <SettingsSection
                label="Instructions"
                aside={current && (
                    <DropdownMenu>
                        <DropdownMenuTrigger
                            aria-label="View instructions as"
                            className="inline-flex items-center gap-1 rounded-sm font-medium text-foreground outline-none hover:opacity-70 focus-visible:ring-2 focus-visible:ring-ring/50"
                        >
                            {view === "written" ? "As written" : RUNTIME_LABELS[view]}
                            <Icon icon={ArrowDown} className="size-3.5 text-muted-foreground"/>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                            <DropdownMenuRadioGroup value={view} onValueChange={setView}>
                                <DropdownMenuRadioItem value="written">As written</DropdownMenuRadioItem>
                                {RENDERABLE_RUNTIMES.map(rt => (
                                    <DropdownMenuRadioItem key={rt} value={rt}>{RUNTIME_LABELS[rt]}</DropdownMenuRadioItem>
                                ))}
                            </DropdownMenuRadioGroup>
                        </DropdownMenuContent>
                    </DropdownMenu>
                )}
                footer={view !== "written" && !RUNTIME_CAN_RECEIVE[view]
                    ? `Preview only. ${RUNTIME_LABELS[view]} agents can't receive skills from Clawbits yet.`
                    : undefined}
            >
                <div className="p-4">
                    {renderQuery.isError ? (
                        <p className="font-mono text-[12.5px] text-destructive wrap-anywhere">{errMsg(renderQuery.error)}</p>
                    ) : markdown != null ? (
                        <SkillDocument markdown={markdown} displayName={skill.display_name}/>
                    ) : view === "written" ? (
                        <p className="text-[13px] text-muted-foreground">No instructions published yet.</p>
                    ) : (
                        <div className="flex flex-col gap-2">
                            <Skeleton className="h-3.5 w-3/4 rounded"/>
                            <Skeleton className="h-3.5 w-1/2 rounded"/>
                        </div>
                    )}
                </div>
            </SettingsSection>

            <SettingsSection
                label="History"
                aside={versions.length > 0 ? `${versions.length} version${versions.length === 1 ? "" : "s"}` : undefined}
            >
                {versionsQuery.isPending ? (
                    [0, 1].map(i => <SettingsRowSkeleton key={i} leading={false}/>)
                ) : versionsQuery.isError ? (
                    <SettingsRow title="Couldn't load the history" error={errMsg(versionsQuery.error)}/>
                ) : versions.length === 0 ? (
                    <SettingsRow title={<span className="font-normal text-muted-foreground">No versions yet</span>}/>
                ) : versions.map((v, i) => {
                    const previous = versions[i + 1];
                    const open = openVersionId === v.version_id;
                    const pinned = installs.filter(a => a.channel === "pinned" && a.pinned_version_id === v.version_id);
                    const running = installs.filter(a => a.installed_version === v.version && !pinned.includes(a));
                    const xref = [
                        pinned.length > 0 && `${names(pinned)} ${pinned.length === 1 ? "is" : "are"} pinned to this version`,
                        running.length > 0 && `Running on ${names(running)}`,
                    ].filter(Boolean).join(" · ");
                    const meta = [`v${v.version}`, v.author, formatRelativeAgo(v.created_at)].filter(Boolean).join(" · ");
                    return (
                        <Fragment key={v.version_id}>
                            <SettingsRow
                                title={<span className="block truncate">{v.changelog ?? (previous ? "No notes" : "First version")}</span>}
                                description={<span className="block truncate tabular-nums">{meta}</span>}
                                onClick={previous && (() => { setOpenVersionId(open ? null : v.version_id); })}
                                expanded={previous && open}
                                control={xref ? (
                                    <span className="max-w-64 truncate text-[13px] text-muted-foreground">{xref}</span>
                                ) : undefined}
                            />
                            {previous && open && <VersionDiff skillId={skillId} versionId={v.version_id} previous={previous}/>}
                        </Fragment>
                    );
                })}
            </SettingsSection>

            <SettingsSection label="Details">
                <SettingsRow title="Identifier" control={<span className={cn(MONO, "text-foreground")}>{skill.slug}</span>}/>
                {current && <SettingsRow title="Files" control={<span title={files} className={MONO}>{files}</span>}/>}
                <SettingsRow title="Runtimes" control={<span className={VALUE}>{runtimes}</span>}/>
                <SettingsRow
                    title="Origin"
                    control={
                        <span className={VALUE}>
                            {skill.origin === "forked" ? (
                                <>
                                    Forked from{" "}
                                    {parent ? (
                                        <Link to={skillDetailPath(parent)} className="text-foreground hover:underline">
                                            {parent.display_name}
                                        </Link>
                                    ) : "another skill"}
                                </>
                            ) : skill.origin === "imported" ? "Imported" : `Written in Clawbits${firstAuthor ? ` by ${firstAuthor}` : ""}`}
                        </span>
                    }
                />
                {current && <SettingsRow title="Size" control={<span className={VALUE}>{humanSize(current.total_bytes)}</span>}/>}
            </SettingsSection>

            <SkillForge open={editing} editing={skill} onOpenChange={setEditing}/>
            <AddToAgentsDialog open={adding} onOpenChange={setAdding} skill={skill}/>
        </SettingsPage>
    );
}
