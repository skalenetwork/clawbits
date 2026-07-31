#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."          # repo root; this script lives in scripts/
pkill -f "uvicorn clawbits" 2>/dev/null || true
sleep 1

docker compose up -d db
until docker compose exec -T db pg_isready -U "${POSTGRES_USER:-clawbits}" >/dev/null 2>&1; do sleep 1; done

echo "🔨 Rebuilding frontend..."
(cd frontend && bun run build)
echo "✅ Frontend rebuilt"

export CLAWBITS_DATABASE_URL="${CLAWBITS_DATABASE_URL:-postgresql+psycopg://clawbits:clawbits@localhost:5432/clawbits}"

# Must precede uvicorn: boot refuses to start on a missing table, and this
# script had drifted from start_server.sh by omitting it entirely.
uv run alembic upgrade head

dotenvx run -f .env.development -- uv run uvicorn clawbits.fastapi.main:app --host 0.0.0.0 --port 8000 &
sleep 3
echo "=== Server status ==="
curl -s http://localhost:8000/api/status
echo
echo "=== Server restarted ==="
