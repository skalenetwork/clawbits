"""The admin/fleet read+control layer.

Merges the live runtime view (``msb``/``docker``) with Reef's own per-sandbox
metadata, redacts secrets out of inspect output, exposes lifecycle control over
any sandbox on the host (including drift), and creates new detached agent VMs.
This is what the Reef-owned admin/fleet API (and the operator UI) calls. Stays
tenant-agnostic; never imports clawbits.
"""

import asyncio
import re
from collections.abc import Collection
from dataclasses import dataclass
from datetime import UTC, datetime
from urllib.parse import urlparse, urlunparse

from reef.agents import AGENT_TYPES, infer_type
from reef.capabilities import DEFAULT_CAPABILITIES
from reef.capabilities import normalize as _normalize_caps
from reef.capabilities import to_env as _caps_to_env
from reef.errors import RuntimeUnavailable, SandboxNotFound
from reef.exposure import Exposure, surface_digest
from reef.manager import SandboxManager
from reef.models import Sandbox
from reef.names import random_name
from reef.profiles import AccessInfo
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
    | {p.guest_env for p in PROVIDERS}
    | {"OLLAMA_BASE_URL"}
)

# Operator-selectable dashboard accent colours. The first is the default look
# (None ⇒ fall back to the agent-type tint, which is this red for OpenClaw).
AGENT_COLORS: tuple[str, ...] = ("red", "green", "blue", "orange", "yellow", "violet")


def redact_env(env: dict[str, str]) -> dict[str, str]:
    """Mask the values of secret-looking env vars, preserving key names."""
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
    """Full per-sandbox view for the detail drawer. ``env`` is already redacted;
    ``access`` is the deliberate type-scoped reveal (URL + password)."""

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
    upgrade_available: bool = False  # agent reported versions behind the active image (server-computed)
    image_version: str | None = None  # truthful "what's running" stack string; None if unreported
    desired_state: DesiredState | None = None
    restart_policy: RestartPolicy | None = None
    restart_count: int = 0
    last_restart_at: datetime | None = None
    access: AccessInfo | None = None
    status: dict | None = None  # agent-volunteered telemetry (versions, …); None if unreported
    capabilities: tuple[str, ...] = ()  # granted opt-in capabilities (managed only)


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
    except (ValueError, KeyError):
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
    if host.startswith(("10.", "192.168.", "172.16.", "172.17.", "172.18.", "172.19.", "172.2", "172.30.", "172.31.")):
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


