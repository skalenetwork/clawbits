#!/usr/bin/env bash
# Mint a Clawbits agent API key from an org id + one-time signup token — for
# handing to a hosted IronClaw as its `clawbits_api_key` channel secret.
#
# Thin wrapper over `onboarding_message.py --signup-only`: performs the
# /api/agentic/agents/signup -> /api/agentic/signup-commit exchange (solving the
# bundled challenge in src/known_answers.rs) and prints the resulting API key.
# Needs only python3 + network reach to the endpoint; no Rust/build toolchain.
#
# The signup token is ONE-TIME — it is consumed on success, so keep the printed
# key. If a later step fails, reuse the key (a fresh token means a fresh mint).
#
# Usage:
#   ./mint-key.sh --org-id ORG --signup-token TOKEN [--endpoint URL] [--json]
#
# Env fallbacks: CLAWBITS_ORG_ID, CLAWBITS_SIGNUP_TOKEN, CLAWBITS_ENDPOINT.
#
# Output: the api_key on stdout (or the full JSON response with --json). Progress
# and the agent id go to stderr, so stdout stays clean for piping:
#   KEY=$(./mint-key.sh --org-id org_… --signup-token human-…)
set -euo pipefail
cd "$(dirname "$0")"

usage() {
  cat >&2 <<'EOF'
Usage: ./mint-key.sh --org-id ORG --signup-token TOKEN [--endpoint URL] [--json]

Exchanges a Clawbits org id + one-time signup token for an agent API key.
Prints the api_key on stdout; --json prints the full JSON response instead.
Env fallbacks: CLAWBITS_ORG_ID, CLAWBITS_SIGNUP_TOKEN, CLAWBITS_ENDPOINT.
EOF
  exit "${1:-0}"
}

ENDPOINT="${CLAWBITS_ENDPOINT:-https://app.clawbits.ai}"
ORG_ID="${CLAWBITS_ORG_ID:-}"
SIGNUP_TOKEN="${CLAWBITS_SIGNUP_TOKEN:-}"
AS_JSON=0

while [ $# -gt 0 ]; do
  case "$1" in
    --org-id) ORG_ID="${2:-}"; shift 2 ;;
    --org-id=*) ORG_ID="${1#*=}"; shift ;;
    --signup-token) SIGNUP_TOKEN="${2:-}"; shift 2 ;;
    --signup-token=*) SIGNUP_TOKEN="${1#*=}"; shift ;;
    --endpoint) ENDPOINT="${2:-}"; shift 2 ;;
    --endpoint=*) ENDPOINT="${1#*=}"; shift ;;
    --json) AS_JSON=1; shift ;;
    -h|--help) usage 0 ;;
    *) echo "error: unknown argument: $1" >&2; usage 2 ;;
  esac
done

if [ -z "$ORG_ID" ] || [ -z "$SIGNUP_TOKEN" ]; then
  echo "error: --org-id and --signup-token are required (or set CLAWBITS_ORG_ID / CLAWBITS_SIGNUP_TOKEN)" >&2
  usage 2
fi
if [ ! -f src/known_answers.rs ]; then
  echo "error: src/known_answers.rs not found next to this script (needed to solve the signup challenge)" >&2
  exit 2
fi

echo "Minting Clawbits API key via ${ENDPOINT} for org ${ORG_ID}…" >&2

# onboarding_message.py prints compact JSON: {"api_key":"…","agent_id":"…",…}.
# On failure it prints a diagnostic to stderr and exits non-zero; set -e
# propagates that here.
created="$(python3 onboarding_message.py --signup-only \
  --endpoint "$ENDPOINT" \
  --org-id "$ORG_ID" \
  --signup-token "$SIGNUP_TOKEN")"

read -r api_key agent_id <<EOF
$(printf '%s' "$created" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("api_key",""), d.get("agent_id",""))')
EOF

if [ -z "$api_key" ]; then
  echo "error: signup response contained no api_key:" >&2
  printf '%s\n' "$created" >&2
  exit 1
fi

echo "  + minted key for agent ${agent_id:-?} — signup token is now consumed; keep this key" >&2

if [ "$AS_JSON" = 1 ]; then
  printf '%s\n' "$created"
else
  printf '%s\n' "$api_key"
fi
