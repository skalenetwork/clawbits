# Reef — isolated microVM hosting for agents

Reef spins up many AI agents on demand, each in its own microVM. It's **agent-agnostic** (OpenClaw and Hermes today) and a **standalone sub-project** that clawbits integrates for auth, UI, and identity.

Source of truth for "how is an agent sandboxed / where does it run / how do we reach it / how does it plug into clawbits / what's built so far."

**Status:** Accepted, in active build · **Date:** 2026-06-04 · **Deciders:** Dmytro / clawbits core

> **Current state (jump to §8):** the `reef/` package is built end-to-end — **two runtimes** (`DockerRuntime` for dev on the Mac, `MicrosandboxRuntime` for prod on Linux, picked by `runtime_factory`), the `SandboxManager` lifecycle, the **exposure layer** (`DirectPortExposure` + `SubdomainProxyExposure`), the **admin/fleet API** (FastAPI, with Cloudflare-Access + bearer auth), and a standalone **operator UI** (Vite/React). The OpenClaw image boots green with the channel-wiring entrypoint, host-side **status telemetry**, and **two auto-authenticating web surfaces** (Control UI + a scoped `openclaw` terminal). Hermes is enabled via a Reef wrapper image that bakes in the Clawbits Hermes extension and exposes the Hermes dashboard for config. **Reef tests green.** Remaining: the **clawbits adapter (#6)**, full **configuration access (§13)**, **end-to-end (#7)**, and prod hardening (non-root volume perms on real `msb`, `SubdomainProxyExposure` on a real host, a SQL store, bare-metal EPYC). See **§8**, **§9**, and **§13**.

---

## 1. What Reef is

Reef hosts **agents** — runtimes that execute arbitrary, LLM-generated code — each isolated in its own microVM (agents run untrusted code, so a shared kernel isn't enough).

- **Agent-agnostic.** Reef knows nothing about "OpenClaw" or "Hermes." An **`AgentProfile`** (image + env mapping + exposure) describes each agent *type*. An **`AGENT_TYPES`** registry (`reef/agents.py`) is the catalog the create path and the UI read.
- **Standalone but integrated.** Reef is its own package (own API, state, config, entrypoint, operator UI) and runs on its own. **clawbits depends on Reef, never the reverse**; clawbits supplies human auth, the customer UI, and agent identity.

**In scope:** isolation boundary, on-demand lifecycle, persistence, networking, agent profiles, web-UI exposure, the clawbits integration seam, and a Reef-owned admin/fleet API + operator UI.
**Out of scope:** human auth and the **customer-facing** UI (clawbits owns those); the agents' own behavior.

---

## 2. Requirements

| | Requirement | MVP |
|---|---|---|
| F1 | Spin up an isolated agent on demand | ✅ |
| F2 | Many agents per host | ✅ |
| F3 | Persistent per-agent workspace surviving restarts | ✅ (**validated**) |
| F4 | Programmatic lifecycle `create/stop/destroy` | ✅ (**validated**) |
| F5 | Agent-agnostic (add types as profiles) | ✅ (OpenClaw + Hermes) |
| F6 | Reach the agent's own web UI (owner-facing) | ✅ (§12 — direct port local; subdomain proxy prod) |
| N1 | Host protection — compromised agent can't touch host | ✅ (microVM; ⚠ dev uses Docker — shared kernel, §3) |
| N2 | Separate planes — agent host(s) ≠ app host | ✅ |
| N3 | Outbound-only by default — no inbound into a microVM | ✅ (web-UI exposure is the deliberate opt-in, §12) |
| N4 | Lean ops — no heavyweight orchestrator/daemon | ✅ |
| N5 | Modular — Reef standalone-capable; no reverse dep | ✅ |
| N6 | Reuse infra: Postgres, Redis, R2, dotenvx, Komodo | ✅ |
| N7 | Upgrade path additive (runtime/profile/scale/confidential) | ✅ |
| — | Mixed-untrusted-tenant co-mingling · no-access · scale-to-zero | ⛔ later (§10) |

---

## 3. The stack (decisions)

| Aspect | Choice |
|---|---|
| **Isolation** | One microVM per agent, via **microsandbox** (libkrun) in prod |
| **Runtime control** | Drive a CLI via subprocess (the `git/repo_manager.py` pattern). Two backends behind one seam: **`msb`** (microsandbox, prod) and **`docker`** (dev). Both embedded — **no daemon of our own**. |
| **Dev runtime** | **`DockerRuntime`** (OrbStack on the Mac). microsandbox's host↔guest relay (`exec`/`-p`/`logs`) is unreliable on macOS/HVF, so local agents run as Docker containers where port-forward + exec + logs work. **Trade-off: a container shares the host kernel** — fine for single-tenant local dev, never for untrusted multi-tenant. |
| **Prod runtime** | **`MicrosandboxRuntime`** on the agent host (Linux/KVM). True microVM isolation. |
| **Backend choice** | `reef.runtime_factory.make_runtime()` — docker on macOS, microsandbox elsewhere; override with `REEF_RUNTIME=docker\|microsandbox`. Both satisfy `AdminRuntime`, so nothing downstream changes. |
| **Three axes** | `AgentRuntime` (the VMM) × `AgentProfile` (the agent type) × `ExposureStrategy` (how the web UI is reached). Reef hardcodes none. |
| **Agent host** | **Bare metal** (AMD EPYC, KVM; SEV-capable for later), separate from the app host. Dev = the M1 Pro (Docker/OrbStack). |
| **Persistence** | Per-agent **named volume** mounted into the guest; `stop`/`start` preserve state. **Validated.** A second **status volume** (host-readable) carries the agent's volunteered telemetry (§7). |
| **Networking** | **Outbound-only by default.** Egress allowlist is **native** on msb (`--net-default-egress deny` + `--net-rule allow@<target>`); Docker has no per-container egress allowlist, so `net_allow` is ignored there (dev only). Inbound is opened *only* by the web-UI exposure path (§12). |
| **State** | Reef's own `SandboxStore` (4-method async Protocol). **`SqliteSandboxStore` is the default** (§9 #4 — one secret-free WAL file, survives API restarts so agents reconcile as `managed`); `InMemorySandboxStore` for tests (`REEF_STORE=memory`); Postgres later for multi-host. The fleet view still reconciles existence from `msb list`/`docker ps`; the store enriches + marks `managed`. Agent identity stays in clawbits' `agents`. |
| **Posture** | Lean & modern — no Nomad/Consul/Kubernetes, no custom daemon. Python ≥ 3.14. |

**Fallbacks (swappable via `AgentRuntime`):** Cocoon (standalone Cloud Hypervisor); Kata + Cloud Hypervisor. *Egress is native in microsandbox, so Cocoon is a general microVM fallback only, not the egress fallback.*

**Rejected:** plain containers in prod (shared kernel); gVisor (not VM-level; only without KVM); raw Firecracker/CH (too much systems code); Kubernetes / Nomad+Consul / E2B-self-hosted (heavyweight).

### Foundation principles
1. **`AgentRuntime` interface** — `create/start/stop/destroy/status`. The seam for VMM swaps and local-vs-remote. *The reason adding the Docker dev runtime cost almost nothing.*
2. **`FleetRuntime` interface** — `list/metrics/inspect/logs/read_status`, the read/observability surface the admin API needs. `AdminRuntime = AgentRuntime + FleetRuntime`.
3. **`AgentProfile` interface** — agent type = image + `build_env(creds)` + `exposure_env` + `access_info`. Adding an agent is a new profile + an `AGENT_TYPES` entry, not a rewrite.
4. **`ExposureStrategy` interface** — `forward/url_for/publish/unpublish`. Direct port locally, nginx subdomain in prod, chosen by config.
5. **One image per profile** — the unit of deployment.
6. **Outbound-only by default** — agent phones home; the only inbound path is the deliberate web-UI exposure (§12).
7. **Dependency inversion** — clawbits depends on Reef; Reef has zero `clawbits.*` imports.

---

## 4. Modularity (the boundary)

**clawbits depends on Reef; Reef never imports clawbits.**

```
 clawbits (main app)                       Reef (this sub-project — standalone-capable)
 ─ WorkOS auth · org scoping               ─ AgentRuntime × AgentProfile × ExposureStrategy
 ─ dashboard + VM spin-up UI               ─ SandboxManager (lifecycle + expose)
 ─ owns agents/orgs identity               ─ FleetService · sandboxes state · admin/fleet API + operator UI
 ─ builds request, calls Reef ───────────▶ ─ HTTP API + Python API (Cloudflare Access / bearer token)
   (depends on Reef)                       ─ own entrypoint + REEF_* config
```

- **Auth seam:** clawbits (WorkOS) authorizes + calls; Reef's API is guarded by a **bearer service token** (machine path) and **Cloudflare Access** JWTs (human operators); Reef never sees WorkOS directly.
- **UI seam:** customer spin-up UI in clawbits' frontend → clawbits endpoint → Reef. Reef's own **operator** UI (`reef/admin-ui/`) is separate and internal.
- **Creds seam:** clawbits owns `agents`, picks the profile, passes `creds` + limits. Reef never touches clawbits' DB.
- **Lean + modular:** MVP **mounts Reef in-process** (one deploy); "run on its own" later = flip the call to HTTP + run Reef's entrypoint (`python -m reef.api`). Config change, not a rewrite.

---

## 5. Architecture & code

```
┌ App host ─────────────────────┐        ┌ Agent host (bare metal · KVM) ─────────────┐
│ clawbits (FastAPI)            │  call  │ Reef (embeds the runtime via a CLI)        │
│  · reef adapter: auth→spec→── ┼──────▶ │  · SandboxManager · FleetService           │
│    call SandboxManager        │        │  · MicrosandboxRuntime → `msb create/...`   │
└────────────────────────────────┘        │   ┌ microVM ┐ ┌ microVM ┐ ┌ microVM ┐      │
        ▲ agent polls clawbits OUTBOUND   │   │ openclaw│ │ openclaw│ │ openclaw│ +vol  │
        └─────────────────────────────────┼───┴─────────┴─┴─────────┴─┴─────────┴───────┘
  Dev: clawbits + Reef + DockerRuntime (OrbStack) on the M1 Pro. Prod: Reef + msb on the agent host, clawbits calls it.
  Inbound only via the §12 web-UI exposure (direct port locally / nginx subdomain in prod).
```

**Package (`reef/`, zero `clawbits.*` imports):**

| File | What |
|---|---|
| `runtime.py` | `AgentRuntime` (lifecycle) + `FleetRuntime` (read) + `AdminRuntime` Protocols; `SandboxSpec`, `SandboxState`, `Limits`, `SandboxInfo`, `MetricsSample` |
| `profiles.py` | `AgentProfile` Protocol + `OpenClawProfile` / `HermesProfile`; `AccessInfo` (the type-scoped access reveal — URLs + the per-agent secret when available) |
| `agents.py` | `AGENT_TYPES` registry (openclaw ✅ · hermes ✅) + `infer_type` (label drift/hand-created VMs) |
| `manager.py` | `SandboxManager` — idempotent `ensure_running` / `expose` / `stop` / `destroy` |
| `fleet.py` | `FleetService` — fleet list/detail/metrics/logs + **create**, secret **redaction**, lifecycle by name (handles drift) |
| `microsandbox_runtime.py` | **`MicrosandboxRuntime`** — drives `msb` via subprocess (prod, Linux; validated) |
| `docker_runtime.py` | **`DockerRuntime`** — drives `docker` via subprocess (dev, macOS/OrbStack) |
| `runtime_factory.py` | `make_runtime` / `make_exposure` — pick backend + exposure by platform/env |
| `exposure.py` | `ExposureStrategy` Protocol + `DirectPortExposure` (dev) + `SubdomainProxyExposure` (prod nginx) + `Exposure` |
| `ports.py` | `PortAllocator` — host-port range (`19000–19999`) for `-p` forwards, store-tracked |
| `status.py` | host-side reader for the agent-volunteered `status.json` (never execs in the guest) |
| `fake_runtime.py` | in-memory runtime for tests |
| `store.py` | `SandboxStore` Protocol + `InMemorySandboxStore` |
| `models.py` | `Sandbox` (Reef's own state record; carries `port`/`url` when exposed) |
| `errors.py` | `ReefError`, `SandboxNotFound`, `RuntimeUnavailable` |
| `api/` | the admin/fleet HTTP API (FastAPI): `app`, `routes`, `schemas`, `security` (auth guard), `access` (Cloudflare Access JWT) |
| `admin-ui/` | the operator dashboard — standalone Vite 8 + React 19 + TS + Tailwind v4 + TanStack Query (§9 #9) |
| `images/openclaw-runtime/` | the OpenClaw agent image (`Dockerfile` + `entrypoint.sh` — §7) |
| `images/hermes-runtime/` | the Hermes wrapper image (upstream Hermes + baked Clawbits extension) |
| `tests/` | **133 tests across 11 files**, green (manager, both runtimes, fleet, fleet-runtime, exposure, ports/factory, api, access-auth, versions) |

**Interfaces:**
```python
@dataclass(frozen=True) SandboxSpec:  # runtime-agnostic descriptor
    sandbox_id; image; env; volume; volume_dest; net_allow; ports; status_dest; limits  # env carries per-agent creds

class AgentRuntime(Protocol):    # create / start / stop / destroy / status                     (async)
class FleetRuntime(Protocol):    # list_sandboxes / metrics / metrics_for / inspect / logs / read_status
class AdminRuntime(AgentRuntime, FleetRuntime, Protocol):  # what FleetService drives; both runtimes satisfy it
class AgentProfile(Protocol):    # name; image; volume_dest; ui_port; status_dir; build_env / exposure_env / access_info
class ExposureStrategy(Protocol):# forward / url_for / publish / unpublish
class SandboxManager:            # ensure_running / expose / stop / destroy                      (idempotent)
class FleetService:              # list_fleet / get_detail / metrics / logs / create / start / stop / destroy
```

**Lifecycle:** `CREATING → RUNNING ⇄ STOPPED → DESTROYED` (+ `FAILED`). `ensure_running` reconciles: missing→create+start; stopped/failed→start; running→no-op. Validated against real `msb` *and* Docker.

---

## 6. The runtime CLIs — validated mappings

Both runtimes are thin subprocess wrappers; every Reef op maps to a flag. microsandbox is embedded (**no daemon**), so the prod runtime runs wherever Reef runs.

### microsandbox (`msb` 0.5.4 — prod, Linux)

| Reef op | `msb` command |
|---|---|
| create (named, background) | `msb create -n <id> -c <cpus> -m <mem>M -v <vol>:<dest> [-v <status-vol>:<status-dest>] -e K=V … [-p …] [--net-rule …] --replace <image>` |
| restart with state | `msb start <id>` / `msb stop <id>` |
| destroy | `msb remove -f <id>` |
| status | `msb status <id> --format json` → `{"status":"Running"\|"Stopped"\|…}` |
| persistent storage | `msb volume create <vol>` + mount via `-v` |
| **egress allowlist** | `--net-default-egress deny --net-rule "allow@api.anthropic.com:tcp:443" …` |
| **port forward (web UI, §12)** | `-p 127.0.0.1:<host>:<guest>` |
| **fleet / observability (#8)** | `msb list / metrics / inspect / logs --format json` |
| scale-to-zero (later) | `--idle-timeout` (auto-stop) + `msb snapshot export/import` (→ R2) |

**Validated:** boot, exec, outbound networking, and **persistence across stop→restart** (a file on a named volume survived). The full `MicrosandboxRuntime` lifecycle ran green against real `msb`.

### docker (dev, macOS/OrbStack)

`DockerRuntime` mirrors the same surface so the manager and fleet API are unchanged. Per-agent containers are stamped with a **`reef.managed=true`** label so the fleet view shows only Reef's agents. Two intentional deltas, both fine for single-tenant local dev: **no egress allowlist** (`net_allow` ignored), and the status mount is a host **bind mount** (`~/.reef/agents/<id>`) rather than a named volume.

**Host reachability (local dev).** `create` always passes `--add-host host.docker.internal:host-gateway`, so an agent can reach services bound to the host's loopback — notably a **locally-running clawbits backend on `localhost:8000`**: set the VM's `clawbits_url` (→ `CLAWBITS_ENDPOINT`) to `http://host.docker.internal:8000` instead of `localhost:8000` (which, inside the guest, is the guest itself). The name is predefined on Docker Desktop/OrbStack (the flag is a harmless no-op there) and *required* on Linux Docker. The clawbits backend already binds `0.0.0.0:8000`, so it accepts the host-gateway connection. This makes the standalone Mac/Linux *Docker* runtime the uniform dev path — on a Linux dev box, set `REEF_RUNTIME=docker` so this single host alias covers it too (microsandbox stays the prod path).

| Reef op | `docker` command |
|---|---|
| create | `docker run -d --name <id> --label reef.managed=true --add-host host.docker.internal:host-gateway --cpus <c> --memory <m>m -v <vol>:<dest> [-v <hostdir>:<status-dest>] -e K=V … [-p …] <image>` |
| restart | `docker start <id>` / `docker stop <id>` |
| destroy | `docker rm -f <id>` (+ drop the status dir) |
| status | `docker inspect -f '{{.State.Status}}' <id>` |
| fleet | `docker ps -a --filter label=reef.managed=true`, `docker stats`, `docker inspect`, `docker logs` (normalized to msb's `{"config":{…}}` shape) |

---

## 7. The OpenClaw agent image (`reef/images/openclaw-runtime/`)

**Confirmed: OpenClaw 2026.6.6 boots green** — onboards headless → gateway ready → container healthy (verified on Docker/OrbStack, 2026-06-12). Reef runtime image **0.6.0**: base `2026.6.8` (the `latest` tag, 2026-06-19), clawbits plugin **0.8.0**, persistent auth-profile volume, and direct OpenAI runtime pin for Reef's API-key default. The build now derives the plugin cache key from `plugin/package.json`, so a server minimum-version bump cannot silently reuse an older plugin layer. Channel wiring + Control UI + scoped-terminal reachability carry over from the prior build. (The microVM/msb validation was on 0.5.1; re-verify on msb at next prod deploy.)

**Base:** `ghcr.io/openclaw/openclaw:2026.6.5` (node:24-bookworm-slim + tini; `openclaw` preinstalled). **Multi-arch** — arm64 boots natively on the Mac, amd64 for EPYC.

**Plugin baked in the Dockerfile:** `openclaw plugins install clawhub:clawbits-openclaw-plugin --pin`. Runs as the `node` user → lands under the user plugin root; placed *before* the entrypoint `COPY` so editing the entrypoint doesn't bust the network layer. `--pin` locks the version (reproducible; bump deliberately, like the base tag). This used to pass `--acknowledge-clawhub-risk`; OpenClaw **removed** that flag and the CLI now hard-errors on it ("does not recognize option"), which broke every image build. The gate moved into `security.installPolicy` — a community package prints a review warning and installs. If a future release makes that fail-closed again, set `security.installPolicy` rather than reintroducing a flag.

**Plugin allowlist — deliberately NOT set.** The entrypoint used to pin `plugins.allow=["clawbits"]` to silence OpenClaw's boot warning that discovered plugins "may auto-load". That was a bad trade: `plugins.allow` is an **exclusive** allowlist ("when set, only listed plugins are eligible to load"), so it also disabled OpenClaw's *bundled* extensions. Measured in the image: `allow=["clawbits"]` → **1 loaded / 95 disabled**; no allowlist → **66 loaded / 30 disabled**. Casualties included `browser` (the browser tool), `document-extract` (PDF reading), `web-readability` (what makes `web_fetch` readable), `canvas`, and every bundled provider extension. Neither `plugins.bundledDiscovery=compat` nor setting a root `browser.*` key works around it — both tested, both no-ops.

So the entrypoint runs `openclaw config unset plugins.allow` on every boot. The `unset` (rather than simply not setting it) matters: agents created before this change carry the old value in their **persisted** `~/.openclaw`, and this is what clears it for them on restart. The boot warning returns — that is the accepted half of the trade. Use `plugins.deny` if a specific plugin ever needs blocking, and note it is a *default*, not a control: `tools.fs.workspaceOnly` defaults false, so the agent can rewrite its own config. The microVM is the boundary, not this line.

**Browser automation:** the Dockerfile defaults to the official **`-browser`** base variant (`OPENCLAW_IMAGE_VARIANT`), which ships Chromium via Playwright's managed cache — the plain image bundles the Playwright JS but *no* browser binary, so the `browser` tool is dead on arrival there. The entrypoint probes for a Chromium (PATH first, then `~/.cache/ms-playwright/chromium-*/chrome-linux*/chrome`) and only then sets `browser.enabled/headless/noSandbox/executablePath`, so a slim build never advertises a browser it cannot launch. **`noSandbox` is required, not optional** — verified in-image that headless Chromium fails to start without it. `browser` is also absent from the `coding` tool profile that `openclaw onboard` writes, so the entrypoint merges it in via `tools.alsoAllow` (never plain `tools.allow`, which would *replace* the profile). `tools.profile="full"` is deliberately avoided: it silently includes `group:messaging`.

**Default model:** Reef injects only the provider API key (`build_env` in `reef/profiles.py`) and does **not** otherwise choose a model; with nothing configured OpenClaw falls back to its built-in default (`openai/gpt-5.5`, which can hit *"Unknown model"* when the runtime model catalog lags that bleeding-edge default). For the **OpenAI-only** case the entrypoint pins a known-good multimodal model (`openai/gpt-5.4`) via `openclaw models set`, plus exact-model `agentRuntime.id=openclaw`: OpenClaw 2026.6.5 otherwise routes `openai/*` agent turns through the Codex harness and can mislabel an OpenAI Platform `insufficient_quota` response as a Codex subscription limit. Both pins are **gated on no model already configured** so a user's later Control-UI choice (persisted across restarts) is never clobbered. Reef can override the model pick for any provider via **`REEF_DEFAULT_MODEL`** (the seam for create-time provider/model — §13 option C); custom overrides do not receive the automatic runtime pin. Anthropic is left on OpenClaw's own default (it resolves). Verified on the rebuilt image: an OpenAI-key agent comes up on `openai/gpt-5.4` and an agent turn reaches the OpenAI API (no "Unknown model").
**Also baked:** a static **`ttyd`** binary (per-arch, fetched via `node` at build — it's not in apt) + the `reef-term.{sh,mjs}` scoped-shell wrapper, for the web terminal (§13).

**The critical fix:** the image's default CMD is the **systemd-service** gateway path, which a microVM lacks. The entrypoint overrides it to onboard headlessly and run the gateway **in the foreground** — no daemon.

**What the entrypoint does (`entrypoint.sh`, all validated):**
1. **Gateway token.** If Reef didn't pin `OPENCLAW_GATEWAY_TOKEN`, generate an ephemeral one (outbound-only ⇒ nothing connects in, so no reason to refuse to boot).
2. **Onboard gate on `gateway.mode`, not file-existence.** Baking the plugin leaves a *stub* `~/.openclaw/openclaw.json` (plugin registration, **no `gateway.mode`**); a file-existence gate would skip onboarding and `gateway run` aborts with *"missing gateway.mode."* Fix: gate on `openclaw config get gateway.mode != local`. Onboard sets `gateway.mode=local` and preserves the baked plugin flag. On a restart with persisted config, it skips straight to running.
3. **Wire the clawbits channel** — the plugin reads `channels.clawbits.accounts.default.*` from the **config store, not env**, so the entrypoint bridges the injected `CLAWBITS_*` into it via `openclaw config set`. Four shapes:
   - **already wired** (config persisted across stop/start) → leave it untouched.
   - **pre-provisioned** (`agentId`+`apiKey`+`channelId`+`orgId` all present) → write the account directly, no approval loop.
   - **token-enroll** (`CLAWBITS_ORG_ID` + `CLAWBITS_SIGNUP_TOKEN` — a one-time `human-…` token from the Clawbits "Add agent" prompt, the admin-UI "connect to Clawbits" path) → seed endpoint+org, then run `openclaw clawbits signup --signup-token …` **before gateway startup** so the plugin sees a configured account on first load (no approval step); it `eval`s the `openclaw config set` lines the signup prints. Org set but **no** token → seed defaults and skip signup (logged) — the plugin now requires a token.
   - **detached** (no `CLAWBITS_*`) → start the gateway with no channel.
4. **Volunteered status telemetry.** Write a small, **secret-free** `status.json` (schema, timestamp, `versions.{image,openclaw,clawbitsPlugin}` — where `image` is the Reef runtime-image version baked in at build time via `REEF_IMAGE_VERSION`) to the Reef **status mount** at boot and on an interval (`REEF_STATUS_INTERVAL`, default 300s; `0` = boot-only). Reef reads it **host-side** (`reef/status.py`) — never executing anything in the guest. Backgrounded; best-effort. The dashboard renders all three as chips in the detail Versions card.
5. **Control-UI exposure (§12).** When Reef sets `OPENCLAW_GATEWAY_BIND=lan` + `OPENCLAW_GATEWAY_AUTH=token` (+ `OPENCLAW_GATEWAY_TOKEN`, read natively — kept off argv) + `OPENCLAW_PUBLIC_URL`, the entrypoint writes `gateway.controlUi.allowedOrigins` and runs `gateway run --bind lan --auth token` — token auth lets the browser auto-auth from a `#token=` URL fragment (no login prompt). Defaults (`loopback`/`token`, no public URL) keep the outbound-only posture.
6. **Web terminal (§13).** When Reef sets `REEF_TERMINAL_ENABLE=1` (+ `REEF_TERMINAL_PASSWORD` — the **same** secret as the gateway token — + `REEF_TERMINAL_PORT`), the entrypoint launches **`ttyd`** on `:7681`, backgrounded so the gateway stays the foreground/liveness process. **The default shell is a real `bash -l`** (`reef-term.sh`), not the scoped one; `REEF_TERMINAL_SHELL=openclaw` swaps in the narrow `openclaw`-only shell (`reef-term.mjs`). This doc previously described the inverse. Note `exposure_env` sets `REEF_TERMINAL_ENABLE=1` unconditionally, so **every exposed agent already ships a full interactive shell to its owner** — the OpenClaw-only shell is opt-in and today only the ChatGPT-subscription path selects it.

**Resolved since the last revision:**
- ✅ **Channel config** — done, via the four paths above (#5 ⇄ #6 seam).
- ✅ **Volume-shadow caveat** — the per-agent volume mounts at OpenClaw's workspace **sub-path** (`/home/node/.openclaw/workspace`), *not* over `~/.openclaw`, so it can't hide the baked-in plugin or the device identity. The status dir is a **separate** mount (`/home/node/.reef`), also outside the state dir. (Why not mount over `~/.openclaw` like the official compose? An empty volume would shadow the baked plugin + stub `openclaw.json`; Docker's copy-into-empty-volume would paper over it locally, but `msb` — prod — does no such copy, so the agent would lose the plugin. Stop/start/self-heal already preserve the **whole container FS** incl. `~/.openclaw`; only destroy loses it. Full state-dir persistence across destroy+recreate would need a seed-if-empty pattern — deferred, blocked on §11.2. Advanced escape hatch: the entrypoint honors an `OPENCLAW_STATE_DIR` override, injectable via the create API's custom `env` — untested w.r.t. plugin discovery.)
- ✅ **Auth-profile config volume** (image **0.5.4**) — a **second** per-agent named volume `reef-<id>-config` mounts at `/home/node/.config/openclaw` (XDG config — what the official compose mounts as `OPENCLAW_AUTH_PROFILE_SECRET_DIR`). Nothing is baked there, so no shadowing; the Dockerfile pre-creates the dir **node-owned** so Docker seeds a writable volume root (msb: §11.2 applies, same as the workspace volume). Named volumes are never auto-removed by reef, so auth-profile credentials survive destroy+recreate under the same agent name.
- ✅ **State dir** = `~/.openclaw` (writable by the non-root `node` user); `COPY --chmod=0755` (non-root can't `RUN chmod` in `/usr/local/bin`).
- ✅ **Custom guest env at create** — `POST /fleet` takes an optional `env` map, merged at **lowest precedence** (reef-managed wiring always wins). Keys reef wires itself (`CLAWBITS_*`, the gateway/exposure keys, `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`) and the whole `REEF_*` prefix are **rejected with a 422** (`OPENCLAW_*` config knobs stay allowed); names/count/size are validated. Like the access secret it is **never persisted** (the store stays secret-free, §9 #4): it lives in the container env — value-masked for secret-named keys in fleet detail — survives stop/start/self-heal, and must be re-supplied on a recreate. Surfaced as a collapsed "env variables" editor in both the clawbits Add-agent dialog (gated on the `/providers` `features` capability flag, so an older reef can't silently drop it) and the admin-ui create dialog.

**Still TODO for full per-agent persistence:**
1. **Non-root volume permissions** — make a mounted volume writable by the image's non-root user so OpenClaw workspace state persists across restarts on real `msb` (root-caused; needs on-host validation — §11.2).
2. **In-microVM probe confirmation** — confirm `gateway probe` green *inside* a microVM on real `msb` (Docker is green; msb `exec`/`logs` were flaky on the Mac, which is why dev moved to Docker).

**Local build/test pipeline (Mac, Docker via OrbStack):**
```sh
# Versioned build: bakes REEF_IMAGE_VERSION from the VERSION file next to the
# Dockerfile, tags both reef-oc:plugin (the floating tag Reef uses) and
# reef-oc:<version>. Bump VERSION deliberately on any base/plugin/entrypoint change.
reef/images/openclaw-runtime/build.sh            # REEF_NO_CACHE=1 → re-resolve the plugin pin
docker run -d --name oc -e OPENCLAW_GATEWAY_TOKEN=tok reef-oc:plugin
docker exec oc openclaw gateway probe        # → Reachable: yes
docker run --rm --entrypoint sh reef-oc:plugin -c 'echo $REEF_IMAGE_VERSION'  # baked version
# msb path (Linux/prod): docker save … | msb image load -i …; msb create …
```

---

## 8. Implementation status (2026-06-04)

| # | Task | State |
|---|---|---|
| 1 | Scaffold `reef/` package | ✅ done (ruff clean) |
| 2 | Unit tests | ✅ done — **128 tests green** across 11 files |
| 3 | microsandbox spike on M1 Pro | ✅ done — persistence/restart/egress/CLI surface validated |
| 4 | `MicrosandboxRuntime` (subprocess) | ✅ done — validated end-to-end vs real `msb` |
| 4b | `DockerRuntime` (dev backend) | ✅ done — local agents run as OrbStack containers (msb host↔guest relay flaky on macOS); `runtime_factory` picks per-platform. Both satisfy `AdminRuntime`. |
| 5 | `openclaw-runtime` image + entrypoint | 🟢 green on Docker — plugin + **ttyd** baked, four-path channel wiring, `gateway.mode` onboard gate, status telemetry, **token-auth Control-UI + scoped-terminal exposure**. In-microVM `gateway probe` on real `msb` + non-root volume perms still to confirm (§7, §11.2). |
| 6 | clawbits reef adapter + in-process mount | ⚪ pending (unblocked) — no `reef` import in `clawbits/` yet |
| 7 | End-to-end on the Mac | ⚪ pending |
| 8 | Reef admin/fleet API foundation | ✅ done — `reef/api/` (FastAPI, standalone) over `FleetService`; read ops (`list/metrics/inspect/logs/read_status`), `POST /fleet` create+expose, lifecycle by name (handles drift), **redacts inspect-env secrets**. |
| 8b | Admin-plane auth | ✅ done — **Cloudflare Access** JWT verification (`api/access.py`, WorkOS as IdP behind Access) **+ bearer service token** (`REEF_ADMIN_TOKEN`); open only when neither is configured (local dev). mTLS is the planned hardening (§11.4). |
| 8c | Agent-volunteered status telemetry | ✅ done — secret-free `status.json` written by the entrypoint to a host-readable status mount; surfaced in the detail view. No guest execution. |
| 9 | Operator admin/fleet UI | ✅ done — standalone `reef/admin-ui/` (Vite 8 + React 19 + TS + Tailwind v4 + TanStack Query): sidebar fleet list (search/filter, type icons, drift tag, live CPU), Home (KPIs + agent grid + fleet composition + host summary), agent detail (metrics, logs, **Web UI access reveal/copy**, versions, config/networking/mounts, **redacted env**), create dialog, start/stop/destroy, 5s polling. Verified against the live API + real `msb`/Docker. |
| 10 | Web-UI exposure (direct + subdomain proxy) | ✅ built — **surface-aware** `DirectPortExposure` (local, validated) + `SubdomainProxyExposure` (nginx wildcard/TLS, `nginx/reef-base.conf.example`); loopback-**IP** URLs + host-port reconcile (`used_host_ports`). Prod DNS/TLS validation on a real host pending (§12). |
| 11 | Config access — scoped web terminal (§13) | 🟢 built on Docker — `ttyd` `openclaw`-only terminal as a 2nd surface; **both surfaces auto-auth** from one per-agent token (Control UI `#token=`, terminal basic-auth), no prompts. Create-time provider/model + trusted-proxy SSO next. |

**Proven this build:** persistent storage + restart; OpenClaw green with a wired channel + Control UI + a scoped web terminal (both surfaces auto-authenticated); both runtimes drive their CLIs correctly; native egress allowlisting (the old #1 risk); a full operator UI over an authenticated API.

---

## 9. Next steps (ordered)

1. **#6 clawbits adapter** — `clawbits/fastapi/reef_endpoints.py`: `Depends(get_current_human_user)`, org-scoped → load agent → build `SandboxSpec`/creds → call `SandboxManager`/`FleetService` (in-process). **Cred provisioning:** mint a clawbits agent + API key when the VM is created (pre-provisioned path), or use the org-only auto-signup path (§7). Surface the returned `{url, password}` to the user.
2. **#7 end-to-end on the Mac** — clawbits "start agent" → real OpenClaw container/microVM → polls clawbits → processes a task → restart preserves workspace.
3. **Finish #5 persistence** — non-root **volume mount permissions** so device-identity/config/workspace survive restarts via the mounted volume on real `msb`; confirm the in-microVM `gateway probe`.
4. **Reef state (write path)** — ✅ **built**. The fleet read path already reconciles from `msb list`/`docker ps` (store enriches + marks `managed`); **host-port allocation reconciles too** — `SandboxManager._used_ports` unions the store with `runtime.used_host_ports()`, so a restarted (empty-store) process won't re-pick a port a prior container still holds and fail the `-p` bind. The `docker ps` path is exact; the **msb-side port parse is the remaining gap** (`MicrosandboxRuntime.used_host_ports` returns empty for now — a real collision still fails loudly at `msb create -p`). The durable **`SqliteSandboxStore`** (`reef/store_sqlite.py`) now sits behind the existing `SandboxStore` Protocol (manager/fleet/API unchanged): one `${REEF_STATE_DIR:-~/.reef}/reef.db` (WAL; stdlib `sqlite3` run off the event loop via `asyncio.to_thread`; `PRAGMA user_version` migration, no ORM), a `sandboxes` table mirroring the `Sandbox` record (**secret-free** — the access token is returned once by `expose` and lives only in the container env, never the DB), selected via the `make_store()` factory (`REEF_STORE=sqlite|memory`, default sqlite, `REEF_DB_PATH` override; tests stay in-memory). On restart the records persist → agents reconcile as `managed` (not drift) with `terminal_url` + ports intact; the runtime stays state-truth (read path prefers live `status`), so no startup sweep is needed. Postgres is the multi-host successor (same Protocol). One-time caveat: agents created before this land as drift once (destroy + recreate; a future `reef adopt` could rebuild records from `docker inspect`).
5. **Prod web-UI exposure** — stand up `SubdomainProxyExposure` on a real host: wildcard DNS + DNS-01 TLS cert for `*.reef.clawbits.ai` + `REEF_BASE_DOMAIN`/`REEF_SUBDOMAIN_SECRET` (see `nginx/reef-base.conf.example`). Built + unit-tested; never run against live nginx yet.
6. **Prod** — provision bare-metal EPYC; build/push **multi-arch amd64** image to a registry; turn on the egress allowlist + resource limits before co-mingling tenants; harden admin auth (mTLS).

---

## 10. Deferred — the north star (on the radar, not built)

- **"No access" from clawbits** — operational (outbound-only + boot-secret broker) → cryptographic (SEV/TDX + Trustee/KBS attestation).
- **Scale-to-zero** — `--idle-timeout` + `snapshot export/import` → R2 → resume anywhere.
- **Mixed-tenant hardening** — egress allowlist + tuned limits before co-mingling untrusted orgs (and no Docker dev shortcut in that path — microVM only).
- **Multi-host & metering**; splitting Reef into its own service/repo at scale.
- **SSO at the proxy** — now the chosen near-term path, specced in **§13** (gateway `--auth trusted-proxy` + clawbits/WorkOS at the proxy → per-user identity, no shared password, replacing v1's §12 password scheme). Genuinely still deferred: OpenClaw-native Tailscale serve as an alternative, and the `exec`-SecretRef boot-secret broker for zero-knowledge provider keys.

*(The internal operator UI, once a north-star item, is built — `reef/admin-ui/`, §8 #9.)*

---

## 11. Open questions

1. **clawbits channel config** — plugin packaging resolved (`clawhub:clawbits-openclaw-plugin --pin`); channel-config keys + the four entrypoint paths resolved (§7). Volume-shadow resolved (workspace sub-path mount). Remaining is just confirming the org-only auto-signup loop end-to-end against a live clawbits.
2. **Per-agent volume permissions** — make a mounted volume writable by the non-root image user so OpenClaw state (incl. device identity) persists on real `msb`. Applies to all three per-agent mounts: workspace, status, and the auth-profile config volume (`/home/node/.config/openclaw`, §7).
3. **Reef↔clawbits auth** — bearer service token + Cloudflare Access are **built** (§8b); mTLS remains the planned hardening for the out-of-process machine path.
4. **Prod registry + multi-arch build** (arm64 dev / amd64 EPYC) — still to do.

---

## 12. Web-UI exposure — let users reach the OpenClaw Control UI

**Goal:** give each agent's owner one-click, **pre-authenticated** access to the agent's two web surfaces — the OpenClaw **Control UI** (chat, config, model picker) and a **scoped terminal** (the `openclaw` CLI, §13) — from a single per-agent secret. v1 security = OpenClaw's own auth (a per-agent token) + TLS + an unguessable subdomain; no clawbits SSO yet (deferred — §10).

The gateway serves the Control UI (HTTP **and** WS) on **:18789** (`AgentProfile.ui_port`). It binds **loopback** by default; `--bind lan` → 0.0.0.0. OpenClaw **refuses a non-loopback bind without auth**, and (since v2026.2.26) requires the public origin in **`gateway.controlUi.allowedOrigins`** or the browser's WS is rejected. All validated on the M1 Pro.

**Exposure is the third seam — `ExposureStrategy` — chosen by config** (`make_exposure()`: proxy when `REEF_BASE_DOMAIN` is set, else direct):

| | Local (dev, the Mac) | Prod (Reef host) |
|---|---|---|
| URL | `http://127.0.0.1:<port>` (the loopback **IP**, not `localhost` — Docker publishes IPv4, browsers resolve `localhost`→`::1`) | `https://<hash>.reef.clawbits.ai` |
| proxy / DNS / TLS | none | nginx wildcard + `*.reef.clawbits.ai` + DNS-01 cert |
| surfaces | two ports: `-p 127.0.0.1:<p1>:18789` (Control UI) + `-p 127.0.0.1:<p2>:7681` (terminal) | *same*, two subdomains |
| gateway | `--bind lan --auth token` — the token auto-auths the Control UI from a `#token=` fragment | *same* |
| `controlUi.allowedOrigins` | the URL (+ loopback) | the URL (+ loopback) |
| status | ✅ validated locally (browser) | ⚪ built, not yet run on a real host |

```
ExposureStrategy(Protocol): forward · url_for(…, surface) · publish(…, surface) · unpublish   # surface = "ui" | "terminal"
  ├─ DirectPortExposure     (dev)  url=http://127.0.0.1:<port>          no proxy (publish/unpublish no-op)
  └─ SubdomainProxyExposure (prod) url=https://<hash>.reef.clawbits.ai  + per-agent nginx server block(s) + reload
```

`<hash>` is a deterministic SHA-256 digest of `<secret>:<sandbox_id>` (stable across restarts, unguessable, no extra state). `publish` writes `<sandbox_id>.conf` into `REEF_NGINX_DIR` (default `/etc/nginx/reef.d`, included by the base config) with WS-upgrade headers and reloads nginx; `unpublish` removes it. The base wildcard server, the `*.<base_domain>` cert (Let's Encrypt DNS-01), and DNS are one-time host setup — see [`nginx/reef-base.conf.example`](../nginx/reef-base.conf.example).

**Reef code (built):** `SandboxSpec.ports` (→ `-p`, multiple); `PortAllocator` (`19000–19999`) over the store **∪ live host ports** (`runtime.used_host_ports()` — reconciles `docker ps`, so a restarted empty-store process never re-picks a bound port and fails the bind); per-agent `Sandbox.{port,url,terminal_port,terminal_url}`; the surface-aware `ExposureStrategy` + the nginx renderer; `SandboxManager.expose()` → `Exposure{url, port, password, terminal_url}` (one secret — the gateway token, which doubles as the terminal password — issued once, never persisted); `FleetService.create()` create-and-expose; the API's `POST /fleet` + the detail's `access` reveal; the UI's **Web access** panel + per-surface "open" actions.

**Per-agent runtime contract** (env Reef injects; the image entrypoint applies it). One secret unlocks both surfaces, each opened pre-authenticated (no prompt):
- **Control UI:** `OPENCLAW_GATEWAY_BIND=lan` · `OPENCLAW_GATEWAY_AUTH=token` · `OPENCLAW_GATEWAY_TOKEN=<secret>` (read natively — off the argv) · `OPENCLAW_PUBLIC_URL=<the URL>` → entrypoint writes `gateway.controlUi.allowedOrigins`; the UI opens `…/#token=<secret>` (the gateway's native auto-auth — the fragment never reaches the server).
- **Terminal:** `REEF_TERMINAL_ENABLE=1` · `REEF_TERMINAL_PASSWORD=<secret>` (the **same** secret) · `REEF_TERMINAL_PORT=7681` → entrypoint runs `ttyd --credential reef:<secret>`; the UI opens `http://reef:<secret>@<host>` (ttyd HTTP basic auth).

**Modularity:** Reef owns the proxy, the hash↔port↔agent map, exposure records, and URL minting (standalone via `REEF_BASE_DOMAIN`); clawbits owns DNS, the cert, identity, and surfacing access to the user — it just consumes Reef's `Exposure{url, terminal_url, password}`.

**Security (v1 → future):** v1 = TLS + a per-agent **gateway token** (also the terminal's basic-auth password) + unguessable hash subdomain; this deliberately opens **inbound** (the documented exception to N3), but the proxy is the only public surface. The `access` reveal (URLs + secret) is the one deliberate, type-scoped un-redaction in the otherwise-masked admin views — the admin UI is the trusted operator surface. Auto-auth carries the secret in the opened URL (Control UI `#token=` fragment — client-only, never server-logged; terminal `user:pass@` — basic auth), so it lands in the opener's browser history: acceptable for local/operator use, and replaced in the end state by **clawbits/WorkOS SSO at the proxy** → gateway `--auth trusted-proxy` (per-user identity, no shared secret — §13), or OpenClaw-native Tailscale serve. NB the terminal's secret is still on ttyd's argv (visible to `ps` inside the VM) — prod should move ttyd auth to the proxy.

---

## 13. Configuration access — let users fully configure their agent

**Goal:** give a microVM's owner full, safe access to OpenClaw's own configuration — pick the **AI provider + model**, wire channels, tune the gateway — without Reef/clawbits holding their provider secrets or leaning on a shared password. Today's only path is manual: open the Control UI (§12) and hand-edit, behind a shared password, with provider keys we injected as plaintext env. This section is the plan.

**Status:** Decided · 2026-06-04 — the **scoped web terminal (ttyd) is built**, and **both web surfaces auto-authenticate** from one per-agent secret (Control UI `#token=`, terminal basic-auth — no prompts); create-time provider/model and trusted-proxy SSO are the next layers. Research validated against the `reef-oc:plugin` image (`openclaw config schema` + the CLI/gateway surface) and the OpenClaw docs.

### 13.1 How OpenClaw config works (verified)

- **One schema-driven store.** `~/.openclaw/openclaw.json` (JSON5), ~40 top-level sections (`agents`, `models`, `secrets`, `gateway`, `auth`, `channels`, …). A machine-readable JSON Schema is available via **`openclaw config schema`** (~2.5 MB); the Control UI renders its config form straight from that schema.
- **Provider + model** (the headline use case):
  - `agents.defaults.model.primary` — e.g. `"anthropic/claude-sonnet-4-6"`; `agents.defaults.model.fallbacks` — e.g. `["openai/gpt-5.4"]`
  - `agents.defaults.models.<provider/model>` — catalog / allowlist
  - `models.providers.<provider>.{apiKey, baseUrl}` — provider credential + custom/self-hosted base URL (OpenAI-compatible, OpenRouter, …)
  - CLI: `openclaw models` (list/scan/set), `openclaw models status` (auth health)
- **SecretRef — the secret primitive (what makes "secure" possible).** Any secret field (`models.providers.*.apiKey`, `gateway.auth.token/password`, channel tokens) is *either* an inline string *or* a reference `{ source: "env" | "file" | "exec", provider, id }`. The **resolved secret is never persisted** — only a marker (the env-var name for `env`; `secretref-managed` for `file`/`exec`). So the config we read/redact stays secret-free; the real key lives in env, a file, or a broker command. `openclaw secrets` audits/reloads them.
- **Three read/write surfaces:**

  | Surface | Mechanism | We use it |
  |---|---|---|
  | **CLI** | `openclaw config get/set/patch/unset/schema/validate`; SecretRef builder (`--ref-source env --ref-id <VAR>`), batch | ✅ entrypoint wiring today |
  | **Gateway WS RPC** | `config.get` (snapshot + `hash`), `config.schema.lookup`, `config.patch` (merge), `config.apply` (replace); writes need `baseHash`, rate-limited 3/60s; via `openclaw gateway call` | candidate for a native panel (option 2) |
  | **Control UI** | the schema-driven form + raw JSON editor on `:18789` | ✅ exposed today (§12) |

- **The Control UI does NOT configure providers (the decisive finding).** Its model selector is a *picker* over already-configured models; there is **no "add a provider + key" form and no embedded terminal**. So provider/model setup is a **CLI** job (`openclaw configure`, `openclaw models`, `openclaw models auth …`). Keyed providers (Anthropic/OpenAI/OpenRouter/custom) are fully **scriptable** (env `<PROVIDER>_API_KEY` or `models auth paste-api-key`, then `openclaw models set`); OAuth providers (OpenAI-OAuth, Gemini-CLI, Grok, …) need an **interactive TTY/browser** (`openclaw models auth login --device-code`). This is why exposing the Control UI does *not* solve provider setup — and why the chosen surface is a **scoped web terminal** (§13.3).
- **Auth + exposure** (richer than §12 captured): `--bind loopback\|lan\|tailnet\|auto\|custom`; `--auth none\|token\|password\|trusted-proxy`; native `--tailscale serve\|funnel`. `gateway.reload.mode = hot\|hybrid\|restart\|off` → config can apply **live**, with no manual gateway restart.
- **`trusted-proxy` = the SSO seam (shipping, not aspirational).** With an identity-aware reverse proxy in front:
  ```
  gateway.auth.mode                     = "trusted-proxy"
  gateway.auth.trustedProxy.userHeader  = "x-forwarded-user"   # header carrying the authenticated user
  gateway.trustedProxies                = ["<proxy ip/cidr>"]  # only these may assert identity; else fail closed
  ```
  The proxy (WorkOS/OIDC) authenticates the human and sets the user header; OpenClaw accepts it **only** from a trusted proxy IP and fails closed for everyone else (loopback included). → per-user identity, **no shared password**.

### 13.2 Options

Since the Control UI can't onboard providers (§13.1), the real fork is **interactive terminal vs non-interactive wizard** — driven by keyed-vs-OAuth providers.

| # | Surface the user gets | Covers | Security | Effort |
|---|---|---|---|---|
| **A. Scoped web terminal (ttyd)** ✅ chosen | the real `openclaw` CLI in the browser | **everything**, incl. OAuth + `configure` | secret typed **inside the VM** — Reef never sees it; behind the §12 proxy + (later) trusted-proxy SSO | Med |
| **B. clawbits-native wizard** | guided "paste key → validate → pick model" | keyed providers only (drives the CLI/RPC under the hood) | key transits clawbits→Reef→VM (written as SecretRef→env) | High |
| **C. Create-time provider/model** | one field at create; set-once | keyed providers | key as SecretRef→env; config stays secret-free | Low |
| **D. Tailscale serve/funnel** | native private URL (any surface) | — | tailnet identity | Low–Med |

**A is the most flexible *and* the strongest no-access story** — the provider key / OAuth dance happens in the user's own isolated microVM, so Reef only proxies TLS bytes. It's also the one surface that covers OAuth providers, which neither the Control UI nor a pure-RPC wizard can.

### 13.3 Decision — scoped web terminal (built)

**Chosen: Option A — a scoped `openclaw` web terminal (ttyd), exposed per agent.** Most flexible (the full CLI, including the OAuth `models auth login` flows) and most secure (the user types their key / does OAuth *inside their own microVM*; Reef never handles the secret). Create-time keys (C) remain a complement for one-click bootstrap; a clawbits-native wizard (B) and Tailscale (D) stay open for later.

**Built (2026-06-03/04, e2e on Docker + browser):**
- **Image** (`reef/images/openclaw-runtime`): a static **`ttyd`** binary + `reef-term.sh` / `reef-term.mjs` — a narrow `openclaw`-only shell (argv-tokenized, no shell → no injection; `REEF_TERMINAL_SHELL=full` toggles a real shell later). The entrypoint launches ttyd (backgrounded, `--credential reef:<secret>`) when `REEF_TERMINAL_ENABLE` is set; the gateway stays the foreground / liveness process. No image change was needed for token auth — the entrypoint already supported it.
- **Two auto-authenticating surfaces, one secret.** `OpenClawProfile.terminal_port = 7681`; `exposure_env` flips the gateway to `--auth token` (`OPENCLAW_GATEWAY_TOKEN`) and gives ttyd the **same** secret (`REEF_TERMINAL_PASSWORD`). The UI opens each pre-authenticated — Control UI via the gateway's `#token=<secret>` fragment, terminal via `reef:<secret>@…` basic auth — **no prompts** (§12). `ExposureStrategy` is **surface-aware** (`url_for/publish(…, surface=)`): dev forwards a second loopback port; prod mints a distinct subdomain (`sha256(secret:id:terminal)`) + a collision-safe `<id>@terminal.conf` (`@` is illegal in a sandbox id). `SandboxManager.expose` allocates+forwards+publishes both and returns `terminal_url`, carried through `Sandbox` / `Exposure` / `AccessInfo` / the API `access` / the admin-UI **Web access** panel + sidebar context menu.
- **Verified (browser, real Docker):** 106 reef tests green (ruff + tsc clean). A created agent exposed **both** ports (`…:18789` + `…:7681`); opening the Control UI with `#token=` landed in the authed app (no prompt) and the terminal opened to the scoped `openclaw>` shell — both from the single secret. Loopback **IP** URLs (`http://127.0.0.1:<port>`) fixed a "stuck on `localhost`/IPv6" hang; host-port reconcile (`used_host_ports`) fixed a 19000 collision after an API restart.

**Still to do:** **prod auth at the proxy** — the terminal's secret is still on ttyd's argv (visible to `ps` in the VM), so prod should move ttyd auth to the proxy; then **trusted-proxy + WorkOS SSO** replaces the shared secret entirely (§10); the **egress allowlist must permit provider auth/API** endpoints for OAuth logins on `msb`; **tini-supervision** to reap per-session shells; the **clawbits** customer-UI surface; the **create-time provider/model + SecretRef** layer (C); the `exec`-SecretRef **broker** for zero-knowledge keys; and a **persistent store** (§9 #4) so API restarts stop turning agents into drift.

**References:** [trusted-proxy auth](https://docs.openclaw.ai/gateway/trusted-proxy-auth) · [configuration reference](https://docs.openclaw.ai/gateway/configuration-reference) · [model providers](https://docs.openclaw.ai/concepts/model-providers) · [models CLI](https://docs.openclaw.ai/concepts/models) · [secrets management](https://docs.openclaw.ai/gateway/secrets) · [ttyd](https://github.com/tsl0922/ttyd).

---

## 14. Reef-level AI provider keys (`REEF_*_API_KEY` + `GET /providers`)

The first slice of §13's "create-time provider/model" layer (option C), built 2026-06-11.

**The model.** The reef maintainer sets shared provider keys in reef's own environment - `REEF_ANTHROPIC_API_KEY` / `REEF_OPENAI_API_KEY` / `REEF_GEMINI_API_KEY` / `REEF_NEARAI_API_KEY` (NEAR Cloud AI, cloud-api.near.ai — IronClaw's native `nearai` backend; OpenClaw wires it as a custom OpenAI-compatible provider in its entrypoint) / `REEF_OPENROUTER_API_KEY` (OpenRouter, openrouter.ai — native on all three runtimes: IronClaw's `openrouter` backend, OpenClaw's bundled openrouter plugin, Hermes' own `openrouter` provider; model ids are `vendor/model` slugs) in `/etc/reef/reef.env` (0640, sourced by systemd) - and reef forwards them into agent VMs at create time, through the exact same `creds -> build_env -> spec.env` path the per-request (BYOK) keys already ride. Nothing is persisted (the sandbox store stays secret-free), nothing new is logged (`_subprocess._redact` masks `-e` values), and the detail view masks them like every other `*KEY*` var (`redact_env`).

**Why the `REEF_` prefix.** Reading bare `OPENAI_API_KEY` from reef's environment would silently forward a developer's personal shell key into every VM. The prefix makes forwarding an explicit maintainer opt-in.

**Discovery: `GET /providers`.** Returns `{providers: [{id, label, configured}]}` - presence booleans ONLY; key values never leave the host. Admin-gated (unlike `/healthz`): it reveals deployment config, and both consumers (the clawbits "Add agent" dialog and the dashboard's create dialog) already hold the admin token when they ask. Registry + resolution live in `reef/providers.py`; adding a provider is one tuple entry.

**Create semantics (`CreateSandboxIn.provider`).** Explicit per-request keys are always injected and win for their provider. The `provider` field governs which REEF-LEVEL keys are forwarded:

| request | reef-level keys injected |
|---|---|
| `provider` omitted (legacy callers) | all configured |
| `"anthropic"` / `"openai"` | that one (422 if no key from either source) |
| `"none"` | none (owner adds a model later in the Control UI) |

Injecting only the picked key is what selects the provider in-VM: the entrypoint already branches on which env vars are present (Anthropic key → `onboard --auth-choice anthropic-api-key`; OpenAI-only → pins `openai/gpt-5.4`, §7). No image change.

**Operational caveats.** A VM's env is fixed at create: rotating a `REEF_*_API_KEY` (env edit + service restart) affects **new** VMs only - recreate an agent to move it to the new key. And these are shared infrastructure credentials readable from inside any VM that received them (the agent process needs the key), so prefer scoped / spend-limited keys at the provider.

---

## References
- **microsandbox** (`msb` CLI, libkrun) — <https://microsandbox.dev/> · <https://github.com/microsandbox/microsandbox> · installs to `~/.microsandbox/bin/msb`
- **Docker / OrbStack** (dev runtime) — <https://www.docker.com/> · <https://orbstack.dev/>
- **OpenClaw** — <https://docs.openclaw.ai/> · image `ghcr.io/openclaw/openclaw` · gateway CLI: <https://docs.openclaw.ai/cli/gateway>
- **Cloudflare Access** (admin-plane SSO) — <https://developers.cloudflare.com/cloudflare-one/identity/>
- Fallbacks: Cocoon <https://github.com/cocoonstack/cocoon> · Kata + Cloud Hypervisor <https://katacontainers.io/> / <https://www.cloudhypervisor.org/>
- Confidential path — Confidential Containers / Trustee <https://confidentialcontainers.org/docs/attestation/>
