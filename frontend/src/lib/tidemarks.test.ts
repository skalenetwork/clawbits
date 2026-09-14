import { describe, expect, it } from "vitest";

import type { TidemarkKind, Tidemarks } from "@/lib/api";
import { MARK_COPY, formatMarkDate, progressText, tidemarkState } from "@/lib/tidemarks";

const TIERS: Tidemarks["tiers"] = [
  { id: "shore", marks: 0 },
  { id: "swell", marks: 1 },
  { id: "tide", marks: 2 },
  { id: "nacre", marks: 3 },
  { id: "abyss", marks: 4 },
  { id: "hadal", marks: 5 },
];

const ALL: TidemarkKind[] = ["conversation", "channel", "lobstertalk", "automation", "mail", "teamwork"];

const mark = (kind: TidemarkKind, earned_at: string): Tidemarks["marks"][number] => ({
  kind,
  earned_at,
  detail: null,
});

function tidemarks(overrides: Partial<Tidemarks> = {}): Tidemarks {
  return { tier: "shore", tiers: TIERS, kinds: ALL, marks: [], full_set: false, ...overrides };
}

describe("tidemarkState", () => {
  it("starts at the bottom tier with nothing earned", () => {
    const s = tidemarkState(tidemarks());
    expect(s).toEqual({ label: "Shore", earnedAt: null, nextTier: "Hadal", toTop: 5, count: 0, total: 6 });
    expect(progressText(s)).toBe("0 of 5 to Hadal");
  });

  it("dates the tier by the mark that reached it, whatever the list order", () => {
    const s = tidemarkState(
      tidemarks({
        tier: "nacre",
        marks: [
          mark("automation", "2026-07-21 09:00:00"),
          mark("conversation", "2026-02-02 10:00:00"),
          mark("channel", "2026-02-09 11:00:00"),
        ],
      }),
    );
    expect(s.label).toBe("Nacre");
    expect(s.earnedAt).toBe("2026-07-21 09:00:00");
    expect(progressText(s)).toBe("3 of 5 to Hadal");
  });

  it("counts only kinds the runtime can earn", () => {
    const kinds = ALL.filter((k) => k !== "automation");
    const marks = kinds.map((k, i) => mark(k, `2026-03-0${i + 1} 12:00:00`));
    const s = tidemarkState(
      tidemarks({ tier: "hadal", kinds, marks: [...marks, mark("automation", "2026-01-01 12:00:00")], full_set: true }),
    );
    expect(s).toMatchObject({ label: "Hadal", nextTier: null, toTop: 0, count: 5, total: 5 });
    expect(s.earnedAt).toBe("2026-03-05 12:00:00");
    expect(progressText(s)).toBe("Full set");
  });

  it("reads the last step as one left once the top tier is reached", () => {
    const marks = ALL.slice(0, 5).map((k, i) => mark(k, `2026-04-0${i + 1} 12:00:00`));
    expect(progressText(tidemarkState(tidemarks({ tier: "hadal", marks })))).toBe("One left for the full set");
  });
});

describe("tidemark copy", () => {
  it("fills the how-to with the agent's name and email", () => {
    expect(MARK_COPY.lobstertalk.howTo("Harbor", "harbor@mail.clawbits.ai")).toBe("Turn on LobsterTalk in Harbor's settings");
    expect(MARK_COPY.mail.howTo("Harbor", "harbor@mail.clawbits.ai")).toBe("Send an email to harbor@mail.clawbits.ai");
  });

  it("formats dates as day, short month and year", () => {
    expect(formatMarkDate("2026-07-21 12:00:00")).toBe("21 Jul 2026");
    expect(formatMarkDate("2026-09-14 12:00:00")).toBe("14 Sep 2026");
  });
});
