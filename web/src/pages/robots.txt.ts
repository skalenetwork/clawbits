import type { APIRoute } from "astro";

/**
 * robots.txt with explicit per-bot rules.
 *
 * A blanket `User-agent: *` would work, but naming each crawler is a decision
 * record: it makes it obvious which AI crawlers we have considered and lets a
 * single one be denied later without touching everything else.
 *
 * Every one of these is ALLOWED, deliberately. Clawbits wants to be cited when
 * someone asks an assistant how to give an agent its own chat identity - that
 * is the entire point of the discovery work in this phase. Revisit only if a
 * specific crawler starts costing real bandwidth.
 *
 * The distinction worth keeping straight: some of these index for training,
 * some fetch live on a user's behalf. Blocking the live fetchers (ChatGPT-User,
 * Claude-User, PerplexityBot) is what makes an assistant say "I can't read that
 * page", so those matter most.
 */

const CRAWLERS = [
  // OpenAI: training index, live user fetch, and search.
  "GPTBot",
  "ChatGPT-User",
  "OAI-SearchBot",
  // Anthropic: training index and live user fetch.
  "ClaudeBot",
  "Claude-User",
  "Claude-SearchBot",
  // Google: Gemini/Vertex grounding. Separate from Googlebot, which is covered
  // by the wildcard and must never be blocked here.
  "Google-Extended",
  // Perplexity: index and live fetch.
  "PerplexityBot",
  "Perplexity-User",
  // Apple Intelligence / Siri grounding.
  "Applebot-Extended",
  // Meta, Amazon, Bytedance, Common Crawl.
  "meta-externalagent",
  "Amazonbot",
  "Bytespider",
  "CCBot",
];

/**
 * The only hosts that may be indexed.
 *
 * Everything else this site is ever served from - preview.clawbits.ai,
 * preview.freeclaws.ai, the *.workers.dev URLs - is the SAME CONTENT on a
 * different origin. Left crawlable, a preview host competes with the apex for
 * its own copy and the fourteen AI crawlers invited below ingest the wrong
 * origin as canonical. Derived from the build's SITE_URL rather than a
 * hand-kept host list, so a new preview target is closed by default.
 *
 * _headers carries the matching `X-Robots-Tag: noindex` for the two known
 * preview hosts: robots.txt stops the crawl, the header stops the indexing of
 * a URL someone linked to anyway. Both are needed; neither is sufficient.
 */
const INDEXABLE_HOSTS = ["clawbits.ai", "freeclaws.ai"];

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
    "# Every crawler below is allowed. See src/pages/robots.txt.ts for why.",
    "",
    "User-agent: *",
    "Allow: /",
    "",
    ...CRAWLERS.flatMap((ua) => [`User-agent: ${ua}`, "Allow: /", ""]),
    `Sitemap: ${sitemap}`,
    "",
    `# Curated, machine-readable index of this site: ${llms}`,
    "",
  ].join("\n");

  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
};
