#!/usr/bin/env bash
# Runs after the upstream Hermes Docker entrypoint has initialized HERMES_HOME
# and dropped privileges. Installs/enables the baked Clawbits plugin, optionally
# enrolls via a one-time signup token, starts the dashboard, then runs the
# Hermes gateway in the foreground.
set -euo pipefail

HERMES_HOME="${HERMES_HOME:-/opt/data}"
PLUGIN_NAME="${CLAWBITS_HERMES_PLUGIN_NAME:-clawbits-platform}"
PLUGIN_SRC="${CLAWBITS_HERMES_PLUGIN_SRC:-/opt/reef/clawbits-platform}"
PLUGIN_DST="${HERMES_HOME}/plugins/${PLUGIN_NAME}"
AGENT_CLI="${PLUGIN_DST}/agent-cli/clawbits_agent_cli.py"

reef_save_env() {
  key="$1"
  value="$2"
  [ -n "${value}" ] || return 0
  python3 - "$HERMES_HOME/.env" "$key" "$value" <<'PY'
from pathlib import Path
import sys
path = Path(sys.argv[1])
key = sys.argv[2]
value = sys.argv[3]
path.parent.mkdir(parents=True, exist_ok=True)
lines = []
if path.exists():
    prefix = key + "="
    lines = [line for line in path.read_text(encoding="utf-8").splitlines() if not line.startswith(prefix)]
lines.append(f"{key}={value}")
path.write_text("\n".join(lines) + "\n", encoding="utf-8")
PY
}

reef_install_plugin() {
  if [ ! -d "$PLUGIN_SRC" ]; then
    echo "reef-hermes: plugin source missing: $PLUGIN_SRC" >&2
    return 1
  fi
  rm -rf "$PLUGIN_DST"
  mkdir -p "$PLUGIN_DST"
  cp -R "$PLUGIN_SRC/." "$PLUGIN_DST/"
  reef_save_env CLAWBITS_AGENT_CLI "$AGENT_CLI"
  if [ -f "$PLUGIN_DST/plugin.yaml" ]; then
    version="$(awk -F': *' '/^version:/ {print $2; exit}' "$PLUGIN_DST/plugin.yaml" | tr -d '"')"
    reef_save_env CLAWBITS_PLUGIN_VERSION "$version"
    export CLAWBITS_PLUGIN_VERSION="${CLAWBITS_PLUGIN_VERSION:-$version}"
  fi
  hermes plugins enable "$PLUGIN_NAME" >/dev/null 2>&1 \
    && echo "reef-hermes: enabled Hermes plugin $PLUGIN_NAME" >&2 \
    || echo "reef-hermes: WARNING: could not enable plugin $PLUGIN_NAME" >&2
}

reef_persist_injected_env() {
  if [ -n "${CLAWBITS_ENDPOINT:-}" ] && [ -z "${CLAWBITS_BASE_URL:-}" ]; then
    export CLAWBITS_BASE_URL="$CLAWBITS_ENDPOINT"
  fi
  for key in \
    CLAWBITS_BASE_URL CLAWBITS_API_KEY CLAWBITS_AGENT_ID CLAWBITS_CHANNEL_ID \
    CLAWBITS_CHALLENGE_ANSWER CLAWBITS_PLUGIN_VERSION OPENAI_API_KEY ANTHROPIC_API_KEY \
    GEMINI_API_KEY OPENROUTER_API_KEY GATEWAY_ALLOW_ALL_USERS REEF_DEFAULT_MODEL \
    REEF_OPENAI_AUTH
  do
    value="${!key:-}"
    # An `if` block, NOT `[ -n "$value" ] && reef_save_env …`. Under `set -e` that
    # one-liner is fatal: on the LAST key (usually an unset ANTHROPIC_API_KEY) the
    # test fails, `&&` short-circuits, and the function returns 1 — which killed the
    # whole script here, before signup, the dashboard, or `exec hermes gateway run`
    # ever ran. The agent booted and died silently.
    if [ -n "$value" ]; then
      reef_save_env "$key" "$value"
    fi
  done
  return 0  # never let the loop's last exit status leak out under `set -e`
}

