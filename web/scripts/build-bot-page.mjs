#!/usr/bin/env node
/**
 * Emit dist/_bot/index.html - the homepage with the hero demo cut out.
 *
 * WHY
 *
 * The hero mockup (AppDemo + PhoneDemo, both shipped so the CSS can pick one)
 * measured 240,820 of dist/index.html's 348,977 bytes on 2026-08-13: 69% of the
 * page. Tag-stripped, it is 11,803 of 17,776 characters - 66% of everything a
 * reader without a browser actually parses. And that text is INVENTED: sample
 * names, sample messages, sample unread counts. An assistant summarising the
 * page reads "Mara: can you check the deploy?" with no way to know it is set
 * dressing, and repeats it as a product fact. The cost is not just bytes.
 *
 * worker/index.ts serves this file, at `/`, to the named AI crawlers in
 * src/lib/crawlers.ts. Everyone else - people, and every search engine - gets
 * dist/index.html untouched.
 *
 * WHY A POST-BUILD CUT RATHER THAN A SECOND ASTRO PAGE
 *
 * A `/_bot/` page would mean refactoring index.astro (47 KB, one enormous
 * scoped <style>) into a component taking a `demo` prop, and would put a second
 * real route in the sitemap and the route table. Slicing between two markers
 * keeps ONE page, one canonical, one set of styles. The fragility that buys is
 * paid for by the assertions below: a missing marker or an unexpectedly small
 * cut FAILS THE BUILD rather than silently shipping the fat page to crawlers.
 *
 * WHAT IT DOES NOT DO
 *
 * It does not touch <head>. The canonical stays https://clawbits.ai/ - correct,
 * because this file is only ever served AT `/`, never as a URL of its own
 * (the worker 404s /_bot/* to keep it that way). The CSP meta keeps the hashes
 * of the scripts that were cut; an unused hash permits nothing.
 *
 * Usage: runs automatically as the last step of `bun run build`.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const SOURCE = join(DIST, "index.html");
const OUT_DIR = join(DIST, "_bot");
const OUT = join(OUT_DIR, "index.html");

/** Emitted by src/pages/index.astro. Real HTML comments, so they survive. */
const START = "<!--bot:demo:start-->";
const END = "<!--bot:demo:end-->";

/**
 * Floor for how much the cut must remove, in bytes.
 *
 * Not a round number for its own sake: the region measured 240 KB, and anything
 * under 150 KB means the markers have drifted apart from the demo - most likely
 * someone moved AppDemo out from between them. Failing here is the whole point
 * of the file; a "successful" build that trimmed 400 bytes would ship crawlers
 * the page this script exists to stop.
 */
const MIN_CUT_BYTES = 150_000;

if (!existsSync(SOURCE)) {
  console.error("dist/index.html missing - run `astro build` first");
  process.exit(1);
}

const html = readFileSync(SOURCE, "utf8");

const start = html.indexOf(START);
const end = html.indexOf(END);

if (start === -1 || end === -1) {
  console.error(
    `build-bot-page: ${start === -1 ? START : END} not found in dist/index.html.\n` +
      "The markers live in src/pages/index.astro around the hero <div class=\"stage\">.\n" +
      "If the hero was restructured, move the markers - do not delete this step.",
  );
  process.exit(1);
}
if (end < start) {
  console.error("build-bot-page: markers are out of order in dist/index.html");
  process.exit(1);
}

const cut = end + END.length - start;
if (cut < MIN_CUT_BYTES) {
  console.error(
    `build-bot-page: the marked region is only ${cut} bytes, under the ${MIN_CUT_BYTES} floor.\n` +
      "The markers no longer bracket the hero demo. Fix src/pages/index.astro.",
  );
  process.exit(1);
}

/**
 * What replaces it.
 *
 * Read out of src/content/home.ts rather than written here, because index.astro
 * says so at the top of the file: all copy lives in one module so the page,
 * llms.txt and llms-full.txt cannot drift. Parsed with a regex rather than
 * imported so this stays a plain .mjs with no TypeScript loader - same reasoning
 * as build-headers.mjs enumerating dist/ instead of importing the allowlist.
 */
const homeTs = readFileSync(join(ROOT, "src", "content", "home.ts"), "utf8");
const altMatch = homeTs.match(/demoAlt:\s*\n?\s*"((?:[^"\\]|\\.)*)"/);
if (!altMatch) {
  console.error(
    "build-bot-page: HERO.demoAlt not found in src/content/home.ts.\n" +
      "It is the prose that stands in for the demo - restore it, or this page\n" +
      "loses its hero entirely with nothing said in its place.",
  );
  process.exit(1);
}
const alt = altMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");

const replacement = `<p class="stage-alt">${alt}</p>`;
const out = html.slice(0, start) + replacement + html.slice(end + END.length);

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT, out);

const pct = ((1 - out.length / html.length) * 100).toFixed(0);
console.log(
  `build-bot-page: dist/_bot/index.html - ${html.length} -> ${out.length} bytes (-${pct}%)`,
);
