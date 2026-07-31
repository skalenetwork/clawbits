// Release-notes loader. Each prod release is one markdown file under
// ``src/release-notes/<version>.md`` (see that folder's README). Files are
// bundled at build time, so the newest entry always describes the deployed
// build — no version endpoint or build-time injection needed.

export interface Release {
  /** "1.4.0" — matches the prod semantic-release tag; the modal dedupes on it. */
  version: string;
  /** ISO date string from frontmatter, or null. */
  date: string | null;
  /** Optional headline from frontmatter. */
  title: string | null;
  /** Markdown body (the user-facing change list). */
  body: string;
  /** Bundled URL of the optional ``<version>.png`` hero image, or null. */
  image: string | null;
}

// Eagerly slurp every markdown file in the folder as a raw string.
const rawFiles = import.meta.glob<string>("../release-notes/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
});

// Optional hero images: a ``<version>.webp`` next to the markdown is shown at
// the top of the modal for that release. Bundled as asset URLs.
const imageFiles = import.meta.glob<string>("../release-notes/*.webp", {
  query: "?url",
  import: "default",
  eager: true,
});

// Only files named like a version are releases — README.md / drafts are skipped.
const VERSION_FILE_RE = /\/(\d+\.\d+\.\d+)\.md$/;
const VERSION_IMAGE_RE = /\/(\d+\.\d+\.\d+)\.webp$/;

const IMAGES_BY_VERSION: Record<string, string> = {};
for (const [path, url] of Object.entries(imageFiles)) {
  const version = VERSION_IMAGE_RE.exec(path)?.[1];
  if (version) IMAGES_BY_VERSION[version] = url;
}

/** Parse a leading ``---\nkey: value\n---`` frontmatter block. Tiny on
 *  purpose — no YAML dependency; values are treated as plain strings. */
function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
  if (!m) return { meta: {}, body: raw.trim() };
  const meta: Record<string, string> = {};
  for (const line of (m[1] ?? "").split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
    if (key) meta[key] = val;
  }
  return { meta, body: raw.slice(m[0].length).trim() };
}

/** Compare two ``a.b.c`` versions numerically. Returns >0 when ``a`` is newer. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** All releases, newest first. */
export const RELEASES: Release[] = Object.entries(rawFiles)
  .map(([path, raw]): Release | null => {
    const match = VERSION_FILE_RE.exec(path);
    const version = match?.[1];
    if (!version) return null;
    const { meta, body } = parseFrontmatter(raw);
    return {
      version,
      date: meta.date ?? null,
      title: meta.title ?? null,
      body,
      image: IMAGES_BY_VERSION[version] ?? null,
    };
  })
  .filter((r): r is Release => r !== null)
  .sort((a, b) => compareVersions(b.version, a.version));

export const LATEST_RELEASE: Release | undefined = RELEASES[0];