reef_configure_model() {
  # Point Hermes at the provider whose key Reef actually injected.
  #
  # The stock config that ships in the image is:
  #     model: {default: anthropic/claude-opus-4.6, provider: auto, base_url: https://openrouter.ai/api/v1}
  # and `auto` resolves an OPENAI_API_KEY to **openrouter** (hermes_cli/auth.py
  # resolve_provider, rule 3: "OPENAI_API_KEY or OPENROUTER_API_KEY -> openrouter").
  # So an agent created with an OpenAI key talked to openrouter.ai, which wants
  # OPENROUTER_API_KEY, found none, sent no Authorization header at all, and every
  # single reply died with `401 Missing Authentication header`. The key was fine; it
  # was being offered to the wrong provider.
  #
  # Hermes DOES have native providers for the keys reef can inject — they are just
  # never chosen by `auto`:
  #     anthropic  -> https://api.anthropic.com   (ANTHROPIC_API_KEY)
  #     openai-api -> https://api.openai.com/v1   (OPENAI_API_KEY)
  # Pin one explicitly. Model ids are the bare native ids reef's wizard already hands
  # over in REEF_DEFAULT_MODEL (gpt-5.4, claude-opus-4-8, …) — NOT the provider/model
  # slugs openrouter uses. The one exception is the deliberate openrouter branch
  # below: it fires only on an injected OPENROUTER_API_KEY (the fixed version of
  # the story above — the key and the endpoint finally match), and ITS model ids
  # ARE the full vendor/model slugs (anthropic/claude-opus-4.6).
  # Priority is deterministic because reef forwards ALL configured reef-level keys when
  # the operator doesn't pick a provider — several may be present at once. The explicit
  # ChatGPT-subscription pick wins outright; otherwise anthropic > openai > gemini,
  # matching the OpenClaw entrypoint's preference.
  provider=""
  base_url=""
  fallback_model=""
  if [ "${REEF_OPENAI_AUTH:-}" = "subscription" ]; then
    # ChatGPT subscription (OAuth): there is NO key — reef holds no token. We only pin
    # the provider; the owner finishes a device-code login in the web terminal with
    #     hermes login --provider openai-codex --no-browser
    # until then the agent has no working credential and will say so.
    provider="openai-codex"
    base_url="https://chatgpt.com/backend-api/codex"
    fallback_model="gpt-5.4"
  elif [ -n "${ANTHROPIC_API_KEY:-}" ]; then
    provider="anthropic"
    base_url="https://api.anthropic.com"
    fallback_model="claude-opus-4-8"
  elif [ -n "${OPENAI_API_KEY:-}" ]; then
    provider="openai-api"
    base_url="https://api.openai.com/v1"
    fallback_model="gpt-5.4"   # same default reef's OpenClaw entrypoint picks
  elif [ -n "${GEMINI_API_KEY:-}" ]; then
    provider="gemini"
    base_url="https://generativelanguage.googleapis.com/v1beta"
    fallback_model="gemini-3.5-flash"
  elif [ -n "${OPENROUTER_API_KEY:-}" ]; then
    provider="openrouter"
    base_url="https://openrouter.ai/api/v1"
    # Full vendor/model slug (what the openrouter API takes), and a FREE one —
    # the pickers' curated default; no spend until the owner picks a model.
    fallback_model="nvidia/nemotron-nano-9b-v2:free"
  else
    # No key injected — leave the stock config alone. The owner configures a provider
    # in the dashboard; overriding here would only trade one broken default for another.
    echo "reef-hermes: no model provider key injected — leaving hermes model config as-is" >&2
    return 0
  fi
  model="${REEF_DEFAULT_MODEL:-$fallback_model}"

  echo "reef-hermes: pinning model provider=${provider} model=${model} (${base_url})" >&2
  hermes config set model.provider "$provider"  >/dev/null 2>&1 || true
  hermes config set model.base_url "$base_url"  >/dev/null 2>&1 || true
  hermes config set model.default  "$model"     >/dev/null 2>&1 || true
  if [ "$provider" = "openai-codex" ]; then
    echo "reef-hermes: ChatGPT subscription selected — the agent has NO credential yet." >&2
    echo "reef-hermes:   Open the web terminal and run:" >&2
    echo "reef-hermes:     hermes login --provider openai-codex --no-browser" >&2
  fi
  return 0
}

