# Release notes

Each prod release gets one markdown file here, shown to users in a "What's new"
modal on their next visit after the release ships. See
`src/components/ReleaseNotesDialog.tsx` + `src/hooks/useReleaseNotes.ts`.

## These files feed TWO sites

This folder is the single source of truth for both:

1. the in-app **"What's new"** modal, and
2. the public changelog at **clawbits.ai/changelog**, which the marketing site
   reads straight out of this folder — see `web/src/content.config.ts`.

Nothing is copied and nothing is synced. Write the note once, both surfaces
update. Two consequences worth knowing before you edit anything here:

- **Two different markdown renderers.** The app uses react-markdown; the site
  uses Astro's Rust processor. Bullet lists, bold, and headings render the same
  in both — anything fancier (tables, embedded images, footnotes, raw HTML)
  needs checking on both before it ships.
- **The frontmatter is validated on the website's build.** `date` and `title`
  are both required there. Omitting one fails `bun run build` in `web/`, which
  is deliberate: the app would silently render a headless entry instead.

Files not named like a version (this README, drafts) are ignored by both.

## Adding a release

Create one file per release named **after the version**, matching the prod
semantic-release tag (`prod` branch cuts `vX.Y.Z`):

```
src/release-notes/1.0.0.md
src/release-notes/1.1.0.md
```

The filename **is** the version the modal shows and dedupes on, so it must match
the released tag exactly (without the leading `v`). Files that aren't named like
a version (this README, drafts) are ignored.

## File format

Optional YAML-ish frontmatter (`date`, `title`), then a short markdown body —
usually a bullet list of user-facing changes. Keep it user-facing (what changed
for them), not commit-speak.

```markdown
---
date: 2026-06-10
title: Smarter member lists
---

- **Channel members** now sort by who's online
- Cleaner, theme-consistent sign-in screen
```

## Optional hero image

Drop a WebP named after the version next to the markdown to use it as the
modal's hero:

```
src/release-notes/1.1.0.md
src/release-notes/1.1.0.webp
```

It renders as a 2:1 banner (`object-cover`, so wider images crop top/bottom)
with the version overlaid on a dark scrim along the bottom edge — keep that
strip free of important detail. Without a WebP the modal falls back to the
login-page gradient + pattern.

## Where it shows

- **Production** (`app.clawbits.ai`) and the **local dev server** (`vite dev`,
  via `import.meta.env.DEV`) so developers can see it. The built **staging**
  site (`app.freeclaws.ai`) is excluded — same bundle as prod, so the gate is
  hostname + dev-mode, not just the build mode.
- Once per version, per device (tracked in `localStorage`). New devices / the
  first rollout see only the latest entry, not the whole history.

## Previewing off-prod

The prod gate hides it on localhost/staging. To preview:
`?releaseNotes=force` in the URL, or `localStorage.setItem('fc_release_notes_force','1')`.

## Future automation

This folder is a drop-in target: a CI step or semantic-release plugin can write
`<version>.md` from the generated notes on each prod release — no code change to
the modal needed.
