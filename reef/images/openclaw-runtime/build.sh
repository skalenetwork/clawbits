#!/usr/bin/env bash
# Build the Reef OpenClaw runtime image. Image identity is DERIVED from what
# actually landed: after the build we probe the image for the real openclaw +
# matching clawbits channel/companion versions and stamp an immutable,
# self-describing tag reef-oc:oc<openclaw>-pl<plugin> plus the floating
# reef-oc:plugin tag Reef boots
# by default. No hand-bumped VERSION file — a rebuild of the same stack overwrites
# the same tag (no churn); a component bump yields a new tag.
#
# Usage:
#   ./build.sh                                  # build latest (cached base, fresh plugin)
#   OPENCLAW_VERSION=2026.7.0 ./build.sh        # override the base openclaw tag
#   CLAWBITS_PLUGIN_VERSION=0.17.18 ./build.sh  # pin both plugins (deterministic, cacheable)
#   CLAWBITS_PLUGIN_LOCAL=1 ./build.sh          # bake the WORKING-TREE ./plugin (own tag: reef-oc:local-plugin)
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

# Own tag + `-local` stack suffix, so a working-tree image can never overwrite a
# clawhub build's tag.
plugin_stage="plugin-clawhub"
stack_suffix=""
if [ -n "${CLAWBITS_PLUGIN_LOCAL:-}" ]; then
  plugin_dir="$(cd "${here}/../../.." && pwd)/plugin"
  if command -v bun >/dev/null; then pm=bun; js=bun; else pm=npm; js=node; fi
  echo "reef: building ${plugin_dir} with ${pm}…"
  (cd "${plugin_dir}" && "${pm}" run build)
  stage_dir="${here}/.plugin-src"
  trap 'rm -rf "${stage_dir}"' EXIT
  rm -rf "${stage_dir}"
  mkdir -p "${stage_dir}"
  (cd "${plugin_dir}" \
    && "${js}" stage-channel.mjs "${stage_dir}/channel" \
    && "${js}" stage-tools.mjs "${stage_dir}/tools")
  plugin_stage="plugin-local"
  stack_suffix="-local"
  image="reef-oc:local-plugin"
fi

# Smart cache for the clawbits plugin layer. The Dockerfile's
# CLAWBITS_PLUGIN_CACHE_KEY ARG sits right before both installs. With no explicit
# version, the channel resolves latest and the companion is pinned to that exact
# version. Derive the key so:
#   - PINNED plugins ⇒ deterministic key (reproducible, layer cacheable);
#   - REEF_NO_CACHE (force fresh) ⇒ a fixed key (the --no-cache flag busts everything);
#   - otherwise ⇒ a timestamp nonce that busts ONLY the plugin layer + everything
#     after it, so the expensive base image / ttyd layers stay cached while every
#     default build still re-resolves the latest plugin.
if [ -n "${CLAWBITS_PLUGIN_LOCAL:-}" ]; then
  cache_key="local"
elif [ -n "${CLAWBITS_PLUGIN_VERSION:-}" ]; then
  cache_key="${CLAWBITS_PLUGIN_VERSION}"
elif [ -n "${REEF_NO_CACHE:-}" ]; then
  cache_key="nocache"
else
  cache_key="$(date +%s)"
fi

args=(
  build
  --build-arg "CLAWBITS_PLUGIN_CACHE_KEY=${cache_key}"
  --build-arg "CLAWBITS_PLUGIN_VERSION=${CLAWBITS_PLUGIN_VERSION:-}"
  --build-arg "CLAWBITS_PLUGIN_STAGE=${plugin_stage}"
)
[ -n "${openclaw_version}" ] && args+=(--build-arg "OPENCLAW_VERSION=${openclaw_version}")
args+=(-t "${image}")
[ -n "${REEF_NO_CACHE:-}" ] && args+=(--no-cache)
args+=("${here}")

echo "reef: building ${image} (openclaw=${openclaw_version:-<pinned>} plugin-source=${plugin_stage#plugin-} plugin-cache-key=${cache_key})…"
"${docker_bin}" "${args[@]}"

# --- Derive the truthful, self-describing identity (post-build) ---------------
# Probe the built image for the REAL versions. The extraction is byte-identical to
# what entrypoint.sh reports into status.json (openclaw --version | sed 's/^OpenClaw //'
# and both clawbits plugins from `plugins list --json`), so the baked labels equal
# what the agent later reports. The two plugin versions MUST match; a partial or
# mismatched split image is rejected here. Always runs, so a default build is
# self-describing too.
probe() { "${docker_bin}" run --rm --entrypoint sh "${image}" -lc "$1" 2>/dev/null; }

installed_oc="$(probe 'openclaw --version 2>/dev/null' | sed 's/^OpenClaw //' | tr -d '\r')" || installed_oc=""
[ -n "${installed_oc}" ] || installed_oc="${openclaw_version}"
installed_plugin="$(
  probe 'openclaw plugins list --json 2>/dev/null' \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);const p=(j.plugins||[]).find(x=>x&&x.id==="clawbits");process.stdout.write(p&&p.version?String(p.version):"")}catch{}})' 2>/dev/null
)" || installed_plugin=""
installed_tools="$(
  probe 'openclaw plugins list --json 2>/dev/null' \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);const p=(j.plugins||[]).find(x=>x&&x.id==="clawbits-tools");process.stdout.write(p&&p.version?String(p.version):"")}catch{}})' 2>/dev/null
)" || installed_tools=""

if [ -z "${installed_plugin}" ] || [ -z "${installed_tools}" ]; then
  echo "reef: ERROR: built image is missing a clawbits channel or companion plugin" >&2
  exit 1
fi
if [ "${installed_plugin}" != "${installed_tools}" ]; then
  echo "reef: ERROR: split plugin version mismatch (channel=${installed_plugin}, tools=${installed_tools})" >&2
  exit 1
fi

stack=""
[ -n "${installed_oc}" ] && stack="oc${installed_oc}-pl${installed_plugin}${stack_suffix}"

# Re-stamp truthful labels + REEF_IMAGE_VERSION onto a one-line layer and re-point
# the floating tag (and the immutable stack tag, when derivable) at it. A rebuild
# of the SAME stack lands the SAME reef-oc:oc…-pl… tag (idempotent, no churn).
restamp=(-t "${image}")
[ -n "${stack}" ] && restamp+=(-t "reef-oc:${stack}")
printf 'FROM %s\nENV REEF_IMAGE_VERSION=%s\nLABEL org.opencontainers.image.version="%s"\nLABEL org.reef.openclaw.version="%s"\nLABEL org.reef.clawbits-plugin.version="%s"\nLABEL org.reef.clawbits-tools.version="%s"\n' \
  "${image}" "${stack:-unknown}" "${stack:-unknown}" "${installed_oc}" "${installed_plugin}" "${installed_tools}" \
  | "${docker_bin}" build "${restamp[@]}" -

if [ -n "${stack}" ]; then
  echo "reef: done → ${image} + reef-oc:${stack} (openclaw=${installed_oc} channel=${installed_plugin} tools=${installed_tools} from ${plugin_stage#plugin-})"
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
