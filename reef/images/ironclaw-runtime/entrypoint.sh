#!/usr/bin/env bash
# Reef IronClaw runtime entrypoint — headless boot in a microVM.
#
# The image's normal path assumes an interactive TUI + an OS keychain, neither of
# which a microVM has. This entrypoint instead:
#   1. ensures a secret-store master key (env, since there's no keychain);
#   2. seeds provider + channel config non-interactively (`ironclaw config set`);
#   3. activates the baked clawbits WASM channel (the DB `activated_channels`
#      set — the same activation IronClaw's own installer performs) when a key is
#      available, wiring the injected CLAWBITS_* into it, and posts the one-time
#      onboarding greeting to the operator DM (deduped on the workspace volume);
#   4. writes secret-free status.json telemetry for Reef to read host-side;
#   5. optionally launches a scoped `ironclaw` web terminal (ttyd);
#   6. execs the gateway in the foreground (the liveness process — no daemon).
#
# All keys arrive as container ENV (Reef injects them; IronClaw and the channel's
# env-fallback both read from the process env), so nothing secret is written to
# disk here beyond what IronClaw persists itself.
set -euo pipefail

log() { echo "[reef-ironclaw] $*" >&2; }

STATE_DIR="${HOME:-/home/ironclaw}/.ironclaw"
CHANNELS_DIR="${STATE_DIR}/channels"
CAP_FILE="${CHANNELS_DIR}/clawbits.capabilities.json"
STATUS_DIR="${REEF_STATUS_DIR:-${HOME:-/home/ironclaw}/.reef}"
# Baked token-enroll helper (onboarding_message.py + known_answers.rs), staged by
# build.sh and COPYd by the Dockerfile. Used only for the signup-token path.
SIGNUP_DIR="${REEF_SIGNUP_DIR:-/usr/local/lib/reef-clawbits-signup}"
mkdir -p "${STATE_DIR}" "${CHANNELS_DIR}" "${STATUS_DIR}"

# `ironclaw config set` and `ironclaw run` share this base dir + DB.
export IRONCLAW_BASE_DIR="${IRONCLAW_BASE_DIR:-${STATE_DIR}}"

# --- Headless run mode --------------------------------------------------------
# A microVM has no interactive terminal, but `ironclaw run` builds its
# full-screen TUI whenever channels.cli_mode == "tui" and a stdin REPL when
# channels.cli_enabled is true — both claim stdin and, with no TTY attached, the
# process just blocks forever on the alternate screen (what looked like a "hang").
#
# cli_mode is the subtle one: its compiled default is Some("tui") and it resolves
# settings-FIRST (db_first_optional_string), so a CLI_MODE *env* var is SHADOWED
# by that default and can't turn the TUI off. `ironclaw run` builds its config via
# from_env_with_toml, and the only lever that path honours is config.toml — merged
# with merge_from(), which overrides any value that differs from the default. So
# pin cli_mode there. config.toml lives at ${IRONCLAW_BASE_DIR}/config.toml
# (Settings::default_toml_path); it's entrypoint-owned + ephemeral (only the
# workspace subdir is a mounted volume), so we (re)write it every boot. A partial
# [channels] table is valid — every other field keeps its serde default.
mkdir -p "${IRONCLAW_BASE_DIR}"
cat > "${IRONCLAW_BASE_DIR}/config.toml" <<'TOML'
# Written by the Reef entrypoint — headless boot (no TUI/REPL; gateway is PID 1).
[channels]
cli_mode = "headless"   # anything != "tui" disables the full-screen TUI channel
cli_enabled = false     # disable the stdin REPL
TOML

# The gateway is the always-on foreground liveness process (like OpenClaw's
# `openclaw gateway run`). gateway_enabled already defaults true, and these are
# settings-default==default, so — unlike cli_mode — the env vars ARE honoured.
# Reef's exposure_env overrides host/token when it binds the UI to LAN.
export GATEWAY_ENABLED="${GATEWAY_ENABLED:-true}"
export GATEWAY_HOST="${GATEWAY_HOST:-127.0.0.1}"   # loopback unless Reef exposure binds LAN
export GATEWAY_PORT="${GATEWAY_PORT:-3000}"

