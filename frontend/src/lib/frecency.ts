const STORAGE_KEY = "fc_cmdk_frecency_v1";
const MAX_TIMESTAMPS = 10;
const MAX_ENTRIES = 300;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const RECENCY: [maxAge: number, points: number][] = [
  [4 * HOUR, 100],
  [DAY, 80],
  [3 * DAY, 60],
  [7 * DAY, 40],
  [30 * DAY, 20],
  [90 * DAY, 10],
];

interface FrecencyEntry {
  count: number;
  visits: number[];
}

export type FrecencyStore = Record<string, FrecencyEntry>;

export function frecencyKey(kind: "channel" | "human" | "agent", id: string | number): string {
  return `${kind}:${String(id)}`;
}

export function loadFrecency(): FrecencyStore {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as FrecencyStore) : {};
  } catch {
    return {};
  }
}

export function recordVisit(...keys: string[]): void {
  const store = loadFrecency();
  const now = Date.now();
  for (const key of keys) {
    const entry = store[key];
    store[key] = {
      count: (entry?.count ?? 0) + 1,
      visits: [now, ...(entry?.visits ?? [])].slice(0, MAX_TIMESTAMPS),
    };
  }
  const kept = Object.entries(store)
    .sort(([, a], [, b]) => (b.visits[0] ?? 0) - (a.visits[0] ?? 0))
    .slice(0, MAX_ENTRIES);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // Best-effort: storage can be full or disabled.
  }
}

export function frecencyScore(key: string, store: FrecencyStore, now: number): number {
  const entry = store[key];
  if (!entry?.visits.length) return 0;
  const points = entry.visits.reduce(
    (sum, ts) => sum + (RECENCY.find(([maxAge]) => now - ts < maxAge)?.[1] ?? 0),
    0,
  );
  return (entry.count * points) / entry.visits.length;
}
