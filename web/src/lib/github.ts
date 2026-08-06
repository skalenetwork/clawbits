/**
 * GitHub star count, fetched ONCE at build time.
 *
 * This site is fully static behind `connect-src 'self'`, so the browser can
 * never ask api.github.com itself - the count is baked into the HTML and
 * refreshes on every deploy, which is the correct trade for a marketing
 * page: zero JS, zero CSP holes, zero layout shift, mildly stale number.
 *
 * The promise is module-cached so the dev server (which re-runs component
 * frontmatter on every request) still fetches at most once per process.
 *
 * Fails to null, never throws: an offline build or a rate-limited CI run
 * ships the page without a count rather than failing the deploy.
 */

import { LINKS } from "../config";

/** "owner/repo", derived from config so the URL cannot drift from the links. */
const REPO = new URL(LINKS.github).pathname.replace(/^\/|\/$/g, "");

let cached: Promise<number | null> | undefined;

export function getStarCount(): Promise<number | null> {
  cached ??= (async () => {
    try {
      const res = await fetch(`https://api.github.com/repos/${REPO}`, {
        headers: {
          "User-Agent": "clawbits-web-build",
          Accept: "application/vnd.github+json",
        },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { stargazers_count?: unknown };
      return typeof data.stargazers_count === "number" ? data.stargazers_count : null;
    } catch {
      return null;
    }
  })();
  return cached;
}

/** 7 -> "7", 1240 -> "1.2k", 12400 -> "12.4k", 1000 -> "1k". */
export function formatStars(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  const s = k >= 100 ? String(Math.round(k)) : (Math.round(k * 10) / 10).toString();
  return `${s.replace(/\.0$/, "")}k`;
}
