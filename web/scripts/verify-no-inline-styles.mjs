#!/usr/bin/env node
/**
 * Inline-style gate.
 *
 * The site ships a CSP whose style-src carries build-computed hashes and NO
 * 'unsafe-inline'. Hashes never apply to style attributes, so every `style="…"`
 * in the built HTML is refused by the browser at runtime.
 *
 * That failure is invisible everywhere it would normally be caught: `astro dev`
 * does not emit the meta CSP at all, `astro build` succeeds, `astro check` is
 * happy, and the page looks right apart from whatever the dropped declaration
 * was doing. It shipped once already - the Markdown processor's GFM table
 * alignment (`style="text-align: center"`) produced 647 refused attributes and
 * silently start-aligned every centered column in the protocol docs.
 *
 * The docs loader now rewrites those into classes (alignmentStylesToClasses in
 * src/content.config.ts). This gate is what stops the next one: a `---:` column
 * in a new spec, a component authored with a style attribute, a dependency that
 * starts emitting one.
 *
 * WHAT THIS CANNOT SEE
 *
 * Only attributes present in the built HTML. A library that injects a <style>
 * element at RUNTIME - which is how @paper-design/shaders broke the hero
 * canvas - appears nowhere in dist/ and passes this gate cleanly. Catching that
 * class needs a real page load collecting securitypolicyviolation events.
 * Keep both.
 *
 * Usage:  bun run build && bun run verify:no-inline-styles
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

const html = walk(DIST).filter((f) => f.endsWith(".html"));

/**
 * `style="…"` on any element.
 *
 * Deliberately NOT matched: `<style>` ELEMENTS. Astro hashes those, they are
 * allowed, and Base.astro ships one on purpose (the empty data-paper-shader
 * marker). The trailing `=` and quote are what separate the attribute from the
 * tag name.
 */
const STYLE_ATTR = /\sstyle\s*=\s*"([^"]*)"/g;

const offenders = [];

for (const file of html) {
  const source = readFileSync(file, "utf8");
  const route = "/" + relative(DIST, file).split("\\").join("/");

  for (const match of source.matchAll(STYLE_ATTR)) {
    // Line number, so the report points somewhere actionable.
    const line = source.slice(0, match.index).split("\n").length;
    offenders.push({ route, line, value: match[1] });
  }
}

if (offenders.length === 0) {
  console.log(`verify:no-inline-styles - ${html.length} pages, no style attributes`);
  process.exit(0);
}

// Group by value: one runaway source usually produces hundreds of identical
// attributes, and a list of 647 lines buries the one that is actually new.
const byValue = new Map();
for (const o of offenders) {
  if (!byValue.has(o.value)) byValue.set(o.value, []);
  byValue.get(o.value).push(o);
}

console.error(
  `\nverify:no-inline-styles FAILED - ${offenders.length} style attribute(s) in built HTML.\n` +
    `The CSP (astro.config.mjs security.csp) refuses every one of these at runtime.\n`,
);

for (const [value, list] of [...byValue].sort((a, b) => b[1].length - a[1].length)) {
  console.error(`  style="${value}"  x${list.length}`);
  for (const o of list.slice(0, 3)) console.error(`      ${o.route}:${o.line}`);
  if (list.length > 3) console.error(`      ... and ${list.length - 3} more`);
}

console.error(
  `\nFix at the source, not by loosening the CSP:\n` +
    `  - Markdown table alignment -> alignmentStylesToClasses (src/content.config.ts)\n` +
    `  - a component -> use a class; scoped <style> blocks are hashed and fine\n` +
    `  - define:vars -> emits a style attribute; use a class or a data attribute\n`,
);

process.exit(1);
