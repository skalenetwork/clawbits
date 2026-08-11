"""Pydantic wire models for the admin/fleet API + mappers from the internal
fleet dataclasses. Keeping the wire shape separate from the domain dataclasses
(and from msb's native shape) lets the API evolve independently.
"""

from datetime import datetime

from pydantic import BaseModel

from reef.build_jobs import BuildJob
from reef.fleet import FleetEntry, Mount, NetworkPolicy, SandboxDetail
from reef.image_ops import BuildImageSpec, ImageInfo
from reef.profiles import AccessInfo
from reef.runtime import MetricsSample


class MetricsOut(BaseModel):
    name: str
    cpu_percent: float
    memory_bytes: int
    memory_limit_bytes: int
    disk_read_bytes: int
    disk_write_bytes: int
    net_rx_bytes: int
    net_tx_bytes: int
    uptime_secs: float


class FleetEntryOut(BaseModel):
    sandbox_id: str
    image: str
    state: str
    agent_type: str = "unknown"
    created_at: datetime | None = None
    profile: str | None = None
    tenant: str | None = None
    managed: bool
    metrics: MetricsOut | None = None
    color: str | None = None  # operator-chosen dashboard accent; null ⇒ agent-type default
    # Version-based upgrade signal (server-computed): the agent's reported running
    # versions vs the active image's baked versions for its runtime. ``image_version``
    # is the truthful "what's running" stack string (oc<oc>-pl<pl> / ic<ic>-ch<ch>),
    # null until the agent reports; ``upgrade_available`` ⇒ strictly behind.
    upgrade_available: bool = False
    image_version: str | None = None
    desired_state: str | None = None  # operator intent (managed only)
    restart_policy: str | None = None  # always | on-failure | never (managed only)
    restart_count: int = 0
    last_restart_at: datetime | None = None


class NetworkOut(BaseModel):
    enabled: bool
    default_egress: str
    default_ingress: str
    egress_allow: list[str]


class MountOut(BaseModel):
    source: str
    dest: str
    type: str
    readonly: bool


class AccessOut(BaseModel):
    """How to reach/use an exposed agent — deliberately includes the password
    (the admin dashboard is the trusted operator surface)."""

    kind: str
    url: str | None = None
    password: str | None = None
    terminal_url: str | None = None  # scoped web-terminal URL (same password)


class SandboxDetailOut(BaseModel):
    sandbox_id: str
    image: str
    state: str
    agent_type: str = "unknown"
    cpus: float | None = None
    memory_mib: int | None = None
    command: str | None = None
    env: dict[str, str]
    network: NetworkOut
    mounts: list[MountOut]
    profile: str | None = None
    tenant: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None
    managed: bool
    port: int | None = None
    url: str | None = None
    color: str | None = None  # operator-chosen dashboard accent; null ⇒ agent-type default
    upgrade_available: bool = False  # reported versions behind the active image (server-computed)
    image_version: str | None = None  # truthful "what's running" stack string; null if unreported
    desired_state: str | None = None  # operator intent (managed only)
    restart_policy: str | None = None  # always | on-failure | never (managed only)
    restart_count: int = 0
    last_restart_at: datetime | None = None
    access: AccessOut | None = None
    status: dict | None = None  # agent-volunteered telemetry (versions, …); None if unreported
    # Opt-in capabilities granted to this agent (reef.capabilities). Always a list,
    # never null: [] means "nothing granted", which is a real answer, not missing
    # data. Managed sandboxes only — a drift VM reports [].
    capabilities: list[str] = []


