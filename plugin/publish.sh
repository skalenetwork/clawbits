#!/usr/bin/env bash
# Build the ClawBits OpenClaw plugin and publish it to ClawHub as a code-plugin
# package (ClawPack format, /api/v1/packages namespace).
#
# MANUAL ESCAPE HATCH. Normal releases are cut by CI
# (.github/workflows/publish-clawhub-plugin.yaml), which derives the version
# automatically: major.minor from plugin/package.json, patch from the count of
# commits touching plugin/. The patch in those files is therefore stale between
# CI runs, so this script will NOT read a version from them — you must pass one
# explicitly so a stale patch can't ship by accident. The supplied version is
# stamped into the staged artifact (the working-tree files are left untouched).
#
# To mirror what CI would publish from the current checkout:
#   bash plugin/publish.sh --version "$(node -p "require('./plugin/package.json').version.split('.').slice(0,2).join('.')").$(git rev-list --count HEAD -- plugin)"
#
# Usage:
#   bash plugin/publish.sh --version X.Y.Z            # build + publish + verify
#   bash plugin/publish.sh --version X.Y.Z --dry-run  # build + stage, skip publish
#   PLUGIN_PUBLISH_VERSION=X.Y.Z bash plugin/publish.sh
#
# Requirements:
#   - bun (for installing plugin deps + running tsc)
#   - npm (for installing clawhub CLI globally)
#   - clawhub login completed once (interactive); subsequent runs reuse the
#     stored token under ~/Library/Application Support/clawhub/config.json
#     (macOS) or $XDG_CONFIG_HOME/clawhub/config.json.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PLUGIN_DIR="$REPO_ROOT/plugin"
PUBLISH_DIR="$REPO_ROOT/publish/clawbits-openclaw-plugin"
REGISTRY_API="https://clawhub.ai/api/v1"
SOURCE_REPO_DEFAULT="skalenetwork/clawbits"
MIN_CLAWHUB_MINOR=12

DRY_RUN=false
VERSION="${PLUGIN_PUBLISH_VERSION:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=true ;;
    --version) shift; VERSION="${1:-}" ;;
    --version=*) VERSION="${1#*=}" ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

step() { printf '\n=== %s ===\n' "$*"; }

# ---------------------------------------------------------------------------
# 1. Resolve target version (explicit only — see header)
# ---------------------------------------------------------------------------
step "Resolving target version"
if [ -z "$VERSION" ]; then
  echo "No version supplied. Pass --version X.Y.Z (or set PLUGIN_PUBLISH_VERSION)." >&2
  echo "Normal releases are tag-driven in CI; this script is a manual override." >&2
  exit 2
fi
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-.+][A-Za-z0-9.+-]*)?$ ]]; then
  echo "Invalid version '$VERSION' (expected semver like 0.6.0 or 0.6.0-rc.1)" >&2
  exit 2
fi
PKG_VERSION="$VERSION"
echo "Target: clawbits-openclaw-plugin@$PKG_VERSION (manual publish)"

# ---------------------------------------------------------------------------
# 2. Ensure clawhub CLI is >= 0.12 (needed for ClawPack creation via npm pack)
# ---------------------------------------------------------------------------
step "Checking clawhub CLI"
needs_upgrade=true
if command -v clawhub >/dev/null 2>&1; then
  current="$(clawhub --cli-version 2>/dev/null || echo "0.0.0")"
  echo "Current clawhub version: $current"
  if [[ "$current" =~ ^([0-9]+)\.([0-9]+)\. ]]; then
    major="${BASH_REMATCH[1]}"; minor="${BASH_REMATCH[2]}"
    if (( major > 0 )) || (( major == 0 && minor >= MIN_CLAWHUB_MINOR )); then
      needs_upgrade=false
    fi
  fi
fi
if "$needs_upgrade"; then
  echo "Installing clawhub@latest globally..."
  npm install --global clawhub@latest
  clawhub --cli-version
fi

