/**
 * Single source of truth for every outbound URL and brand string.
 *
 * The apex cutover (Phase 6 of the landing site plan, which lives in the
 * private clawbits-internal repo) moves the app to app.<domain>. Keeping every
 * app link behind APP_URL means that migration is a one-line change here rather
 * than a grep across the site.
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
  /**
   * The long-form description. Used where there is no length budget and the
   * reader is a machine that benefits from specificity: the JSON-LD graph,
   * llms.txt, and the /brand boilerplate a human copies into a press page.
   */
  description:
    "Clawbits is team chat where AI agents are members, not integrations. Each agent holds its own API key and its own row in every membership, post, and reaction table, with its own mailbox, git repos, and automations. MIT licensed and self-hostable.",
  /**
   * The `<meta name="description">` / og:description string. 155 characters.
   *
   * `description` above is 246, and a search result shows roughly 155-160. It
   * was being cut mid-clause at "every membership, post, and reac..." - so the
   * snippet spent its whole budget on a database detail and never reached
   * "MIT licensed and self-hostable", which is the line most likely to make
   * someone click. Same three facts, ordered so the truncation point falls
   * after them rather than through them.
   */
  metaDescription:
    "Team chat where AI agents are members, not integrations. Each agent gets its own API key, mailbox, git repos, and automations. MIT licensed, self-hostable.",
  org: "SKALE Labs",
} as const;

export const APP_URL = APP_URL_ENV ?? "https://app.clawbits.ai";

/**
 * Hosts whose traffic is counted. ONE Umami website spans both.
 *
 * A separate website per property was the obvious split and the wrong one: the
 * question this analytics exists to answer is "how many people who read the
 * landing page went on to sign up", and Umami can only join those two pageviews
 * into a funnel when they share a website ID. Split across two IDs, the app
 * shows up as a referral that leads nowhere and the landing page as traffic that
 * goes nowhere. Umami records the hostname on every event, so the marketing
 * numbers are still one filter away when you want them alone.
 *
 * `clawbits.ai` is the marketing site only AFTER the Phase 6 apex cutover
 * (landing site plan, Phase 6). Until then it is the app, which reports to this
 * same website ID from frontend/src/components/Analytics.tsx - so the funnel exists
 * from the day the DNS flips, with no third deploy to remember.
 */
const ANALYTICS_HOSTS: readonly string[] = ["clawbits.ai", "app.clawbits.ai"];

/**
 * Umami, cookieless, shared with the app.
 *
 * NO COOKIE BANNER RESTS ON THIS STAYING COOKIELESS. What triggers ePrivacy
 * Art. 5(3) consent is reading or writing storage on the device, not analytics
 * as such. Umami writes no cookie and no localStorage entry, so there is
 * nothing to consent to - which is exactly the basis /privacy section 9 states.
 * Adding a second analytics script, or turning on anything here that persists
 * an identifier, puts a banner on every page of this site. Revisit
 * src/pages/privacy.astro (section 9 and the subprocessor table) first.
 *
 * `websiteId` is deliberately the same literal as
 * frontend/src/components/Analytics.tsx:20. The two sites build and ship
 * independently and share no module, so this is a copy by necessity - change
 * one, change the other, or the funnel silently splits in half.
 *
 * `data-domains` is the belt: the tracker matches it against
 * `window.location.hostname` and does not run at all anywhere else. That is
 * what keeps preview.clawbits.ai, preview.freeclaws.ai, *.workers.dev and
 * localhost out of the numbers even when the tag reaches them.
 */
export const ANALYTICS = {
  /** Also has to be in astro.config.mjs's `scriptDirective` + `connect-src`. */
  scriptUrl: "https://cloud.umami.is/script.js",
  websiteId: "3b3f10a0-3d8a-4196-b692-1442deded2d9",
  hosts: ANALYTICS_HOSTS,
} as const;

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

/*
 * INTERNAL PATHS END IN A SLASH.
 *
 * That is the canonical form the site declares (Base.astro builds canonicals
 * from Astro.url.pathname) and the form @astrojs/sitemap submits, and
 * astro.config.mjs pins it with trailingSlash: "always". A slash-less href here
 * is not cosmetic: it makes every link on the site a 307 to the URL the page
 * itself calls canonical, which spends crawl budget and splits internal link
 * equity across two forms of the same page.
 */
export const LINKS = {
  signup: `${APP_URL}/login`,
  signin: `${APP_URL}/login`,
  docs: "/docs/", // Phase 4 landed 2026-08-03
  changelog: "/changelog/", // Phase 5 landed 2026-08-06
  download: "/download/", // real page landed 2026-08-06
  brand: "/brand/", // brand kit landed 2026-08-06
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
  privacy: "/privacy/",
  terms: "/terms/",
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

/**
 * Absolute canonical URL for an internal route.
 *
 * Every JSON-LD `@id` and `url` must be byte-identical to the
 * `<link rel="canonical">` in the same document. When they differ only by a
 * trailing slash a crawler is being told, in two machine-readable formats on
 * one page, that there are two URLs for it - which is the ambiguity `@id` and
 * `canonical` both exist to remove.
 *
 * Four pages built these by hand with `new URL("/docs", Astro.site)` and drifted
 * exactly that way. Route them all through here instead: the slash is added
 * once, in one place, and cannot be forgotten at the twenty-first call site.
 */
export const canonicalUrl = (pathname: string, site: URL | undefined) =>
  new URL(pathname.endsWith("/") ? pathname : `${pathname}/`, site).href;

/* GitHub stays last: it is the only entry that leaves the site, and the
 * on-site links read as one group when nothing external sits between them. */
export const NAV = [
  { href: LINKS.docs, label: "Docs" },
  { href: LINKS.changelog, label: "Changelog" },
  { href: LINKS.download, label: "Download" },
  { href: LINKS.github, label: "GitHub" },
] as const;
