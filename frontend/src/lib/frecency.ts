/**
 * Frecency (frequency + recency) for the command palette. Records when the
 * user jumps to a target (channel/DM/person/agent) and scores targets so the
 * empty-state "Recents" and the as-you-type ranking favour what they actually
 * use. Entirely client-side, persisted in localStorage. See
 * docs/protocol/SEARCH_SPEC.md (Tier 1) — this mirrors Slack's quick-switcher
 * model: a per-target hit count plus the last N visit timestamps, scored by
 * recency buckets.
 *
 * Keys are namespaced by kind so ids never collide:
 *   channel:<channel_id> | human:<id> | agent:<agent_id>
 */

const STORAGE_KEY = "fc_cmdk_frecency_v1";
const MAX_TIMESTAMPS = 10; // last-N visits kept per target
const MAX_ENTRIES = 300; // cap the store; prune least-recently-used beyond this

interface FrecencyEntry {
  /** Total recorded visits (frequency). */
  count: number;
  /** Epoch-ms of the most recent visits, newest first, capped at MAX_TIMESTAMPS. */
  visits: number[];
}

export type FrecencyStore = Record<string, FrecencyEntry>;

export function frecencyKey(
  kind: "channel" | "human" | "agent",
  id: string | number,
): string {
  return `${kind}:${String(id)}`;
}

export function loadFrecency(): FrecencyStore {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as FrecencyStore) : {};
  } catch {
    return {};
  }
}

function save(store: FrecencyStore): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Storage full / disabled — frecency is best-effort, so swallow.
  }
}

/** Record a visit to `key` (from `frecencyKey`). Call on palette selection. */
export function recordVisit(key: string): void {
  const store = loadFrecency();
  const now = Date.now();
  const entry = store[key] ?? { count: 0, visits: [] };
  entry.count += 1;
  entry.visits = [now, ...entry.visits].slice(0, MAX_TIMESTAMPS);
  store[key] = entry;

  const keys = Object.keys(store);
  if (keys.length <= MAX_ENTRIES) {
    save(store);
    return;
  }
  // Keep the most-recently-visited MAX_ENTRIES — rebuild rather than
  // dynamic-delete (cleaner, and the lint forbids computed-key delete).
  const kept = keys
    .sort((a, b) => (store[b]?.visits[0] ?? 0) - (store[a]?.visits[0] ?? 0))
    .slice(0, MAX_ENTRIES);
  const pruned: FrecencyStore = {};
  for (const k of kept) {
    const entry = store[k];
    if (entry) pruned[k] = entry;
  }
  save(pruned);
}

/** Recency points for one visit timestamp — buckets decaying from "just now"
 *  to >90 days, matching the quick-switcher curve. */
function recencyPoints(ts: number, now: number): number {
  const age = now - ts;
  const H = 3_600_000;
  const D = 24 * H;
  if (age < 4 * H) return 100;
  if (age < D) return 80;
  if (age < 3 * D) return 60;
  if (age < 7 * D) return 40;
  if (age < 30 * D) return 20;
  if (age < 90 * D) return 10;
  return 0;
}

/**
 * Frecency score for `key`. 0 when never visited. Formula mirrors Slack:
 * `count * sum(recencyPoints) / numTimestamps` — frequency scaled by the
 * average recency of the tracked visits.
 */
export function frecencyScore(
  key: string,
  store: FrecencyStore,
  now: number,
): number {
  const entry = store[key];
  if (!entry || entry.visits.length === 0) return 0;
  const sum = entry.visits.reduce((acc, ts) => acc + recencyPoints(ts, now), 0);
  return (entry.count * sum) / entry.visits.length;
}
