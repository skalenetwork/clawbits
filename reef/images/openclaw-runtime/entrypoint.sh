#!/bin/sh
# Reef entrypoint for the OpenClaw agent runtime.
#
# Validated on microsandbox (M1 Pro, OpenClaw 2026.5.28): a microVM has no
# systemd, so `openclaw gateway` (the service path) fails — instead we onboard
# headlessly and run the gateway in the FOREGROUND. No daemon.
#
# Per-agent config is injected as env by Reef (see reef.profiles.OpenClawProfile):
#   OPENCLAW_GATEWAY_TOKEN  (optional)  ANTHROPIC_API_KEY (optional)
#   OPENAI_API_KEY (optional — the gateway reads it natively for OpenAI models)
#   NEARAI_API_KEY (optional — wired as a custom OpenAI-compatible provider below)
#   OPENROUTER_API_KEY (optional — native auth-choice for the bundled plugin below)
#   CLAWBITS_ENDPOINT / CLAWBITS_ORG_ID / CLAWBITS_SIGNUP_TOKEN /
#   CLAWBITS_AGENT_ID / CLAWBITS_API_KEY / CLAWBITS_CHANNEL_ID  (clawbits channel)
set -eu

# microsandbox's `--init` handoff runs as root and does not apply the OCI USER.
# Drop back to the image user before OpenClaw touches ~/.openclaw; otherwise root
# creates /root or /.openclaw state, plugin CLI discovery breaks, and restarts can
# fail validation. Docker already starts as node, so this is a no-op there.
if [ "$(id -u)" = "0" ]; then
  export HOME=/home/node USER=node LOGNAME=node
  exec setpriv --reuid node --regid node --init-groups "$0" "$@"
fi

# KEEP IN SYNC with reef/fleet.py: the case arms below mirror _GUEST_DROPPED_ENV_PREFIXES / _GUEST_DROPPED_ENV_KEYS / _DANGEROUS_ENV_KEYS.
reef_apply_env_file() {
  _f="${REEF_ENV_DIR:-}/env"
  [ -n "${REEF_ENV_DIR:-}" ] && [ -r "${_f}" ] || return 0
  while IFS=' ' read -r _op _k _v || [ -n "${_op:-}" ]; do
    case "${_op}" in s | u) ;; *) continue ;; esac
    case "${_k}" in
      "" | [0-9]*) continue ;;
      *[!A-Za-z0-9_]*) continue ;;
      REEF_* | CLAWBITS_* | OPENCLAW_GATEWAY_* | OPENCLAW_PUBLIC_URL) continue ;;
      GATEWAY_* | HERMES_* | IRONCLAW_* | SECRETS_MASTER_KEY) continue ;;
      PATH | HOME | SHELL | USER | LOGNAME | IFS) continue ;;
      LD_PRELOAD | LD_LIBRARY_PATH | LD_AUDIT) continue ;;
      NODE_OPTIONS | NODE_PATH) continue ;;
      PYTHONPATH | PYTHONHOME | PYTHONSTARTUP) continue ;;
      PERL5LIB | PERLLIB | PERL5OPT) continue ;;
      BASH_ENV | ENV | SHELLOPTS | BASHOPTS) continue ;;
      GIT_SSH_COMMAND | GIT_SSH | GIT_EXEC_PATH | GIT_EXTERNAL_DIFF) continue ;;
      GIT_PROXY_COMMAND | GIT_TEMPLATE_DIR) continue ;;
      GIT_CONFIG_GLOBAL | GIT_CONFIG_SYSTEM | GIT_CONFIG_COUNT) continue ;;
      NODE_EXTRA_CA_CERTS | NODE_TLS_REJECT_UNAUTHORIZED) continue ;;
      SSL_CERT_FILE | SSL_CERT_DIR | CURL_CA_BUNDLE | REQUESTS_CA_BUNDLE) continue ;;
      GIT_SSL_CAINFO | GIT_SSL_NO_VERIFY) continue ;;
    esac
    if [ "${_op}" = "u" ]; then
      unset "${_k}" 2>/dev/null || true
      continue
    fi
    _dv=$(printf %s "${_v}" | base64 -d 2>/dev/null) || continue
    export "${_k}=${_dv}"
  done < "${_f}"
  unset _f _op _k _v _dv
  return 0
}
reef_apply_env_file

# The gateway needs an auth token for its loopback control plane. Reef's model
# is outbound-only — nothing connects IN — so when Reef hasn't pinned one,
# generate an ephemeral token instead of refusing to boot.
if [ -z "${OPENCLAW_GATEWAY_TOKEN:-}" ]; then
  OPENCLAW_GATEWAY_TOKEN="$(od -An -tx1 -N24 /dev/urandom | tr -d ' \n')"
fi

# OpenClaw state (config + device identity + sessions + workspace) lives in the
# image user's home (~/.openclaw) by default — writable by the non-root user.
# Reef can override OPENCLAW_STATE_DIR to a mounted per-agent volume for
# persistence across restarts (the volume must be writable by this user).
[ -n "${OPENCLAW_STATE_DIR:-}" ] && export OPENCLAW_STATE_DIR

