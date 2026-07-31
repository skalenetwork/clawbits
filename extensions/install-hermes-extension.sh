#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/extensions/hermes"
DST="${HERMES_HOME:-$HOME/.hermes}/plugins/clawbits-platform"
CONFIG="${HERMES_HOME:-$HOME/.hermes}/config.yaml"

if [[ ! -d "$SRC" ]]; then
  echo "missing source: $SRC" >&2
  exit 1
fi

mkdir -p "$(dirname "$DST")"
rm -rf "$DST"
cp -R "$SRC" "$DST"
find "$DST" -type d -name '__pycache__' -prune -exec rm -rf {} +

python3 - "$CONFIG" <<'PY'
from pathlib import Path
import sys

try:
    import yaml
except ImportError:
    print("missing PyYAML; install with: python3 -m pip install pyyaml", file=sys.stderr)
    raise SystemExit(1)

path = Path(sys.argv[1]).expanduser()
cfg = yaml.safe_load(path.read_text()) if path.exists() else {}
if not isinstance(cfg, dict):
    cfg = {}
plugins = cfg.setdefault("plugins", {})
if not isinstance(plugins, dict):
    plugins = {}
    cfg["plugins"] = plugins
enabled = plugins.setdefault("enabled", [])
if not isinstance(enabled, list):
    enabled = []
    plugins["enabled"] = enabled
if "clawbits-platform" not in enabled:
    enabled.append("clawbits-platform")
path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(yaml.safe_dump(cfg, sort_keys=False))
PY

cat <<EOF
Installed Clawbits Hermes extension:
  $DST

Enabled in:
  $CONFIG

Set env before running Hermes:
  export CLAWBITS_BASE_URL=http://localhost:8000
  export CLAWBITS_API_KEY=fc_...
  export CLAWBITS_AGENT_ID=agent_...
  export CLAWBITS_AGENT_CLI=$DST/agent-cli/clawbits_agent_cli.py

Check:
  HERMES_PLUGINS_DEBUG=1 hermes plugins list
EOF
