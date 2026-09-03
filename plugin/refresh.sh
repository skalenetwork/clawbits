#!/usr/bin/env bash
# Full clawbits plugin reset for the local OpenClaw install.
#
# Tiers, increasing destructiveness:
#   0. `openclaw plugins uninstall clawbits --force`
#      Removes channels.clawbits.*, plugins.entries.clawbits,
#      plugins.installs.clawbits, and ~/.openclaw/extensions/clawbits/.
#      Triggers an auto-restart of the gateway (config-write hook).
#   1. Plugin-owned log files at the OpenClaw state-dir root.
#   2. Clawbits-tagged lines stripped out of global gateway/audit logs.
#   3. Agent conversation transcripts that referenced clawbits — DESTRUCTIVE,
#      the agent forgets every prior conversation through this channel.
#   4. (--reinstall only) `npm run build` in plugin/ then
#      `openclaw plugins install <plugin-dir> --force`.
#
# Repo source under plugin/ is never touched; the Verify step asserts that.
#
# Flags:
#   --dry-run        show what would change without modifying anything
#   --no-uninstall   skip tier 0; gap-fill only (old behavior)
#   --no-tier3       skip the destructive transcript wipe
#   --reinstall      after cleanup, rebuild dist/ and reinstall the plugin
#   --quiet          suppress per-file detail (keep the summary)
#
# macOS-safe: avoids bash 4 features (no `mapfile`, no `${var,,}`).

set -euo pipefail

# ── flags ──────────────────────────────────────────────────────────────────
DRY_RUN=0
SKIP_UNINSTALL=0
SKIP_TIER3=0
REINSTALL=0
QUIET=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --no-uninstall) SKIP_UNINSTALL=1 ;;
    --no-tier3) SKIP_TIER3=1 ;;
    --reinstall) REINSTALL=1 ;;
    --quiet) QUIET=1 ;;
    -h|--help)
      sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

# ── theme ──────────────────────────────────────────────────────────────────
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

