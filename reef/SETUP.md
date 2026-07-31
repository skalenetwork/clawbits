# Reef setup - dev and prod

How to stand up Reef (the agent-microVM fleet manager) in both environments:

- **Dev** - macOS or any box with Docker. The API runs in your shell, agents run
  as Docker containers, auth is optional.
- **Prod** - a Linux host with KVM. Agents run as true microVMs under
  [microsandbox](https://microsandbox.dev) (`msb`), the API runs under systemd,
  auth is mandatory.

Related docs: [`README.md`](README.md) (architecture + module layout),
[`deploy/README.md`](deploy/README.md) (what the prod installer does, manual
install, ops notes), [`../docs/REEF.md`](../docs/REEF.md) (design decisions),
[`admin-ui/README.md`](admin-ui/README.md) (the operator dashboard).

## TL;DR

```bash
# Dev (from the repo root)
uv sync
reef/images/openclaw-runtime/build.sh        # agent image -> reef-oc:plugin
uv run python -m reef.api                    # API on 127.0.0.1:8787 (Docker runtime on macOS)
cd reef/admin-ui && bun install && bun run dev -- --port 5174   # operator UI

# Prod (Ubuntu/Debian checkout on the server)
sudo reef/deploy/install.sh                  # installs everything, starts systemd units
sudoedit /etc/reef/reef.env                  # review auth / exposure / AI keys
sudo systemctl restart reef-api
```

---

## Development setup

### Prerequisites

- [`uv`](https://docs.astral.sh/uv/) (Python deps; the repo pins Python 3.14)
- **Docker** (OrbStack on macOS) - the dev runtime *and* the agent-image builder.
  microsandbox's host-guest relay is flaky on macOS, so `make_runtime()` defaults
  to Docker there; no KVM needed.
- **bun** (or npm) + Node for `admin-ui`
- [`dotenvx`](https://dotenvx.com) - optional; this repo's dev services load
  `.env.development` (repo root, values encrypted) through it.

### 1. Install dependencies

```bash
uv sync          # from the repo root; reef has no extra deps beyond the workspace
```

### 2. Build the agent image

Agents boot from a local OCI image (default tag `reef-oc:plugin`):

```bash
reef/images/openclaw-runtime/build.sh     # REEF_NO_CACHE=1 re-resolves the pinned plugin
```

Re-run after changing the image's Dockerfile / entrypoint, or to pick up a new
OpenClaw release. Point Reef at a different tag with `REEF_OPENCLAW_IMAGE`.

### 3. Run the API

```bash
uv run python -m reef.api                 # http://127.0.0.1:8787
```

Dev defaults when nothing is set: Docker runtime (on macOS), SQLite store at
`~/.reef/reef.db`, **no auth** (open API - fine on loopback only), CORS already
allows the clawbits web/desktop dev origins. Useful dev extras:

```bash
REEF_API_RELOAD=1 uv run python -m reef.api      # uvicorn auto-reload
REEF_RUNTIME=microsandbox uv run python -m reef.api   # force msb (Linux dev box)
```

**This repo's wired dev flow:** `.claude/launch.json` defines a `reef-backend`
config that runs the API through dotenvx:

```bash
dotenvx run -f .env.development -- uv run python -m reef.api
```

`.env.development` (repo root) carries the dev `REEF_ADMIN_TOKEN` and any
AI provider keys, encrypted. Add or change values with:

```bash
dotenvx set REEF_ANTHROPIC_API_KEY "sk-ant-..." -f .env.development
dotenvx run -q -f .env.development -- printenv REEF_ADMIN_TOKEN   # read one back
```

### 4. Run the operator UI

```bash
cd reef/admin-ui
bun install
bun run dev -- --port 5174     # 5173 is taken by the clawbits frontend in this repo
```

The Vite dev server proxies `/api/*` to `http://127.0.0.1:8787` (override with
`VITE_REEF_API_TARGET`). When the API has `REEF_ADMIN_TOKEN` set, the UI prompts
for it once per tab (sessionStorage); `VITE_REEF_ADMIN_TOKEN` can seed it for
kiosk-style setups.

### 5. Smoke-test

```bash
curl -s 127.0.0.1:8787/healthz | python3 -m json.tool        # liveness (no auth)

# With auth (export REEF_TOKEN first; skip -H if running open):
export REEF_TOKEN=<your REEF_ADMIN_TOKEN>
curl -s -H "Authorization: Bearer $REEF_TOKEN" 127.0.0.1:8787/providers

# Create, inspect, destroy a detached agent VM:
curl -s -X POST -H "Authorization: Bearer $REEF_TOKEN" -H "Content-Type: application/json" \
  -d '{"type":"openclaw","name":"smoke"}' 127.0.0.1:8787/fleet
curl -s -H "Authorization: Bearer $REEF_TOKEN" "127.0.0.1:8787/fleet/smoke/logs?tail=50"
curl -s -X DELETE -H "Authorization: Bearer $REEF_TOKEN" 127.0.0.1:8787/fleet/smoke
```

### 6. Connect a local clawbits (optional)

1. Run the clawbits backend (`:8000`) + frontend (`:5173`).
2. In clawbits: **Settings -> Reef** - URL `http://127.0.0.1:8787`, plus the
   admin token. The browser talks to Reef directly; clawbits' backend never does.
3. When creating agents that must call back into your local clawbits, the
   `clawbits_url` must be reachable **from inside the VM** - use the preset
   `http://host.docker.internal:8000` (Docker) or
   `http://host.microsandbox.internal:8000` (msb), never `localhost`.

### Tests + lint

```bash
uv run pytest reef/tests -q     # pure in-memory: no DB, network, or hypervisor
uv run ruff check reef
cd reef/admin-ui && bun run typecheck
```

### Dev gotchas

- **msb on macOS**: `msb exec`/`logs` are flaky; stick with the Docker default.
- **Desktop app shows Reef "Offline"**: a CORS miss. The default allowlist covers
  `tauri://localhost`, `http://tauri.localhost`, and the Tauri dev port `:5176`;
  if you override `REEF_CORS_ORIGINS`, you replace (not extend) that list - keep
  those entries.
- **Changing `.env.development`** requires restarting the `reef-backend` process
  (env is read at startup by dotenvx, and provider keys are read per request from
  the process env).

---

## Production setup

### Prerequisites

- Ubuntu/Debian host with **KVM** (`/dev/kvm`) for the microsandbox runtime
  (skippable only with `REEF_RUNTIME=docker` - no microVM isolation).
- A checkout of this repo on the server (deploy key or HTTPS token - it's private).
- A tunnel for reachability (e.g. `cloudflared`); Reef itself binds loopback.

(microsandbox itself is installed by the installer - as the service user, into
`<checkout>/.microsandbox/bin`, symlinked to `/usr/local/bin/msb`.)

### Quick install

```bash
cd /opt/reef            # your checkout (any path works; units default to /opt/reef)
sudo reef/deploy/install.sh             # add --skip-image to skip the image build
```

Idempotent. It installs Docker (image builder) + uv + Python and deps, creates
the `reef` service user (in the `kvm` group) and installs microsandbox as it,
writes `/etc/reef/reef.env` (0640) with a generated `REEF_ADMIN_TOKEN`, builds
`reef-oc:plugin` and loads it into msb, builds the operator-dashboard SPA, and
installs + starts the systemd units (`reef-api.service` with `Restart=always`
and boot-start, `reef-admin-ui.service` on loopback, plus the daily
`reef-db-backup.timer`), and prints `/healthz`. Overrides: `REEF_USER`,
`REEF_API_PORT`, `REEF_STATE_DIR`, `REEF_RUNTIME=docker`, `--skip-image`,
`--skip-ui`. Details and the manual (non-Ubuntu) procedure:
[`deploy/README.md`](deploy/README.md).

### Configure `/etc/reef/reef.env`

Review after install; restart to apply (`sudo systemctl restart reef-api`).
The minimum for any reachable deployment:

```bash
REEF_ADMIN_TOKEN=<generated>        # and/or REEF_ACCESS_* for operator SSO
REEF_SUBDOMAIN_SECRET=<generated>   # seeds the unguessable /s/{digest}/ surface paths
```

Recommended extras:

```bash
# Shared AI provider keys, injected into agent VMs at create time. Clients see
# only WHICH providers are configured (GET /providers) - never the values.
# Prefer scoped / spend-limited keys; rotation applies to NEW agents only
# (a VM's env is fixed at create - recreate an agent to move it).
REEF_ANTHROPIC_API_KEY=sk-ant-...
REEF_OPENAI_API_KEY=sk-...
REEF_GEMINI_API_KEY=AIza...
REEF_NEARAI_API_KEY=...

REEF_PUBLIC_URL=https://reef.yourhost.com   # echoed in the startup connect banner
```

### Reachability + connect to clawbits

Point a tunnel at the API, e.g.:

```bash
cloudflared tunnel --url http://127.0.0.1:8787    # prints a https://... URL
```

In clawbits: **Settings -> Reef** - paste that URL + the `REEF_ADMIN_TOKEN`
(get it with `sudo grep REEF_ADMIN_TOKEN /etc/reef/reef.env`). The startup log
prints the same "connect to clawbits" banner with both values' sources.

Agent Control-UI / web-terminal exposure comes in two flavors:

- **Surface proxy (default)** - each agent's UI rides the API's own hostname at
  `/s/{digest}/`; needs only `REEF_SUBDOMAIN_SECRET`.
- **Subdomain proxy (nginx)** - one wildcard subdomain per agent surface; set
  `REEF_BASE_DOMAIN`, `REEF_NGINX_DIR`, `REEF_TLS_CERT`/`REEF_TLS_KEY`, and do the
  one-time nginx/DNS setup in
  [`../nginx/reef-base.conf.example`](../nginx/reef-base.conf.example).

### Verify

```bash
systemctl status reef-api
journalctl -u reef-api -f                       # reconciler heals log at INFO
curl -s 127.0.0.1:8787/healthz | python3 -m json.tool   # status, msb_available, reconciler.healthy
```

Alert on `reconciler.healthy: false` (the self-healing loop stopped passing).

### Upgrades, backups, reboots

```bash
cd /opt/reef && sudo git pull && sudo -u reef uv sync
sudo systemctl restart reef-api      # SQLite schema migrates in place; agents reconcile back
```

- The daily timer snapshots `REEF_DB_PATH` to `REEF_BACKUP_DIR` (keeps
  `REEF_BACKUP_KEEP`); for point-in-time use [litestream](https://litestream.io).
- Host reboots recover automatically: systemd starts the API, the reconciler
  restores every `desired_state=running` agent from the durable store.
- Run the reconciler on **exactly one** node (`REEF_RECONCILE=0` on any extra
  API process against the same fleet).

---

## Environment variable reference

Everything is optional to *boot* - with no env at all, Reef runs open on
loopback with platform defaults. "Required (prod)" below means required for any
deployment reachable beyond localhost. All are read from the process env
(systemd `EnvironmentFile=/etc/reef/reef.env` in prod, your shell / dotenvx in dev).

### Runtime + image

| Variable | Default | What |
|---|---|---|
| `REEF_RUNTIME` | `docker` on macOS, `microsandbox` on Linux | Which VMM/CLI Reef drives: `docker` \| `microsandbox` |
| `REEF_MSB_BIN` | `msb` from `PATH` (or `~/.microsandbox`) | Pin the msb binary |
| `REEF_DOCKER_BIN` | `docker` from `PATH` | Pin the docker binary |
| `REEF_OPENCLAW_IMAGE` | `reef-oc:plugin` | OCI image for the OpenClaw agent type |
| `REEF_MSB_VOLUMES_DIR` | `~/.microsandbox/volumes` | msb named-volume root (Reef reads per-agent status here host-side) |
| `REEF_MSB_SANDBOXES_DIR` | sibling `sandboxes/` of the volumes dir | msb sandboxes dir |

### Durable state

| Variable | Default | What |
|---|---|---|
| `REEF_STATE_DIR` | `~/.reef` (prod unit: `/var/lib/reef`) | Durable state root |
| `REEF_DB_PATH` | `$REEF_STATE_DIR/reef.db` | SQLite desired-state DB - **back it up** |
| `REEF_STORE` | `sqlite` | `sqlite` (durable) \| `memory` (ephemeral, tests/dev) |

### API + auth

| Variable | Default | What |
|---|---|---|
| `REEF_API_HOST` / `REEF_API_PORT` | `127.0.0.1` / `8787` | Bind address (keep private; front with a tunnel) |
| `REEF_ADMIN_TOKEN` | unset | **Required (prod)** unless Access is set. Bearer token for every `/fleet` + `/providers` call (clawbits browser sessions + the dashboard). Unset + no Access = open API (dev only) |
| `REEF_ACCESS_TEAM_DOMAIN` / `REEF_ACCESS_AUD` | unset | Cloudflare Access operator SSO (verifies `Cf-Access-Jwt-Assertion`) |
| `REEF_CORS_ORIGINS` | clawbits.ai + web dev `:5173` + Tauri (`tauri://localhost`, `http://tauri.localhost`, dev `:5176`) | Comma-separated browser origins. Overriding **replaces** the whole default list |
| `REEF_PUBLIC_URL` | unset | This API's public (tunnel) URL - informational, echoed in the startup banner |
| `REEF_LOG_LEVEL` | `INFO` | `reef.*` log level (reconciler heals log at INFO) |
| `REEF_API_RELOAD` | unset | Any value enables uvicorn auto-reload (dev only) |

### AI provider keys (shared, maintainer-level)

| Variable | Default | What |
|---|---|---|
| `REEF_ANTHROPIC_API_KEY` | unset | Forwarded into agent VMs as `ANTHROPIC_API_KEY` at create time |
| `REEF_OPENAI_API_KEY` | unset | Forwarded into agent VMs as `OPENAI_API_KEY` at create time |
| `REEF_GEMINI_API_KEY` | unset | Forwarded into agent VMs as `GEMINI_API_KEY` at create time |
| `REEF_NEARAI_API_KEY` | unset | Forwarded into agent VMs as `NEARAI_API_KEY` at create time (NEAR Cloud AI, cloud-api.near.ai) |

Semantics (see [`providers.py`](providers.py) and docs/REEF.md §14): the create
request's `provider` field picks which configured key to forward (`"none"` skips;
omitted = all configured); a per-request key always wins. `GET /providers`
(admin-gated) reports presence booleans only - values never leave the host, are
never persisted, and are masked in fleet detail views and subprocess errors.

### Agent surface exposure

| Variable | Default | What |
|---|---|---|
| `REEF_SUBDOMAIN_SECRET` | unset | **Required (prod)**: HMAC seed for the unguessable `/s/{digest}/` surface-proxy paths and nginx subdomain digests. Unset = empty seed (guessable paths) |
| `REEF_BASE_DOMAIN` | unset | Wildcard domain for the nginx subdomain proxy (e.g. `reef.yourhost.com`); unset = surface proxy only |
| `REEF_NGINX_DIR` | `/etc/nginx/reef.d` | Where per-agent nginx confs are written (service user needs write + nginx reload) |
| `REEF_TLS_CERT` / `REEF_TLS_KEY` | unset | Wildcard cert pair for the subdomain proxy |

### Self-healing reconciler

| Variable | Default | What |
|---|---|---|
| `REEF_RECONCILE` | `1` | Enable the in-process control loop (`0` on any extra API node) |
| `REEF_RECONCILE_INTERVAL` | `15` | Seconds between passes |
| `REEF_RESTART_BACKOFF_BASE` / `REEF_RESTART_BACKOFF_CAP` | `10` / `300` | Crash-loop backoff: first delay, doubling, capped |
| `REEF_RESTART_STABLE_RESET` | `300` | Seconds running before the restart counter resets |

### Version checks (`GET /versions/latest`)

| Variable | Default | What |
|---|---|---|
| `REEF_VERSION_CHECK` | `1` | `0` disables all outbound "latest version" lookups |
| `REEF_VERSION_CHECK_TTL` | `10800` | Cache seconds |
| `REEF_CLAWBITS_URL` | unset | Opt-in clawbits base URL for the plugin-version floor (unset = skipped) |

### DB backup (used by `deploy/reef-db-backup.sh`)

| Variable | Default | What |
|---|---|---|
| `REEF_BACKUP_DIR` | `/var/backups/reef` | Snapshot destination |
| `REEF_BACKUP_KEEP` | `14` | Snapshots retained |

---

## Command reference

```bash
# Run
uv run python -m reef.api                          # the API (and reconciler)
dotenvx run -f .env.development -- uv run python -m reef.api   # this repo's dev flow

# Test / lint
uv run pytest reef/tests -q
uv run ruff check reef

# Agent image
reef/images/openclaw-runtime/build.sh              # build reef-oc:plugin (+ versioned tag)
docker save reef-oc:plugin | msb image load -i -   # hand-load into msb (prod; installer does this)

# API (export REEF_TOKEN first; drop the header if running open)
curl -s 127.0.0.1:8787/healthz                                        # liveness (no auth)
curl -s -H "Authorization: Bearer $REEF_TOKEN" 127.0.0.1:8787/providers   # AI provider availability
curl -s -H "Authorization: Bearer $REEF_TOKEN" 127.0.0.1:8787/fleet       # fleet list
curl -s -X POST -H "Authorization: Bearer $REEF_TOKEN" -H "Content-Type: application/json" \
  -d '{"type":"openclaw","name":"a1","provider":"anthropic"}' 127.0.0.1:8787/fleet
curl -s -H "Authorization: Bearer $REEF_TOKEN" "127.0.0.1:8787/fleet/a1/logs?tail=100"
curl -s -X POST   -H "Authorization: Bearer $REEF_TOKEN" 127.0.0.1:8787/fleet/a1/restart
curl -s -X DELETE -H "Authorization: Bearer $REEF_TOKEN" 127.0.0.1:8787/fleet/a1

# Prod ops
sudo systemctl {status,restart} reef-api
journalctl -u reef-api -f
sudo systemctl list-timers reef-db-backup.timer
```

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `401` on `/fleet` or `/providers` | Missing/wrong bearer token; check `REEF_ADMIN_TOKEN` in the env file vs what you pasted |
| `GET /providers` returns `404` | The running API predates the endpoint - restart it on current code |
| Provider shows `configured: false` despite the key being set | Key must be in the **API process's** env (`/etc/reef/reef.env` + restart, or `.env.development` via dotenvx); blank values count as unset |
| `422: provider 'x' has no key on this reef` | That provider isn't configured server-side and no key was passed - set `REEF_*_API_KEY` or paste a key in the dialog |
| Desktop app shows Reef "Offline" while the browser works | CORS: a custom `REEF_CORS_ORIGINS` replaced the defaults - re-add `tauri://localhost`, `http://tauri.localhost`, `http://localhost:5176` |
| `POST /fleet` hangs / msb weirdness on macOS | Use the Docker runtime (the macOS default) - msb's host relay is flaky there |
| Create fails with image not found | Build it: `reef/images/openclaw-runtime/build.sh` (and `msb image load` for msb); or fix `REEF_OPENCLAW_IMAGE` |
| Agent up but never enrolls in clawbits | `clawbits_url` not reachable from inside the VM - use the `host.docker.internal` / `host.microsandbox.internal` preset, and mind the signup token's single use |
| Rotated an AI key but agents still use the old one | Expected: VM env is fixed at create - recreate the agent |
