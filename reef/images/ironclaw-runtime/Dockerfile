# Reef agent runtime: IronClaw, run headless in a microVM (no keychain, no TUI).
#
# Base = an IronClaw image (the `ironclaw` Rust binary preinstalled under
# /usr/local/bin, non-root `ironclaw` user, state dir ~/.ironclaw, gateway on
# :3000). We layer the clawbits integration on top — for IronClaw that's a baked
# WASM *channel* (ironclaw-channel/), the counterpart to OpenClaw's plugin.
#
# The base is built from ../../../ironclaw by build.sh (`--target runtime`, the
# lean binary-only stage) and tagged `ironclaw:latest`; override with
# REEF_IRONCLAW_BASE.
#
# The clawbits channel WASM comes from one of two sources, selected by the
# CLAWBITS_SOURCE build-arg (build.sh sets it from REEF_CHANNEL_BUILD):
#
#   image (default) — the channel-builder stage compiles ironclaw-channel/
#     INSIDE this build, from the `channel-src` named context. The host needs
#     no Rust/wasm toolchain, only Docker with BuildKit (default since Docker
#     23). Requires:  --build-context channel-src=../../../ironclaw-channel
#   host — legacy path: build.sh compiles the channel on the host (Rust +
#     wasm32-wasip2 + wasm-tools) and stages the artifacts into ./channel/ and
#     ./signup/ for a plain COPY. No named context needed.
#
# Both sources converge on the same /staging layout via the `clawbits` alias
# stage, so the final image is identical either way. BuildKit only builds the
# stages the target actually references, so the unused source stage (and its
# context/staged dirs) is skipped entirely.
ARG IRONCLAW_BASE=ironclaw:latest
ARG CLAWBITS_SOURCE=image

# ── Channel source A: build the WASM in-image ────────────────────────────────
# Same rustc as the IronClaw base build (ironclaw/Dockerfile) for consistency.
# Runs on the build platform: the wasm32-wasip2 output is target-independent,
# so no need to emulate the target arch.
FROM --platform=$BUILDPLATFORM rust:1.96-bookworm@sha256:5e2214abe154fe26e39f64488952e5c991eeed1d6d6da7cc8381ae83927f0cfc AS clawbits-image

# wasm-tools as a prebuilt release binary — `cargo install wasm-tools` compiles
# for minutes; the tarball is seconds. Version matches ironclaw/Dockerfile.
ARG WASM_TOOLS_VERSION=1.246.1
ARG BUILDARCH
RUN set -eux; \
    rustup target add wasm32-wasip2; \
    arch="${BUILDARCH:-$(dpkg --print-architecture)}"; \
    case "$arch" in \
      amd64) wt_arch=x86_64 ;; \
      arm64) wt_arch=aarch64 ;; \
      *) echo "unsupported arch: $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/bytecodealliance/wasm-tools/releases/download/v${WASM_TOOLS_VERSION}/wasm-tools-${WASM_TOOLS_VERSION}-${wt_arch}-linux.tar.gz" \
      | tar -xz -C /usr/local/bin --strip-components=1 \
          "wasm-tools-${WASM_TOOLS_VERSION}-${wt_arch}-linux/wasm-tools"; \
    wasm-tools --version

# Only the paths named here are transferred from the channel-src context, so
# a fat local ironclaw-channel/target/ never reaches the daemon.
WORKDIR /build
COPY --from=channel-src Cargo.toml Cargo.lock ./
COPY --from=channel-src wit/ wit/
COPY --from=channel-src src/ src/

# Mirrors ironclaw-channel/build.sh: cargo build, componentize (wasip2 output
# is usually already a component — fall back to a plain copy), strip. Cache
# mounts keep the registry + target across builds; the artifact must be copied
# out of the mount within this RUN.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/build/target \
    set -eux; \
    cargo build --locked --release --target wasm32-wasip2; \
    mkdir -p /staging/channel; \
    raw=target/wasm32-wasip2/release/clawbits_channel.wasm; \
    wasm-tools component new "$raw" -o /staging/channel/clawbits.wasm 2>/dev/null \
      || cp "$raw" /staging/channel/clawbits.wasm; \
    wasm-tools strip /staging/channel/clawbits.wasm -o /staging/channel/clawbits.wasm

# Capabilities manifest + token-enroll signup helper (see the signup COPY in
# the final stage), straight from the channel source. After the build RUN so
# tweaking them never re-runs cargo.
COPY --from=channel-src clawbits.capabilities.json /staging/channel/clawbits.capabilities.json
COPY --from=channel-src onboarding_message.py /staging/signup/onboarding_message.py
COPY --from=channel-src src/known_answers.rs /staging/signup/known_answers.rs

# ── The selected channel source ───────────────────────────────────────────────
FROM clawbits-${CLAWBITS_SOURCE} AS clawbits

# ── Final image ───────────────────────────────────────────────────────────────
FROM ${IRONCLAW_BASE}

