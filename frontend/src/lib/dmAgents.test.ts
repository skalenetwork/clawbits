import { describe, expect, it } from "vitest";
import { rankDmAgents } from "./dmAgents";
import { frecencyKey, type FrecencyStore } from "./frecency";
import type { AgentUser } from "./api";

const NOW = Date.UTC(2026, 8, 21);

function agent(id: string, extra: Partial<AgentUser> = {}): AgentUser {
  return { agent_id: id, can_dm: true, creation_time: "2026-01-01T00:00:00Z", ...extra };
}

function visited(id: string, ago: number): FrecencyStore {
  return { [frecencyKey("agent", id)]: { count: 1, visits: [NOW - ago] } };
}

describe("rankDmAgents", () => {
  it("drops agents you may not contact", () => {
    const ranked = rankDmAgents([agent("closed", { can_dm: false }), agent("open")], {}, NOW);
    expect(ranked.map((a) => a.agent_id)).toEqual(["open"]);
  });

  it("puts the agent you reached for most recently first", () => {
    const ranked = rankDmAgents([agent("stale"), agent("fresh")], visited("fresh", 60_000), NOW);
    expect(ranked[0]?.agent_id).toBe("fresh");
  });

  it("falls back to the newest agent when nothing was visited", () => {
    const ranked = rankDmAgents(
      [agent("old", { creation_time: "2026-01-01T00:00:00Z" }), agent("new", { creation_time: "2026-09-01T00:00:00Z" })],
      {},
      NOW,
    );
    expect(ranked.map((a) => a.agent_id)).toEqual(["new", "old"]);
  });
});
