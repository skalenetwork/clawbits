"""In-memory ``AgentRuntime`` for tests and dev without a hypervisor."""

from collections.abc import Sequence

from reef.guest_env import EnvRecord
from reef.runtime import SandboxSpec, SandboxState


class FakeRuntime:
    """Tracks per-handle state in a dict, with deterministic handles for
    assertions. Records every spec passed to ``create`` in ``self.created``.
    """

    def __init__(self) -> None:
        self._state: dict[str, SandboxState] = {}
        self.created: list[SandboxSpec] = []
        self.host_ports: set[int] = set()  # seed to simulate ports already bound on the host
        self.guest_env: dict[str, list[EnvRecord]] = {}

    async def create(self, spec: SandboxSpec) -> str:
        handle = f"fake://{spec.sandbox_id}"
        self._state[handle] = SandboxState.CREATING
        self.created.append(spec)
        return handle

    async def start(self, handle: str) -> None:
        self._state[handle] = SandboxState.RUNNING

    async def stop(self, handle: str) -> None:
        self._state[handle] = SandboxState.STOPPED

    async def destroy(self, handle: str) -> None:
        self._state[handle] = SandboxState.DESTROYED

    async def status(self, handle: str) -> SandboxState:
        return self._state.get(handle, SandboxState.DESTROYED)

    async def read_guest_env(self, handle: str) -> list[EnvRecord] | None:
        return self.guest_env.get(handle)

    async def write_guest_env(self, handle: str, records: Sequence[EnvRecord]) -> None:
        self.guest_env[handle] = list(records)

    async def remove_guest_env(self, handle: str) -> None:
        self.guest_env.pop(handle, None)

    async def used_host_ports(self) -> set[int]:
        return set(self.host_ports)