# Onboard once per agent. Gate on whether the gateway is configured
# (gateway.mode) — NOT on openclaw.json existing: the build-time
# `plugins install` bakes a stub openclaw.json (plugin registration only, no
# gateway.mode), which would trick a file-existence check into skipping
# onboarding and leave the gateway refusing to start ("missing gateway.mode").
# On a restart with persisted config, gateway.mode is already "local" → skip
# straight to running the gateway.
#
# --skip-health: don't wait for a running gateway during setup; we start it
# ourselves right after (otherwise onboard's health probe fails and `set -e`
# aborts before the gateway ever launches).
reef_onboard() {
  openclaw onboard --non-interactive --accept-risk --flow quickstart --skip-health \
    --gateway-auth token --gateway-token "${OPENCLAW_GATEWAY_TOKEN}" "$@"
}

# Provider auth-choice, in reef's registry preference order (reef.providers).
# Normally exactly ONE provider is injected — the create picker narrows the
# forwarding. OpenAI needs no auth-choice (the gateway reads OPENAI_API_KEY
# natively; its model is pinned below).
did_onboard=""
if [ "$(openclaw config get gateway.mode 2>/dev/null)" != "local" ]; then
  did_onboard=1
  if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
    reef_onboard --auth-choice anthropic-api-key --anthropic-api-key "${ANTHROPIC_API_KEY}"
  elif [ -n "${GEMINI_API_KEY:-}" ]; then
    # Native env var (GEMINI_API_KEY); the choice also pins Google's default
    # model, which a create-time REEF_DEFAULT_MODEL overrides below.
    reef_onboard --auth-choice gemini-api-key --gemini-api-key "${GEMINI_API_KEY}"
  elif [ -n "${NEARAI_API_KEY:-}" ]; then
    # NEAR Cloud AI (OpenAI-compatible chat completions at cloud-api.near.ai).
    # OpenClaw has no built-in nearai provider; --auth-choice custom-api-key
    # writes models.providers.nearai (baseUrl + the ONE declared model, api
    # "openai-completions") and sets agents.defaults.model.primary =
    # nearai/<model>. The custom onboard REQUIRES a model id: use the
    # create-time pick (stripping an explicit nearai/ prefix — the flag wants
    # the provider-bare id, which for NEAR is the full HF path like
    # zai-org/GLM-5.1-FP8), else the known-good default. Pure config write —
    # no server probe, so no ollama-style unreachable fallback is needed.
    _near_model="${REEF_DEFAULT_MODEL:-}"
    _near_model="${_near_model#nearai/}"
    [ -n "${_near_model}" ] || _near_model="zai-org/GLM-5.1-FP8"
    reef_onboard --auth-choice custom-api-key \
      --custom-provider-id nearai \
      --custom-base-url "https://cloud-api.near.ai/v1" \
      --custom-model-id "${_near_model}" \
      --custom-api-key "${NEARAI_API_KEY}" \
      --custom-compatibility openai
  elif [ -n "${OPENROUTER_API_KEY:-}" ]; then
    # OpenClaw bundles an openrouter provider plugin (enabled by default), so
    # the native auth-choice writes the key — no custom-api-key onboard needed.
    # The plugin's own no-model default is openrouter/auto (paid routing); the
    # model block below overrides that with a FREE catalog model, and a
    # create-time REEF_DEFAULT_MODEL is qualified to openrouter/<vendor>/<model>.
    reef_onboard --auth-choice openrouter-api-key --openrouter-api-key "${OPENROUTER_API_KEY}"
  elif [ -n "${OLLAMA_HOST:-}" ]; then
    # OpenClaw has no OLLAMA_HOST env support — `--auth-choice ollama` is the
    # documented non-interactive path: it probes the server (/api/tags), pulls
    # the model if absent, writes models.providers.ollama, and sets
    # agents.defaults.model.primary=ollama/<model>. The probe HARD-FAILS when
    # the server is unreachable, so fall back to a detached onboard rather
    # than refusing to boot — the owner can finish setup in the web terminal.
    _oll_model="${REEF_DEFAULT_MODEL:-}"
    _oll_model="${_oll_model#ollama/}" # --custom-model-id wants the bare id
    if [ -n "${_oll_model}" ]; then
      set -- --auth-choice ollama --custom-base-url "${OLLAMA_HOST}" \
        --custom-model-id "${_oll_model}"
    else
      set -- --auth-choice ollama --custom-base-url "${OLLAMA_HOST}"
    fi
    if ! reef_onboard "$@"; then
      echo "reef-entrypoint: WARNING ollama onboarding failed (server unreachable at ${OLLAMA_HOST}?) — booting without a configured model; finish setup via the web terminal." >&2
      reef_onboard --auth-choice skip
    fi
  else
    reef_onboard --auth-choice skip
  fi
fi

# `plugins.allow` is an EXCLUSIVE allowlist: setting one disables every bundled
# plugin not listed. Never set it; unset it so agents carrying an old value recover.
openclaw config unset plugins.allow >/dev/null 2>&1 || true

# The image carries the slim channel plus the companion. The companion must own
# cron reconciliation, email polling, usage reporting, and skills sync. Write this
# every boot so upgraded pre-split agents cannot retain legacy channel ownership.
openclaw config set channels.clawbits.serviceOwner tools

