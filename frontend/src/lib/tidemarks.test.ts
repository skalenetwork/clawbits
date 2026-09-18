import { describe, expect, it } from "vitest";

import type { TidemarkKind, Tidemarks } from "@/lib/api";
import { MARK_COPY, formatMarkDate, progressText, tidemarkState } from "@/lib/tidemarks";

const TIERS: Tidemarks["tiers"] = [
  { id: "shore", marks: 0 },
  { id: "swell", marks: 1 },
  { id: "tide", marks: 3 },
  { id: "reef", marks: 5 },
  { id: "nacre", marks: 8 },
  { id: "twilight", marks: 11 },
  { id: "abyss", marks: 14 },
  { id: "hadal", marks: 17 },
];

const BANDS: Tidemarks["bands"] = [
  { id: "shallows", kinds: ["conversation", "channel", "lobstertalk", "automation", "mail", "teamwork"] },
  { id: "open", kinds: ["file", "skill", "run", "thread", "pinned", "crew", "night", "handoff"] },
  { id: "deep", kinds: ["streak3", "streak7", "streak30", "clockwork", "tides", "weathered", "year"] },
];

const ALL: TidemarkKind[] = BANDS.flatMap((b) => b.kinds);

const mark = (kind: TidemarkKind, earned_at: string): Tidemarks["marks"][number] => ({
  kind,
  earned_at,
  detail: null,
});

const day = (n: number) => `2026-03-${String(n).padStart(2, "0")} 12:00:00`;

function tidemarks(overrides: Partial<Tidemarks> = {}): Tidemarks {
  return { tier: "shore", tiers: TIERS, bands: BANDS, marks: [], full_set: false, ...overrides };
}

describe("tidemarkState", () => {
  it("starts at the bottom tier with nothing earned", () => {
    const s = tidemarkState(tidemarks());
    expect(s).toMatchObject({ label: "Shore", earnedAt: null, nextTier: "Swell", count: 0, total: 21 });
    expect(progressText(s)).toBe("0 of 1 to Swell");
  });

  it("names the next rung, not the top one", () => {
    const s = tidemarkState(tidemarks({ tier: "reef", marks: ALL.slice(0, 6).map((k, i) => mark(k, day(i + 1))) }));
    expect(s.label).toBe("Reef");
    expect(progressText(s)).toBe("6 of 8 to Nacre");
  });

  it("dates the tier by the mark that reached it, whatever the list order", () => {
    const s = tidemarkState(
      tidemarks({
        tier: "tide",
        marks: [mark("automation", day(21)), mark("conversation", day(2)), mark("channel", day(9))],
      }),
    );
    expect(s.earnedAt).toBe(day(21));
  });

  it("counts marks per band and drops what the runtime cannot earn", () => {
    const bands = BANDS.map((b) => ({ ...b, kinds: b.kinds.filter((k) => k !== "automation") }));
    const s = tidemarkState(tidemarks({ bands, marks: [mark("conversation", day(1)), mark("file", day(2))] }));
    expect(s.total).toBe(20);
    expect(s.bands.map((b) => [b.id, b.count, b.marks.length])).toEqual([
      ["shallows", 1, 5],
      ["open", 1, 8],
      ["deep", 0, 7],
    ]);
  });

  it("reads the last steps as the full set once the top tier is reached", () => {
    const at = (n: number) => ALL.slice(0, n).map((k, i) => mark(k, day(i + 1)));
    expect(progressText(tidemarkState(tidemarks({ tier: "hadal", marks: at(20) })))).toBe("One left for the full set");
    expect(progressText(tidemarkState(tidemarks({ tier: "hadal", marks: at(18) })))).toBe("3 left for the full set");
    expect(progressText(tidemarkState(tidemarks({ tier: "hadal", marks: at(21) })))).toBe("Full set");
  });
});

describe("tidemark copy", () => {
  it("fills the how-to with the agent's name and email", () => {
    expect(MARK_COPY.lobstertalk.howTo("Harbor", "harbor@mail.clawbits.ai")).toBe("Turn on LobsterTalk in Harbor's settings");
    expect(MARK_COPY.mail.howTo("Harbor", "harbor@mail.clawbits.ai")).toBe("Send an email to harbor@mail.clawbits.ai");
    expect(MARK_COPY.streak7.howTo("Harbor")).toBe("Talk with Harbor seven days running");
  });

  it("formats dates as day, short month and year", () => {
    expect(formatMarkDate("2026-07-21 12:00:00")).toBe("21 Jul 2026");
    expect(formatMarkDate("2026-09-14 12:00:00")).toBe("14 Sep 2026");
  });
});
