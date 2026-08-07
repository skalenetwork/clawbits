#!/usr/bin/env node
/**
 * Internal link gate.
 *
 * Every internal href in the built site - including the ones inside llms.txt
 * and llms-full.txt - must resolve to a page that actually exists.
 *
 * This exists because the nav, the hero CTAs, the footer, and the generated
 * machine index all linked to /docs, /changelog, and /blog for three phases
 * before those routes were built. Shipping a machine-readable index full of
 * 404s is the exact opposite of what the discovery work is for, and nothing
 * catches it: the build succeeds, the type checker is happy, and the page
 * looks right.
 *
 * Usage:  bun run build && bun run verify:links
 */

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");

if (!existsSync(DIST)) {
  console.error("dist/ missing - run `bun run build` first");
  process.exit(1);
}

function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const files = walk(DIST);

/** Every path the built site can actually serve. */
const served = new Set(["/"]);
for (const f of files) {
  const rel = "/" + relative(DIST, f).split("\\").join("/");
  served.add(rel);
  // dist/privacy/index.html is served at /privacy and /privacy/
  if (rel.endsWith("/index.html")) {
    const dir = rel.slice(0, -"/index.html".length);
    served.add(dir || "/");
    served.add(`${dir}/`);
  }
}

const HREF = /(?:href|src)="([^"]+)"/g;
// Markdown links plus bare URLs, for the generated .txt files.
//
// The bare-URL branch stops before trailing sentence punctuation. Without the
// exclusion a URL written mid-sentence ("...at https://host/x/y.md.") swallows
// the full stop and is reported as a dead link that does not exist.
const TXT_LINK =
  /\]\((https?:\/\/[^)]+)\)|(?<![(\w])(https?:\/\/[^\s)<>"]*[^\s)<>".,;:!?])/g;

const SITE_HOSTS = new Set(["clawbits.ai", "www.clawbits.ai"]);

const problems = [];

function checkInternal(path, source) {
  // Strip query and fragment; anchors are validated by the legal parity gate.
  const clean = path.split("#")[0].split("?")[0];
  if (!clean || clean === "/") return;
  if (served.has(clean) || served.has(clean.replace(/\/$/, ""))) return;
  problems.push({ source, href: path });
}

for (const f of files) {
  const rel = "/" + relative(DIST, f).split("\\").join("/");
  const body = readFileSync(f, "utf8");

  if (f.endsWith(".html")) {
    // The URL this file is served at, used to resolve relative hrefs.
    const pageUrl = rel.endsWith("/index.html")
      ? rel.slice(0, -"index.html".length)
      : rel;

    for (const [, href] of body.matchAll(HREF)) {
      if (/^[a-z]+:|^#/i.test(href)) continue; // external or in-page
      if (href.startsWith("/")) {
        checkInternal(href, rel);
      } else {
        // RELATIVE hrefs are checked too. Skipping them is how 30 relative
        // `.md` cross-references from the protocol specs shipped unnoticed:
        // they never start with "/", so a startsWith("/") filter waves every
        // one of them through.
        checkInternal(new URL(href, `https://x${pageUrl}`).pathname, rel);
      }
    }
  }

  if (f.endsWith(".txt")) {
    for (const m of body.matchAll(TXT_LINK)) {
      const url = m[1] ?? m[2];
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        continue;
      }
      // Only our own host is checkable; app.* and github.com are out of scope.
      if (SITE_HOSTS.has(parsed.host)) {
        checkInternal(parsed.pathname, rel);
      }
    }
  }
}

if (problems.length) {
  console.error(`✗ ${problems.length} internal link(s) point at nothing:\n`);
  for (const p of problems) {
    console.error(`    ${p.source}  ->  ${p.href}`);
  }
  console.error(
    "\nEither build the route or point the link off-site until it exists.",
  );
  process.exit(1);
}

console.log(`✓ links: every internal href resolves (${served.size} paths served)`);
