import type { APIRoute } from "astro";
import { getCollection } from "astro:content";
import { DOCS } from "../../docs-allowlist";

/**
 * Raw Markdown for every doc page, at /docs/<slug>.md
 *
 * Plan §7, and the cheapest win on the site: an agent that follows the link at
 * the bottom of a doc page gets the clean source instead of parsed HTML, with
 * no navigation, no styling, and no token budget spent on markup.
 *
 * Served as text/plain deliberately - text/markdown makes browsers download
 * the file, which makes the "View as Markdown" link feel broken to a human
 * who clicks it.
 */
export async function getStaticPaths() {
  const loaded = await getCollection("docs");

  return DOCS.map((entry) => {
    const doc = loaded.find((d) => d.id === entry.slug);
    if (!doc) {
      throw new Error(`docs allowlist names ${entry.file}, but it was not loaded.`);
    }
    // Same incremental-build opt-in as [slug].astro: skip re-rendering when
    // the body digest and module graph are unchanged.
    return { params: { slug: entry.slug }, props: { entry, body: doc.body ?? "" }, cacheKey: doc.digest };
  });
}

export const GET: APIRoute = ({ props, site }) => {
  const { entry, body } = props as { entry: (typeof DOCS)[number]; body: string };

  // A short provenance header so the file still identifies itself once an
  // agent has copied it away from its URL.
  const header = [
    `<!-- ${entry.title} - Clawbits protocol documentation`,
    `     ${new URL(`/docs/${entry.slug}`, site).href}`,
    `     Source: docs/${entry.file}`,
    `     Verbatim except that cross-references to other specs have been`,
    `     rewritten from repo-relative paths to URLs on this site. -->`,
    "",
    "",
  ].join("\n");

  return new Response(header + body, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
};
