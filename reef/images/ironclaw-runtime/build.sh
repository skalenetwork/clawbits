#!/usr/bin/env bash
# Build the Reef IronClaw runtime image: an IronClaw base + the baked clawbits
# WASM channel + the headless entrypoint. Image identity is DERIVED from what
# landed: we stamp an immutable, self-describing tag reef-ic:ic<ironclaw>-ch<channel>
# plus the floating reef-ic:channel tag Reef boots by default, and bake the same
# stack string as REEF_IMAGE_VERSION so each VM self-reports it (entrypoint writes
# it into status.json). No hand-bumped VERSION file — a rebuild of the same stack
# overwrites the same tag; a base/channel bump yields a new tag.
#
# IronClaw source is a checkout of upstream nearai/ironclaw at <repo_root>/ironclaw
# commit); Reef-specific changes are NOT forked — they live as patches in ./patches
# and are applied on top at build time. This script patches that checkout and
# applies the patches, so a fresh checkout only needs `./build.sh`.
#
# The clawbits channel WASM is built IN-IMAGE by default (the Dockerfile's
# clawbits-image stage compiles ironclaw-channel/ inside docker via a BuildKit
# named context) — the host needs no Rust/wasm toolchain. Set
# wasm32-wasip2 target + wasm-tools) and stage the artifacts for a plain COPY.
#
# Usage:
#   ./build.sh                          # build latest
#   REEF_IRONCLAW_BASE=img ./build.sh   # use a prebuilt IronClaw base image
#   REEF_REBUILD_BASE=1 ./build.sh      # force-rebuild ironclaw:latest from source
#                                       # (REQUIRED after editing the ironclaw source —
#                                       # otherwise an existing base is reused as-is)
#   REEF_NO_CACHE=1 ./build.sh          # clean rebuild
#   REEF_MSB_LOAD=1 ./build.sh          # build, then load into microsandbox
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "${here}/../../.." && pwd)"
docker_bin="${REEF_DOCKER_BIN:-docker}"
msb_bin="${REEF_MSB_BIN:-msb}"
image="${REEF_IRONCLAW_IMAGE:-reef-ic:channel}"

# IronClaw source is expected at <repo_root>/ironclaw (upstream nearai/ironclaw).
# Clone it there yourself, or point REEF_IRONCLAW_BASE at a prebuilt base image.
# Our Reef-specific changes are NOT forked — they live as patches in ./patches
# and are applied on top of that checkout at build time.
ironclaw_dir="${repo_root}/ironclaw"
patches_dir="${here}/patches"

