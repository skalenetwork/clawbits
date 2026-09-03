import { describe, expect, it } from "vitest";

import {
  cronEcho,
  cronValid,
  describeSchedule,
  humanizeEvery,
  parseSchedule,
  scheduleToSpec,
  type Schedule,
} from "./schedule";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe("parseSchedule / scheduleToSpec", () => {
  it("round-trips all three kinds", () => {
    const cases: Schedule[] = [
      { kind: "every", everyMs: 2 * HOUR },
      { kind: "cron", expr: "0 9 * * 1-5", tz: "Europe/Kyiv" },
      { kind: "cron", expr: "0 9 * * *" },
      { kind: "at", at: 1_800_000_000_000 },
    ];
    for (const s of cases) {
      expect(parseSchedule(scheduleToSpec(s))).toEqual(s);
    }
  });

  it("serializes a one-shot `at` as an ISO string, not an epoch number", () => {
    // OpenClaw's cron schema is a closed object whose `at` is a non-empty
    // STRING (packages/gateway-protocol/src/schema/cron.ts). Sending the epoch
    // number this app models internally is rejected outright: cron.add fails,
    // the automation reports sync_status="failed", and it never fires.
    const at = 1_800_000_000_000;
    expect(scheduleToSpec({ kind: "at", at })).toEqual({
      kind: "at",
      at: new Date(at).toISOString(),
    });
  });

  it("parses every `at` form an automation may already be stored in", () => {
    const at = 1_800_000_000_000;
    const iso = new Date(at).toISOString();
    // Legacy epoch number written before the wire form was fixed.
    expect(parseSchedule({ kind: "at", at })).toEqual({ kind: "at", at });
    // Epoch digit string — also accepted by OpenClaw's own parser.
    expect(parseSchedule({ kind: "at", at: String(at) })).toEqual({ kind: "at", at });
    // The ISO form this app now writes.
    expect(parseSchedule({ kind: "at", at: iso })).toEqual({ kind: "at", at });
  });

  it("rejects malformed input defensively", () => {
    expect(parseSchedule(null)).toBeNull();
    expect(parseSchedule("weekly")).toBeNull();
    expect(parseSchedule({ kind: "every", everyMs: 0 })).toBeNull();
    expect(parseSchedule({ kind: "every", everyMs: "1h" })).toBeNull();
    expect(parseSchedule({ kind: "cron", expr: "  " })).toBeNull();
    expect(parseSchedule({ kind: "at", at: Number.NaN })).toBeNull();
    expect(parseSchedule({ kind: "at", at: "not-a-time" })).toBeNull();
    expect(parseSchedule({ kind: "at", at: "" })).toBeNull();
  });

  it("omits an empty tz on serialize", () => {
    expect(scheduleToSpec({ kind: "cron", expr: "0 9 * * *" })).toEqual({
      kind: "cron",
      expr: "0 9 * * *",
    });
  });
});

describe("describeSchedule / humanizeEvery", () => {
  it("humanizes intervals with clean units", () => {
    expect(humanizeEvery(60_000)).toBe("minute");
    expect(humanizeEvery(45 * 60_000)).toBe("45 min");
    expect(humanizeEvery(HOUR)).toBe("hour");
    expect(humanizeEvery(6 * HOUR)).toBe("6 hours");
    expect(humanizeEvery(DAY)).toBe("day");
    expect(humanizeEvery(7 * DAY)).toBe("week");
  });

  it("never emits float unit counts — larger units only on clean division", () => {
    expect(humanizeEvery(100 * 60_000)).toBe("100 min");
    expect(humanizeEvery(10 * DAY)).toBe("10 days");
    expect(humanizeEvery(90 * 60_000)).toBe("90 min");
    expect(humanizeEvery(36 * HOUR)).toBe("36 hours");
  });

  it("handles sub-minute intervals from external jobs", () => {
    expect(humanizeEvery(30_000)).toBe("30 sec");
    expect(humanizeEvery(1000)).toBe("second");
  });

  it("echoes cron in plain English and falls back to the raw expr", () => {
    expect(describeSchedule({ kind: "every", everyMs: DAY })).toBe("Every day");
    expect(describeSchedule({ kind: "cron", expr: "0 9 * * 1-5" })).toMatch(/9:00 AM/);
    expect(describeSchedule(null)).toBe("—");
  });

  it("names a foreign tz on cron sentences, omits the local one", () => {
    const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const foreign = local === "Pacific/Kiritimati" ? "Pacific/Niue" : "Pacific/Kiritimati";
    expect(describeSchedule({ kind: "cron", expr: "0 9 * * *", tz: foreign })).toContain(
      `(${foreign})`,
    );
    expect(describeSchedule({ kind: "cron", expr: "0 9 * * *", tz: local })).not.toContain("(");
  });

  it("cronEcho / cronValid reject junk without throwing", () => {
    expect(cronEcho("not a cron")).toBeNull();
    expect(cronValid("not a cron")).toBe(false);
    expect(cronValid("*/15 9-18 * * 1-5")).toBe(true);
    expect(cronValid("")).toBe(false);
  });
});
