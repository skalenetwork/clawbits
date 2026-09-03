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
#   OPENCLAW_IMAGE_VARIANT= ./build.sh          # plain base (no Chromium); default is -browser
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
  # --vendor-deps: the Dockerfile installs these staged directories by PATH, and
  # an OpenClaw directory install is a plain copy with no dependency step. The
  # tools package imports `typebox` at module scope, so without vendoring it the
  # companion installs and then loads with `status: error, missing typebox`
  # while the channel looks fine. Published artifacts must NOT vendor — managed
  # npm/ClawHub installs run their own `npm install`.
  (cd "${plugin_dir}" \
    && "${js}" stage-channel.mjs "${stage_dir}/channel" --vendor-deps \
    && "${js}" stage-tools.mjs "${stage_dir}/tools" --vendor-deps)
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
# Upstream publishes `-browser` alongside the plain image, but not necessarily
# for every version. The Dockerfile defaults to `-browser` and fails loudly at
# pull time when that tag is absent, which is correct — but without this
# passthrough the only way to fall back to the plain image was to edit the
# Dockerfile. Set OPENCLAW_IMAGE_VARIANT="" for a slim build (no Chromium, so
# OpenClaw's `browser` tool is dead in that image).
[ -n "${OPENCLAW_IMAGE_VARIANT+set}" ] &&
  args+=(--build-arg "OPENCLAW_IMAGE_VARIANT=${OPENCLAW_IMAGE_VARIANT}")
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

# Take only the VERSION token. OpenClaw 2026.8 ("2.0") appends a build SHA —
# `OpenClaw 2026.8.1 (ea80657)` where 2026.6.10 printed `OpenClaw 2026.6.10` —
# and stripping just the prefix leaves "2026.8.1 (ea80657)", which contains a
# space and parentheses. That is not a legal Docker reference, so the re-stamp
# below died with `invalid tag "reef-oc:oc2026.8.1 (ea80657)-pl…"` AFTER the
# image had already built. Must stay byte-identical to entrypoint.sh.
installed_oc="$(probe 'openclaw --version 2>/dev/null' | sed 's/^OpenClaw //' | awk '{print $1}' | tr -d '\r')" || installed_oc=""
[ -n "${installed_oc}" ] || installed_oc="${openclaw_version}"
# A plugin reports a `version` as soon as its manifest is copied, whether or not
# it actually LOADED. `status` ("loaded" | "disabled" | "error") is the field
# that distinguishes them, so the probe demands it: a companion missing a
# runtime dependency installs happily, reports its version, and then fails at
# import — which is precisely how an image shipped with a dead tools plugin
# while this probe reported success.
plugin_status_probe() {
  probe 'openclaw plugins list --json 2>/dev/null' \
    | node -e '
        const id = process.argv[1];
        let s = "";
        process.stdin.on("data", (d) => (s += d)).on("end", () => {
          try {
            const j = JSON.parse(s);
            const p = (j.plugins || []).find((x) => x && x.id === id);
            if (!p) return;
            // "|" not a tab: a literal tab in this heredoc is one reformat
            // away from becoming spaces, which would silently break the split.
            process.stdout.write(`${p.status ?? "unknown"}|${p.version ?? ""}`);
          } catch {}
        });
      ' "$1" 2>/dev/null
}

require_loaded_plugin() {
  # `local` matters here: this runs inside $( ), and `status`/`version` are
  # generic enough to collide with the caller's scope on a later edit.
  local id raw status version
  id="$1"
  raw="$(plugin_status_probe "${id}")" || raw=""
  status="${raw%%|*}"
  version="${raw##*|}"
  if [ -z "${raw}" ]; then
    echo "reef: ERROR: built image is missing the '${id}' plugin" >&2
    exit 1
  fi
  if [ "${status}" != "loaded" ]; then
    echo "reef: ERROR: '${id}' is installed but not loaded (status=${status})." >&2
    echo "reef:        A path install copies the directory and never installs" >&2
    echo "reef:        dependencies — check that staging ran with --vendor-deps." >&2
    "${docker_bin}" run --rm --entrypoint sh "${image}" -lc \
      "openclaw plugins inspect ${id} --runtime 2>&1 | head -30" >&2 || true
    exit 1
  fi
  printf '%s' "${version}"
}

installed_plugin="$(require_loaded_plugin clawbits)"
installed_tools="$(require_loaded_plugin clawbits-tools)"

if [ -z "${installed_plugin}" ] || [ -z "${installed_tools}" ]; then
  echo "reef: ERROR: built image is missing a clawbits channel or companion version" >&2
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
