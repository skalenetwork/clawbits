#!/usr/bin/env node
/**
 * Derives every brand file we publish from the two masters.
 *
 * There is exactly ONE drawing in this brand. clawbits-long.svg contains the
 * mark plus eight letterforms; clawbits-short.svg is that same mark path with
 * every y coordinate 44 units lower. Verified by comparing the path data
 * directly - not assumed. So every variant below is a transform of the
 * masters, never a redraw, and re-running this script is the only way a
 * variant is allowed to change.
 *
 * Run:  bun run brand:assets   (wired into `bun run build`)
 *
 * No dependencies on purpose: this is string surgery on two SVG files plus a
 * hand-rolled store-only ZIP writer. Adding a rasteriser or an archiver to
 * ship four kilobytes of vector would be the wrong trade.
 */

import { readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32 } from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));
const BRAND = join(HERE, "..", "public", "brand");

/* ── The geometry, measured not guessed ────────────────────────────────────
 * Tight ink bounding boxes, obtained by flattening every cubic Bezier and
 * solving for the derivative roots. Re-measure with scripts/bbox.mjs if the
 * masters are ever redrawn; do NOT hand-edit these.
 *
 * The unit X is the dot on the "i" - 142.56 units wide. Every clear-space and
 * padding number on /brand is a multiple of it, which is why the page can
 * claim its dimensions are real: they are all derived from one measured
 * feature of the artwork itself. */
export const GEO = {
  /** clawbits-long.svg */
  lockup: { vbW: 4082, vbH: 672, inkW: 4070.6, inkH: 671.58 },
  /** The claw, identical in both masters (long: y0-671.58, short: y44-715.58). */
  mark: { w: 759.02, h: 671.58 },
  /**
   * The eight letterforms as one block, measured separately from the lockup.
   * NOT the same as the lockup's ink height: the tallest letter ("b", "l")
   * tops out at y=9 and the baseline sits at y=662.8, so the word is 653.8
   * tall inside a 671.58 lockup. Using the lockup height here is a real bug -
   * it puts ~5 units of phantom padding under the stacked wordmark and shifts
   * it down by the same amount.
   */
  word: { x: 809.6, y: 9, w: 3261, h: 653.8 },
  /** The i-dot. The clear-space module. */
  X: 142.56,
  /** Gap between the mark and the "c" in the lockup. */
  markGap: 50.6,
};

const INK = "#0c0d0e"; // --color-paper
const PAPER = "#f7f5f1"; // --color-canvas-text, our white. NOT #ffffff.

const read = (f) => readFileSync(join(BRAND, f), "utf8");

/** Recolour every fill in a master. The masters are fill="black" throughout. */
function recolour(svg, to) {
  return svg.replace(/fill="black"/g, `fill="${to}"`);
}

/**
 * The mark path, lifted out of the lockup rather than out of the short file,
 * because in the lockup it sits at y=0 and needs no offset correction.
 */
function markPath() {
  const long = read("clawbits-long.svg");
  const m = long.match(/<path d="(M597\.017 5\.80972[^"]*)"/);
  if (!m) throw new Error("mark path not found in clawbits-long.svg - was it redrawn?");
  return m[1];
}

/** The eight letterform paths, in document order. */
function letterPaths() {
  const long = read("clawbits-long.svg");
  const all = [...long.matchAll(/<path d="([^"]+)"/g)].map((m) => m[1]);
  if (all.length !== 9) throw new Error(`expected 9 paths in the lockup, found ${all.length}`);
  return all.slice(1);
}

const files = [];
const emit = (name, body) => {
  writeFileSync(join(BRAND, name), body);
  files.push(name);
};

/* ── 1. Inverted masters ────────────────────────────────────────────────────
 * For dark grounds. PAPER, not #ffffff: pure white on our warm black is a
 * cold edge, and #f7f5f1 is the value the rest of the site already uses for
 * text on --color-canvas. */
emit("clawbits-long-inverted.svg", recolour(read("clawbits-long.svg"), PAPER));
emit("clawbits-short-inverted.svg", recolour(read("clawbits-short.svg"), PAPER));

/* ── 2. currentColor variants ───────────────────────────────────────────────
 * For inlining into HTML, where the mark should inherit its surroundings.
 * This is the variant a developer actually wants and no master provided. */
emit("clawbits-long-current.svg", recolour(read("clawbits-long.svg"), "currentColor"));
emit("clawbits-short-current.svg", recolour(read("clawbits-short.svg"), "currentColor"));