reef_start_terminal() {
  # ttyd: Reef's authenticated web terminal, on the port reef forwards as
  # ``terminal_url``. Same one-time secret as the dashboard, so one password unlocks
  # both surfaces (the OpenClaw runtime does exactly this).
  #
  # This is what makes the ChatGPT-subscription (openai-codex) provider possible at
  # all: it is OAuth, so reef has no key to inject and the owner must run the
  # device-code login INSIDE the guest. The dashboard's chat tab can't do it — its
  # /api/pty drives the agent, not a shell.
  #
  # Backgrounded on purpose: the gateway stays the foreground process, so if the
  # terminal dies the agent is unaffected.
  [ -n "${REEF_TERMINAL_ENABLE:-}" ] || return 0
  if ! command -v ttyd >/dev/null 2>&1; then
    echo "reef-hermes: ttyd missing — no web terminal (ChatGPT-subscription login unavailable)" >&2
    return 0
  fi
  port="${REEF_TERMINAL_PORT:-7681}"
  set -- ttyd --writable --port "$port"
  if [ -n "${REEF_TERMINAL_PASSWORD:-}" ]; then
    set -- "$@" --credential "reef:${REEF_TERMINAL_PASSWORD}"
  else
    # Fail closed: an unauthenticated shell on a forwarded port is a remote-code-
    # execution hole, which is a different class of problem from "no terminal".
    echo "reef-hermes: REEF_TERMINAL_ENABLE set without a password — refusing to serve an UNAUTHENTICATED shell" >&2
    return 0
  fi
  echo "reef-hermes: starting web terminal (ttyd) on :${port}" >&2
  ( "$@" /usr/local/bin/reef-term.sh 2>&1 | sed -u 's/^/[terminal] /' ) &
  return 0
}

reef_clawbits_signup() {
  if [ -n "${CLAWBITS_API_KEY:-}" ] && [ -n "${CLAWBITS_AGENT_ID:-}" ]; then
    echo "reef-hermes: Clawbits creds injected — skipping signup" >&2
    return 0
  fi
  if [ -z "${CLAWBITS_SIGNUP_TOKEN:-}" ]; then
    if [ -n "${CLAWBITS_ORG_ID:-}" ]; then
      echo "reef-hermes: CLAWBITS_ORG_ID set but no CLAWBITS_SIGNUP_TOKEN — not enrolled" >&2
    else
      echo "reef-hermes: no clawbits signup token — starting detached" >&2
    fi
    return 0
  fi
  endpoint="${CLAWBITS_BASE_URL:-https://app.clawbits.ai}"
  args=(clawbits signup --endpoint "$endpoint" --signup-token "$CLAWBITS_SIGNUP_TOKEN" --agent-cli "$AGENT_CLI")
  [ -n "${CLAWBITS_ORG_ID:-}" ] && args+=(--org-id "$CLAWBITS_ORG_ID")
  echo "reef-hermes: enrolling with one-time signup token at $endpoint …" >&2
  hermes "${args[@]}" || true

  # Do NOT trust the exit code: `hermes clawbits signup` prints
  #   error: Clawbits signup failed: {...}
  # and still exits 0 (its CLI dispatcher drops the subcommand's return value). We
  # verified an agent that had been 426'd on enrollment yet logged "signup complete".
  #
  # Check the thing that actually matters instead: signup's whole job is to mint
  # CLAWBITS_API_KEY + CLAWBITS_AGENT_ID and persist them to $HERMES_HOME/.env. They
  # are the plugin's `requires_env`, so without them the gateway boots with "No
  # messaging platforms enabled", never contacts Clawbits, and the operator's Add-agent
  # wizard hangs on "hatching" forever with no clue why. Say so, loudly, right here.
  env_file="$HERMES_HOME/.env"
  if grep -qs '^CLAWBITS_API_KEY=..*' "$env_file" && grep -qs '^CLAWBITS_AGENT_ID=..*' "$env_file"; then
    echo "reef-hermes: signup complete — agent enrolled (api key + agent id persisted)" >&2
    return 0
  fi
  echo "reef-hermes: ****** ENROLLMENT FAILED ******" >&2
  echo "reef-hermes:   signup did not persist CLAWBITS_API_KEY / CLAWBITS_AGENT_ID to $env_file" >&2
  echo "reef-hermes:   the gateway will start with NO messaging platforms and will never" >&2
  echo "reef-hermes:   reach Clawbits — the Add-agent wizard will hang at 'hatching'." >&2
  echo "reef-hermes:   See the 'error:' line above for the cause (a 426 plugin_outdated" >&2
  echo "reef-hermes:   means this image's bundled plugin is below the server's floor)." >&2
  return 0  # keep booting: the dashboard still comes up so an operator can inspect
}

