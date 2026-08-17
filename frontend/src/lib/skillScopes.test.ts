import {act, renderHook} from "@testing-library/react";
import {beforeEach, describe, expect, it} from "vitest";
import type {Skill} from "@/lib/api";
import {
    SELECTABLE_SKILL_SCOPES,
    SKILL_SCOPES,
    filterSkillsByScope,
    groupSkillsByRecency,
    matchesSkillQuery,
    skillRowMark,
    useSkillScope,
} from "@/lib/skillScopes";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 7, 17);

function skill(over: Partial<Skill> = {}): Skill {
    return {
        skill_id: "sk-1",
        org_id: "org-1",
        slug: "changelog-voice",
        display_name: "Changelog voice",
        summary: "How we write release notes.",
        icon_emoji: null,
        visibility: "org",
        origin: "authored",
        runtimes: ["openclaw"],
        forked_from_skill_id: null,
        forked_from_version_id: null,
        latest_version_id: "v-1",
        latest_version: "1.0.0",
        content_hash: "abc",
        has_executable: false,
        is_draft: false,
        installed_agent_count: 0,
        pending_agent_count: 0,
        archived_at: null,
        created_by: 7,
        created_at: null,
        updated_at: new Date(NOW).toISOString(),
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

    it("counts only CONFIRMED installs as on-agent", () => {
        const requested = skill({skill_id: "requested", pending_agent_count: 3});
        const scoped = filterSkillsByScope([...all, requested], "agents", 7);
        expect(scoped.map(s => s.skill_id)).toEqual(["live"]);
    });
});

describe("scope descriptors", () => {
    it("keeps public listed but unselectable", () => {
        const pub = SKILL_SCOPES.find(s => s.id === "public");
        expect(pub?.disabled).toBe(true);
        expect(SELECTABLE_SKILL_SCOPES.map(s => s.id)).not.toContain("public");
    });

    it("has no scope that duplicates the org superset", () => {
        // An "all" row next to "org" would filter identically — one of them
        // would be lying about what the product does.
        expect(SKILL_SCOPES.map(s => s.id)).not.toContain("all");
    });
});

describe("matchesSkillQuery", () => {
    const s = skill();

    it("matches name, slug and summary, case-insensitively", () => {
        expect(matchesSkillQuery(s, "CHANGELOG")).toBe(true);
        expect(matchesSkillQuery(s, "voice")).toBe(true);
        expect(matchesSkillQuery(s, "release notes")).toBe(true);
    });

    it("matches everything on an empty or blank query", () => {
        expect(matchesSkillQuery(s, "")).toBe(true);
        expect(matchesSkillQuery(s, "   ")).toBe(true);
    });

    it("does not match unrelated text", () => {
        expect(matchesSkillQuery(s, "invoice")).toBe(false);
    });
});

describe("groupSkillsByRecency", () => {
    it("splits on a real week, not a fixed slice", () => {
        const fresh = skill({skill_id: "fresh", updated_at: new Date(NOW - DAY).toISOString()});
        const stale = skill({skill_id: "stale", updated_at: new Date(NOW - 30 * DAY).toISOString()});
        const groups = groupSkillsByRecency([fresh, stale], NOW);
        expect(groups.map(g => g.id)).toEqual(["recent", "earlier"]);
        expect(groups[0]?.skills.map(s => s.skill_id)).toEqual(["fresh"]);
    });

    it("drops empty groups so a young library renders one plain list", () => {
        const groups = groupSkillsByRecency([skill()], NOW);
        expect(groups).toHaveLength(1);
        expect(groups[0]?.id).toBe("recent");
    });

    it("files a skill with no timestamp under earlier rather than dropping it", () => {
        const groups = groupSkillsByRecency([skill({updated_at: null})], NOW);
        expect(groups.flatMap(g => g.skills)).toHaveLength(1);
        expect(groups[0]?.id).toBe("earlier");
    });
});

describe("skillRowMark", () => {
    it("ranks draft above everything — it is installable nowhere", () => {
        const mark = skillRowMark(skill({is_draft: true, installed_agent_count: 4}));
        expect(mark).toEqual({kind: "draft"});
    });

    it("ranks work in flight above a settled install", () => {
        const mark = skillRowMark(skill({installed_agent_count: 2, pending_agent_count: 1}));
        expect(mark).toEqual({kind: "pending", agents: 1});
    });

    it("prefers where it is live over which version it is", () => {
        expect(skillRowMark(skill({installed_agent_count: 3}))).toEqual({
            kind: "installed",
            agents: 3,
        });
        expect(skillRowMark(skill())).toEqual({kind: "version", version: "1.0.0"});
    });
});

describe("useSkillScope", () => {
    beforeEach(() => { localStorage.clear(); });

    it("defaults to the org library", () => {
        expect(renderHook(() => useSkillScope()).result.current[0]).toBe("org");
    });

    it("restores a stored scope", () => {
        localStorage.setItem("fc_skills_scope", "agents");
        expect(renderHook(() => useSkillScope()).result.current[0]).toBe("agents");
    });

    it("ignores a stored scope that can no longer be selected", () => {
        // e.g. someone hand-edits storage, or a future build retires a scope —
        // loading it back would filter to a set nothing can satisfy.
        localStorage.setItem("fc_skills_scope", "public");
        expect(renderHook(() => useSkillScope()).result.current[0]).toBe("org");
    });

    it("persists a pick and refuses to persist an unselectable one", () => {
        const {result} = renderHook(() => useSkillScope());
        act(() => { result.current[1]("mine"); });
        expect(result.current[0]).toBe("mine");
        expect(localStorage.getItem("fc_skills_scope")).toBe("mine");

        act(() => { result.current[1]("public"); });
        expect(result.current[0]).toBe("mine");
        expect(localStorage.getItem("fc_skills_scope")).toBe("mine");
    });
});
