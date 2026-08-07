# web

Marketing site for the apex domains. The app lives on `app.<domain>` - see the
landing site plan, which lives in the private `clawbits-internal` repo at
`docs/plans/LANDING_SITE_PLAN.md`.

- `clawbits.ai` - production, after the Phase 6 apex cutover
- `freeclaws.ai` - staging, after the Phase 6 apex cutover
- `preview.clawbits.ai` - production target **today** (`prod` branch)
- `preview.freeclaws.ai` - staging target **today** (`main` branch)

Astro 7.1, Tailwind 4, fully static. **Ships 0 bytes of JavaScript.**

## Run it

```bash
cd web && bun install && bun run dev
```

```bash
bun run build && bun run check && bun run verify:legal
```

`bun run dev` honours `$PORT` (`astro dev` itself does not, hence the flag in
the `dev` script).

## Deploy

Automatic, via [`.github/workflows/web.yaml`](../.github/workflows/web.yaml):

| Branch | Worker | URL |
| --- | --- | --- |
| `main` | `clawbits-web-staging` | `preview.freeclaws.ai` |
| `prod` | `clawbits-web` | `preview.clawbits.ai` |

`prod` advances by manual merge from `main`. Pull requests build and verify but
never deploy.

Two build-time environment variables drive the difference, and getting either
wrong ships a site that lies about where it lives:

- `SITE_URL` - canonical URLs, sitemap, absolute OG images, and whether
  `robots.txt` allows indexing at all (only the two apex hosts do; every
  preview origin gets `Disallow: /`, backed by `X-Robots-Tag` in `_headers`).
- `PUBLIC_APP_URL` - where every "Sign in" / "Get started" CTA points. Must be
  `PUBLIC_`-prefixed or Vite strips it and the build silently falls back to the
  production app URL.

To deploy by hand (rarely needed - CI is the normal path):

```bash
cd web && SITE_URL=https://preview.freeclaws.ai PUBLIC_APP_URL=https://freeclaws.ai bun run build && bunx wrangler deploy --env staging
```

`--env` is **mandatory**. Without it wrangler deploys the unnamed top-level
config as a third Worker.

`wrangler.jsonc` still declares **no routes**. The two `preview.*` custom
domains are attached by hand in the Cloudflare dashboard - that keeps the apex
cutover a deliberate Phase 6 step rather than a side effect of a deploy, and
lets the CI token stay scoped to `Workers Scripts: Edit` with no zone-level DNS
write. CI needs exactly two repo secrets: `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID`.

## Layout

```
src/
  config.ts              every outbound URL and brand string - the Phase 6
                         app.* migration is a one-line change here
  content/home.ts        ALL homepage copy; the page and both llms.txt
                         endpoints render from it so they cannot drift
  docs-allowlist.ts      which docs/protocol specs are published at /docs
  styles/global.css      @theme tokens, type scale, motion keyframes
  layouts/
    Base.astro           <head>, JSON-LD graph, font preloads, CSP
    Docs.astro           /docs frame
    Legal.astro          frame for /privacy and /terms
  components/
    Section.astro        the ONE layout primitive
    AppDemo.astro        the hero's zero-JS recreation of the real app
    ShaderBackdrop.tsx   the only React island (GrainGradient, client:only)
    *Visual.astro        one per feature section
    LegalSection.astro   one numbered section; index and body share one object
    Nav / Footer / Button / Logo / Eyebrow / HugeIcon / AppWindow
  pages/                 index, privacy, terms, brand, download, 404,
                         docs/, changelog/, robots.txt, llms.txt, llms-full.txt
scripts/
  build-brand-assets.mjs derives every brand variant from the two masters
  verify-legal-parity.mjs
  verify-links.mjs
```

## Type and tone

**Geist for display and body both** (`--font-display` and `--font-body` resolve
to the same variable face), Geist Mono for code. The scale leans on in-between
weights - 450, 550 - which only work because it is served as a variable font,
so do not swap in static instances.

