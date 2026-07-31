/** Persistent memory of URLs the unfurler returned no usable card for.
 *
 *  The server caches unfurl results in Redis, and React Query caches
 *  them in memory for the session — but the in-memory cache is empty on
 *  every cold load (page refresh / app reopen). So a channel containing
 *  a dead or preview-less link (e.g. ``http://52.27.128.58:10003``)
 *  re-fires the same doomed fetch and flashes a loading skeleton every
 *  single time it's opened fresh.
 *
 *  This is a localStorage-backed set of "we already tried, there's no
 *  preview" verdicts so that decision survives reloads: a known-miss URL
 *  is never re-fetched and never shows a skeleton again (until the TTL
 *  lapses, at which point we retry once in case the site came back up).
 *
 *  Only NEGATIVE verdicts are stored. Positive previews for new posts
 *  are already embedded on the post row server-side; legacy positive
 *  posts re-unfurl once per cold load, which is harmless. */

const STORAGE_KEY = "fc_link_preview_misses";
// Remember a "no preview" verdict for a week, then allow one retry — a
// previously-dead URL may have started serving OG tags or come online.
const MISS_TTL_MS = 7 * 24 * 60 * 60_000;
// Cap stored verdicts so a link-heavy workspace can't grow localStorage
// without bound. Oldest verdicts are evicted first.
const MAX_ENTRIES = 500;

/** url -> verdict timestamp (epoch ms). */
type MissMap = Record<string, number>;

function read(): MissMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as MissMap) : {};
  } catch {
    return {};
  }
}

function write(map: MissMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* quota / private mode — skipping persistence just means the
       skeleton may reappear on the next cold load, which is benign. */
  }
}

function prune(map: MissMap, now: number): MissMap {
  // Drop expired verdicts, then enforce the size cap by keeping the
  // newest MAX_ENTRIES (oldest evicted first).
  let entries = Object.entries(map).filter(([, ts]) => now - ts < MISS_TTL_MS);
  if (entries.length > MAX_ENTRIES) {
    entries = entries
      .sort((a, b) => a[1] - b[1])
      .slice(entries.length - MAX_ENTRIES);
  }
  return Object.fromEntries(entries);
}

/** True when ``url`` previously unfurled to no usable card and the
 *  verdict hasn't expired. Cheap enough to call on every render. */
export function isKnownNoPreview(url: string): boolean {
  if (!url) return false;
  const ts = read()[url];
  return ts !== undefined && Date.now() - ts < MISS_TTL_MS;
}

/** Record that ``url`` resolved to no usable card. */
export function rememberNoPreview(url: string): void {
  if (!url) return;
  const now = Date.now();
  const map = read();
  map[url] = now;
  write(prune(map, now));
}

/** Drop a stored miss — called when a URL unexpectedly resolves to a
 *  real card, so we stop suppressing it. */
export function forgetNoPreview(url: string): void {
  if (!url) return;
  const map = read();
  if (map[url] === undefined) return;
  write(
    Object.fromEntries(Object.entries(map).filter(([key]) => key !== url)),
  );
}
