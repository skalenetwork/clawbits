#!/usr/bin/env bash
# Boot the ClawBits backend. Defaults to production (fail-closed).
#   Local dev:  APP_ENV=development scripts/start_server.sh   (single worker + --reload)
#   Staging VM: APP_ENV=staging scripts/start_server.sh        (4 workers, no reload)
#   Prod VM:    scripts/start_server.sh                        (4 workers, no reload)
# The matching DOTENV_PRIVATE_KEY_<APP_ENV> must be exported by the systemd
# unit / Komodo stack — secrets at rest live only in .env.<APP_ENV>
# (encrypted in git).
set -euo pipefail
cd "$(dirname "$0")/.."          # repo root; this script lives in scripts/
pkill -f "uvicorn clawbits" 2>/dev/null || true
sleep 1

# Detect a compose command (prefer `docker compose`, fallback to `docker-compose`).
compose_cmd=()
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    compose_cmd=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
    compose_cmd=(docker-compose)
else
    echo "ERROR: docker compose or docker-compose not found; please install Docker Compose." >&2
    exit 1
fi

# Start only services that are not already running. This avoids errors when ports are already bound.
services=(db redis)
to_start=()
for svc in "${services[@]}"; do
    # Get container id for the service in this compose project (if any)
    cid=$("${compose_cmd[@]}" ps -q "$svc" 2>/dev/null || true)
    if [ -n "$cid" ]; then
        # Inspect whether the container is running
        is_running=$(docker inspect -f '{{.State.Running}}' "$cid" 2>/dev/null || echo "false")
        if [ "$is_running" = "true" ]; then
            echo "Service '$svc' already running (container $cid)"
            continue
        else
            echo "Service '$svc' exists but is not running; starting"
            # Try to start the existing container; fallback to up -d for this service
            if ! "${compose_cmd[@]}" start "$svc" 2>/dev/null; then
                to_start+=("$svc")
            fi
        fi
    else
        # No container for this service yet — we need to bring it up
        to_start+=("$svc")
    fi
done

if [ ${#to_start[@]} -gt 0 ]; then
    echo "Bringing up services: ${to_start[*]}"
    "${compose_cmd[@]}" up -d "${to_start[@]}"
fi

# Wait for services to be healthy/ready
until "${compose_cmd[@]}" exec -T db pg_isready -U "${POSTGRES_USER:-clawbits}" >/dev/null 2>&1; do sleep 1; done
until "${compose_cmd[@]}" exec -T redis redis-cli ping >/dev/null 2>&1; do sleep 1; done

APP_ENV="${APP_ENV:-production}"
export CLAWBITS_DATABASE_URL="${CLAWBITS_DATABASE_URL:-postgresql+psycopg://clawbits:clawbits@localhost:5432/clawbits}"
export CLAWBITS_REDIS_URL="${CLAWBITS_REDIS_URL:-redis://localhost:6379/0}"

if [ "$APP_ENV" = "development" ]; then
    # Single worker + hot reload for dev. --reload is incompatible with --workers >1.
    UVICORN_MODE_ARGS=(--reload)
else
    UVICORN_MODE_ARGS=(--workers "${CLAWBITS_WEB_CONCURRENCY:-4}")
fi

# Decide python binary: prefer project .venv, then python3, then python
if [ -x "./.venv/bin/python" ]; then
    PYBIN="./.venv/bin/python"
elif command -v python3 >/dev/null 2>&1; then
    PYBIN="python3"
else
    PYBIN="python"
fi

# Run migrations before starting uvicorn so the schema is upgraded by
# exactly one process. With ``--workers > 1`` the previous in-lifespan
# upgrade raced across workers and produced duplicate-key errors at
# first deploy.
# Advisory: the per-env files are gitignored copies of clawbits-internal, so
# nothing else would tell you a teammate rotated a value and yours is stale.
if [ -x "$(dirname "$0")/sync_env.sh" ]; then
  "$(dirname "$0")/sync_env.sh" --check "${APP_ENV}" >/dev/null 2>&1 \
    || echo "start_server: .env.${APP_ENV} differs from clawbits-internal — run scripts/sync_env.sh ${APP_ENV}" >&2
fi

dotenvx run -f ".env.${APP_ENV}" -- "$PYBIN" -m alembic upgrade head

exec dotenvx run -f ".env.${APP_ENV}" -- "$PYBIN" -m uvicorn clawbits.fastapi.main:app --host 0.0.0.0 --port 8000 "${UVICORN_MODE_ARGS[@]}"
