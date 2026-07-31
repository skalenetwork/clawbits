"""AI provider registry: which model-provider config reef can wire into a VM.

Two value sources, resolved at create time (``reef.fleet.FleetService.create``):

  * **per-request** (BYO) - the caller passes the provider's cred field
    (``openai_api_key`` / ``anthropic_api_key`` / ``gemini_api_key`` /
    ``ollama_host``) in the create body. Always wins.
  * **reef-level** - the maintainer sets the provider's ``REEF_*`` var
    (``REEF_ANTHROPIC_API_KEY``, ``REEF_OLLAMA_HOST``, …) in reef's own
    environment (/etc/reef/reef.env) and reef forwards it into agent VMs. The
    create request's ``provider`` field narrows the forwarding to one provider
    ("none" skips it); requests that omit the field get every configured
    API-KEY provider (legacy callers predate the picker) - endpoint-kind
    providers (ollama) are never forwarded implicitly, so legacy callers keep
    their exact pre-picker behavior.

Provider kinds:

  * ``api_key`` - the value is a secret. ``GET /providers`` reports presence
    booleans only and the fleet detail view masks the guest env value
    (``redact_env`` matches ``*_API_KEY``).
  * ``endpoint`` - the value is a URL (Ollama). Not a secret: it is visible
    (unmasked) in fleet detail like any non-secret env var. Validated as
    http(s) with no userinfo, so no credential can ride it. An ollama create
    additionally REQUIRES a model (``resolve_model``): there is no sane
    default Ollama model, and UI-only enforcement wouldn't survive scripts or
    old clients. ``REEF_OLLAMA_DEFAULT_MODEL`` is the maintainer escape hatch.
  * ``oauth`` - the owner brings their own *subscription* (OpenAI ChatGPT plan)
    and authenticates with a device-code OAuth flow **inside their own VM**
    after boot (``openclaw models auth login --provider openai --device-code``,
    surfaced through the scoped web terminal). There is no reef-level or
    per-request secret to inject - reef never handles the token - so the create
    only emits an in-process marker that flips the guest into subscription mode
    (Codex harness + a Codex-safe default model). Always reported ``configured``
    (nothing to set up on the reef). Currently OpenClaw-only.

Values are never persisted - they ride the creds dict into the VM spec and
nothing else (the sandbox store stays secret-free).

The host env names are deliberately ``REEF_``-prefixed: reading bare
``OPENAI_API_KEY`` from reef's environment would silently forward a
developer's personal shell key into every VM. The prefix makes forwarding an
explicit maintainer opt-in.
"""

import os
import re
from dataclasses import dataclass
from urllib.parse import urlparse, urlunparse

import httpx

KIND_API_KEY = "api_key"
KIND_ENDPOINT = "endpoint"
KIND_OAUTH = "oauth"

# Model ids are runtime-defined (OpenClaw/IronClaw catalogs, Ollama tags like
# ``llama3.2:8b``); reef only sanity-checks the shape and passes them through.
_MODEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$")


@dataclass(frozen=True, slots=True)
class Provider:
    id: str  # wire id - the create request's ``provider`` value
    label: str  # human name for the pickers
    kind: str  # api_key | endpoint (see module docstring)
    cred_key: str  # creds-dict key AND the create request's BYO field name
    server_env: str  # reef host env var holding the maintainer-level value
    guest_env: str  # env var the profile injects into the VM
    runtimes: tuple[str, ...]  # agent types whose images can consume it


