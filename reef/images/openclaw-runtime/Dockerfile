# Reef agent runtime: OpenClaw, run headless in a microVM (no systemd).
#
# Base = the official OpenClaw image (node:24-bookworm-slim + tini; the
# `openclaw` CLI is preinstalled). Multi-arch confirmed on microsandbox: the
# arm64 layer boots natively on the M1 Pro (dev), amd64 on EPYC (prod).
# Pin a concrete version for reproducibility (bump deliberately). Overridable at
# build time (build.sh OPENCLAW_VERSION / the dashboard's build dialog) for true
# "latest openclaw" self-service. The real baked openclaw/plugin versions are
# stamped POST-BUILD by build.sh (it probes the built image), so there's no
# post-FROM re-declare of OPENCLAW_VERSION.
ARG OPENCLAW_VERSION=2026.6.10
# Image VARIANT. Upstream publishes a `-browser` build of every version alongside
# the plain one; it is the same OpenClaw plus a real Chromium and its shared
# libraries/fonts, which the plain image does NOT ship (it bundles the Playwright
# JS but no browser binary, so OpenClaw's `browser` tool is dead on arrival there).
# Default to `-browser` so agents get browser automation; set to "" for a slim
# build without it. If a pinned version has no `-browser` tag the FROM fails loudly
# at pull time, which is the intended behaviour - do not silently fall back.
ARG OPENCLAW_IMAGE_VARIANT=-browser
# BuildKit builds ONLY the selected stage, so a default build never needs .plugin-src/.
ARG CLAWBITS_PLUGIN_STAGE=plugin-clawhub
FROM ghcr.io/openclaw/openclaw:${OPENCLAW_VERSION}${OPENCLAW_IMAGE_VARIANT} AS base