# --- 0. Database backend ------------------------------------------------------
# A microVM has no external Postgres, and IronClaw only auto-detects libSQL when
# ~/.ironclaw/ironclaw.db already exists — which it doesn't on a fresh container,
# so it would otherwise fail with "Missing required setting 'DATABASE_URL'".
# Default to the embedded libSQL backend unless the operator injected Postgres
# (DATABASE_URL) or a backend of their own.
if [ -z "${DATABASE_URL:-}" ] && [ -z "${DATABASE_BACKEND:-}" ]; then
  export DATABASE_BACKEND="libsql"
  export LIBSQL_PATH="${LIBSQL_PATH:-${IRONCLAW_BASE_DIR}/ironclaw.db}"
  log "no DATABASE_URL/BACKEND injected — using embedded libSQL at ${LIBSQL_PATH}"
fi

# Fresh-agent detection (no DB yet) so first-boot defaults (the model pin below)
# never clobber a user's later, persisted choice on restart. Computed BEFORE any
# `ironclaw config set` (which creates the DB). Only the embedded libSQL case is
# file-checkable; a Postgres deployment is treated as not-fresh (configure the
# model explicitly there).
FRESH_BOOT=0
if [ "${DATABASE_BACKEND:-}" = "libsql" ] && [ ! -f "${LIBSQL_PATH:-}" ]; then
  FRESH_BOOT=1
fi

# Best-effort config set: an exact-key mismatch must not abort boot (the boot
# loop still comes up; the value just isn't applied). These are the incantations
# to refine during boot-green validation against the pinned IronClaw build.
cfg() {
  if ! ironclaw config set "$1" "$2" >/dev/null 2>&1; then
    log "warn: 'ironclaw config set $1 …' failed (continuing)"
  fi
}

# --- 1. Secret-store master key ----------------------------------------------
# IronClaw reads SECRETS_MASTER_KEY from the env before trying the (absent) OS
# keychain. If Reef didn't inject one, let IronClaw auto-generate + persist it on
# first use — fine on a fresh agent (no pre-existing encrypted data to orphan).
if [ -n "${SECRETS_MASTER_KEY:-}" ]; then
  log "using injected SECRETS_MASTER_KEY"
else
  log "no SECRETS_MASTER_KEY injected — IronClaw will generate + persist one"
fi

# --- 2. Provider / model ------------------------------------------------------
# Provider values ride the env (ANTHROPIC_API_KEY / OPENAI_API_KEY /
# GEMINI_API_KEY / NEARAI_API_KEY / OPENROUTER_API_KEY / OLLAMA_BASE_URL — the
# same fields the clawbits "Add agent" dialog forwards, or Reef's own REEF_*
# values, REEF.md §14). IronClaw defaults to the `nearai` backend, so derive +
# pin the backend from whichever value is present (registry preference order;
# Anthropic wins when several are) unless one was set explicitly — otherwise an
# injected value is silently ignored for nearai. Reef's IronClaw profile
# pre-pins LLM_BACKEND whenever it injects a provider, so this chain is the
# fallback for detached / hand-wired boots. (ollama needs no key:
# LLM_BACKEND=ollama + OLLAMA_BASE_URL is the whole setup; gemini reads
# GEMINI_API_KEY; nearai reads NEARAI_API_KEY, base URL auto-defaults to
# cloud-api.near.ai when a key is present; openrouter reads OPENROUTER_API_KEY,
# base URL built into its dedicated client — all verified against the pinned
# IronClaw build.)
if [ -z "${LLM_BACKEND:-}" ]; then
  if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
    LLM_BACKEND="anthropic"
  elif [ -n "${OPENAI_API_KEY:-}" ]; then
    LLM_BACKEND="openai"
  elif [ -n "${GEMINI_API_KEY:-}" ]; then
    LLM_BACKEND="gemini"
  elif [ -n "${NEARAI_API_KEY:-}" ]; then
    LLM_BACKEND="nearai"
  elif [ -n "${OPENROUTER_API_KEY:-}" ]; then
    LLM_BACKEND="openrouter"
  elif [ -n "${OLLAMA_BASE_URL:-}" ]; then
    LLM_BACKEND="ollama"
  fi