# ChatGPT-subscription agents run through the bundled Codex harness (plugin id
# `codex`), which ships DISABLED regardless of any allowlist. Enabling the entry is
# what actually turns it on — otherwise agentRuntime.id=codex (pinned below) fails
# at run time with "Requested agent harness 'codex' is not registered".
if [ "${REEF_OPENAI_AUTH:-}" = "subscription" ]; then
  openclaw config set plugins.entries.codex.enabled true --json
fi

# --- Opt-in capabilities (REEF_CAPS, see reef/capabilities.py) --------------
# Comma-separated grant list from reef; ALWAYS set by a capabilities-aware reef,
# so an unset var means "old reef" and an empty one means "granted nothing".
# Every branch writes BOTH the on and off case, because this config is persisted
# in ~/.openclaw: a revoke has to actively turn the feature off, not merely stop
# turning it on. Defined here because the tool policy below depends on it.
reef_has_cap() {
  case ",${REEF_CAPS:-}," in *",$1,"*) return 0 ;; *) return 1 ;; esac
}

# Tool policy. `openclaw onboard` writes tools.profile="coding", which does NOT
# include `browser`, `cron`, or the companion's optional tools. alsoAllow MERGES
# on top of the profile; plain `allow` would REPLACE it and silently drop
# everything else. All seven clawbits tools are first-party Reef functionality and
# are explicitly enabled because OpenClaw does not auto-allow optional plugin
# tools. Deliberately NOT using tools.profile="full": it silently includes the
# unrestricted group:messaging tool family.
#
# The built-in `cron` tool is added only for agents granted the capability: it lets
# the agent schedule its own recurring work. Rewritten in full every boot (not
# appended) so a revoke removes it while the clawbits tools remain available.
if reef_has_cap cron; then
  openclaw config set tools.alsoAllow '["browser","cron","clawbits_channels_list","clawbits_channel_members","clawbits_email_inbox","clawbits_email_get","clawbits_agent_info","clawbits_email_send","clawbits_agent_description_update"]' --json
else
  openclaw config set tools.alsoAllow '["browser","clawbits_channels_list","clawbits_channel_members","clawbits_email_inbox","clawbits_email_get","clawbits_agent_info","clawbits_email_send","clawbits_agent_description_update"]' --json
fi

# Exec posture. These are already OpenClaw's effective defaults (verified in-image:
# `openclaw exec-policy show` reports security=full, ask=off), so this changes
# nothing today — it PINS the posture so a future OpenClaw release cannot silently
# tighten or loosen it underneath us. `exec-policy preset` writes BOTH layers that
# gate exec (the config file AND the host approvals store); setting only one is the
# usual failure mode. Not a security control: exec runs unattended by design here,
# and tools.fs.workspaceOnly defaults false, so the agent can rewrite this config
# itself. The microVM is the boundary, not this line.
openclaw exec-policy preset yolo >/dev/null 2>&1 \
  || echo "reef-entrypoint: WARNING could not pin exec policy (continuing on OpenClaw defaults)" >&2

# Browser automation. The image ships Chromium only in the `-browser` base variant
# (Dockerfile OPENCLAW_IMAGE_VARIANT), so probe rather than assume: a slim build
# must not advertise a browser it cannot launch. `noSandbox` is REQUIRED, not
# optional — verified in-image that headless Chromium fails to start without it
# (no user namespaces for the Chromium sandbox in this container/microVM). That
# trade is acceptable because the microVM, not the renderer sandbox, is the
# boundary here.
reef_chrome=""
for _c in chromium chromium-browser google-chrome google-chrome-stable; do
  if command -v "${_c}" >/dev/null 2>&1; then reef_chrome="$(command -v "${_c}")"; break; fi
done
if [ -z "${reef_chrome}" ]; then
  # The official `-browser` variant does NOT put chromium on PATH — it ships
  # Playwright's managed cache (verified: ~/.cache/ms-playwright/chromium-<build>/
  # chrome-linux/chrome). Resolve it explicitly rather than relying on OpenClaw's
  # auto-discovery, so a Playwright layout change shows up here as "no chromium"
  # instead of silently leaving the tool unable to launch. The `chromium-*` glob
  # deliberately does not match the sibling `chromium_headless_shell-*` dir.
  reef_chrome="$(ls -d "${HOME}"/.cache/ms-playwright/chromium-*/chrome-linux*/chrome 2>/dev/null | head -1)"
fi
if [ -n "${reef_chrome}" ]; then
  openclaw config set browser.enabled true --json
  openclaw config set browser.headless true --json
  openclaw config set browser.noSandbox true --json
  openclaw config set browser.executablePath "${reef_chrome}"
  echo "reef-entrypoint: browser automation enabled (${reef_chrome})" >&2
else
  echo "reef-entrypoint: no chromium in this image — browser automation left disabled (build with OPENCLAW_IMAGE_VARIANT=-browser to enable)." >&2
fi

# --- Capability side-effects (the tool policy above handles `cron`'s tool) ---
# These are the capabilities whose blast radius LEAVES the microVM. Anything the
# VM contains (shell, package installs, the browser) is not gated — see
# reef/capabilities.py for why.

# gh: the GitHub CLI is staged at /opt/reef/gh-bin (off PATH). Link it in only
# when granted. NB the binary remains reachable by absolute path — this is
# ergonomics, and the real gate is that reef injects no GitHub token.
if reef_has_cap gh; then
  mkdir -p "${HOME}/.local/bin" 2>/dev/null || true
  ln -sf /opt/reef/gh-bin/gh "${HOME}/.local/bin/gh" 2>/dev/null || true
  echo "reef-entrypoint: capability gh — GitHub CLI linked onto PATH (no token injected by reef)" >&2
