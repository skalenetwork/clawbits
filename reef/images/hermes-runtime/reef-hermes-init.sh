#!/bin/sh
# The microsandbox boot handoff for the Hermes runtime (HermesProfile.init).
#
# WHY THIS EXISTS. msb ignores the image's ENTRYPOINT/CMD entirely: it boots the
# microVM and execs whatever `msb create --init <path>` names (reef passes
# ``profile.init``; see reef/microsandbox_runtime.py). Docker, by contrast, runs
# the image's own ENTRYPOINT+CMD. OpenClaw and IronClaw paper over that split by
# making both the same self-contained script — their ENTRYPOINT *is* their
# ``init``. Hermes can't: its base image boots through **s6-overlay**, so the
# chain has three links, and `--init` takes a single path with no args. This shim
# is that single path, and it reproduces the docker chain exactly:
#
#   ENTRYPOINT ["/init", "/opt/hermes/docker/main-wrapper.sh"]  +  CMD [reef-hermes-run]
#
# `/init` MUST be PID 1 — it is not decoration:
#   • it runs the cont-init bootstrap (stage2-hook.sh), which fixes ownership on
#     /opt/data (HERMES_HOME, the reef volume mount);
#   • it populates /run/s6/container_environment, which main-wrapper.sh's
#     `#!/command/with-contenv sh` shebang reads — /init scrubs the environ before
#     invoking the main program, so WITHOUT this the whole CLAWBITS_*/HERMES_* env
#     reef injects is silently lost;
#   • main-wrapper.sh then drops root → hermes via s6-setuidgid.
#
# So do NOT "simplify" this to `exec /usr/local/bin/reef-hermes-run`: that runs as
# root, with a scrubbed environment, against an unbootstrapped /opt/data.
#
# Skipping the handoff altogether (init = None, the original bug) meant msb booted
# the VM and started nothing at all: no dashboard listener, and a 0-byte kernel.log
# — which is the file reef's log endpoint falls back to reading, hence "no logs".
exec /init /opt/hermes/docker/main-wrapper.sh /usr/local/bin/reef-hermes-run
