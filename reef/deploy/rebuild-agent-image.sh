#!/usr/bin/env bash
# Rebuild the Reef agent image with the LATEST clawbits plugin, then load it into
# the Reef service user's microsandbox store — the two steps that have to happen
# together for `msb create` to pick up a new plugin.
#
# Why this isn't just `build.sh`:
#   1. The plugin is installed from the clawhub registry at build time and Docker
#      caches that layer, so a plain rebuild keeps the stale plugin. We force a
#      clean resolve (REEF_NO_CACHE=1) so it pulls whatever clawhub serves now.
#   2. msb images are PER-USER. The API runs as `reef`, so the image must land in
#      reef's store via `sudo -u reef -H msb image load` — a plain `msb image load`
#      (as root) loads into root's store and the service never sees it.
#
# Usage (on the Reef host, as root):
#   sudo reef/deploy/rebuild-agent-image.sh            # latest plugin, current image VERSION
#   sudo reef/deploy/rebuild-agent-image.sh 0.6.0      # also bump the baked image version
#
# Only NEWLY created agents use the rebuilt image; existing VMs keep the version
# they were created with — destroy + recreate an agent to migrate it.
#
# Overridable env: REEF_USER (reef), REEF_STATE_DIR (/var/lib/reef),
# REEF_OPENCLAW_IMAGE (reef-oc:plugin).
set -euo pipefail

REEF_USER="${REEF_USER:-reef}"
REEF_STATE_DIR="${REEF_STATE_DIR:-/var/lib/reef}"
image="${REEF_OPENCLAW_IMAGE:-reef-oc:plugin}"
here="$(cd "$(dirname "$0")" && pwd)"
build_sh="$here/../images/openclaw-runtime/build.sh"

# ── Preflight ─────────────────────────────────────────────────────────────────
[ "$(id -u)" -eq 0 ] || { echo "error: run with sudo (needs docker + 'sudo -u $REEF_USER')" >&2; exit 1; }
command -v docker >/dev/null || { echo "error: docker not found (the image builder)" >&2; exit 1; }
id "$REEF_USER" >/dev/null 2>&1 || { echo "error: no such user '$REEF_USER' (set REEF_USER=)" >&2; exit 1; }
sudo -u "$REEF_USER" -H bash -lc 'command -v msb >/dev/null' \
  || { echo "error: 'msb' not on $REEF_USER's PATH — install microsandbox first" >&2; exit 1; }

# ── 1. Build with a clean resolve of the clawhub-pinned plugin ────────────────
echo "==> building $image with the latest clawbits plugin (no-cache resolve)…"
REEF_NO_CACHE=1 bash "$build_sh" "$@"

# ── 2. Load into the reef user's msb store (staged in a reef-readable dir) ─────
tar="$REEF_STATE_DIR/reef-oc.tar"
echo "==> loading $image into $REEF_USER's microsandbox store…"
install -d -o "$REEF_USER" -g "$REEF_USER" -m 0750 "$REEF_STATE_DIR"
docker save "$image" -o "$tar"
chown "$REEF_USER:$REEF_USER" "$tar"
sudo -u "$REEF_USER" -H msb image load -i "$tar"
rm -f "$tar"

echo "==> done. New agents will boot the rebuilt $image."
echo "    Existing VMs keep their baked image — destroy + recreate to migrate one."
