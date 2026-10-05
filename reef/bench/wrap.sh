#!/bin/sh
log=/home/node/.openclaw/state/bench.log
mark() { echo "$(date +%s.%N) $1" >> "$log"; }
mark init
(
  while :; do
    t=$(date +%s.%N)
    grep -ash . /proc/[0-9]*/cmdline | tr '\0' ' ' | awk -v t="$t" '{
      for (i = 1; i <= NF; i++) if ($i ~ /^\/.*\/(openclaw\.mjs|clawbits-boot\.ts)$/) {
        s = $i; sub(/.*\//, "", s); sub(/\..*/, "", s)
        for (j = i + 1; j <= NF && j <= i + 2 && $j !~ /^-/; j++) s = s " " $j
        print t, s; next
      }
    }' | sort -u >> "$log"
    sleep 0.25
  done &
  until curl -so /dev/null -m 1 http://127.0.0.1:18789/; do sleep 0.25; done
  kill $!
  mark http
  until grep -qs 'gateway ready' /tmp/openclaw/openclaw-*.log; do sleep 0.25; done
  mark ready
  until grep -qs 'agent WebSocket connected' /tmp/openclaw/openclaw-*.log; do sleep 0.25; done
  mark connected
) &
exec "$@"
