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
  /** Bare semver, tag `desktop-v0.17.0` -> "0.17.0". */
  version: string;
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