fi
if [ -n "${LLM_BACKEND:-}" ]; then
  export LLM_BACKEND
  cfg llm_backend "\"${LLM_BACKEND}\""
fi

# Default model, mirroring the OpenClaw entrypoint (reef/images/openclaw-runtime):
# Reef injects only the provider key, never a model, so an OpenAI-only agent has a
# backend but no model. On first boot, pin a known-good OpenAI model so the key
# resolves; REEF_DEFAULT_MODEL (any provider) and OPENAI_MODEL (native, read by
# IronClaw) override. Gated on FRESH_BOOT so a user's later, persisted choice is
# never clobbered.
if [ "${FRESH_BOOT}" = "1" ] && [ -z "${OPENAI_MODEL:-}" ]; then
  reef_model="${REEF_DEFAULT_MODEL:-}"
  # IronClaw's selected_model is a BARE id — strip an openclaw-style
  # provider/ prefix so one REEF_DEFAULT_MODEL value serves both runtimes.
  # nearai and openrouter are the exceptions: their bare ids are org/model
  # paths whose FIRST segment can collide with a real provider (NEAR hosts
  # openai/gpt-oss-120b; OpenRouter's slugs are vendor/model like
  # openai/gpt-5.4) — on those backends the full path IS the model id, so only
  # an explicit nearai//openrouter/ qualifier is stripped and the rest passes
  # through untouched (zai-org/GLM-5.1-FP8 matches no pattern anyway).
  case "${reef_model}" in
    nearai/*) reef_model="${reef_model#nearai/}" ;;
    openrouter/*)
      # Strip the qualifier ONLY when a vendor path remains: openrouter/auto
      # is itself a complete slug (vendor "openrouter") and must survive.
      _rest="${reef_model#openrouter/}"
      case "${_rest}" in */*) reef_model="${_rest}" ;; esac
      ;;
    anthropic/* | openai/* | google/* | gemini/* | ollama/*)
      [ "${LLM_BACKEND:-}" = "nearai" ] || [ "${LLM_BACKEND:-}" = "openrouter" ] \
        || reef_model="${reef_model#*/}"
      ;;
  esac
  if [ -z "${reef_model}" ] && [ "${LLM_BACKEND:-}" = "openai" ]; then
    reef_model="gpt-5-mini"
  fi
  if [ -z "${reef_model}" ] && [ "${LLM_BACKEND:-}" = "openrouter" ]; then
    # FREE catalog model (the pickers' curated default), not the client's paid
    # default_model — a fresh BYO-key agent shouldn't spend until its owner
    # chooses. Bare slug: IronClaw takes OpenRouter ids raw, no prefix.
    #
    # Verified live on 2026-09-03: the previous `nvidia/nemotron-nano-9b-v2:free`
    # was withdrawn from OpenRouter and 404s with "No endpoints found". Free-tier
    # slugs rotate — re-check https://openrouter.ai/api/v1/models before editing.
    reef_model="nvidia/nemotron-3.5-lightning:free"
  fi
  if [ -n "${reef_model}" ]; then
    log "fresh boot, no model configured — pinning default model ${reef_model}"
    cfg selected_model "\"${reef_model}\""
  fi
fi

# --- 3. clawbits channel wiring ----------------------------------------------
# The channel files are baked at ${CHANNELS_DIR}. Activate + wire only when we
# have a usable API key; otherwise leave it inactive (detached), so the channel
# never comes up unauthenticated (which would just 401 every poll).
endpoint="${CLAWBITS_ENDPOINT:-https://app.clawbits.ai}"
host="${endpoint#*://}"; host="${host%%/*}"; host="${host%%:*}"

