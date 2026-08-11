"""``SandboxManager`` — the facade clawbits calls. Idempotent lifecycle over an
``AgentRuntime`` + a ``SandboxStore``, building specs from an ``AgentProfile``.
"""

import secrets
from collections.abc import Sequence
from datetime import UTC, datetime

from reef.errors import RuntimeUnavailable, SandboxNotFound
from reef.exposure import DirectPortExposure, Exposure, ExposureStrategy
from reef.models import Sandbox
from reef.ports import PortAllocator
from reef.profiles import AgentProfile
from reef.runtime import (
    AgentRuntime,
    DesiredState,
    Limits,
    RestartPolicy,
    SandboxSpec,
    SandboxState,
)
from reef.store import SandboxStore


def _now() -> datetime:
    return datetime.now(UTC)


def _default_volume(sandbox_id: str) -> str:
    return f"reef-{sandbox_id}"


class SandboxManager:
    def __init__(
        self,
        runtime: AgentRuntime,
        store: SandboxStore,
        *,
        backend: str = "microsandbox",
        exposure: ExposureStrategy | None = None,
        port_allocator: PortAllocator | None = None,
    ) -> None:
        self._runtime = runtime
        self._store = store
        self._backend = backend
        self._exposure = exposure or DirectPortExposure()
        self._ports = port_allocator or PortAllocator()

    @property
    def backend(self) -> str:
        """Which runtime CLI this manager drives ("docker" | "microsandbox")."""
        return self._backend

    async def ensure_running(
        self,
        sandbox_id: str,
        profile: AgentProfile,
        creds: dict[str, str],
        *,
        volume: str | None = None,
        limits: Limits | None = None,
        tenant: str | None = None,
        net_allow: Sequence[str] = (),
        ports: Sequence[str] = (),
        extra_env: dict[str, str] | None = None,
        user_env: dict[str, str] | None = None,
        restart_policy: RestartPolicy = RestartPolicy.ON_FAILURE,
        capabilities: Sequence[str] = (),
    ) -> Sandbox:
        """Reconcile the sandbox to RUNNING. Idempotent: missing -> create+start;
        stopped/failed -> start; already running -> no-op. ``ports``/``extra_env``/
        ``user_env`` apply only on first create (a running/stopped sandbox keeps
        what it was created with).
        """
        existing = await self._store.get(sandbox_id)
        if existing is not None and existing.state is SandboxState.RUNNING:
            return existing

        if existing is None:
            # user_env is the BASE layer: profile-managed env (build_env), exposure
            # env (extra_env) and REEF_STATUS_DIR all override it. The fleet service
            # rejects reserved keys up front; this ordering is defense-in-depth.
            env = {**(user_env or {}), **profile.build_env(creds)}
            if extra_env:
                env = {**env, **extra_env}
            # Tell the agent where to write its volunteered status (versions, etc.);
            # the runtime mounts a host dir there for Reef to read host-side.
            env["REEF_STATUS_DIR"] = profile.status_dir
            vol = volume or _default_volume(sandbox_id)
            spec = SandboxSpec(
                sandbox_id=sandbox_id,
                image=profile.image,
                env=env,
                init=getattr(profile, "init", None),
                volume=vol,
                volume_dest=profile.volume_dest,
                # Profile-declared extra mounts, named off the main volume —
                # e.g. ("config", …) ⇒ "reef-<id>-config".
                extra_volumes=tuple(
                    (f"{vol}-{suffix}", dest)
                    for suffix, dest in getattr(profile, "extra_mounts", ())
                ),
                net_allow=tuple(net_allow),
                ports=tuple(ports),
                status_dest=profile.status_dir,
                limits=limits or Limits(),
            )
            handle = await self._runtime.create(spec)
            sandbox = Sandbox(
                sandbox_id=sandbox_id,
                profile=profile.name,
                backend=self._backend,
                capabilities=tuple(capabilities),
                state=SandboxState.CREATING,
                image=spec.image,
                volume=spec.volume,
                handle=handle,
                tenant=tenant,
                created_at=_now(),
                updated_at=_now(),
                desired_state=DesiredState.RUNNING,
                restart_policy=restart_policy,
            )
            await self._store.put(sandbox)
        else:
            sandbox = existing  # exists but stopped/failed -> just (re)start it

        await self._runtime.start(sandbox.handle)
        sandbox.state = SandboxState.RUNNING
        sandbox.updated_at = _now()
        await self._store.put(sandbox)
        return sandbox

    async def expose(
        self,
        sandbox_id: str,
        profile: AgentProfile,
        creds: dict[str, str],
        *,
        password: str | None = None,
        volume: str | None = None,
        limits: Limits | None = None,
        tenant: str | None = None,
        net_allow: Sequence[str] = (),
        user_env: dict[str, str] | None = None,
        restart_policy: RestartPolicy = RestartPolicy.ON_FAILURE,
        capabilities: Sequence[str] = (),
    ) -> Exposure:
        """Ensure the agent is running with its web surfaces reachable, and return
        how to reach them. First creation allocates a host port for the Control UI
        (and, when the profile defines one, a second for the scoped web terminal),
        forwards each host port → its guest port, and bakes in an access secret
        shared by both surfaces.

        The secret is a **one-time random token** minted here at first creation:
        it is baked into the guest env, returned in this ``Exposure`` ONCE, and
        then forgotten. Reef never stores it and cannot recompute it — so re-expose
        (a stop/start) returns an empty password, and ``GET /fleet/{id}`` never
        reveals it. The operator must save it at creation; losing it means
        recreating the agent (reef has no rotate). An explicit ``password``
        overrides (tests / caller-supplied).
        """
        existing = await self._store.get(sandbox_id)
        used = await self._used_ports()
        port = (
            existing.port
            if existing is not None and existing.port is not None
            else self._ports.allocate(used)
        )
        url = self._exposure.url_for(sandbox_id, port, surface="ui")

        # Optional second surface: a scoped web terminal (ttyd) for CLI config.
        terminal_guest = getattr(profile, "terminal_port", None)
        terminal_port: int | None = None
        terminal_url: str | None = None
        if terminal_guest:
            terminal_port = (
                existing.terminal_port
                if existing is not None and existing.terminal_port is not None
                else self._ports.allocate(used | {port})
            )
            terminal_url = self._exposure.url_for(sandbox_id, terminal_port, surface="terminal")

        if existing is None:
            # One-time random secret: minted once, baked into the guest, returned
            # once below, never stored or recomputable. 24 bytes ⇒ 192-bit token.
            # Some profiles expose a dashboard without a static password.
            uses_password = bool(getattr(profile, "exposure_password", True))
            pw = (password or secrets.token_urlsafe(24)) if uses_password else ""
            forwards = [self._exposure.forward(port, profile.ui_port)]
            if terminal_port is not None and terminal_guest:
                forwards.append(self._exposure.forward(terminal_port, terminal_guest))
            sandbox = await self.ensure_running(
                sandbox_id,
                profile,
                creds,
                volume=volume,
                limits=limits,
                tenant=tenant,
                net_allow=net_allow,
                ports=tuple(forwards),
                extra_env=profile.exposure_env(password=pw, public_url=url),
                user_env=user_env,
                restart_policy=restart_policy,
                capabilities=capabilities,
            )
        else:
            # Already created with its -p + secret baked in — just (re)start it.
            # The secret was a one-time reveal at creation; reef didn't keep it, so
            # re-expose returns empty (the operator already saved it, or recreates).
            pw = password or ""
            sandbox = await self.ensure_running(
                sandbox_id,
                profile,
                creds,
                volume=volume,
                limits=limits,
                tenant=tenant,
                net_allow=net_allow,
            )

        # Register routes (no-op for DirectPort): Control UI, then the terminal.
        await self._exposure.publish(sandbox_id, port, surface="ui")
        if terminal_port is not None:
            await self._exposure.publish(sandbox_id, terminal_port, surface="terminal")
        sandbox.port = port
        sandbox.url = url
        sandbox.terminal_port = terminal_port
        sandbox.terminal_url = terminal_url
        sandbox.updated_at = _now()
        await self._store.put(sandbox)
        return Exposure(
            sandbox_id=sandbox_id, url=url, port=port, password=pw, terminal_url=terminal_url
        )

    async def _used_ports(self) -> set[int]:
        # Reef's store ∪ ports actually bound on the host (from the runtime — the
        # source of truth). The in-memory store is empty after a restart, so a fresh
        # process would otherwise re-pick a port a prior agent's container still holds
        # and the `-p` bind would fail. Best-effort: a reconcile hiccup falls back to
        # the store rather than blocking create.
        used: set[int] = set()
        for s in await self._store.list():
            if s.port is not None:
                used.add(s.port)
            if s.terminal_port is not None:
                used.add(s.terminal_port)
        reconcile = getattr(self._runtime, "used_host_ports", None)
        if reconcile is not None:
            try:
                used |= await reconcile()
            except RuntimeUnavailable:
                pass
        return used

    async def recreate_with_image(
        self,
        sandbox_id: str,
        profile: AgentProfile,
        env: dict[str, str],
        *,
        limits: Limits | None = None,
        net_allow: Sequence[str] = (),
    ) -> Sandbox:
        """Upgrade in place: destroy the sandbox and recreate it under the SAME id +
        SAME named volumes against ``profile.image`` (the now-newer active tag),
        replaying ``env`` verbatim.

        Lossless by construction: the per-agent volumes survive destroy, so the
        agent's workspace AND config volume (where the entrypoint persists the
        clawbits identity) carry over; and replaying ``OPENCLAW_GATEWAY_TOKEN``
        reproduces the working access password — reef never had to store it.
        ``env`` MUST be the reef-injected env only (the caller subtracts the old
        image's baked ENV so a stale ``REEF_IMAGE_VERSION`` doesn't ride along).
        Preserves ports, ``desired_state``, color, restart_policy, tenant.
        """
        rec = await self._require(sandbox_id)
        desired = rec.desired_state

        # Re-mint the port forwards from the RECORD: inspect carries no host ports
        # on msb, and the record is reef's source of truth for them.
        forwards: list[str] = []
        if rec.port is not None:
            forwards.append(self._exposure.forward(rec.port, profile.ui_port))
        terminal_guest = getattr(profile, "terminal_port", None)
        if rec.terminal_port is not None and terminal_guest:
            forwards.append(self._exposure.forward(rec.terminal_port, terminal_guest))

        vol = rec.volume or _default_volume(sandbox_id)
        spec = SandboxSpec(
            sandbox_id=sandbox_id,
            image=profile.image,
            env={**env, "REEF_STATUS_DIR": profile.status_dir},
            init=getattr(profile, "init", None),
            volume=vol,
            volume_dest=profile.volume_dest,
            extra_volumes=tuple(
                (f"{vol}-{suffix}", dest) for suffix, dest in getattr(profile, "extra_mounts", ())
            ),
            net_allow=tuple(net_allow),
            ports=tuple(forwards),
            status_dest=profile.status_dir,
            limits=limits or Limits(),
        )

        # Mark CREATING + persist BEFORE destroy: the reconciler never acts on a
        # CREATING record, so it skips the destroy→create gap instead of racing to
        # "heal" the briefly-absent sandbox.
        rec.state = SandboxState.CREATING
        rec.updated_at = _now()
        await self._store.put(rec)

        if rec.handle is not None:
            await self._runtime.destroy(rec.handle)  # named volumes survive
        handle = await self._runtime.create(spec)
        rec.handle = handle
        rec.image = profile.image
        rec.updated_at = _now()
        # Respect a deliberate stop: don't revive an agent the operator stopped.
        if desired is DesiredState.RUNNING:
            await self._runtime.start(handle)
            rec.state = SandboxState.RUNNING
        else:
            rec.state = SandboxState.STOPPED
        await self._store.put(rec)
        return rec

    async def stop(self, sandbox_id: str) -> Sandbox:
        sandbox = await self._require(sandbox_id)
        if sandbox.handle is not None:
            await self._runtime.stop(sandbox.handle)
        sandbox.state = SandboxState.STOPPED
        sandbox.updated_at = _now()
        await self._store.put(sandbox)
        return sandbox

    async def destroy(self, sandbox_id: str) -> None:
        sandbox = await self._store.get(sandbox_id)
        if sandbox is None:
            return
        if sandbox.handle is not None:
            await self._runtime.destroy(sandbox.handle)
        await self._exposure.unpublish(sandbox_id)  # drop the route (no-op if direct/none)
        await self._store.delete(sandbox_id)

    async def get(self, sandbox_id: str) -> Sandbox | None:
        return await self._store.get(sandbox_id)

    async def _require(self, sandbox_id: str) -> Sandbox:
        sandbox = await self._store.get(sandbox_id)
        if sandbox is None:
            raise SandboxNotFound(sandbox_id)
        return sandbox
