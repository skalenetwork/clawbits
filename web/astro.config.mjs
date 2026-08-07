// @ts-check
import { defineConfig, fontProviders } from "astro/config";
import react from "@astrojs/react";
import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";
import { satteri } from "@astrojs/markdown-satteri";

// The apex is the marketing site; the app lives on app.<domain>. SITE is what
// canonical URLs, the sitemap, and absolute OG image URLs are built from, so it
// must be the real deployed origin - override per environment at build time.
const SITE = process.env.SITE_URL ?? "https://clawbits.ai";

export default defineConfig({
  site: SITE,

  // Fully static. NO adapter, deliberately.
  //
  // The plan originally kept @astrojs/cloudflare so a route could opt into
  // on-demand rendering later without a config migration. Measured, that was
  // the wrong trade: with output:"static" the adapter emits an EMPTY
  // dist/server, splits output into dist/client (breaking the obvious
  // assets.directory), and injects a `SESSION` KV binding that has to be
  // provisioned in Cloudflare before `wrangler deploy` will succeed - all to
  // serve a site with zero server-rendered routes.
  //
  // Everything planned through Phase 5 is static, including the Satori OG
  // images (prerendered at build time). Cloudflare Workers deploys static
  // assets with no Worker script at all.
  //
  // To reintroduce it the day an on-demand route genuinely exists:
  //   bunx astro add cloudflare
  //   -> then set wrangler.jsonc assets.directory to "./dist/client" and add
  //      "main": "@astrojs/cloudflare/entrypoints/server"
  output: "static",

  // The canonical form of every URL on this site ends in a slash.
  //
  // It already did, in the two places a crawler reads: `Astro.url.pathname`
  // gives the canonical in Base.astro a trailing slash, and @astrojs/sitemap
  // emits all 24 <loc>s with one. What did not agree was the site's own
  // markup - every internal href was written slash-less, so each of ~700 links
  // pointed at a URL that 307s to the one the page declares canonical.
  //
  // "always" rather than "never" because "always" is a no-op on what is
  // already emitted: build.format stays "directory", the canonicals and the
  // sitemap are unchanged, and Cloudflare's default auto-trailing-slash
  // already serves the slashed form at 200. "never" would have meant rewriting
  // all 24 sitemap entries and every canonical, and pinning a matching
  // `html_handling` in wrangler.jsonc - a two-file invariant nothing in CI
  // checks, where reverting either file silently points every canonical at a
  // redirect.
  //
  // The `/docs/<slug>.md` endpoints are file paths, not routes, and keep no
  // trailing slash.
  trailingSlash: "always",

  // No floating widget over the design while previewing - the owner reviews
  // the page in the dev server and the toolbar reads as part of the layout.
  devToolbar: { enabled: false },

  markdown: {
    // Syntax highlighting OFF, for two independent reasons.
    //
    // 1. Shiki emits inline styles, which the CSP above blocks - Astro warns
    //    about exactly this pairing, and the result would be unstyled code
    //    blocks plus console violations on every doc page.
    // 2. A syntax theme introduces six or seven hues. The art direction allows
    //    one accent, and a code block is not where to spend it.
    //
    // `pre` is styled by hand in Docs.astro instead: one tone, real contrast.
    syntaxHighlight: false,
    // Smart punctuation OFF. The protocol specs are quoted engineering text -
    // rewriting their straight quotes and hyphens would corrupt code samples
    // and header names. Same reasoning as the .astro legal pages.
    processor: satteri({ features: { smartPunctuation: false } }),
    // NB: no rehypePlugins here. Astro 7 defaults to the Rust Markdown
    // processor, and `markdown.rehypePlugins` would force the old unified
    // pipeline back in as an extra dependency. Cross-document link rewriting
    // happens in the content loader instead - see src/content.config.ts.
  },

  integrations: [
    // React exists for exactly one island: the GrainGradient hero/CTA shader
    // (@paper-design/shaders-react, client:only). Everything else stays plain
    // Astro with zero client JavaScript - do not add React to content sections.
    react(),
    sitemap({
      // The .txt and .png endpoints are machine surfaces, not pages a search
      // engine should list. robots.txt points crawlers at llms.txt directly.
      filter: (page) => !/\/(llms|llms-full)\.txt/.test(page),
    }),
  ],

  vite: {
    plugins: [tailwindcss()],

    server: {
      fs: {
        // The changelog collection and its hero images are read from
        // ../frontend/src/release-notes - outside this Astro root. Vite's dev
        // server blocks reads outside the root by default, so the collection
        // would load in `astro build` and 403 in `astro dev`.
        //
        // Scoped to that one folder rather than opening ".." (the whole repo,
        // .env.development included). The project root has to be listed
        // explicitly: setting `allow` REPLACES the default rather than adding
        // to it, and dropping the root breaks every normal import.
        allow: [".", "../frontend/src/release-notes"],
      },
    },
  },

  // Built-in Fonts API: downloads, caches, self-hosts, generates optimized
  // fallback metrics (kills hero CLS) and emits preload links. No @fontsource
  // dependency, unlike frontend/.
  //
  // ONE face for display and body, per the 2026-08-04 art direction: Geist
  // covers both, with its variable weight axis carrying the difference. The
  // scale leans on in-between weights (450/550), which only work because this
  // is served as a variable font. Do not replace the range with static
  // instances.
  fonts: [
    {
      provider: fontProviders.fontsource(),
      name: "Geist",
      cssVariable: "--ff-sans",
      weights: ["100 900"],
      subsets: ["latin"],
      styles: ["normal"],
      fallbacks: ["ui-sans-serif", "system-ui", "sans-serif"],
    },
    {
      provider: fontProviders.fontsource(),
      name: "Geist Mono",
      cssVariable: "--ff-mono",
      weights: ["400 500"],
      subsets: ["latin"],
      styles: ["normal"],
      fallbacks: ["ui-monospace", "monospace"],
    },
    {
      // The app's serif, used in ONE place: the hero demo's Home greeting -
      // the product's "one editorial moment" recreated faithfully.
      provider: fontProviders.fontsource(),
      name: "Fraunces",
      cssVariable: "--ff-serif",
      weights: ["400 600"],
      subsets: ["latin"],
      styles: ["normal"],
      fallbacks: ["ui-serif", "Georgia", "serif"],
    },
    {
      // The product's own UI face (frontend uses Inter Variable), scoped to
      // the hero demo window - the single biggest "feels like the real app"
      // lever after icon stroke width. Variable weights: the app leans on
      // 500/600 between the 400 body.
      provider: fontProviders.fontsource(),
      name: "Inter",
      cssVariable: "--ff-app",
      weights: ["100 900"],
      subsets: ["latin"],
      styles: ["normal"],
      fallbacks: ["ui-sans-serif", "system-ui", "sans-serif"],
    },
  ],

  // Auto-hashes inline scripts and styles into a real CSP.
  //
  // Stable since Astro 6, which means it lives under `security.csp` - NOT under
  // `experimental` (that errors) and NOT as a top-level `csp` key (Astro strips
  // unknown top-level keys SILENTLY, so it builds fine and emits nothing).
  //
  // script-src / style-src are deliberately absent from `directives`: Astro
  // manages those itself so it can inject the hashes it computes. An extra
  // HOST for script-src goes through `scriptDirective.resources` below, which
  // Astro merges with its hashes - writing "script-src ..." into `directives`
  // instead would fight it and drop every hash on the floor.
  security: {
    csp: {
      algorithm: "SHA-256",

      // The one third-party origin on this site: the Umami tracker (see the
      // ANALYTICS block in src/config.ts). 'self' must stay - Astro emits it by
      // default, and `resources` REPLACES that default rather than adding to
      // it, so dropping it here would block every bundled /_astro/*.js.
      scriptDirective: {
        resources: ["'self'", "https://cloud.umami.is"],
      },

      directives: [
        "default-src 'self'",
        "img-src 'self' data:",
        "font-src 'self'",
        // cloud.umami.is: the tracker POSTs pageviews to its /api/send. Without
        // it the script loads and every event is silently refused.
        "connect-src 'self' https://cloud.umami.is",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
      ],
    },
  },
});
