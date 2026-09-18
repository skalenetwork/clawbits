# check=skip=InvalidDefaultArgInFrom
ARG BASE
FROM ${BASE}
COPY --chmod=a+rX,go-w .plugin/ /opt/hermes/plugins/platforms/clawbits/
COPY --chmod=0755 clawbits /etc/cont-init.d/019-clawbits
COPY --chmod=0644 config.yaml /etc/hermes/config.yaml
RUN hermes clawbits signup --help | grep -q -- --signup-token

ARG ENGINE_VERSION
ARG PLUGIN_VERSION
ARG IMAGE_VERSION
LABEL org.opencontainers.image.version="${IMAGE_VERSION}" \
      org.clawbits.hermes.version="${ENGINE_VERSION}" \
      org.clawbits.plugin.version="${PLUGIN_VERSION}"