class CreateSandboxIn(BaseModel):
    type: str
    # Boot a specific image tag (e.g. "reef-ic:0.2.3") instead of the agent
    # type's active image. Must be an image of ``type`` (validated) — GET /images
    # lists the choices with their ``agent_type``. Omitted ⇒ the active image.
    image: str | None = None
    name: str | None = None
    cpus: float | None = None
    memory_mib: int | None = None
    # OpenClaw/Hermes: wire the new VM to a Clawbits org. Pass ``signup_token``
    # (a one-time ``human-…`` token copied from the Clawbits "Add agent" prompt)
    # so the agent enrolls itself on boot — no approval step. ``clawbits_url``
    # is required when ``org_id`` is set; Reef does not infer production/staging.
    org_id: str | None = None
    clawbits_url: str | None = None
    signup_token: str | None = None
    # Optional provider values, injected under their guest env vars
    # (OPENAI_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY / NEARAI_API_KEY /
    # OPENROUTER_API_KEY / OLLAMA_HOST — the runtimes read them natively;
    # IronClaw's ollama spelling is mapped in its profile, OpenClaw's nearai
    # wiring lives in its entrypoint). Leave unset to add a model later in the
    # agent's Control UI.
    # ``ollama_host`` must be a plain http(s) URL (no user:pass@); a host-local
    # one (localhost / a runtime alias) is normalized for THIS reef's runtime
    # and allowed through the guest's egress rules.
    openai_api_key: str | None = None
    anthropic_api_key: str | None = None
    gemini_api_key: str | None = None
    nearai_api_key: str | None = None
    openrouter_api_key: str | None = None
    ollama_host: str | None = None
    # Which reef-level (maintainer-configured, REEF_*) provider value to
    # forward: a provider id from GET /providers, or "none". Omitted = forward
    # ALL configured reef-level API keys (legacy callers predate the picker;
    # endpoint-kind providers are never forwarded implicitly). The explicit
    # fields above always win for their provider.
    provider: str | None = None
    # Per-agent default model (→ REEF_DEFAULT_MODEL in the guest, applied on
    # fresh boot only). Optional — the runtime's own default applies — EXCEPT
    # for ollama, which has no sane default: an ollama create without a model
    # (and without REEF_OLLAMA_DEFAULT_MODEL on the reef host) is a 422.
    model: str | None = None
    # Self-healing policy for the reconciler: always | on-failure | never (default
    # on-failure). Changeable later via PATCH.
    restart_policy: str | None = None
    # Custom guest env baked into the new VM at LOWEST precedence (reef-managed
    # wiring always wins); keys reef manages (CLAWBITS_*, the gateway/exposure
    # keys, model keys) and the REEF_* prefix are rejected → 422. Applied on
    # first create only and never persisted by reef: it lives in the container
    # env (secret-named keys value-masked in fleet detail) and survives
    # restarts, but a destroyed agent must be recreated with it re-supplied.
    env: dict[str, str] | None = None
    # Opt-in capabilities for this agent (reef.capabilities): currently "gh" and
    # "cron". OMITTED ⇒ reef.capabilities.DEFAULT_CAPABILITIES (today: "gh");
    # an explicit [] ⇒ nothing. The two are deliberately NOT the same — both UIs
    # send the field whenever the reef advertises it, so an unticked box means a
    # bare agent, while an older/scripted caller that never heard of capabilities
    # gets the defaults. Unknown names are a 422 rather than being dropped, so the
    # UI can never claim a capability the agent didn't get.
    # NOT settable through ``env`` above: every capability toggle is a REEF_* var
    # and that prefix is reserved, so an agent cannot self-grant one.
    capabilities: list[str] | None = None


class CreateSandboxOut(BaseModel):
    sandbox_id: str
    state: str
    agent_type: str
    access: AccessOut | None = None


class PatchSandboxIn(BaseModel):
    """Operator-editable settings; only the provided fields change. ``color`` ∈
    ``reef.fleet.AGENT_COLORS``; ``restart_policy`` ∈ ``always|on-failure|never``
    (both validated in the service).

    ``capabilities`` replaces the whole granted set (``[]`` revokes everything;
    omitting the field leaves it untouched). It updates reef's record — the guest
    reads REEF_CAPS at boot, so the change reaches the agent on its next
    upgrade/recreate, NOT immediately. Surface that in the UI."""

    color: str | None = None
    restart_policy: str | None = None
    capabilities: list[str] | None = None


class SandboxPatchOut(BaseModel):
    sandbox_id: str
    color: str | None = None
    restart_policy: str | None = None
    capabilities: list[str] = []


class LogsOut(BaseModel):
    sandbox_id: str
    lines: list[str]


class ActionOut(BaseModel):
    sandbox_id: str
    state: str


class ReconcilerHealth(BaseModel):
    """Self-healing loop liveness for monitoring (systemd watchdog / external probe).
    ``healthy`` goes False when the loop hasn't completed a pass in too long."""

    enabled: bool
    interval_secs: float
    last_pass_at: datetime | None = None
    seconds_since_pass: float | None = None
    passes: int = 0
    restarts: int = 0  # cumulative reconciler-driven restarts since process start
    last_error: str | None = None
    healthy: bool = True


class HealthOut(BaseModel):
    status: str
    msb_available: bool
    sandboxes: int | None = None
    reconciler: ReconcilerHealth | None = None  # null when disabled (REEF_RECONCILE=0)


class ProviderOut(BaseModel):
    """One AI provider reef can wire into an agent VM. ``configured`` reports
    ONLY the presence of a reef-level value (REEF_*) - never the value itself."""

    id: str
    label: str
    configured: bool
    # api_key (secret, masked everywhere) | endpoint (a URL, e.g. ollama —
    # the picker asks for a host instead of a key, and MUST also collect a
    # model: ollama creates without one are rejected).
    kind: str = "api_key"
    # Agent types whose images can consume this provider — drives per-runtime
    # enable/disable in the pickers; the create validates it server-side too.
    runtimes: list[str] = []


