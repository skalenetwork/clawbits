import {act, renderHook} from "@testing-library/react";
import {beforeEach, describe, expect, it} from "vitest";
import type {Skill} from "@/lib/api";
import {filterSkillsByScope, matchesSkillQuery, skillSections, useSkillScope} from "@/lib/skillScopes";

function skill(over: Partial<Skill> = {}): Skill {
    return {
        skill_id: "sk-1",
        slug: "changelog-voice",
        display_name: "Changelog voice",
        summary: "How we write release notes.",
        icon_emoji: null,
        origin: "authored",
        runtimes: ["openclaw"],
        forked_from_skill_id: null,
        latest_version_id: "v-1",
        latest_version: "1.0.0",
        is_draft: false,
        installed_agent_count: 0,
        attention: {failed: 0, installing: 0, removing: 0, behind: 0},
        created_by: 7,
        updated_at: null,
        ...over,
    };
}

describe("filterSkillsByScope", () => {
    const mine = skill({skill_id: "mine", created_by: 7});
    const theirs = skill({skill_id: "theirs", created_by: 9});
    const live = skill({skill_id: "live", created_by: 9, installed_agent_count: 2});
    const all = [mine, theirs, live];

    it("treats org as the superset that mine is a slice of", () => {
        expect(filterSkillsByScope(all, "org", 7)).toEqual(all);
        expect(filterSkillsByScope(all, "mine", 7).map(s => s.skill_id)).toEqual(["mine"]);
    });

    it("has nothing to call mine with no signed-in user", () => {
        expect(filterSkillsByScope(all, "mine", null)).toEqual([]);
    });

    it("counts only confirmed installs as on-agent", () => {
        expect(filterSkillsByScope(all, "agents", 7).map(s => s.skill_id)).toEqual(["live"]);
    });
});

describe("matchesSkillQuery", () => {
    it.each([
        ["CHANGELOG", true],
        ["voice", true],
        ["release notes", true],
        ["", true],
        ["   ", true],
        ["invoice", false],
    ])("matches %j: %s", (query, hit) => {
        expect(matchesSkillQuery(skill(), query)).toBe(hit);
    });
});

describe("skillSections", () => {
    it("files each skill by where it stands, keeping the given order", () => {
        const sections = skillSections([
            skill({skill_id: "draft", is_draft: true}),
            skill({skill_id: "idle"}),
            skill({skill_id: "used", installed_agent_count: 2}),
            skill({skill_id: "also-idle"}),
        ]);
        expect(sections.map(s => [s.label, s.skills.map(k => k.skill_id)])).toEqual([
            ["Used by agents", ["used"]],
            ["Not on any agent yet", ["idle", "also-idle"]],
            ["Drafts", ["draft"]],
        ]);
    });

    it("drops sections with nothing in them", () => {
        expect(skillSections([skill()]).map(s => s.label)).toEqual(["Not on any agent yet"]);
    });
});

describe("useSkillScope", () => {
    beforeEach(() => { localStorage.clear(); });

    it.each([
        [null, "org"],
        ["agents", "agents"],
        ["public", "org"],
    ])("loads stored %j as %s", (stored, scope) => {
        if (stored) localStorage.setItem("fc_skills_scope", stored);
        expect(renderHook(() => useSkillScope()).result.current[0]).toBe(scope);
    });

    it("persists a pick", () => {
        const {result} = renderHook(() => useSkillScope());
        act(() => { result.current[1]("mine"); });
        expect(result.current[0]).toBe("mine");
        expect(localStorage.getItem("fc_skills_scope")).toBe("mine");
    });
});
