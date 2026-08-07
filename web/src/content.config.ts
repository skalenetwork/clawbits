import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";
import { DOCS, FILE_TO_SLUG } from "./docs-allowlist";

/**
 * The protocol docs are loaded straight from the repository's `docs/` tree -
 * NOT copied into web/. A copy would be a second source of truth that goes
 * stale the first time someone edits a spec and forgets the website.
 *
 * Only the files named in the audited allowlist (src/docs-allowlist.ts) are
 * read, so a new file appearing in docs/protocol/ is never published by
 * accident. These files have no frontmatter; every piece of metadata (title,
 * summary, group, slug) is curated in the allowlist, which is what makes the
 * publication decision reviewable in one place.
 *
 * This is a hand-written loader rather than `glob()` because the specs'
 * cross-references have to be rewritten BEFORE the Markdown is parsed - see
 * rewriteLinks. An earlier attempt post-processed `entry.rendered.html` after
 * calling glob()'s loader, which silently did nothing: rendering is lazy, so
 * `rendered` is not populated at load time and every rewrite was skipped. The
 * pages still built, and the only symptom was relative .md hrefs surviving
 * into production.
 */

/**
 * Rewrite the specs' cross-references, in Markdown source.
 *
 * They link to each other with repo-relative paths -
 * `[Channels](CHANNELS_AND_MESSAGING_PROCEDURES_SPEC.md)`, `[Reef](../REEF.md)`.
 * Rendered as-is on a website, every one of those is a 404.
 *
 *   target IS published     -> /docs/<slug>, preserving any #anchor
 *   target is NOT published -> drop the link, keep the text
 *
 * The drop matters: excluded files are excluded deliberately (internal
 * runbooks, unshipped drafts), so a reference must not survive as a dead href
 * OR as a pointer to something we chose not to publish.
 *
 * Operating on Markdown rather than HTML keeps this to one predictable form -
 * `](path)` - instead of guessing at rendered attribute order.
 */
