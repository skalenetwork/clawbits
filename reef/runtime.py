"""The runtime seam: WHERE/HOW a sandbox runs (the VMM).

`AgentRuntime` is the swappable boundary — microsandbox today, Cocoon/Kata as
fallbacks. Reef code depends only on this Protocol, never a concrete VMM.

`FleetRuntime` adds the read/observability surface the admin/fleet API needs
(list, metrics, inspect, logs) — kept separate so the lifecycle seam stays
minimal. `MicrosandboxRuntime` satisfies both.
"""

from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from datetime import datetime
from enum import StrEnum
from typing import TYPE_CHECKING, Protocol

if TYPE_CHECKING:
    from reef.image_ops import BuildImageSpec, ImageInfo


class SandboxState(StrEnum):
    """Lifecycle state of a single sandbox (one agent's microVM)."""

    CREATING = "creating"
    RUNNING = "running"
    STOPPED = "stopped"
    FAILED = "failed"
    DESTROYED = "destroyed"


class DesiredState(StrEnum):
    """Operator intent for a sandbox — what the reconciler drives it toward.
    A deliberate stop sets ``STOPPED`` (so the reconciler won't fight it); a crash
    leaves ``RUNNING`` (so the reconciler heals it)."""

    RUNNING = "running"
    STOPPED = "stopped"


class RestartPolicy(StrEnum):
    """How the reconciler reacts to a desired-running sandbox that's down.

    ``NEVER`` — hands-off. ``ON_FAILURE`` — restart only on a crash (``FAILED``:
    non-zero exit / dead). ``ALWAYS`` — restart whenever it's not running.
    """

    ALWAYS = "always"
    ON_FAILURE = "on-failure"
    NEVER = "never"


@dataclass(frozen=True, slots=True)
class Limits:
    """Per-sandbox resource caps enforced by the runtime."""

    cpus: float = 2.0
    memory_mb: int = 2048


@dataclass(frozen=True, slots=True)
class SandboxSpec:
    """A fully-resolved request to run one agent. Built by the manager from an
    `AgentProfile` plus caller-supplied creds; consumed by an `AgentRuntime`.

    Note: ``env`` carries secrets (API keys) — never log it.
    """

    sandbox_id: str
    image: str
    env: dict[str, str]
    volume: str
    init: str | None = None  # microsandbox detached boot handoff; None ⇒ no init override
    volume_dest: str = "/workspace"  # where ``volume`` mounts inside the guest
    # Additional per-agent named volumes, each (volume_name, guest_dest) — e.g.
    # OpenClaw's auth-profile secrets dir. Like ``volume``, these are created
    # idempotently and never auto-removed, so they outlive destroy+recreate.
    extra_volumes: tuple[tuple[str, str], ...] = ()
    net_allow: tuple[str, ...] = ()  # egress allowlist; empty ⇒ no restriction
    ports: tuple[str, ...] = ()  # inbound forwards, each "[BIND:]HOST:GUEST" (-p); empty ⇒ none
    status_dest: str | None = None  # guest path for the agent-volunteered status mount; None ⇒ none
    limits: Limits = field(default_factory=Limits)


@dataclass(frozen=True, slots=True)
class SandboxInfo:
    """One row of the live fleet, as the runtime reports it (``msb list``).
    Runtime-level only — Reef's own metadata (profile, tenant) is merged on top
    by the fleet service.
    """

    name: str
    image: str
    state: SandboxState
    created_at: datetime | None = None


@dataclass(frozen=True, slots=True)
class MetricsSample:
    """Live resource usage for one running sandbox (``msb metrics``)."""

    name: str
    cpu_percent: float = 0.0
    memory_bytes: int = 0
    memory_limit_bytes: int = 0
    disk_read_bytes: int = 0
    disk_write_bytes: int = 0
    net_rx_bytes: int = 0
    net_tx_bytes: int = 0
    uptime_secs: float = 0.0


class AgentRuntime(Protocol):
    """The VMM boundary. Implementations: ``MicrosandboxRuntime`` (prod),
    ``FakeRuntime`` (tests). Lifecycle methods are idempotent; transport
    failures should raise ``RuntimeUnavailable``.
    """

    async def create(self, spec: SandboxSpec) -> str:
        """Create the sandbox (do not start). Returns an opaque handle."""
        ...

    async def start(self, handle: str) -> None:
        """Start a created/stopped sandbox. No-op if already running."""
        ...

    async def stop(self, handle: str) -> None:
        """Stop a running sandbox, preserving its volume. No-op if stopped."""
        ...

    async def destroy(self, handle: str) -> None:
        """Destroy the sandbox. No-op if already gone."""
        ...

    async def status(self, handle: str) -> SandboxState:
        """Return the runtime's view of the sandbox state."""
        ...


class FleetRuntime(Protocol):
    """Read/observability seam over the VMM — what the admin/fleet API needs
    beyond per-sandbox lifecycle. ``MicrosandboxRuntime`` wraps the
    ``msb list/metrics/inspect/logs`` family.
    """

    async def list_sandboxes(self) -> list[SandboxInfo]:
        """Every sandbox the runtime knows about (running or stopped)."""
        ...

    async def metrics(self) -> list[MetricsSample]:
        """Live metrics for all running sandboxes (best-effort)."""
        ...

    async def metrics_for(self, handle: str) -> MetricsSample | None:
        """Live metrics for one sandbox, or ``None`` if it isn't running."""
        ...

    async def inspect(self, handle: str) -> dict:
        """Raw, runtime-native configuration + status for one sandbox."""
        ...

    async def logs(self, handle: str, *, tail: int | None = None, since: str | None = None) -> str:
        """Captured stdout/stderr for one sandbox (newest-last, text)."""
        ...

    async def read_status(self, handle: str) -> dict | None:
        """The agent-volunteered status file (versions, etc.), read host-side from
        the sandbox's status mount. ``None`` if the agent hasn't written one or it's
        unreadable. Never executes anything inside the guest — Reef only reads the
        shared dir the agent writes to."""
        ...

    async def used_host_ports(self) -> set[int]:
        """Host ports currently bound by sandboxes the runtime knows about, so the
        manager never re-allocates a port that's still in use. Reef's in-memory store
        is empty after a restart, but a prior agent's container can still hold its
        ``-p`` binding — and the new bind would fail. Source of truth = the runtime,
        not the store; best-effort (an empty set just falls back to the store)."""
        ...


class ImageRuntime(Protocol):
    """Local agent-image inventory + build — what the dashboard's Images section
    drives. Both backends build with Docker (the universal builder) and the
    microsandbox backend additionally loads the result into the msb store; the
    concrete logic lives in ``reef.image_ops``.
    """

    async def list_images(self) -> list[ImageInfo]:
        """Every local agent image (``reef-oc:*``), newest first."""
        ...

    def build_image(self, spec: BuildImageSpec) -> AsyncIterator[str]:
        """Build a fresh agent image, yielding the build log line-by-line. A
        successful build re-points the floating active tag (auto-promote)."""
        ...

    async def activate_image(self, tag: str) -> None:
        """Re-point the floating active tag at an existing image (rollback /
        manual promote)."""
        ...

    async def image_env(self, image: str) -> dict[str, str]:
        """The ENV an image bakes in — so the upgrade path can subtract it from a
        container's full env and replay only REEF-injected vars."""
        ...


class AdminRuntime(AgentRuntime, FleetRuntime, ImageRuntime, Protocol):
    """A runtime supporting lifecycle, fleet observability, and image management —
    the surface the admin/fleet service drives. ``MicrosandboxRuntime`` satisfies
    it.
    """
