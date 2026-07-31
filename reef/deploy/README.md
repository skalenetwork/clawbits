# Running Reef in production

Reef is a host-level fleet manager: it shells out to the container runtime
(`msb`/`docker`), owns a durable SQLite store, and runs the **self-healing
reconciler** in-process. The reconciler keeps *agents* alive; this setup keeps
*Reef* alive — so the two together survive crashes and host reboots.

What you get:

- **`reef-api.service`** — runs `python -m reef.api` under systemd with
  `Restart=always` (crash recovery) and boot-start after the runtime, so on a host
  reboot the API comes up and the reconciler restores every agent to its desired
  state from the store.
- **`reef.env.example`** — the `REEF_*` config surface.
- **`reef-db-backup.{sh,service,timer}`** — a daily snapshot of the desired-state DB.

This is single-host. Multi-host (Postgres store + scheduler) is the later step;
see [`../../docs/REEF.md`](../../docs/REEF.md).

## Install (Ubuntu/Debian — the script)

[`install.sh`](install.sh) does everything below, idempotently. Clone the repo to
the server first (it's private — set up a GitHub deploy key, or clone over HTTPS
with a token), then:

```bash
cd /opt/reef/clawbits           # your checkout
sudo reef/deploy/install.sh     # microsandbox runtime (prod default); --skip-image to skip the image step
```

It installs Docker (the image builder) + uv + Python 3.14 + deps, creates the
`reef` service user (adding it to the `kvm` group), installs **microsandbox**
as that user (per-user state at `<checkout>/.microsandbox`, `msb` symlinked to
`/usr/local/bin`), writes `/etc/reef/reef.env` with a generated
`REEF_ADMIN_TOKEN`, `REEF_SUBDOMAIN_SECRET`, and `REEF_RUNTIME`, builds the
`reef-oc:plugin` agent image in place, builds the operator-dashboard SPA
(bun, in place), renders + starts the systemd units (API + reconciler +
dashboard + daily backup), and prints `/healthz`. Then review
`/etc/reef/reef.env` (auth, exposure) and `sudo systemctl restart reef-api` if
you changed anything.

**Runtime** (the agent image is built in place with Docker either way; later, CI
will publish it to a registry and you'll use `--skip-image` + a pull instead):

- **microsandbox** (default, prod) — true microVM isolation; needs KVM
  (`/dev/kvm`). The installer installs msb itself, builds the image with Docker
  and loads it into msb, printing the exact `msb image load` to run if it can't
  auto-load (docs/REEF.md §7).
- **docker** (dev / no-KVM box) — `sudo REEF_RUNTIME=docker reef/deploy/install.sh`;
  Docker is also the runtime, fully hands-off.

**Overrides:** `REEF_USER`, `REEF_API_PORT`, `REEF_STATE_DIR`, `REEF_SKIP_IMAGE=1`,
`REEF_SKIP_UI=1` (see `install.sh --help`).

The rest of this doc is what the installer does under the hood — useful for
non-Ubuntu hosts, customization, or a hand install.

## Prerequisites

- Linux host with the runtime Reef will drive: **microsandbox** (`msb`, prod) or
  Docker (dev-style). The service user needs access to it (the `docker` group for
  the Docker socket, or `msb` on `PATH`).
- `python` + [`uv`](https://docs.astral.sh/uv/) for the venv, and `sqlite3` (for backups).
- If you expose agent Control UIs: nginx + the one-time wildcard-cert/DNS setup
  from [`../../nginx/reef-base.conf.example`](../../nginx/reef-base.conf.example).

## Manual install (what the script does)

```bash
# 1. Service user + dirs (StateDirectory= also creates /var/lib/reef on first start)
sudo useradd --system --home /opt/reef --shell /bin/bash reef
sudo usermod -aG kvm reef               # microsandbox: /dev/kvm is root:kvm 0660
sudo usermod -aG docker reef            # docker is the image builder/store on BOTH runtimes

# 1b. microsandbox (prod runtime) — install AS the service user (state is per-user),
#     then symlink (not copy — keeps the rpath to ../lib/libkrunfw) onto the PATH:
sudo -u reef -H bash -c 'curl -fsSL https://install.microsandbox.dev | sh'
sudo ln -sf /opt/reef/.microsandbox/bin/msb /usr/local/bin/msb

# 2. Code + venv at /opt/reef (a checkout of this repo: the dir with `reef/`)
sudo git clone <repo> /opt/reef && cd /opt/reef
sudo -u reef uv sync                    # creates /opt/reef/.venv

# 3. Config
sudo install -d -m 0750 -o reef -g reef /etc/reef
sudo install -m 0640 -o reef -g reef reef/deploy/reef.env.example /etc/reef/reef.env
sudoedit /etc/reef/reef.env             # set auth + REEF_RUNTIME + paths

# 4. Units (edit paths/User in the unit files first if you didn't use /opt/reef)
sudo install -m 0644 reef/deploy/reef-api.service /etc/systemd/system/
sudo install -m 0644 reef/deploy/reef-db-backup.service /etc/systemd/system/
sudo install -m 0644 reef/deploy/reef-db-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload

# 5. Start (enable = also start on boot)
sudo systemctl enable --now reef-api
sudo systemctl enable --now reef-db-backup.timer
```

## Verify

```bash
systemctl status reef-api
journalctl -u reef-api -f                       # watch reconciler heals (INFO)

# Liveness + reconciler health (note the `reconciler` block):
curl -s 127.0.0.1:8787/healthz | python3 -m json.tool
# {
#   "status": "ok", "msb_available": true, "sandboxes": N,
#   "reconciler": { "enabled": true, "interval_secs": 15, "passes": …,
#                   "restarts": …, "last_pass_at": "…", "healthy": true }
# }
```

`reconciler.healthy` goes **false** if the loop hasn't completed a pass in too long
(wedged or dead) — alert on it (e.g. a Cloudflare/Datadog check on `/healthz`, or a
systemd watchdog). The loop also self-restarts in-process if it ever crashes, and
systemd restarts the whole API if the process dies.

## Operational notes

- **Run the reconciler on exactly one node.** `REEF_RECONCILE=1` here; set `=0` on
  any additional API process pointed at the same fleet — two reconcilers would
  fight (double restarts). Single-host today, so this is just future-proofing.
- **Host-reboot recovery** is automatic: the store is durable, so after boot the
  reconciler reconciles every `desired_state=running` agent back up. It can restart
  a *stopped* container but cannot recreate a *removed* one (the access secret lives
  only in the guest env, never persisted) — those surface as `failed`.
- **Back up `REEF_DB_PATH`.** It's the source of truth for every agent's intent and
  restart policy. The daily timer keeps `REEF_BACKUP_KEEP` snapshots; for
  continuous point-in-time backups use [litestream](https://litestream.io) against
  the same file instead.
- **Auth:** set `REEF_ADMIN_TOKEN` (machine path) and/or `REEF_ACCESS_*` (operator
  SSO). With neither set the API is open — fine only if it's truly unreachable.
- **Exposure:** for the subdomain proxy, the service user needs write access to
  `REEF_NGINX_DIR` and permission to reload nginx (a scoped sudoers rule, or run
  the reload via a helper) — relax the unit's hardening accordingly.

## Upgrades

```bash
cd /opt/reef && sudo git pull && sudo -u reef uv sync
sudo systemctl restart reef-api          # store survives; agents reconcile back as managed
```

A SQLite schema bump migrates in place on start (`PRAGMA user_version`); the daily
backup is your rollback point.
