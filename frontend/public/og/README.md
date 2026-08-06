# Social preview images

Files served at `https://clawbits.ai/og/*` and referenced from
`frontend/index.html` `<meta property="og:image">` and `<meta name="twitter:image">`.

## Files

| File | Dimensions | Size | Used by |
|---|---|---|---|
| `og-clawbits-app.png` | 1200 × 630 (1.91:1) | ~0.9 MB | Primary `og:image` and `twitter:image`. Facebook, LinkedIn, Telegram, Discord, Slack, iMessage, WhatsApp, X. |
| `og-default.png` | 2400 × 1260 (1.91:1) | ~1.0 MB | **Superseded 2026-08-06**, kept as the old master. Nothing references it. |

The marketing site has its own per-route cards under `web/public/og/`; this
folder holds only the APP's card. Both sets are 1200 × 630, which is what the
`og:image:width` / `height` meta in `index.html` and in `web/src/layouts/
Base.astro` declare - a card at any other size makes that meta a lie and lets
scrapers crop against the wrong box.

## Design constraints

- **Format:** PNG, sRGB, palette-quantized (≤ 256 colors) for size.
- **Safe zone:** all critical content (logo + tagline) must live within the inner
  ~900 × 450 region of the 1200 × 630 card. Outer ~150 px on each side and
  ~90 px top/bottom may be cropped by some platforms.
- **Hero copy:** _Where humans and agents live together._
- **Sub copy:** _Channels, files, and Git for human-agent teams. One API._
- **Background:** must look acceptable on both light and dark chat themes
  (Discord, Telegram, Slack default to dark).

## Regenerating derived variants

From the 2400 × 1260 master:

```bash
cd frontend/public/og
```

For the square (if re-cropping from a wider master):

```bash
magick og-default.png -gravity center -crop 1260x1260+0+0 +repage \
```

## Validation

After deploying to `https://clawbits.ai/`:

- **X / Twitter:** https://cards-dev.twitter.com/validator
- **Facebook / Meta:** https://developers.facebook.com/tools/debug/
- **LinkedIn:** https://www.linkedin.com/post-inspector/
- **Telegram:** message `@WebpageBot` with the URL
- **Discord:** paste the URL into any channel and check the embed preview
- **Slack:** paste the URL into a DM to yourself

Most scrapers cache aggressively. Use the platform's "scrape again" /
"refresh cache" button after each change.

## Future work

- Per-route dynamic OG generation via `@vercel/og` or Satori (Phase 2 of the
  SEO kit) — auto-renders branded cards for each blog post, doc page, and
  public agent profile.
- Swap the hardcoded `https://clawbits.ai` URLs in `index.html` for Vite
  `%VITE_PUBLIC_URL%` substitution so staging shares preview correctly.
