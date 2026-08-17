"""The admin/fleet read+control layer.

Merges the live runtime view (``msb``/``docker``) with Reef's own per-sandbox
metadata, redacts secrets out of inspect output, exposes lifecycle control over
any sandbox on the host (including drift), and creates new detached agent VMs.
This is what the Reef-owned admin/fleet API (and the operator UI) calls. Stays
tenant-agnostic; never imports clawbits.
"""

import asyncio
import re
from collections.abc import Collection, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from time import monotonic
from urllib.parse import urlparse, urlunparse

from reef.agents import AGENT_TYPES, infer_type
from reef.capabilities import DEFAULT_CAPABILITIES
from reef.capabilities import normalize as _normalize_caps
from reef.capabilities import to_env as _caps_to_env
from reef.errors import RuntimeUnavailable, SandboxBusy, SandboxNotFound
from reef.exposure import Exposure, surface_digest
from reef.guest_env import EnvRecord, EnvTier
from reef.manager import SandboxManager
from reef.models import Sandbox
from reef.names import random_name
from reef.profiles import AccessInfo, AgentProfile
from reef.providers import PROVIDERS, resolve_creds, resolve_model
from reef.runtime import (
    AdminRuntime,
    DesiredState,
    Limits,
    MetricsSample,
    RestartPolicy,
    SandboxState,
)
from reef.store import SandboxStore
from reef.versions import is_outdated, latest_versions

# Env keys whose VALUE is a secret. ``msb inspect`` returns the full guest env
# (API keys, gateway tokens, passwords); never surface those to an operator UI.
# We mask values, not keys — operators still see *which* vars are set. (The
# type-aware ``access`` field is the one deliberate, scoped reveal — see below.)
_SECRET_KEY = re.compile(r"(KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|PRIVATE|CRED)", re.IGNORECASE)
_MASK = "***"

# Sandbox-name rules (valid as a docker/msb name).
_NAME_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$")

# Custom per-sandbox env (``CreateSandboxIn.env``). Keys reef itself wires into
# the guest are rejected up front — merge order alone can't protect
# conditionally-set keys (a detached create emits no CLAWBITS_*/model keys, so a
# user value would land verbatim and configure a channel/model behind the
# dedicated fields' backs). REEF_* is reef's own namespace (status dir, terminal,
# entrypoint knobs). OPENCLAW_* is deliberately NOT blanket-banned —
# OPENCLAW_STATE_DIR etc. are the use case; only the gateway/exposure keys reef
# manages are reserved.
_ENV_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_ENV_MAX_COUNT = 32
_ENV_MAX_KEY_LEN = 128
_ENV_MAX_VALUE_LEN = 4096
_RESERVED_ENV_PREFIX = "REEF_"
RESERVED_ENV_KEYS = frozenset(
    {
        "CLAWBITS_ENDPOINT",
        "CLAWBITS_BASE_URL",
        "CLAWBITS_ORG_ID",
        "CLAWBITS_SIGNUP_TOKEN",
        "CLAWBITS_AGENT_ID",
        "CLAWBITS_API_KEY",
        "CLAWBITS_CHANNEL_ID",
        "OPENCLAW_GATEWAY_TOKEN",
        "OPENCLAW_GATEWAY_BIND",
        "OPENCLAW_GATEWAY_AUTH",
        "OPENCLAW_PUBLIC_URL",
    }
    # Provider guest vars (ANTHROPIC_API_KEY, …, OLLAMA_HOST) are reef-managed
    # via the dedicated create fields — derived so a new registry entry is
    # reserved automatically. OLLAMA_BASE_URL is IronClaw's spelling of the
    # ollama host (profiles.IronClawProfile); CLAWBITS_BASE_URL is Hermes'
    # spelling of the clawbits endpoint (profiles.HermesProfile) — same
    # conditionally-set hole as CLAWBITS_ENDPOINT on a detached create.
    # LLM_BACKEND stays deliberately
    # UNreserved: reef only pins it when it injects a provider (merge order
    # protects that case), and a custom LLM_BACKEND + custom key env is the
    # supported power-user path to backends reef doesn't broker (groq, …)
    # on IronClaw.
    # Filtered: the OAuth provider declares guest_env="", which would otherwise
    # ride into every set built from this.
    | {p.guest_env for p in PROVIDERS if p.guest_env}
    | {"OLLAMA_BASE_URL"}
)

# Keys a user value must never take over: setting one turns an operation that is
# NOT "run this code" into one that does, or changes who the guest trusts.
_DANGEROUS_ENV_KEYS = frozenset(
    {
        "LD_PRELOAD",
        "LD_LIBRARY_PATH",
        "LD_AUDIT",
        "NODE_OPTIONS",
        "NODE_PATH",
        "PYTHONPATH",
        "PYTHONHOME",
        "PYTHONSTARTUP",
        "PERL5LIB",
        "PERLLIB",
        "PERL5OPT",
        "BASH_ENV",
        "ENV",
        "SHELLOPTS",
        "BASHOPTS",
        "GIT_SSH_COMMAND",
        "GIT_SSH",
        "GIT_EXEC_PATH",
        "GIT_EXTERNAL_DIFF",
        "GIT_PROXY_COMMAND",
        "GIT_TEMPLATE_DIR",
        "GIT_CONFIG_GLOBAL",
        "GIT_CONFIG_SYSTEM",
        "GIT_CONFIG_COUNT",
        "NODE_EXTRA_CA_CERTS",
        "NODE_TLS_REJECT_UNAUTHORIZED",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
        "CURL_CA_BUNDLE",
        "REQUESTS_CA_BUNDLE",
        "GIT_SSL_CAINFO",
        "GIT_SSL_NO_VERIFY",
        "PATH",
        "HOME",
        "SHELL",
        "USER",
        "LOGNAME",
        "IFS",
    }
)
# KEEP IN SYNC with ``reef_apply_env_file`` in reef/images/openclaw-runtime/
# entrypoint.sh: this is its two namespace arms, _DANGEROUS_ENV_KEYS its exact-key
# arms. The server must refuse exactly what the guest would silently discard.
_GUEST_DROPPED_ENV_PREFIXES = (
    _RESERVED_ENV_PREFIX,  # REEF_ - reef's own namespace
    "CLAWBITS_",
    "OPENCLAW_GATEWAY_",
    "GATEWAY_",
    "HERMES_",
    "IRONCLAW_",
)
_GUEST_DROPPED_ENV_KEYS = frozenset({"OPENCLAW_PUBLIC_URL", "SECRETS_MASTER_KEY"})
# Subtracts from the per-profile managed set only; nothing here may name a
# RESERVED_ENV_KEYS entry.
_USER_SETTABLE_MANAGED_KEYS = frozenset({"LLM_BACKEND"})
# Cap on the WHOLE user layer: 32 × 4096 of `-e` argv approaches ARG_MAX.
_ENV_MAX_TOTAL_BYTES = 65536
# Baked as image ENV, read back off `inspect` (which merges baked ENV with `-e`).
_ENV_FEATURE = "env-file"
_ENV_FEATURE_KEY = "REEF_FEATURES"
_ENV_APPLY_MODES = ("restart", "recreate", "none")
# Shorter values ("1", "dev") would destroy a log to protect a non-credential.
_LOG_REDACT_MIN_LEN = 6
_LOG_REDACT_TTL = 15.0  # seconds
_MAX_RETIRED_ENV_VALUES = 64  # bounded: plaintext in process memory

# Operator-selectable dashboard accent colours. The first is the default look
# (None ⇒ fall back to the agent-type tint, which is this red for OpenClaw).
AGENT_COLORS: tuple[str, ...] = ("red", "green", "blue", "orange", "yellow", "violet")


def redact_env(env: dict[str, str]) -> dict[str, str]:
    """Mask the values of secret-looking env vars, preserving key names. A
    key-NAME heuristic, so only ever safe over env reef itself wrote."""
    return {k: (_MASK if _SECRET_KEY.search(k) else v) for k, v in env.items()}


def _now() -> datetime:
    return datetime.now(UTC)


@dataclass(frozen=True, slots=True)
class FleetEntry:
    """One row of the fleet list: live runtime state + Reef metadata + metrics."""

    sandbox_id: str
    image: str
    state: SandboxState
    created_at: datetime | None = None
    profile: str | None = None
    tenant: str | None = None
    managed: bool = False  # tracked in Reef's store (vs drift / hand-created)
    metrics: MetricsSample | None = None
    agent_type: str = "unknown"  # openclaw | hermes | unknown
    color: str | None = None  # operator-chosen dashboard accent; None ⇒ agent-type default
    # Version-based upgrade signal (server-computed): the agent's REPORTED running
    # versions (status.json) vs the active image's baked versions for its runtime.
    # ``upgrade_available`` ⇒ strictly behind on some component; False when the
    # agent hasn't reported yet (a safe no-signal, no digest dependency).
    # ``image_version`` is the truthful "what's running" stack string
    # (oc<oc>-pl<pl> / ic<ic>-ch<ch>), or None if unreported.
    upgrade_available: bool = False
    image_version: str | None = None
    # Self-healing (managed sandboxes only; None/0 for drift).
    desired_state: DesiredState | None = None
    restart_policy: RestartPolicy | None = None
    restart_count: int = 0
    last_restart_at: datetime | None = None


@dataclass(frozen=True, slots=True)
class NetworkPolicy:
    enabled: bool = True
    default_egress: str = "allow"
    default_ingress: str = "allow"
    egress_allow: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class Mount:
    source: str
    dest: str
    type: str
    readonly: bool = False


