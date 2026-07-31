#!/usr/bin/env bash
#
# Reef production installer (Ubuntu/Debian). Idempotent — safe to re-run,
# including after a `git pull` to pick up new deps / a new dashboard build.
# Run as root from the repo checkout:
#
#   sudo reef/deploy/install.sh [--skip-image] [--skip-ui]
#
# One command does the whole host: Docker (the image builder) + uv + Python 3.14
# + deps, the service user (+ kvm group), microsandbox itself, /etc/reef/reef.env
# (with a generated REEF_ADMIN_TOKEN + REEF_SUBDOMAIN_SECRET), the reef-oc:plugin
# agent image (built in place and loaded into msb), the operator-dashboard SPA
# (built in place with bun), the systemd units, and the API + self-healing
# reconciler + daily DB-backup timer. Not covered: BIOS/OS, the git clone, and
# the tunnel — see PROD_RUNBOOK.md.
#
# (Later: once CI publishes the image to a registry, run with --skip-image and pull
#  it instead of building in place.)
#
# Env overrides:
#   REEF_RUNTIME=microsandbox|docker   (default: microsandbox — the prod runtime;
#                                       use docker on a dev box without KVM)
#   REEF_USER=reef                     service user
#   REEF_API_PORT=8787
#   REEF_STATE_DIR=/var/lib/reef       the durable desired-state DB lives here
#   REEF_ENV_FILE=/etc/reef/reef.env
#   REEF_SKIP_IMAGE=1                  skip building the agent image
#   REEF_SKIP_UI=1                     skip building the operator dashboard
set -euo pipefail

REEF_USER="${REEF_USER:-reef}"
REEF_RUNTIME="${REEF_RUNTIME:-microsandbox}"   # prod default (reef's own Linux default); docker for dev
REEF_ENV_FILE="${REEF_ENV_FILE:-/etc/reef/reef.env}"
REEF_STATE_DIR="${REEF_STATE_DIR:-/var/lib/reef}"
REEF_BACKUP_DIR="${REEF_BACKUP_DIR:-/var/backups/reef}"
REEF_API_PORT="${REEF_API_PORT:-8787}"
SKIP_IMAGE="${REEF_SKIP_IMAGE:-0}"
SKIP_UI="${REEF_SKIP_UI:-0}"

# repo root = two levels up from this script (reef/deploy/install.sh → repo root)
SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REEF_DIR="$(cd "$SELF/../.." && pwd)"
REEF_VENV="$REEF_DIR/.venv"
DEPLOY="$REEF_DIR/reef/deploy"

log()  { printf '\033[1;36m[reef]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[reef] WARN:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[reef] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

usage() { awk 'NR==1{next} /^#/{sub(/^# ?/,"");print;next} {exit}' "${BASH_SOURCE[0]}"; }

for arg in "$@"; do
  case "$arg" in
    --skip-image) SKIP_IMAGE=1 ;;
    --skip-ui) SKIP_UI=1 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $arg (try --help)" ;;
  esac
done

[[ $EUID -eq 0 ]] || die "run as root: sudo $0"
[[ "$(uname -s)" == "Linux" ]] || die "this installer targets Linux (Ubuntu/Debian)"
[[ -f "$REEF_DIR/pyproject.toml" && -d "$REEF_DIR/reef" ]] || die "run it from inside the clawbits checkout"
case "$REEF_RUNTIME" in docker|microsandbox) ;; *) die "REEF_RUNTIME must be docker or microsandbox" ;; esac

log "checkout : $REEF_DIR"
log "runtime  : $REEF_RUNTIME"
log "user     : $REEF_USER"
log "env file : $REEF_ENV_FILE"

# ── 1. base packages ──────────────────────────────────────────────────────────
log "installing base packages…"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git curl ca-certificates sqlite3 build-essential unzip >/dev/null

# ── 2. Docker (builds the agent image in place — and is the runtime when chosen) ─
if ! command -v docker >/dev/null; then
  log "installing Docker (agent-image builder)…"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io >/dev/null
fi
systemctl enable --now docker >/dev/null 2>&1 || true

# ── 3. service user ───────────────────────────────────────────────────────────
if ! id "$REEF_USER" &>/dev/null; then
  log "creating service user '$REEF_USER' (home=$REEF_DIR)…"
  useradd --system --home-dir "$REEF_DIR" --shell /bin/bash "$REEF_USER"
fi
# Docker access regardless of runtime: even on microsandbox hosts, Docker is the
# image builder + store, and the image admin endpoints (list/build/activate) shell
# out to it as the service user (reef/image_ops.py).
usermod -aG docker "$REEF_USER"
chown -R "$REEF_USER:$REEF_USER" "$REEF_DIR"

run_as_reef() { sudo -u "$REEF_USER" -H "$@"; }

