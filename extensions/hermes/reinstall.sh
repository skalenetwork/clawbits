#!/usr/bin/env bash
#
# Install or upgrade the Clawbits platform plugin in one self-hosted Hermes profile.
#
# Default (install/upgrade): stage this directory, validate it with the real Hermes
# loader, switch it in, restart only this profile's gateway, and roll back to the
# previous plugin if the gateway does not come back healthy. Identity (.env),
# config.yaml and the plugin's state (plugin-data/clawbits-platform) are never touched.
#
#   ./reinstall.sh                                         # install or upgrade
#   ./reinstall.sh --signup-token TOKEN [--endpoint URL]   # ... and enroll
#   ./reinstall.sh --profile work                          # another Hermes profile
#   ./reinstall.sh --no-restart                            # switch files only
#   ./reinstall.sh --profile work --restart-default        # work is served by the default
#                                                          # gateway: restart that (all its profiles)
#   ./reinstall.sh --rollback                              # swap back to the previous plugin
#   ./reinstall.sh --reset [-y] ...                        # DESTRUCTIVE: forget this profile's
#                                                          # Clawbits identity and local state
#
# Exit: 0 ok (a degraded subsystem prints a warning), 1 failed (nothing changed, rolled
#       back, or signup failed), 2 usage, or run from a bundled image install (upgrade by
#       replacing the image), 3 profile served by the default gateway, so not restarted
#       (see --restart-default), 4 signup token unused (the profile already has an agent)
# Env:  HERMES_HOME (default ~/.hermes), CLAWBITS_UPGRADE_WAIT (health wait, 120s),
#       CLAWBITS_RESTART_SETTLE (seconds a restart may take before it counts as running, 20)
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_NAME="clawbits-platform"
MODE=upgrade ASSUME_YES=0 RESTART=1 RESTART_DEFAULT=0 PROFILE="" ENDPOINT="" SIGNUP_TOKEN=""
WAIT="${CLAWBITS_UPGRADE_WAIT:-120}" SETTLE="${CLAWBITS_RESTART_SETTLE:-20}"
value() { [[ -n "${2:-}" ]] || { echo "error: $1 needs a value" >&2; exit 2; }; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    --reset)           MODE=reset; shift ;;
    --rollback)        MODE=rollback; shift ;;
    --no-restart)      RESTART=0; shift ;;
    --restart-default) RESTART_DEFAULT=1; shift ;;
    -y|--yes)          ASSUME_YES=1; shift ;;
    -p|--profile)      value "$@"; PROFILE="$2"; shift 2 ;;
    --endpoint)        value "$@"; ENDPOINT="$2"; shift 2 ;;
    --signup-token)    value "$@"; SIGNUP_TOKEN="$2"; shift 2 ;;
    -h|--help)         sed -n '3,/^set /p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
command -v hermes >/dev/null 2>&1 || { echo "error: 'hermes' is not on PATH" >&2; exit 1; }

# Profile: the same resolution as `hermes` itself (HERMES_HOME profile dir, -p, active_profile).
ROOT="${HERMES_HOME:-$HOME/.hermes}"
if [[ "$(basename "$(dirname "$ROOT")")" == profiles ]]; then
  PROFILE="${PROFILE:-$(basename "$ROOT")}"; ROOT="$(dirname "$(dirname "$ROOT")")"
