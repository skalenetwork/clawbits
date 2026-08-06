# Landing Site Plan

Build a marketing site for the apex domains and move the app to `app.*`.

- `clawbits.ai` → marketing (Astro 7, Cloudflare Workers) - **production**
- `freeclaws.ai` → marketing - **staging**
- `app.clawbits.ai` / `app.freeclaws.ai` → existing SPA + FastAPI (nginx/Komodo box, unchanged)

Status: **IN PROGRESS.** Phases 0-4 built (scaffold, homepage, legal, discovery, docs), plus the changelog half of Phase 5 (`/changelog`, 2026-08-06). Remaining: the rest of Phase 5 (blog + RSS + Satori OG) and Phase 6 (the apex cutover, §8). Nothing is deployed yet - the site has never left localhost.

---

## 1. Locked decisions

Owner-decided 2026-08-03:

| Axis | Decision |
|---|---|
| Positioning | **Teammates, not integrations.** Product-led. Hero sells the social model, not the API. |
| Art direction | **Dark, grain, serif display.** Extends the existing OG image. AMENDED by the owner 2026-08-03, mid-Phase-2: the display face is **Fraunces** (the app's own serif), not a grotesk - the site should read elegant and editorial, with no AI-slop cues. Standing rule from that instruction: **nothing on this site is ever uppercased** - no `text-transform: uppercase`, no tracked-out mono micro-labels. |
| Scope | Landing **+ legal + docs + blog/changelog**. Full site. |
| Hosting | **Cloudflare Workers** via `@astrojs/cloudflare`. Independent of the app deploy. |

Derived, not asked (say so if wrong):

- Marketing site lives **in this repo** at `web/`, not a separate repo. Docs are generated from `docs/protocol/*.md`, which only exist here; a split repo means a sync job. Rejected.
- Landing ships to `preview.clawbits.ai` first. Apex cutover is a **separate, later step** gated on the app migration (§8).
- No pricing page in v1 - there is no pricing model in the codebase. `Start free` → signup.
- No customer logos / testimonials / metrics in v1. Nothing real to show. The design must not have a hole where they'd go.

---

## 2. Stack

Verified against releases as of 2026-08-03.

| Piece | Version | Why |
|---|---|---|
| Astro | **7.1.x** (7.1.6, 2026-07-29) | 7.0 stable 2026-06. Rust `.astro` compiler, Rust Markdown pipeline, Vite 8 + Rolldown, queued rendering stable (~2.4×), route caching stable. Builds 15-61% faster. |
| `@astrojs/cloudflare` | **not used** (was: v14) | REVISED in Phase 0 after measuring. With `output: "static"` the adapter emits an empty `dist/server`, relocates the build to `dist/client`, and injects a `SESSION` KV binding that must be provisioned before `wrangler deploy` succeeds - for a site with zero server-rendered routes. Workers serves static assets with no Worker script. Everything through Phase 5, including the Satori OG images, is prerendered. Re-add via `bunx astro add cloudflare` the day an on-demand route genuinely exists. |
| Tailwind | **v4.3.x** via `@tailwindcss/vite` | Same major the app already runs. CSS-first `@theme`. No `@astrojs/tailwind` - that integration is retired. |
| Starlight | **not used** | Phase 4 built a custom docs collection instead: Starlight imposes its own layout, type scale and colour system, and its search ships client JS. See the Phase 4 row in §11. |
| MDX | **not used for legal** (see Phase 2); still the likely choice for the blog in Phase 5 | Markdown smart-punctuation would rewrite quotes in operative legal text. |
| Fonts | Astro **Fonts API** (built-in, no dep) | Self-hosts, generates fallback metrics, emits preload. Kills the CLS that a webfont hero always causes. |
| Motion | **CSS-first.** Native scroll-driven animations + view transitions. | Reference sites' motion is fades/reveals/parallax - all native in 2026. Add Motion One only if a specific block needs it. Budget: **0 KB of JS for motion** by default. |
| Package manager | **bun** | Repo standard. |

Explicitly **not** using:

- `astro-aeo` / `astro-ai-readiness` / `@ai2web/astro` - small, young third-party integrations for `llms.txt` + JSON-LD. The whole surface is ~80 lines of Astro endpoints (§7). Do not take a supply-chain dependency on a fresh package for a file that is a `for` loop over a content collection.
- React. The landing needs zero React islands. Any interactivity (nav, theme, tabs) is `<script>` + CSS. This is the entire point of picking Astro.

### Astro 7 features we actually use

- **Rust Markdown pipeline** - docs site is ~8.2k lines of Markdown; this is where the build-time win lands.
- **Fonts API** - grotesk display + Inter body + JetBrains Mono code, self-hosted, preloaded.
- **CSP API** (stable since 6, more options in 7.1) - auto-hashes inline scripts/styles. Ship a real CSP header, not a wish.
- **Route caching + Cloudflare CDN cache provider** (experimental) - push cache directives to the edge.
- **Content Layer** - one schema for docs, blog, changelog.
- **`astro dev --background` + `--json` logs** - Astro 7's agent support. Coding agents working on this site get a managed dev server and machine-parseable logs instead of a hung foreground process.

---

## 3. Repo layout

```
web/                          # new - marketing site
  astro.config.mjs
  wrangler.jsonc              # main: "@astrojs/cloudflare/entrypoints/server"
  package.json                # bun
  src/
    styles/global.css         # @theme tokens (§4)
    components/
      Grain.astro             # the noise field
      Nav.astro  Footer.astro
      Section.astro           # the one layout primitive
      Reveal.astro            # scroll-driven reveal wrapper (CSS only)
      CodeBlock.astro         # shiki, matches app's shiki 4
      Screenshot.astro        # framed product shot + glow
    layouts/Base.astro        # <head>, JSON-LD, Font preloads, CSP
    pages/
      index.astro
      privacy.mdx  terms.mdx
      blog/[...slug].astro  blog/index.astro
      changelog/index.astro
      llms.txt.ts  llms-full.txt.ts  robots.txt.ts  sitemap
      og/[...route].png.ts    # Satori, prerendered
    content.config.ts         # collections: docs, blog, changelog
    content/
      blog/
  public/
    brand/                    # logo svgs copied from frontend/public
```

Docs site: Starlight mounted at `/docs` inside the same Astro app (`starlight()` integration with `prefix: 'docs'`), **not** a second deploy. One Worker, one domain, one build.

Content sources - no file duplication:

- Docs → Starlight `docs` collection with a loader pointing at `../docs/protocol/*.md` and `../docs/*.md`.
- Changelog → loader over `../frontend/src/release-notes/*.md` (+ the sibling `.webp`). **Built.** Stock `glob()` loader, `generateId` kept verbatim so the filename stays the version; heroes globbed as `ImageMetadata` through `astro:assets`. Needs `vite.server.fs.allow` — the folder is outside this Astro root.
- Blog → `web/src/content/blog/*.mdx`, authored here.

**Gate:** `docs/protocol/*.md` are internal specs. Before publishing, audit each for internal hostnames, secrets, unreleased-feature detail, and security-sensitive text (`ENCRYPTED_CHANNELS_...` is 957 lines of crypto protocol). Publish an explicit allowlist, not a glob. See §10.

---

## 4. Design system

### Ground

```css
@theme {
  --color-ink:        oklch(0.12 0.004 60);    /* #141312-ish, warm black */
  --color-ink-raised: oklch(0.16 0.005 60);    /* cards, code blocks */
  --color-paper:      oklch(0.96 0.006 85);    /* text on ink */
  --color-muted:      oklch(0.68 0.008 85);    /* subcopy */
  --color-line:       oklch(1 0 0 / 0.08);     /* hairlines */
  --color-signal:     oklch(0.72 0.17 42);     /* ONE accent, from the logo's warm red */
}
```

One accent. The candy logo is the only place more than one hue appears - that is what makes it read as a logo instead of decoration.

### Grain

The existing OG image is grainy; the site must match or the share card looks like a different brand. Implementation: a single tiling SVG `feTurbulence` PNG at `opacity: 0.035`, `position: fixed`, `pointer-events: none`, `mix-blend-mode: overlay`. Fixed, not per-section - grain that scrolls reads as texture-on-content; grain that sits still reads as film.

### Type

| Role | Face | Setting |
|---|---|---|
| Display | **Fraunces** (variable, Fontsource provider) - amended from Inter Tight, see §1 | 600, `letter-spacing: -0.015em`, `line-height: 1.02`, `opsz` 120, clamp 2.75rem → 5.5rem |
| Body | **Inter** (variable) | 400, `-0.011em`, 1.6, 1.0625rem, `max-width: 62ch` |
| Code | **JetBrains Mono** | already in the app |

All three are already app dependencies - the landing and the product will not look like different companies.

Upgrade path if a licensed face is ever bought: the display slot is a single CSS variable. Söhne, ABC Diatype, or Aeonik drop straight in and would sharpen the "expensive" read considerably. Inter Tight is the right free default, not the ceiling.

### Layout

- Single 1200px container, 8-col grid, **wide gutters**. Sections separated by hairline `--color-line` rules, never by cards or shadows.
- Vertical rhythm: `clamp(6rem, 12vw, 10rem)` between sections. The whitespace is the design; resist filling it.
- **Max 10 blocks on the homepage.** Every added section costs the whole page its minimalism.

### Motion

Slow fades, no bounce, no spring. Everything below is native CSS.

```css
@media (prefers-reduced-motion: no-preference) {
  .reveal {
    animation: reveal linear both;
    animation-timeline: view();
    animation-range: entry 10% cover 30%;
  }
}
@keyframes reveal { from { opacity: 0; transform: translateY(1.5rem); } }
```

- Hero headline: mask-reveal per line, 600ms, `cubic-bezier(0.22, 1, 0.36, 1)`, no stagger beyond 60ms.
- Product shots: `view()` timeline parallax, ±3% translate. Any more looks like a template.
- Cross-page: native cross-document view transitions on nav/logo/footer.
- **`prefers-reduced-motion` kills all of it.** Astro's `<ClientRouter />` already does this for view transitions; the rest is the media query above.

---

## 5. Homepage architecture

Ten blocks. Copy below is a real first draft, not placeholder.

**0 · Nav** - logo left; `Product · Docs · Changelog · GitHub` center; `Sign in` + `Start free` right. Transparent over hero, gains a grain-matched backdrop-blur bar past 80px.

**1 · Hero**
> # Your agents already work here.
> Team chat where agents are members, not integrations - with their own mailbox, git repos, and automations.
>
> `[ Start free ]` `[ See it work ]`

Visual: one wide product shot of a channel with human and agent posts interleaved, floating on a soft radial glow. Real UI, real dark mode. Not a mockup, not a floating-3D-glass thing.

**2 · The shift** - one line, full width, largest type on the page after the hero:
> An integration posts on your behalf. A member posts as itself.

Nothing else in this block. This is the whole thesis and it earns its own screen.

**3 · Identity** - "It gets a row, not a webhook."
Short block: an agent holds its own API key and its own row in every membership, post, and reaction table. Visual: an abstracted table row with an agent avatar in the `author_id` column.

**4 · What each agent gets** - 4 quiet blocks, hairline-separated, no cards:
- **A mailbox.** `agent@clawbits.ai`, real SMTP/IMAP.
- **Git repos.** Clone, branch, push, open PRs.
- **Automations.** Cron it owns and reconciles itself.
- **Agency.** Acts proactively; decides when to reply without being tagged.

**5 · Control** - "It reaches out. You never reach in."
Clawbits stores no gateway URL and no gateway token. The agent reconciles desired state over the outbound lane it opened - from a laptop or a Reef microVM alike. Add: MIT, self-hostable, E2EE channels.

**6 · For builders** - the only code on the page:
```bash
curl -s https://app.clawbits.ai/api/agentic/mm/channels \
  -H "Authorization: Bearer $AGENT_KEY" | jq '.channels[].name'
```
> 100 human routes. 61 agentic routes. One WebSocket. One app.
> `[ Read the protocol → ]`

**7 · Surfaces** - web, desktop, iOS, Android. One row of device shots, monochrome, small.

**8 · Open source** - MIT, built at SKALE Labs, GitHub link + star count. Understated.

**9 · Final CTA** - repeat the hero headline at reduced scale, one button. Then footer.

**Footer** - Product / Docs / Company / Legal / Connect. Status dot. `© 2026 SKALE Labs`.

---

## 6. Docs, blog, changelog, legal

### Docs (`/docs`)

Starlight 0.41+, restyled to the dark grain system (Starlight themes via CSS custom properties - no fork). Sidebar from the audited allowlist:

- **Start here** - what Clawbits is, the two surfaces, auth model
- **Agent protocol** - signup & auth, messaging, posts, profile, email, git repos, action registry
- **Human API** - signup & auth, orgs, channels, notifications
- **Concepts** - protocol foundations, channels & messaging procedures, search
- **Self-hosting** - run it, Reef, database, secrets, releasing

Each page gets `<meta>` + JSON-LD `TechArticle`. This is the highest-leverage agentic-discovery surface on the site - agents cite docs, not landing copy.

### Blog (`/blog`)

Content collection, MDX, `astro:assets` images, `BlogPosting` JSON-LD, RSS. Zero posts at launch is fine; the route ships ready.

### Changelog (`/changelog`)

Loader over `frontend/src/release-notes/*.md`. Already written, already versioned, already has hero images. Free freshness signal - AI answer engines weight recency, and this updates on every release with no marketing work.

### Legal (`/privacy`, `/terms`)

Port `PrivacyPage.tsx` (532 lines) and `TermsPage.tsx` (588 lines) to MDX. **Must ship before apex cutover** - `apps/mobile/src/app/(tabs)/settings/index.tsx` hard-links `https://clawbits.ai/terms` and `/privacy`, and every shipped iOS/Android build has those URLs baked in. If the apex flips to marketing without them, those links 404 in the App Store build.

Delete the SPA routes only after the marketing pages are live and the mobile app has shipped an update.

---

## 7. Agentic discovery

The differentiator. Do this properly and Clawbits gets cited when someone asks an assistant "how do I give an agent its own chat identity".

**Machine-readable surface**

- `/llms.txt` - curated index: what Clawbits is, then links to the protocol docs with one-line descriptions. Generated from the docs collection, hand-ordered by importance.
- `/llms-full.txt` - full concatenated docs text. Generated.
- Every doc page also served as raw Markdown at `/docs/<slug>.md`. Cheapest possible win: an agent that hits the `.md` gets clean source instead of parsed HTML.
- `/robots.txt` - **explicit per-bot rules**, not a blanket allow: `GPTBot`, `ClaudeBot`, `Claude-User`, `Google-Extended`, `PerplexityBot`, `Bytespider`, `Applebot-Extended`. Decide allow/deny per bot deliberately (default: allow all - we want the citations).
- `/.well-known/mcp.json` - only if/when a public MCP endpoint exists. Do not ship a stub.

**JSON-LD** (`@graph` in `Base.astro`)

- `Organization` (SKALE Labs) + `WebSite` with `SearchAction`
- `SoftwareApplication` - name, category, `offers`, `operatingSystem`, `softwareVersion`, GitHub `codeRepository`
- `TechArticle` per doc page, `BlogPosting` per post
- `FAQPage` on the homepage FAQ if one is added

**Content shape for retrieval**

- Every doc page opens with a self-contained one-paragraph answer before any prose. Chunk-level retrieval means a page's first 400 characters do most of the work.
- Semantic HTML, real `<h1>`-`<h3>` hierarchy, descriptive anchors. No `<div>` headings.
- Stable URLs. Never rename a doc slug without a 301.

**Classic SEO** - canonical URLs, `@astrojs/sitemap`, per-page OG via Satori (prerendered), 2400×1260 to match the existing card spec in `frontend/public/og/README.md`.

> **Satori OG deferred to Phase 5** (decided 2026-08-03). It needs `satori` +
> `@resvg/resvg-js` + static font files (a native binary and 3-4 new
> dependencies) to generate cards for three pages that a hand-designed
> `og-default.png` already covers. The pages that actually need per-route cards
> - blog posts and changelog entries - arrive in Phase 5, so the pipeline gets
> built once, there, where it pays for itself. `/privacy` and `/terms` share the
> brand card until then, which is acceptable rather than ideal.

---

## 8. App migration to `app.*`

**This is the risky half of the project, and it is bigger than the website.** The landing can ship to `preview.clawbits.ai` with zero migration. Do not couple them.

### Confirmed blast radius

Grepped, not guessed:

| # | Surface | Where | Impact |
|---|---|---|---|
| 1 | **Reef egress allowlist** | `reef/fleet.py:62,866`, `reef/profiles.py:471` | `CLAWBITS_BASE_URL` is injected into every microVM and feeds `_net_allow_union` → the per-sandbox egress allowlist. Existing VMs do not have `app.clawbits.ai` allowed. **Every running agent loses connectivity at cutover** unless VMs are upgraded first. Memory also flags an `upgrade()` net_allow union trap. **Highest-severity item.** |
| 2 | **R2 bucket CORS** | `clawbits/cloudflare/r2_provisioner.py:129` | Allowed origins derive from `CLAWBITS_BASE_URL`. Attachment inline preview blob-fetches from R2 → PDF/text preview breaks until re-provisioned. |
| 3 | **OAuth redirect URIs** | `workos_auth.py:1377`, `connectors/github.py:61` | Both build from `CLAWBITS_BASE_URL`. Must register `app.*` callbacks in the WorkOS dashboard and the GitHub App **before** flipping, keeping the old ones during the window. |
| 4 | **Session cookies** | `session_cookie.py:60` | `cookie_kwargs()` sets no `domain=` → host-only. Moving host **logs every user out once**. See decision below. |
| 5 | **Web push** | `frontend/public/sw.js`, `manifest.webmanifest` | Push subscriptions are origin-bound. **All existing subscriptions become invalid**; users must re-subscribe. Installed PWAs on the apex will open the marketing site. |
| 6 | **Mobile app** | `apps/mobile/src/lib/config.ts:1`, `package.json:66-72` | Fallback base URL is `https://clawbits.ai`. Shipped builds cannot be changed. **Requires an apex `/api/*` compatibility proxy** (below). |
| 7 | **CORS allowlist** | `fastapi/main.py:226` | Add `https://app.clawbits.ai`, `https://app.freeclaws.ai` to `CLAWBITS_CORS_EXTRA`. |
| 8 | **Analytics** | `frontend/src/components/Analytics.tsx:19` | `ANALYTICS_HOSTS = ["clawbits.ai"]` → `["app.clawbits.ai"]`. Marketing site gets its own Umami site. |
| 9 | **Release notes gate** | `frontend/src/hooks/useReleaseNotes.ts:13` | `hostname === "clawbits.ai"` → `app.clawbits.ai`. |
| 10 | **Desktop (Tauri)** | `desktop/src-tauri/tauri.conf.json` | Bundles `frontend/dist` locally and calls the API over the network. **Verify** which base URL the packaged build uses before cutover - not fully traced. |
| 11 | nginx / DNS | `nginx/nginx.conf` | Currently one `server_name _` catch-all. Split by `server_name`; apex leaves the box entirely. |
| 12 | Favicon swap | `frontend/index.html:39` | Already regex-matches `*.clawbits.ai`. No change. |
| 13 | **App social meta** | `frontend/index.html:88-101` | `og:url` and the `og:image` / `twitter:image` pair are hardcoded absolute to `https://clawbits.ai`. After the flip the apex is the marketing site, so `og:url` points at the wrong page and `/og/og-clawbits-app.png` 404s - the app's share card silently breaks. Rewrite all four to `https://app.clawbits.ai`. (The card art itself lives at `frontend/public/og/og-clawbits-app.png` and moves with the app.) |

### Decision needed: session continuity

- **(a) Accept one-time re-login.** Nothing to build. Every user signs in again once. Recommended - it is honest, cheap, and avoids widening cookie scope.
- **(b) Pre-set `domain=.clawbits.ai`** in a release *before* cutover so sessions carry across. Costs a release cycle of lead time and exposes the session cookie to `share.`, `avatars.`, and `mail.` subdomains. The cookie is `httponly; secure; samesite=lax` and we control those hosts, so the risk is low - but it is a real widening for a one-time convenience.

Recommend **(a)**.

### Compatibility proxy (non-negotiable)

Shipped mobile builds and old desktop builds point at the apex forever. The apex Worker must proxy `/api/*` → the app box for a long deprecation window (**suggest 12 months**), while serving marketing on every other path. This also covers `/privacy` and `/terms` naturally, since the marketing site owns those routes.

### Order of operations

1. Add `app.clawbits.ai` / `app.freeclaws.ai` DNS → same origin. Both hosts serve the app. Apex still serves the app.
2. Register `app.*` OAuth callbacks (WorkOS + GitHub App). Keep apex callbacks.
3. Add `app.*` to `CLAWBITS_CORS_EXTRA`. Re-provision R2 CORS with both origins.
4. Flip `CLAWBITS_BASE_URL` → `https://app.clawbits.ai`. **Upgrade all Reef VMs** so `net_allow` picks up the new host. Verify agents still post.
5. Ship mobile + desktop updates pointing at `app.*`.
6. Ship marketing site with `/privacy` + `/terms` on `preview.clawbits.ai`. Verify.
7. **Cutover:** apex DNS → Worker. Worker proxies `/api/*` to the app box, serves marketing elsewhere, 301s `/login`→`app.*/login` and every other app route.
8. Remove legal routes from the SPA. Update `ANALYTICS_HOSTS`, `useReleaseNotes`.

Steps 1-5 are reversible. Step 7 is the only real cutover, and it is a DNS change.

---

## 9. Deploy & CI

```bash
cd web && bun install
bun run dev            # workerd, via astro dev
bun run build
bunx wrangler deploy
```

- `.github/workflows/` - add a `web` job: build + `astro check` + Lighthouse CI budget. Path-filtered to `web/**` and `docs/**` so it never blocks backend PRs.
- PR previews via Workers preview URLs.
- Budgets, enforced in CI: **LCP < 1.2s**, **CLS < 0.02**, **0 KB motion JS**, total JS **< 20 KB** on `/`.
- Secrets: `CLOUDFLARE_API_TOKEN` scoped to Workers-deploy only.

---

## 10. Gates & open questions

Blocking before build starts:

1. ~~**Docs publication audit**~~ - **CLOSED 2026-08-03.** Audited all 29 files in `docs/` and `docs/protocol/` for credentials, internal hostnames, unshipped-feature detail and security-sensitive text. **17 published** (public API reference; no secret values, internal hosts or private-repo references found in any of them). **Excluded:** `ENCRYPTED_CHANNELS_...` and `GITHUB_INTEGRATION_SPEC` (both document features that do not exist in the API today - the former says so in its own header), `SEARCH_SPEC` (spec, and builds on the E2EE draft), `SECRETS`/`REEF`/`AUTH`/`RELEASING`/`DATABASE`/`ATTACHMENTS` (internal runbooks; `SECRETS` references the private `clawbits-internal` repo and `AUTH` contains Tailscale setup), `LOBSTER_RELAY_PROTOCOL_SPEC` (different subsystem), `LANDING_SITE_PLAN` (this document), `CLAWBITS_PROTOCOL_SPEC` (an index of relative file paths, superseded by the site nav). Full reasoning lives in `web/src/docs-allowlist.ts` so it stays next to the code it governs. **Owner review still welcome** - the default was deliberately conservative and is cheap to grow.
2. **Product screenshots** - the hero lives or dies on these. Need a seeded demo org with believable channels, agents, and conversation. Suggest a scripted seed so shots are reproducible at every redesign.
3. **Tauri base URL** (§8 item 10) - trace what the packaged desktop build actually calls.

Non-blocking, decide during build:

4. Does `Start free` go to open signup, or a waitlist?
5. Umami on the marketing site - same instance, new site ID?
6. Keep the candy logo as-is on dark, or commission a monochrome lockup for the nav? (The candy mark at 24px nav size may mud out - check before committing.)
7. Buy a display face later? The design system leaves one variable to swap.

---

## 11. Phasing

| Phase | Contents | Gate |
|---|---|---|
| **0 · Scaffold** | `web/`, Astro 7 + Tailwind 4 + Fonts API, tokens, grain, Nav/Footer/Section primitives, deploy to `preview.clawbits.ai` | Worker deploys; grain + type match the OG card. **Code DONE 2026-08-03** (23 files, 0 KB JS, `astro check` clean). Deploy still open: needs a Cloudflare Workers-deploy token + `preview.clawbits.ai` DNS. |
| **1 · Homepage** | 10 blocks, real copy, CSS motion, screenshots | Lighthouse budget met; reads right on mobile. **Code DONE 2026-08-03**: 9 blocks + nav + footer, 0 KB JS, 4.9 KB HTML + 5.9 KB CSS gzipped, no horizontal overflow at 375/840/1280, `astro check` clean. OPEN: real product screenshots (see §10 gate 2) - the hero and identity visuals are rendered-DOM stand-ins; and Lighthouse has not been run. |
| **2 · Legal** | `/privacy` + `/terms` ports | Byte-for-byte content parity with the SPA pages. **DONE 2026-08-03.** Ported as `.astro`, not MDX - markdown's smartypants would have rewritten the straight quotes in `"as is" and "as available"` and every `"lawful basis"`, which is a character-level change to an operative contract, and auto-slugged headings would have broken the `#rights`-style anchors. Gate is automated: `bun run verify:legal` diffs every rendered word against the TSX plus section anchors and the index (privacy 1624 words, terms 2070, all matching; negative-tested against a changed word, a dropped sentence, and a renamed anchor). |
| **3 · Discovery** | llms.txt, llms-full.txt, raw `.md`, robots, JSON-LD, sitemap, Satori OG | Validators clean; `/llms.txt` renders every allowlisted doc. **DONE 2026-08-03** except two items called out below. Shipped: `/llms.txt`, `/llms-full.txt`, per-crawler `/robots.txt` (14 named AI bots), `@astrojs/sitemap`, per-page `WebPage` JSON-LD with `dateModified`. All copy moved to `src/content/home.ts` so the page and both text endpoints render from one source and cannot drift. Added `verify:links`, which caught 11 dead internal links to `/docs` that had been live since Phase 0. **Deferred:** raw `.md` endpoints (they are per-doc-page, so they belong with Phase 4) and Satori OG images (see below). **Dropped:** `WebSite`/`SearchAction` - the marketing site has no search, and declaring one is a lie in a machine-readable format. |
| **4 · Docs** | Starlight at `/docs`, restyled, audited allowlist | §10 gate 1 signed off. **DONE 2026-08-03.** 17 specs published, read straight from `docs/` (no copy). The audit IS `web/src/docs-allowlist.ts`, which records every exclusion and its reason. **NOT Starlight** - it brings its own layout/type/colour system and its search ships client JS, which would end the 0 KB JS property for a 17-page reference; a custom collection reuses the existing design system instead. Trade: no built-in search. Also shipped: raw Markdown at `/docs/<slug>.md` (the Phase 3 carry-over), `TechArticle` JSON-LD per page, cross-document link rewriting, and llms.txt now indexes every doc with its summary. |
| **5 · Blog + changelog** | Collections + RSS + release-notes loader | Changelog renders current releases — **loader + page DONE 2026-08-06**; blog + RSS outstanding |
| **6 · Migration** | §8 steps 1-8 | Agents still posting after step 4; mobile shipped before step 7 |

Phases 0-5 ship to `preview.*` and are independent of the app. Phase 6 is the only one that can break production.
