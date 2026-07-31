#!/bin/sh
# The command ttyd spawns for the Reef web terminal (one fresh instance per
# browser session). Default = a real login shell (full access);
# REEF_TERMINAL_SHELL=openclaw → the narrow OpenClaw-only shell (reef-term.mjs)
# for setups that still want the restricted UX. Kept tiny so the toggle is obvious.
case "${REEF_TERMINAL_SHELL:-full}" in
  openclaw) exec node /usr/local/bin/reef-term.mjs ;;
  *) exec /usr/bin/bash -l ;;
esac