function rewriteLinks(markdown: string): string {
  return markdown.replace(
    /\[([^\]]*)\]\((?!https?:|\/|#)([^)\s#]*?\.md)(#[^)\s]*)?\)/g,
    (_match, text: string, path: string, anchor = "") => {
      const slug = FILE_TO_SLUG.get(path.split("/").pop()!);
      // Trailing slash before any anchor: /docs/<slug>/#section. This is the
      // canonical form (trailingSlash: "always"), and the specs cross-reference
      // each other heavily - slash-less here meant every one of those links
      // redirected.
      return slug ? `[${text}](/docs/${slug}/${anchor})` : text;
    },
  );
}

/**
 * Replace the Markdown processor's table-alignment inline styles with classes.
 *
 * GFM alignment rows (`:---`, `:---:`, `---:`) render as
 * `<td style="text-align: center">`. The site's CSP ships style-src hashes with
 * no 'unsafe-inline', and hashes DO NOT apply to style attributes - so the
 * browser refuses every one of them. 647 across the corpus today, each one a
 * console error, and every centered column silently falling back to
 * `.shell .prose th,td { text-align: start }`.
 *
 * The alternative - adding 'unsafe-hashes' or 'unsafe-inline' to style-src -
 * was rejected: it would leave 647 dead attributes in the shipped HTML and
 * permanently reopen attribute-style injection on a site whose strict CSP is a
 * stated property.
 *
 * `left` is dropped rather than classed: it is already the inherited default,
 * so a `.ta-left` class would be 522 attributes of pure noise.
 *
 * All THREE values are matched even though the corpus currently emits only two.
 * A single `---:` column added to any spec later emits the third, and matching
 * two literals would ship it blocked - the exact silent failure this replaces.
 * `verify:no-inline-styles` (scripts/verify-no-inline-styles.mjs) fails the
 * build if a fourth form ever appears.
 *
 * Safe as a regex over rendered HTML because the processor emits these on
 * `<td>`/`<th>` only, with no other attributes and a fixed spelling - verified
 * across all 17 published docs.
 */
function alignmentStylesToClasses(html: string): string {
  return html.replace(
    / style="text-align: (left|center|right)"/g,
    (_match, align: string) => (align === "left" ? "" : ` class="ta-${align}"`),
  );
}

const docs = defineCollection({
  loader: {
    name: "protocol-docs",
    async load({ store, renderMarkdown, generateDigest, config, logger }) {
      store.clear();

      for (const entry of DOCS) {
        const url = new URL(`../docs/${entry.file}`, config.root);
        let raw: string;
        try {
          raw = await readFile(fileURLToPath(url), "utf8");
        } catch {
          // Loud, not silent: the allowlist is the publication decision, so a
          // file it names going missing must not degrade to a quietly absent
          // page. [slug].astro throws on the same condition.
          logger.error(
            `docs allowlist names docs/${entry.file}, which does not exist. ` +
              `Fix the path in src/docs-allowlist.ts or restore the file.`,
          );
          continue;
        }

        const body = rewriteLinks(raw);
        // Post-processing `rendered.html` works HERE and would not work behind
        // glob(): rendering is lazy there, so `entry.rendered` is unpopulated at
        // load time and every rewrite is silently skipped (see the header note).
        // This loader awaits renderMarkdown itself, so the HTML is real.
        const rendered = await renderMarkdown(body);
        store.set({
          id: entry.slug,
          data: { title: entry.title, summary: entry.summary },
          body,
          digest: generateDigest(body),
          rendered: { ...rendered, html: alignmentStylesToClasses(rendered.html) },
        });
      }

      logger.info(`Loaded ${DOCS.length} protocol docs`);
    },
  },
});

/**
 * The changelog reads the app's release notes IN PLACE - same principle as the
 * docs collection above, and for the same reason: a copy under web/ would go
 * stale the first release someone ships without remembering the website.
 *
 * The notes are NOT moving out of frontend/src/ (decided 2026-08-06). They stay
 * app-owned because the app still needs the whole back-catalogue bundled - the
 * "What's new" dialog renders the DELTA between a device's last-seen version
 * and the latest (src/hooks/useReleaseNotes.ts), so an old device can need
 * arbitrarily old entries. Publishing the history here does not let the app
 * drop it; both surfaces render the full set. Promoting the files to a neutral
 * repo-root home would only move the cost, making BOTH Vite roots reach
 * outside themselves instead of one.
 *
 * Unlike `docs`, this is the stock `glob()` loader, not a hand-written one. The
 * warning in the docs comment does not apply: that loader is hand-written
 * solely so cross-references can be rewritten before parse, and release notes
 * contain no links at all (verified across all 18 files - no tables, no
 * embedded images, effectively just bullet lists and bold).
 *
 * `[0-9]*.md` and not `*.md`: the folder's README.md has no frontmatter and
 * would fail schema validation, taking the whole build down with it. Version
 * filenames all start with a digit, so the pattern is also exactly the
 * "only files named like a version are releases" rule the app applies in
 * src/lib/releaseNotes.ts - kept in lock-step by hand, since the two build
 * systems cannot share the regex.
 */
const changelog = defineCollection({
  loader: glob({
    pattern: "[0-9]*.md",
    // Relative to the Astro project root (web/), so this points at the app's
    // folder one level up. Requires vite.server.fs.allow in astro.config.mjs -
    // the dev server refuses to read outside its root without it.
    base: "../frontend/src/release-notes",
    // WITHOUT this the ids are wrong in a way that still builds: glob()
    // slugifies filenames by default, so `0.17.0.md` becomes the id `0170`.
    // That silently breaks three things at once - the displayed version reads
    // "v0170", the anchor becomes #v0170, and the version->hero-image lookup
    // misses every file. The filename IS the version here, so keep it verbatim.
    generateId: ({ entry }) => entry.replace(/\.md$/, ""),
  }),
  // Every note carries both keys today; requiring them means a release that
  // forgets one fails the build here rather than rendering a headless entry.
  schema: z.object({
    date: z.coerce.date(),
    title: z.string(),
  }),
});

export const collections = { docs, changelog };
