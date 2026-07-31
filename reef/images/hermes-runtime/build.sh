#!/usr/bin/env bash
# Build the Reef Hermes runtime image (upstream Hermes Agent + the baked Clawbits
# platform plugin from extensions/hermes). Image identity is DERIVED from what
# actually landed: after the build we probe the image for the real hermes-agent +
# clawbits-platform versions and stamp an immutable, self-describing tag
# reef-hm:hm<hermes>-pl<plugin> plus the floating reef-hm:plugin tag Reef boots by
# default. No hand-bumped VERSION file — a rebuild of the same stack overwrites the
# same tag (no churn); a component bump yields a new tag.
#
# Prereq: a Hermes base image. Local default:
#   cd ~/.hermes/hermes-agent && docker build -t hermes-agent .
#
# Usage:
#   ./build.sh                                       # build on the default base
#   HERMES_BASE_IMAGE=ghcr.io/you/hermes:tag ./build.sh   # override the base
#   REEF_NO_CACHE=1 ./build.sh                       # full clean rebuild
#   REEF_MSB_LOAD=1 ./build.sh                       # build, then load into microsandbox
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
docker_bin="${REEF_DOCKER_BIN:-docker}"
msb_bin="${REEF_MSB_BIN:-msb}"
image="${REEF_HERMES_IMAGE:-reef-hm:plugin}"
# Default to the upstream published multi-arch image on Docker Hub
# (docker.io/nousresearch/hermes-agent — see hermes-agent/.github/workflows/docker.yml),
# so a fresh machine needs no hand-built local base. Override with HERMES_BASE_IMAGE.
base="${HERMES_BASE_IMAGE:-nousresearch/hermes-agent:latest}"

# The plugin is copied from this tree, so a rebuild always picks up local edits.
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cp "$here/Dockerfile" "$here/reef-hermes-run.sh" "$here/reef-hermes-init.sh" \
   "$here/cont-init-reef-status.sh" "$here/reef-term.sh" "$tmp/"
cp -R "$repo/extensions/hermes" "$tmp/clawbits-platform"
find "$tmp/clawbits-platform" -type d -name '__pycache__' -prune -exec rm -rf {} +

args=(build --build-arg "HERMES_BASE_IMAGE=${base}" -t "${image}")
[ -n "${REEF_NO_CACHE:-}" ] && args+=(--no-cache)
args+=("$tmp")

echo "reef: building ${image} from ${base}…"
"${docker_bin}" "${args[@]}"

# --- Derive the truthful, self-describing identity (post-build) ---------------
# Probe the built image for the REAL versions. Both extractions are byte-identical
# to what reef-hermes-run.sh reports into status.json (importlib.metadata for the
# hermes-agent distribution; the `version:` key of the plugin's plugin.yaml), so
# the baked label == what the agent later reports — that equality is what makes the
# version-based upgrade signal correct.
probe() { "${docker_bin}" run --rm --entrypoint sh "${image}" -lc "$1" 2>/dev/null; }

installed_hm="$(probe 'python3 -c "from importlib.metadata import version; print(version(\"hermes-agent\"))"' | tr -d '\r')" || installed_hm=""
installed_plugin="$(
  probe "awk -F': *' '/^version:/ {print \$2; exit}' /opt/reef/clawbits-platform/plugin.yaml" \
    | tr -d '"\r'
)" || installed_plugin=""

stack=""
[ -n "${installed_hm}" ] && [ -n "${installed_plugin}" ] && stack="hm${installed_hm}-pl${installed_plugin}"

# Re-stamp truthful labels + REEF_IMAGE_VERSION onto a one-line layer and re-point
# the floating tag (and the immutable stack tag, when derivable) at it. A rebuild of
# the SAME stack lands the SAME reef-hm:hm…-pl… tag (idempotent, no churn).
restamp=(-t "${image}")
[ -n "${stack}" ] && restamp+=(-t "reef-hm:${stack}")
printf 'FROM %s\nENV REEF_IMAGE_VERSION=%s\nLABEL org.opencontainers.image.version="%s"\nLABEL org.reef.hermes.version="%s"\nLABEL org.reef.clawbits-plugin.version="%s"\n' \
  "${image}" "${stack:-unknown}" "${stack:-unknown}" "${installed_hm}" "${installed_plugin}" \
  | "${docker_bin}" build "${restamp[@]}" -

if [ -n "${stack}" ]; then
  echo "reef: done → ${image} + reef-hm:${stack} (hermes=${installed_hm} plugin=${installed_plugin})"
else
  echo "reef: done → ${image} (WARNING: could not probe versions; no stack tag)" >&2
fi

if [ -n "${REEF_MSB_LOAD:-}" ]; then
  echo "reef: loading ${image} into microsandbox…"
  save_tags=("${image}")
  [ -n "${stack}" ] && save_tags+=("reef-hm:${stack}")
  "${docker_bin}" save "${save_tags[@]}" | "${msb_bin}" image load -t "${image}"
  echo "reef: microsandbox image ready → ${image}"
fi
