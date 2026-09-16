#!/bin/sh
# One tick: pull what the org declared, apply it or bring back what died, push
# what this host observed. Nothing retries in here; the next tick is the retry.
set -eu

: "${REEF_HOST:?REEF_HOST is required}"
: "${REEF_DIR:=$HOME/agents}"
REEF="${REEF:-$HOME/.local/bin/reef}"

# A TCP connection GitHub silently dropped (laptop slept, network changed)
# otherwise hangs a tick forever and the loop never ticks again: keepalives
# turn it into a failure the next tick retries.
export GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -o ConnectTimeout=10 -o ServerAliveInterval=10 -o ServerAliveCountMax=3}"

# A host that cannot see the repo changes nothing.
for tree in main fleet; do
  git -C "$REEF_DIR/$tree" pull --quiet --ff-only
done

apply() {
  "$REEF" role apply "$REEF_DIR"/main/roles/*.toml || return 1
  # empty.toml keeps --prune meaningful: reef bails when handed no files, and a
  # partial list with --prune deletes every agent it cannot see.
  set -- "$REEF_DIR/empty.toml"
  for entry in "$REEF_DIR/fleet/fleet/$REEF_HOST"/*.toml; do
    [ -f "$entry" ] && set -- "$@" "$entry"
  done
  "$REEF" fleet apply "$@" --prune || return 1
}

# reef closes a failed command with a summary line; the cause is the last
# "subject: reason" line before it, when there is one.
cause() {
  printf '%s\n' "$1" |
    { grep -E '^[^ ]+: ' | grep -v '^Error: ' || printf '%s\n' "$1"; } |
    tail -n 1 | sed 's/^[[:space:]]*//' | cut -c 1-200
}

applied="$REEF_DIR/applied"
declared="$(git -C "$REEF_DIR/main" rev-parse HEAD) $(git -C "$REEF_DIR/fleet" rev-parse HEAD)"
result=ok
error=
if [ "$declared" != "$(cat "$applied" 2>/dev/null || true)" ]; then
  # The HEADs are recorded only once both applies land, so a failure is retried
  # next tick. Status is written either way: a failed agent's state and reason
  # are the only diagnosis the org gets.
  if out="$(apply 2>&1)"; then
    printf '%s' "$declared" > "$applied"
  else
    result=failed
    error="$(cause "$out")"
  fi
  printf '%s\n' "$out"
elif ! out="$("$REEF" reconcile 2>&1)"; then
  result=failed
  error="$(cause "$out")"
  printf '%s\n' "$out"
fi

# Built from `agent list`, never `agent get`: the detail row prints env, and env
# carries the signup token. `at` is the heartbeat, rounded down to ten minutes
# so an idle host commits about that often and never on every tick.
at="$(date -u +%Y-%m-%dT%H:%M)"
file="$REEF_DIR/status/status/$REEF_HOST.json"
mkdir -p "${file%/*}"
jq -n \
  --arg host "$REEF_HOST" \
  --arg reef "$("$REEF" --version | cut -d' ' -f2)" \
  --arg at "${at%?}0:00Z" \
  --arg applied "$(cat "$applied" 2>/dev/null || true)" \
  --arg result "$result" \
  --arg error "$error" \
  --argjson roles "$("$REEF" role list --json)" \
  --argjson agents "$("$REEF" agent list --json)" \
  --argjson events "$("$REEF" events --json | jq '.[-100:]')" \
  '{host: $host, reef: $reef, at: $at,
    applied: ($applied | split(" ") | if length == 2 then {main: .[0], fleet: .[1]} else null end),
    result: $result, error: (if $error == "" then null else $error end),
    roles: $roles, agents: $agents, events: $events}' > "$file"

git -C "$REEF_DIR/status" add "status/$REEF_HOST.json"
git -C "$REEF_DIR/status" diff --cached --quiet ||
  git -C "$REEF_DIR/status" commit --quiet -m "status $REEF_HOST"
# Every host commits near the same ten-minute mark, each to its own file, so
# rebasing onto whoever pushed first never conflicts. Pushing whatever is ahead,
# not only this tick's commit, is what lands a lost race on the next tick.
if [ -n "$(git -C "$REEF_DIR/status" rev-list '@{u}..')" ]; then
  git -C "$REEF_DIR/status" pull --quiet --rebase
  git -C "$REEF_DIR/status" push --quiet
fi

[ "$result" = ok ]