# Insecure-http opt-in. IronClaw's WASM HTTP gate requires https AND rejects
# private/internal IPs (SSRF guard). When the endpoint is a LOCAL clawbits over
# plaintext http (local dev), name that host in IronClaw's insecure-http
# allowlist (IRONCLAW_ALLOW_INSECURE_HTTP_HOSTS) — this relaxes both gates for
# THAT host only. Covered: loopback, the microVM host-gateway aliases
# (host.microsandbox.internal / host.docker.internal → *.internal), *.local, and
# RFC1918 literals. A plaintext http endpoint on a PUBLIC host is refused (use
# https) so we never send agent creds in the clear over the network. Default is
# no exemption, so prod (https://app.clawbits.ai) stays strict.
if [ "${endpoint%%://*}" = "http" ]; then
  case "${host}" in
    localhost|127.*|::1|*.internal|*.local|10.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*)
      export IRONCLAW_ALLOW_INSECURE_HTTP_HOSTS="${host}"
      log "local http endpoint (${host}) — allowing plaintext http to this host only (IRONCLAW_ALLOW_INSECURE_HTTP_HOSTS)"
      ;;
    *)
      log "WARNING: CLAWBITS_ENDPOINT is plaintext http on a non-local host (${host}); IronClaw requires https for non-local hosts, so the channel will be rejected. Use https (or a local/host-gateway address)."
      ;;
  esac
fi

