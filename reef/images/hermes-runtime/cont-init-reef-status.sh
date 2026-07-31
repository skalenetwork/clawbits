#!/command/with-contenv sh
# s6 cont-init hook — runs as ROOT, before main-wrapper drops to the `hermes` user.
#
# REEF_STATUS_DIR (HermesProfile.status_dir = /opt/data/.reef) is a reef-managed
# volume mounted into the guest. It arrives root-owned, so the unprivileged agent
# cannot write status.json into it:
#
#   reef-hermes-run: /opt/data/.reef/status.json.tmp: Permission denied
#
# That failure is quiet but not harmless: status.json is how the agent reports its
# hermes + clawbits-plugin versions, so without it reef shows no versions and the
# version-based upgrade signal never fires (see fleet._version_signal). The
# workspace volume at /opt/data is already bootstrapped by the base image's own
# cont-init, which is why the plugin install works and only this mount fails.
#
# with-contenv is required in the shebang: /init scrubs the environ, and this needs
# REEF_STATUS_DIR back.
set -e
[ -n "${REEF_STATUS_DIR:-}" ] || exit 0
mkdir -p "$REEF_STATUS_DIR" 2>/dev/null || true
chown -R hermes:hermes "$REEF_STATUS_DIR" 2>/dev/null || true
exit 0
