import type { TidemarkBandId, TidemarkKind, TidemarkTier, Tidemarks } from "@/lib/api";
import { parseUtcTimestamp } from "@/lib/formatting";

export type TidemarkState = ReturnType<typeof tidemarkState>;

const TIER_LABEL: Record<TidemarkTier, string> = {
  shore: "Shore",
  swell: "Swell",
  tide: "Tide",
  reef: "Reef",
  nacre: "Nacre",
  twilight: "Twilight",
  kelp: "Kelp",
  vent: "Vent",
  abyss: "Abyss",
  hadal: "Hadal",
};

export const BAND_LABEL: Record<TidemarkBandId, string> = {
  shallows: "Firsts",
  open: "Real work",
  deep: "Days and streaks",
};

export const MARK_COPY: Record<TidemarkKind, { title: string; howTo: (name: string, email?: string | null) => string }> = {
  conversation: { title: "First conversation", howTo: (name) => `A person messaged ${name} and it replied` },
  channel: { title: "Joined a channel", howTo: (name) => `Add ${name} to a channel` },
  lobstertalk: { title: "LobsterTalk on", howTo: (name) => `Turn on LobsterTalk in ${name}'s settings` },
  automation: { title: "Automation added", howTo: (name) => `Add an automation to ${name}` },
  mail: { title: "First mail", howTo: (name, email) => `Send an email to ${email ?? name}` },
  teamwork: { title: "Agent teamwork", howTo: (name) => `Let ${name} exchange messages with another agent` },
  file: { title: "Passed a file", howTo: (name) => `Share a file in a channel ${name} is in` },
  skill: { title: "Learned a skill", howTo: (name) => `Install a library skill on ${name}` },
  run: { title: "Automation ran", howTo: (name) => `Wait for one of ${name}'s automations to run` },
  thread: { title: "Held a thread", howTo: (name) => `Get ${name} to answer inside a thread` },
  pinned: { title: "Pinned by a person", howTo: (name) => `Pin one of ${name}'s messages` },
  crew: { title: "Crew of three", howTo: (name) => `Put ${name} in a channel with two other agents` },
  night: { title: "Night shift", howTo: (name) => `Let ${name} answer while you are away` },
  handoff: { title: "Handed off", howTo: (name) => `Have ${name} work with a second agent` },
  streak3: { title: "Three-day tide", howTo: (name) => `Talk with ${name} three days running` },
  streak7: { title: "Spring tide", howTo: (name) => `Talk with ${name} seven days running` },
  streak30: { title: "Full moon", howTo: (name) => `Talk with ${name} thirty days running` },
  clockwork: { title: "Clockwork", howTo: (name) => `Keep one of ${name}'s automations running seven days straight` },
  tides: { title: "Hundred tides", howTo: (name) => `Talk with ${name} on a hundred separate days` },
  weathered: { title: "Weathered", howTo: (name) => `${name} turns ninety days old` },
  year: { title: "Year at sea", howTo: (name) => `${name} turns a year old` },
};

export function tidemarkState({ tier, tiers, bands, marks }: Tidemarks) {
  const byKind = new Map(marks.map((m) => [m.kind, m]));
  const groups = bands.map((band) => ({
    id: band.id,
    marks: band.kinds.map((kind) => ({ kind, mark: byKind.get(kind) ?? null })),
    count: band.kinds.filter((kind) => byKind.has(kind)).length,
  }));
  const count = groups.reduce((n, band) => n + band.count, 0);
  const total = groups.reduce((n, band) => n + band.marks.length, 0);
  const dates = marks.map((m) => m.earned_at).filter((at) => at != null).toSorted();
  const next = tiers.find((t) => t.marks > count) ?? null;
  return {
    label: TIER_LABEL[tier],
    earnedAt: dates[(tiers.find((t) => t.id === tier)?.marks ?? 0) - 1] ?? null,
    nextTier: next && TIER_LABEL[next.id],
    nextAt: next?.marks ?? 0,
    count,
    total,
    bands: groups,
  };
}

export function bandCount({ count, marks }: TidemarkState["bands"][number]): string {
  return `${count} of ${marks.length}`;
}

export function progressText({ nextTier, nextAt, count, total }: TidemarkState): string {
  if (nextTier) return `${count} of ${nextAt} to ${nextTier}`;
  const left = total - count;
  if (left <= 0) return "Full set";
  return left === 1 ? "One left for the full set" : `${left} left for the full set`;
}

export function formatMarkDate(ts: string): string {
  const d = parseUtcTimestamp(ts);
  return `${d.getDate()} ${d.toLocaleDateString("en-US", { month: "short" })} ${d.getFullYear()}`;
}
