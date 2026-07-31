#!/usr/bin/env bash
#
# Fresh (re)install of the Clawbits platform plugin for Hermes.
#
# Wipes any previous install AND its local configuration/state, then installs
# the plugin cleanly from this source directory and enables it. Optionally runs
# signup in the same pass (which mints CB_TOKENS and writes ~/.hermes/.env).
#
# What it removes (local only — never touches the Clawbits server/DB):
#   - ~/.hermes/plugins/clawbits-platform/        (the installed plugin dir)
#   - all CLAWBITS_* lines from ~/.hermes/.env    (stale creds/endpoint/channel)
#
# Usage:
#   ./reinstall.sh                       # clean reinstall, then prints next steps
#   ./reinstall.sh -y                    # skip the "this will delete" confirmation
#   ./reinstall.sh -y \
#       --endpoint http://localhost:8000 \
#       --org-id   <ORG> \
#       --signup-token <TOKEN>         # also signs up (mints tokens) + starts gateway
#
# Env overrides:
#   HERMES_HOME         (default: ~/.hermes)
#   CLAWBITS_AGENT_CLI  optional path to agent-cli/clawbits_agent_cli.py
#                       (default: bundled CLI inside installed plugin)
#
set -euo pipefail

# --- locate things ----------------------------------------------------------
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
PLUGINS_DIR="$HERMES_HOME/plugins"
PLUGIN_NAME="clawbits-platform"
DEST_DIR="$PLUGINS_DIR/$PLUGIN_NAME"
ENV_FILE="$HERMES_HOME/.env"

# agent-cli is bundled with this plugin; after install, use the installed copy.
DEFAULT_AGENT_CLI="$DEST_DIR/agent-cli/clawbits_agent_cli.py"
AGENT_CLI="${CLAWBITS_AGENT_CLI:-$DEFAULT_AGENT_CLI}"

# --- parse args -------------------------------------------------------------
ASSUME_YES=0
ENDPOINT="" ORG_ID="" SIGNUP_TOKEN=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -y|--yes)        ASSUME_YES=1; shift ;;
    --endpoint)      ENDPOINT="$2"; shift 2 ;;
    --org-id)        ORG_ID="$2"; shift 2 ;;
    --signup-token)  SIGNUP_TOKEN="$2"; shift 2 ;;
    --agent-cli)     AGENT_CLI="$2"; shift 2 ;;
    -h|--help)       grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

echo "Clawbits Hermes plugin — fresh install"
echo "  source:      $SRC_DIR"
echo "  destination: $DEST_DIR"
echo "  env file:    $ENV_FILE"
echo "  agent-cli:   $AGENT_CLI"
echo

# --- confirm (destructive) --------------------------------------------------
if [[ "$ASSUME_YES" -ne 1 ]]; then
  echo "This will DELETE:"
  echo "  - $DEST_DIR"
  echo "  - all CLAWBITS_* lines in $ENV_FILE"
  read -r -p "Proceed? [y/N] " reply
  [[ "$reply" =~ ^[Yy]$ ]] || { echo "aborted."; exit 1; }
fi

# --- 0. stop the gateway so it isn't holding stale creds/code ---------------
echo "==> stopping gateway (if running)"
systemctl --user stop hermes-gateway.service 2>/dev/null || true
pkill -f "hermes_cli.main gateway" 2>/dev/null || true

# --- 1. purge previous install + config -------------------------------------
echo "==> removing previous plugin install"
rm -rf "$DEST_DIR"

if [[ -f "$ENV_FILE" ]]; then
  echo "==> stripping CLAWBITS_* from $ENV_FILE"
  tmp="$(mktemp)"
  grep -v '^CLAWBITS_' "$ENV_FILE" > "$tmp" || true
  mv "$tmp" "$ENV_FILE"
fi

# --- 2. install fresh from source -------------------------------------------
echo "==> installing plugin"
mkdir -p "$PLUGINS_DIR"
cp -R "$SRC_DIR" "$DEST_DIR"
# Drop any stray bytecode copied from the source tree.
find "$DEST_DIR" -type d -name '__pycache__' -prune -exec rm -rf {} +

# Sanity: the plugin needs the agent CLI to function.
if [[ ! -f "$AGENT_CLI" ]]; then
  echo "WARNING: agent CLI not found at: $AGENT_CLI" >&2
  echo "         Set CLAWBITS_AGENT_CLI or pass --agent-cli; signup will fail without it." >&2
fi

# --- 3. enable the plugin (opt-in allow-list) -------------------------------
echo "==> enabling plugin"
if command -v hermes >/dev/null 2>&1; then
  hermes plugins enable "$PLUGIN_NAME" || {
    echo "WARNING: 'hermes plugins enable' failed — enable it manually." >&2
  }
else
  echo "WARNING: 'hermes' not on PATH — run 'hermes plugins enable $PLUGIN_NAME' yourself." >&2
fi

# --- 4. optional one-shot signup (mints tokens, writes .env) ----------------
if [[ -n "$SIGNUP_TOKEN" && -n "$ENDPOINT" ]]; then
  echo "==> running signup"
  CLAWBITS_AGENT_CLI="$AGENT_CLI" hermes clawbits signup \
    --endpoint "$ENDPOINT" \
    ${ORG_ID:+--org-id "$ORG_ID"} \
    --signup-token "$SIGNUP_TOKEN" \
    --agent-cli "$AGENT_CLI"
  echo "==> starting gateway"
  systemctl --user restart hermes-gateway.service 2>/dev/null \
    || echo "Start the gateway with: hermes gateway run --replace"
  echo
  echo "Done. Verify with:  journalctl --user -u hermes-gateway -n 20 --no-pager"
else
  echo
  echo "Done. Plugin installed & enabled, previous config wiped."
  echo "Next — sign up (mints CB_TOKENS, writes ~/.hermes/.env):"
  echo
  echo "  hermes clawbits signup --endpoint <API_URL> --org-id <ORG> --signup-token <TOKEN>"
  echo
  echo "Then start the gateway:  systemctl --user restart hermes-gateway.service"
  echo "                  (or):  hermes gateway run --replace"
fi
