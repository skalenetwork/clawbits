#!/bin/bash
# The shell Reef's web terminal (ttyd) serves for a Hermes agent.
#
# ttyd already ran as the unprivileged `hermes` user (reef-hermes-run is past s6's
# privilege drop by the time it starts us), so this is just a login shell — no
# further sudo/root path is opened by exposing it. Auth is ttyd's basic-auth with
# reef's one-time access password.
#
# The reason this surface exists at all is the ChatGPT-subscription provider:
# openai-codex is OAuth, so reef holds no token and can inject no key. The owner has
# to complete a device-code login *inside* the guest, and this terminal is the only
# place they can run it (the dashboard's chat tab drives the agent over /api/pty, not
# a shell). So when reef marked the agent as subscription-mode, lead with the exact
# command rather than making them hunt for it.
set -u

if [ "${REEF_OPENAI_AUTH:-}" = "subscription" ]; then
    cat <<'BANNER'

  ┌────────────────────────────────────────────────────────────────────┐
  │  ChatGPT subscription — one step left                              │
  ├────────────────────────────────────────────────────────────────────┤
  │  This agent has no API key by design: reef never sees your ChatGPT │
  │  token. Finish the device-code login here, then it can think.      │
  │                                                                    │
  │    hermes login --provider openai-codex --no-browser               │
  │                                                                    │
  │  It prints a URL + code — open them in your OWN browser. Check     │
  │  afterwards with:  hermes auth status                              │
  └────────────────────────────────────────────────────────────────────┘

BANNER
fi

exec bash -l
