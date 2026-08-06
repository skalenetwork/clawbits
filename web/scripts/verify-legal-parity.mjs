#!/usr/bin/env node
/**
 * Legal parity gate.
 *
 * /privacy and /terms are ports of the SPA pages at
 * frontend/src/pages/{Privacy,Terms}Page.tsx. Those are operative legal
 * documents, so the port has to be word-for-word - a paraphrase introduced by
 * a well-meaning edit is a change to a contract.
 *
 * This compares the visible words of the built marketing page against the
 * visible words of the TSX source and exits non-zero on any difference.
 *
 * Scope is the legal text proper: the intro paragraph, every section title,
 * and every section body. Page chrome differs by design (the SPA has
 * SiteHeader, the marketing site has its own nav and footer) and is excluded.
 *
 * Usage:  bun run build && bun run verify:legal
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, "..");
const REPO = join(WEB, "..");

const PAGES = [
  {
    name: "privacy",
    tsx: join(REPO, "frontend/src/pages/PrivacyPage.tsx"),
    html: join(WEB, "dist/privacy/index.html"),
  },
  {
    name: "terms",
    tsx: join(REPO, "frontend/src/pages/TermsPage.tsx"),
    html: join(WEB, "dist/terms/index.html"),
  },
];

const ENTITIES = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#34;": '"',
  "&apos;": "'",
  "&#39;": "'",
  "&nbsp;": " ",
  "&middot;": "·",
  "&copy;": "©",
  "&mdash;": "—",
  "&ndash;": "–",
};

function decodeEntities(s) {
  let out = s;
  for (const [k, v] of Object.entries(ENTITIES)) out = out.split(k).join(v);
  return out.replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
}

/** Visible words, whitespace- and markup-insensitive. */
function words(s) {
  return decodeEntities(s)
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

function stripTags(s) {
  // Space, not empty: <strong>not</strong> sell must not become "notsell".
  // Word-joining across a tag boundary is exactly the bug this gate exists to
  // catch, so erring toward a space here and normalizing after is correct.
  return s.replace(/<[^>]*>/g, " ");
}

// ── source of truth: the TSX ────────────────────────────────────────────────

function extractFromTsx(file) {
  const src = readFileSync(file, "utf8");

  const start = src.indexOf("const SECTIONS: Section[] = [");
  const end = src.indexOf("\n];", start);
  if (start === -1 || end === -1) {
    throw new Error(`${file}: could not locate the SECTIONS array`);
  }
  const sectionsBlock = src.slice(start, end);

  // Titles, in document order.
  const titles = [...sectionsBlock.matchAll(/^\s*title: "(.*)",$/gm)].map(
    (m) => m[1],
  );
  if (!titles.length) throw new Error(`${file}: no section titles found`);

  const ids = [...sectionsBlock.matchAll(/^\s*id: "(.*)",$/gm)].map((m) => m[1]);

  // The intro paragraph lives in the component, in the first block after the
  // <h1>/date header. Grab the paragraph that mentions the operating company.
  const introMatch = src.match(
    /<div className="mt-10 space-y-4[^"]*">\s*<p>([\s\S]*?)<\/p>/,
  );
  if (!introMatch) throw new Error(`${file}: could not locate the intro paragraph`);

  // JSX -> text. {" "} is an explicit space; any other brace expression in
  // these files would be dynamic content and must not appear in legal copy.
  const jsxToText = (jsx) => {
    const leftovers = jsx.replace(/\{" "\}/g, " ").match(/\{[^}]*\}/g);
    if (leftovers) {
      throw new Error(
        `${file}: unexpected JSX expression in legal copy: ${leftovers[0]}`,
      );
    }
    return words(stripTags(jsx.replace(/\{" "\}/g, " ")));
  };

  // Bodies, in document order. Each is `body: (` ... `),`.
  const bodies = [...sectionsBlock.matchAll(/body: \(([\s\S]*?)\n {4}\),/g)].map(
    (m) => m[1],
  );
  if (bodies.length !== titles.length) {
    throw new Error(
      `${file}: ${titles.length} titles but ${bodies.length} bodies - the regex is out of step with the file`,
    );
  }

  const out = [...jsxToText(introMatch[1])];
  titles.forEach((t, i) => {
    out.push(...words(t), ...jsxToText(bodies[i]));
  });
  return { words: out, ids };
}