@dataclass(frozen=True, slots=True)
class SandboxDetail:
    """Full per-sandbox view for the detail drawer. ``env`` is REEF'S OWN layer
    only, already redacted; ``access`` is the type-scoped reveal."""

    sandbox_id: str
    image: str
    state: SandboxState
    cpus: float | None
    memory_mib: int | None
    command: str | None
    env: dict[str, str]
    network: NetworkPolicy
    mounts: tuple[Mount, ...]
    profile: str | None = None
    tenant: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None
    managed: bool = False
    port: int | None = None  # forwarded host port (when exposed)
    url: str | None = None  # public Control-UI URL (when exposed)
    agent_type: str = "unknown"
    color: str | None = None  # operator-chosen dashboard accent; None ⇒ agent-type default
    upgrade_available: bool = (
        False  # agent reported versions behind the active image (server-computed)
    )
    image_version: str | None = None  # truthful "what's running" stack string; None if unreported
    desired_state: DesiredState | None = None
    restart_policy: RestartPolicy | None = None
    restart_count: int = 0
    last_restart_at: datetime | None = None
    access: AccessInfo | None = None
    status: dict | None = None  # agent-volunteered telemetry (versions, …); None if unreported
    capabilities: tuple[str, ...] = ()  # granted opt-in capabilities (managed only)


@dataclass(frozen=True, slots=True)
class GuestEnvVar:
    """One user-supplied guest env var.

    ``value`` is populated ONLY for ``tier="regular"``. A secret stays write-only:
    reef holds the plaintext (it is in the overlay file) but no surface hands it
    back, which is the promise every value entered before tiers was given.
    """

    key: str
    value_length: int  # characters; 0 is set-but-empty, not "missing"
    source: str  # "file" (the editable overlay) | "container" (the create-time -e layer)
    tier: str = "secret"
    value: str | None = None  # regular only; None for every secret


@dataclass(frozen=True, slots=True)
class GuestEnvView:
    """``GET /fleet/{id}/env``: what the operator's own vars ARE, never what they
    say."""

    sandbox_id: str
    vars: tuple[GuestEnvVar, ...]
    editable: bool
    apply_modes: tuple[str, ...]  # ("restart","recreate") | ("recreate",)
    state: str
    desired_state: str | None
    # None when editable; "drift" (permanent) | "unreadable-image" (transient)
    # otherwise. Drift wins when both hold.
    editable_reason: str | None = None
    complete: bool = True  # False ⇒ vars is PARTIAL; reef could not read the -e layer
    pending: bool = False  # forward-compat; always False in v1 (a write IS the apply)


@dataclass(frozen=True, slots=True)
class EnvApplyResult:
    """``changed`` False ⇒ the resulting env equalled the current one and NOTHING
    was touched."""

    sandbox_id: str
    changed: bool
    applied: str  # restart | recreate | none - what actually happened, not what was asked
    takes_effect: str  # now | on_next_start
    state: str
    vars: tuple[GuestEnvVar, ...]


@dataclass(frozen=True, slots=True)
class _EnvContext:
    """Everything both env paths need out of one round-trip of runtime reads."""

    sandbox_id: str
    state: SandboxState
    rec: Sandbox | None
    profile: AgentProfile | None
    injected: dict[str, str]  # reef-injected layer (container env minus baked ENV)
    limits: Limits
    container_user: dict[str, str]  # user vars from the create-time -e layer
    current: dict[str, str]  # container_user with the overlay file applied over it
    file_keys: frozenset[str]  # which of ``current`` the overlay file carries
    # Tier per overlay-carried key. A key absent here (a create-time -e var, or a
    # file written before tiers existed) is secret - see ``guest_env._DEFAULT_TIER``.
    file_tiers: dict[str, str]
    # The overlay file EXACTLY as read, unfiltered; ``None`` when there is no file.
    # Verbatim, not rebuilt from ``current``: it is the undo buffer for a failed
    # apply, and a rebuild would "clean" records the operator never saved.
    file_records: tuple[EnvRecord, ...] | None
    supports_env_file: bool
    # Baked env unreadable, so the -e layer could not be separated from it:
    # ``container_user`` is empty and ``current`` is the overlay file ALONE.
    degraded: bool = False


def _image_ref(cfg: dict) -> str:
    img = cfg.get("image")
    if isinstance(img, dict):
        oci = img.get("Oci") or img.get("oci") or {}
        return str(oci.get("reference", ""))
    return str(img or "")


def _command(cfg: dict) -> str | None:
    parts: list[str] = []
    for key in ("entrypoint", "cmd"):
        val = cfg.get(key)
        if isinstance(val, list):
            parts += [str(p) for p in val]
        elif val:
            parts.append(str(val))
    return " ".join(parts) if parts else None


def _env_dict(cfg: dict) -> dict[str, str]:
    """Normalize a runtime's env list to a ``{key: value}`` dict.

    Runtimes disagree on the wire shape and reef must accept all of them, or
    exposure/access detection (and the upgrade-path env replay) silently blanks
    out on one host:
      • docker (dev) + the docker adapter → ``[[key, value], …]`` pairs
      • microsandbox (prod) ``msb inspect`` → ``[{"key": …, "value": …}, …]`` objects
      • defensive: ``[{"name": …, "value": …}, …]`` and ``["KEY=VALUE", …]``
    Unknown shapes are skipped rather than raising — a malformed entry must not
    take down the whole detail read.
    """
    out: dict[str, str] = {}
    for item in cfg.get("env") or []:
        if isinstance(item, list | tuple) and len(item) == 2:
            out[str(item[0])] = str(item[1])
        elif isinstance(item, dict):
            key = item.get("key", item.get("name"))
            if key is not None:
                out[str(key)] = str(item.get("value", ""))
        elif isinstance(item, str) and "=" in item:
            k, v = item.split("=", 1)
            out[k] = v
    return out


def _network(cfg: dict) -> NetworkPolicy:
    net = cfg.get("network") or {}
    policy = net.get("policy") or {}
    allow: list[str] = []
    for rule in policy.get("rules") or []:
        if rule.get("action") == "allow" and rule.get("direction") == "egress":
            dest = rule.get("destination") or {}
            label = dest.get("domain") or dest.get("host") or dest.get("cidr") or dest.get("group")
            if label and label != "host":  # skip the implicit host-loopback rule
                allow.append(str(label))
    return NetworkPolicy(
        enabled=bool(net.get("enabled", True)),
        default_egress=str(policy.get("default_egress", "allow")),
        default_ingress=str(policy.get("default_ingress", "allow")),
        egress_allow=tuple(allow),
    )


def _mounts(cfg: dict) -> tuple[Mount, ...]:
    out: list[Mount] = []
    for m in cfg.get("mounts") or []:
        opts = m.get("options") or {}
        out.append(
            Mount(
                source=str(m.get("host") or m.get("volume") or m.get("type", "")),
                dest=str(m.get("guest", "")),
                type=str(m.get("type", "")),
                readonly=bool(opts.get("readonly", False)),
            )
        )
    return tuple(out)


def _access_info(
    agent_type: str,
    env: dict[str, str],
    url: str | None,
    terminal_url: str | None = None,
) -> AccessInfo | None:
    """Type-scoped access reveal for the detail view: the surface URLs (which are
    not secret) WITHOUT the password. The access password is a one-time reveal at
    CREATE only (``manager.expose`` → the create response); reef neither stores
    nor can recompute it, so it is never surfaced here. ``None`` when the type is
    unknown or the agent isn't exposed."""
    at = AGENT_TYPES.get(agent_type)
    if at is None:
        return None
    try:
        # secret=None ⇒ the profile yields password=None (no env fallback).
        return at.profile().access_info(env, url=url, terminal_url=terminal_url, secret=None)
    except ValueError, KeyError:
        return None


# Hostname a guest uses to reach its host's loopback, per runtime CLI.
_RUNTIME_HOST_ALIASES = {
    "docker": "host.docker.internal",
    "microsandbox": "host.microsandbox.internal",
}
# Endpoint hostnames that mean "the clawbits backend on the reef host itself".
_LOCAL_ENDPOINT_HOSTS = {"localhost", "127.0.0.1", *_RUNTIME_HOST_ALIASES.values()}


def _normalize_local_endpoint(url: str, backend: str) -> str:
    """Map a host-local clawbits endpoint onto THIS runtime's host alias.

    The clawbits UI can't know which runtime a reef drives, so a local-dev
    create may name the host as ``localhost`` (which, inside the guest, is the
    guest itself) or as the *other* runtime's alias (unresolvable here). Swap
    the hostname for the alias this runtime's guests can actually reach,
    keeping scheme/port. Public endpoints (prod/staging clawbits) and unknown
    backends pass through untouched."""
    parsed = urlparse(url)
    alias = _RUNTIME_HOST_ALIASES.get(backend)
    host = (parsed.hostname or "").lower()
    if alias is None or host == alias or host not in _LOCAL_ENDPOINT_HOSTS:
        return url
    netloc = alias if parsed.port is None else f"{alias}:{parsed.port}"
    return urlunparse(parsed._replace(netloc=netloc))


def _local_endpoint_net_allow(url: str | None) -> tuple[str, ...]:
    """msb default egress permits public internet, not host/private networks.
    Local Clawbits endpoints need an explicit allow rule. Adding any msb allow
    rule flips default egress to deny, so preserve public internet too (OpenAI,
    Anthropic, npm, etc.)."""
    if not url:
        return ()
    host = (urlparse(url).hostname or "").lower()
    if host in _LOCAL_ENDPOINT_HOSTS:
        return ("public", "host")
    if host.startswith(
        (
            "10.",
            "192.168.",
            "172.16.",
            "172.17.",
            "172.18.",
            "172.19.",
            "172.2",
            "172.30.",
            "172.31.",
        )
    ):
        return ("public", "private")
    return ()


