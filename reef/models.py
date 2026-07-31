"""Reef's own persisted state. This is NOT a clawbits model — Reef owns this
schema and stays tenant-agnostic.
"""

from dataclasses import dataclass
from datetime import datetime

from reef.runtime import DesiredState, RestartPolicy, SandboxState


@dataclass
class Sandbox:
    """One agent's microVM, as Reef tracks it.

    ``sandbox_id`` is an opaque ref supplied by the caller (clawbits passes the
    agent_id). ``tenant`` is an opaque tag for metering/limits — Reef never
    resolves it against clawbits' database.
    """

    sandbox_id: str
    profile: str
    backend: str
    state: SandboxState
    image: str
    volume: str
    handle: str | None = None
    tenant: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None
    port: int | None = None  # host port forwarded to the agent's UI (when exposed)
    url: str | None = None  # public URL of the agent's Control UI (when exposed)
    terminal_port: int | None = (
        None  # host port forwarded to the scoped web terminal (when exposed)
    )
    terminal_url: str | None = None  # public URL of the scoped web terminal (when exposed)
    color: str | None = None  # operator-chosen accent for the dashboard; None ⇒ agent-type default
    # DEPRECATED — unused since the upgrade signal became version-based (agent
    # status.json vs the active image's baked versions; see fleet._version_signal).
    # Kept as a nullable column to avoid a store migration; no longer written or
    # read, so it stays None on agents created after that change.
    created_image_id: str | None = None
    # Self-healing: the reconciler drives the sandbox toward ``desired_state`` per
    # ``restart_policy``; ``restart_count`` / ``last_restart_at`` gate crash-loop backoff.
    desired_state: DesiredState = DesiredState.RUNNING
    restart_policy: RestartPolicy = RestartPolicy.ON_FAILURE
    restart_count: int = 0  # consecutive reconciler-driven restarts (resets once stable)
    last_restart_at: datetime | None = None