# Order = picker display order and default-pick preference (the openclaw
# entrypoint onboards with Anthropic when several keys are present).
# ``runtimes``: IronClaw support verified against nearai/ironclaw@06f9f0fc -
# LLM_BACKEND accepts "gemini" (GEMINI_API_KEY) and "ollama" (OLLAMA_BASE_URL,
# NOT OLLAMA_HOST - the IronClaw profile maps the cred; see profiles.py).
# Hermes is listed ONLY on anthropic + openai: ``HermesProfile.build_env`` injects
# exactly OPENAI_API_KEY / ANTHROPIC_API_KEY, so claiming a provider the image
# can't consume would hand the operator a key that silently does nothing.
PROVIDERS: tuple[Provider, ...] = (
    Provider(
        id="anthropic",
        label="Anthropic",
        kind=KIND_API_KEY,
        cred_key="anthropic_api_key",
        server_env="REEF_ANTHROPIC_API_KEY",
        guest_env="ANTHROPIC_API_KEY",
        runtimes=("openclaw", "ironclaw", "hermes"),
    ),
    Provider(
        id="openai",
        label="OpenAI",
        kind=KIND_API_KEY,
        cred_key="openai_api_key",
        server_env="REEF_OPENAI_API_KEY",
        guest_env="OPENAI_API_KEY",
        runtimes=("openclaw", "ironclaw", "hermes"),
    ),
    Provider(
        id="openai-codex",
        label="ChatGPT subscription",
        kind=KIND_OAUTH,
        # No BYO field and no reef-level key: the owner authenticates with their
        # ChatGPT plan via OpenClaw's device-code OAuth *inside the VM* after
        # boot, so reef never sees the token. ``cred_key`` is the in-process
        # marker ``resolve_creds`` emits when this provider is picked (consumed
        # by the profile's build_env + resolve_model); ``server_env`` /
        # ``guest_env`` are unused - no secret rides into the guest env.
        cred_key="openai_codex",
        server_env="",
        guest_env="",
        # OpenClaw + Hermes. Both complete the login themselves in the guest's web
        # terminal — a device-code flow, so no browser is needed inside the VM:
        #   openclaw: `openclaw models auth login --provider openai --device-code`
        #   hermes:   `hermes login --provider openai-codex --no-browser`
        # IronClaw has its own codex path and no such command.
        runtimes=("openclaw", "hermes"),
    ),
    Provider(
        id="gemini",
        label="Gemini",
        kind=KIND_API_KEY,
        cred_key="gemini_api_key",
        server_env="REEF_GEMINI_API_KEY",
        guest_env="GEMINI_API_KEY",
        # Hermes has a native `gemini` provider reading GEMINI_API_KEY (the same guest
        # var), so the key needs no translation — only the provider pin in the entrypoint.
        runtimes=("openclaw", "ironclaw", "hermes"),
    ),
    Provider(
        id="nearai",
        label="NEAR AI",
        kind=KIND_API_KEY,
        # NEAR Cloud AI: OpenAI-compatible chat completions at
        # https://cloud-api.near.ai (Bearer auth; HF-style model ids like
        # zai-org/GLM-5.1-FP8). IronClaw supports it natively (LLM_BACKEND
        # "nearai" reads NEARAI_API_KEY and auto-defaults the base URL when a
        # key is present — verified vs the pinned build); OpenClaw has no
        # built-in nearai provider, so its entrypoint registers a custom
        # OpenAI-compatible provider via the non-interactive onboard (see
        # reef/images/openclaw-runtime/entrypoint.sh).
        cred_key="nearai_api_key",
        server_env="REEF_NEARAI_API_KEY",
        guest_env="NEARAI_API_KEY",
        runtimes=("openclaw", "ironclaw"),
    ),
    Provider(
        id="ollama",
        label="Ollama",
        kind=KIND_ENDPOINT,
        cred_key="ollama_host",
        server_env="REEF_OLLAMA_HOST",
        guest_env="OLLAMA_HOST",
        runtimes=("openclaw", "ironclaw"),
    ),
)

# Explicit "inject no reef-level value" (the owner adds a model later in the
# agent's Control UI). Distinct from omitting the field, which forwards ALL
# configured reef-level API keys.
PROVIDER_NONE = "none"

# Maintainer-level default model for ollama creates that omit ``model``.
OLLAMA_DEFAULT_MODEL_ENV = "REEF_OLLAMA_DEFAULT_MODEL"

# Default model for ChatGPT-subscription (Codex OAuth) agents. ``gpt-5.5``
# crashes the codex session-mirror hook on the pinned OpenClaw image (breaks
# every message after the first - see the frontend model pickers + the
# reef-gpt55-codex-conflict note), so pin the known-good ``gpt-5.4`` until the
# reef image is bumped past it. Fully qualified so the openclaw entrypoint's
# bare-id qualifier passes it through untouched (no provider env var is set for
# an oauth pick, so the qualifier can't infer the ``openai/`` prefix itself).
CODEX_DEFAULT_MODEL = "openai/gpt-5.4"