def _net_allow_union(*urls: str | None) -> tuple[str, ...]:
    """Union of the egress rules every host-local URL the guest must reach needs
    (clawbits endpoint AND the ollama host) — computed the same way at create
    and at upgrade, or an image upgrade would silently drop a rule and strand
    the agent's LLM (docs/protocol/AGENT_SETUP_WIZARD_PLAN.md §1.3)."""
    rules: list[str] = []
    for url in urls:
        for rule in _local_endpoint_net_allow(url):
            if rule not in rules:
                rules.append(rule)
    return tuple(rules)


def default_env_tier(key: str) -> EnvTier:
    """The tier a NEW variable gets when the caller does not say.

    Named, not fixed: a flat "regular by default" would make ``ANTHROPIC_API_KEY``
    readable because someone did not tick a box, and the pasted-credential case is
    the common one. ``_SECRET_KEY`` is the same heuristic the log redactor and both
    UIs already share, so the guess is consistent everywhere.
    """
    return "secret" if _SECRET_KEY.search(key) else "regular"


def _resolve_env_tiers(
    result: Mapping[str, str],
    *,
    current_tiers: Mapping[str, str],
    known_keys: Collection[str],
    requested: Mapping[str, str],
    set_keys: Collection[str],
) -> dict[str, str]:
    """The tier to store for every key in the post-save env.

    Precedence: what the caller asked for, else the tier the key already had, else
    ``default_env_tier`` for a key reef has never seen. A key reef already knows
    therefore keeps its tier through an ordinary value edit, and a pre-tier key
    stays secret instead of being silently reclassified by the heuristic.

    One transition is refused: secret -> regular WITHOUT re-supplying the value.
    Reef *could* reveal the old plaintext - it is right there in the overlay file -
    but then the flip is a read primitive: anyone holding the admin token could
    flip, read, and flip back. Requiring re-entry means whoever reveals a value
    already knew it.
    """
    out: dict[str, str] = {}
    for key in result:
        was = current_tiers.get(key, "secret") if key in known_keys else None
        want = requested.get(key)
        if want is None:
            out[key] = was if was is not None else default_env_tier(key)
            continue
        if want not in ("secret", "regular"):
            raise ValueError(f"invalid tier {want!r} for env key {key!r}: use secret or regular")
        if want == "regular" and was == "secret" and key not in set_keys:
            raise ValueError(
                f"env key {key!r} is stored as a secret; re-enter its value to make it "
                "readable (reef does not reveal a value that was saved as a secret)"
            )
        out[key] = want
    return out


def _env_vars_out(
    values: dict[str, str],
    file_keys: Collection[str],
    tiers: Mapping[str, str],
) -> tuple[GuestEnvVar, ...]:
    out = []
    for key, value in sorted(values.items()):
        # Anything with no recorded tier is pre-tier data: secret (see guest_env).
        tier = tiers.get(key, "secret")
        out.append(
            GuestEnvVar(
                key=key,
                value_length=len(value),
                source="file" if key in file_keys else "container",
                tier=tier,
                value=value if tier == "regular" else None,
            )
        )
    return tuple(out)


def _recreate_net_allow(injected: dict[str, str]) -> tuple[str, ...]:
    """The same union as create - dropping a rule here would strand the agent's LLM
    or its host-local clawbits on msb, where host egress is opt-in."""
    return _net_allow_union(
        injected.get("CLAWBITS_ENDPOINT"),
        injected.get("CLAWBITS_BASE_URL"),
        injected.get("OLLAMA_HOST"),
        injected.get("OLLAMA_BASE_URL"),
    )


def _new_name(name: str | None, taken: Collection[str] = ()) -> str:
    if name:
        name = name.strip()
        if not _NAME_RE.match(name):
            raise ValueError(f"invalid name {name!r}: use letters, digits, '-', '_', '.'")
        return name
    return random_name(taken)


def _parse_restart_policy(value: str | None) -> RestartPolicy:
    """``None`` ⇒ the default (``on-failure``); a bad string raises ``ValueError``."""
    if value is None:
        return RestartPolicy.ON_FAILURE
    try:
        return RestartPolicy(value)
    except ValueError:
        valid = ", ".join(p.value for p in RestartPolicy)
        raise ValueError(f"invalid restart_policy {value!r}; expected one of: {valid}") from None


def _managed_keys(profile: AgentProfile | None) -> frozenset[str]:
    """Every key reef itself owns for this agent type."""
    managed = RESERVED_ENV_KEYS | frozenset(getattr(profile, "managed_env_keys", frozenset()))
    return managed - _USER_SETTABLE_MANAGED_KEYS


def _guest_drops(key: str) -> bool:
    return key in _GUEST_DROPPED_ENV_KEYS or key.startswith(_GUEST_DROPPED_ENV_PREFIXES)


def _is_user_env_key(key: str, managed: Collection[str]) -> bool:
    """The ONE predicate behind both halves of the env read, so the reader can
    never offer a key the validator refuses."""
    return key not in managed and key not in _DANGEROUS_ENV_KEYS and not _guest_drops(key)


def _reject_reserved_key(key: str, managed: Collection[str]) -> None:
    if key in _DANGEROUS_ENV_KEYS:
        raise ValueError(
            f"env key {key!r} is not settable: it controls how the guest loads and runs "
            "code, or which TLS roots it trusts"
        )
    # ``managed`` already has these subtracted; this covers a caller with its own set.
    if key in _USER_SETTABLE_MANAGED_KEYS:
        return
    if key in RESERVED_ENV_KEYS or key in managed or _guest_drops(key):
        raise ValueError(f"env key {key!r} is managed by reef; use the dedicated create fields")


def _validate_env_totals(env: dict[str, str]) -> None:
    """Applied to the RESULTING user env on an edit, never to the delta - otherwise
    the count cap is bypassed one PATCH at a time."""
    if len(env) > _ENV_MAX_COUNT:
        raise ValueError(f"too many env vars ({len(env)}); max {_ENV_MAX_COUNT}")
    total = sum(len(k.encode("utf-8")) + len(v.encode("utf-8")) for k, v in env.items())
    if total > _ENV_MAX_TOTAL_BYTES:
        raise ValueError(f"env too large ({total} bytes); max {_ENV_MAX_TOTAL_BYTES}")


def _validate_guest_representable(key: str, value: str) -> None:
    if "\x00" in value:  # can't ride exec argv; the guest reader drops it too
        raise ValueError(f"env value for {key!r} contains a NUL byte")
    # The guest decodes with ``$( )``, which strips trailing newlines - so a value
    # ending in one would reach the agent as a different string. Interior ones are fine.
    if value.endswith("\n"):
        raise ValueError(
            f"env value for {key!r} ends with a newline, which the guest's env "
            "reader strips; set it without the trailing newline"
        )


def _validate_written_env(result: dict[str, str], submitted: Collection[str]) -> None:
    """The create-time ``-e`` layer predates these rules, so serializing one of its
    values into the overlay would make the guest silently truncate it."""
    for key, value in result.items():
        if key in submitted:
            continue  # already validated, with the plain message
        try:
            _validate_guest_representable(key, value)
        except ValueError as exc:
            raise ValueError(
                f"{exc} (this agent already carries {key!r} that way - it predates the rule, "
                "so reef cannot save any change while it would have to write it back)"
            ) from None


def _validate_user_env(
    env: dict[str, str] | None, *, managed: Collection[str] = ()
) -> dict[str, str] | None:
    """Validate caller-supplied env; raises ``ValueError`` (→ 422). Returns a
    defensive copy, or ``None`` when empty/absent. Messages carry the KEY and the
    LENGTH, never the value - they are echoed into an operator's toast."""
    if not env:
        return None
    _validate_env_totals(env)
    for key, value in env.items():
        if len(key) > _ENV_MAX_KEY_LEN or not _ENV_KEY_RE.match(key):
            raise ValueError(
                f"invalid env key {key!r}: use letters, digits, '_'; must not start with a digit"
            )
        _reject_reserved_key(key, managed)
        if len(value) > _ENV_MAX_VALUE_LEN:
            raise ValueError(
                f"env value for {key!r} too long ({len(value)} chars); max {_ENV_MAX_VALUE_LEN}"
            )
        _validate_guest_representable(key, value)
    return dict(env)


def _injected_env(container_env: dict[str, str], image_baked: dict[str, str]) -> dict[str, str]:
    return {k: v for k, v in container_env.items() if image_baked.get(k) != v}


def _reef_managed_env(env: dict[str, str], profile: AgentProfile | None) -> dict[str, str]:
    """Keep only the keys REEF owns: ``redact_env`` masks by key NAME, which is a
    coin flip over an operator's vars (``DATABASE_URL``, ``GH_PAT`` come back in
    full), so they are dropped rather than trusted to it."""
    managed = _managed_keys(profile)
    return {k: v for k, v in env.items() if not _is_user_env_key(k, managed)}


def _user_env_layer(injected: dict[str, str], profile: AgentProfile | None) -> dict[str, str]:
    managed = _managed_keys(profile)
    return {k: v for k, v in injected.items() if _is_user_env_key(k, managed)}


def _apply_env_overlay(
    injected: dict[str, str],
    records: Sequence[EnvRecord] | None,
    profile: AgentProfile | None,
) -> dict[str, str]:
    """The same last-one-wins the guest performs at boot, so a recreate pins what
    the agent is actually running with. Filtered, so a stale dangerous record is
    never promoted onto ``-e``."""
    if not records:
        return injected
    managed = _managed_keys(profile)
    out = dict(injected)
    for record in records:
        if not _is_user_env_key(record.key, managed):
            continue
        if record.op == "u":
            out.pop(record.key, None)
        else:
            out[record.key] = record.value
    return out


def _supports_env_file(container_env: dict[str, str]) -> bool:
    """``container_env`` MUST be the raw env off ``inspect``, never
    ``image_env(rec.image)``: that is the floating active tag, so promoting a
    post-feature build would make every existing container claim a reader it does
    not have."""
    features = (container_env.get(_ENV_FEATURE_KEY) or "").split(",")
    return _ENV_FEATURE in (f.strip() for f in features)