class OllamaModelOut(BaseModel):
    """One model pulled on the probed Ollama server (`GET /api/tags`)."""

    id: str  # the ollama tag, e.g. "llama3.2:latest" — what the create's `model` takes
    size: int | None = None  # bytes on disk, when reported
    parameter_size: str | None = None  # e.g. "8.0B", when reported


class OllamaModelsOut(BaseModel):
    models: list[OllamaModelOut]


class OpenRouterModelOut(BaseModel):
    """One model in OpenRouter's live catalog (public listing, reef-proxied)."""

    id: str  # the vendor/model slug, e.g. "openai/gpt-5.4" — what `model` takes
    name: str | None = None  # display name, e.g. "OpenAI: GPT-5.4"
    context_length: int | None = None  # tokens, when reported


class OpenRouterModelsOut(BaseModel):
    models: list[OpenRouterModelOut]


class ProvidersOut(BaseModel):
    providers: list[ProviderOut]
    # Create-API capability flags ("env", "model"), so an always-newer clawbits
    # frontend can detect what THIS self-hosted reef accepts instead of having
    # an older Pydantic silently drop an unknown create field. Older reefs omit
    # the field entirely (callers treat absent as "none").
    features: list[str] = []


class SettingsOut(BaseModel):
    """Operator-adjustable settings. Today: the public URL the agent surface
    links (Control UI / terminal) are built on. ``override`` wins over the
    ``REEF_PUBLIC_URL`` env var; ``effective`` is what's actually used (override,
    else env, else the request origin at call time)."""

    public_url_override: str | None = None  # operator-set (settings.json)
    public_url_env: str | None = None  # from REEF_PUBLIC_URL (read-only, for display)
    public_url_effective: str | None = None  # override or env; null ⇒ request origin


class SettingsIn(BaseModel):
    # A public URL to pin (http/https), or null/blank to clear the override and
    # fall back to REEF_PUBLIC_URL / the request origin.
    public_url: str | None = None


class LatestVersionOut(BaseModel):
    latest: str | None = None
    source: str | None = None  # where the value came from; null when unavailable


class RuntimeLatestOut(BaseModel):
    """Latest floors for one runtime: the engine (runtime) + the clawbits component."""

    runtime: LatestVersionOut  # openclaw npm / ironclaw self-built (null)
    component: LatestVersionOut  # clawbits plugin / channel floor


class LatestVersionsOut(BaseModel):
    """Latest available versions per runtime for the dashboard's "update available"
    hints. Best-effort: outbound checks are gated by REEF_VERSION_CHECK. Sources are
    public registries — npm for the OpenClaw engine, ClawHub for the clawbits plugin
    (the same places a build pulls from). IronClaw's floors are null (engine
    self-built; channel ships from this tree) until the channel is published, and
    Hermes' floors are null too (engine from the pinned base image; plugin ships
    from this tree)."""

    enabled: bool
    fetched_at: str | None = None
    openclaw: RuntimeLatestOut
    ironclaw: RuntimeLatestOut
    hermes: RuntimeLatestOut


class RuntimeImageStatusOut(BaseModel):
    """One runtime's build signal: the active image's baked versions joined with the
    latest floors + a server-computed ``build_available`` (active strictly behind)."""

    agent_type: str
    active_runtime_version: str | None = None
    active_component_version: str | None = None
    latest_runtime: LatestVersionOut
    latest_component: LatestVersionOut
    build_available: bool = False


class ImageStatusOut(BaseModel):
    """Per-runtime build availability for the Images panel (the server owns the
    semver; clients render the boolean + the from→to versions)."""

    enabled: bool
    fetched_at: str | None = None
    runtimes: list[RuntimeImageStatusOut]


def metrics_out(m: MetricsSample | None) -> MetricsOut | None:
    if m is None:
        return None
    return MetricsOut(
        name=m.name,
        cpu_percent=m.cpu_percent,
        memory_bytes=m.memory_bytes,
        memory_limit_bytes=m.memory_limit_bytes,
        disk_read_bytes=m.disk_read_bytes,
        disk_write_bytes=m.disk_write_bytes,
        net_rx_bytes=m.net_rx_bytes,
        net_tx_bytes=m.net_tx_bytes,
        uptime_secs=m.uptime_secs,
    )


def access_out(a: AccessInfo | None) -> AccessOut | None:
    if a is None:
        return None
    return AccessOut(kind=a.kind, url=a.url, password=a.password, terminal_url=a.terminal_url)


