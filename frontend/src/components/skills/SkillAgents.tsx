import {Fragment} from "react";
import {AgentFaceAvatar} from "@/components/AgentFaceAvatar";
import {Squircle} from "@/components/home/tiles";
import {SettingsRow, SettingsSection, SettingsTile, TileGrid} from "@/components/settings/Settings";
import {Button} from "@/components/ui/button";
import {agentDisplay} from "@/lib/agentDisplay";
import type {AgentUser, Skill, SkillVersion} from "@/lib/api";
import {RUNTIME_LOGO} from "@/lib/formatting";
import {RUNTIME_LABELS, agentRuntime, installPill} from "@/lib/skills";
import type {Pill} from "@/lib/status";

const COLLISION = "a skill of that name already exists on this agent";

const rank = (pill: Pill | null) => (!pill ? 2 : pill.bad ? 0 : 1);

/** Every agent this skill is on or on its way to, the ones that need a look first, each with what it last confirmed.
 *  A failure's reason and the way out sit in the footer. */
export function SkillAgents({skill, versions, agents, onAdd}: {
    skill: Skill;
    versions: readonly SkillVersion[];
    agents: ReadonlyMap<string, AgentUser>;
    onAdd: () => void;
}) {
    const installs = (skill.agents ?? [])
        .map(install => {
            const agent = agents.get(install.agent_id);
            return {install, agent, name: agentDisplay(agent ?? install), pill: installPill(install, versions)};
        })
        .sort((a, b) => rank(a.pill) - rank(b.pill));

    if (installs.length === 0) {
        return (
            <SettingsSection label="Agents">
                {skill.is_draft ? (
                    <SettingsRow title="Not published yet" description="Publish it from Edit, then add it to agents."/>
                ) : (
                    <SettingsRow
                        title="Not on any agent yet"
                        description="Add it to the agents that should use it."
                        control={<Button variant="outline" size="sm" onClick={onAdd}>Add to agents</Button>}
                    />
                )}
            </SettingsSection>
        );
    }

    const failures = installs.filter(({install}) => install.sync_status === "failed" && install.sync_error);
    return (
        <SettingsSection
            label="Agents"
            stack
            footer={failures.length > 0 ? failures.map(({install, name}) => (
                <Fragment key={install.install_id}>
                    <p>{name}: <span className="font-mono text-destructive wrap-anywhere">{install.sync_error}</span></p>
                    <p>
                        {install.sync_error === COLLISION
                            ? `Adopt or remove ${name}'s own copy on its Skills tab.`
                            : `${name} tries again on its own.`}
                    </p>
                </Fragment>
            )) : undefined}
        >
            <TileGrid>
                {installs.map(({install, agent, name, pill}) => {
                    const runtime = agentRuntime(agent?.agent_type);
                    return (
                        <SettingsTile
                            key={install.install_id}
                            leading={
                                <Squircle size={40}>
                                    <AgentFaceAvatar src={agent?.avatar?.url} name={name} size={40} className="rounded-none"/>
                                </Squircle>
                            }
                            title={name}
                            href={agent && (agent.can_manage_contacts
                                ? `/agents/${encodeURIComponent(agent.agent_id)}/skills/${encodeURIComponent(install.install_id)}`
                                : `/agents/${encodeURIComponent(agent.agent_id)}`)}
                            subtitle={
                                <span className="flex items-center gap-1.5">
                                    <img src={RUNTIME_LOGO[runtime]} alt="" title={RUNTIME_LABELS[runtime]} className="size-3.5 shrink-0"/>
                                    <span className="truncate">
                                        {install.installed_version
                                            ? `v${install.installed_version}`
                                            : install.sync_status === "requested" ? "Not installed yet" : "Not installed"}
                                    </span>
                                </span>
                            }
                            aside={agent?.is_operator ? null : agent?.operator?.display_name}
                            pill={pill}
                        />
                    );
                })}
            </TileGrid>
        </SettingsSection>
    );
}
