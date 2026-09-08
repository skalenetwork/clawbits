# check=skip=InvalidDefaultArgInFrom
ARG BASE
ARG PLUGIN_STAGE=clawhub

FROM ${BASE} AS base
ARG GH_VERSION=2.63.2
ARG TARGETARCH
USER root
RUN set -eux; \
    chown node:node /home/node/.cache; \
    curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${TARGETARCH}.tar.gz" \
      | tar -xz --no-same-owner -C /usr/local/bin --strip-components=2 \
          "gh_${GH_VERSION}_linux_${TARGETARCH}/bin/gh"; \
    gh --version
USER node
RUN help="$(openclaw plugins install --help 2>/dev/null || true)"; flags=""; \
    for flag in --acknowledge-clawhub-risk \
                --acknowledge-install-policy-warning \
                --accept-capabilities; do \
      case "$help" in *"$flag"*) flags="$flags $flag" ;; esac; \
    done; \
    printf '#!/bin/sh\nexec openclaw plugins install%s "$@"\n' "$flags" > /tmp/pi; \
    chmod 0755 /tmp/pi

FROM base AS clawhub
ARG PLUGIN_VERSION
RUN /tmp/pi clawhub:clawbits-openclaw-plugin@${PLUGIN_VERSION} \
 && /tmp/pi clawhub:clawbits-openclaw-tools@${PLUGIN_VERSION}

FROM base AS local
COPY --chown=node:node .plugin/ /tmp/plugin/
RUN /tmp/pi /tmp/plugin/channel --force && /tmp/pi /tmp/plugin/tools --force

FROM ${PLUGIN_STAGE}
RUN openclaw plugins list --json | node -e 'const p=JSON.parse(require("fs").readFileSync(0,"utf8")).plugins||[];for(const id of["clawbits","clawbits-tools"]){const x=p.find(y=>y.id===id)||{};if(x.status!=="loaded"){console.error(id,x.status||"missing");process.exit(1)}}' \
 && rm -f /tmp/pi /home/node/.openclaw/openclaw.json /home/node/.openclaw/openclaw.json.bak

COPY --chmod=0755 start /usr/local/bin/clawbits-start
COPY --chmod=0644 defaults.json /usr/local/share/clawbits-defaults.json

ARG ENGINE_VERSION
ARG PLUGIN_VERSION
ARG IMAGE_VERSION
LABEL org.opencontainers.image.version="${IMAGE_VERSION}" \
      org.clawbits.openclaw.version="${ENGINE_VERSION}" \
      org.clawbits.plugin.version="${PLUGIN_VERSION}"
