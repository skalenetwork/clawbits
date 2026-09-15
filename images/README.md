# clawbits agent images

Bakes the clawbits plugins into an upstream agent runtime and hands you a
digest to pin in a reef role. Everything else an agent needs (entrypoint,
config, env, ports, volumes) is role data, not image data.

```bash
cargo run --release            # latest openclaw + latest plugins, loaded into docker
cargo run --release -- --push  # same, pushed to ghcr
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

The image ships plugin files and no config. A role supplies the config, must
enable both plugins under `plugins.entries`, and must not mount a volume over
`/home/node/.openclaw` — that hides the plugins entirely. See
`reef/roles/clawbits-openclaw.toml`, which mounts `state` and `workspace`
separately.

Versions are resolved before the build (npm for the engine, ClawHub for the
plugins) and passed in as build args, so the tag, the labels and the installed
packages are equal by construction. The tag also carries the short commit of the
tree that built it (`oc2026.9.3-pl0.17.24-g563b35bd`), so a recipe change with no
version bump publishes a new tag instead of moving the old one. The engine's ghcr
tag is checked first: not every release publishes a `-browser` variant.

The build asserts both plugins report `loaded`, which catches a plugin whose
files copied but whose runtime dependencies did not. It does not prove the
gateway will load them: that is the role's `plugins.entries`.

## Adding an image

A row in `RECIPES` and a Dockerfile under `<name>/` taking `BASE`,
`PLUGIN_STAGE`, `ENGINE_VERSION`, `PLUGIN_VERSION` and `IMAGE_VERSION`.
