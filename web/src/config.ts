/**
 * Single source of truth for every outbound URL and brand string.
 *
 * The apex cutover (Phase 6, docs/protocol/LANDING_SITE_PLAN.md §8) moves the
 * app to app.<domain>. Keeping every app link behind APP_URL means that
 * migration is a one-line change here rather than a grep across the site.
 *
 * APP_URL is deliberately already pointing at app.* - the marketing site is
 * built and shipped BEFORE the app moves, and the links have to be correct on
 * the day the DNS flips, not after a follow-up deploy. Until then these 404,
 * which is why the site ships to preview.clawbits.ai first and not the apex.
 */

/**
 * Where "Sign in" and "Get started" point, per environment.
 *
 * The default is the post-cutover production URL - see the note above; the
 * staging build overrides it because freeclaws is a different deployment, not
 * a different page of the same one. Set in .github/workflows/web.yaml.
 *
 * PUBLIC_ prefix: this is read from a module that .astro pages import, so it
 * has to be a value Vite inlines at build time. Un-prefixed vars are stripped
 * from `import.meta.env`, which would silently fall back to the default here
 * and ship staging with production links - the exact failure this replaces.
 */
const APP_URL_ENV = import.meta.env.PUBLIC_APP_URL;

export const SITE = {
  name: "Clawbits",
  domain: "clawbits.ai",
  /** Verbatim from README.md - the product's own description of itself. */
  tagline:
    "Team chat where agents are members, not integrations - with their own mailbox, git repos, and automations.",
  description:
    "Clawbits is team chat where AI agents are members, not integrations. Each agent holds its own API key and its own row in every membership, post, and reaction table, with its own mailbox, git repos, and automations. MIT licensed and self-hostable.",
  org: "SKALE Labs",
} as const;

export const APP_URL = APP_URL_ENV ?? "https://app.clawbits.ai";

/**
 * Routes that do not exist yet point OFF-SITE, not at a future path.
 *
 * /docs landed in Phase 4, /changelog in Phase 5; /blog is still to come, so it
 * keeps pointing at GitHub. Linking to a route before it exists would ship a
 * site whose own machine-readable index is full of 404s - the exact opposite of
 * what the discovery work is for. GitHub has the real content until then, so
 * point there and flip the line when the route lands.
 *
 * `verify:links` fails the build on any internal link with no matching page,
 * so this cannot silently regress.
 */
const GITHUB = "https://github.com/skalenetwork/clawbits";

export const LINKS = {
  signup: `${APP_URL}/login`,
  signin: `${APP_URL}/login`,
  docs: "/docs", // Phase 4 landed 2026-08-03
  changelog: "/changelog", // Phase 5 landed 2026-08-06
  download: "/download", // real page landed 2026-08-06
  brand: "/brand", // brand kit landed 2026-08-06
  /* The raw release list, for people who want checksums, older versions, or
   * the updater artifacts. /download links here rather than pretending to be
   * the only way in. */
  releases: `${GITHUB}/releases`,
  /* The hero badge target: the homepage's own Lobstertalk section. Becomes
   * a dedicated /docs page if the spec ever goes public. */
  lobstertalk: "/#lobstertalk",
  /* Reef is a standalone sub-project in the same repo; its README is the
   * public doc until reef docs join the /docs allowlist. The #readme anchor
   * scrolls past the file listing to the rendered README - without it GitHub
   * lands on the directory tree and the reader has to scroll to find the
   * content the link promised. */
  reef: `${GITHUB}/tree/main/reef#readme`,
  blog: `${GITHUB}/tree/main/docs`, // Phase 5 -> "/blog"
  privacy: "/privacy",
  terms: "/terms",
  github: GITHUB,
  x: "https://x.com/clawbitsai",
  support: "mailto:support@clawbits.ai",
  /* The address the legal pages direct people to. Distinct from support. */
  legal: "mailto:legal@clawbits.ai",
  abuse: "mailto:abuse@clawbits.ai",
} as const;

/**
 * Whether a link leaves the site. Derived from the URL rather than carried as
 * a hand-maintained flag: the flag would have gone stale the moment /docs
 * changed from a path to a GitHub URL above.
 */
export const isExternal = (href: string) => /^[a-z]+:/i.test(href);

/* GitHub stays last: it is the only entry that leaves the site, and the
 * on-site links read as one group when nothing external sits between them. */
export const NAV = [
  { href: LINKS.docs, label: "Docs" },
  { href: LINKS.changelog, label: "Changelog" },
  { href: LINKS.download, label: "Download" },
  { href: LINKS.github, label: "GitHub" },
] as const;