def fleet_entry_out(e: FleetEntry) -> FleetEntryOut:
    return FleetEntryOut(
        sandbox_id=e.sandbox_id,
        image=e.image,
        state=e.state.value,
        agent_type=e.agent_type,
        created_at=e.created_at,
        profile=e.profile,
        tenant=e.tenant,
        managed=e.managed,
        metrics=metrics_out(e.metrics),
        color=e.color,
        upgrade_available=e.upgrade_available,
        image_version=e.image_version,
        desired_state=e.desired_state.value if e.desired_state else None,
        restart_policy=e.restart_policy.value if e.restart_policy else None,
        restart_count=e.restart_count,
        last_restart_at=e.last_restart_at,
    )


def _network_out(n: NetworkPolicy) -> NetworkOut:
    return NetworkOut(
        enabled=n.enabled,
        default_egress=n.default_egress,
        default_ingress=n.default_ingress,
        egress_allow=list(n.egress_allow),
    )


def _mount_out(m: Mount) -> MountOut:
    return MountOut(source=m.source, dest=m.dest, type=m.type, readonly=m.readonly)


def sandbox_detail_out(d: SandboxDetail) -> SandboxDetailOut:
    return SandboxDetailOut(
        sandbox_id=d.sandbox_id,
        image=d.image,
        state=d.state.value,
        agent_type=d.agent_type,
        cpus=d.cpus,
        memory_mib=d.memory_mib,
        command=d.command,
        env=d.env,
        network=_network_out(d.network),
        mounts=[_mount_out(m) for m in d.mounts],
        profile=d.profile,
        tenant=d.tenant,
        created_at=d.created_at,
        updated_at=d.updated_at,
        managed=d.managed,
        port=d.port,
        url=d.url,
        color=d.color,
        upgrade_available=d.upgrade_available,
        image_version=d.image_version,
        desired_state=d.desired_state.value if d.desired_state else None,
        restart_policy=d.restart_policy.value if d.restart_policy else None,
        restart_count=d.restart_count,
        last_restart_at=d.last_restart_at,
        access=access_out(d.access),
        status=d.status,
        capabilities=list(d.capabilities),
    )


# ── Images (the dashboard's Images section) ───────────────────────────────────
class ImageOut(BaseModel):
    tag: str
    image_id: str
    created_at: datetime | None = None
    size_bytes: int
    reef_image_version: str | None = None  # baked derived stack LABEL; null on pre-label images
    runtime_version: str | None = None  # openclaw | ironclaw engine version (baked LABEL)
    component_version: str | None = None  # clawbits plugin | channel version (baked LABEL)
    is_active: bool  # this image is what new agents (and upgrades) of its type boot
    agent_type: str = "openclaw"  # openclaw | ironclaw — which runtime this image is


class BuildImageIn(BaseModel):
    # runtime/component overrides apply to OpenClaw only; IronClaw derives them
    # from source. force_fresh=true ⇒ full --no-cache; default = smart cache
    # (base layers cached, plugin/channel re-resolved). See image_ops.BuildImageSpec.
    agent_type: str = "openclaw"  # which runtime to build (openclaw | ironclaw)
    runtime_version: str | None = None  # engine base-tag override; null ⇒ Dockerfile default
    component_version: str | None = None  # clawbits plugin pin; null ⇒ resolve latest
    force_fresh: bool = False


class ActivateImageIn(BaseModel):
    tag: str  # an existing reef-oc:* / reef-ic:* tag to re-point its runtime's active tag at


class BuildJobOut(BaseModel):
    id: str
    status: str  # running | succeeded | failed
    error: str | None = None
    started_at: datetime
    finished_at: datetime | None = None
    agent_type: str = "openclaw"
    runtime_version: str | None = None  # engine base-tag override, when set
    component_version: str | None = None  # clawbits plugin pin, when set
    log: list[str]


def image_out(i: ImageInfo) -> ImageOut:
    return ImageOut(
        tag=i.tag,
        image_id=i.image_id,
        created_at=i.created_at,
        size_bytes=i.size_bytes,
        reef_image_version=i.reef_image_version,
        runtime_version=i.runtime_version,
        component_version=i.component_version,
        is_active=i.is_active,
        agent_type=i.agent_type,
    )


def build_image_spec(payload: BuildImageIn) -> BuildImageSpec:
    return BuildImageSpec(
        agent_type=payload.agent_type,
        runtime_version=payload.runtime_version,
        component_version=payload.component_version,
        force_fresh=payload.force_fresh,
    )


def build_job_out(j: BuildJob) -> BuildJobOut:
    return BuildJobOut(
        id=j.id,
        status=j.status,
        error=j.error,
        started_at=j.started_at,
        finished_at=j.finished_at,
        agent_type=j.spec.agent_type,
        runtime_version=j.spec.runtime_version,
        component_version=j.spec.component_version,
        log=list(j.lines),
    )
