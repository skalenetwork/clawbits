/**
 * Desktop release metadata, fetched ONCE at build time.
 *
 * Same contract as getStarCount in ./github.ts and for the same reasons: the
 * site is static behind `connect-src 'self'`, so the browser can never ask
 * api.github.com itself. Version, sizes and dates are baked into the HTML and
 * refresh on every deploy. Fails to null, never throws - an offline build or a
 * rate-limited CI run ships /download with its GitHub fallback rather than
 * failing the deploy.
 *
 * WHY the files are served from GitHub rather than from this origin: releases
 * are already published there for the Tauri updater (latest.json points at
 * those exact URLs), GitHub serves them from its own CDN for free, and this
 * site deploys as static assets with no Worker to proxy bytes through.
 * Re-hosting on R2 would mean a second copy to keep in sync on every release
 * and a bandwidth bill, to save showing github.com in a download prompt - which
 * for an MIT-licensed app reads as provenance, not friction.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { LINKS } from "../config";

const REPO = new URL(LINKS.github).pathname.replace(/^\/|\/$/g, "");

/** One downloadable file, already matched to a platform. */
export interface Build {
  /** Stable key, also the CSS hook for platform auto-detection. */
  platform: "mac" | "linux";
  /** Button label, e.g. "macOS". */
  label: string;
  /** The qualifier under the label, e.g. "Universal - Apple silicon & Intel". */
  detail: string;
  /** Package format shown as a chip. The real file extension, lowercase -
   *  not a shouted acronym (owner: no uppercase on the page). */
  format: string;
  url: string;
  /** Human size, e.g. "18.0 MB". */
  size: string;
}

export interface DesktopRelease {
  /** Bare semver, tag `desktop-v0.20.0` -> "0.20.0". */
  version: string;
  /** The git tag verbatim, e.g. "desktop-v0.20.0". */
  tag: string;
  /** The release's own name, e.g. "Clawbits desktop-v0.20.0". */
  title: string;
  /** Short commit the release was built from, e.g. "75c9716". */
  sha: string;
  /** Release channel, from the body's "on channel <x>." - "prod" or "staging". */
  channel: string;
  /** ISO date of publication. */
  date: string;
  /** GitHub page for this specific release. */
  url: string;
  builds: Build[];
}

interface GhAsset {
  name: string;
  size: number;
  browser_download_url: string;
}
interface GhRelease {
  tag_name: string;
  name?: string | null;
  body?: string | null;
  target_commitish?: string;
  published_at: string;
  html_url: string;
  draft: boolean;
  prerelease: boolean;
  assets: GhAsset[];
}

/** 18019312 -> "18.0 MB". Decimal MB, which is what every OS download UI shows. */
function formatSize(bytes: number): string {
  const mb = bytes / 1_000_000;
  return mb >= 100 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
}

/**
 * Match an asset to a human-installable build.
 *
 * Returns null for the three updater artifacts in every release -
 * `Clawbits.app.tar.gz`, its `.sig`, and `latest.json`. Those exist for the
 * Tauri updater and are actively wrong for a person to click: the tarball is
 * not a mountable installer, and offering it would produce a bug report per
 * download. Allow-list by matching, never deny-list by name.
 */
function toBuild(asset: GhAsset): Build | null {
  const n = asset.name;
  const common = { url: asset.browser_download_url, size: formatSize(asset.size) };

  if (n.endsWith(".dmg")) {
    return {
      platform: "mac",
      label: "macOS",
      // The build is genuinely universal (one binary, both architectures), so
      // this page needs no Apple-silicon/Intel picker. Do not add one without
      // checking tauri.conf.json - it would be a choice with no difference.
      detail: "Universal - Apple silicon & Intel",
      format: ".dmg",
      ...common,
    };
  }
  if (n.endsWith(".deb")) {
    return {
      platform: "linux",
      label: "Debian / Ubuntu",
      detail: "x86_64",
      format: ".deb",
      ...common,
    };
  }
  if (n.endsWith(".AppImage")) {
    return {
      platform: "linux",
      // Not "Linux (AppImage)": the chip beside it already says .AppImage, and
      // the parenthetical wrapped to two lines at 375px, breaking the row's
      // square badge alignment. "Other Linux" distinguishes it from the .deb
      // row above without repeating the format.
      label: "Other Linux",
      detail: "Portable, x86_64",
      format: ".AppImage",
      ...common,
    };
  }
  return null;
}