// ── the port: built HTML ────────────────────────────────────────────────────

function extractFromHtml(file) {
  if (!existsSync(file)) {
    throw new Error(`${file} missing - run \`bun run build\` first`);
  }
  const html = readFileSync(file, "utf8");

  const grab = (cls) => {
    const i = html.indexOf(`class="${cls}`);
    if (i === -1) throw new Error(`${file}: no .${cls} block`);
    const open = html.lastIndexOf("<", i);
    // Walk tags to find this element's matching close.
    const tag = html.slice(open + 1, html.indexOf(" ", open));
    let depth = 0;
    const re = new RegExp(`<${tag}\\b|</${tag}>`, "g");
    re.lastIndex = open;
    let m;
    while ((m = re.exec(html))) {
      depth += m[0].startsWith("</") ? -1 : 1;
      if (depth === 0) return html.slice(open, m.index);
    }
    throw new Error(`${file}: unbalanced <${tag}> around .${cls}`);
  };

  // The index repeats every section title; it is navigation, not the document,
  // so it is excluded from the word comparison. Its links ARE checked against
  // the section ids below.
  const ids = [...html.matchAll(/<section id="([a-z-]+)"/g)].map((m) => m[1]);
  const tocHrefs = [...grab("toc").matchAll(/href="#([a-z-]+)"/g)].map(
    (m) => m[1],
  );

  return {
    words: [
      ...words(stripTags(grab("intro"))),
      ...words(stripTags(grab("prose"))),
    ],
    ids,
    tocHrefs,
  };
}

// ── compare ─────────────────────────────────────────────────────────────────

let failed = 0;

for (const page of PAGES) {
  let src, out;
  try {
    src = extractFromTsx(page.tsx);
    out = extractFromHtml(page.html);
  } catch (err) {
    console.error(`✗ ${page.name}: ${err.message}`);
    failed++;
    continue;
  }
  const expected = src.words;
  const actual = out.words;

  // Anchors are part of the contract too: people and other sites link to
  // /privacy#rights. A renamed or reordered id silently breaks those links.
  if (src.ids.join(",") !== out.ids.join(",")) {
    failed++;
    console.error(`✗ ${page.name}: section anchors differ from the TSX source`);
    console.error(`      source: ${src.ids.join(", ")}`);
    console.error(`      page:   ${out.ids.join(", ")}`);
  }

  // The index is generated from the same object as the sections, so a mismatch
  // means that invariant has been broken.
  if (out.tocHrefs.join(",") !== out.ids.join(",")) {
    failed++;
    console.error(
      `✗ ${page.name}: "On this page" links do not match the sections in document order`,
    );
    console.error(`      index:    ${out.tocHrefs.join(", ")}`);
    console.error(`      sections: ${out.ids.join(", ")}`);
  }

  const diffs = [];
  const n = Math.max(expected.length, actual.length);
  for (let i = 0; i < n && diffs.length < 10; i++) {
    if (expected[i] !== actual[i]) {
      diffs.push({
        at: i,
        context: expected.slice(Math.max(0, i - 6), i).join(" "),
        expected: expected[i] ?? "(end of document)",
        actual: actual[i] ?? "(end of document)",
      });
      break; // one desync makes every later index meaningless
    }
  }

  if (diffs.length === 0 && expected.length === actual.length) {
    console.log(`✓ ${page.name}: ${expected.length} words match the TSX source`);
    continue;
  }

  failed++;
  console.error(
    `✗ ${page.name}: source has ${expected.length} words, page has ${actual.length}`,
  );
  for (const d of diffs) {
    console.error(`    at word ${d.at}, after: "...${d.context}"`);
    console.error(`      source: ${d.expected}`);
    console.error(`      page:   ${d.actual}`);
  }
}

if (failed) {
  console.error(
    `\n${failed} legal page(s) diverge from the SPA source. These are operative documents - reconcile before shipping.`,
  );
  process.exit(1);
}
console.log("\nLegal parity verified.");
