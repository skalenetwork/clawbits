import { describe, expect, test } from "bun:test";
import { AGENT_OFFLINE_AFTER_MS, agentName, agentOffline, gameSwitchAgents, serverTime } from "./agents";
import type { Organization, OrgAgent } from "./models";

const agent = (over: Partial<OrgAgent> = {}): OrgAgent => ({
  agent_id: "a1",
  nickname: null,
  display_name: null,
  avatar: null,
  last_alive_at: null,
  is_operator: false,
  widgets_enabled: false,
  ...over,
});

const org = (my_role: Organization["my_role"]): Organization => ({
  org_id: "o1",
  name: "Org",
  display_name: null,
  is_personal: false,
  my_role,
});

describe("serverTime", () => {
  test("reads the server's naive UTC, and a zoned time", () => {
    expect(serverTime("2026-11-05 15:00:00")).toBe(Date.UTC(2026, 10, 5, 15, 0, 0));
    expect(serverTime("2026-11-05T17:00:00+02:00")).toBe(Date.UTC(2026, 10, 5, 15, 0, 0));
    expect(Number.isNaN(serverTime("soon"))).toBe(true);
  });
});

describe("agentOffline", () => {
  const at = Date.UTC(2026, 10, 5, 15, 0, 0);

  test("only once its last ping is older than the window, the window's edge still online", () => {
    expect(agentOffline("2026-11-05 15:00:00", at + 60_000)).toBe(false);
    expect(agentOffline("2026-11-05 15:00:00", at + AGENT_OFFLINE_AFTER_MS)).toBe(false);
    expect(agentOffline("2026-11-05 15:00:00", at + AGENT_OFFLINE_AFTER_MS + 1)).toBe(true);
  });

  test("never for an agent that hasn't pinged yet, one unknown here, or a time it can't read", () => {
    expect(agentOffline(null, at)).toBe(false);
    expect(agentOffline(undefined, at)).toBe(false);
    expect(agentOffline("soon", at)).toBe(false);
  });
});

describe("gameSwitchAgents", () => {
  const scout = agent({ agent_id: "a2", nickname: "Scout", is_operator: true, widgets_enabled: true });
  const blue = agent({ agent_id: "a1", display_name: "Deep Blue", is_operator: false });
  const old = agent({ agent_id: "a3", nickname: "Old", is_operator: true, widgets_enabled: undefined });

  test("lists the agents this person runs; an owner gets every one of the org's, by name", () => {
    expect(gameSwitchAgents([scout, blue], org("member")).map(agentName)).toEqual(["Scout"]);
    expect(gameSwitchAgents([scout, blue], org("owner")).map(agentName)).toEqual(["Deep Blue", "Scout"]);
  });

  test("leaves out an agent an older server says nothing of the switch for", () => {
    expect(gameSwitchAgents([old], org("owner"))).toEqual([]);
  });

  test("names an agent by its nickname, then its display name, then its id", () => {
    expect(agentName(agent({ nickname: "Nick", display_name: "Display" }))).toBe("Nick");
    expect(agentName(agent({ display_name: "Display" }))).toBe("Display");
    expect(agentName(agent())).toBe("a1");
  });
});
