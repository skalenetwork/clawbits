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
FROM ghcr.io/openclaw/openclaw:${OPENCLAW_VERSION}

# Bake in the clawbits channel plugin from the clawhub registry. `--pin` locks
# the resolved version so the image is reproducible (bump deliberately, like the
# base tag above). `--acknowledge-clawhub-risk` is required for a non-interactive
# install: ClawHub's scan flags this FIRST-PARTY plugin as `suspicious` (large
# local blast radius - it manages cron + does loopback RPC), not malicious, so
# newer openclaw CLIs abort a silent install without the ack. Installed as the
# image's `node` user, so it lands under the user plugin root - kept BEFORE the
# entrypoint COPY so editing the entrypoint doesn't invalidate this (network) layer.
ARG CLAWBITS_PLUGIN_CACHE_KEY=dev
RUN echo "clawbits plugin cache key=${CLAWBITS_PLUGIN_CACHE_KEY}" \
    && openclaw plugins install clawhub:clawbits-openclaw-plugin --pin --acknowledge-clawhub-risk

# Bake in ttyd — a tiny static web-terminal server (xterm.js over WebSocket).
# Reef launches it from the entrypoint (only when REEF_TERMINAL_ENABLE is set)
# to serve a scoped `openclaw`-only shell, so an agent's OWNER can configure
# provider/model/channels with the real CLI via Reef's web-UI exposure. ttyd is
# not in apt on bookworm-slim, so fetch the per-arch static binary — via node
# (already in the base image; no curl/ca-certificates needed). Pinned; bump
# deliberately. Needs root to write /usr/local/bin, then drop back to non-root.
USER root
ARG TTYD_VERSION=1.7.7
ARG TARGETARCH
RUN set -eux; \
    arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    case "$arch" in \
      amd64) ttyd_asset=x86_64 ;; \
      arm64) ttyd_asset=aarch64 ;; \
      *) echo "unsupported arch: $arch" >&2; exit 1 ;; \
    esac; \
    url="https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.${ttyd_asset}"; \
    node -e 'const fs=require("fs");(async()=>{const r=await fetch(process.argv[1]);if(!r.ok)throw new Error("ttyd download failed: HTTP "+r.status);fs.writeFileSync("/usr/local/bin/ttyd",Buffer.from(await r.arrayBuffer()))})().catch(e=>{console.error(e);process.exit(1)})' "$url"; \
    chmod 0755 /usr/local/bin/ttyd; \
    ttyd --version
USER node

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
LABEL org.reef.clawbits-plugin.version="${CLAWBITS_PLUGIN_CACHE_KEY}"

# Headless onboard -> foreground gateway (validated). No ports published by
# Reef; the gateway binds loopback inside the microVM.
ENTRYPOINT ["/usr/local/bin/reef-entrypoint.sh"]