else
  rm -f "${HOME}/.local/bin/gh" 2>/dev/null || true
fi

# cron: self-scheduled recurring work. Not a privilege escalation (the agent
# already has unrestricted exec) but a PERSISTENCE grant — an injected loop
# outlives the conversation — so it is opt-in and revocable. Two halves: the
# `cron` TOOL (tool policy above, so the model can create schedules) and
# `cron.enabled` here (so the gateway actually RUNS stored schedules). Gating only
# one would leave a half-working feature: jobs that can be created but never fire,
# or jobs that keep firing after a revoke.
#
# NB the key is `cron.enabled`. There is no `cron.triggers.*` in the config schema
# — writing one fails validation and takes the whole gateway down on boot.
if reef_has_cap cron; then
  openclaw config set cron.enabled true --json
  echo "reef-entrypoint: capability cron — scheduling enabled (tool + execution)" >&2
else
  openclaw config set cron.enabled false --json
fi

# Git identity. Without one `git commit` hard-fails with "Author identity unknown",
# which silently breaks any skill that commits. Per-agent (not a shared constant) so
# commits stay attributable to the agent that made them. Only set when absent, so an
# owner who configures their own identity in the terminal is never clobbered.
if ! git config --global user.email >/dev/null 2>&1; then
  git config --global user.email "${CLAWBITS_AGENT_ID:-agent}@agents.clawbits.ai"
  git config --global user.name "${CLAWBITS_AGENT_ID:-reef-agent}"
  git config --global init.defaultBranch main
fi

