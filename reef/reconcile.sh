#!/bin/sh
# One tick: pull what the org declared, apply it, push what this host observed.
# Nothing retries in here; the next tick is the retry.
set -eu

: "${REEF_HOST:?REEF_HOST is required}"
: "${REEF_DIR:=$HOME/agents}"
REEF="${REEF:-$HOME/.local/bin/reef}"

# A host that cannot see the repo changes nothing.
for tree in main fleet status; do
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

applied="$REEF_DIR/applied"
declared="$(git -C "$REEF_DIR/main" rev-parse HEAD) $(git -C "$REEF_DIR/fleet" rev-parse HEAD)"
rc=0
if [ "$declared" != "$(cat "$applied" 2>/dev/null || true)" ]; then
  # The HEADs are recorded only once both applies land, so a failure is retried
  # next tick. Status is written either way: a failed agent's state and reason
  # are the only diagnosis the org gets.
  if apply; then printf '%s' "$declared" > "$applied"; else rc=1; fi
fi

# Built from `agent list`, never `agent get`: the detail row prints env, and env
# carries the signup token.
file="$REEF_DIR/status/status/$REEF_HOST.json"
mkdir -p "${file%/*}"
jq -n \
  --arg host "$REEF_HOST" \
  --arg reef "$("$REEF" --version | cut -d' ' -f2)" \
  --argjson roles "$("$REEF" role list --json)" \
  --argjson agents "$("$REEF" agent list --json)" \
  --argjson events "$("$REEF" events --json | jq '.[-100:]')" \
  '{host: $host, reef: $reef, roles: $roles, agents: $agents, events: $events}' > "$file"

git -C "$REEF_DIR/status" add "status/$REEF_HOST.json"
if ! git -C "$REEF_DIR/status" diff --cached --quiet; then
  git -C "$REEF_DIR/status" commit --quiet -m "status $REEF_HOST"
  git -C "$REEF_DIR/status" push --quiet
fi

exit $rc