/* ── 3. Padded square mark ──────────────────────────────────────────────────
 * THE FIX. clawbits-short.svg is a 759x672 landscape mark letterboxed into a
 * 760 square: 44 units top and bottom, ZERO left and right - the artwork
 * touches both vertical edges. It cannot go in a favicon, an avatar or an app
 * icon without re-padding, which is why apps/mobile compensates with
 * "scale": 0.8 and the favicon PNGs were composited by hand.
 *
 * Here the mark is scaled to fit a 1024 box with exactly 1X of clear space on
 * every side, then centred on both axes. The width is the binding constraint
 * (the mark is landscape), so it drives the scale and the vertical centring
 * follows. */
{
  const box = 1024;
  const inner = box - 2 * GEO.X * (box / (GEO.mark.w + 2 * GEO.X));
  const s = (box - 2 * (GEO.X * (box / (GEO.mark.w + 2 * GEO.X)))) / GEO.mark.w;
  const w = GEO.mark.w * s;
  const h = GEO.mark.h * s;
  const tx = (box - w) / 2;
  const ty = (box - h) / 2;
  const square = (fill) =>
    `<svg width="${box}" height="${box}" viewBox="0 0 ${box} ${box}" fill="none" xmlns="http://www.w3.org/2000/svg">
<!-- The claw, scaled to leave exactly 1X (the i-dot, 142.56 master units) of
     clear space on every side, then centred. Generated by
     scripts/build-brand-assets.mjs - do not hand-edit. -->
<g transform="translate(${tx.toFixed(3)} ${ty.toFixed(3)}) scale(${s.toFixed(6)})">
<path d="${markPath()}" fill="${fill}"/>
</g>
</svg>
`;
  emit("clawbits-mark-square.svg", square(INK));
  emit("clawbits-mark-square-inverted.svg", square(PAPER));
  void inner;
}

/* ── 4. Stacked lockup ──────────────────────────────────────────────────────
 * Mark centred above the wordmark, for square-ish and narrow slots (sponsor
 * grids, splash screens, ad units) where the 6:1 horizontal lockup collapses
 * to illegibility. The vertical gap is 1X, the same module as the clear
 * space, so the stack is measurably part of the same system. */
{
  const letters = letterPaths();
  const { x: wordX, y: wordY, w: wordW, h: wordH } = GEO.word;
  const gap = GEO.X;
  // Scale the wordmark so its width matches ~2.6x the mark width - the ratio
  // at which the stack reads as one object rather than two stacked ones.
  const targetW = GEO.mark.w * 2.6;
  const s = targetW / wordW;
  const sw = wordW * s;
  const sh = wordH * s;
  const W = Math.max(GEO.mark.w, sw);
  const H = GEO.mark.h + gap + sh;
  const stacked = (fill) =>
    `<svg width="${W.toFixed(0)}" height="${H.toFixed(0)}" viewBox="0 0 ${W.toFixed(2)} ${H.toFixed(2)}" fill="none" xmlns="http://www.w3.org/2000/svg">
<!-- Stacked lockup: mark over wordmark, separated by 1X (the i-dot).
     Generated by scripts/build-brand-assets.mjs - do not hand-edit. -->
<g transform="translate(${((W - GEO.mark.w) / 2).toFixed(3)} 0)">
<path d="${markPath()}" fill="${fill}"/>
</g>
<g transform="translate(${((W - sw) / 2).toFixed(3)} ${(GEO.mark.h + gap).toFixed(3)}) scale(${s.toFixed(6)}) translate(${-wordX} ${-wordY})">
${letters.map((d) => `<path d="${d}" fill="${fill}"/>`).join("\n")}
</g>
</svg>
`;
  emit("clawbits-stacked.svg", stacked(INK));
  emit("clawbits-stacked-inverted.svg", stacked(PAPER));
}

/* ── 5. Machine-readable brand surface ──────────────────────────────────────
 * The one thing on this page that only a product built around agents could
 * ship. An agent asked to "use the Clawbits logo" should be able to fetch
 * this and get the right file and the right rule without parsing a webpage. */
const palette = [
  { name: "Paper", hex: "#f2efe8", role: "Page ground" },
  { name: "Raised", hex: "#f8f7f2", role: "Cards, code blocks" },
  { name: "Ink", hex: "#0c0d0e", role: "Primary text, and the mark on light grounds" },
  { name: "Muted", hex: "#6f7176", role: "Secondary text" },
  { name: "Faint", hex: "#9d9fa5", role: "Captions" },
  { name: "Signal", hex: "#c0394f", role: "The one accent. Links, eyebrows, focus." },
  { name: "Signal deep", hex: "#a82840", role: "Accent hover" },
  { name: "Canvas", hex: "#141311", role: "Dark surfaces" },
  { name: "Canvas text", hex: "#f7f5f1", role: "Text and the mark on dark grounds. Not #ffffff." },
];

const candy = [
  { name: "Strawberry", hex: "#e8425c" },
  { name: "Grape", hex: "#8f5bd6" },
  { name: "Blue", hex: "#4a8fe0" },
  { name: "Orange", hex: "#f09a3f" },
  { name: "Rust", hex: "#b03927" },
];

