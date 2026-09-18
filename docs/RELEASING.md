# Releasing

Every version in this repo is derived by
[release-please](https://github.com/googleapis/release-please) from Conventional Commit subjects.
Nobody edits a version by hand, and there is no bump script any more.

## How a version gets decided

The repo is **squash-merge only**, so a PR becomes exactly one commit on `main` and its **title**
becomes that commit's subject. The title is linted by the `PR title` check in
[`ci.yml`](../.github/workflows/ci.yml), which is what makes the derivation trustworthy — before
that gate, 6 of 135 commits were conventional and the old semantic-release setup produced three tags
in the repo's lifetime while writing no version anywhere.

Commits on your own branch are never inspected; squashing discards them.

| PR title prefix | Bump |
| --- | --- |
| `feat:` | minor |
| `fix:`, `perf:`, `refactor:`, `revert:` | patch |
| `feat!:`, or `BREAKING CHANGE:` in the body | major |
| `chore:`, `docs:`, `test:`, `style:`, `ci:`, `build:` | no release |

Scope the title to steer which component bumps, e.g. `fix(plugin): drop stale tool count`.

## The release PR

release-please keeps an open PR titled `chore: release …`. It accumulates every unreleased change,
updates the version files and `CHANGELOG.md`, and does nothing else.

**Merging that PR is what cuts a release.** Until then, nothing is published.

## The five version lanes

Configured in [`release-please-config.json`](../release-please-config.json); current versions live
in [`.release-please-manifest.json`](../.release-please-manifest.json), which is the source of
truth — not the version fields in the files.

| Lane | Files it writes | Tag |
| --- | --- | --- |
| **Product** (backend + frontend + desktop) | `pyproject.toml`, `frontend/package.json`, `desktop/package.json`, `tauri.conf.json`, `src-tauri/Cargo.toml` | `v1.2.3` |
| **OpenClaw plugin** | `plugin/package.json`, `plugin/openclaw.plugin.json` | `openclaw-plugin-v1.2.3` |
| **CLI** | `cli/Cargo.toml` | `cli-v1.2.3` |
| **Images** | `images/Cargo.toml` | `images-v1.2.3` |
| **Mobile** | `apps/mobile/package.json`, `apps/mobile/app.json` | `mobile-v1.2.3` |

Backend, frontend and desktop deliberately share one version, as the old `bump_version.py` enforced
by hand.

`uv.lock` and `desktop/src-tauri/Cargo.lock` are **not** managed. Neither can be addressed by
jsonpath, `uv sync --frozen` and `cargo build` both tolerate the drift, and each self-heals on the
next `uv lock` / `cargo build`. Only `uv lock --check` would object, and nothing runs it.

## What publishes, and when

| Artifact | Trigger |
| --- | --- |
| ClawHub tools + channel packages | push to `main`, when `plugin/package.json`'s version is not yet on ClawHub |
| CLI binaries | push to `main` touching `cli/**` |
| Marketing site | push to `main` (staging) / `prod` (production) |
| Desktop app | push to `prod`, or `workflow_dispatch` for a staging build |
| Agent image | `workflow_dispatch` only — it is a multi-gigabyte deliberate action |

Promote to production by merging `main` → `prod`.

## The "Latest" release is a production endpoint

`releases/latest/download/latest.json` is baked into every desktop binary ever shipped
([`tauri.conf.json`](../desktop/src-tauri/tauri.conf.json)), so GitHub's "Latest" pointer must
always resolve to a desktop release.

**Every `gh release create` in this repo passes `--latest=false` except the desktop one.** The
`Release` workflow also un-latests anything release-please creates, immediately after creation.
If you add a workflow that cuts a release, it passes `--latest=false` or it breaks the updater for
every installed app.

Changing the endpoint only affects *future* builds; installs in the wild keep polling whatever URL
they shipped with. Treat it as approximately permanent.

Staging desktop builds are marked GitHub **prereleases**, so they can never take the pointer.
Signing and notarisation: [`desktop/SIGNING.md`](../desktop/SIGNING.md).

## Other version helpers

[`scripts/sync_native_versions.py`](../scripts/sync_native_versions.py) propagates the marketing
version into the iOS and Android native projects (`CFBundleShortVersionString`, `versionCode`).
Its leader files — `apps/mobile/package.json` and `desktop/src-tauri/Cargo.toml` — are both written
by release-please, so run it after a release PR merges.

## If a release goes wrong

Code releases are additive. Delete the GitHub release and its tag, correct the version in
`.release-please-manifest.json`, and push; release-please recomputes from there.

A desktop release is different: once `latest.json` points at a build, clients fetch it. To pull a
bad build, delete that release so `releases/latest/` falls back to the previous one, then confirm
the redirect resolves where you expect before walking away.

ClawHub and the Tauri updater both require **strictly increasing** versions, and neither lets you
republish a version. Never lower a number in `.release-please-manifest.json`.