Two further faces exist and are scoped to one place each, both inside the hero
demo, where the point is to look like the real app rather than like the site:
**Fraunces** for the Home greeting and **Inter** (`--ff-app`) for the demo
window's UI. Neither belongs anywhere else on the page.

**Nothing on this site is uppercased.** No `text-transform: uppercase`, no
tracked-out mono micro-labels. Both are the most overused devices on AI landing
pages and they date a design instantly. Section labels are sentence case in the
serif. `font-synthesis: none` is set globally so the browser never fakes a
weight or a slant.

## Agentic discovery

All generated at build time, no dependencies:

| Route | What it is |
|---|---|
| `/llms.txt` | Curated index: summary, checkable facts, links by importance |
| `/llms-full.txt` | The whole site as one plain-text document |
| `/robots.txt` | Explicit per-crawler rules (14 named AI bots, all allowed) |
| `/sitemap-index.xml` | Via `@astrojs/sitemap` |

**All page copy lives in `src/content/home.ts`, not in the template.** The page
and the two `.txt` endpoints render from that one module, so a machine-readable
file can never disagree with what a person reads. Do not inline new prose in
`index.astro`.

`FACTS` in that module is what a model should be able to state about Clawbits
without inferring it. Every line must be checkable against the repository - no
aspirational entries.

**Links to routes that don't exist yet point off-site.** `/docs` arrives in
Phase 4 and `/changelog` + `/blog` in Phase 5; until then `config.ts` sends
those to GitHub. `bun run verify:links` fails the build on any internal href
with no matching page - it was added after the nav, hero, footer and generated
index all linked to `/docs` for three phases.