/**
 * Where a release came from, read out of its own body.
 *
 * The desktop pipeline writes exactly one line:
 *
 *   Built from skalenetwork/clawbits@<40-hex> on channel prod.
 *
 * so both facts are parseable rather than guessed. `target_commitish` is the
 * fallback for the sha because GitHub sets it to the full commit for a release
 * cut from a tag - but it is a BRANCH NAME for releases cut from a branch, so
 * it is only trusted when it looks like a sha. `channel` falls back to "prod":
 * this function only ever sees non-prerelease releases.
 */
function provenance(rel: GhRelease): { sha: string; channel: string } {
  const body = rel.body ?? "";
  const fromBody = body.match(/@([0-9a-f]{7,40})\b/)?.[1];
  const fromTarget = /^[0-9a-f]{7,40}$/.test(rel.target_commitish ?? "")
    ? rel.target_commitish
    : undefined;
  return {
    sha: (fromBody ?? fromTarget ?? "").slice(0, 7),
    channel: body.match(/on channel ([a-z0-9-]+)/i)?.[1] ?? "prod",
  };
}

let cached: Promise<DesktopRelease | null> | undefined;

export function getDesktopRelease(): Promise<DesktopRelease | null> {
  cached ??= (async () => {
    try {
      // The LIST endpoint, not /releases/latest. Two reasons: the desktop
      // pipeline publishes `-staging.<sha>` prereleases constantly, and the
      // repo also runs semantic-release for the app itself - so the single
      // "latest" release is not guaranteed to be a desktop one. Pick the
      // newest published release that actually carries installable assets.
      const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=30`, {
        headers: {
          "User-Agent": "clawbits-web-build",
          Accept: "application/vnd.github+json",
        },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return null;

      const list = (await res.json()) as GhRelease[];
      if (!Array.isArray(list)) return null;

      for (const rel of list) {
        if (rel.draft || rel.prerelease) continue;
        const builds = (rel.assets ?? [])
          .map(toBuild)
          .filter((b): b is Build => b !== null)
          // Stable order regardless of how GitHub returns them: mac first
          // (dominant desktop audience), then Linux, .deb before AppImage.
          .sort((a, b) => {
            const rank = (x: Build) =>
              x.platform === "mac" ? 0 : x.format === ".deb" ? 1 : 2;
            return rank(a) - rank(b);
          });
        if (builds.length === 0) continue;

        return {
          version: rel.tag_name.replace(/^desktop-v?/, "").replace(/^v/, ""),
          tag: rel.tag_name,
          title: rel.name?.trim() || `Clawbits ${rel.tag_name}`,
          ...provenance(rel),
          date: rel.published_at,
          url: rel.html_url,
          builds,
        };
      }
      return null;
    } catch {
      return null;
    }
  })();
  return cached;
}

/* ── The version the demos print ──────────────────────────────────────────
 *
 * The hero's chat transcript talks about a desktop release by number, and the
 * message carries the GitHub link preview for that exact release. Both were
 * literals ("v0.17.0", "d867eb5") and went stale three releases later, while
 * /download - which reads GitHub - kept saying something else on the same page.
 *
 * One build-time source now feeds all of it. getDesktopRelease() is already
 * module-cached, so this costs no extra request however many components ask.
 */

/** What the demos need, with every field guaranteed present. */
export interface DesktopFacts {
  version: string;
  tag: string;
  title: string;
  sha: string;
  channel: string;
  /** The release page, or the releases index when the fetch failed. */
  url: string;
  /** False when GitHub could not be reached and this is the local fallback. */
  live: boolean;
}

/**
 * The fallback version: the one this working tree is ON.
 *
 * Read from desktop/package.json rather than written here as a literal, so the
 * value cannot rot - scripts/bump_version.py already keeps that file current,
 * and it is the same number the pipeline will tag. Only ever reached when the
 * build cannot talk to api.github.com (offline, or rate-limited CI).
 *
 * node:fs, not a JSON import: the file lives outside the Astro root, and an
 * import would need it added to vite.server.fs.allow to survive `astro dev`.
 */
function localDesktopVersion(): string {
  try {
    const pkg = fileURLToPath(new URL("../../../desktop/package.json", import.meta.url));
    const version = JSON.parse(readFileSync(pkg, "utf8")).version;
    return typeof version === "string" ? version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export async function getDesktopFacts(): Promise<DesktopFacts> {
  const rel = await getDesktopRelease();
  if (rel) return { ...rel, live: true };
  const version = localDesktopVersion();
  return {
    version,
    tag: `desktop-v${version}`,
    // The same composition the pipeline uses for the release name, so the
    // fallback lockup reads exactly like the live one.
    title: `Clawbits desktop-v${version}`,
    // No sha to show without the release. The lockup drops the line rather
    // than inventing one - see AppDemo's link preview.
    sha: "",
    channel: "prod",
    url: `${LINKS.github}/releases/latest`,
    live: false,
  };
}
