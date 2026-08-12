import { describe, it, expect } from "vitest";
import { automationVisualState } from "@/lib/automations";
import type { Automation, AutomationReportedState } from "@/lib/api";

const NOW = Date.parse("2026-08-11T12:00:00Z");

/** A minimal automation row. Only the fields the visual state reads matter;
 *  the rest of the wire type is filled with harmless defaults. */
function automation(overrides: Partial<Automation> = {}): Automation {
  return {
    automation_id: "auto-1",
    agent_id: "agent-1",
    org_id: "org-1",
    managed_by: "clawbits",
    name: "Daily digest",
    enabled: true,
    desired_spec: null,
    reported_spec: null,
    reported_state: null,
    sync_status: "applied",
    sync_error: null,
    spec_hash: null,
    gateway_job_id: "cron_1",
    desired_generation: 1,
    observed_generation: 1,
    run_requested_generation: 0,
    run_observed_generation: 0,
    run_pending: false,
    missing_since: null,
    ...overrides,
  } as Automation;
}

const failing = (consecutiveErrors: number): AutomationReportedState => ({
  lastRunAtMs: NOW - 60_000,
  lastRunStatus: "error",
  consecutiveErrors,
  lastError: "skill 'agentpit-reference' not found",
});

const state = (a: Automation) => automationVisualState(a, "available", "snivy", NOW);

describe("automationVisualState failure reporting", () => {
  it("surfaces the runtime's error text for a failed run", () => {
    const s = state(automation({ reported_state: failing(78) }));
    expect(s.lastError).toBe("skill 'agentpit-reference' not found");
    expect(s.failStreak).toBe(78);
  });

  it("does not surface a stale error once a run succeeds again", () => {
    // The gateway keeps `lastError` around after recovery; only the status says
    // whether it still applies.
    const s = state(
      automation({
        reported_state: {
          lastRunAtMs: NOW - 60_000,
          lastRunStatus: "ok",
          lastError: "skill 'agentpit-reference' not found",
        },
      }),
    );
    expect(s.lastError).toBeNull();
    expect(s.failStreak).toBe(0);
    expect(s.failing).toBe(false);
    expect(s.needsAttention).toBe(false);
  });

  it("treats one bad run as noise and two in a row as a pattern", () => {
    expect(state(automation({ reported_state: failing(1) })).failing).toBe(false);
    expect(state(automation({ reported_state: failing(2) })).failing).toBe(true);
  });
});

describe("automationVisualState needsAttention", () => {
  it("flags a synced-but-failing automation - 'Active' is not 'working'", () => {
    const s = state(automation({ reported_state: failing(5) }));
    expect(s.key).toBe("active");
    expect(s.needsAttention).toBe(true);
  });

  it("flags a failing EXTERNAL mirror, unfixable or not", () => {
    const s = state(
      automation({ managed_by: "external", reported_state: failing(78) }),
    );
    expect(s.key).toBe("external");
    expect(s.needsAttention).toBe(true);
    expect(s.lastError).toBe("skill 'agentpit-reference' not found");
  });

  it("leaves a healthy external mirror recessed", () => {
    const s = state(
      automation({
        managed_by: "external",
        reported_state: { lastRunAtMs: NOW - 60_000, lastRunStatus: "ok" },
      }),
    );
    expect(s.needsAttention).toBe(false);
  });

  it("keeps a paused-while-broken automation flagged", () => {
    const s = state(automation({ enabled: false, reported_state: failing(4) }));
    expect(s.key).toBe("paused");
    expect(s.needsAttention).toBe(true);
  });

  it("does not flag a healthy automation", () => {
    expect(state(automation()).needsAttention).toBe(false);
  });
});
