import type { APIRoute } from "astro";
import { AI_CRAWLERS } from "../lib/crawlers";

/**
 * robots.txt with explicit per-bot rules.
 *
 * A blanket `User-agent: *` would work, but naming each crawler is a decision
 * record: it makes it obvious which AI crawlers we have considered and lets a
 * single one be denied later without touching everything else.
 *
 * The list itself lives in src/lib/crawlers.ts, because worker/index.ts needs
 * the same names to decide who gets the demo-free homepage. See that module for
 * why each one is on it and why search engines are not.
 */

/**
 * The only hosts that may be indexed.
 *
 * Everything else this site is ever served from - preview.clawbits.ai and
 * the *.workers.dev URLs - is the SAME CONTENT on a
 * different origin. Left crawlable, a preview host competes with the apex for
 * its own copy and the fourteen AI crawlers invited below ingest the wrong
 * origin as canonical. Derived from the build's SITE_URL rather than a
 * hand-kept host list, so a new preview target is closed by default.
 *
 * _headers carries the matching `X-Robots-Tag: noindex` for the known
 * preview host: robots.txt stops the crawl, the header stops the indexing of
 * a URL someone linked to anyway. Both are needed; neither is sufficient.
 */
/* Owner decision 2026-08-10: `clawbits.ai` is the ONLY indexable origin. */
const INDEXABLE_HOSTS = ["clawbits.ai"];

export const GET: APIRoute = ({ site }) => {
  const sitemap = new URL("sitemap-index.xml", site).href;
  const llms = new URL("llms.txt", site).href;

  if (!site || !INDEXABLE_HOSTS.includes(site.hostname)) {
    return new Response(
      [
        `# Non-production origin (${site?.hostname ?? "unknown host"}).`,
        "# The canonical site is https://clawbits.ai - see src/pages/robots.txt.ts.",
        "",
        "User-agent: *",
        "Disallow: /",
        "",
      ].join("\n"),
      { headers: { "Content-Type": "text/plain; charset=utf-8" } },
    );
  }

  const body = [
    "# Clawbits - https://clawbits.ai",
    "# Every crawler below is allowed. See src/lib/crawlers.ts for why.",
    "",
    "User-agent: *",
    "Allow: /",
    "",
    ...AI_CRAWLERS.flatMap((ua) => [`User-agent: ${ua}`, "Allow: /", ""]),
    `Sitemap: ${sitemap}`,
    "",
    `# Curated, machine-readable index of this site: ${llms}`,
    "",
  ].join("\n");

  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
};