def server_key(provider: Provider) -> str | None:
    """The maintainer-level value, read live from reef's env (systemd
    EnvironmentFile) - nothing cached, nothing stored."""
    value = (os.getenv(provider.server_env) or "").strip()
    return value or None


def is_configured(provider: Provider) -> bool:
    if provider.kind == KIND_OAUTH:
        # Nothing to configure on the reef - the owner brings their ChatGPT plan
        # and authenticates in-VM - so it is always "ready" in the picker.
        return True
    return server_key(provider) is not None


def _validate_endpoint(provider: Provider, url: str, *, source: str) -> str:
    """Endpoint-kind values must be plain http(s) URLs. Userinfo is rejected
    (not silently stripped) so no credential can ride a URL into the guest env,
    which is unmasked for non-secret keys."""
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise ValueError(f"{source} must be an http(s) URL, got {url!r}")
    if parsed.username or parsed.password:
        raise ValueError(f"{source} must not embed credentials (user:pass@host)")
    return url


def resolve_creds(
    provider_id: str | None,
    request_values: dict[str, str | None],
    *,
    agent_type: str | None = None,
) -> dict[str, str]:
    """Map the caller's provider pick + any explicit per-request values to the
    provider creds to inject (a ``creds``-dict fragment, keyed by ``cred_key``).

    Explicit request values are always injected and win over reef-level ones.
    ``provider_id`` governs which REEF-LEVEL values are forwarded:

      * ``None`` (field omitted - legacy callers): all configured API-KEY
        providers; endpoint-kind (ollama) is never forwarded implicitly
      * a provider id: that provider's value only - an error when neither a
        request value nor a reef-level one exists for it
      * ``"none"``: no reef-level values

    ``agent_type`` (when given) rejects a pick the type's images can't consume
    (``Provider.runtimes``). Raises ``ValueError`` for an unknown id, an
    unconfigured pick, an unsupported pick, or an invalid endpoint URL (the
    API maps it to 422).
    """
    chosen: Provider | None = None
    if provider_id is not None and provider_id != PROVIDER_NONE:
        chosen = next((p for p in PROVIDERS if p.id == provider_id), None)
        if chosen is None:
            valid = ", ".join([p.id for p in PROVIDERS] + [PROVIDER_NONE])
            raise ValueError(f"unknown provider {provider_id!r}; expected one of: {valid}")
        if agent_type is not None and agent_type not in chosen.runtimes:
            raise ValueError(
                f"provider {chosen.id!r} is not supported by agent type {agent_type!r} yet"
            )
    if chosen is not None and chosen.kind == KIND_OAUTH:
        # OAuth/subscription providers carry no secret from reef or the request:
        # the owner runs the device-code login inside their own VM after boot.
        # Emit only an in-process marker; the profile's build_env turns it into
        # the subscription-mode guest env and resolve_model pins a Codex-safe
        # model. (No key loop, and no "unconfigured pick" error - there is
        # nothing to configure.)
        return {chosen.cred_key: "1"}
    creds: dict[str, str] = {}
    for p in PROVIDERS:
        if p.kind == KIND_OAUTH:
            continue  # never resolved via keys; handled above when it's the pick
        explicit = (request_values.get(p.cred_key) or "").strip()
        if explicit:
            if p.kind == KIND_ENDPOINT:
                explicit = _validate_endpoint(p, explicit, source=p.cred_key)
            creds[p.cred_key] = explicit
            continue
        if provider_id is not None and (chosen is None or chosen.id != p.id):
            continue  # the caller picked, and not this one
        if provider_id is None and p.kind == KIND_ENDPOINT:
            continue  # never forward an endpoint implicitly (legacy callers)
        value = server_key(p)
        if value:
            if p.kind == KIND_ENDPOINT:
                value = _validate_endpoint(p, value, source=p.server_env)
            creds[p.cred_key] = value
        elif chosen is not None:  # picked it, but no value from either source
            noun = "key" if p.kind == KIND_API_KEY else "endpoint"
            raise ValueError(
                f"provider {p.id!r} has no {noun} on this reef - "
                f"set {p.server_env} or pass {p.cred_key}"
            )
    return creds


