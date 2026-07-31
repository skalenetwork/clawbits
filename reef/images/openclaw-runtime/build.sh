#!/usr/bin/env bash
# Build the Reef OpenClaw runtime image. Image identity is DERIVED from what
# actually landed: after the build we probe the image for the real openclaw +
# clawbits-plugin versions and stamp an immutable, self-describing tag
# reef-oc:oc<openclaw>-pl<plugin> plus the floating reef-oc:plugin tag Reef boots
# by default. No hand-bumped VERSION file — a rebuild of the same stack overwrites
# the same tag (no churn); a component bump yields a new tag.
#
# Usage:
#   ./build.sh                                  # build latest (cached base, fresh plugin)
#   OPENCLAW_VERSION=2026.7.0 ./build.sh        # override the base openclaw tag
#   CLAWBITS_PLUGIN_VERSION=0.8.1 ./build.sh    # pin the plugin (deterministic, cacheable)
#   REEF_NO_CACHE=1 ./build.sh                  # full clean rebuild (force fresh)
#   REEF_MSB_LOAD=1 ./build.sh                  # build, then load into microsandbox
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
docker_bin="${REEF_DOCKER_BIN:-docker}"
msb_bin="${REEF_MSB_BIN:-msb}"
image="${REEF_OPENCLAW_IMAGE:-reef-oc:plugin}"
# OPENCLAW_VERSION overrides the Dockerfile's pinned base tag (true "latest
# openclaw"); empty ⇒ the Dockerfile default.
openclaw_version="${OPENCLAW_VERSION:-}"

# Smart cache for the clawbits plugin layer. The Dockerfile's CLAWBITS_PLUGIN_CACHE_KEY
# ARG sits right before `openclaw plugins install … --pin`, which ALWAYS resolves
# clawhub's latest at build time. Derive the key so:
#   - a PINNED plugin ⇒ deterministic key (reproducible, layer cacheable);
#   - REEF_NO_CACHE (force fresh) ⇒ a fixed key (the --no-cache flag busts everything);
#   - otherwise ⇒ a timestamp nonce that busts ONLY the plugin layer + everything
#     after it, so the expensive base image / ttyd layers stay cached while every
#     default build still re-resolves the latest plugin.
if [ -n "${CLAWBITS_PLUGIN_VERSION:-}" ]; then
  cache_key="${CLAWBITS_PLUGIN_VERSION}"
elif [ -n "${REEF_NO_CACHE:-}" ]; then
  cache_key="nocache"
else
  cache_key="$(date +%s)"
fi

args=(
  build
  --build-arg "CLAWBITS_PLUGIN_CACHE_KEY=${cache_key}"
)
[ -n "${openclaw_version}" ] && args+=(--build-arg "OPENCLAW_VERSION=${openclaw_version}")
args+=(-t "${image}")
[ -n "${REEF_NO_CACHE:-}" ] && args+=(--no-cache)
args+=("${here}")

echo "reef: building ${image} (openclaw=${openclaw_version:-<pinned>} plugin-cache-key=${cache_key})…"
"${docker_bin}" "${args[@]}"

# --- Derive the truthful, self-describing identity (post-build) ---------------
# Probe the built image for the REAL versions. The extraction is byte-identical to
# what entrypoint.sh reports into status.json (openclaw --version | sed 's/^OpenClaw //'
# and the clawbits plugin from `plugins list --json`), so the baked label == what
# the agent later reports — that equality is what makes the version-based upgrade
# signal correct. Always runs, so a default build is self-describing too.
probe() { "${docker_bin}" run --rm --entrypoint sh "${image}" -lc "$1" 2>/dev/null; }

installed_oc="$(probe 'openclaw --version 2>/dev/null' | sed 's/^OpenClaw //' | tr -d '\r')" || installed_oc=""
[ -n "${installed_oc}" ] || installed_oc="${openclaw_version}"
installed_plugin="$(
  probe 'openclaw plugins list --json 2>/dev/null' \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);const p=(j.plugins||[]).find(x=>x&&x.id==="clawbits");process.stdout.write(p&&p.version?String(p.version):"")}catch{}})' 2>/dev/null
)" || installed_plugin=""

stack=""
[ -n "${installed_oc}" ] && [ -n "${installed_plugin}" ] && stack="oc${installed_oc}-pl${installed_plugin}"

# Re-stamp truthful labels + REEF_IMAGE_VERSION onto a one-line layer and re-point
# the floating tag (and the immutable stack tag, when derivable) at it. A rebuild
# of the SAME stack lands the SAME reef-oc:oc…-pl… tag (idempotent, no churn).
restamp=(-t "${image}")
[ -n "${stack}" ] && restamp+=(-t "reef-oc:${stack}")
printf 'FROM %s\nENV REEF_IMAGE_VERSION=%s\nLABEL org.opencontainers.image.version="%s"\nLABEL org.reef.openclaw.version="%s"\nLABEL org.reef.clawbits-plugin.version="%s"\n' \
  "${image}" "${stack:-unknown}" "${stack:-unknown}" "${installed_oc}" "${installed_plugin}" \
  | "${docker_bin}" build "${restamp[@]}" -

if [ -n "${stack}" ]; then
  echo "reef: done → ${image} + reef-oc:${stack} (openclaw=${installed_oc} plugin=${installed_plugin})"
else
  echo "reef: done → ${image} (WARNING: could not probe versions; no stack tag)" >&2
fi

if [ -n "${REEF_MSB_LOAD:-}" ]; then
  echo "reef: loading ${image} into microsandbox…"
  save_tags=("${image}")
  [ -n "${stack}" ] && save_tags+=("reef-oc:${stack}")
  "${docker_bin}" save "${save_tags[@]}" | "${msb_bin}" image load -t "${image}"
  echo "reef: microsandbox image ready → ${image}"
fi