# Apply the Reef patches on top of the IronClaw checkout. Idempotent: a patch
# already present in the tree is skipped, so repeat local builds and a fresh
# CI checkout both converge on the same patched source.
prepare_ironclaw_source() {
  if [ ! -e "${ironclaw_dir}/.git" ] && [ ! -f "${ironclaw_dir}/Cargo.toml" ]; then
    echo "reef: no IronClaw source at ${ironclaw_dir}" >&2
    echo "reef: clone it first, e.g." >&2
    echo "reef:   git clone https://github.com/nearai/ironclaw.git ${ironclaw_dir}" >&2
    echo "reef: or set REEF_IRONCLAW_BASE=<image> to use a prebuilt base." >&2
    return 1
  fi
  [ -d "${patches_dir}" ] || return 0
  for p in "${patches_dir}"/*.patch; do
    [ -e "${p}" ] || continue
    if git -C "${ironclaw_dir}" apply --reverse --check "${p}" >/dev/null 2>&1; then
      echo "reef: patch already applied: $(basename "${p}")"
    elif git -C "${ironclaw_dir}" apply --check "${p}" >/dev/null 2>&1; then
      echo "reef: applying patch: $(basename "${p}")"
      git -C "${ironclaw_dir}" apply "${p}"
    else
      echo "reef: ERROR: patch does not apply cleanly: $(basename "${p}")" >&2
      echo "reef: the ironclaw checkout likely drifted from the expected commit — refresh the patch." >&2
      exit 1
    fi
  done
}

# 1. Ensure an IronClaw base image. Prefer an explicit REEF_IRONCLAW_BASE (taken
#    as-is, never rebuilt here); else build the lean binary-only stage from the
#    patched checkout when the base is ABSENT or REEF_REBUILD_BASE is set.
#    IMPORTANT: an existing `ironclaw:latest` is REUSED by default, so after
#    editing the ironclaw source/patches you MUST pass REEF_REBUILD_BASE=1 (or
#    delete the image) or your changes silently won't ship. SLOW — full Rust build.
base="${REEF_IRONCLAW_BASE:-ironclaw:latest}"
if [ -z "${REEF_IRONCLAW_BASE:-}" ] \
   && { [ -n "${REEF_REBUILD_BASE:-}" ] || ! "${docker_bin}" image inspect "${base}" >/dev/null 2>&1; }; then
  prepare_ironclaw_source
  echo "reef: building IronClaw base '${base}' from ${ironclaw_dir} (slow the first time)…"
  "${docker_bin}" build --target runtime -t "${base}" "${ironclaw_dir}"
fi
ironclaw_version="$("${docker_bin}" run --rm --entrypoint ironclaw "${base}" --version 2>/dev/null | head -1 | awk '{print $NF}')" || ironclaw_version="unknown"

# 2. Channel artifacts (WASM + capabilities + the token-enroll signup helper —
#    IronClaw has no native signup command, so the entrypoint exchanges a
#    one-time signup token for a minted key via the same challenge/known-answers
#    helper the channel installer uses; pure-stdlib python3, no pip).
#
#    The channel is compiled inside the docker build (clawbits-image stage)
#    from the `channel-src` named context; nothing is staged host-side. A
#    second `REEF_CHANNEL_BUILD=host` mode used to compile it with the host
#    toolchain — removed in the pre-open-source cleanup: it needed host Rust +
#    wasm32-wasip2 + wasm-tools, no installer or runbook used it, and prod
#    (reef/deploy/install.sh) only ever builds the openclaw runtime.
channel_args=(
  --build-context "channel-src=${repo_root}/ironclaw-channel"
  --build-arg "CLAWBITS_SOURCE=image"
)

# The baked channel-version label, read from the tracked source manifest (both
# modes bake a byte-identical copy of it into the image).
channel_version="$(
  python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("version","unknown"))' \
    "${repo_root}/ironclaw-channel/clawbits.capabilities.json" 2>/dev/null || echo unknown
)"

# Derive the self-describing stack identity from what landed (both versions are
# known before the build) and bake it as REEF_IMAGE_VERSION so the VM self-reports it.
stack="ic${ironclaw_version}-ch${channel_version}"

# 3. Build the reef image.
args=(
  build
  "${channel_args[@]}"
  --build-arg "IRONCLAW_BASE=${base}"
  --build-arg "REEF_IMAGE_VERSION=${stack}"
  --build-arg "IRONCLAW_VERSION=${ironclaw_version}"
  --build-arg "CLAWBITS_CHANNEL_VERSION=${channel_version}"
  -t "${image}"
  -t "reef-ic:${stack}"
)
[ -n "${REEF_NO_CACHE:-}" ] && args+=(--no-cache)
args+=("${here}")

echo "reef: building ${image} (also reef-ic:${stack}) base=${base} ironclaw=${ironclaw_version} channel=${channel_version} channel-build=${channel_mode}…"
"${docker_bin}" "${args[@]}"
echo "reef: done → ${image} + reef-ic:${stack}"

if [ -n "${REEF_MSB_LOAD:-}" ]; then
  echo "reef: loading ${image} into microsandbox…"
  "${docker_bin}" save "${image}" "reef-ic:${stack}" | "${msb_bin}" image load -t "${image}"
  echo "reef: microsandbox image ready → ${image}"
fi