def _redact_values(text: str, values: Collection[str]) -> str:
    """Longest first, so a value containing another can't leave a fragment behind."""
    for value in sorted(
        {v for v in values if len(v) >= _LOG_REDACT_MIN_LEN}, key=len, reverse=True
    ):
        text = text.replace(value, _MASK)
    return text


# status.json version keys per runtime: (runtime-engine key, clawbits-component key).
# Hermes carries the clawbits *plugin* (the baked clawbits-platform extension), so
# it shares OpenClaw's component key — not IronClaw's channel.
_STATUS_VERSION_KEYS = {
    "openclaw": ("openclaw", "clawbitsPlugin"),
    "ironclaw": ("ironclaw", "clawbitsChannel"),
    "hermes": ("hermes", "clawbitsPlugin"),
}
# How the truthful "what's running" stack string is spelled per runtime.
_STACK_PREFIXES = {
    "openclaw": ("oc", "pl"),
    "ironclaw": ("ic", "ch"),
    "hermes": ("hm", "pl"),
}


def _version_signal(
    agent_type: str,
    status: dict | None,
    active: dict[str, tuple[str | None, str | None]],
) -> tuple[str | None, bool]:
    """Version-based upgrade signal for one agent → ``(image_version,
    upgrade_available)``. ``image_version`` is the truthful running stack string
    built from the agent's REPORTED versions (status.json); ``upgrade_available``
    is True iff a reported component is strictly behind the active image's baked
    version for this runtime. No/unparseable report ⇒ ``(None, False)`` — a safe
    no-signal. Never uses digests, so there's no churn and no legacy null-gap."""
    keys = _STATUS_VERSION_KEYS.get(agent_type)
    if keys is None or not isinstance(status, dict):
        return None, False
    versions = status.get("versions")
    if not isinstance(versions, dict):
        return None, False
    rt_key, comp_key = keys
    rt = versions.get(rt_key)
    comp = versions.get(comp_key)
    rt = rt if isinstance(rt, str) and rt else None
    comp = comp if isinstance(comp, str) and comp else None
    rt_pfx, comp_pfx = _STACK_PREFIXES[agent_type]
    parts: list[str] = []
    if rt:
        parts.append(f"{rt_pfx}{rt}")
    if comp:
        parts.append(f"{comp_pfx}{comp}")
    image_version = "-".join(parts) if parts else None
    active_rt, active_comp = active.get(agent_type, (None, None))
    upgrade = is_outdated(rt, active_rt) or is_outdated(comp, active_comp)
    return image_version, upgrade


def _record_detail(rec: Sandbox) -> SandboxDetail:
    """Detail view of a managed record whose container is gone; everything
    runtime-sourced is absent, not guessed."""
    return SandboxDetail(
        sandbox_id=rec.sandbox_id,
        image=rec.image or "",
        state=rec.state,
        cpus=None,
        memory_mib=None,
        command=None,
        env={},
        network=NetworkPolicy(),
        mounts=(),
        profile=rec.profile,
        tenant=rec.tenant,
        created_at=rec.created_at,
        updated_at=rec.updated_at,
        managed=True,
        port=rec.port,
        url=rec.url,
        agent_type=infer_type(rec.image or "", rec.profile),
        color=rec.color,
        desired_state=rec.desired_state,
        restart_policy=rec.restart_policy,
        restart_count=rec.restart_count,
        last_restart_at=rec.last_restart_at,
        capabilities=rec.capabilities,
    )