def _validate_user_env(env: dict[str, str] | None) -> dict[str, str] | None:
    """Validate caller-supplied env for a new VM; raises ``ValueError`` (→ 422).
    Returns a defensive copy, or ``None`` when empty/absent."""
    if not env:
        return None
    if len(env) > _ENV_MAX_COUNT:
        raise ValueError(f"too many env vars ({len(env)}); max {_ENV_MAX_COUNT}")
    for key, value in env.items():
        if len(key) > _ENV_MAX_KEY_LEN or not _ENV_KEY_RE.match(key):
            raise ValueError(
                f"invalid env key {key!r}: use letters, digits, '_'; must not start with a digit"
            )
        if key in RESERVED_ENV_KEYS or key.startswith(_RESERVED_ENV_PREFIX):
            raise ValueError(f"env key {key!r} is managed by reef; use the dedicated create fields")
        if len(value) > _ENV_MAX_VALUE_LEN:
            raise ValueError(
                f"env value for {key!r} too long ({len(value)} chars); max {_ENV_MAX_VALUE_LEN}"
            )
        # A NUL can't ride exec argv — it would 500 deep in create_subprocess_exec.
        if "\x00" in value:
            raise ValueError(f"env value for {key!r} contains a NUL byte")
    return dict(env)


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
        if state is not None:
            entries = [e for e in entries if e.state is state]
        return entries

    async def get_detail(self, sandbox_id: str) -> SandboxDetail:
        state = await self._runtime.status(sandbox_id)
        if state is SandboxState.DESTROYED:
            raise SandboxNotFound(sandbox_id)
        raw = await self._runtime.inspect(sandbox_id)
        cfg = raw.get("config", raw) if isinstance(raw, dict) else {}
        rec = await self._store.get(sandbox_id)
        full_env = _env_dict(cfg)
        image = _image_ref(cfg) or sandbox_id
        url = rec.url if rec else None
        terminal_url = rec.terminal_url if rec else None
        agent_type = infer_type(image, rec.profile if rec else None)
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
            env=redact_env(full_env),
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
        except (ValueError, KeyError):
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
        return await self._runtime.logs(sandbox_id, tail=tail, since=since)

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
                raise ValueError(
                    f"image {image!r} is a {match.agent_type} image, not {agent_type}"
                )
            profile.image = image
        user_env = _validate_user_env(env)  # fail fast, before any runtime round-trip
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
            raise SandboxNotFound(sandbox_id)
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
            raise SandboxNotFound(sandbox_id)
        await self._runtime.stop(sandbox_id)
        await self._runtime.start(sandbox_id)
        await self._sync(
            sandbox_id,
            state=SandboxState.RUNNING,
            desired=DesiredState.RUNNING,
            reset_restarts=True,
        )
        return SandboxState.RUNNING

    async def destroy(self, sandbox_id: str) -> None:
        await self._runtime.destroy(sandbox_id)
        await self._store.delete(sandbox_id)

    async def upgrade(self, sandbox_id: str) -> Sandbox:
        """Recreate the agent on the newest image (the active ``REEF_OPENCLAW_IMAGE``
        tag) in place. Lossless: the named volumes survive (workspace + the config
        volume where the entrypoint persists the clawbits identity), and the access
        password is replayed — so the operator keeps the same URL, password, and
        clawbits identity. Brief downtime during destroy→recreate; the reconciler
        holds off while the record is CREATING.

        Raises ``SandboxNotFound`` (unknown / drift — not reef-managed) or
        ``ValueError`` → 422 (type can't be upgraded)."""
        if self._manager is None:
            raise RuntimeUnavailable("creating/recreating VMs needs a SandboxManager")
        rec = await self._store.get(sandbox_id)
        if rec is None:
            # Not in the store ⇒ drift (hand-created) or gone. Reef can only
            # recreate sandboxes it manages (it owns their volumes + ports).
            raise SandboxNotFound(sandbox_id)
        agent_type = infer_type(rec.image, rec.profile)
        at = AGENT_TYPES.get(agent_type)
        if at is None or not at.enabled:
            raise ValueError(f"agent type {agent_type!r} cannot be upgraded")
        # The rebuilt profile's image is the CURRENT active tag (REEF_OPENCLAW_IMAGE)
        # — i.e. whatever the latest build promoted. Recreating against it adopts it.
        profile = at.profile()

        # Replay the live container's RAW env (unredacted — get_detail masks it),
        # minus the OLD image's baked ENV, so only reef-injected vars (creds,
        # gateway token, exposure, user env) land on the new image and a stale
        # REEF_IMAGE_VERSION doesn't pin the reported version.
        raw = await self._runtime.inspect(sandbox_id)
        cfg = raw.get("config", raw) if isinstance(raw, dict) else {}
        container_env = _env_dict(cfg)
        image_baked = await self._runtime.image_env(rec.image)
        injected = {k: v for k, v in container_env.items() if image_baked.get(k) != v}

        limits = Limits(
            cpus=float(cfg.get("cpus") or Limits().cpus),
            memory_mb=int(cfg.get("memory_mib") or Limits().memory_mb),
        )
        # Same union as create: dropping the ollama rule here would strand the
        # agent's LLM after every image upgrade on msb (host egress is opt-in).
        # OLLAMA_BASE_URL is IronClaw's spelling of the same host, and
        # CLAWBITS_BASE_URL is Hermes' spelling of the clawbits endpoint
        # (profiles.py) — dropping it would cut a Hermes agent off from a
        # host-local clawbits on every upgrade.
        net_allow = _net_allow_union(
            injected.get("CLAWBITS_ENDPOINT"),
            injected.get("CLAWBITS_BASE_URL"),
            injected.get("OLLAMA_HOST"),
            injected.get("OLLAMA_BASE_URL"),
        )
        # Capabilities are the ONE thing we do not replay from the container: the
        # RECORD is authoritative, so a PATCH that granted or revoked something
        # since the last boot actually takes effect here rather than being
        # overwritten by the stale REEF_CAPS the old container was started with.
        # This is also why an empty grant still writes an explicit empty value —
        # a revoke has to be able to reach the guest.
        injected.update(_caps_to_env(rec.capabilities))
        return await self._manager.recreate_with_image(
            sandbox_id, profile, injected, limits=limits, net_allow=net_allow
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