# ---------------------------------------------------------------------------
# 3. Build the plugin (TypeScript -> dist/)
# ---------------------------------------------------------------------------
step "Building plugin"
cd "$PLUGIN_DIR"
bun install --frozen-lockfile
node node_modules/typescript/bin/tsc
cd "$REPO_ROOT"

# ---------------------------------------------------------------------------
# 4. Stage a clean publish directory
# ---------------------------------------------------------------------------
step "Staging publish directory at $PUBLISH_DIR"
rm -rf "$PUBLISH_DIR"
mkdir -p "$PUBLISH_DIR"
cp -r "$PLUGIN_DIR/dist" "$PLUGIN_DIR/src" "$PLUGIN_DIR/docs" "$PLUGIN_DIR/skills" "$PUBLISH_DIR/"
cp "$PLUGIN_DIR/openclaw.plugin.json" \
   "$PLUGIN_DIR/clawbits.config.example.json" \
   "$PLUGIN_DIR/package.json" \
   "$PUBLISH_DIR/"

# Stamp the resolved version into the staged manifest + package.json (the
# working-tree copies are intentionally left as placeholders). This mirrors
# the "Stamp auto version" step in the CI publish workflow.
PKG_VERSION="$PKG_VERSION" node -e "
const fs = require('fs');
const v = process.env.PKG_VERSION;
for (const p of ['$PUBLISH_DIR/package.json', '$PUBLISH_DIR/openclaw.plugin.json']) {
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  j.version = v;
  if (j.openclaw && j.openclaw.version) j.openclaw.version = v;
  fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
}
console.log('Stamped staged version ' + v);
"
echo "Staged files:"
( cd "$PUBLISH_DIR" && find . -maxdepth 2 -type f | sort )

if "$DRY_RUN"; then
  step "Dry-run complete; skipping publish"
  exit 0
fi

# ---------------------------------------------------------------------------
# 5. Publish (creates a ClawPack tarball via `npm pack` and uploads it)
# ---------------------------------------------------------------------------
step "Publishing to ClawHub (/api/v1/packages)"
COMMIT_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD)"
BRANCH_NAME="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "HEAD")"
SOURCE_REPO="${CLAWBITS_PUBLISH_SOURCE_REPO:-$SOURCE_REPO_DEFAULT}"

clawhub package publish "$PUBLISH_DIR" \
  --family code-plugin \
  --source-repo "$SOURCE_REPO" \
  --source-commit "$COMMIT_SHA" \
  --source-ref "$BRANCH_NAME"

# ---------------------------------------------------------------------------
# 6. Verify the version is queryable on the packages namespace
# ---------------------------------------------------------------------------
step "Verifying publish"
versions_json="$(curl -fsS "$REGISTRY_API/packages/clawbits-openclaw-plugin/versions" || true)"
echo "$versions_json" | node -e "
const data = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const versions = (data.items || []).map(v => v.version);
console.log('Versions on registry:', versions.join(', ') || '(none)');
if (!versions.includes('$PKG_VERSION')) {
  console.error('FAIL: $PKG_VERSION not present on registry');
  process.exit(1);
}
console.log('OK: $PKG_VERSION is published.');
"

artifact_kind="$(curl -fsS "$REGISTRY_API/packages/clawbits-openclaw-plugin" \
  | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log(d.package?.artifact?.kind || '(unknown)')")"
echo "Latest artifact kind: $artifact_kind"
if [ "$artifact_kind" = "legacy-zip" ]; then
  echo "WARNING: latest published artifact is still legacy-zip. Clawhub CLI may be stale."
  exit 1
fi

step "Done"
echo "Install with (pinned remote):"
echo "  openclaw plugins install clawhub:clawbits-openclaw-plugin --pin --acknowledge-clawhub-risk"
echo "Self-update later with: openclaw clawbits update"
echo "  → prints: openclaw plugins install clawhub:clawbits-openclaw-plugin --pin --force --acknowledge-clawhub-risk"
echo "    (re-fetches the newest compatible release and stays pinned)"
