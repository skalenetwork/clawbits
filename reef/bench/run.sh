#!/bin/sh
set -eu
reef=${REEF:-$HOME/.local/bin/reef}
log=/home/node/.openclaw/state/bench.log
export REEF_STATE="${XDG_STATE_HOME:-$HOME/.local/state}/reef-bench"

if [ "${1:?usage: run.sh ROLE.toml [IMAGE] | run.sh clean}" = clean ]; then
  exec "$reef" agent rm bench --volumes
fi
python3 "$(dirname "$0")/role.py" "$@" | "$reef" role apply /dev/stdin >/dev/null
if "$reef" agent get bench >/dev/null 2>&1; then
  "$reef" agent rm bench ${FRESH:+--volumes} >/dev/null
fi
signup=$(cat "${SIGNUP:-/dev/null}")

t0=$(date +%s.%N)
printf 'version = 1\n[agents.bench]\nrole = "bench"\n[agents.bench.env]\n%s\n' "$signup" |
  "$reef" fleet apply /dev/stdin >/dev/null
t1=$(date +%s.%N)

for _ in $(seq 600); do
  "$reef" agent exec bench -- cat "$log" 2>/dev/null |
    awk -v t="$t0" -v e="${END:-connected}" '$1 >= t && $2 == e { f = 1 } END { exit !f }' && break
  sleep 1
done

{ echo "$t0 apply"; echo "$t1 apply"; "$reef" agent exec bench -- cat "$log"; } | sort -n | awk -v t="$t0" '
  $1 >= t { e = substr($0, index($0, " ") + 1); if (!(e in a)) { a[e] = $1; o[++n] = e }; z[e] = $1 }
  END { for (i = 1; i <= n; i++) { e = o[i]; printf "%7.1f %7s  %s\n", a[e] - t, (z[e] > a[e] ? sprintf("%.1f", z[e] - a[e]) : ""), e } }'