class FleetService:
    """Admin-facing fleet operations over an ``AdminRuntime`` + ``SandboxStore``.

    Lifecycle/read is keyed by sandbox name (== Reef's ``sandbox_id``), so it
    works for sandboxes Reef created *and* ones found only on the host. Creating
    new VMs needs a ``SandboxManager`` (the create/expose engine).
    """

    def __init__(
        self,
        runtime: AdminRuntime,
        store: SandboxStore,
        *,
        manager: SandboxManager | None = None,
    ) -> None:
        self._runtime = runtime
        self._store = store
        self._manager = manager
        self._locks: dict[str, asyncio.Lock] = {}  # per-sandbox mutation lock
        self._redaction_cache: dict[str, tuple[float, tuple[str, ...]]] = {}
        self._retired_env_values: dict[str, tuple[str, ...]] = {}

    @property
    def runtime(self) -> AdminRuntime:
        """The underlying runtime — used to build the image-build job manager."""
        return self._runtime

    async def list_images(self):
        """Local agent images (``reef-oc:*`` + ``reef-ic:*``) for the Images section."""
        return await self._runtime.list_images()

    async def activate_image(self, tag: str) -> None:
        """Re-point the floating active tag at an existing image (rollback). Validates
        the tag is a known reef image (so a typo 422s instead of mis-tagging); the
        runtime then re-points that tag's OWN runtime's active tag (never cross-type
        — see ``image_ops.activate_image``). Raises ``ValueError`` for an unknown tag."""
        if not any(i.tag == tag for i in await self._runtime.list_images()):
            raise ValueError(f"unknown image {tag!r}")
        await self._runtime.activate_image(tag)

    async def _active_image_versions(self) -> dict[str, tuple[str | None, str | None]]:
        """Per-runtime ``{agent_type: (runtime_version, component_version)}`` from the
        active image of each type — the versions an agent SHOULD be on. Best-effort +
        time-boxed: a docker hiccup or wedged daemon yields ``{}`` (⇒ no upgrade
        signal, never a hang/break). 3s bounds the ~8s fleet poll."""
        try:
            images = await asyncio.wait_for(self._runtime.list_images(), timeout=3.0)
        except Exception:  # noqa: BLE001 — incl. TimeoutError; observability must not depend on docker
            return {}
        active: dict[str, tuple[str | None, str | None]] = {}
        for img in images:
            if img.is_active:
                active[img.agent_type] = (img.runtime_version, img.component_version)
        return active

    async def _read_statuses(self, names: list[str]) -> dict[str, dict | None]:
        """status.json for many sandboxes at once, best-effort + concurrent. Each
        read is a host-side file read (never a guest exec); a failure yields ``None``
        for that one, so a single unreadable status can't blank the whole list."""

        async def one(name: str) -> tuple[str, dict | None]:
            try:
                return name, await self._runtime.read_status(name)
            except Exception:  # noqa: BLE001 — a bad read must not break the list
                return name, None

        return dict(await asyncio.gather(*(one(n) for n in names)))

    async def image_status(self) -> dict:
        """Per-runtime build signal for the Images panel: the active image's baked
        versions joined with the latest floors + a server-computed ``build_available``
        (active strictly behind a floor). Best-effort — a docker hiccup yields null
        actives (⇒ build_available False). Shape mirrors ``ImageStatusOut``."""
        active = await self._active_image_versions()
        latest = await latest_versions()
        enabled = bool(latest.get("enabled"))
        runtimes: list[dict] = []
        for agent_type in ("openclaw", "ironclaw", "hermes"):
            active_rt, active_comp = active.get(agent_type, (None, None))
            lv = latest.get(agent_type) or {}
            latest_rt = lv.get("runtime") or {"latest": None, "source": None}
            latest_comp = lv.get("component") or {"latest": None, "source": None}
            build_available = enabled and (
                is_outdated(active_rt, latest_rt.get("latest"))
                or is_outdated(active_comp, latest_comp.get("latest"))
            )
            runtimes.append(
                {
                    "agent_type": agent_type,
                    "active_runtime_version": active_rt,
                    "active_component_version": active_comp,
                    "latest_runtime": latest_rt,
                    "latest_component": latest_comp,
                    "build_available": build_available,
                }
            )
        return {"enabled": enabled, "fetched_at": latest.get("fetched_at"), "runtimes": runtimes}

    async def list_fleet(self, *, state: SandboxState | None = None) -> list[FleetEntry]:
        infos = await self._runtime.list_sandboxes()
        metrics = {m.name: m for m in await self._runtime.metrics()}
        managed = {s.sandbox_id: s for s in await self._store.list()}
        active = await self._active_image_versions()  # one resolve for the whole list
        # Each agent's volunteered status → the version-based upgrade signal, read
        # concurrently host-side (no N+1 of detail fetches).
        statuses = await self._read_statuses([info.name for info in infos])
        entries: list[FleetEntry] = []
        for info in infos:
            rec = managed.get(info.name)
            agent_type = infer_type(info.image, rec.profile if rec else None)
            image_version, upgrade_available = _version_signal(
                agent_type, statuses.get(info.name), active
            )
            entries.append(
                FleetEntry(
                    sandbox_id=info.name,
                    image=info.image,
                    state=info.state,
                    created_at=info.created_at,
                    profile=rec.profile if rec else None,
                    tenant=rec.tenant if rec else None,
                    managed=rec is not None,
                    metrics=metrics.get(info.name),
                    agent_type=agent_type,
                    color=rec.color if rec else None,
                    upgrade_available=upgrade_available,
                    image_version=image_version,
                    desired_state=rec.desired_state if rec else None,
                    restart_policy=rec.restart_policy if rec else None,
                    restart_count=rec.restart_count if rec else 0,
                    last_restart_at=rec.last_restart_at if rec else None,
                )
            )
        # The list is otherwise purely runtime-driven, so a managed record with no
        # live container would vanish from the dashboard entirely.
        live = {info.name for info in infos}
        for rec in sorted(managed.values(), key=lambda r: r.sandbox_id):
            if rec.sandbox_id in live:
                continue
            entries.append(
                FleetEntry(
                    sandbox_id=rec.sandbox_id,
                    image=rec.image or "",
                    state=rec.state,
                    created_at=rec.created_at,
                    profile=rec.profile,
                    tenant=rec.tenant,
                    managed=True,
                    agent_type=infer_type(rec.image or "", rec.profile),
                    color=rec.color,
                    desired_state=rec.desired_state,
                    restart_policy=rec.restart_policy,
                    restart_count=rec.restart_count,
                    last_restart_at=rec.last_restart_at,
                )
            )
        if state is not None:
            entries = [e for e in entries if e.state is state]
        return entries

    async def get_detail(self, sandbox_id: str) -> SandboxDetail:
        state = await self._runtime.status(sandbox_id)
        if state is SandboxState.DESTROYED:
            rec = await self._store.get(sandbox_id)
            if rec is None:
                raise SandboxNotFound(sandbox_id)  # drift / genuinely gone
            return _record_detail(rec)
        raw = await self._runtime.inspect(sandbox_id)
        cfg = raw.get("config", raw) if isinstance(raw, dict) else {}
        rec = await self._store.get(sandbox_id)
        full_env = _env_dict(cfg)
        image = _image_ref(cfg) or sandbox_id
        url = rec.url if rec else None
        terminal_url = rec.terminal_url if rec else None
        agent_type = infer_type(image, rec.profile if rec else None)
        at = AGENT_TYPES.get(agent_type)
        profile = at.profile() if at is not None and at.enabled else None
        status = await self._runtime.read_status(sandbox_id)
        active = await self._active_image_versions()
        image_version, upgrade_available = _version_signal(agent_type, status, active)
        return SandboxDetail(
            sandbox_id=sandbox_id,
            image=image,
            state=state,
            cpus=cfg.get("cpus"),
            memory_mib=cfg.get("memory_mib"),
            command=_command(cfg),
            env=redact_env(_reef_managed_env(full_env, profile)),
            network=_network(cfg),
            mounts=_mounts(cfg),
            profile=rec.profile if rec else None,
            tenant=rec.tenant if rec else None,
            created_at=rec.created_at if rec else None,
            updated_at=rec.updated_at if rec else None,
            managed=rec is not None,
            port=rec.port if rec else None,
            url=url,
            agent_type=agent_type,
            color=rec.color if rec else None,
            upgrade_available=upgrade_available,
            image_version=image_version,
            desired_state=rec.desired_state if rec else None,
            restart_policy=rec.restart_policy if rec else None,
            restart_count=rec.restart_count if rec else 0,
            last_restart_at=rec.last_restart_at if rec else None,
            access=_access_info(agent_type, full_env, url, terminal_url),
            status=status,
            # From the RECORD, never from the guest env: REEF_CAPS in a running
            # container is what it booted with, which goes stale the moment an
            # operator PATCHes the grant. A drift VM has no record, so ().
            capabilities=rec.capabilities if rec else (),
        )

    async def reveal_access(self, sandbox_id: str) -> AccessInfo | None:
        """Admin-gated password RE-reveal for an exposed agent (the deliberate
        opt-in reversal of the one-time-reveal posture ``get_detail`` upholds).

        Reef never persists the access secret, so ``get_detail`` yields
        ``password=None`` — but the running guest still carries it in its env.
        This reads it back (via the profile's ``reveal_secret``) and returns the
        FULL access (URLs + password), so an operator who lost the create-time
        password can recover it instead of destroy+recreate. The caller
        (``POST /fleet/{id}/reveal``) sits behind ``admin_auth`` like every fleet
        route. ``None`` when the agent is unknown-typed or not exposed (nothing to
        reveal); raises ``SandboxNotFound`` for a destroyed/absent sandbox."""
        state = await self._runtime.status(sandbox_id)
        if state is SandboxState.DESTROYED:
            raise SandboxNotFound(sandbox_id)
        raw = await self._runtime.inspect(sandbox_id)
        cfg = raw.get("config", raw) if isinstance(raw, dict) else {}
        rec = await self._store.get(sandbox_id)
        full_env = _env_dict(cfg)  # unredacted — we deliberately read the secret
        image = _image_ref(cfg) or sandbox_id
        agent_type = infer_type(image, rec.profile if rec else None)
        at = AGENT_TYPES.get(agent_type)
        if at is None:
            return None
        profile = at.profile()
        try:
            secret = profile.reveal_secret(full_env)
            return profile.access_info(
                full_env,
                url=rec.url if rec else None,
                terminal_url=rec.terminal_url if rec else None,
                secret=secret,
            )
        except ValueError, KeyError:
            return None

    async def resolve_surface(self, digest: str, *, secret: str) -> tuple[str, str, int] | None:
        """Map an unguessable surface digest (``reef.exposure.surface_digest``,
        used by the API's ``/s/{digest}/`` proxy) back to
        ``(sandbox_id, surface, host_port)``. O(fleet) per call — fine at Reef
        scale, and keeps the digest un-enumerable (no reverse index at rest)."""
        for rec in await self._store.list():
            for surface, port in (("ui", rec.port), ("terminal", rec.terminal_port)):
                if port is not None and surface_digest(secret, rec.sandbox_id, surface) == digest:
                    return rec.sandbox_id, surface, port
        return None

    async def logs(self, sandbox_id: str, *, tail: int = 200, since: str | None = None) -> str:
        """Captured stdout/stderr, with the agent's user-env VALUES substituted for
        ``***``; an undeterminable set returns the log unchanged, not blanked."""
        text = await self._runtime.logs(sandbox_id, tail=tail, since=since)
        return _redact_values(text, await self._redaction_values(sandbox_id))

    async def _redaction_values(self, sandbox_id: str) -> tuple[str, ...]:
        """Memoised for ``_LOG_REDACT_TTL``. Cannot go stale in the direction that
        matters: ``set_env`` drops the entry on every write, and a read failure
        keeps the last known values rather than dropping them."""
        cached = self._redaction_cache.get(sandbox_id)
        now = monotonic()
        if cached is not None and now < cached[0]:
            return cached[1]
        try:
            values = await self._user_env_values(sandbox_id)
        except Exception:  # noqa: BLE001 - observability must not depend on this working
            return cached[1] if cached is not None else ()
        self._redaction_cache[sandbox_id] = (now + _LOG_REDACT_TTL, values)
        return values

    async def _user_env_values(self, sandbox_id: str) -> tuple[str, ...]:
        """An unreadable baked env yields the empty set, NOT "everything": treating
        every baked value as the operator's would substitute ``/usr/local/bin`` out
        of every log line."""
        cfg = await self._inspect_config(sandbox_id)
        image = _image_ref(cfg) or sandbox_id
        image_baked = await self._runtime.image_env(image)
        if not image_baked:
            return ()
        # A wrong guess here can only ADD reef's own values to the redaction set.
        at = AGENT_TYPES.get(infer_type(image, None))
        profile = at.profile() if at is not None and at.enabled else None
        values = set(_user_env_layer(_injected_env(_env_dict(cfg), image_baked), profile).values())
        for record in await self._runtime.read_guest_env(sandbox_id) or ():
            if record.op == "s":
                values.add(record.value)
        values.update(self._retired_env_values.get(sandbox_id, ()))
        return tuple(v for v in values if v)

    def _retire_env_values(self, sandbox_id: str, previous: Collection[str]) -> None:
        """Keep covering the values an agent is about to STOP having. Insertion order
        is age order, and re-retiring must not refresh a position or one rotated key
        would pin the whole budget."""
        kept = dict.fromkeys(self._retired_env_values.get(sandbox_id, ()))
        for value in previous:
            if value and len(value) >= _LOG_REDACT_MIN_LEN:
                kept.setdefault(value, None)
        self._retired_env_values[sandbox_id] = tuple(kept)[-_MAX_RETIRED_ENV_VALUES:]

    async def create(
        self,
        agent_type: str,
        *,
        image: str | None = None,
        name: str | None = None,
        cpus: float | None = None,
        memory_mib: int | None = None,
        tenant: str | None = None,
        org_id: str | None = None,
        clawbits_url: str | None = None,
        signup_token: str | None = None,
        openai_api_key: str | None = None,
        anthropic_api_key: str | None = None,
        gemini_api_key: str | None = None,
        nearai_api_key: str | None = None,
        openrouter_api_key: str | None = None,
        ollama_host: str | None = None,
        provider: str | None = None,
        model: str | None = None,
        restart_policy: str | None = None,
        env: dict[str, str] | None = None,
        capabilities: list[str] | None = None,
    ) -> tuple[Sandbox, Exposure]:
        """Create + expose a new agent VM of ``agent_type``. Detached by default
        (no clawbits identity); pass ``org_id`` + required ``clawbits_url`` +
        ``signup_token`` (a one-time ``human-…`` token from the Clawbits "Add
        agent" prompt) to wire it to a Clawbits org — the agent enrolls itself
        on boot with the token, no approval step. The per-request provider
        values (``*_api_key`` / ``ollama_host``, all optional) are injected
        under their guest env vars (``OPENAI_API_KEY`` … ``OPENROUTER_API_KEY``
        … ``OLLAMA_HOST``) so
        those models work out of the box; ``provider`` picks which REEF-LEVEL
        value (maintainer-configured ``REEF_*``) to forward instead — see
        ``reef.providers.resolve_creds`` for the precedence rules. ``model``
        (optional; REQUIRED for ollama) rides into the guest as
        ``REEF_DEFAULT_MODEL``. A host-local ``ollama_host`` is normalized to
        this runtime's host alias and folded into the egress allowlist, same
        as ``clawbits_url``. ``env`` is extra caller-supplied guest env
        (validated; reserved/REEF_* keys rejected) baked into the container
        only — like the access secret it is never persisted by reef: it
        survives stop/start/self-heal, but a destroyed agent must be recreated
        with it re-supplied, and it is ignored when the name matches an
        existing managed sandbox. ``capabilities`` grants opt-in capabilities
        (see ``reef.capabilities``); OMITTING it applies
        ``DEFAULT_CAPABILITIES``, while an explicit ``[]`` grants nothing.
        Returns the stored sandbox and its one-time
        access (URL + password — for Hermes that's the dashboard proxy's
        basic-auth secret, minted once and never recomputable, see
        ``HermesProfile``). Raises ``ValueError`` for an unknown /
        not-yet-available type, an unknown/unsupported provider, a provider
        pick with no value from either source, an ollama create without a
        model, or invalid ``env``.
        """
        if self._manager is None:
            raise RuntimeError("FleetService.create requires a SandboxManager")
        at = AGENT_TYPES.get(agent_type)
        if at is None:
            raise ValueError(f"unknown agent type {agent_type!r}")
        if not at.enabled:
            raise ValueError(f"agent type {agent_type!r} is not available yet")
        profile = at.profile()
        # Optional image override: boot a specific tag instead of the type's active
        # image. Validate it exists AND is an image of this agent type (so a
        # reef-ic image can't be booted under the openclaw profile, or vice versa),
        # then point the profile at it.
        if image is not None:
            match = next((i for i in await self._runtime.list_images() if i.tag == image), None)
            if match is None:
                raise ValueError(f"unknown image {image!r}")
            if match.agent_type != agent_type:
                raise ValueError(f"image {image!r} is a {match.agent_type} image, not {agent_type}")
            profile.image = image
        user_env = _validate_user_env(env, managed=_managed_keys(profile))
        # None (field omitted) ⇒ the defaults; an explicit list — INCLUDING [] —
        # ⇒ exactly that. Both frontends always send the field when the reef
        # advertises it, so an unticked box really does produce a bare agent.
        caps = _normalize_caps(
            DEFAULT_CAPABILITIES if capabilities is None else capabilities
        )  # 422 on an unknown name, before any I/O
        # Auto-named VMs get a Docker-style ``adjective-noun`` — unique against the
        # names the runtime already knows (managed + drift), so the create can't clash.
        taken: set[str] = set()
        if name is None:
            taken = {info.name for info in await self._runtime.list_sandboxes()}
        sandbox_id = _new_name(name, taken)
        defaults = Limits()
        limits = Limits(cpus=cpus or defaults.cpus, memory_mb=memory_mib or defaults.memory_mb)
        creds: dict[str, str] = {}
        if org_id:
            endpoint = (clawbits_url or "").strip()
            if not endpoint:
                raise ValueError("clawbits_url is required when org_id is set")
            creds["org_id"] = org_id
            creds["endpoint"] = _normalize_local_endpoint(endpoint, self._manager.backend)
            if signup_token:
                creds["signup_token"] = signup_token
        creds.update(
            resolve_creds(
                provider,
                {
                    "openai_api_key": openai_api_key,
                    "anthropic_api_key": anthropic_api_key,
                    "gemini_api_key": gemini_api_key,
                    "nearai_api_key": nearai_api_key,
                    "openrouter_api_key": openrouter_api_key,
                    "ollama_host": ollama_host,
                },
                agent_type=agent_type,
            )
        )
        # Model choice (→ REEF_DEFAULT_MODEL). Resolved AFTER creds so the
        # ollama-requires-a-model rule sees the reef-level host too.
        effective_model = resolve_model(model, creds)
        if effective_model:
            creds["model"] = effective_model
        # Normalize the RESOLVED ollama host (it may come from REEF_OLLAMA_HOST,
        # e.g. localhost on the reef box) onto this runtime's host alias, exactly
        # like the clawbits endpoint — and fold it into the egress allowlist.
        if creds.get("ollama_host"):
            creds["ollama_host"] = _normalize_local_endpoint(
                creds["ollama_host"], self._manager.backend
            )
        policy = _parse_restart_policy(restart_policy)
        # creds carries it to the profile's build_env (→ REEF_CAPS in the guest);
        # the kwarg persists it on the record. Both, deliberately: the guest needs
        # it at boot, the operator needs it to still be answerable a month later.
        if caps:
            creds["capabilities"] = ",".join(caps)
        exposure = await self._manager.expose(
            sandbox_id,
            profile,
            creds,
            limits=limits,
            tenant=tenant,
            net_allow=_net_allow_union(clawbits_url, creds.get("ollama_host")),
            user_env=user_env,
            restart_policy=policy,
            capabilities=caps,
        )
        sandbox = await self._store.get(sandbox_id)
        if sandbox is None:  # expose() persists before returning — defensive
            raise RuntimeUnavailable(f"sandbox {sandbox_id} vanished after create")
        return sandbox, exposure

    async def start(self, sandbox_id: str) -> SandboxState:
        if await self._runtime.status(sandbox_id) is SandboxState.DESTROYED:
            return await self._rebuild(sandbox_id)
        await self._runtime.start(sandbox_id)
        # Manual start = operator wants it up; clear any crash-loop backoff.
        await self._sync(
            sandbox_id,
            state=SandboxState.RUNNING,
            desired=DesiredState.RUNNING,
            reset_restarts=True,
        )
        return SandboxState.RUNNING

    async def stop(self, sandbox_id: str) -> SandboxState:
        if await self._runtime.status(sandbox_id) is SandboxState.DESTROYED:
            raise SandboxNotFound(sandbox_id)
        await self._runtime.stop(sandbox_id)
        # Record intent STOPPED so the reconciler won't revive a deliberate stop.
        await self._sync(sandbox_id, state=SandboxState.STOPPED, desired=DesiredState.STOPPED)
        return SandboxState.STOPPED

    async def restart(self, sandbox_id: str) -> SandboxState:
        """Stop then start in place — both runtime calls are idempotent, so this
        also revives a stopped/failed VM. Works on drift (lifecycle is by name)."""
        if await self._runtime.status(sandbox_id) is SandboxState.DESTROYED:
            return await self._rebuild(sandbox_id)
        await self._runtime.stop(sandbox_id)
        await self._runtime.start(sandbox_id)
        # Read the state back instead of asserting RUNNING because ``start`` did not
        # raise. A container can accept ``start`` and still fail to come up - most
        # relevantly here, the entrypoint parses the env overlay at boot, so a file
        # it cannot read is a boot failure, and asserting RUNNING is how "your
        # credential is live" gets reported for an agent that never saw it.
        #
        # This closes the loop against the CONTAINER, not against the guest having
        # consumed the file: confirming that needs a receipt the entrypoint writes
        # to the workspace volume, which is an image change.
        observed = await self._runtime.status(sandbox_id)
        await self._sync(
            sandbox_id,
            state=observed,
            desired=DesiredState.RUNNING,
            reset_restarts=True,
        )
        return observed

    async def _rebuild(self, sandbox_id: str) -> SandboxState:
        """Re-run the create half of a failed recreate, on the SAME image and volumes.
        No record ⇒ drift or genuinely gone, so that still 404s."""
        rec = await self._store.get(sandbox_id)
        if rec is None or self._manager is None:
            raise SandboxNotFound(sandbox_id)
        lock = self._env_lock(sandbox_id)
        try:
            async with lock:
                rec = await self._manager.rebuild(sandbox_id)
        finally:
            self._locks.pop(sandbox_id, None)
        await self._sync(
            sandbox_id, state=rec.state, desired=DesiredState.RUNNING, reset_restarts=True
        )
        return rec.state

    async def destroy(self, sandbox_id: str) -> None:
        """Managed sandboxes route through ``SandboxManager.destroy`` so
        ``exposure.unpublish`` runs: a surviving nginx block plus a re-allocatable
        port would proxy this agent's subdomain to whichever tenant binds it next."""
        rec = await self._store.get(sandbox_id)
        if self._manager is not None and rec is not None:
            await self._manager.destroy(sandbox_id)  # runtime.destroy + unpublish + store.delete
        else:
            await self._runtime.destroy(sandbox_id)
            await self._store.delete(sandbox_id)
        # The overlay outlives destroy+recreate (an upgrade goes through destroy);
        # a TRUE delete is the one place it must go.
        try:
            await self._runtime.remove_guest_env(sandbox_id)
        except Exception:  # noqa: BLE001 - the sandbox is already gone; this is cleanup
            pass
        # Only when nobody HOLDS it: popping a held lock lets the next caller build
        # a fresh one and run concurrently with the holder.
        lock = self._locks.get(sandbox_id)
        if lock is not None and not lock.locked():
            self._locks.pop(sandbox_id, None)
        self._redaction_cache.pop(sandbox_id, None)
        self._retired_env_values.pop(sandbox_id, None)

    def _env_lock(self, sandbox_id: str) -> asyncio.Lock:
        """Take the per-sandbox mutation lock, or raise ``SandboxBusy`` (→ 409).
        Rejects rather than queues, so the entry can be dropped on release. The
        caller's ``async with`` must stay await-free after this returns."""
        lock = self._locks.get(sandbox_id)
        if lock is None:
            lock = self._locks[sandbox_id] = asyncio.Lock()
        if lock.locked():
            raise SandboxBusy(f"{sandbox_id} is busy: another env apply or upgrade is in flight")
        return lock

    async def _replay_context(
        self, rec: Sandbox, *, require_baked: bool = True
    ) -> tuple[dict[str, str], Limits, dict[str, str]]:
        """``require_baked`` raises ``RuntimeUnavailable`` (→ 503) on an empty baked
        map: every real image bakes at least PATH, so empty means the inspect
        failed, and treating every baked var as reef-injected is destructive."""
        cfg = await self._inspect_config(rec.sandbox_id)
        return await self._replay_from_config(cfg, rec.image, require_baked=require_baked)

    async def _replay_from_config(
        self, cfg: dict, image: str, *, require_baked: bool
    ) -> tuple[dict[str, str], Limits, dict[str, str]]:
        """Lets a drift VM resolve its image from the config rather than a record it
        lacks."""
        image_baked = await self._runtime.image_env(image)
        if require_baked and not image_baked:
            raise RuntimeUnavailable(
                f"can't read the baked env of image {image!r}; refusing to guess which "
                "vars reef injected"
            )
        # Minus the OLD image's baked ENV, so a stale REEF_IMAGE_VERSION does not
        # ride onto the new image and pin the reported version.
        injected = _injected_env(_env_dict(cfg), image_baked)
        limits = Limits(
            cpus=float(cfg.get("cpus") or Limits().cpus),
            memory_mb=int(cfg.get("memory_mib") or Limits().memory_mb),
        )
        return injected, limits, image_baked

    async def _inspect_config(self, sandbox_id: str) -> dict:
        raw = await self._runtime.inspect(sandbox_id)
        return raw.get("config", raw) if isinstance(raw, dict) else {}

    async def upgrade(self, sandbox_id: str) -> Sandbox:
        """Recreate the agent on the newest image (the active ``REEF_OPENCLAW_IMAGE``
        tag) in place.

        Survives: the named volumes (workspace + the config volume holding the
        clawbits identity) and the access password, replayed out of the running
        container. Does NOT survive: everything on the container rootfs -
        ``~/.openclaw``, sqlite state, sessions, device identity, skills installed
        post-boot - and a fresh onboard re-pins the model.

        Raises ``SandboxNotFound`` (unknown / drift), ``ValueError`` → 422 (type
        can't be upgraded), or ``SandboxBusy`` → 409."""
        if self._manager is None:
            raise RuntimeUnavailable("creating/recreating VMs needs a SandboxManager")
        rec = await self._store.get(sandbox_id)
        if rec is None:
            # Not in the store ⇒ drift (hand-created) or gone. Reef can only
            # recreate sandboxes it manages (it owns their volumes + ports).
            raise SandboxNotFound(sandbox_id)
        lock = self._env_lock(sandbox_id)
        try:
            async with lock:
                return await self._upgrade_locked(rec)
        finally:
            self._locks.pop(sandbox_id, None)

    async def _upgrade_locked(self, rec: Sandbox) -> Sandbox:
        sandbox_id = rec.sandbox_id
        if self._manager is None:  # re-checked: the caller checks before locking
            raise RuntimeUnavailable("creating/recreating VMs needs a SandboxManager")
        agent_type = infer_type(rec.image, rec.profile)
        at = AGENT_TYPES.get(agent_type)
        if at is None or not at.enabled:
            raise ValueError(f"agent type {agent_type!r} cannot be upgraded")
        # The rebuilt profile's image is the CURRENT active tag (REEF_OPENCLAW_IMAGE)
        # — i.e. whatever the latest build promoted. Recreating against it adopts it.
        profile = at.profile()
        if await self._runtime.status(sandbox_id) is SandboxState.DESTROYED:
            # No container to inspect, so the parked rebuild spec stands in for the
            # replay - the only escape when the pinned image is what will not start.
            pending = await self._manager.pending_spec(sandbox_id)
            if pending is None:
                raise RuntimeUnavailable(
                    f"{sandbox_id} has no container and reef holds no rebuild spec for it, so "
                    "there is no env to carry onto the new image: the credentials and access "
                    "secret it ran with lived in the container that is gone. Delete this agent "
                    "and create it again."
                )
            injected, limits = dict(pending.env), pending.limits
        else:
            injected, limits, _baked = await self._replay_context(rec, require_baked=False)
        # The overlay wins over the create-time -e layer, as it does at boot;
        # replaying `injected` alone would re-pin every value edited since create.
        injected = _apply_env_overlay(
            injected, await self._runtime.read_guest_env(sandbox_id), profile
        )
        return await self._manager.recreate_with_image(
            sandbox_id,
            profile,
            self._recreate_env(injected, rec),
            limits=limits,
            net_allow=_recreate_net_allow(injected),
        )

    @staticmethod
    def _recreate_env(injected: dict[str, str], rec: Sandbox) -> dict[str, str]:
        """Capabilities are the ONE thing not taken from the container: the RECORD is
        authoritative, so a grant or revoke since the last boot takes effect here
        instead of being overwritten by a stale REEF_CAPS - which is why an empty
        grant still writes an explicit empty value. ``_DANGEROUS_ENV_KEYS`` are
        dropped, so the next recreate cleans up whatever the old create hole let in."""
        replayed = {k: v for k, v in injected.items() if k not in _DANGEROUS_ENV_KEYS}
        return {**replayed, **_caps_to_env(rec.capabilities)}

    async def _env_context(self, sandbox_id: str, *, require_baked: bool = True) -> _EnvContext:
        """ "Current" is the create-time ``-e`` layer with the overlay FILE applied
        over it, which is what the guest computes at boot."""
        state = await self._runtime.status(sandbox_id)
        rec = await self._store.get(sandbox_id)
        if state is SandboxState.DESTROYED:
            if rec is None:
                raise SandboxNotFound(sandbox_id)  # drift / genuinely gone
            # No create-time ``-e`` layer to inspect, so reef cannot say what the
            # agent's env IS. Without the parked spec both start and upgrade 503.
            if self._manager is None or await self._manager.pending_spec(sandbox_id) is None:
                raise RuntimeUnavailable(
                    f"{sandbox_id} has no container and reef holds no rebuild spec for it, so "
                    "neither start nor upgrade can bring it back: the env it ran with - its "
                    "credentials and its access secret - lived in the container that is gone. "
                    "Delete this agent and create it again."
                )
            raise RuntimeUnavailable(
                f"{sandbox_id} has no container right now: a recreate destroyed the old one and "
                "failed to build the new one. Its volumes and its env file are intact. Start it "
                "to rebuild it on the same image with the env it had, or upgrade it onto the "
                "active image; then re-read its env before editing it."
            )
        cfg = await self._inspect_config(sandbox_id)
        image = (rec.image if rec else "") or _image_ref(cfg) or sandbox_id
        agent_type = infer_type(image, rec.profile if rec else None)
        at = AGENT_TYPES.get(agent_type)
        profile = at.profile() if at is not None and at.enabled else None
        injected, limits, image_baked = await self._replay_from_config(
            cfg, image, require_baked=require_baked
        )
        # ``image_env`` shells to DOCKER even on the msb prod box, so an image
        # absent from the local docker store lands here. Writes stay strict.
        degraded = not image_baked
        container_user = {} if degraded else _user_env_layer(injected, profile)
        managed = _managed_keys(profile)
        current = dict(container_user)
        file_keys: set[str] = set()
        file_tiers: dict[str, str] = {}
        file_records = await self._runtime.read_guest_env(sandbox_id)
        for record in file_records or ():
            if not _is_user_env_key(record.key, managed):
                continue
            if record.op == "u":
                current.pop(record.key, None)
                file_keys.discard(record.key)
                file_tiers.pop(record.key, None)
            else:
                current[record.key] = record.value
                file_keys.add(record.key)
                file_tiers[record.key] = record.tier
        return _EnvContext(
            sandbox_id=sandbox_id,
            state=state,
            rec=rec,
            profile=profile,
            injected=injected,
            limits=limits,
            container_user=container_user,
            current=current,
            file_keys=frozenset(file_keys),
            file_tiers=file_tiers,
            file_records=tuple(file_records) if file_records is not None else None,
            degraded=degraded,
            # RAW live container env, never the image's - see ``_supports_env_file``.
            supports_env_file=_supports_env_file(_env_dict(cfg)),
        )

    async def get_env(self, sandbox_id: str) -> GuestEnvView:
        """Key names + value LENGTHS for the agent's user env, never values."""
        # The one lenient caller: a read that 503s on a failed `docker image
        # inspect` would take the whole feature down fleet-wide.
        ctx = await self._env_context(sandbox_id, require_baked=False)
        reason = "drift" if ctx.rec is None else ("unreadable-image" if ctx.degraded else None)
        return GuestEnvView(
            sandbox_id=sandbox_id,
            vars=_env_vars_out(ctx.current, ctx.file_keys, ctx.file_tiers),
            editable=reason is None,
            editable_reason=reason,
            complete=not ctx.degraded,
            apply_modes=("restart", "recreate") if ctx.supports_env_file else ("recreate",),
            state=ctx.state.value,
            desired_state=ctx.rec.desired_state.value
            if ctx.rec and ctx.rec.desired_state
            else None,
        )

    async def set_env(
        self,
        sandbox_id: str,
        *,
        set_vars: dict[str, str],
        unset_keys: Sequence[str] = (),
        apply: str = "restart",
        tiers: Mapping[str, str] | None = None,
    ) -> EnvApplyResult:
        """Apply a diff to the agent's user env. ``apply``:

        ``restart`` - write the overlay, then stop/start in place; the container
        rootfs survives. 422 when the image predates the env-file reader.
        ``recreate`` - destroy+recreate on the agent's CURRENT image, never the
        active tag: an env save must not smuggle in an image upgrade.
        ``none`` - write only; the guest picks it up on its next boot.

        A deliberate stop is respected, and a no-op touches nothing."""
        if apply not in _ENV_APPLY_MODES:
            raise ValueError(
                f"invalid apply {apply!r}; expected one of: {', '.join(_ENV_APPLY_MODES)}"
            )
        lock = self._env_lock(sandbox_id)
        try:
            async with lock:
                return await self._set_env_locked(
                    sandbox_id,
                    set_vars=set_vars,
                    unset_keys=unset_keys,
                    apply=apply,
                    tiers=tiers,
                )
        finally:
            self._locks.pop(sandbox_id, None)

    async def _set_env_locked(
        self,
        sandbox_id: str,
        *,
        set_vars: dict[str, str],
        unset_keys: Sequence[str],
        apply: str,
        tiers: Mapping[str, str] | None = None,
    ) -> EnvApplyResult:
        ctx = await self._env_context(sandbox_id)
        if ctx.rec is None:  # drift: reef can neither recreate it nor claim its mounts
            raise SandboxNotFound(sandbox_id)
        managed = _managed_keys(ctx.profile)
        _validate_user_env(set_vars, managed=managed)
        removed = set(unset_keys)
        both = sorted(set(set_vars) & removed)
        if both:
            # "Set to empty" is `set: {"K": ""}`, a different, real state.
            raise ValueError(f"env key(s) {', '.join(both)} are in both set and unset; pick one")
        for key in unset_keys:
            if len(key) > _ENV_MAX_KEY_LEN or not _ENV_KEY_RE.match(key):
                raise ValueError(
                    f"invalid env key {key!r}: use letters, digits, '_'; must not start with a digit"
                )
            _reject_reserved_key(key, managed)
            if key not in ctx.current:
                raise ValueError(f"env key {key!r} is not set on this agent")
        result = {k: v for k, v in ctx.current.items() if k not in removed}
        result.update(set_vars)
        _validate_env_totals(result)  # count + bytes against the RESULT, not the delta
        _validate_written_env(result, set_vars)
        tier_map = _resolve_env_tiers(
            result,
            current_tiers=ctx.file_tiers,
            known_keys=ctx.current,
            requested=tiers or {},
            set_keys=set_vars,
        )
        # A tier-only change (secret <-> regular, same value) is a REAL change, so
        # the no-op short-circuit has to compare tiers too or it would swallow it.
        current_tiers = {k: ctx.file_tiers.get(k, "secret") for k in ctx.current}

        if result == ctx.current and tier_map == current_tiers:
            # Before the image gate, so a retry against an old image reports the
            # truth instead of a 422 about a change it isn't making.
            return EnvApplyResult(
                sandbox_id=sandbox_id,
                changed=False,
                applied="none",
                takes_effect="now" if ctx.state is SandboxState.RUNNING else "on_next_start",
                state=ctx.state.value,
                vars=_env_vars_out(ctx.current, ctx.file_keys, ctx.file_tiers),
            )
        if not ctx.supports_env_file and apply != "recreate":
            # The gate is on the WRITE, not the restart: a container without the
            # reader has no env mount either, so apply="none" is the worst option.
            raise ValueError(
                "this agent is running an image that predates the in-place env file: it has "
                "neither the entrypoint reader nor the env mount, so reef would be writing a "
                "file the guest can never read. Run upgrade first (one recreate now, in-place "
                'restarts forever after), or retry with apply="recreate" (which destroys '
                "~/.openclaw - config, sessions and device identity - and re-pins the model)"
            )

        # Only the container that will RUN the file gets one: on a pre-feature image
        # it would be an unconsumable plaintext credential at rest.
        wrote_file = ctx.supports_env_file
        touched_file = wrote_file  # whether the undo below has anything to undo
        if wrote_file:
            records = [
                EnvRecord(op="s", key=k, value=v, tier=tier_map[k]) for k, v in result.items()
            ]
            if apply != "recreate":
                # Explicit removals for keys the create-time -e layer still carries;
                # a recreate instead rebuilds that layer as exactly ``result``.
                records += [EnvRecord(op="u", key=k) for k in ctx.container_user if k not in result]
            await self._runtime.write_guest_env(sandbox_id, records)
        elif ctx.file_records:
            # A file from before a downgrade, already folded into ``result``;
            # leaving it would let the next upgrade resurrect stale records. Cleared
            # rather than deleted: ``remove_guest_env`` drops a live mount source.
            touched_file = True
            await self._runtime.write_guest_env(sandbox_id, [])
        # Retire what this save supersedes FIRST, or the recomputed set loses it.
        self._retire_env_values(sandbox_id, set(ctx.current.values()) - set(result.values()))
        self._redaction_cache.pop(sandbox_id, None)

        state = ctx.state
        applied, takes_effect = "none", "on_next_start"
        # A deliberate stop is respected: the file is written, the agent stays down.
        deliberately_stopped = ctx.rec.desired_state is DesiredState.STOPPED
        try:
            if apply == "recreate":
                rec = await self._recreate_for_env(ctx, result)
                state = rec.state
                applied = "recreate"
                takes_effect = "now" if state is SandboxState.RUNNING else "on_next_start"
            elif (
                apply == "restart"
                and not deliberately_stopped
                and ctx.state is SandboxState.RUNNING
            ):
                state = await self.restart(sandbox_id)
                applied = "restart"
                # Same honesty rule as the recreate branch above: the agent has the
                # new env "now" only if it actually came back up.
                takes_effect = "now" if state is SandboxState.RUNNING else "on_next_start"
        except BaseException as exc:
            # Without the undo the retry is a NO-OP: it now equals ``ctx.current``
            # and short-circuits, leaving the agent on the OLD env. Guarded, or the
            # restore would create the very file the branch above declined to write.
            undone = not touched_file or await self._restore_guest_env(sandbox_id, ctx.file_records)
            if isinstance(exc, Exception) and apply == "recreate":
                rec = await self._store.get(sandbox_id)
                if rec is not None and rec.handle is None:
                    # The overlay outranks the -e layer the rebuild replays, so a
                    # failed undo means the save is PENDING, not rolled back.
                    raise RuntimeUnavailable(
                        f"the env change was NOT applied - it has been rolled back in full - but "
                        f"the recreate had already destroyed the container: {exc}. Start the "
                        "agent to rebuild it with the env it had before this save."
                        if undone
                        else f"the env change never reached the agent, and reef could not undo the "
                        f"overlay file it had already written: {exc}. It is now PENDING - it will "
                        "take effect when the agent comes back. Start the agent, then re-read its "
                        "env and set it to what you want."
                    ) from exc
            raise
        return EnvApplyResult(
            sandbox_id=sandbox_id,
            changed=True,
            applied=applied,
            takes_effect=takes_effect,
            state=state.value,
            vars=_env_vars_out(
                result, frozenset(result) if wrote_file else frozenset(), tier_map
            ),
        )

    async def _restore_guest_env(
        self, sandbox_id: str, previous: tuple[EnvRecord, ...] | None
    ) -> bool:
        """Returns whether the restore landed. ``None`` (no file before) restores as
        an EMPTY record set, not a delete: ``remove_guest_env`` drops the live
        container's mount source, and a record-less file reads as a missing one."""
        try:
            await self._runtime.write_guest_env(sandbox_id, list(previous or ()))
            return True
        except Exception:  # noqa: BLE001 - never mask the real cause
            return False
        finally:
            self._redaction_cache.pop(sandbox_id, None)

    async def _recreate_for_env(self, ctx: _EnvContext, result: dict[str, str]) -> Sandbox:
        """Pinned to the agent's CURRENT image - not ``upgrade``, which would ship an
        unrequested image change on every env save."""
        if self._manager is None:
            raise RuntimeUnavailable("recreating VMs needs a SandboxManager")
        rec = ctx.rec
        if rec is None or ctx.profile is None:
            raise ValueError("this agent's type cannot be recreated")
        profile = ctx.profile
        profile.image = rec.image
        base = {k: v for k, v in ctx.injected.items() if k not in ctx.container_user}
        env = {**base, **result}
        # What the destroyed container HAD. Recovery must restore this and not
        # ``env``, or a save the operator was told failed goes live on the next start.
        before = {**base, **ctx.current}
        return await self._manager.recreate_with_image(
            rec.sandbox_id,
            profile,
            self._recreate_env(env, rec),
            limits=ctx.limits,
            net_allow=_recreate_net_allow(env),
            rollback_env=self._recreate_env(before, rec),
            rollback_net_allow=_recreate_net_allow(before),
        )

    async def set_color(self, sandbox_id: str, color: str) -> Sandbox:
        """Persist the operator-chosen dashboard accent (managed sandboxes only)."""
        return await self.update_settings(sandbox_id, color=color)

    async def update_settings(
        self,
        sandbox_id: str,
        *,
        color: str | None = None,
        restart_policy: str | None = None,
        capabilities: list[str] | None = None,
    ) -> Sandbox:
        """Patch operator-editable settings on a managed sandbox: dashboard ``color``,
        self-healing ``restart_policy``, and/or granted ``capabilities``. Only the
        provided fields change. Drift VMs (no store record) and invalid values raise
        ``ValueError``.

        NOTE on ``capabilities``: this updates reef's record, which is the source of
        truth the operator UI shows and which ``upgrade`` replays into the guest. It
        does NOT reach into a running VM - the guest reads ``REEF_CAPS`` once at boot,
        and reef cannot rewrite a live container's env. So a capability change lands
        on the agent's next upgrade/recreate, and callers should say so rather than
        implying it took effect immediately. Passing ``[]`` explicitly REVOKES
        everything (distinct from omitting the field, which leaves it unchanged)."""
        rec = await self._store.get(sandbox_id)
        if rec is None:
            raise ValueError(f"{sandbox_id} is not a managed sandbox")
        if color is not None:
            if color not in AGENT_COLORS:
                raise ValueError(
                    f"invalid color {color!r}; expected one of: {', '.join(AGENT_COLORS)}"
                )
            rec.color = color
        if restart_policy is not None:
            rec.restart_policy = _parse_restart_policy(restart_policy)
        if capabilities is not None:
            rec.capabilities = _normalize_caps(capabilities)
        rec.updated_at = _now()
        await self._store.put(rec)
        return rec

    async def _sync(
        self,
        sandbox_id: str,
        *,
        state: SandboxState,
        desired: DesiredState | None = None,
        reset_restarts: bool = False,
    ) -> None:
        """Keep Reef's record in step after a control action (no-op for drift).
        Optionally records the new operator ``desired`` intent and clears backoff."""
        rec = await self._store.get(sandbox_id)
        if rec is None:
            return
        rec.state = state
        if desired is not None:
            rec.desired_state = desired
        if reset_restarts:
            rec.restart_count = 0
            rec.last_restart_at = None
        rec.updated_at = _now()
        await self._store.put(rec)