reef_write_status() {
  [ -n "${REEF_STATUS_DIR:-}" ] || return 0
  mkdir -p "$REEF_STATUS_DIR" 2>/dev/null || return 0
  hermes_version="$(python3 - <<'PY' 2>/dev/null || true
from importlib.metadata import version
try:
    print(version("hermes-agent"))
except Exception:
    print("")
PY
)"
  plugin_version="$(awk -F': *' '/^version:/ {print $2; exit}' "$PLUGIN_DST/plugin.yaml" 2>/dev/null | tr -d '"')"
  reported_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  cat >"$REEF_STATUS_DIR/status.json.tmp" <<EOF
{
  "schema": 1,
  "reportedAt": "${reported_at}",
  "agent": "hermes",
  "versions": {
    "image": "${REEF_IMAGE_VERSION:-}",
    "hermes": "${hermes_version}",
    "clawbitsPlugin": "${plugin_version}"
  }
}
EOF
  mv "$REEF_STATUS_DIR/status.json.tmp" "$REEF_STATUS_DIR/status.json" 2>/dev/null || true
}

reef_status_loop() {
  reef_write_status
  interval="${REEF_STATUS_INTERVAL:-300}"
  [ "$interval" -gt 0 ] 2>/dev/null || return 0
  while :; do
    sleep "$interval"
    reef_write_status
  done
}

reef_start_dashboard() {
  case "${REEF_HERMES_DASHBOARD:-}" in
    1|true|TRUE|True|yes|YES|Yes) ;;
    *) return 0 ;;
  esac
  host="${HERMES_DASHBOARD_HOST:-127.0.0.1}"
  port="${HERMES_DASHBOARD_PORT:-9118}"
  args=(--host "$host" --port "$port" --no-open)
  # NO --insecure. That flag is not a bind guard, it is the OFF switch for the
  # dashboard's auth gate (web_server.should_require_auth), and with it the session
  # token is served inside the SPA HTML — anyone reaching the port could read it and
  # pull the agent's API keys back out via /api/reveal. Reef binds the dashboard to
  # loopback and fronts it with an authenticating proxy instead (see below), so the
  # flag is never needed. If someone overrides the bind to a non-loopback host we
  # refuse rather than silently disable the gate.
  case "$host" in
    127.0.0.1|localhost|::1) ;;
    *)
      echo "reef-hermes: REFUSING to start dashboard on non-loopback host '$host'" >&2
      echo "reef-hermes:   a non-loopback bind needs --insecure, which disables auth" >&2
      echo "reef-hermes:   and exposes API keys. Leave HERMES_DASHBOARD_HOST=127.0.0.1." >&2
      return 0
      ;;
  esac
  if [ "${HERMES_DASHBOARD_TUI:-}" = "1" ]; then
    args+=(--tui)
  fi
  echo "reef-hermes: starting dashboard on ${host}:${port} (loopback; auth via proxy)" >&2
  (
    stdbuf -oL -eL hermes dashboard "${args[@]}" 2>&1 | sed -u 's/^/[dashboard] /'
  ) &
}

reef_start_auth_proxy() {
  # The only door into the guest's dashboard: nginx on the forwarded port, enforcing
  # HTTP basic auth with reef's one-time exposure password, proxying to the loopback
  # dashboard. Same shape as OpenClaw's ttyd (basic auth in front of a WebSocket).
  case "${REEF_HERMES_DASHBOARD:-}" in
    1|true|TRUE|True|yes|YES|Yes) ;;
    *) return 0 ;;
  esac
  public_port="${REEF_HERMES_PROXY_PORT:-9119}"
  upstream_port="${HERMES_DASHBOARD_PORT:-9118}"
  user="${REEF_HERMES_DASHBOARD_USER:-reef}"
  pw="${REEF_HERMES_DASHBOARD_PASSWORD:-}"

  # FAIL CLOSED. No password ⇒ no proxy. The dashboard stays bound to loopback and
  # is simply unreachable from outside the guest — never expose it unauthenticated.
  if [ -z "$pw" ]; then
    echo "reef-hermes: no REEF_HERMES_DASHBOARD_PASSWORD — NOT exposing the dashboard" >&2
    echo "reef-hermes:   (it stays loopback-only inside the guest; this is fail-closed)" >&2
    return 0
  fi
  nginx_bin="$(command -v nginx || echo /usr/sbin/nginx)"
  if [ ! -x "$nginx_bin" ]; then
    echo "reef-hermes: nginx missing — NOT exposing the dashboard (fail-closed)" >&2
    return 0
  fi

  prefix=/tmp/reef-proxy
  mkdir -p "$prefix/tmp"
  # -stdin so the password never appears in the process list / ps output.
  hash="$(printf '%s' "$pw" | openssl passwd -apr1 -stdin)"
  printf '%s:%s\n' "$user" "$hash" >"$prefix/htpasswd"
  chmod 600 "$prefix/htpasswd"

  cat >"$prefix/nginx.conf" <<CONF
