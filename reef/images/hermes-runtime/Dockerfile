# Reef Hermes runtime: upstream Hermes Agent + baked Clawbits platform plugin.
#
# Base = the upstream published multi-arch image on Docker Hub
# (docker.io/nousresearch/hermes-agent — pushed by hermes-agent's
# .github/workflows/docker.yml). No hand-built local base needed; a fresh
# machine can `./build.sh` straight away. Override with HERMES_BASE_IMAGE
# (e.g. a locally built `hermes-agent` for development).
# NOTE: `:latest` means this image is not reproducible — two builds a week apart
# can differ. Deliberate for now (reef/image_ops.py treats the hermes base as
# unpinned by design); pass HERMES_BASE_IMAGE=<repo>@sha256:… for a fixed build.
ARG HERMES_BASE_IMAGE=nousresearch/hermes-agent:latest
FROM ${HERMES_BASE_IMAGE}

USER root

# nginx fronts the dashboard with HTTP basic auth (reef's one-time exposure
# password) and proxies to it on loopback — see reef_start_auth_proxy in
# reef-hermes-run.sh. It is what lets us drop hermes' `--insecure`, which would
# otherwise disable the dashboard's auth gate and serve its session token (and thus
# the agent's API keys, via /api/reveal) to anyone who can reach the port.
# It runs UNPRIVILEGED as the `hermes` user, wholly out of /tmp, so no state under
# /var/{log,lib}/nginx is needed.
RUN apt-get update \
    && apt-get install -y --no-install-recommends nginx \
    && rm -rf /var/lib/apt/lists/*

# ttyd — the authenticated web terminal reef exposes as `terminal_url`. Not a
# convenience: the ChatGPT-subscription provider (openai-codex) is OAuth, so reef holds
# no token and injects no key — the owner must complete a device-code login INSIDE the
# guest (`hermes login --provider openai-codex --no-browser`), and this is the only
# place they can run it (the dashboard's chat tab drives the agent over /api/pty, not a
# shell). Not packaged in Debian trixie, so fetch the release binary — same approach and
# same pinned version as the OpenClaw runtime.
ARG TTYD_VERSION=1.7.7
ARG TARGETARCH
RUN set -eux; \
    arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    case "$arch" in \
      amd64) ttyd_asset=x86_64 ;; \
      arm64) ttyd_asset=aarch64 ;; \
      *) echo "unsupported arch for ttyd: $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /usr/local/bin/ttyd \
      "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.${ttyd_asset}"; \
    chmod 0755 /usr/local/bin/ttyd; \
    ttyd --version

COPY --chmod=0755 reef-term.sh /usr/local/bin/reef-term.sh
COPY --chown=hermes:hermes clawbits-platform /opt/reef/clawbits-platform
COPY --chmod=0755 reef-hermes-run.sh /usr/local/bin/reef-hermes-run
COPY --chmod=0755 reef-hermes-init.sh /usr/local/bin/reef-hermes-init
# Runs as root under s6's legacy cont-init, before the drop to the `hermes` user:
# hands reef's root-owned status volume to the agent so it can report versions.
COPY --chmod=0755 cont-init-reef-status.sh /etc/cont-init.d/50-reef-status

ARG REEF_IMAGE_VERSION=dev
ENV REEF_IMAGE_VERSION=${REEF_IMAGE_VERSION}
LABEL org.opencontainers.image.version="${REEF_IMAGE_VERSION}"

# Keep the upstream ENTRYPOINT — s6-overlay:
#   ["/init", "/opt/hermes/docker/main-wrapper.sh"]
# /init runs the cont-init bootstrap (ownership on /opt/data), populates
# /run/s6/container_environment (main-wrapper's with-contenv shebang needs it, since
# /init scrubs the environ), then runs the CMD below as its "main program";
# main-wrapper drops root -> hermes via s6-setuidgid and execs it.
#
# That chain is DOCKER-only: microsandbox ignores ENTRYPOINT/CMD and execs
# `--init <path>` instead. reef-hermes-init reproduces the chain above in one
# executable for that path — see reef-hermes-init.sh and HermesProfile.init.
CMD ["/usr/local/bin/reef-hermes-run"]
