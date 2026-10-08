import type {ReactNode} from "react";
import {SettingsTile} from "@/components/settings/Settings";
import {SkillGlyph} from "@/components/skills/SkillGlyph";
import type {Skill} from "@/lib/api";
import {skillDetailPath, skillPill} from "@/lib/skills";

/** A library tile: when to use the skill, how many agents run it, and a pill only when something needs a look. */
export function SkillTile({skill, menu}: {skill: Skill; menu: ReactNode}) {
    const agents = skill.installed_agent_count;
    return (
        <SettingsTile
            leading={<SkillGlyph skill={skill}/>}
            title={skill.display_name}
            href={skillDetailPath(skill)}
            subtitle={skill.summary}
            aside={agents > 0 && `${agents} agent${agents === 1 ? "" : "s"}`}
            pill={skillPill(skill)}
            end={menu}
            endOnHover
        />
    );
}