# Bake in the clawbits channel plus its tools/services companion. The channel is
# resolved first; the companion is then installed at that EXACT version. This
# avoids a split release's publication window producing a mismatched image.
# CLAWBITS_PLUGIN_VERSION pins both packages when explicitly supplied. Installed
# as the image's `node` user, so they land under the user plugin root - kept BEFORE
# the entrypoint COPY so editing the entrypoint doesn't invalidate this network
# layer.
#
# NOTE: install gating has flip-flopped upstream THREE times now, so every flag
# below is probed from `--help` rather than assumed. This RUN has to keep working
# on both an old pinned OPENCLAW_VERSION and a current one.
#
#  1. `--acknowledge-clawhub-risk` existed, was REMOVED (the CLI hard-errored on
#     it, so it was dropped here), then 2026.7.1-2 brought it back FAIL-CLOSED: a
#     release with ClawHub scan findings (e.g. 0.15.11's capability advisory,
#     flagged Aug 2026) aborts the install unless it is passed. In 2026.8 ("2.0")
#     the option is gone AGAIN and its role belongs to
#     `--acknowledge-install-policy-warning`, so both names are probed.
#  2. `--accept-capabilities` is NEW in 2026.8 and is REQUIRED for us: OpenClaw
#     computes a declared-surface review per external plugin and throws
#     ManagedPluginLifecycleError unless an operator accepts it. A Docker RUN has
#     no TTY, so it gets no consent handler at all. Clawbits is not in OpenClaw's
#     official plugin/channel catalogs, so it gets no `official` exemption.
#  3. `--pin` is REJECTED in 2026.8 for `clawhub:` refs -
#     `src/cli/plugins-install-preflight.ts` allows it only for npm/official/
#     bundled sources ("--pin is only supported with npm registry installs").
#     It cannot be probed from `--help` (the option still exists, it is the
#     SOURCE that is refused), and preflight rejects before any staging or
#     network work, so the cheap and version-agnostic form is: try with --pin,
#     fall back without. A genuine failure fails both attempts. On 2026.8 pin the
#     version in the SPEC instead, which is what the tools install already does.
#
# Deliberately NOT solved via `security.installPolicy`: this stage's $HOME
# persists into the final image, so a config-level bypass would also weaken the
# RUNTIME install policy for every agent, while these flags are scoped to this
# one invocation. They only acknowledge findings for our own first-party plugin -
# when ClawHub flags a release, review the scan, don't just assume noise.
FROM base AS plugin-clawhub
ARG CLAWBITS_PLUGIN_CACHE_KEY=dev
ARG CLAWBITS_PLUGIN_VERSION=
RUN echo "clawbits plugin cache key=${CLAWBITS_PLUGIN_CACHE_KEY}" \
    && install_help="$(openclaw plugins install --help 2>/dev/null || true)"; \
    ack_flag=""; \
    if printf '%s' "$install_help" | grep -q -- --acknowledge-clawhub-risk; then \
      ack_flag="--acknowledge-clawhub-risk"; \
    fi; \
    if printf '%s' "$install_help" | grep -q -- --acknowledge-install-policy-warning; then \
      ack_flag="${ack_flag} --acknowledge-install-policy-warning"; \
    fi; \
    cap_flag=""; \
    if printf '%s' "$install_help" | grep -q -- --accept-capabilities; then \
      cap_flag="--accept-capabilities"; \
    fi; \
    channel_ref="clawhub:clawbits-openclaw-plugin"; \
    if [ -n "${CLAWBITS_PLUGIN_VERSION}" ]; then \
      channel_ref="${channel_ref}@${CLAWBITS_PLUGIN_VERSION}"; \
    fi; \
    openclaw plugins install "${channel_ref}" --pin ${ack_flag} ${cap_flag} \
      || openclaw plugins install "${channel_ref}" ${ack_flag} ${cap_flag}; \
    resolved_plugin_version="${CLAWBITS_PLUGIN_VERSION}"; \
    if [ -z "${resolved_plugin_version}" ]; then \
      resolved_plugin_version="$(openclaw plugins list --json 2>/dev/null \
        | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);const p=(j.plugins||[]).find(x=>x&&x.id==="clawbits");if(p&&p.version)process.stdout.write(String(p.version))}catch{}})')"; \
    fi; \
    [ -n "${resolved_plugin_version}" ] \
      || { echo "could not resolve installed clawbits channel version" >&2; exit 1; }; \
    openclaw plugins install "clawhub:clawbits-openclaw-tools@${resolved_plugin_version}" ${ack_flag} ${cap_flag}

# .plugin-src/{channel,tools} are standalone working-tree artifacts staged by
# build.sh. Installing both exercises the same package boundary as ClawHub.
#
# Local-path installs need the 2026.8 consent flag even more than ClawHub ones:
# the install record pins no artifact integrity for a path source, so OpenClaw
# can never prove the new bytes are ones already approved and asks EVERY time.
FROM base AS plugin-local
COPY --chown=node:node .plugin-src/channel/ /tmp/clawbits-channel/
COPY --chown=node:node .plugin-src/tools/ /tmp/clawbits-tools/
RUN cap_flag=""; \
    if openclaw plugins install --help 2>/dev/null | grep -q -- --accept-capabilities; then \
      cap_flag="--accept-capabilities"; \
    fi; \
    openclaw plugins install /tmp/clawbits-channel --force ${cap_flag} \
      && openclaw plugins install /tmp/clawbits-tools --force ${cap_flag}

FROM ${CLAWBITS_PLUGIN_STAGE}

# Everything below needs root (writes to /usr/bin, /usr/local/bin, /etc), then we
# drop back to the image's non-root `node` user. The agent NEVER runs as root and
# `sudo` is deliberately NOT installed: with egress open, exec unrestricted and
# $HOME writable, the agent can already bootstrap user-scoped tooling (uv, npm -g
# with a user prefix), so root would only add system-path installs in exchange for
# permanent in-guest root. Bake what agents need here instead.
USER root