wire_clawbits_capabilities() {
  # Rewrite the baked capabilities so its endpoint/allowlist/credential host match
  # the injected endpoint. Shell-only (no jq/python in the base image): the shape
  # is fixed and small. channel_id (single-channel watch) is set when provided.
  local channel_line=""
  if [ -n "${CLAWBITS_CHANNEL_ID:-}" ]; then
    channel_line="\"channel_id\": \"${CLAWBITS_CHANNEL_ID}\","
  else
    channel_line="\"channel_id\": null,"
  fi
  cat > "${CAP_FILE}" <<JSON
{
  "version": "0.1.0",
  "wit_version": "0.3.0",
  "type": "channel",
  "name": "clawbits",
  "description": "Clawbits agentic messaging channel",
  "setup": {
    "required_secrets": [
      { "name": "clawbits_api_key", "prompt": "Clawbits agent API key", "optional": false }
    ],
    "setup_url": "${endpoint}"
  },
  "capabilities": {
    "http": {
      "allowlist": [ { "host": "${host}", "path_prefix": "/api/agentic" } ],
      "credentials": {
        "clawbits_api": {
          "secret_name": "clawbits_api_key",
          "location": { "type": "bearer" },
          "host_patterns": [ "${host}" ]
        }
      },
      "max_response_bytes": 10485760,
      "rate_limit": { "requests_per_minute": 120, "requests_per_hour": 4000 }
    },
    "secrets": { "allowed_names": [ "clawbits_*" ] },
    "channel": {
      "allow_polling": true,
      "min_poll_interval_ms": 30000,
      "workspace_prefix": "channels/clawbits/",
      "emit_rate_limit": { "messages_per_minute": 100, "messages_per_hour": 5000 }
    }
  },
  "config": {
    "endpoint": "${endpoint}",
    "agent_id": ${CLAWBITS_AGENT_ID:+\"${CLAWBITS_AGENT_ID}\"},
    "org_id": ${CLAWBITS_ORG_ID:+\"${CLAWBITS_ORG_ID}\"},
    ${channel_line}
    "allow_from": [],
    "poll_interval_ms": 30000
  }
}
JSON
  # ${VAR:+...} above leaves a bare value when the var is unset; normalize those
  # two optional fields to JSON null.
  sed -i 's/"agent_id": ,/"agent_id": null,/; s/"org_id": ,/"org_id": null,/' "${CAP_FILE}"
}

reef_clawbits_signup() {
  # Exchange a one-time signup token (CLAWBITS_SIGNUP_TOKEN, the admin-UI
  # "connect to Clawbits" path) for a minted agent key, mirroring the OpenClaw
  # image's `openclaw clawbits signup`. IronClaw has no native signup command, so
  # we run the same challenge/known-answers helper the channel installer uses
  # (onboarding_message.py --signup-only), baked at ${SIGNUP_DIR}. On success it
  # exports CLAWBITS_API_KEY/CLAWBITS_AGENT_ID for the wire + activate step below.
  command -v python3 >/dev/null 2>&1 || { log "python3 missing — cannot run signup"; return 1; }
  [ -f "${SIGNUP_DIR}/onboarding_message.py" ] || { log "signup helper absent at ${SIGNUP_DIR}"; return 1; }

  local -a cmd=(python3 "${SIGNUP_DIR}/onboarding_message.py" --signup-only
    --answers-file "${SIGNUP_DIR}/known_answers.rs"
    --endpoint "${endpoint}"
    --org-id "${CLAWBITS_ORG_ID}"
    --signup-token "${CLAWBITS_SIGNUP_TOKEN}")
  # Cap a slow/unreachable endpoint so boot can't hang forever (default 120s;
  # REEF_CLAWBITS_SIGNUP_TIMEOUT=0 disables). On timeout we boot detached.
  local timeout="${REEF_CLAWBITS_SIGNUP_TIMEOUT:-120}"
  if [ "${timeout}" != "0" ] && command -v timeout >/dev/null 2>&1; then
    cmd=(timeout "${timeout}" "${cmd[@]}")
  fi

  # The helper prints ONE compact JSON line to stdout ({"api_key":…,"agent_id":…})
  # and all diagnostics to stderr. Capture stdout; let stderr flow to the container
  # log for debuggability (it never carries the key in --signup-only mode). NEVER
  # echo the JSON itself — reef reads container logs host-side, so printing it would
  # leak the minted agent key (the "reef can't read agent secrets" invariant).
  local json
  json="$("${cmd[@]}")" || { log "clawbits signup failed (see stderr above)"; return 1; }

  local key aid
  key="$(printf '%s' "${json}" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("api_key",""))' 2>/dev/null)"
  aid="$(printf '%s' "${json}" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("agent_id",""))' 2>/dev/null)"
  [ -n "${key}" ] || { log "clawbits signup returned no api_key"; return 1; }

  export CLAWBITS_API_KEY="${key}"
  [ -n "${aid}" ] && export CLAWBITS_AGENT_ID="${aid}"
  log "clawbits signup completed${aid:+ (agent ${aid})}"
  return 0
}

reef_clawbits_greeting() {
  # Post the one-time onboarding greeting to the operator DM — the same
  # first-contact message the OpenClaw plugin sends during setup (the signup
  # helper's default mode). Greeting first matters beyond politeness:
  # the channel's first poll anchors its watermark at the newest post without
  # replaying, so an owner who speaks first into a silent agent loses that
  # message. The greeting makes the agent speak first. Deduped via a state file
  # on the durable workspace volume, so restarts never re-greet. Best-effort:
  # a failure must not block boot (the agent is still reachable).
  command -v python3 >/dev/null 2>&1 || { log "python3 missing — skipping onboarding greeting"; return 0; }
  [ -f "${SIGNUP_DIR}/onboarding_message.py" ] || { log "signup helper absent — skipping onboarding greeting"; return 0; }

  local -a cmd=(python3 "${SIGNUP_DIR}/onboarding_message.py"
    --answers-file "${SIGNUP_DIR}/known_answers.rs"
    --endpoint "${endpoint}"
    --state-file "${STATE_DIR}/workspace/.reef-clawbits-greeted")
  local timeout="${REEF_CLAWBITS_GREETING_TIMEOUT:-60}"
  if [ "${timeout}" != "0" ] && command -v timeout >/dev/null 2>&1; then
    cmd=(timeout "${timeout}" "${cmd[@]}")
  fi

  # Greeting mode reads CLAWBITS_API_KEY from the process env and prints only
  # benign diagnostics (never the key) — safe to stream to the container log.
  if "${cmd[@]}" 1>&2; then
    log "clawbits onboarding greeting ensured"
  else
    log "onboarding greeting failed (non-fatal) — agent stays reachable; it simply won't have spoken first"
  fi
  return 0
}

# Token-enroll: with only an org + one-time signup token (the admin-UI "connect
# to Clawbits" path), exchange it for a minted agent key first — on success this
# sets CLAWBITS_API_KEY, so we fall through to the same wire + activate path a
# pre-provisioned (server-minted) key takes.
if [ -z "${CLAWBITS_API_KEY:-}" ] && [ -n "${CLAWBITS_ORG_ID:-}" ] && [ -n "${CLAWBITS_SIGNUP_TOKEN:-}" ]; then
  log "enrolling in org ${CLAWBITS_ORG_ID} via one-time signup token…"
  reef_clawbits_signup || log "signup failed (token invalid, expired, already used, \
or endpoint unreachable — it is single-use and short-lived) — booting DETACHED; \
recreate with a fresh signup token or server-minted CLAWBITS_AGENT_ID/API_KEY."
fi

if [ -n "${CLAWBITS_API_KEY:-}" ]; then
  log "wiring clawbits channel (endpoint=${endpoint}, host=${host})"
  wire_clawbits_capabilities
  cfg channels.wasm_channels_enabled "true"
  cfg channels.wasm_channels '["clawbits"]'
  cfg activated_channels '["clawbits"]'
  # The channel authenticates from the CLAWBITS_API_KEY env var (its .env
  # fallback); it's already exported in this process env, inherited by the exec.
  reef_clawbits_greeting
else
  log "no clawbits credentials — booting with the channel inactive (detached)"
  cfg activated_channels '[]'
fi

# --- 4. status telemetry ------------------------------------------------------
# Secret-free status.json (schema + versions) at boot and on an interval. Reef
# reads it host-side (reef/status.py); never execs in the guest.
write_status() {
  local iron_ver chan_ver ts
  iron_ver="$(ironclaw --version 2>/dev/null | head -1 || echo unknown)"
  iron_ver="${iron_ver##* }"  # "ironclaw 0.3.1" -> "0.3.1" (last field == build.sh awk '{print $NF}')
  chan_ver="${CLAWBITS_CHANNEL_VERSION:-unknown}"
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  cat > "${STATUS_DIR}/status.json" <<JSON
{"schema":1,"timestamp":"${ts}","versions":{"image":"${REEF_IMAGE_VERSION:-dev}","ironclaw":"${iron_ver}","clawbitsChannel":"${chan_ver}"}}
JSON
}
write_status || log "warn: initial status write failed"
interval="${REEF_STATUS_INTERVAL:-300}"
if [ "${interval}" != "0" ]; then
  ( while sleep "${interval}"; do write_status || true; done ) &
fi

# --- 5. scoped web terminal (optional) ---------------------------------------
if [ "${REEF_TERMINAL_ENABLE:-}" = "1" ] && [ -n "${REEF_TERMINAL_PASSWORD:-}" ]; then
  term_port="${REEF_TERMINAL_PORT:-7681}"
  log "starting scoped ironclaw web terminal on :${term_port}"
  ttyd --port "${term_port}" --interface 0.0.0.0 \
       --credential "reef:${REEF_TERMINAL_PASSWORD}" \
       /usr/local/bin/reef-term.sh &
fi

# --- 6. foreground gateway ----------------------------------------------------
# --no-onboard: skip the interactive wizard; config was seeded above. The gateway
# (GATEWAY_ENABLED/HOST/PORT/AUTH_TOKEN from env) is the liveness process.
log "starting ironclaw headless (no TUI/REPL via config.toml, gateway_enabled=${GATEWAY_ENABLED}, port=${GATEWAY_PORT})"
exec ironclaw run --no-onboard
