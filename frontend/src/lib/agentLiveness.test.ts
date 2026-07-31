import { describe, it, expect } from "vitest";
import {
  AGENT_OFFLINE_AFTER_MS,
  agentLivenessStatus,
  agentStatusLabel,
} from "@/lib/agentLiveness";

const NOW = Date.parse("2026-06-04T12:00:00Z");
const isoAgo = (msAgo: number) => new Date(NOW - msAgo).toISOString();

describe("agentLivenessStatus", () => {
  it("returns setup when the agent has never pinged", () => {
    expect(agentLivenessStatus(null, NOW)).toBe("setup");
  });

  it("is available within the window, inclusive at the boundary", () => {
    expect(agentLivenessStatus(isoAgo(0), NOW)).toBe("available");
    expect(agentLivenessStatus(isoAgo(25 * 60_000), NOW)).toBe("available");
    // "40 minutes -> still Available" (matches the backend's <= boundary).
    expect(agentLivenessStatus(isoAgo(AGENT_OFFLINE_AFTER_MS), NOW)).toBe("available");
  });

  it("is offline once the last ping ages past the window", () => {
    expect(agentLivenessStatus(isoAgo(AGENT_OFFLINE_AFTER_MS + 1_000), NOW)).toBe("offline");
    expect(agentLivenessStatus(isoAgo(3 * 60 * 60_000), NOW)).toBe("offline");
  });

  it("parses naive (timezone-less) UTC timestamps as UTC, not browser-local", () => {
    // The backend emits "YYYY-MM-DD HH:MM:SS" with no timezone. A ping ~7 min
    // ago must read as available regardless of the runner's timezone (the bug:
    // a raw Date.parse read it as local, flipping it to offline for UTC+ users).
    const now = Date.parse("2026-06-04T16:12:31Z");
    expect(agentLivenessStatus("2026-06-04 16:04:51", now)).toBe("available");
    expect(agentLivenessStatus("2026-06-04 15:30:00", now)).toBe("offline"); // 42 min
  });

  it("treats an unparseable timestamp as offline", () => {
    expect(agentLivenessStatus("not-a-date", NOW)).toBe("offline");
  });

  it("uses a 40-minute window, matching the backend AGENT_OFFLINE_AFTER", () => {
    expect(AGENT_OFFLINE_AFTER_MS).toBe(40 * 60 * 1000);
  });
});

describe("agentStatusLabel", () => {
  it("maps each status to a friendly caption", () => {
    expect(agentStatusLabel("available")).toBe("Available");
    expect(agentStatusLabel("offline")).toBe("Offline");
    expect(agentStatusLabel("setup")).toBe("Setting up…");
  });
});