fi
PROFILE="${PROFILE:-$(cat "$ROOT/active_profile" 2>/dev/null || true)}"; PROFILE="${PROFILE:-default}"
[[ "$PROFILE" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || { echo "error: invalid profile name '$PROFILE'" >&2; exit 2; }
if [[ "$PROFILE" == default ]]; then HOME_DIR="$ROOT"; else HOME_DIR="$ROOT/profiles/$PROFILE"; fi
[[ "$PROFILE" == default || -d "$HOME_DIR" ]] || { echo "error: profile '$PROFILE' not found at $HOME_DIR" >&2; exit 1; }
hermes_p() { HERMES_HOME="$ROOT" hermes -p "$PROFILE" "$@" </dev/null; }

# The Reef image bakes this plugin under plugins/platforms/; a copy staged into
# $HOME_DIR/plugins would live on the persistent volume and shadow it at every later
# start, pinning the agent to one day's version across image replacements.
if [[ "$(basename "$(dirname "$SRC_DIR")")" == platforms \
      && "$SRC_DIR" != "$HOME_DIR/plugins/"* ]]; then
  echo "error: $SRC_DIR is a bundled image install; upgrade by replacing the image." >&2
  echo "       Check it with 'hermes clawbits doctor'; recover with 'hermes clawbits inbox'." >&2
  exit 2
fi

DEST="$HOME_DIR/plugins/$PLUGIN_NAME"
STATE="$HOME_DIR/plugin-data/$PLUGIN_NAME"
# Hermes loads EVERY directory under plugins/ (the last one scanned wins), so the
# staged and previous copies live beside it, never inside it.
WORK="$HOME_DIR/clawbits-upgrade"; STAGE="$WORK/stage"; PREV="$WORK/prev"
LOG="$WORK/upgrade.log"
mkdir -p "$WORK"
mkdir "$WORK/lock" 2>/dev/null || { echo "error: another upgrade holds $WORK/lock (remove it if none is running)" >&2; exit 1; }
trap 'rmdir "$WORK/lock" 2>/dev/null || true' EXIT
# A crash between the two renames of a switch leaves only the previous copy.
if [[ ! -d "$DEST" && -d "$PREV" ]]; then mv "$PREV" "$DEST"; echo "==> restored $DEST from an interrupted switch"; fi

echo "Clawbits Hermes plugin: $MODE, profile '$PROFILE' ($HOME_DIR)"

has_identity() { grep -q '^CLAWBITS_API_KEY=.' "$HOME_DIR/.env" 2>/dev/null && grep -q '^CLAWBITS_AGENT_ID=.' "$HOME_DIR/.env"; }
agent_id() { sed -n 's/^CLAWBITS_AGENT_ID=//p' "$HOME_DIR/.env" 2>/dev/null | tail -1 || true; }

swap_back() {  # exchange the live and previous plugin directories
  [[ -d "$PREV" ]] || { echo "error: no previous plugin in $PREV" >&2; return 1; }
  rm -rf "$WORK/swap"; mv "$DEST" "$WORK/swap"; mv "$PREV" "$DEST"; mv "$WORK/swap" "$PREV"
}

restart_gateway() {  # $1 profile; 0 restarted (or running detached), 78 served by the multiplexer, else failed
  echo "==> restarting the '$1' gateway (console: $WORK/gateway.out)"
  # `hermes gateway restart` returns once a service manager restarted the gateway; with
  # no service it stops this profile's gateway and runs the new one in the foreground,
  # so it is detached and only an early exit is judged. That gateway is unsupervised:
  # a caller's systemd INVOCATION_ID would make Hermes treat it as supervised.
  nohup env -u INVOCATION_ID HERMES_HOME="$ROOT" hermes -p "$1" gateway restart >"$WORK/gateway.out" 2>&1 </dev/null &
  local pid=$! i
  for ((i = 0; i < SETTLE; i++)); do
    sleep 1
    if ! kill -0 "$pid" 2>/dev/null; then wait "$pid"; return $?; fi
  done
  return 0
}

healthy() {  # doctor exit: 0 healthy, 1 degraded but receiving, 3 not ready; anything else fails
  [[ -f "$DEST/doctor.py" ]] || { echo "   (this plugin version has no doctor; check the gateway log)"; return 0; }
  local rc=0; hermes_p clawbits doctor --wait "$WAIT" --since "$1" || rc=$?
  [[ $rc -eq 1 ]] && echo "WARNING: the gateway is receiving, but a subsystem is degraded (above)."
  [[ $rc -le 1 ]]
}

activate() {  # restart + health gate; roll back to $PREV on failure
  local since rc=0 gw="$PROFILE"
  if [[ $RESTART -eq 0 ]] || ! has_identity; then
    echo "==> not restarting. Restart the gateway, then check:  hermes -p $PROFILE clawbits doctor"
    return 0
  fi
  since=$(date +%s)
  restart_gateway "$gw" || rc=$?
  if [[ $rc -eq 78 && $RESTART_DEFAULT -eq 1 ]]; then gw=default rc=0; restart_gateway "$gw" || rc=$?; fi
  if [[ $rc -eq 78 ]]; then
    echo "error: profile '$PROFILE' is served by the default gateway, so applying this restarts every profile it serves." >&2
    echo "       Re-run with --restart-default, or --no-restart and restart it yourself${SIGNUP_TOKEN:+ (omit --signup-token: the profile is enrolled)}." >&2
    if [[ -d "$PREV" ]]; then swap_back; echo "       The previous plugin is restored." >&2; fi
    return 3
  fi
  if [[ $rc -eq 0 ]] && healthy "$since"; then return 0; fi
  echo "error: the gateway did not come back healthy (restart rc=$rc); rolling back" >&2
  tail -n 20 "$WORK/gateway.out" >&2 || true
  [[ -d "$PREV" ]] || return 1
  swap_back
  since=$(date +%s); restart_gateway "$gw" && healthy "$since" && echo "==> previous plugin restored" >&2
  return 1
}

if [[ $MODE == rollback ]]; then
  swap_back
  echo "==> switched to $(sed -n 's/^version: *//p' "$DEST/plugin.yaml") (the other copy is kept in $PREV)"
  if [[ -f "$STATE/inbox.db" && ! -f "$DEST/inbox_state.py" ]]; then
    echo "WARNING: this version predates the intake journal; work it handles is outside the journal and the next upgrade holds it for review."
  fi
  activate; exit $?
fi

if [[ $MODE == reset && $ASSUME_YES -ne 1 ]]; then
  echo "This FORGETS profile '$PROFILE''s Clawbits agent: removes CLAWBITS_* from $HOME_DIR/.env"
  echo "and moves the plugin and its local state (cursors, queue, outbox) to $WORK/reset-*."
  reply=""; read -r -p "Proceed? [y/N] " reply || true
  [[ "$reply" =~ ^[Yy]$ ]] || { echo "aborted."; exit 1; }
fi

# Stage and validate with the real loader in a throwaway Hermes home.
rm -rf "$STAGE"; mkdir -p "$STAGE/plugins"
cp -R "$SRC_DIR" "$STAGE/plugins/$PLUGIN_NAME"
find "$STAGE" -type d -name '__pycache__' -prune -exec rm -rf {} +
printf 'plugins:\n  enabled: [%s]\n' "$PLUGIN_NAME" > "$STAGE/config.yaml"
echo "==> validating $(sed -n 's/^version: *//p' "$SRC_DIR/plugin.yaml") against $(hermes --version 2>/dev/null | head -1)"
if ! HERMES_HOME="$STAGE" hermes -p default clawbits doctor --preflight </dev/null; then
  echo "error: validation failed; nothing was changed. Loader errors:" >&2
  tail -n 20 "$STAGE/logs/errors.log" >&2 2>/dev/null || true
  exit 1
fi

if [[ $MODE == reset ]]; then
  rc=0; hermes_p gateway stop >>"$LOG" 2>&1 || rc=$?
  if [[ $rc -eq 78 ]]; then
    echo "error: profile '$PROFILE' is served by the default gateway; nothing was changed. Stop that gateway" >&2
    echo "       (hermes gateway stop: every profile it serves goes offline), rerun with --no-restart, then start it." >&2
    exit 3
  fi
  [[ $rc -eq 0 ]] || { echo "error: could not stop the '$PROFILE' gateway (see $LOG); nothing was changed." >&2; exit 1; }
  saved="$(mktemp -d "$WORK/reset-$(date +%Y%m%d%H%M%S).XXXX")"
  for item in "plugins/$PLUGIN_NAME" "plugin-data/$PLUGIN_NAME" clawbits-read-cursors.json clawbits-email-watermark.json .clawbits_greeted; do
    if [[ -e "$HOME_DIR/$item" ]]; then mkdir -p "$saved/$(dirname "$item")"; mv "$HOME_DIR/$item" "$saved/$item"; fi
  done
  if [[ -f "$HOME_DIR/.env" ]]; then
    tmp="$(mktemp "$HOME_DIR/.env.XXXXXX")"; grep -v '^CLAWBITS_' "$HOME_DIR/.env" > "$tmp" || true; mv "$tmp" "$HOME_DIR/.env"
  fi
  echo "==> previous plugin and state saved in $saved"
fi

# Switch: the previous copy stays outside plugins/ until the new one is healthy.
fresh=0; [[ -d "$DEST" ]] || fresh=1
rm -rf "$PREV"; mkdir -p "$(dirname "$DEST")"
[[ $fresh -eq 1 ]] || mv "$DEST" "$PREV"
mv "$STAGE/plugins/$PLUGIN_NAME" "$DEST"; rm -rf "$STAGE"
if [[ $fresh -eq 1 ]]; then
  hermes_p plugins enable "$PLUGIN_NAME" >>"$LOG" 2>&1 || echo "WARNING: run 'hermes -p $PROFILE plugins enable $PLUGIN_NAME'" >&2
fi

if [[ -n "$SIGNUP_TOKEN" ]]; then
  before="$(agent_id)"
  if ! hermes_p clawbits signup --signup-token "$SIGNUP_TOKEN" ${ENDPOINT:+--endpoint "$ENDPOINT"}; then
    echo "error: signup failed (above). The plugin is installed; profile '$PROFILE' has no Clawbits identity." >&2
    exit 1
  fi
  if [[ -n "$before" && "$(agent_id)" == "$before" ]]; then
    echo "NOTE: profile '$PROFILE' already has an active agent ($before); the signup token was NOT used." >&2
    echo "      Use a new profile (hermes profile create NAME; --profile NAME) or --reset this one." >&2
    rc=0; activate || rc=$?
    [[ $rc -eq 1 ]] && exit 1
    exit 4
  fi
fi
has_identity || echo "Next: hermes -p $PROFILE clawbits signup --signup-token <TOKEN> [--endpoint <URL>]"
activate
