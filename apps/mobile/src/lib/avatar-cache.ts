/**
 * Persistent disk cache for avatar SVGs.
 *
 * Why this exists: the web frontend gets free durability from the browser
 * HTTP cache (server sends ``Cache-Control: immutable`` so avatars are
 * pinned on disk for a year). On mobile, ``fetch()`` doesn't honor that
 * header durably across cold starts — without a custom cache, every
 * launch re-downloads every visible SVG, and any transient network blip
 * leaves the user staring at a fallback initial letter.
 *
 * Avatar URLs are content-versioned (``v{n}.svg``), so a new avatar
 * version yields a new URL — and a new cache key. No invalidation logic
 * is needed; the cache key naturally rotates with the content.
 *
 * Layout: ``${Paths.cache}avatars/${sha1(url)}.svg``. Files live in the
 * OS-managed cache directory so the OS can evict them under storage
 * pressure without breaking the app.
 *
 * The stored text is the *inlined* SVG — ``inlineDataUriImages`` has
 * already been run before write — so warm reads skip the (expensive)
 * regex/base64 dance.
 */
import { CryptoDigestAlgorithm, digestStringAsync } from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';

import { inlineDataUriImages } from '@/lib/svg-inline';

const AVATARS_DIR_NAME = 'avatars';

let dirReady = false;

/** Lazily create the cache directory. Idempotent — safe to call before
 *  every read/write. */
function ensureDirSync(): Directory {
  const dir = new Directory(Paths.cache, AVATARS_DIR_NAME);
  if (!dirReady) {
    if (!dir.exists) {
      dir.create({ intermediates: true });
    }
    dirReady = true;
  }
  return dir;
}

async function fileFor(url: string): Promise<File> {
  const dir = ensureDirSync();
  const key = await digestStringAsync(CryptoDigestAlgorithm.SHA1, url);
  return new File(dir, `${key}.svg`);
}

/** In-flight fetch dedup — multiple ``<Avatar>`` instances mounting in
 *  the same frame for the same URL share one network request. */
const inflight = new Map<string, Promise<string>>();

/** Lightweight counters surfaced via {@link formatAvatarCacheStats}. */
const stats = {
  hits: 0,
  misses: 0,
  errors: 0,
  writes: 0,
};

/** Human-readable stats snapshot: hit-rate + raw counters. Useful for
 *  console diagnostics and the dev-only foreground log. Returns ``null``
 *  if no avatars have been touched yet (avoids noise on cold start). */
export function formatAvatarCacheStats(): string | null {
  const total = stats.hits + stats.misses + stats.errors;
  if (total === 0) return null;
  const pct = total > 0 ? Math.round((stats.hits / total) * 100) : 0;
  return (
    `avatars: ${stats.hits}/${total} hit (${pct}%), ` +
    `misses=${stats.misses}, errors=${stats.errors}, writes=${stats.writes}`
  );
}

/** Read a cached SVG from disk. Returns ``null`` if not cached or the
 *  file can't be read. */
export async function readCachedSvg(url: string): Promise<string | null> {
  try {
    const file = await fileFor(url);
    if (!file.exists) return null;
    const text = await file.text();
    stats.hits += 1;
    return text;
  } catch {
    // Read failures shouldn't crash the avatar — fall through to a network
    // fetch via the caller.
    return null;
  }
}

/** Persist an inlined SVG to disk. Atomic via temp-file + move so a
 *  partial write can't corrupt the cache. Idempotent — re-writing the
 *  same URL is a no-op-ish (overwrites with identical content). */
export async function writeCachedSvg(url: string, inlined: string): Promise<void> {
  try {
    const file = await fileFor(url);
    if (file.exists) {
      // Identical-content overwrite — skip to avoid pointless disk churn
      // when several avatars resolve their fetch in parallel.
      return;
    }
    // Write to a temp sibling then move into place so a crash mid-write
    // doesn't leave a half-empty .svg file lying around for the next
    // launch to choke on.
    const dir = ensureDirSync();
    const tmpKey = await digestStringAsync(CryptoDigestAlgorithm.SHA1, `${url}#tmp`);
    const tmp = new File(dir, `${tmpKey}.tmp`);
    if (tmp.exists) tmp.delete();
    tmp.create();
    tmp.write(inlined);
    await tmp.move(file);
    stats.writes += 1;
  } catch {
    // Persistence is best-effort — a failed write just means we'll
    // re-fetch on the next mount. Don't surface to the caller.
  }
}

/** Fetch + inline + persist a single avatar SVG. Returns the inlined
 *  text. Dedupes concurrent fetches per URL. Surface 4xx as a thrown
 *  error so callers can decide not to retry. */
export async function fetchAndCacheSvg(url: string): Promise<string> {
  const existing = inflight.get(url);
  if (existing) return existing;
  const promise = (async () => {
    // Hard timeout so a stalled avatar fetch can't hold an `inflight` slot
    // (and the dependent React Query) open indefinitely on a flaky network.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) {
        stats.errors += 1;
        throw new Error(`avatar fetch ${res.status}`);
      }
      const raw = await res.text();
      const inlined = inlineDataUriImages(raw);
      stats.misses += 1;
      void writeCachedSvg(url, inlined);
      return inlined;
    } finally {
      clearTimeout(timer);
      inflight.delete(url);
    }
  })();
  inflight.set(url, promise);
  return promise;
}

/** Read-through: check disk first, fall back to network. Used by
 *  ``<Avatar>``'s React Query ``queryFn`` so the disk cache silently
 *  short-circuits the network call when present. */
export async function loadSvg(url: string): Promise<string> {
  const cached = await readCachedSvg(url);
  if (cached !== null) return cached;
  return fetchAndCacheSvg(url);
}

/** Best-effort background prefetch of a batch of avatar URLs. Fires
 *  every fetch in parallel; failures are swallowed so a single broken
 *  URL can't block the rest. Returns once every URL has either landed
 *  on disk or failed. */
export async function preloadSvgs(urls: readonly string[]): Promise<void> {
  if (urls.length === 0) return;
  const unique = Array.from(new Set(urls));
  await Promise.allSettled(
    unique.map(async (url) => {
      const cached = await readCachedSvg(url);
      if (cached !== null) return;
      await fetchAndCacheSvg(url).catch(() => {
        // Swallowed — prefetch is purely an optimisation.
      });
    }),
  );
}
