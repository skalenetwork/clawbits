import type { TidemarkKind, TidemarkTier, Tidemarks } from "@/lib/api";
import { parseUtcTimestamp } from "@/lib/formatting";

export type TidemarkState = ReturnType<typeof tidemarkState>;

const TIER_LABEL: Record<TidemarkTier, string> = {
  shore: "Shore",
  swell: "Swell",
  tide: "Tide",
  nacre: "Nacre",
  abyss: "Abyss",
  hadal: "Hadal",
};

export const MARK_COPY: Record<TidemarkKind, { title: string; howTo: (name: string, email?: string | null) => string }> = {
  conversation: { title: "First conversation", howTo: (name) => `A person messaged ${name} and it replied` },
  channel: { title: "Joined a channel", howTo: (name) => `Add ${name} to a channel` },
  lobstertalk: { title: "LobsterTalk on", howTo: (name) => `Turn on LobsterTalk in ${name}'s settings` },
  automation: { title: "Automation added", howTo: (name) => `Add an automation to ${name}` },
  mail: { title: "First mail", howTo: (name, email) => `Send an email to ${email ?? name}` },
  teamwork: { title: "Agent teamwork", howTo: (name) => `Let ${name} exchange messages with another agent` },
};

export function tidemarkState({ tier, tiers, kinds, marks }: Tidemarks) {
  const earned = marks.filter((m) => kinds.includes(m.kind)).map((m) => m.earned_at).toSorted();
  const top = tiers.at(-1)!;
  const toTop = Math.max(top.marks - earned.length, 0);
  return {
    label: TIER_LABEL[tier],
    earnedAt: earned[(tiers.find((t) => t.id === tier)?.marks ?? 0) - 1] ?? null,
    nextTier: toTop ? TIER_LABEL[top.id] : null,
    toTop,
    count: earned.length,
    total: kinds.length,
  };
}

export function progressText({ nextTier, toTop, count, total }: TidemarkState): string {
  if (nextTier) return `${count} of ${count + toTop} to ${nextTier}`;
  const left = total - count;
  if (left <= 0) return "Full set";
  return left === 1 ? "One left for the full set" : `${left} left for the full set`;
}

export function formatMarkDate(ts: string): string {
  const d = parseUtcTimestamp(ts);
  return `${d.getDate()} ${d.toLocaleDateString("en-US", { month: "short" })} ${d.getFullYear()}`;
}
