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

# Bake in the clawbits channel plugin from the clawhub registry. `--pin` locks
# the resolved version so the image is reproducible (bump deliberately, like the
# base tag above). Installed as the image's `node` user, so it lands under the user
# plugin root - kept BEFORE the entrypoint COPY so editing the entrypoint doesn't
# invalidate this (network) layer.
#
# NOTE: this used to pass `--acknowledge-clawhub-risk`, which OpenClaw REMOVED -
# `openclaw plugins install --help` no longer lists it and the CLI hard-errors on
# it ("does not recognize option"), so every image build was failing. The gate moved
# into `security.installPolicy`; a community package now prints a review warning and
# installs rather than aborting. If a future OpenClaw tightens that policy back to
# fail-closed, set `security.installPolicy` here rather than reintroducing a flag.
FROM base AS plugin-clawhub
ARG CLAWBITS_PLUGIN_CACHE_KEY=dev
RUN echo "clawbits plugin cache key=${CLAWBITS_PLUGIN_CACHE_KEY}" \
    && openclaw plugins install clawhub:clawbits-openclaw-plugin --pin

# .plugin-src/ is the working-tree ./plugin, staged into the context by build.sh.
FROM base AS plugin-local
COPY --chown=node:node .plugin-src/ /tmp/clawbits-plugin/
RUN openclaw plugins install /tmp/clawbits-plugin --force

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
# (the plugin one from the cache key); build.sh re-stamps truthful
# org.reef.openclaw.version / org.reef.clawbits-plugin.version post-build by
# probing the built image — the same source entrypoint.sh reports into status.json
# — so a default build is self-describing without a passed --build-arg.
ARG CLAWBITS_PLUGIN_CACHE_KEY=dev
LABEL org.reef.clawbits-plugin.version="${CLAWBITS_PLUGIN_CACHE_KEY}"

# Headless onboard -> foreground gateway (validated). No ports published by
# Reef; the gateway binds loopback inside the microVM.
ENTRYPOINT ["/usr/local/bin/reef-entrypoint.sh"]