Not shipped, deliberately: `/.well-known/mcp.json` (there is no public MCP
endpoint - a stub would advertise a capability that doesn't exist) and
per-route OG images (see the plan, deferred to Phase 5 with the blog).

## Docs

`/docs` renders 17 protocol specs read **directly from the repo's `docs/` tree**
- not copied into `web/`, so there is no second source of truth to go stale.

**`src/docs-allowlist.ts` is the publication decision.** It is an explicit list,
not a glob: `docs/protocol/` is internal engineering material, and a glob would
publish whatever lands there next to a site whose robots.txt invites fourteen AI
crawlers in. The file records what was audited and why each excluded spec is
excluded. To publish another one, re-audit it and move it up.

Each page also serves raw Markdown at `/docs/<slug>.md`, linked from the page
footer and from llms.txt.

**Not Starlight**, though the plan called for it: it brings its own layout, type
scale and colour system, so using it means fighting its theme back to the design
already in `global.css`, and its search ships client JS - ending the site's 0 KB
JS property for a 17-page reference. The trade is no built-in search.

Cross-document links are rewritten in `src/content.config.ts`: the specs link to
each other with repo-relative `.md` paths, which are all 404s on a website.
Published targets become `/docs/<slug>`; unpublished ones are unwrapped to plain
text so a reference never points at something we chose not to publish.

Syntax highlighting is **off**. Shiki emits inline styles that the CSP blocks,
and a syntax theme would introduce six or seven hues against an art direction
that allows one accent. `pre` is styled by hand.

## Legal pages

`/privacy` and `/terms` are word-for-word ports of
`frontend/src/pages/{Privacy,Terms}Page.tsx`. They are operative legal
documents, so `bun run verify:legal` diffs every rendered word against the TSX
source and also checks that section anchors and the "On this page" index match.
It fails the build on any difference. Run it after touching either page.

Two things in the ported text look like mistakes and are preserved deliberately:
em dashes (the repo's prose style avoids them, but this is quoted legal text),
and privacy section 2 naming `clawbits.ai` twice where the Terms name
`clawbits.ai` and `freeclaws.ai`. Fix those upstream in the SPA first, then
re-run the gate.

## Things that will bite you

**Page-scoped styles cannot reach a component's root.** Astro gives every
component its own scope id, so `<Section class="hero">` leaves the `<section>`
carrying Section's id, not the page's. A page rule like `.hero { padding: ... }`
compiles to a selector that can never match, and it fails *silently*. Use a
prop (`<Section pad="hero">`) or a Tailwind utility (utilities are global).

**CSP lives at `security.csp`.** Not `experimental.csp` (errors), and not a
top-level `csp` key - Astro strips unknown top-level keys silently, so it builds
fine and emits nothing.

**No Cloudflare adapter, on purpose.** With `output: "static"` it emits an empty
`dist/server`, moves the build to `dist/client`, and injects a `SESSION` KV
binding you then have to provision. Everything through Phase 5 is static. To add
it back when a genuinely on-demand route exists, see the note in
`astro.config.mjs`.

**`astro dev` goes stale on a wholesale file rewrite.** Rewriting a `.astro`
file end-to-end (rather than editing it) can leave the dev server serving the
*previous* scoped CSS - new rules simply absent from the stylesheet while old
ones persist. It looks exactly like a broken selector. Confirm against
`bun run build` output before debugging the CSS; if the built file is correct,
restart the dev server.

**Whitespace inside `<pre>` is real.** Pretty-printing a `.map()` across several
template lines inside a whitespace-preserving element emits every newline and
indent as text. Keep each line as one unbroken expression on one source line.

**`@keyframes` names are GLOBAL, even in scoped `<style>`.** Astro scopes
selectors with a `data-astro-cid-*` attribute but does **not** rename keyframes,
and every component's CSS is concatenated into one stylesheet. Two components
that both define `@keyframes r7` produce one winner - whichever is emitted last -
and the loser's animation silently runs the wrong keyframe. This already
happened: `LobstertalkVisual` and `MailboxVisual` both had `r7`/`r8`/`r9`, so
three rows of the Lobstertalk card animated `max-height` (Mailbox's property)
while their own rule set `height`, and they simply never opened. Nothing errors;
`astro check` and the build are clean. **Prefix every keyframe with the
component**, as `lt-*` does. To audit:

```bash
cd web && bun run build && python3 -c "import re,glob,collections; d=collections.defaultdict(set); [d[m.group(1)].add(f) for f in glob.glob('dist/_astro/*.css') for m in re.finditer(r'@keyframes ([\w-]+)\{', open(f).read())]; print({k:v for k,v in d.items() if len(v)>1} or 'no collisions')"
```

**Grain is invisible in downscaled screenshots.** It is 1px noise at 0.055
opacity; any 2x-downscaled capture averages it away. Judge it on a real display.

**There is no colour logo SVG.** `clawbits-long.svg` is flat black artwork for
light backgrounds, inverted to white here. The candy-textured mark exists only
as raster inside `og-default.png`. See the note in `Logo.astro`.

**OG cards ship palette-quantised, and a new one should too.** The hand-made
cards exported at ~885 KB each; re-encoding to a dithered 256-colour PNG takes
them to ~340 KB with a mean per-channel error of 0.26/255 - invisible on grain
and on letterform edges, both checked at 1:1. Plain lossless recompression only
reaches 710 KB, and JPEG, which would reach 100 KB, visibly smooths the grain
out of the flat black areas, and the grain is the art direction. Run this on any
card you add (sharp comes with Astro, so there is nothing to install):

```bash
cd web && node -e "const s=require('sharp'),f=process.argv[1];s(f).png({palette:true,quality:100,dither:1,effort:10,compressionLevel:9}).toFile(f+'.tmp').then(()=>require('fs').renameSync(f+'.tmp',f))" public/og/og-clawbits-NEW.png
```

Careful reading sharp's PNG options: passing `effort`, `quality`, `colours` or
`dither` **implies `palette: true`**. There is no way to ask for "lossless but
high effort" - `png({compressionLevel: 9})` alone is the lossless path, and
anything that looks like a quality knob is quantising.

**`public/og/og-default.png` is unreferenced ON PURPOSE - do not delete it.** No
page points at it (`Base.astro` defaults to `og-clawbits.png`, which uses the
flat logo), so every unused-asset sweep flags it. It is the only surviving
raster of the candy-textured wordmark described above, and there is no vector to
regenerate it from.
