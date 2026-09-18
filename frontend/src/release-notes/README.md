# Release notes

One markdown file per prod release. This folder feeds two surfaces, with nothing copied or synced:

1. the in-app "What's new" card, a non-blocking panel pinned bottom-left (`src/components/ReleaseNotesCard.tsx`,
   `src/hooks/useReleaseNotes.ts`), and
2. the public changelog at **clawbits.ai/changelog**, which reads this folder through `web/src/content.config.ts`.

Two consequences:

- **Two markdown renderers.** The app uses react-markdown, the site Astro's processor. Lists, bold and headings
  render the same; check anything fancier (tables, images, footnotes, raw HTML) on both.
- **The website build validates the frontmatter.** `date` and `title` are required there, so omitting one fails
  `bun run build` in `web/`. That is deliberate: the app would silently render a headless entry.

## Adding a release

Name the file after the released version, matching the prod release-please tag without its `v`
(release-please cuts `vX.Y.Z`). The filename is the version the card shows and dedupes on. Files not named like a version (this
README, drafts) are ignored by both surfaces.

A short user-facing body (what changed for users, not commit-speak), usually a bullet list:

```markdown
---
date: 2026-06-10
title: Smarter member lists
---

- **Channel members** now sort by who's online
- Cleaner, theme-consistent sign-in screen
```

An optional WebP named after the version (`1.1.0.webp` next to `1.1.0.md`) renders as a 2:1 hero above the
notes, `object-cover` anchored to the right edge, so a wider capture crops from the left.

## Where it shows

- Production (`app.clawbits.ai`) and the local dev server (`import.meta.env.DEV`). The built staging site
  (`app.freeclaws.ai`) serves the same bundle, so the gate is hostname plus dev mode.
- Once per version per device (tracked in `localStorage`), latest release only: a device that skipped versions
  sees just the newest notes.
- Preview anywhere with `?releaseNotes=force` or `localStorage.setItem('fc_release_notes_force','1')`.
