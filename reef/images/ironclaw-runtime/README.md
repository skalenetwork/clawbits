# Reef IronClaw runtime image

The second Reef agent type (after OpenClaw): the [IronClaw](../../../ironclaw)
Rust agent, run headless in a microVM with the **clawbits WASM channel baked in
and activated** — the IronClaw counterpart to OpenClaw's baked plugin.

Registered in `reef/agents.py` (`AGENT_TYPES["ironclaw"]`) with a matching
`IronClawProfile` in `reef/profiles.py`, so it's created/managed exactly like an
OpenClaw agent (create path + fleet views read the registry; the admin-UI
catalog lives in `reef/admin-ui/src/lib/agentTypes.tsx`).

## Layout

```
ironclaw-runtime/
├── Dockerfile     # IronClaw base + baked clawbits channel + ttyd + entrypoint
├── entrypoint.sh  # headless boot: seed config → activate channel → foreground gateway
├── reef-term.sh   # scoped `ironclaw`-only web terminal (ttyd)
└── build.sh       # build the IronClaw base (if absent) + the channel + this image
```

Image identity is derived, not hand-bumped: build.sh stamps the immutable
`reef-ic:ic<ironclaw>-ch<channel>` stack tag plus the floating `reef-ic:channel`
tag, and bakes the stack string as `REEF_IMAGE_VERSION`.

## Build

```sh
./build.sh                          # applies patches + builds everything
REEF_REBUILD_BASE=1 ./build.sh      # force-rebuild ironclaw:latest from source (see below)
REEF_IRONCLAW_BASE=my/ironclaw ./build.sh   # use a prebuilt IronClaw base image (skips the source checkout/patches)
REEF_MSB_LOAD=1 ./build.sh          # also load into microsandbox (prod)
```

IronClaw source is a checkout of upstream **`nearai/ironclaw`** at `<repo_root>/ironclaw`.
**Nothing pins the commit** — the directory is gitignored and there is no submodule, so the
build takes whatever you have checked out. If a patch below stops applying, that is
usually why. Reef-specific changes are **not forked** — they live as patches in
[`patches/`](patches/README.md) and are applied on top at build time. `build.sh`
applies the patches, so once that checkout exists you only need `./build.sh`.
The first base build is a slow full Rust build; pass `REEF_IRONCLAW_BASE` to skip it.

### Channel build

The clawbits channel WASM is compiled **inside the docker build**: the
Dockerfile's `clawbits-image` stage builds `../../../ironclaw-channel` from a
BuildKit named context (`channel-src`), so the host needs only Docker (BuildKit
— default since Docker 23), no Rust/wasm toolchain. Repeat builds stay fast via
BuildKit cargo cache mounts; only the first build compiles the (small)
dependency set cold.

A second `REEF_CHANNEL_BUILD=host` mode used to compile the channel with the
host toolchain and stage the artifacts for a plain COPY. It was removed in the
pre-open-source cleanup: it required host Rust + `wasm32-wasip2` + `wasm-tools`,
no installer or runbook used it, and production only ever builds the openclaw
runtime.

> **After editing the ironclaw source/patches**, an existing `ironclaw:latest` is
> **reused** by default — your changes silently won't ship. Force the base rebuild
> with `REEF_REBUILD_BASE=1 ./build.sh` (or `docker rmi ironclaw:latest` first).

## Runtime contract

