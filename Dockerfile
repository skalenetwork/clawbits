# syntax=docker/dockerfile:1.7

# ---------- Python deps ----------
FROM ghcr.io/astral-sh/uv:python3.14-bookworm-slim AS deps
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/app/.venv
WORKDIR /app
COPY pyproject.toml uv.lock ./
# --extra router: semantic-router + FastEmbed (CPU) for the LobsterTalk attention
# gate (clawbits/lobstertalk/attention). Without it get_gate() ImportErrors and the feature is
# permanently inert regardless of the per-org toggle. The litellm<1.92 cap in
# [tool.uv] keeps this installable on Python 3.14 (see pyproject).
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-project --extra router

# ---------- Runtime ----------
FROM python:3.14-slim-bookworm AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/app/.venv/bin:$PATH" \
    FASTEMBED_CACHE_PATH=/opt/fastembed
WORKDIR /app

RUN groupadd --system --gid 1000 app \
    && useradd --system --uid 1000 --gid app --create-home app \
    && mkdir -p /app/data \
    && chown app:app /app/data

# dotenvx — wraps uvicorn at boot to inject decrypted env from .env.${APP_ENV}.
# The matching DOTENV_PRIVATE_KEY_<ENV> is supplied by Komodo at runtime.
# libgomp1: OpenMP runtime that onnxruntime (pulled by the router extra) links
# against — without it the LobsterTalk attention encoder fails to import and the
# gate disables itself. Kept in the image (only curl is purged below).
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates libgomp1 \
    && curl -sfS https://dotenvx.sh | sh \
    && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

COPY --from=deps --chown=app:app /app/.venv /app/.venv

# Pre-bake the LobsterTalk attention encoder (bge-small ONNX, ~67MB) into the image
# at FASTEMBED_CACHE_PATH so the uvicorn workers don't each cold-download it at
# boot — and so boot doesn't depend on HuggingFace reachability. The model name
# matches what the gate loads at runtime: fastembed and semantic_router both
# default to BAAI/bge-small-en-v1.5. Needs libgomp1 (installed above) for the
# onnxruntime import. Owned by app (uid 1000) so the runtime user can read it.
RUN mkdir -p "$FASTEMBED_CACHE_PATH" \
    && python -c "from fastembed import TextEmbedding; TextEmbedding()" \
    && chown -R app:app "$FASTEMBED_CACHE_PATH"

COPY --chown=app:app clawbits /app/clawbits
# Each client plugin's manifest is the source of truth for ITS OWN version floor
# (clawbits/fastapi/version_check.py resolves one floor per plugin kind — the version
# lines are independent, so OpenClaw's must not gate Hermes or IronClaw). The server
# reads them at startup for the version-check endpoint and the
# ``require_supported_plugin`` dependency. Only the manifests need to be in the image
# — the rest of those trees stays out of the server build.
#
# A missing manifest fails OPEN (that plugin's gate is disabled, with a warning), so
# dropping one of these COPYs does not break the server — it silently stops gating
# that plugin. Keep them in step with ``_FLOOR_SOURCES``.
COPY --chown=app:app plugin/package.json /app/plugin/package.json
COPY --chown=app:app extensions/hermes/plugin.yaml /app/extensions/hermes/plugin.yaml
COPY --chown=app:app ironclaw-channel/Cargo.toml /app/ironclaw-channel/Cargo.toml
COPY --chown=app:app pyproject.toml uv.lock alembic.ini /app/
# Only the env files present in the build context land here. On a prod build
# that is just .env.production, because scripts/sync_env.sh materialises one
# env at a time — so a prod image no longer carries dev and staging ciphertext
# the way it did when all three were committed and copied unconditionally.
COPY --chown=app:app .env.* /app/

USER app
EXPOSE 8000
# Outer sh interpolates ${APP_ENV} (compose env). dotenvx --overload then
# loads the matching .env file and overrides any compose-set defaults.
# Inner sh sees dotenvx-loaded values for ${CLAWBITS_WEB_CONCURRENCY}.
#
# Boot chain:
#   1. ``alembic upgrade head`` — schema migrations. Must run exactly
#      once per deploy, before workers fork (the previous in-lifespan
#      upgrade raced across N workers and produced duplicate-key
#      errors). DB readiness is gated by ``depends_on: db:
#      service_healthy`` so a non-zero exit here means a real failure
#      and compose's restart-on-failure handles the retry.
#   2. ``exec uvicorn`` — replaces the shell, becomes PID 1.
#
# Two data backfills used to run here and no longer do; both are now manual
# tools, run with ``python -m <module>`` inside the container:
#
#   * ``clawbits.avatars.backfill`` — a spent ratchet. Every creation site
#     stamps ``CURRENT_AVATAR_VERSION`` (9) or higher, so ``avatar_version < 9``
#     cannot be re-entered and the step was a no-op on every boot. Re-arm it
#     with ``--force`` after bumping ``CURRENT_AVATAR_VERSION``.
#   * ``clawbits.fastapi.mm_file_dimensions_backfill`` — never worked. It built
#     a bare ``R2Presigner()``, which defaults to ``CLOUDFLARE_BUCKET`` while
#     chat attachments live in ``MM_FILES_BUCKET``, so every probe 404'd and
#     ``|| echo`` swallowed it. The bucket bug is fixed; run it by hand if you
#     want dimensions on pre-probe rows.
CMD ["sh", "-c", "exec dotenvx run --overload -f /app/.env.${APP_ENV:-production} -- sh -c 'alembic upgrade head && exec uvicorn clawbits.fastapi.main:app --host 0.0.0.0 --port 8000 --proxy-headers --forwarded-allow-ips=* --workers ${CLAWBITS_WEB_CONCURRENCY:-4}'"]
