#!/usr/bin/env bash
# Update the local OpenClaw Clawbits plugin from this repo source.
#
# This is the non-destructive companion to refresh.sh:
#   - does NOT uninstall the plugin
#   - does NOT delete ~/.openclaw data, logs, transcripts, config, or accounts
#   - builds plugin/dist from the current source tree
#   - overwrites the installed plugin code with `openclaw plugins install <plugin-dir> --force`
#
# Flags:
#   --dry-run   show commands without modifying anything
#   --no-build  skip `npm run build` and install current files as-is
#   --quiet     suppress command output detail
#
# macOS-safe: avoids bash 4-only constructs.

set -euo pipefail

DRY_RUN=0
NO_BUILD=0
QUIET=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --no-build) NO_BUILD=1 ;;
    --quiet) QUIET=1 ;;
    -h|--help)
      sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

if [ -t 1 ]; then
  BOLD=$(printf '\033[1m')
  DIM=$(printf '\033[2m')
  RED=$(printf '\033[31m')
  YELLOW=$(printf '\033[33m')
  GREEN=$(printf '\033[32m')
  CYAN=$(printf '\033[36m')
  RESET=$(printf '\033[0m')
else
  BOLD='' DIM='' RED='' YELLOW='' GREEN='' CYAN='' RESET=''
fi

section() { printf '\n%s━━━ %s%s\n' "$BOLD$CYAN" "$1" "$RESET"; }
ok() { printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$1"; }
warn() { printf '  %s•%s %s\n' "$YELLOW" "$RESET" "$1"; }
fail() { printf '  %s✗%s %s\n' "$RED" "$RESET" "$1"; }
detail() { [ "$QUIET" = "1" ] || printf '      %s%s%s\n' "$DIM" "$1" "$RESET"; }

REPO_PLUGIN_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_DIR="$HOME/.openclaw/extensions/clawbits"
START_TIME=$SECONDS
UPDATED=0

if [ "$DRY_RUN" = "1" ]; then
  printf '\n%s[DRY RUN]%s no files will be modified.\n' "$BOLD$YELLOW" "$RESET"
fi

section "Preflight"
if [ ! -f "$REPO_PLUGIN_DIR/package.json" ]; then
  fail "package.json not found in $REPO_PLUGIN_DIR"
  exit 1
fi
ok "source: $REPO_PLUGIN_DIR"

if ! command -v openclaw >/dev/null 2>&1; then
  fail "openclaw CLI not on PATH"
  exit 1
fi
ok "openclaw CLI found"

if [ "$NO_BUILD" = "0" ] && ! command -v npm >/dev/null 2>&1; then
  fail "npm not on PATH; pass --no-build to skip build"
  exit 1
fi

if openclaw plugins inspect clawbits --json >/dev/null 2>&1; then
  ok "clawbits plugin is registered"
else
  warn "clawbits plugin is not registered; install will add it without deleting existing data"
fi

if [ -d "$INSTALL_DIR" ]; then
  detail "installed code dir exists: $INSTALL_DIR"
else
  detail "installed code dir absent: $INSTALL_DIR"
fi

section "Build"
if [ "$NO_BUILD" = "1" ]; then
  warn "skipped via --no-build"
elif [ "$DRY_RUN" = "1" ]; then
  warn "would run: (cd $REPO_PLUGIN_DIR && npm run build)"
else
  ok "running: npm run build"
  if BUILD_OUT=$(cd "$REPO_PLUGIN_DIR" && npm run build 2>&1); then
    [ "$QUIET" = "1" ] || printf '%s\n' "$BUILD_OUT" | tail -8 | sed "s/^/      ${DIM}/" | sed "s/\$/${RESET}/"
    ok "build succeeded"
  else
    fail "build failed"
    printf '%s\n' "$BUILD_OUT" | tail -20 | sed 's/^/      /'
    exit 1
  fi
fi

section "Update installed plugin code"
if [ "$DRY_RUN" = "1" ]; then
  warn "would run: openclaw plugins install $REPO_PLUGIN_DIR --force"
else
  ok "running: openclaw plugins install $REPO_PLUGIN_DIR --force"
  if INSTALL_OUT=$(openclaw plugins install "$REPO_PLUGIN_DIR" --force 2>&1); then
    [ "$QUIET" = "1" ] || printf '%s\n' "$INSTALL_OUT" | sed "s/^/      ${DIM}/" | sed "s/\$/${RESET}/"
    ok "plugin updated from source (gateway auto-restart may be triggered)"
    UPDATED=1
  else
    fail "openclaw install --force failed"
    printf '%s\n' "$INSTALL_OUT" | sed 's/^/      /'
    exit 1
  fi
fi

section "Verify data preserved"
if [ -f "$HOME/.openclaw/openclaw.json" ]; then
  if grep -qi 'clawbits' "$HOME/.openclaw/openclaw.json"; then
    ok "openclaw.json still contains clawbits config"
  else
    warn "openclaw.json has no clawbits references"
  fi
else
  warn "openclaw.json not found"
fi

detail "not touched: ~/.openclaw/clawbits-plugin.log"
detail "not touched: ~/.openclaw/clawbits-latency.log"
detail "not touched: ~/.openclaw/agents/*/sessions"

ELAPSED=$((SECONDS - START_TIME))
section "Summary"
if [ "$DRY_RUN" = "1" ]; then
  detail "dry-run — no changes made"
elif [ "$UPDATED" = "1" ]; then
  ok "updated installed plugin code from repo source"
else
  warn "nothing updated"
fi
printf '  %sfinished in %ds%s\n' "$DIM" "$ELAPSED" "$RESET"