# ── Ollama model discovery ────────────────────────────────────────────────────
# The pickers offer a dropdown of the server's actually-pulled models. The
# fetch happens REEF-side: the operator's browser often can't reach the host at
# all (guest aliases like host.docker.internal, the reef box's own loopback, a
# LAN IP behind the tunnel) — reachability from the reef process is also the
# best predictor of reachability from a guest.

_OLLAMA_PROBE_TIMEOUT = 4.0
# Guest-side host aliases mean "the reef box" — from the reef process itself
# that is plain loopback. (The forward mapping lives in reef.fleet.)
_GUEST_HOST_ALIASES = {"host.docker.internal", "host.microsandbox.internal"}


def resolve_ollama_probe_url(host: str | None) -> str:
    """The URL the reef process should probe for ``/api/tags``: the caller's
    host (BYO) or the maintainer-level ``REEF_OLLAMA_HOST``, with guest-side
    aliases mapped back to loopback. Raises ``ValueError`` (→ 422) when
    neither source yields a valid http(s) URL."""
    ollama = next(p for p in PROVIDERS if p.id == "ollama")
    value = (host or "").strip()
    if value:
        value = _validate_endpoint(ollama, value, source="host")
    else:
        value = server_key(ollama) or ""
        if not value:
            raise ValueError(f"no ollama host: pass ?host= or set {ollama.server_env}")
        value = _validate_endpoint(ollama, value, source=ollama.server_env)
    parsed = urlparse(value)
    if (parsed.hostname or "").lower() in _GUEST_HOST_ALIASES:
        netloc = "127.0.0.1" if parsed.port is None else f"127.0.0.1:{parsed.port}"
        value = urlunparse(parsed._replace(netloc=netloc))
    return value.rstrip("/")


async def fetch_ollama_models(base_url: str) -> list[dict[str, object]]:
    """``GET {base}/api/tags`` → ``[{id, size, parameter_size}]`` (the shape the
    pickers render). Network/HTTP failures raise ``httpx.HTTPError`` — the API
    maps them to a readable 502."""
    async with httpx.AsyncClient(timeout=_OLLAMA_PROBE_TIMEOUT) as client:
        resp = await client.get(f"{base_url}/api/tags")
        resp.raise_for_status()
        body = resp.json()
    models: list[dict[str, object]] = []
    for m in body.get("models") or []:
        if not isinstance(m, dict) or not m.get("name"):
            continue
        details = m.get("details") if isinstance(m.get("details"), dict) else {}
        models.append(
            {
                "id": str(m["name"]),
                "size": m.get("size") if isinstance(m.get("size"), int) else None,
                "parameter_size": details.get("parameter_size") or None,
            }
        )
    return models


def resolve_model(model: str | None, creds: dict[str, str]) -> str | None:
    """The effective per-agent model (→ ``REEF_DEFAULT_MODEL`` in the guest).

    The request's ``model`` wins. An ollama create (``ollama_host`` in creds)
    REQUIRES one - falling back to ``REEF_OLLAMA_DEFAULT_MODEL``, else a
    ``ValueError`` (→ 422). Other providers may omit it (the runtime's own
    default applies). Raises for a malformed model id.
    """
    value = (model or "").strip() or None
    if value is None and creds.get("openai_codex"):
        # ChatGPT-subscription pick with no explicit model: pin the Codex-safe
        # default (see CODEX_DEFAULT_MODEL). A power user may still pass an
        # explicit model, which wins and is validated below.
        value = CODEX_DEFAULT_MODEL
    if value is None and creds.get("ollama_host"):
        value = (os.getenv(OLLAMA_DEFAULT_MODEL_ENV) or "").strip() or None
        if value is None:
            raise ValueError(
                "provider 'ollama' needs a model: pass model or set "
                f"{OLLAMA_DEFAULT_MODEL_ENV}"
            )
    if value is not None and not _MODEL_RE.match(value):
        raise ValueError(
            f"invalid model {value!r}: use letters, digits, '.', '_', ':', '/', '-' (max 200)"
        )
    return value
