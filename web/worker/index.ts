import { isAiCrawler } from "../src/lib/crawlers";

/**
 * The one piece of server code on this site.
 *
 * It exists to answer a single question - "is this a named AI crawler asking
 * for the homepage?" - and if so to serve dist/_bot/index.html instead of
 * dist/index.html. That variant is the same page with the hero demo cut out:
 * 69% of the bytes and 66% of the parseable text, all of it invented sample
 * conversation that a reader without a screen has no way to identify as such.
 * See scripts/build-bot-page.mjs for the measurements.
 *
 * WHY THIS IS NOT THE CLOUDFLARE ADAPTER
 *
 * astro.config.mjs explains at length why @astrojs/cloudflare is deliberately
 * absent, and none of that changed: the site is still `output: "static"`, still
 * has zero server-rendered routes, and still builds into a flat ./dist that
 * Cloudflare serves from its asset store. This is a hand-written Worker with an
 * ASSETS binding sitting in front of that store - not an SSR runtime. Adding
 * the adapter would split dist into client/server, emit an empty server bundle
 * and demand a KV binding, for a file that reads one header.
 *
 * WHY IT BARELY RUNS
 *
 * `assets.run_worker_first` in wrangler.jsonc lists exactly two patterns, so
 * every other request on the site - every doc page, every asset, every .md
 * endpoint - is served straight from the asset store with no Worker invocation
 * at all, exactly as before. The Worker is on the path for `/` and `/_bot/*`
 * and nothing else.
 *
 * WHAT IT IS CAREFUL ABOUT
 *
 *   Search engines. Googlebot and Bingbot are not in the crawler list and must
 *   never be: serving a search crawler something a person does not get is
 *   cloaking. src/lib/crawlers.ts is assistants and training crawlers only.
 *
 *   Caching. The `/` response varies by request header, so it says so. Without
 *   `Vary: User-Agent` any shared cache between here and a reader is entitled
 *   to hand a person the crawler's copy - a homepage with no hero.
 *
 *   Discoverability. `/_bot/` is an implementation detail of this file, not a
 *   URL. Left reachable it would be a second, crawlable copy of the homepage
 *   competing with the apex for its own content - the exact failure the
 *   preview-host rules in public/_headers exist to prevent. It 404s.
 */

interface Env {
  ASSETS: Fetcher;
}

/** The variant's path in the asset store. Written by build-bot-page.mjs. */
const BOT_PAGE = "/_bot/";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Not a URL. See the note above.
    if (url.pathname.startsWith("/_bot")) {
      return new Response("Not found", {
        status: 404,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    if (!isAiCrawler(request.headers.get("user-agent"))) {
      // The overwhelmingly common path: hand the request back untouched. Note
      // this returns the asset store's own response, headers included, so
      // public/_headers still applies exactly as it did before this file.
      return withVary(await env.ASSETS.fetch(request));
    }

    // Fetch the variant by URL on the same origin, preserving the request
    // method and headers so a HEAD stays a HEAD and a conditional stays
    // conditional. If it is somehow missing from the build, fall through to the
    // real page rather than serving the crawler a 404 - a fat homepage is a
    // worse answer, never a broken one.
    const variant = await env.ASSETS.fetch(
      new Request(new URL(BOT_PAGE, url), request),
    );
    if (!variant.ok) return withVary(await env.ASSETS.fetch(request));

    return withVary(variant);
  },
} satisfies ExportedHandler<Env>;

/**
 * Mark the response as header-dependent.
 *
 * Applied to BOTH branches, not just the crawler one: `Vary` describes the
 * resource's behaviour, and a cache that stored the human copy without it would
 * be just as free to replay it for a crawler. The response is cloned because
 * the headers of an asset-store response are immutable.
 */
function withVary(response: Response): Response {
  const out = new Response(response.body, response);
  const existing = out.headers.get("Vary");
  out.headers.set(
    "Vary",
    existing && !/user-agent/i.test(existing)
      ? `${existing}, User-Agent`
      : existing || "User-Agent",
  );
  return out;
}