Reef injects creds → `IronClawProfile.build_env` → container env. The entrypoint
reads them from the env (IronClaw and the channel's `.env` fallback both do):

- **Provider:** `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` (+ `LLM_BACKEND` pinned).
- **Secret store:** `SECRETS_MASTER_KEY` (no OS keychain in a microVM — IronClaw
  reads this env first; auto-generates + persists one if unset).
- **clawbits channel:** `CLAWBITS_ENDPOINT` / `CLAWBITS_ORG_ID` /
  `CLAWBITS_AGENT_ID` / `CLAWBITS_API_KEY` / `CLAWBITS_CHANNEL_ID` /
  `CLAWBITS_SIGNUP_TOKEN`. With a pre-minted `CLAWBITS_API_KEY` the entrypoint
  wires the capabilities + activates the channel directly. With only
  `CLAWBITS_ORG_ID` + `CLAWBITS_SIGNUP_TOKEN` (the admin-UI "connect to Clawbits"
  path) it first exchanges the one-time token for a minted key via the baked
  signup helper, then wires + activates. With neither it boots detached.
- **Local clawbits over http:** IronClaw's WASM HTTP gate requires `https` *and*
  rejects private/internal IPs (SSRF guard). When `CLAWBITS_ENDPOINT` is a **local**
  http URL — loopback (`http://localhost`, `http://127.*`, `http://[::1]`), a
  microVM host-gateway alias (`host.microsandbox.internal` / `host.docker.internal`
  → `*.internal`), `*.local`, or an RFC1918 literal — the entrypoint sets
  `IRONCLAW_ALLOW_INSECURE_HTTP_HOSTS=<that host>`, which relaxes both gates for
  **that host only** (matched by hostname, so a gateway name that resolves to a
  private IP still works). A plaintext-http **public** host is refused (use https).
  Requires the ironclaw base to carry the exemption (`src/tools/wasm/{allowlist,
  host}.rs`, `http_security.rs`). Default: no exemption, so prod
  (`https://clawbits.ai`) stays strict.
- **Headless boot:** a microVM has no TTY, so the entrypoint pins a non-`tui`
  `cli_mode` (+ `cli_enabled = false`) in `${IRONCLAW_BASE_DIR}/config.toml`. The
  `cli_mode` default is `Some("tui")` and resolves settings-first, so an env var
  is shadowed — `config.toml` is the only lever the `from_env` config path
  honours. The gateway — not an interactive channel — is the liveness process.
- **Web-UI exposure:** `GATEWAY_ENABLED` (defaults `true` — the liveness anchor) /
  `GATEWAY_HOST` (loopback unless Reef binds LAN) / `GATEWAY_PORT` (3000) /
  `GATEWAY_AUTH_TOKEN` (+ `REEF_TERMINAL_*` for the scoped shell).

## Status / boot-green TODOs

The Reef plumbing (profile, registry, admin-UI catalog, image scaffold) is done
and unit-tested (`reef/tests/test_ironclaw_entrypoint.py`). Resolved during
boot-green iteration:

- **Headless run.** `ironclaw run --no-onboard` drops into its full-screen TUI
  whenever `channels.cli_mode == "tui"` (the compiled default) — fatal in a
  TTY-less microVM (it just blocks on the alternate screen). Because `cli_mode`
  resolves settings-first, an env var can't disable it; the entrypoint pins a
  non-`tui` `cli_mode` (+ `cli_enabled = false`) in `config.toml` and runs the
  gateway (`GATEWAY_ENABLED=true`, loopback) as the foreground liveness process.
- **token-enroll** (`org_id` + `signup_token`). Implemented: IronClaw has no
  native signup command, so the entrypoint runs the baked
  `onboarding_message.py --signup-only` (the same challenge/known-answers
  exchange the channel installer uses) to mint a key, then wires + activates.

Remaining before this is production-green — validate against a real build+boot:

1. **Config-set key names.** The `cfg` config-set keys (`llm_backend`,
   `selected_model`, `activated_channels`) are best-effort — confirm the exact
   keys the pinned IronClaw build accepts (mismatches log a warning, don't abort).
2. **Gateway pre-auth parity.** OpenClaw auto-auths its Control UI from a
   `#token=` fragment; IronClaw's gateway uses a bearer `Authorization` token —
   wire a one-click pre-auth (small IronClaw feature or proxy-side), else the
   access panel just reveals URL + token for manual entry.
3. **Persistence** — same non-root volume-permission caveat as OpenClaw
   (REEF.md §11.2); the workspace volume mounts at `~/.ironclaw/workspace`.
