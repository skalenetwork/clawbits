# Releasing

Everything is cut by [semantic-release](https://semantic-release.gitbook.io/) from commit subjects.
Nobody edits a version by hand.

## The four release lanes

| Lane | Trigger | Tag | Where it lands |
| --- | --- | --- | --- |
| **Backend + web** | push to `main` / `prod` (after Test passes) | `v1.2.3` / `v1.2.3-rc.N` | this repo's Releases |
| **Desktop app** | push to `main` / `prod`, or a `desktop-v*` tag | `desktop-v1.2.3` | this repo's Releases, plus `latest.json` for the updater |
| **OpenClaw plugin** | push to `main` touching `plugin/` | `v1.2.3` in the mirror repo | `skalenetwork/clawbits-openclaw-plugin` → ClawHub |
| **IronClaw channel** | push to `main` touching `ironclaw-channel/` | — | release asset on the mirror repo |

The two tag namespaces are deliberately separate. Code releases take `v*`; desktop takes
`desktop-v*`. They share one repo, so a collision would otherwise be a matter of time — the version
lines are simply far apart today.

## What decides the version

The [Conventional Commits](https://www.conventionalcommits.org/) prefix on each subject:

| Prefix | Bump |
| --- | --- |
| `feat:` | minor |
| `fix:`, `perf:`, `refactor:`, `revert:` | patch |
| `BREAKING CHANGE:` in the body, or `feat!:` | major |
| `chore:`, `docs:`, `test:`, `style:`, `ci:` | no release |

`main` publishes prereleases (`-rc.N`); `prod` publishes final versions. Config lives in
[`.releaserc.json`](../.releaserc.json) — it is short on purpose, because the default preset already
handles every case above.

## Cutting a release

Merge to `main`. That is the whole procedure.

`Test` runs first; `Release` only fires on a green run (`workflow_run` with
`conclusion == 'success'`). Nothing needs triggering by hand, though both `Release` and
`Desktop release` accept `workflow_dispatch`.

Promote to production by merging `main` → `prod`.

## Desktop specifics

Staging builds (from `main`) are marked GitHub **prereleases**, so the updater's
`releases/latest/` redirect only ever resolves to a `prod` build. Staging testers download
manually.

The updater endpoint is baked into each binary at build time
([`tauri.conf.json`](../desktop/src-tauri/tauri.conf.json)), so changing it only affects *future*
builds — installs already in the wild keep polling whatever URL they shipped with. Treat that
endpoint as approximately permanent.

Signing keys and notarisation: [`desktop/SIGNING.md`](../desktop/SIGNING.md).

## Version numbers in the tree

Two helpers, for when a version needs to exist in more than one manifest:

- [`scripts/bump_version.py`](../scripts/bump_version.py) — bumps backend, frontend and desktop together
- [`scripts/sync_native_versions.py`](../scripts/sync_native_versions.py) — propagates the desktop
  version into the iOS and Android native projects

## If a release goes wrong

Code releases are additive — there is no version file to revert. Delete the GitHub release and its
tag, then push a corrected commit; semantic-release recomputes from history.

A desktop release is different: once `latest.json` points at a build, clients fetch it. To pull a bad
build, delete that release so `releases/latest/` falls back to the previous one, then confirm the
redirect resolves where you expect before walking away.