# Agent userland. The base is node:24-bookworm-slim, which ships only
# `ca-certificates curl git hostname lsof openssl procps python3 tini` - so the
# common tools OpenClaw's bundled skills reach for are missing, and the ttyd shell
# has no pager at all (`git log`/`git diff` are unusable without `less`).
# --no-install-recommends keeps this ~40 MB. ffmpeg is deliberately NOT here: it is
# the ~100 MB item and only buys voice-note transcoding.
RUN set -eux; \
    apt-get update; \
    apt-get install -o Acquire::Retries=3 -y --no-install-recommends \
      ripgrep jq less unzip zip xz-utils file gnupg vim-tiny python3-pip python3-venv; \
    rm -rf /var/lib/apt/lists/*

# Bake in ttyd — a tiny static web-terminal server (xterm.js over WebSocket).
# Reef launches it from the entrypoint (only when REEF_TERMINAL_ENABLE is set)
# so an agent's OWNER can configure provider/model/channels with the real CLI via
# Reef's web-UI exposure. ttyd is not in apt on bookworm-slim, so fetch the per-arch
# static binary — via node (already in the base image). Pinned by VERSION *and*
# sha256: this binary is fetched over the network and then executed in every
# customer agent, so an unverified download would be an unsigned-code path into the
# image. Bump the version and BOTH hashes together.
ARG TTYD_VERSION=1.7.7
ARG TTYD_SHA256_AMD64=8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55
ARG TTYD_SHA256_ARM64=b38acadd89d1d396a0f5649aa52c539edbad07f4bc7348b27b4f4b7219dd4165
ARG TARGETARCH
RUN set -eux; \
    arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    case "$arch" in \
      amd64) ttyd_asset=x86_64; ttyd_sha="${TTYD_SHA256_AMD64}" ;; \
      arm64) ttyd_asset=aarch64; ttyd_sha="${TTYD_SHA256_ARM64}" ;; \
      *) echo "unsupported arch: $arch" >&2; exit 1 ;; \
    esac; \
    url="https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.${ttyd_asset}"; \
    node -e 'const fs=require("fs");(async()=>{const r=await fetch(process.argv[1]);if(!r.ok)throw new Error("ttyd download failed: HTTP "+r.status);fs.writeFileSync("/usr/local/bin/ttyd",Buffer.from(await r.arrayBuffer()))})().catch(e=>{console.error(e);process.exit(1)})' "$url"; \
    echo "${ttyd_sha}  /usr/local/bin/ttyd" | sha256sum -c -; \
    chmod 0755 /usr/local/bin/ttyd; \
    ttyd --version

# GitHub CLI, staged OFF the default PATH at /opt/reef/gh-bin. The entrypoint
# symlinks it into ~/.local/bin only for agents granted the `gh` capability
# (reef.capabilities), so an ungranted agent does not find `gh` by name.
#
# Be honest about what that gate is: the binary is still on disk at a known
# absolute path, and the agent has unrestricted exec, so this is ERGONOMICS, not
# containment. The thing that actually gates GitHub is the CREDENTIAL - `gh` is
# inert without a token, and reef injects none. Do not treat the symlink as a
# security boundary. (Staged rather than omitted because the image is shared by
# the whole fleet; per-agent apt installs are not a thing.)
ARG GH_VERSION=2.63.2
RUN set -eux; \
    arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    case "$arch" in \
      amd64) gh_asset=linux_amd64 ;; \
      arm64) gh_asset=linux_arm64 ;; \
      *) echo "unsupported arch: $arch" >&2; exit 1 ;; \
    esac; \
    url="https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_${gh_asset}.tar.gz"; \
    mkdir -p /opt/reef/gh-bin /tmp/gh; \
    node -e 'const fs=require("fs");(async()=>{const r=await fetch(process.argv[1]);if(!r.ok)throw new Error("gh download failed: HTTP "+r.status);fs.writeFileSync("/tmp/gh/gh.tgz",Buffer.from(await r.arrayBuffer()))})().catch(e=>{console.error(e);process.exit(1)})' "$url"; \
    tar -xzf /tmp/gh/gh.tgz -C /tmp/gh --strip-components=1; \
    install -m 0755 /tmp/gh/bin/gh /opt/reef/gh-bin/gh; \
    rm -rf /tmp/gh; \
    /opt/reef/gh-bin/gh --version

# PATH for user-scoped installs, in BOTH directions. `ENV PATH` below covers the
# gateway process (and therefore the agent's own exec tool), but the ttyd terminal
# runs `bash -l`, and /etc/profile RESETS PATH — so without this drop-in the human
# owner's shell cannot see anything the agent installed, which is a confusing split
# brain. Keep the two lists in sync.
RUN printf '%s\n' \
      '# Reef: keep user-scoped install dirs on PATH for login shells (see Dockerfile).' \
      'PATH="/home/node/.npm-global/bin:/home/node/.local/bin:$PATH"' \
      'export PATH' \
      > /etc/profile.d/reef-path.sh \
    && chmod 0644 /etc/profile.d/reef-path.sh

USER node

# Let the agent `npm i -g` without root: the default prefix (/usr/local/lib) is
# root-owned and fails EACCES. A user prefix makes global installs just work.
ENV NPM_CONFIG_PREFIX=/home/node/.npm-global
ENV PATH=/home/node/.npm-global/bin:/home/node/.local/bin:$PATH
RUN mkdir -p /home/node/.npm-global/bin /home/node/.local/bin

# Pre-create OpenClaw's auth-profile secrets dir (XDG config; the official
# compose mounts it as OPENCLAW_AUTH_PROFILE_SECRET_DIR) so it exists NODE-OWNED
# in the image: Reef mounts a per-agent named volume here ("reef-<id>-config",
# see reef/profiles.py extra_mounts), and docker seeds a fresh volume's root
# from the image path — ownership included. Without this the mountpoint would
# materialize root-owned and OpenClaw couldn't write credentials.
RUN mkdir -p /home/node/.config/openclaw

# The Reef web-terminal entry: a real shell by default (reef-term.sh → bash -l),
# with a REEF_TERMINAL_SHELL=openclaw toggle to the narrow OpenClaw-only shell
# (reef-term.mjs). Kept before the entrypoint COPY so editing the entrypoint
# doesn't re-COPY these.
COPY --chmod=0755 reef-term.sh /usr/local/bin/reef-term.sh
COPY --chmod=0644 reef-term.mjs /usr/local/bin/reef-term.mjs

COPY --chmod=0755 entrypoint.sh /usr/local/bin/reef-entrypoint.sh

# reef reads REEF_FEATURES off `inspect` to pick in-place restart vs recreate, so it
# must only claim env-file on an image whose entrypoint carries reef_apply_env_file.
ENV REEF_FEATURES=env-file
ENV REEF_ENV_DIR=/home/node/.reef-env

# Reef runtime-image version. A `dev` placeholder here; build.sh OVERWRITES it
# post-build with the derived stack identity (oc<openclaw>-pl<plugin>) once it has
# probed the real versions. The entrypoint reports it in status.json so the
# dashboard shows which image a VM is on. After the COPY so the cheap tail
# rebuilds fast.
ARG REEF_IMAGE_VERSION=dev
ENV REEF_IMAGE_VERSION=${REEF_IMAGE_VERSION}
LABEL org.opencontainers.image.version="${REEF_IMAGE_VERSION}"

# Baked component versions for the dashboard's Images list. These are PLACEHOLDERS
# (the plugin one from the cache key); build.sh re-stamps truthful OpenClaw,
# channel, and companion labels post-build by probing the built image — the same
# source entrypoint.sh reports into status.json — so a default build is
# self-describing without a passed --build-arg.
ARG CLAWBITS_PLUGIN_CACHE_KEY=dev
LABEL org.reef.clawbits-plugin.version="${CLAWBITS_PLUGIN_CACHE_KEY}"
LABEL org.reef.clawbits-tools.version="${CLAWBITS_PLUGIN_CACHE_KEY}"

# Headless onboard -> foreground gateway (validated). No ports published by
# Reef; the gateway binds loopback inside the microVM.
ENTRYPOINT ["/usr/local/bin/reef-entrypoint.sh"]
