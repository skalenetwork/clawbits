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
# BOTH halves, always. Since 0.17 Clawbits is a split pair, and the repo root is
# only the CHANNEL package (package.json); the companion lives behind
# package.tools.json and is produced by stage-tools.mjs. Installing the repo dir
# alone updates the channel and silently leaves the old companion running — so
# cron, email, usage and skills keep executing the code you just replaced.
#
# --vendor-deps is required for a path install: OpenClaw copies the directory
# and never installs dependencies, and companion-tools.ts imports `typebox` at
# module scope, so an unvendored companion loads with `status: error`.
#
# OpenClaw 2026.8 ("2.0") also requires capability consent before it will commit
# an external plugin's staged artifact, and a path install can never inherit an
# earlier acceptance (no artifact integrity is recorded for a path source), so it
# asks on every run. Probe --help: pre-2026.8 CLIs hard-error on the flag.
CAP_FLAG=""
if openclaw plugins install --help 2>/dev/null | grep -q -- --accept-capabilities; then
  CAP_FLAG="--accept-capabilities"
fi
STAGE_DIR="$(mktemp -d -t clawbits-update-src.XXXXXX)"
trap 'rm -rf "$STAGE_DIR"' EXIT
if [ "$DRY_RUN" = "1" ]; then
  warn "would run: node stage-channel.mjs <stage>/channel --vendor-deps"
  warn "would run: node stage-tools.mjs <stage>/tools --vendor-deps"
  warn "would run: openclaw plugins install <stage>/channel --force $CAP_FLAG"
  warn "would run: openclaw plugins install <stage>/tools --force $CAP_FLAG"
else
  ok "staging channel and companion artifacts"
  if ! STAGE_OUT=$( (cd "$REPO_PLUGIN_DIR" \
    && node stage-channel.mjs "$STAGE_DIR/channel" --vendor-deps \
    && node stage-tools.mjs "$STAGE_DIR/tools" --vendor-deps) 2>&1); then
    fail "staging failed"
    printf '%s\n' "$STAGE_OUT" | sed 's/^/      /'
    exit 1
  fi
  [ "$QUIET" = "1" ] || printf '%s\n' "$STAGE_OUT" | sed "s/^/      ${DIM}/" | sed "s/\$/${RESET}/"
  for part in channel tools; do
    ok "running: openclaw plugins install $STAGE_DIR/$part --force $CAP_FLAG"
    # shellcheck disable=SC2086 # CAP_FLAG is a single flag or empty by construction
    if INSTALL_OUT=$(openclaw plugins install "$STAGE_DIR/$part" --force $CAP_FLAG 2>&1); then
      [ "$QUIET" = "1" ] || printf '%s\n' "$INSTALL_OUT" | sed "s/^/      ${DIM}/" | sed "s/\$/${RESET}/"
      ok "$part updated from source"
      UPDATED=1
    else
      fail "openclaw install --force failed for $part"
      printf '%s\n' "$INSTALL_OUT" | sed 's/^/      /'
      exit 1
    fi
  done
  ok "channel and companion updated (gateway auto-restart may be triggered)"
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
