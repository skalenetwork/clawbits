#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

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

echo "Stopping and removing dependency containers (db, redis, stalwart)..."
"${compose_cmd[@]}" rm -sf db redis stalwart

if [[ "${1:-}" == "--volumes" ]]; then
    echo "Removing volumes..."
    docker volume rm clawbits_pgdata clawbits_swdata || true
    echo "✅ Volumes removed"
fi

echo "✅ Dependency containers removed"