# Default model. A create-time model pick rides in as REEF_DEFAULT_MODEL (a
# bare id — fully qualified below — or a provider/model id). With nothing
# configured, OpenClaw falls back to its built-in default (currently
# `openai/gpt-5.5`, which can hit "Unknown model" when the runtime model catalog
# lags that bleeding-edge default). So when the agent is
# OpenAI-only and no model is configured yet, pin a known-good multimodal model.
# Gate: a fresh onboard always applies REEF_DEFAULT_MODEL (gemini/ollama
# onboarding auto-sets a primary, which must not shadow the user's explicit
# create-time pick); restarts only pin when NO primary is set, so a user's
# later Control-UI choice (persisted across restarts) is never clobbered.
# Anthropic is left on OpenClaw's own default (it resolves; out of scope here).
if [ -n "${did_onboard}" ] || ! openclaw config get agents.defaults.model.primary >/dev/null 2>&1; then
  reef_model="${REEF_DEFAULT_MODEL:-}"
  reef_runtime=""
  # "OpenAI-only" means an API key OR a ChatGPT SUBSCRIPTION. The subscription
  # path deliberately injects no key (reef never handles the OAuth token — see
  # providers.py KIND_OAUTH), so gating this on OPENAI_API_KEY alone left every
  # subscription agent with reef_model empty. That skipped this whole block,
  # which is also where agentRuntime.id=codex is pinned — so the agent booted
  # with NO default model and NO Codex harness, and generated no replies. The
  # create wizard offers no model on this path either (OptionsStep: "no key or
  # model to configure here"), so REEF_DEFAULT_MODEL is always empty here and
  # this fallback is the only thing that can set one.
  #
  # gpt-5.4, NOT the provider's own recommendation: `models auth login
  # --set-default` applies openai/gpt-5.5, whose session-mirror hook crashes on
  # the pinned OpenClaw runtime and breaks every message after the first. That
  # is why the model pickers omit 5.5, and why the post-boot login command must
  # stay WITHOUT --set-default.
  if [ -z "${reef_model}" ] \
    && { [ -n "${OPENAI_API_KEY:-}" ] || [ "${REEF_OPENAI_AUTH:-}" = "subscription" ]; } \
    && [ -z "${ANTHROPIC_API_KEY:-}" ] \
    && [ -z "${GEMINI_API_KEY:-}" ] && [ -z "${OLLAMA_HOST:-}" ]; then
    reef_model="openai/gpt-5.4"
  fi
  # Fully-qualify a bare model id with its provider (`openclaw models set`
  # wants provider/model; the create-time field carries the bare id). The
  # single injected provider names the prefix; a provider/model id passes
  # through untouched (power-user escape hatch).
  #
  # nearai is special-cased FIRST: NEAR's bare model ids are HF-style
  # org/model paths (zai-org/GLM-5.1-FP8), so the generic "contains a slash ⇒
  # already provider-qualified" rule below would misread them (openclaw's
  # model-ref parser splits on the FIRST slash — zai-org would parse as the
  # provider). When the NEAR key is the effective provider (no
  # higher-preference key present), anything not already nearai/-prefixed
  # gets the prefix — including NEAR-hosted ids whose first segment collides
  # with a real provider (openai/gpt-oss-120b → nearai/openai/gpt-oss-120b).
  if [ -n "${NEARAI_API_KEY:-}" ] && [ -z "${ANTHROPIC_API_KEY:-}" ] \
    && [ -z "${OPENAI_API_KEY:-}" ] && [ -z "${GEMINI_API_KEY:-}" ]; then
    case "${reef_model}" in
      "" | nearai/*) ;;
      *) reef_model="nearai/${reef_model}" ;;
    esac
  elif [ -n "${OPENROUTER_API_KEY:-}" ] && [ -z "${ANTHROPIC_API_KEY:-}" ] \
    && [ -z "${OPENAI_API_KEY:-}" ] && [ -z "${GEMINI_API_KEY:-}" ] \
    && [ -z "${NEARAI_API_KEY:-}" ]; then
    # Same slash hazard as nearai: OpenRouter model ids are vendor/model slugs
    # (openai/gpt-5.4, moonshotai/kimi-k2), so the generic "contains a slash ⇒
    # already provider-qualified" rule would misparse them (the first segment
    # collides with a real provider). When the OpenRouter key is the effective
    # provider, anything not already openrouter/-prefixed gets the prefix —
    # openai/gpt-5.4 → openrouter/openai/gpt-5.4. No pick defaults to a FREE
    # catalog model (the pickers' curated default), NOT the plugin's
    # openrouter/auto paid routing — a fresh BYO-key agent shouldn't spend
    # until its owner chooses a model.
    case "${reef_model}" in
      "") reef_model="openrouter/nvidia/nemotron-nano-9b-v2:free" ;;
      openrouter/*) ;;
      *) reef_model="openrouter/${reef_model}" ;;
    esac
  else
    case "${reef_model}" in
      "" | */*) ;;
      *)
        if [ -n "${ANTHROPIC_API_KEY:-}" ]; then reef_model="anthropic/${reef_model}"
        elif [ -n "${OPENAI_API_KEY:-}" ]; then reef_model="openai/${reef_model}"
        elif [ -n "${GEMINI_API_KEY:-}" ]; then reef_model="google/${reef_model}"
        elif [ -n "${OLLAMA_HOST:-}" ]; then reef_model="ollama/${reef_model}"
        fi
        ;;
    esac
  fi
  # OpenClaw 2026.6.5+ routes openai/* agent turns through the Codex harness by
  # default, even with an API key. Pin the runtime explicitly for ANY effective
  # openai/* model (the auto-default above AND a user-picked model):
  #   • ChatGPT-subscription agents (REEF_OPENAI_AUTH=subscription) → the Codex
  #     harness — that's the whole point, so the owner's OAuth'd ChatGPT plan is
  #     used. The owner completes `openclaw models auth login --provider openai
  #     --device-code` in the scoped terminal after boot.
  #   • Everyone else (API key) → the direct runtime, so Platform quota/billing
  #     errors are not mislabeled as Codex subscription limits.
  # Exact-model scope leaves later model choices alone.
  case "${reef_model}" in
    openai/*)
      if [ "${REEF_OPENAI_AUTH:-}" = "subscription" ]; then
        reef_runtime="codex"
      else
        reef_runtime="openclaw"
      fi
      ;;
  esac
  if [ -n "${reef_model}" ]; then
    echo "reef-entrypoint: no model configured — pinning default model ${reef_model}" >&2
    if openclaw models set "${reef_model}" 1>&2 \
      || openclaw config set agents.defaults.model.primary "${reef_model}" 1>&2; then
      if [ -n "${reef_runtime}" ]; then
        openclaw config set \
          "agents.defaults.models[\"${reef_model}\"].agentRuntime.id" \
          "${reef_runtime}" 1>&2 \
          || echo "reef-entrypoint: WARNING could not set ${reef_model} runtime to ${reef_runtime}" >&2
      fi
    else
      echo "reef-entrypoint: WARNING could not set default model ${reef_model}" >&2
    fi
  fi
fi

# Token-based Clawbits enrollment. The one-time signup token
# (CLAWBITS_SIGNUP_TOKEN, a `human-…` value from the Clawbits "Add agent" prompt)
# enrolls the agent immediately — no approval step. The signup mints tokens,
# resolves the owner channel, and prints `openclaw config set/unset` lines, which
# we eval to persist the minted credentials (exactly the documented manual flow).
# Run this BEFORE the gateway starts: channel accounts are read during gateway
# startup, so a background signup races and can leave the agent idle as
# "not fully configured" until a manual restart.
reef_clawbits_autosignup() {
  # app.clawbits.ai, NOT the apex: clawbits.ai now serves the marketing site, so
  # the old fallback would enroll the agent against a static page (an HTML 200,
  # not a clean connection error — the worst shape of failure). Reef itself
  # always injects CLAWBITS_ENDPOINT (profiles.py), so this fires only for a
  # hand-rolled container; keep every fallback in this file on the same host.
  _ep="${CLAWBITS_ENDPOINT:-https://app.clawbits.ai}"
  echo "reef-clawbits: enrolling in org '${CLAWBITS_ORG_ID}' at ${_ep} with one-time signup token…" >&2
  # This runs synchronously before the gateway boots, so a slow or unreachable
  # endpoint must not hang startup forever. Cap it with `timeout`
  # (REEF_CLAWBITS_SIGNUP_TIMEOUT seconds, default 120; set 0 to disable the cap).
  # On timeout the agent comes up with no channel rather than never coming up.
  set -- openclaw clawbits signup --endpoint "${_ep}" --org-id "${CLAWBITS_ORG_ID}" \
    --signup-token "${CLAWBITS_SIGNUP_TOKEN:-}"
  _signup_timeout="${REEF_CLAWBITS_SIGNUP_TIMEOUT:-120}"
  if [ "${_signup_timeout}" != "0" ] && command -v timeout >/dev/null 2>&1; then
    set -- timeout "${_signup_timeout}" "$@"
  fi
  # The signup prints `openclaw config set …` lines that carry the MINTED SECRETS
  # (apiKey etc.) for us to persist. We eval them, but must NEVER echo the value to
  # the container log (reef reads logs host-side — that would leak the agent key,
  # breaking the "reef can't access agent secrets" invariant). So redact the value
  # of any `config set` line; non-secret lines pass through verbatim.
  "$@" 2>&1 | while IFS= read -r _line; do
    case "${_line}" in
      "openclaw config set "*)
        eval "${_line}" >/dev/null 2>&1 || true
        printf 'reef-clawbits: %s <redacted>\n' "$(printf '%s' "${_line}" | cut -d' ' -f1-4)" >&2 ;;
      "openclaw config unset "*)
        eval "${_line}" >/dev/null 2>&1 || true
        printf 'reef-clawbits: %s\n' "${_line}" >&2 ;;
      *)
        printf 'reef-clawbits: %s\n' "${_line}" >&2 ;;
    esac
  done
  if openclaw config get channels.clawbits.accounts.default.channelId >/dev/null 2>&1; then
    echo "reef-clawbits: channel configured — agent enrolled and wired up." >&2
  else
    echo "reef-clawbits: enrollment failed or timed out (token invalid, expired, already used, or endpoint unreachable — the token is single-use and short-lived). Recreate the agent with a fresh signup token." >&2
  fi
}

# Wire the Clawbits channel. The plugin reads `channels.clawbits.accounts.default.*`
# from the config store (NOT env), so bridge the injected CLAWBITS_* values before
# the gateway loads the plugin. An account is "configured" once agentId, apiKey,
# channelId and orgId are all set (see the plugin's accounts.ts).
acct="channels.clawbits.accounts.default"

# Identity persistence across an IMAGE UPGRADE (destroy+recreate). The channel
# config (incl. the minted apiKey) lives in ~/.openclaw, which the image RESETS on
# a recreate — but the one-time signup token is already spent, so a naive recreate
# can't re-enroll. So mirror the identity onto the per-agent CONFIG volume
# (~/.config/openclaw, a named volume that SURVIVES destroy+recreate) and restore
# from it on recreate instead of re-signing-up. Reef never reads this file (it
# holds the channel secret) — the credential stays inside the guest, on a volume
# reef can't decrypt, honouring the "reef can't access agents" model.
reef_identity_file="${HOME}/.config/openclaw/.reef-clawbits-identity"

reef_persist_clawbits_identity() {
  # Read the clawbits account DIRECTLY FROM the openclaw config file, NOT via
  # `openclaw config get`: config get REDACTS secrets in its output (it returns
  # the literal "__OPENCLAW_REDACTED__" for apiKey), so persisting that output
  # would mirror a FAKE key and the post-upgrade restore would 401 on every
  # clawbits call. The stored file keeps the real value (only the CLI redacts).
  # Couples to openclaw's config layout (channels.clawbits.accounts.default.*) —
  # guarded below so a schema/path change degrades to "don't persist" rather than
  # mirroring garbage.
  _cfg="${OPENCLAW_STATE_DIR:-${HOME}/.openclaw}/openclaw.json"
  [ -f "${_cfg}" ] || return 0
  _vals=$(node -e '
    const fs = require("fs");
    try {
      const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const a = ((((j.channels || {}).clawbits || {}).accounts || {}).default) || {};
      const s = (x) => (typeof x === "string" ? x : "");
      const out = [s(a.endpoint), s(a.orgId), s(a.agentId), s(a.apiKey), s(a.channelId)];
      // Require a COMPLETE identity (org, agentId, apiKey, channelId) and never a
      // redacted apiKey — otherwise leave the last-good mirror untouched.
      if (out.slice(1).some((v) => !v)) process.exit(1);
      if (out.includes("__OPENCLAW_REDACTED__")) process.exit(1);
      process.stdout.write(out.join("\n"));
    } catch (e) { process.exit(1); }
  ' "${_cfg}" 2>/dev/null) || return 0
  [ -n "${_vals}" ] || return 0
  mkdir -p "$(dirname "${reef_identity_file}")" 2>/dev/null || return 0
  # One value per line (none contain newlines): endpoint, orgId, agentId, apiKey, channelId.
  printf '%s\n' "${_vals}" > "${reef_identity_file}" 2>/dev/null || return 0
  chmod 600 "${reef_identity_file}" 2>/dev/null || true
}

reef_restore_clawbits_identity() {
  [ -f "${reef_identity_file}" ] || return 1
  _ep=$(sed -n '1p' "${reef_identity_file}")
  _org=$(sed -n '2p' "${reef_identity_file}")
  _aid=$(sed -n '3p' "${reef_identity_file}")
  _key=$(sed -n '4p' "${reef_identity_file}")
  _ch=$(sed -n '5p' "${reef_identity_file}")
  [ -n "${_aid}" ] && [ -n "${_key}" ] && [ -n "${_ch}" ] && [ -n "${_org}" ] || return 1
  # SECURITY: never take the endpoint from the mirror. This file lives in the
  # agent's own home and is therefore AGENT-WRITABLE, so trusting line 1 let a
  # compromised (e.g. prompt-injected) agent point its clawbits channel at an
  # attacker-controlled host and survive a destroy+recreate — carrying the org's
  # real minted apiKey with it. The endpoint is reef's to declare, so always use
  # the injected value; only the identity fields come from the mirror.
  # (_ep is still read above so the file format stays self-describing.)
  openclaw config set "${acct}.endpoint"  "${CLAWBITS_ENDPOINT:-https://app.clawbits.ai}"
  openclaw config set "${acct}.orgId"     "${_org}"
  openclaw config set "${acct}.agentId"   "${_aid}"
  openclaw config set "${acct}.apiKey"    "${_key}"
  openclaw config set "${acct}.channelId" "${_ch}"
}

# Wire the Clawbits channel. The plugin reads `channels.clawbits.accounts.default.*`
# from the config store (NOT env), so bridge the injected CLAWBITS_* values before
# the gateway loads the plugin. An account is "configured" once agentId, apiKey,
# channelId and orgId are all set (see the plugin's accounts.ts).
if openclaw config get "${acct}.channelId" >/dev/null 2>&1; then
  # Already wired (config persisted across a same-container stop/start) — leave it.
  echo "reef-entrypoint: clawbits channel already configured — skipping signup." >&2
elif [ -n "${CLAWBITS_AGENT_ID:-}" ] && [ -n "${CLAWBITS_API_KEY:-}" ] \
  && [ -n "${CLAWBITS_CHANNEL_ID:-}" ] && [ -n "${CLAWBITS_ORG_ID:-}" ]; then
  # Pre-provisioned: clawbits minted the identity server-side — write the account
  # directly, no signup/approval loop.
  #
  # Checked BEFORE the mirror restore below (it used to come after): reef-injected
  # env is authoritative, the mirror is agent-writable. When both are present they
  # should agree, and if they ever disagree the reef-supplied one must win.
  openclaw config set "${acct}.endpoint"  "${CLAWBITS_ENDPOINT:-https://app.clawbits.ai}"
  openclaw config set "${acct}.orgId"     "${CLAWBITS_ORG_ID}"
  openclaw config set "${acct}.agentId"   "${CLAWBITS_AGENT_ID}"
  openclaw config set "${acct}.apiKey"    "${CLAWBITS_API_KEY}"
  openclaw config set "${acct}.channelId" "${CLAWBITS_CHANNEL_ID}"
elif reef_restore_clawbits_identity; then
  # Recreate (image upgrade) of a SIGNUP-TOKEN agent: ~/.openclaw was reset, the
  # one-time token is spent, and reef holds no identity env to replay — so the
  # persistent config volume's mirror is the only way back. Restore it, NO
  # re-signup. (Endpoint is taken from reef's env, not the mirror; see above.)
  echo "reef-entrypoint: restored clawbits identity from the persistent config volume (post-upgrade recreate — no re-signup needed)." >&2
elif [ -n "${CLAWBITS_ORG_ID:-}" ] && [ -n "${CLAWBITS_SIGNUP_TOKEN:-}" ]; then
  # Org + one-time signup token (the admin-UI "connect to Clawbits" path): seed
  # the endpoint + org as signup defaults, then enroll synchronously so the
  # gateway sees a fully configured channel on its first plugin load.
  openclaw config set channels.clawbits.endpoint "${CLAWBITS_ENDPOINT:-https://app.clawbits.ai}"
  openclaw config set channels.clawbits.orgId    "${CLAWBITS_ORG_ID}"
  reef_clawbits_autosignup
elif [ -n "${CLAWBITS_ORG_ID:-}" ]; then
  # Org set but no signup token: seed the defaults, but we can't enroll — signup
  # now requires a one-time token. Bring the gateway up without a channel and
  # tell the operator to recreate the agent with a CLAWBITS_SIGNUP_TOKEN.
  openclaw config set channels.clawbits.endpoint "${CLAWBITS_ENDPOINT:-https://app.clawbits.ai}"
  openclaw config set channels.clawbits.orgId    "${CLAWBITS_ORG_ID}"
  echo "reef-entrypoint: CLAWBITS_ORG_ID set but no CLAWBITS_SIGNUP_TOKEN — skipping signup (it now requires a one-time token from the Clawbits 'Add agent' prompt). Recreate the agent with a signup token to enroll it." >&2
else
  echo "reef-entrypoint: no clawbits org set — starting the gateway without a clawbits channel" >&2
fi

# Mirror the (now-configured) identity onto the persistent config volume so a
# future image upgrade can restore it without the single-use signup token.
# Idempotent; a no-op for detached agents or an incomplete identity.
reef_persist_clawbits_identity

# Re-persist on a short interval as a SECONDARY guard. The boot persist above
# already captures the real key from the config file, but openclaw can rotate the
# clawbits apiKey later in the session (it rewrites
# channels.clawbits.accounts.default.apiKey), and the mirror is what a future
# image-upgrade restore reads. Backgrounded; the helper reads the real (unredacted)
# key from the config file and only writes a COMPLETE identity, so it's a safe
# no-op for detached/unconfigured agents.
reef_identity_persist_loop() {
  _iv="${REEF_IDENTITY_PERSIST_INTERVAL:-60}"
  [ "${_iv}" -gt 0 ] 2>/dev/null || return 0
  while :; do
    sleep "${_iv}"
    reef_persist_clawbits_identity
  done
}
reef_identity_persist_loop &

# --- Volunteered status (versions, …) for Reef to read host-side ------------
# Write a small, SECRET-FREE status.json to the Reef status mount: once at boot,
# then on an interval so in-place openclaw/plugin updates surface without a
# restart. Backgrounded so it never delays the gateway; best-effort. Reef reads
# this dir host-side (reef/status.py) — it must never contain secrets.
# REEF_STATUS_INTERVAL=0 → boot-only; unset REEF_STATUS_DIR → disabled.
reef_write_status() {
  [ -n "${REEF_STATUS_DIR:-}" ] || return 0
  mkdir -p "${REEF_STATUS_DIR}" 2>/dev/null || return 0
  _ocv=$(openclaw --version 2>/dev/null | sed 's/^OpenClaw //' | tr -d '\r')
  openclaw plugins list --json 2>/dev/null \
    | REEF_OC_VERSION="${_ocv}" REEF_IMAGE_VERSION="${REEF_IMAGE_VERSION:-}" node -e '
      let s = "";
      process.stdin.on("data", (d) => (s += d)).on("end", () => {
        let plugin = null;
        let tools = null;
        try {
          const j = JSON.parse(s);
          const p = (j.plugins || []).find((x) => x && x.id === "clawbits");
          const t = (j.plugins || []).find((x) => x && x.id === "clawbits-tools");
          if (p && p.version) plugin = String(p.version);
          if (t && t.version) tools = String(t.version);
        } catch {}
        const out = {
          schema: 1,
          reportedAt: new Date().toISOString(),
          agent: "openclaw",
          versions: {
            image: process.env.REEF_IMAGE_VERSION || null,
            openclaw: process.env.REEF_OC_VERSION || null,
            clawbitsPlugin: plugin,
            clawbitsTools: tools,
          },
        };
        try {
          require("fs").writeFileSync(
            process.env.REEF_STATUS_DIR + "/status.json",
            JSON.stringify(out, null, 2) + "\n",
          );
        } catch {}
      });
    ' 2>/dev/null || true
}

reef_status_loop() {
  reef_write_status
  _iv="${REEF_STATUS_INTERVAL:-300}"
  [ "${_iv}" -gt 0 ] 2>/dev/null || return 0
  while :; do
    sleep "${_iv}"
    reef_write_status
  done
}
reef_status_loop &

# --- Control-UI exposure (Reef-controlled; defaults keep outbound-only) -----
# To expose the Control UI, Reef sets OPENCLAW_GATEWAY_BIND=lan +
# OPENCLAW_GATEWAY_AUTH=password (+ OPENCLAW_GATEWAY_PASSWORD, which OpenClaw
# reads natively — keep it off the argv) and OPENCLAW_PUBLIC_URL = the URL the
# browser will use. A non-loopback bind is refused without auth, and the
# browser's origin must be in gateway.controlUi.allowedOrigins or its WS is
# rejected (seeded with localhost only since v2026.2.26).
if [ -n "${OPENCLAW_PUBLIC_URL:-}" ]; then
  openclaw config set gateway.controlUi.allowedOrigins \
    "[\"${OPENCLAW_PUBLIC_URL}\",\"http://localhost:18789\",\"http://127.0.0.1:18789\"]" --json
fi

# --- Reef web terminal (full shell by default; defaults OFF) ----------------
# When Reef sets REEF_TERMINAL_ENABLE, run ttyd serving a real login shell
# (reef-term.sh → bash -l) so the agent's owner can configure provider/model/
# channels, or run anything else, through Reef's authenticated web-UI exposure.
# Backgrounded — the gateway stays the FOREGROUND process so the container's
# liveness still tracks it (if the terminal dies, the agent is fine).
# Auth: in dev we pass ttyd --credential; in prod prefer auth at the proxy and
# keep the password off argv (trusted-proxy SSO later). REEF_TERMINAL_SHELL=openclaw
# swaps the real shell for the narrow scoped `openclaw`-only one.
# (Productionizing: supervise both under the image's tini so per-session shells
# are reaped.)
if [ -n "${REEF_TERMINAL_ENABLE:-}" ]; then
  set -- ttyd --writable --port "${REEF_TERMINAL_PORT:-7681}"
  if [ -n "${REEF_TERMINAL_PASSWORD:-}" ]; then
    set -- "$@" --credential "reef:${REEF_TERMINAL_PASSWORD}"
  else
    echo "reef-entrypoint: REEF_TERMINAL_ENABLE set without REEF_TERMINAL_PASSWORD — serving the terminal WITHOUT auth (dev only; put auth at the proxy in prod)." >&2
  fi
  echo "reef-entrypoint: starting Reef web terminal (ttyd) on :${REEF_TERMINAL_PORT:-7681} (shell=${REEF_TERMINAL_SHELL:-full})" >&2
  "$@" /usr/local/bin/reef-term.sh &
fi

exec openclaw gateway run \
  --bind "${OPENCLAW_GATEWAY_BIND:-loopback}" \
  --auth "${OPENCLAW_GATEWAY_AUTH:-token}" \
  --force