# ── 3b. microsandbox — the prod agent runtime (external, not in apt) ──────────
# msb state (images, sandboxes, volumes) is per-user, so it must be installed AS
# the service user; it lands in $REEF_DIR/.microsandbox/{bin,lib}.
if [[ "$REEF_RUNTIME" == microsandbox ]]; then
  MSB_LOCAL="$REEF_DIR/.microsandbox/bin/msb"
  if [[ ! -x "$MSB_LOCAL" ]] && ! command -v msb >/dev/null; then
    log "installing microsandbox (as $REEF_USER)…"
    run_as_reef bash -c 'curl -fsSL https://install.microsandbox.dev | sh' \
      || warn "microsandbox install failed — install it manually, then re-run"
  fi
  # Symlink (NOT copy — keeps the binary's rpath to ../lib/libkrunfw intact) onto
  # the system PATH so sudo's secure_path and the systemd service both resolve it.
  [[ -x "$MSB_LOCAL" ]] && ln -sf "$MSB_LOCAL" /usr/local/bin/msb
  command -v msb >/dev/null \
    || warn "'msb' still not resolvable — set REEF_MSB_BIN in $REEF_ENV_FILE"
  # /dev/kvm is root:kvm 0660 — the service user needs the group to boot microVMs.
  getent group kvm >/dev/null && usermod -aG kvm "$REEF_USER"
  [[ -e /dev/kvm ]] \
    || warn "/dev/kvm not present — enable VT-x/SVM in BIOS; microsandbox needs KVM"
fi

# ── 4. uv + Python 3.14 + dependencies ────────────────────────────────────────
if ! command -v uv >/dev/null; then
  log "installing uv…"
  curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh >/dev/null
fi
log "installing Python 3.14 + dependencies (uv sync --frozen) — this can take a few minutes…"
run_as_reef bash -c "cd '$REEF_DIR' && uv python install 3.14 >/dev/null && uv sync --frozen"
[[ -x "$REEF_VENV/bin/python" ]] || die "uv sync did not produce $REEF_VENV/bin/python"

# ── 5. state dirs ─────────────────────────────────────────────────────────────
install -d -m 0750 -o "$REEF_USER" -g "$REEF_USER" "$REEF_STATE_DIR" "$REEF_BACKUP_DIR"
install -d -m 0750 -o "$REEF_USER" -g "$REEF_USER" "$(dirname "$REEF_ENV_FILE")"

# ── 6. config (never clobber an existing env) ─────────────────────────────────
if [[ -f "$REEF_ENV_FILE" ]]; then
  log "keeping existing $REEF_ENV_FILE"
else
  log "writing $REEF_ENV_FILE with a generated REEF_ADMIN_TOKEN + REEF_SUBDOMAIN_SECRET…"
  token="$(openssl rand -hex 32)"
  subdomain_secret="$(openssl rand -hex 32)"
  sed -e "s#^REEF_RUNTIME=.*#REEF_RUNTIME=$REEF_RUNTIME#" \
      -e "s|^# REEF_ADMIN_TOKEN=.*|REEF_ADMIN_TOKEN=$token|" \
      -e "s|^# REEF_SUBDOMAIN_SECRET=.*|REEF_SUBDOMAIN_SECRET=$subdomain_secret|" \
      -e "s#^REEF_STATE_DIR=.*#REEF_STATE_DIR=$REEF_STATE_DIR#" \
      -e "s#^REEF_DB_PATH=.*#REEF_DB_PATH=$REEF_STATE_DIR/reef.db#" \
      -e "s#^REEF_API_PORT=.*#REEF_API_PORT=$REEF_API_PORT#" \
      "$DEPLOY/reef.env.example" > "$REEF_ENV_FILE"
  chmod 0640 "$REEF_ENV_FILE"
  chown "$REEF_USER:$REEF_USER" "$REEF_ENV_FILE"
fi

# ── 7. agent image — built in place with Docker (future: pull from the CI registry) ─
if [[ "$SKIP_IMAGE" != 1 ]]; then
  if docker image inspect reef-oc:plugin >/dev/null 2>&1; then
    log "agent image reef-oc:plugin already built"
  else
    log "building agent image reef-oc:plugin in place…"
    ( cd "$REEF_DIR" && bash reef/images/openclaw-runtime/build.sh ) \
      || warn "image build failed — run: bash reef/images/openclaw-runtime/build.sh"
  fi
  if [[ "$REEF_RUNTIME" == microsandbox ]]; then
    tar="$REEF_STATE_DIR/reef-oc.tar"
    log "loading reef-oc:plugin into microsandbox…"
    # chmod: the tar is written by root but read by the service user (msb state is
    # per-user), and a restrictive root umask (077) would otherwise make it 0600.
    if docker save reef-oc:plugin -o "$tar" && chmod 0644 "$tar" && run_as_reef msb image load -i "$tar"; then
      log "loaded reef-oc:plugin into msb"
      rm -f "$tar"
    else
      warn "couldn't auto-load into msb — the image is built; load it once with:"
      cat >&2 <<EOF
       docker save reef-oc:plugin -o $tar
       sudo -u $REEF_USER msb image load -i $tar      # adjust to your msb syntax — docs/REEF.md §7
EOF
    fi
  fi
fi

