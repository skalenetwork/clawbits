#!/usr/bin/env bash
# Debug-only: build a Reef OpenClaw image with the repo's local ./plugin folder
# copied over the baked clawbits plugin, then load it into microsandbox.
#
# Usage:
#   ./reef/images/openclaw-runtime/build-debug-plugin.sh
#
# Env:
#   REEF_BASE_IMAGE=reef-oc:plugin            base image to patch
#   REEF_DEBUG_IMAGE=reef-oc:debug-plugin    output tag
#   REEF_DOCKER_BIN=docker                   docker binary
#   REEF_MSB_BIN=msb                         msb binary
#   REEF_MSB_LOAD=0                          skip msb image load
#   REEF_SKIP_PLUGIN_BUILD=1                 skip `bun install && bun run build`
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
if root="$(git -C "$here" rev-parse --show-toplevel 2>/dev/null)"; then
  :
else
  root="$(cd "$here/../../.." && pwd)"
fi
plugin_dir="$root/plugin"
base_image="${REEF_BASE_IMAGE:-reef-oc:plugin}"
image="${REEF_DEBUG_IMAGE:-reef-oc:debug-plugin}"
docker_bin="${REEF_DOCKER_BIN:-docker}"
msb_bin="${REEF_MSB_BIN:-msb}"

[ -d "$plugin_dir" ] || { echo "reef-debug: missing plugin dir: $plugin_dir" >&2; exit 1; }

if [ -z "${REEF_SKIP_PLUGIN_BUILD:-}" ]; then
  echo "reef-debug: building local plugin…"
  (cd "$plugin_dir" && bun install && bun run build)
fi

[ -f "$plugin_dir/dist/index.js" ] || {
  echo "reef-debug: missing plugin/dist/index.js (run plugin build first)" >&2
  exit 1
}

tmp="$(mktemp -t reef-debug-plugin.XXXXXX.Dockerfile)"
trap 'rm -f "$tmp"' EXIT
cat > "$tmp" <<'DOCKERFILE'
ARG BASE_IMAGE=reef-oc:plugin
FROM ${BASE_IMAGE}
USER root
RUN rm -rf /home/node/.openclaw/extensions/clawbits
COPY --chown=node:node plugin/ /home/node/.openclaw/extensions/clawbits/
USER node
DOCKERFILE

echo "reef-debug: building $image from $base_image with ./plugin…"
"$docker_bin" build \
  -f "$tmp" \
  --build-arg "BASE_IMAGE=$base_image" \
  -t "$image" \
  "$root"

echo "reef-debug: docker image ready → $image"

if [ "${REEF_MSB_LOAD:-1}" != "0" ]; then
  echo "reef-debug: loading $image into microsandbox…"
  "$docker_bin" save "$image" | "$msb_bin" image load -t "$image"
  echo "reef-debug: microsandbox image ready → $image"
fi

echo "reef-debug: run Reef with: export REEF_OPENCLAW_IMAGE=$image"