# Bake in the clawbits WASM channel + its capabilities manifest. Lands in the
# channels dir IronClaw discovers at boot; the entrypoint then *activates* it
# (the DB `activated_channels` set) and wires the injected CLAWBITS_* into it.
# Placed before the entrypoint COPY so editing the entrypoint doesn't bust this
# layer.
COPY --from=clawbits --chown=ironclaw:ironclaw /staging/channel/clawbits.wasm /home/ironclaw/.ironclaw/channels/clawbits.wasm
COPY --from=clawbits --chown=ironclaw:ironclaw /staging/channel/clawbits.capabilities.json /home/ironclaw/.ironclaw/channels/clawbits.capabilities.json

# Bake in ttyd — a tiny static web-terminal server — so an agent's OWNER can
# drive the real `ironclaw` CLI (provider/model/channel config) via Reef's
# web-UI exposure. Launched from the entrypoint only when REEF_TERMINAL_ENABLE
# is set. Not in apt on bookworm-slim, so fetch the per-arch static binary.
# python3 (stdlib only, no pip) powers the token-enroll signup helper below —
# IronClaw has no native signup command, so the entrypoint runs the same
# challenge/known-answers exchange the channel installer uses.
# Needs root to write /usr/local/bin, then drop back to the non-root user.
USER root
ARG TTYD_VERSION=1.7.7
ARG TARGETARCH
RUN set -eux; \
    apt-get -o Acquire::Retries=3 update; \
    apt-get -o Acquire::Retries=3 install -y --no-install-recommends curl python3; \
    rm -rf /var/lib/apt/lists/*; \
    arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    case "$arch" in \
      amd64) ttyd_asset=x86_64 ;; \
      arm64) ttyd_asset=aarch64 ;; \
      *) echo "unsupported arch: $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.${ttyd_asset}" \
      -o /usr/local/bin/ttyd; \
    chmod 0755 /usr/local/bin/ttyd; \
    ttyd --version

# The Reef web-terminal entry: a narrow `ironclaw`-only shell (reef-term.sh),
# with a REEF_TERMINAL_SHELL=full toggle to a real shell. Before the entrypoint
# COPY so editing the entrypoint doesn't re-COPY it.
COPY --chmod=0755 reef-term.sh /usr/local/bin/reef-term.sh

# Token-enroll signup helper (from ../../../ironclaw-channel, via the clawbits
# stage): the pure-stdlib onboarding_message.py + the baked known_answers.rs it
# reads to answer the signup challenge. The entrypoint runs it only for the
# signup-token path (SIGNUP_DIR=/usr/local/lib/reef-clawbits-signup). The known
# answers are already compiled into clawbits.wasm, so shipping the .rs text
# adds no exposure.
COPY --from=clawbits --chown=ironclaw:ironclaw /staging/signup/onboarding_message.py /usr/local/lib/reef-clawbits-signup/onboarding_message.py
COPY --from=clawbits --chown=ironclaw:ironclaw /staging/signup/known_answers.rs /usr/local/lib/reef-clawbits-signup/known_answers.rs

# The status dir Reef bind-mounts and reads host-side (telemetry). Pre-created
# node/ironclaw-owned so a mounted volume seeds writable (see reef/profiles.py).
RUN mkdir -p /home/ironclaw/.reef && chown ironclaw:ironclaw /home/ironclaw/.reef

COPY --chmod=0755 entrypoint.sh /usr/local/bin/reef-entrypoint.sh

# Reef runtime-image version — the derived stack identity (ic<ironclaw>-ch<channel>),
# passed by build.sh. The entrypoint reports it in status.json so the dashboard
# shows which image a VM runs. After the COPY so the cheap tail rebuilds fast.
ARG REEF_IMAGE_VERSION=dev
ENV REEF_IMAGE_VERSION=${REEF_IMAGE_VERSION}
LABEL org.opencontainers.image.version="${REEF_IMAGE_VERSION}"

# Baked component versions for the dashboard's Images list AND the version-based
# upgrade signal. CLAWBITS_CHANNEL_VERSION is also promoted to ENV so the entrypoint
# reports the SAME value into status.json that this label carries (otherwise the
# runtime var is unset and every agent reports channel "unknown", so the signal
# could never match).
ARG IRONCLAW_VERSION=unknown
ARG CLAWBITS_CHANNEL_VERSION=unknown
ENV CLAWBITS_CHANNEL_VERSION=${CLAWBITS_CHANNEL_VERSION}
LABEL org.reef.ironclaw.version="${IRONCLAW_VERSION}"
LABEL org.reef.clawbits-channel.version="${CLAWBITS_CHANNEL_VERSION}"

USER ironclaw
EXPOSE 3000

# Headless: seed config -> activate the clawbits channel -> foreground gateway.
ENTRYPOINT ["/usr/local/bin/reef-entrypoint.sh"]