worker_processes 1;
daemon off;
pid $prefix/nginx.pid;
# 'stderr' (the keyword), NOT /dev/stderr (the path). nginx opens a path target with
# open(), and in a microsandbox microVM /dev/stderr is not openable by the
# unprivileged hermes user — nginx then dies at startup with
#   [emerg] open() "/dev/stderr" failed (13: Permission denied)
# and the dashboard is silently unreachable. The keyword writes to fd 2 directly.
# (Docker's /dev is permissive enough to hide this, so it only bites on msb — i.e.
# on Linux, i.e. in prod.)
error_log stderr warn;
events { worker_connections 512; }
http {
    access_log off;
    client_body_temp_path $prefix/tmp/body;
    proxy_temp_path       $prefix/tmp/proxy;
    fastcgi_temp_path     $prefix/tmp/fastcgi;
    uwsgi_temp_path       $prefix/tmp/uwsgi;
    scgi_temp_path        $prefix/tmp/scgi;

    # WebSocket upgrade passthrough — the dashboard's Chat tab drives the agent over
    # /api/ws and /api/pty, so this is load-bearing, not boilerplate.
    map \$http_upgrade \$connection_upgrade { default upgrade; '' close; }

    server {
        listen 0.0.0.0:$public_port;
        auth_basic           "Hermes dashboard";
        auth_basic_user_file $prefix/htpasswd;
        client_max_body_size 0;

        location / {
            proxy_pass http://127.0.0.1:$upstream_port;
            proxy_http_version 1.1;
            # The dashboard validates Host against {localhost,127.0.0.1,::1} on a
            # loopback bind (DNS-rebinding defence, GHSA-ppp5-vxwm-4cf7). Forward the
            # loopback Host it expects, not the caller's.
            proxy_set_header Host 127.0.0.1;
            # Same guard applies to the WS upgrade (_ws_host_origin_reason), and it
            # checks Origin too. A browser reaching the agent through reef's surface
            # proxy sends Origin: https://<reef-host>, which is NOT loopback ⇒
            # "origin_mismatch" ⇒ the chat WebSocket (/api/ws, /api/pty) is refused.
            # Present the loopback origin the dashboard expects. We are not weakening
            # the boundary: the upstream still only accepts loopback peers (i.e. this
            # proxy), basic auth gates the door, and the WS itself still requires the
            # SPA-injected session token (?token=…) which a cross-site page cannot read.
            proxy_set_header Origin "http://127.0.0.1:$upstream_port";
            proxy_set_header Upgrade \$http_upgrade;
            proxy_set_header Connection \$connection_upgrade;
            proxy_set_header X-Forwarded-For \$remote_addr;
            proxy_set_header X-Forwarded-Proto \$scheme;
            proxy_read_timeout 3600s;   # long-lived chat WebSockets
            proxy_send_timeout 3600s;
            proxy_buffering off;        # stream SSE/WS promptly
        }
    }
}
CONF

  echo "reef-hermes: starting auth proxy on 0.0.0.0:${public_port} -> 127.0.0.1:${upstream_port} (basic auth, user '${user}')" >&2
  (
    stdbuf -oL -eL "$nginx_bin" -c "$prefix/nginx.conf" -p "$prefix" 2>&1 | sed -u 's/^/[proxy] /'
  ) &
}

reef_install_plugin
reef_persist_injected_env
reef_configure_model
reef_clawbits_signup
reef_start_dashboard
reef_start_auth_proxy
reef_start_terminal
reef_status_loop &

exec hermes gateway run --replace --accept-hooks
