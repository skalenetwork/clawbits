# Reef

Isolated microVM hosting for agents — one microVM per agent, **agent-agnostic**.
A standalone sub-project: **clawbits depends on Reef, never the reverse** (no
`clawbits.*` imports live here).

Design & decisions: [`../docs/REEF.md`](../docs/REEF.md).
Setup guide (dev + prod, full env-var reference, commands): [`SETUP.md`](SETUP.md).

## Layout

| File | What |
|---|---|
| `runtime.py` | `AgentRuntime` (lifecycle seam) + `FleetRuntime` (read seam) + `AdminRuntime`; `SandboxSpec`, `SandboxState`, `Limits`, `SandboxInfo`, `MetricsSample` |
| `profiles.py` | `AgentProfile` (the agent-type seam) + `OpenClawProfile` / `IronClawProfile` / `HermesProfile`; `AccessInfo` |
| `agents.py` | `AGENT_TYPES` registry (openclaw ✅ · ironclaw ✅ · hermes ✅) + `infer_type` |
| `manager.py` | `SandboxManager` — idempotent lifecycle facade (`ensure_running` / `expose` / `stop` / `destroy`) |
| `fleet.py` | `FleetService` — fleet view (merge live runtime + store), secret redaction, create, lifecycle by name (handles drift) |
| `reconciler.py` | `Reconciler` — self-healing control loop: drives each managed sandbox toward `desired_state` per its `restart_policy`, with crash-loop backoff; runs in the API lifespan |
| `microsandbox_runtime.py` | real prod runtime — drives `msb` via subprocess (validated) |
| `docker_runtime.py` | dev runtime — drives `docker`/OrbStack (msb's host↔guest relay is flaky on macOS) |
| `runtime_factory.py` | `make_runtime` / `make_exposure` — pick backend + exposure by platform/env |
| `exposure.py` | `ExposureStrategy` + `DirectPortExposure` (dev) + `SubdomainProxyExposure` (prod nginx) |
| `ports.py` | `PortAllocator` — host-port range for web-UI forwards |
| `status.py` | host-side reader for the agent-volunteered `status.json` (no guest execution) |
| `store.py` | `SandboxStore` + `InMemorySandboxStore` |
| `models.py` | `Sandbox` — Reef's own state record |
| `fake_runtime.py` | in-memory runtime for tests/dev |
| `api/` | the admin/fleet HTTP API (FastAPI) — Reef's own entrypoint |
| `admin-ui/` | the operator dashboard (Vite + React) — see [`admin-ui/README.md`](admin-ui/README.md) |
| `images/openclaw-runtime/` | the OpenClaw agent image (Dockerfile + entrypoint) |
| `images/hermes-runtime/` | the Hermes agent image wrapper (upstream Hermes + baked Clawbits extension) |
| `deploy/` | production setup — one-shot [`install.sh`](deploy/README.md) (Ubuntu), systemd unit (`Restart=always` + boot-start), env template, DB-backup timer |

## Test

```bash
uv run pytest reef/tests -q
```

Pure in-memory — no DB, network, or hypervisor required.

## Runtime selection

One seam (`AdminRuntime`), two backends. `reef.runtime_factory.make_runtime()`
picks **docker on macOS** (dev — OrbStack), **microsandbox elsewhere** (prod —
Linux/KVM). Override with `REEF_RUNTIME=docker|microsandbox`. Both drive a CLI via
subprocess and expose the same lifecycle + fleet surface, so nothing downstream
changes. (Dev Docker has no per-container egress allowlist — a single-tenant
local-dev trade-off; prod microVMs do.)

Build agent images:

```bash
reef/images/openclaw-runtime/build.sh
# Hermes wrapper: first build/pull a `hermes-agent` base image, then:
reef/images/hermes-runtime/build.sh
# For msb hosts, load the built image into microsandbox's image store.
```

## Admin / fleet API

Reef's own entrypoint — an operator view + lifecycle control over the agent
microVMs, wrapping the runtime's `list/metrics/inspect/logs` and a create+expose
path. Standalone (depends only on `reef.*` + FastAPI, never clawbits).

```bash
uv run python -m reef.api            # or: uv run uvicorn reef.api.app:app  → 127.0.0.1:8787
```

| Endpoint | What |
|---|---|
| `GET /fleet` | all sandboxes (live runtime + Reef metadata; `?state=running`) |
| `POST /fleet` | create + expose a new agent VM (`{type: "openclaw"|"ironclaw"|"hermes", name?, cpus?, memory_mib?, org_id?, clawbits_url?, signup_token?, …}`) → `{sandbox_id, access:{url,password?}}` |
| `GET /fleet/{id}` | detail — limits, network policy, mounts, **env with secrets redacted**, `access`, status telemetry |
| `GET /fleet/{id}/logs?tail=N` | captured output |
| `POST /fleet/{id}/start`·`/stop`, `DELETE /fleet/{id}` | lifecycle control |
| `GET /healthz` | liveness + runtime reachability (unauthenticated) |
| `GET /versions/latest` | latest available versions per runtime (`openclaw` · `ironclaw` · `hermes`) for the dashboard's "update available" hints (optional, best-effort, cached; IronClaw + Hermes floors are null — engines self-built / base-image, components in-tree) |

Auth (`reef/api/security.py`): **Cloudflare Access** JWT for human operators
(`REEF_ACCESS_TEAM_DOMAIN` + `REEF_ACCESS_AUD`) and/or a **bearer service token**
(`REEF_ADMIN_TOKEN`) for the clawbits→Reef machine path. Open only when neither is
set (local dev).

Config (all `REEF_*`, optional): `REEF_RUNTIME`, `REEF_MSB_BIN`, `REEF_DOCKER_BIN`,
`REEF_OPENCLAW_IMAGE` (default `reef-oc:plugin`), `REEF_HERMES_IMAGE` (default
`reef-hm:plugin`), `REEF_API_HOST`/`REEF_API_PORT` (default `127.0.0.1:8787`),
`REEF_CORS_ORIGINS` (default the Vite dev server), `REEF_BASE_DOMAIN` +
`REEF_NGINX_DIR` / `REEF_TLS_*` / `REEF_SUBDOMAIN_SECRET` (prod web-UI exposure —
see [`../nginx/reef-base.conf.example`](../nginx/reef-base.conf.example)).

**Latest-version checks** (`GET /versions/latest`, optional + best-effort): `REEF_VERSION_CHECK`
(`0` disables all outbound checks — default on), `REEF_CLAWBITS_URL` (opt-in clawbits base URL
for the plugin-version floor; unset → plugin latest is skipped, keeping Reef decoupled),
`REEF_VERSION_CHECK_TTL` (cache seconds, default `10800`). OpenClaw latest comes from npm, the
reef image from the local `VERSION` file (swap for a registry tag once the image is published).

## Operator UI

`reef/admin-ui/` — a standalone Vite/React dashboard over the API above. See its
[README](admin-ui/README.md). Separate from the customer app, per docs/REEF.md §10.
