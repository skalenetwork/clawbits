# clawbits agent images

Bakes a clawbits plugin into an upstream agent runtime and hands you a
digest to pin in a reef role. Everything else an agent needs (entrypoint,
config, env, ports, volumes) is role data, not image data.

```bash
cargo run --release                    # latest openclaw + latest plugins, loaded into docker
cargo run --release -- --push          # same, pushed to ghcr
cargo run --release -- hermes          # latest Hermes release + the connector at HEAD
```

```
      --engine <VERSION>  Engine version to bake instead of the latest published
      --plugin <VERSION>  Plugin version to bake instead of the latest published
      --local             Bake the working-tree plugin; never pushed
      --push              Push to the registry instead of loading into docker
      --digest            Push by digest with no tag, for the multi-arch merge
  -y, --yes               Skip the confirmation prompt
```

`--push` prints the one line that matters:

```
  pushed   ghcr.io/skalenetwork/clawbits-openclaw@sha256:680ef913…
```

Paste it into a role's `image =`. Pushing needs `docker login ghcr.io` with a
token carrying `write:packages`.

A local build is single-architecture: the host's. A digest pushed from an arm64
Mac cannot be pulled by an amd64 host, so the multi-arch image comes from the
`Images publish` workflow, which builds each architecture on its own native
runner, pushes both with `--digest`, and merges them into one tag. That is the
path prod pulls from; a local `--push` is for trying something out.

The OpenClaw image ships plugin files and no config. A role supplies the config,
must enable both plugins under `plugins.entries`, and must not mount a volume
over `/home/node/.openclaw` — that hides the plugins entirely. See
`reef/roles/clawbits-openclaw.toml`, which mounts `state` and `workspace`
separately. The Hermes image ships the connector plus a cont-init hook that
signs up with `CLAWBITS_SIGNUP_TOKEN` at first boot; the identity lands in
`/opt/data/.env`.

Versions are resolved before the build (npm or a GitHub release for the engine,
ClawHub or this tree's `plugin.yaml` for the plugin) and passed in as build
args, so the tag, the labels and the installed packages are equal by
construction. The tag also carries the short commit of the tree that built it
(`oc2026.9.3-pl0.17.24-g563b35bd`, `hm2026.9.14-pl0.9.0-g563b35bd`), so a
recipe change with no version bump publishes a new tag instead of moving the
old one. The engine's registry tag is checked first: not every OpenClaw release
publishes a `-browser` variant.

Each build asserts its plugin loads (OpenClaw: both plugins report `loaded`;
Hermes: `hermes clawbits signup --help` prints the signup flag and
`hermes clawbits doctor --preflight` runs the plugin's agent CLI under the image's
Python), which catches a plugin whose files copied but whose runtime dependencies
did not. It does not prove the gateway will load them: that is the role's config.

## Adding an image

A row in `RECIPES` naming the engine source (an npm tag or a GitHub release),
the plugin source (a ClawHub package or a directory of this tree) and the tag
prefix, plus a Dockerfile under `<name>/` taking `BASE`, `ENGINE_VERSION`,
`PLUGIN_VERSION` and `IMAGE_VERSION`, and `PLUGIN_STAGE` for a ClawHub plugin. A
tree plugin arrives in `.plugin/` from `git archive HEAD`, or from the working
tree with `--local`.