const base = "https://clawbits.ai/brand";
const brandJson = {
  name: "Clawbits",
  spelling:
    "Always 'Clawbits' - one word, capital C. Never ClawBits, Claw Bits or CLAWBITS. Lowercase only inside identifiers (clawbits.ai, @clawbitsai). The wordmark's lowercase is a property of the drawing, not a spelling.",
  tagline: "Agents don't plug in here. They belong here.",
  description:
    "Clawbits is team chat where AI agents are members, not integrations. Each agent holds its own API key and its own row in every membership, post, and reaction table, with its own mailbox, git repos, and automations. MIT licensed and self-hostable.",
  owner: "SKALE Labs",
  logo: {
    monochrome_only: true,
    note: "The mark is black, #f7f5f1, or currentColor. It is never the accent red and never sits inside the candy gradient.",
    lockup: { light: `${base}/clawbits-long.svg`, dark: `${base}/clawbits-long-inverted.svg`, inherit: `${base}/clawbits-long-current.svg` },
    mark: { light: `${base}/clawbits-short.svg`, dark: `${base}/clawbits-short-inverted.svg`, inherit: `${base}/clawbits-short-current.svg` },
    stacked: `${base}/clawbits-stacked.svg`,
    icon: `${base}/clawbits-mark-square.svg`,
  },
  clear_space: {
    unit: "The dot on the i",
    master_units: GEO.X,
    rule: "Leave at least one unit of clear space on every side of any lockup or mark.",
  },
  minimum_size: { lockup_px: 120, mark_px: 16 },
  colors: palette,
  gradient: { name: "Candy", note: "A surface the mark sits on, never a fill the mark is made of.", stops: candy },
  typeface: { name: "Geist", note: "Geist and Geist Mono. Open source, SIL Open Font License." },
  usage:
    "Do not alter these files in any way - no recolouring, stretching, rotating, or adding effects. Questions: brand@clawbits.ai",
  contact: "brand@clawbits.ai",
};
emit("brand.json", JSON.stringify(brandJson, null, 2) + "\n");

/* ── 6. The kit ─────────────────────────────────────────────────────────────
 * Store-only ZIP (no compression). SVGs are already tiny and deflate buys a
 * couple of kilobytes at the cost of a dependency or a shelled-out `zip` that
 * is not guaranteed to exist on the build host. Store-only is ~60 lines,
 * deterministic, and every unzipper on earth reads it. */
function zip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const dosTime = 0x0000; // fixed so the archive is byte-stable across builds
  const dosDate = 0x2821; // 2020-01-01
  for (const [name, buf] of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const sum = crc32(buf);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(buf.length, 18);
    local.writeUInt32LE(buf.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, buf);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0, 8);
    cen.writeUInt16LE(0, 10);
    cen.writeUInt16LE(dosTime, 12);
    cen.writeUInt16LE(dosDate, 14);
    cen.writeUInt32LE(sum, 16);
    cen.writeUInt32LE(buf.length, 20);
    cen.writeUInt32LE(buf.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(0, 42 - 8);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += local.length + nameBuf.length + buf.length;
  }
  const cenBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cenBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cenBuf, end]);
}

const kitFiles = [
  "clawbits-long.svg",
  "clawbits-long-inverted.svg",
  "clawbits-long-current.svg",
  "clawbits-short.svg",
  "clawbits-short-inverted.svg",
  "clawbits-short-current.svg",
  "clawbits-stacked.svg",
  "clawbits-stacked-inverted.svg",
  "clawbits-mark-square.svg",
  "clawbits-mark-square-inverted.svg",
  "brand.json",
];
writeFileSync(
  join(BRAND, "clawbits-brand-kit.zip"),
  zip(kitFiles.map((f) => [f, readFileSync(join(BRAND, f))])),
);

/* ── 7. The manifest ────────────────────────────────────────────────────────
 * Sizes are read off disk rather than typed, so the page cannot print a byte
 * count that disagrees with the file it links to. */
const manifest = kitFiles.concat("clawbits-brand-kit.zip").map((f) => ({
  file: f,
  bytes: statSync(join(BRAND, f)).size,
}));
mkdirSync(join(HERE, "..", "src", "generated"), { recursive: true });
writeFileSync(
  join(HERE, "..", "src", "generated", "brand-manifest.json"),
  JSON.stringify({ geo: GEO, files: manifest }, null, 2) + "\n",
);

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
console.log(`brand assets: ${files.length} generated, kit ${kb(statSync(join(BRAND, "clawbits-brand-kit.zip")).size)}`);
for (const m of manifest) console.log(`  ${m.file.padEnd(32)} ${kb(m.bytes)}`);