say() { printf '%s\n' "$*"; }
section() { printf '\n%s━━━ %s%s\n' "$BOLD$CYAN" "$1" "$RESET"; }
ok() { printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$1"; }
warn() { printf '  %s•%s %s\n' "$YELLOW" "$RESET" "$1"; }
fail() { printf '  %s✗%s %s\n' "$RED" "$RESET" "$1"; }
detail() { [ "$QUIET" = "1" ] || printf '      %s%s%s\n' "$DIM" "$1" "$RESET"; }
muted() { printf '  %s%s%s\n' "$DIM" "$1" "$RESET"; }

# Mode banner
if [ "$DRY_RUN" = "1" ]; then
  printf '\n%s[DRY RUN]%s no files will be modified.\n' "$BOLD$YELLOW" "$RESET"
fi

# Tally
declare -i TIER0_RAN=0
declare -i TIER1_FILES=0
declare -i TIER2_LINES_STRIPPED=0
declare -i TIER2_FILES_TOUCHED=0
declare -i TIER3_TRIOS=0
declare -i TIER3_KEYS_DROPPED=0
declare -i TIER4_RAN=0
START_TIME=$SECONDS

# Snapshot the repo's plugin/ git state at startup. The Verify step
# below compares this to the post-run state; only files that changed
# DURING the script's run are flagged. Pre-existing WIP edits are
# the user's business, not a cleanup concern.
REPO_PLUGIN_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$REPO_PLUGIN_DIR/.." 2>/dev/null && pwd || true)"
REPO_PLUGIN_NAME="$(basename "$REPO_PLUGIN_DIR")"
REPO_BASELINE=""
if [ -n "$REPO_ROOT" ] && git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  REPO_BASELINE=$(git -C "$REPO_ROOT" status --porcelain -- "$REPO_PLUGIN_NAME" 2>/dev/null || true)
fi

# ── helpers ────────────────────────────────────────────────────────────────
# Count lines matching 'clawbits' (case-insensitive) in a file. 0 if missing.
# Note: `grep -c` exits 1 when there are zero matches but still prints "0",
# so we swallow the exit code with `|| true` instead of `|| echo 0` (which
# would emit a doubled value like "0\n0" and break later -eq tests).
count_clawbits_lines() {
  [ -f "$1" ] || { echo 0; return; }
  local n
  n=$(grep -ic clawbits "$1" 2>/dev/null || true)
  echo "${n:-0}"
}

# Strip clawbits-mentioning lines from a plain-text log, in place.
strip_clawbits_from_log() {
  local f=$1
  if [ ! -f "$f" ]; then
    detail "skip — file not present: $f"
    return
  fi
  local before
  before=$(count_clawbits_lines "$f")
  if [ "$before" -eq 0 ]; then
    detail "no clawbits mentions in $(basename "$f")"
    return
  fi
  if [ "$DRY_RUN" = "1" ]; then
    warn "would strip $before line(s) from $(basename "$f")"
    return
  fi
  grep -v -i clawbits "$f" > "$f.tmp"
  mv "$f.tmp" "$f"
  TIER2_LINES_STRIPPED=$((TIER2_LINES_STRIPPED + before))
  TIER2_FILES_TOUCHED=$((TIER2_FILES_TOUCHED + 1))
  ok "stripped $before line(s) from $(basename "$f")"
}

# ── tier 0 — official openclaw uninstall ──────────────────────────────────
section "Tier 0 — openclaw plugins uninstall"
INSTALL_DIR="$HOME/.openclaw/extensions/clawbits"
if [ "$SKIP_UNINSTALL" = "1" ]; then
  muted "skipped via --no-uninstall (config + install dir will remain)"
elif ! command -v openclaw >/dev/null 2>&1; then
  fail "openclaw CLI not on PATH; cannot run uninstall step"
  detail "install it or pass --no-uninstall to skip this tier"
else
  # Check if clawbits is registered before invoking uninstall — otherwise
  # uninstall exits non-zero on a missing plugin, which would trip set -e.
  if openclaw plugins inspect clawbits --json >/dev/null 2>&1; then
    if [ "$DRY_RUN" = "1" ]; then
      warn "would run: openclaw plugins uninstall clawbits --force"
      detail "(would remove: channels.clawbits.*, plugins.{entries,installs}.clawbits, ~/.openclaw/extensions/clawbits/)"
    else
      ok "running: openclaw plugins uninstall clawbits --force"
      # Capture output so the script's section formatting isn't disrupted.
      if UNINSTALL_OUT=$(openclaw plugins uninstall clawbits --force 2>&1); then
        TIER0_RAN=1
        # Indent the CLI's own output so it nests under our section.
        printf '%s\n' "$UNINSTALL_OUT" | sed "s/^/      ${DIM}/" | sed "s/\$/${RESET}/"
        ok "openclaw uninstall completed (gateway auto-restart triggered)"
      else
        fail "openclaw uninstall failed:"
        printf '%s\n' "$UNINSTALL_OUT" | sed 's/^/      /'
        detail "continuing with the cleanup tiers below"
      fi
    fi
  else
    detail "plugin 'clawbits' is not registered with openclaw"
  fi
  # Even when the plugin isn't registered (or uninstall succeeded), the
  # install directory under ~/.openclaw/extensions/clawbits/ can survive
  # from a prior --keep-files uninstall or a partial run. Tier 4 install
  # refuses to overwrite it, so scrub it here unconditionally. Path is
  # OpenClaw-owned; the repo source lives elsewhere.
  if [ -d "$INSTALL_DIR" ]; then
    if [ "$DRY_RUN" = "1" ]; then
      warn "would remove orphan install dir: $INSTALL_DIR"
    else
      rm -rf "$INSTALL_DIR"
      ok "removed orphan install dir: $INSTALL_DIR"
    fi
  else
    detail "no orphan install dir at ~/.openclaw/extensions/clawbits/"
  fi
fi

# ── tier 1 — plugin-owned log files at state-dir root ──────────────────────
section "Tier 1 — plugin-owned log files"
for f in \
  "$HOME/.openclaw/clawbits-latency.log" \
  "$HOME/.openclaw/clawbits-plugin.log"; do
  if [ ! -f "$f" ]; then
    detail "skip — already absent: $(basename "$f")"
    continue
  fi
  size=$(wc -c < "$f" 2>/dev/null | tr -d ' ')
  if [ "$DRY_RUN" = "1" ]; then
    warn "would remove $(basename "$f") (${size} bytes)"
    continue
  fi
  rm -f "$f"
  ok "removed $(basename "$f") (${size} bytes)"
  TIER1_FILES=$((TIER1_FILES + 1))
done

# ── tier 2 — clawbits lines in global logs (history-preserving) ────────────
section "Tier 2 — global logs (preserve other plugins' history)"
for f in \
  "$HOME/.openclaw/logs/gateway.log" \
  "$HOME/.openclaw/logs/gateway.err.log" \
  "$HOME/.openclaw/logs/gateway-restart.log"; do
  strip_clawbits_from_log "$f"
done

# config-audit is JSONL — filter by JSON content
AUDIT="$HOME/.openclaw/logs/config-audit.jsonl"
if [ ! -f "$AUDIT" ]; then
  detail "skip — no config-audit.jsonl"
else
  AUDIT_BEFORE=$(count_clawbits_lines "$AUDIT")
  if [ "$AUDIT_BEFORE" -eq 0 ]; then
    detail "no clawbits entries in config-audit.jsonl"
  elif [ "$DRY_RUN" = "1" ]; then
    warn "would drop $AUDIT_BEFORE entry/entries from config-audit.jsonl"
  else
    python3 - "$AUDIT" <<'PY'
import json, pathlib, sys
p = pathlib.Path(sys.argv[1])
keep, dropped = [], 0
for line in p.read_text().splitlines():
    try:
        obj = json.loads(line)
        if 'clawbits' in json.dumps(obj):
            dropped += 1
            continue
    except Exception:
        pass
    keep.append(line)
p.write_text('\n'.join(keep) + ('\n' if keep else ''))
print(dropped)
PY
    AUDIT_DROPPED=$AUDIT_BEFORE
    TIER2_LINES_STRIPPED=$((TIER2_LINES_STRIPPED + AUDIT_DROPPED))
    TIER2_FILES_TOUCHED=$((TIER2_FILES_TOUCHED + 1))
    ok "stripped $AUDIT_DROPPED entry/entries from config-audit.jsonl"
  fi
fi

# ── tier 3 — agent transcripts (DESTRUCTIVE) ───────────────────────────────
if [ "$SKIP_TIER3" = "1" ]; then
  section "Tier 3 — agent transcripts (SKIPPED via --no-tier3)"
  muted "agent will keep prior clawbits conversation context"
else
  section "Tier 3 — agent transcripts referencing clawbits  ${RED}(DESTRUCTIVE)${RESET}"
  SESSIONS_DIR="$HOME/.openclaw/agents/main/sessions"
  if [ ! -d "$SESSIONS_DIR" ]; then
    detail "skip — sessions dir not present: $SESSIONS_DIR"
  else
    # macOS-safe collection (no mapfile)
    CB_FILES=()
    while IFS= read -r f; do
      CB_FILES+=("$f")
    done < <(grep -l 'agent:main:clawbits:' "$SESSIONS_DIR"/*.jsonl 2>/dev/null || true)

    if [ "${#CB_FILES[@]}" -eq 0 ]; then
      detail "no transcripts mention agent:main:clawbits:"
    else
      for f in "${CB_FILES[@]}"; do
        base="${f%.jsonl}"
        name="$(basename "$base")"
        # Count siblings for reporting (trajectory + reset snapshots)
        siblings=()
        for s in "$base.jsonl" "$base.trajectory.jsonl" "$base".jsonl.reset.*; do
          [ -e "$s" ] && siblings+=("$(basename "$s")")
        done
        if [ "$DRY_RUN" = "1" ]; then
          warn "would remove $name + ${#siblings[@]} file(s): ${siblings[*]}"
          continue
        fi
        rm -f "$base.jsonl" "$base.trajectory.jsonl" "$base".jsonl.reset.*
        ok "removed transcript trio for $name (${#siblings[@]} file(s))"
        TIER3_TRIOS=$((TIER3_TRIOS + 1))
      done
    fi

    # Drop clawbits keys from sessions index
    INDEX="$SESSIONS_DIR/sessions.json"
    if [ -f "$INDEX" ]; then
      if [ "$DRY_RUN" = "1" ]; then
        WOULD_DROP=$(python3 - "$INDEX" <<'PY'
import json, sys
d = json.loads(open(sys.argv[1]).read())
if isinstance(d, list):
    print(sum(1 for k in d if 'clawbits' in k))
elif isinstance(d, dict):
    print(sum(1 for k in d if 'clawbits' in k))
else:
    print(0)
PY
)
        if [ "$WOULD_DROP" -gt 0 ]; then
          warn "would drop $WOULD_DROP clawbits key(s) from sessions.json"
        else
          detail "no clawbits keys in sessions.json"
        fi
      else
        DROPPED=$(python3 - "$INDEX" <<'PY'
import json, pathlib, sys
p = pathlib.Path(sys.argv[1])
d = json.loads(p.read_text())
if isinstance(d, list):
    n_before = len(d)
    d = [k for k in d if 'clawbits' not in k]
    dropped = n_before - len(d)
elif isinstance(d, dict):
    n_before = len(d)
    d = {k: v for k, v in d.items() if 'clawbits' not in k}
    dropped = n_before - len(d)
else:
    dropped = 0
p.write_text(json.dumps(d, indent=2))
print(dropped)
PY
)
        if [ "$DROPPED" -gt 0 ]; then
          ok "dropped $DROPPED clawbits key(s) from sessions.json"
          TIER3_KEYS_DROPPED=$DROPPED
        else
          detail "no clawbits keys in sessions.json"
        fi
      fi
    else
      detail "sessions.json not present"
    fi
  fi
fi

# ── tier 4 — rebuild + reinstall (opt-in) ──────────────────────────────────
if [ "$REINSTALL" = "1" ]; then
  section "Tier 4 — rebuild and reinstall (--reinstall)"
  # OpenClaw 2026.8 ("2.0") gates every external-plugin install behind a
  # capability-consent review and throws ManagedPluginLifecycleError unless an
  # operator accepts the declared surface. A local-path install can NEVER
  # inherit an earlier acceptance (the install record pins no artifact
  # integrity, so OpenClaw cannot prove the new bytes are the approved ones),
  # so this asks every run. Probe --help and pass the flag only when this
  # OpenClaw knows it: pre-2026.8 CLIs hard-error on an unknown option, and
  # this script has to keep working on both.
  CAP_FLAG=""
  if command -v openclaw >/dev/null 2>&1 &&
    openclaw plugins install --help 2>/dev/null | grep -q -- --accept-capabilities; then
    CAP_FLAG="--accept-capabilities"
  fi
  if [ "$DRY_RUN" = "1" ]; then
    warn "would run: (cd $REPO_PLUGIN_DIR && npm run build)"
    warn "would run: node stage-channel.mjs <stage>/channel --vendor-deps"
    warn "would run: node stage-tools.mjs <stage>/tools --vendor-deps"
    warn "would run: openclaw plugins install <stage>/channel --force $CAP_FLAG"
    warn "would run: openclaw plugins install <stage>/tools --force $CAP_FLAG"
  else
    if ! command -v npm >/dev/null 2>&1; then
      fail "npm not on PATH; cannot rebuild"
    elif ! command -v openclaw >/dev/null 2>&1; then
      fail "openclaw CLI not on PATH; cannot reinstall"
    else
      ok "building dist/ via: npm run build"
      if BUILD_OUT=$(cd "$REPO_PLUGIN_DIR" && npm run build 2>&1); then
        printf '%s\n' "$BUILD_OUT" | tail -3 | sed "s/^/      ${DIM}/" | sed "s/\$/${RESET}/"
        ok "build succeeded"
        # Pre-install scrub: openclaw's install step refuses to overwrite
        # an existing dir in `install` mode, and the `--force → update`
        # behavior has shifted across releases. Removing the dir up-front
        # is bullet-proof across versions. Skipped when --no-uninstall
        # since the user explicitly opted to preserve state.
        if [ "$SKIP_UNINSTALL" = "0" ] && [ -d "$INSTALL_DIR" ]; then
          rm -rf "$INSTALL_DIR"
          ok "pre-install scrub: removed $INSTALL_DIR"
        fi
        # Stage and install BOTH halves. The repo root is only the CHANNEL
        # package; the companion lives behind package.tools.json. Installing the
        # repo dir alone leaves cron, email, usage and skills on the old code.
        # --vendor-deps copies `typebox` into the staged companion, which a path
        # install would otherwise never install (OpenClaw copies the directory
        # and runs no dependency step, so the plugin loads with status: error).
        STAGE_DIR="$(mktemp -d -t clawbits-refresh-src.XXXXXX)"
        if ! STAGE_OUT=$( (cd "$REPO_PLUGIN_DIR" \
          && node stage-channel.mjs "$STAGE_DIR/channel" --vendor-deps \
          && node stage-tools.mjs "$STAGE_DIR/tools" --vendor-deps) 2>&1); then
          fail "staging failed; not running install:"
          printf '%s\n' "$STAGE_OUT" | sed 's/^/      /'
          rm -rf "$STAGE_DIR"
        else
          printf '%s\n' "$STAGE_OUT" | sed "s/^/      ${DIM}/" | sed "s/\$/${RESET}/"
          INSTALL_FAILED=0
          for part in channel tools; do
            ok "installing $part via: openclaw plugins install $STAGE_DIR/$part --force $CAP_FLAG"
            # shellcheck disable=SC2086 # CAP_FLAG is a single flag or empty by construction
            if INSTALL_OUT=$(openclaw plugins install "$STAGE_DIR/$part" --force $CAP_FLAG 2>&1); then
              printf '%s\n' "$INSTALL_OUT" | sed "s/^/      ${DIM}/" | sed "s/\$/${RESET}/"
            else
              INSTALL_FAILED=1
              fail "openclaw install failed for $part:"
              printf '%s\n' "$INSTALL_OUT" | sed 's/^/      /'
            fi
          done
          rm -rf "$STAGE_DIR"
          if [ "$INSTALL_FAILED" = "0" ]; then
            ok "openclaw install completed for channel and tools (gateway auto-restart triggered)"
            TIER4_RAN=1
          fi
        fi
      else
        fail "build failed; not running install"
        printf '%s\n' "$BUILD_OUT" | tail -10 | sed 's/^/      /'
      fi
    fi
  fi
fi

# ── verification ───────────────────────────────────────────────────────────
section "Verify"
RESIDUAL_FILES=$(find "$HOME/.openclaw" -maxdepth 4 -iname '*clawbits*' 2>/dev/null | wc -l | tr -d ' ')
RESIDUAL_CONFIG=$(count_clawbits_lines "$HOME/.openclaw/openclaw.json")

# Repo source must be untouched BY THIS SCRIPT. We diff the porcelain
# git status against the baseline captured at script start, so the user's
# in-progress edits don't trip this defensive check — only changes the
# script itself introduced will be flagged.
if [ -n "$REPO_BASELINE" ] || git -C "${REPO_ROOT:-/dev/null}" rev-parse --git-dir >/dev/null 2>&1; then
  REPO_NOW=$(git -C "$REPO_ROOT" status --porcelain -- "$REPO_PLUGIN_NAME" 2>/dev/null || true)
  NEW_OR_CHANGED=$(diff <(printf '%s\n' "$REPO_BASELINE") <(printf '%s\n' "$REPO_NOW") | grep '^>' | sed 's/^> //' || true)
  if [ -z "$NEW_OR_CHANGED" ]; then
    if [ -n "$REPO_BASELINE" ]; then
      ok "repo source: no changes introduced by this run ($(printf '%s' "$REPO_BASELINE" | wc -l | tr -d ' ') pre-existing edit(s) ignored)"
    else
      ok "repo source untouched: $REPO_PLUGIN_DIR"
    fi
  else
    fail "this script wrote to the repo source — investigate:"
    printf '%s\n' "$NEW_OR_CHANGED" | sed 's/^/      /'
  fi
fi

if [ "$RESIDUAL_FILES" = "0" ]; then
  ok "no clawbits files left under ~/.openclaw (maxdepth=4)"
else
  warn "$RESIDUAL_FILES clawbits path(s) remain under ~/.openclaw:"
  find "$HOME/.openclaw" -maxdepth 4 -iname '*clawbits*' 2>/dev/null | sed 's|^|      |'
  detail "these may be owned by something the script doesn't manage (e.g. install dir if you skipped \`openclaw plugins uninstall\`)"
fi

if [ "$RESIDUAL_CONFIG" = "0" ]; then
  ok "openclaw.json has no clawbits references"
else
  warn "$RESIDUAL_CONFIG clawbits line(s) still in openclaw.json:"
  grep -n -i clawbits "$HOME/.openclaw/openclaw.json" | sed 's|^|      |'
  detail "run \`openclaw plugins uninstall clawbits --force\` to clean these"
fi

# ── summary ────────────────────────────────────────────────────────────────
ELAPSED=$((SECONDS - START_TIME))
section "Summary"
if [ "$DRY_RUN" = "1" ]; then
  muted "dry-run — nothing was actually changed"
else
  if [ "$SKIP_UNINSTALL" = "1" ]; then
    printf '  %s tier 0: skipped (--no-uninstall)\n' "$BOLD"
  elif [ "$TIER0_RAN" = "1" ]; then
    printf '  %s tier 0: openclaw plugins uninstall — ok\n' "$BOLD"
  else
    printf '  %s tier 0: nothing to uninstall (clawbits not registered)\n' "$BOLD"
  fi
  printf '  %s tier 1: %d file(s) removed\n' "$BOLD" "$TIER1_FILES"
  printf '  %s tier 2: %d line(s) stripped across %d file(s)\n' "$BOLD" "$TIER2_LINES_STRIPPED" "$TIER2_FILES_TOUCHED"
  if [ "$SKIP_TIER3" = "0" ]; then
    printf '  %s tier 3: %d transcript trio(s) removed, %d key(s) dropped from index\n' "$BOLD" "$TIER3_TRIOS" "$TIER3_KEYS_DROPPED"
  else
    printf '  %s tier 3: skipped (--no-tier3)\n' "$BOLD"
  fi
  if [ "$REINSTALL" = "1" ]; then
    if [ "$TIER4_RAN" = "1" ]; then
      printf '  %s tier 4: build + reinstall — ok\n' "$BOLD"
    else
      printf '  %s tier 4: build or reinstall failed (see above)\n' "$BOLD"
    fi
  else
    printf '  %s tier 4: skipped (pass --reinstall to enable)\n' "$BOLD"
  fi
  printf '%s' "$RESET"
fi
printf '  %sfinished in %ds%s\n' "$DIM" "$ELAPSED" "$RESET"
