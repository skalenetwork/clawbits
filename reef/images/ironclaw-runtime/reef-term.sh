#!/usr/bin/env bash
# Scoped web-terminal shell for a Reef IronClaw agent (served by ttyd, behind the
# per-agent secret). Default: a narrow prompt that only drives the `ironclaw` CLI
# — config/model/channel management, no general shell. REEF_TERMINAL_SHELL=full
# swaps in a real login shell (the owner's own microVM, so it's their call).
set -uo pipefail

if [ "${REEF_TERMINAL_SHELL:-}" = "full" ]; then
  exec bash -l
fi

export IRONCLAW_BASE_DIR="${IRONCLAW_BASE_DIR:-${HOME:-/home/ironclaw}/.ironclaw}"

cat <<'BANNER'
Reef · scoped ironclaw shell. Type ironclaw subcommands, e.g.:
  config get llm_backend      status      onboard --step provider
`exit` to close. (REEF_TERMINAL_SHELL=full for a real shell.)
BANNER

while true; do
  printf 'ironclaw> '
  IFS= read -r line || break
  # Allow an optional leading "ironclaw" so both `status` and `ironclaw status` work.
  line="${line#ironclaw }"
  case "${line}" in
    "") continue ;;
    exit | quit) break ;;
  esac
  # Word-split into argv and hand straight to the binary — NOT eval, so shell
  # metacharacters (;, |, $()) are literal args, never re-interpreted.
  # shellcheck disable=SC2086
  ironclaw ${line} || true
done