# ── 7b. operator dashboard — built in place with bun (loopback-only service) ──
# Rebuilt on every run so a `git pull` + re-run picks up UI changes; --skip-ui
# to leave the current dist alone.
if [[ "$SKIP_UI" != 1 ]]; then
  BUN="$REEF_DIR/.bun/bin/bun"
  if [[ ! -x "$BUN" ]]; then
    log "installing bun (dashboard build tool, as $REEF_USER)…"
    run_as_reef bash -c 'curl -fsSL https://bun.sh/install | bash' >/dev/null \
      || warn "bun install failed — dashboard build skipped (re-run, or build dist on a workstation)"
  fi
  if [[ -x "$BUN" ]]; then
    log "building the operator dashboard (reef/admin-ui)…"
    run_as_reef bash -c "cd '$REEF_DIR/reef/admin-ui' && '$BUN' install --frozen-lockfile >/dev/null && '$BUN' run build" \
      || warn "dashboard build failed — reef-admin-ui stays disabled until a dist exists"
  fi
fi

# ── 8. systemd units (rendered from the templates with real paths) ────────────
render_unit() {  # <src> <dest>
  sed -e "s#^User=.*#User=$REEF_USER#" \
      -e "s#^Group=.*#Group=$REEF_USER#" \
      -e "s#^WorkingDirectory=.*#WorkingDirectory=$REEF_DIR#" \
      -e "s#^EnvironmentFile=.*#EnvironmentFile=$REEF_ENV_FILE#" \
      -e "s#^ExecStart=.*python -m reef.api#ExecStart=$REEF_VENV/bin/python -m reef.api#" \
      -e "s#^ExecStart=.*python -m reef.admin_ui#ExecStart=$REEF_VENV/bin/python -m reef.admin_ui#" \
      -e "s#^ExecStart=.*reef-db-backup.sh#ExecStart=$DEPLOY/reef-db-backup.sh#" \
      -e "s#^Documentation=.*#Documentation=file://$DEPLOY/README.md#" \
      "$1" > "$2"
}
log "installing systemd units…"
render_unit "$DEPLOY/reef-api.service" /etc/systemd/system/reef-api.service
# microsandbox doesn't need the docker.service ordering.
[[ "$REEF_RUNTIME" != docker ]] && sed -i 's#^After=.*#After=network-online.target#' /etc/systemd/system/reef-api.service
render_unit "$DEPLOY/reef-db-backup.service" /etc/systemd/system/reef-db-backup.service
install -m 0644 "$DEPLOY/reef-db-backup.timer" /etc/systemd/system/reef-db-backup.timer
chmod +x "$DEPLOY/reef-db-backup.sh"
# The local-only operator dashboard (loopback, never on the tunnel). Rendered
# always; started only when a prebuilt SPA is present (the box has no node/bun).
render_unit "$DEPLOY/reef-admin-ui.service" /etc/systemd/system/reef-admin-ui.service
systemctl daemon-reload
systemctl enable --now reef-api
systemctl enable --now reef-db-backup.timer

ADMIN_UI_DIST="$REEF_DIR/reef/admin-ui/dist"
if [[ -f "$ADMIN_UI_DIST/index.html" ]]; then
  systemctl enable --now reef-admin-ui
  log "operator dashboard up (reef-admin-ui, loopback). Reach via SSH forward."
else
  systemctl disable reef-admin-ui >/dev/null 2>&1 || true
  warn "operator dashboard NOT started — no SPA at $ADMIN_UI_DIST (build failed or --skip-ui?)."
  warn "  re-run this installer, or build dist elsewhere and copy it in, then:"
  warn "  sudo systemctl enable --now reef-admin-ui"
fi

# ── 9. verify ─────────────────────────────────────────────────────────────────
port="$(sed -n 's/^REEF_API_PORT=//p' "$REEF_ENV_FILE" | head -1)"; port="${port:-$REEF_API_PORT}"
log "waiting for the API on 127.0.0.1:${port}…"
for _ in $(seq 1 40); do curl -sf "127.0.0.1:${port}/healthz" >/dev/null 2>&1 && break; sleep 0.5; done
if curl -sf "127.0.0.1:${port}/healthz" >/dev/null 2>&1; then
  log "reef-api is up. /healthz:"
  curl -s "127.0.0.1:${port}/healthz" | python3 -m json.tool || true
else
  warn "API not responding yet — check: journalctl -u reef-api -n 50 --no-pager"
fi

cat <<EOF

[reef] Done. Next:
  • Status   : systemctl status reef-api   ·   journalctl -u reef-api -f
  • Config   : $REEF_ENV_FILE  (review auth/exposure, then: systemctl restart reef-api)
  • Token    : sudo sed -n 's/^REEF_ADMIN_TOKEN=//p' $REEF_ENV_FILE
  • Reach it : private on 127.0.0.1:${port} — tunnel: ssh -L ${port}:127.0.0.1:${port} <you>@<host>
  • Dashboard: local-only operator UI (reef-admin-ui, loopback — never on the tunnel).
               Reach it:  ssh -L 8788:127.0.0.1:8788 <you>@<host>  →  http://localhost:8788
  • Backups  : reef-db-backup.timer enabled (daily → $REEF_BACKUP_DIR)
EOF
