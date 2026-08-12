#!/usr/bin/env node
/**
 * Analytics collector gate.
 *
 * THE FAILURE THIS EXISTS TO CATCH: the Umami tag is fetched from one host and
 * POSTs its events to a DIFFERENT one. `cloud.umami.is/script.js` hardcodes
 * `https://gateway.umami.is/api/send` as its collector, so a CSP that allows
 * only the script host looks completely correct - the tag is in the HTML, the
 * script loads, `window.umami` exists, the tracker docs agree with you - and
 * every single event is refused by connect-src. Nothing fails. The build is
 * green, the page is right, and the dashboard is empty.
 *
 * The apex shipped in exactly that state and collected nothing until it was
 * caught by hand on 2026-08-12. A static allowlist cannot prevent a repeat,
 * because the collector host is the VENDOR's choice and can change under a
 * script tag we do not version. So this reads the tracker that will actually
 * run and checks the CSP against it.
 *
 * Deliberately NOT fatal on a network failure: a vendor blip must not break
 * every deploy. It is fatal only when the tracker is successfully read and
 * names a host the shipped CSP would block - which is a real, silent outage.
 *
 * Usage:  bun run build && bun run verify:analytics
 */

import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const INDEX = join(DIST, "index.html");

if (!existsSync(INDEX)) {
  console.error("dist/index.html missing - run `bun run build` first");
  process.exit(1);
}

const html = readFileSync(INDEX, "utf8");

/* The tag only exists on builds whose SITE_URL is a tracked host (Base.astro's
 * `trackAnalytics`). Staging ships without it, and that is not a failure. */
const tag = html.match(/<script[^>]*\bdata-website-id=[^>]*>/i)?.[0];
if (!tag) {
  console.log("verify:analytics - no analytics tag in this build (staging); skipped");
  process.exit(0);
}

const scriptUrl = tag.match(/\bsrc="([^"]+)"/i)?.[1];
if (!scriptUrl) {
  console.error("analytics tag has no src - cannot verify the collector");
  process.exit(1);
}

/** The connect-src hosts the shipped pages actually allow. */
const csp = html.match(/http-equiv="Content-Security-Policy"[^>]*\bcontent="([^"]*)"/i)?.[1] ?? "";
const connectSrc = csp
  .split(";")
  .map((d) => d.trim())
  .find((d) => d.startsWith("connect-src"));

if (!connectSrc) {
  console.error("no connect-src in the built CSP - every analytics event would be blocked");
  process.exit(1);
}

const allowed = new Set(
  connectSrc
    .split(/\s+/)
    .slice(1)
    .map((s) => s.replace(/^https?:\/\//, "").replace(/\/$/, "")),
);

let tracker;
try {
  const res = await fetch(scriptUrl, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  tracker = await res.text();
} catch (err) {
  console.warn(`verify:analytics - could not read ${scriptUrl} (${err.message}); skipped`);
  process.exit(0);
}

/* Every absolute origin the tracker names. Today that is exactly one literal,
 * the collector default. Checking all of them rather than grepping for the
 * known host is the point: a new one appearing is precisely the change that
 * would otherwise go unnoticed. */
const hosts = [...new Set([...tracker.matchAll(/https:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1]))];
const blocked = hosts.filter((h) => !allowed.has(h) && !allowed.has(`*.${h.split(".").slice(1).join(".")}`));

if (blocked.length) {
  console.error(
    `\nThe tracker at ${scriptUrl} sends to a host the CSP blocks:\n` +
      blocked.map((h) => `  - https://${h}`).join("\n") +
      `\n\nconnect-src currently allows: ${[...allowed].join(", ")}\n` +
      `Add the host(s) to security.csp.directives connect-src in astro.config.mjs.\n` +
      `Until then this build collects ZERO analytics and fails silently in production.\n`,
  );
  process.exit(1);
}

console.log(`verify:analytics OK - ${scriptUrl} -> ${hosts.map((h) => `https://${h}`).join(", ")} allowed`);
