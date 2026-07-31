"""In-memory fakes for fleet/API tests — no msb, no microVMs.

``FakeAdminRuntime`` implements the full ``AdminRuntime`` surface from seeded
data, and records lifecycle calls for assertions.
"""

from __future__ import annotations

from datetime import UTC, datetime

from reef.errors import RuntimeUnavailable
from reef.image_ops import BuildImageSpec, ImageInfo, active_tag
from reef.runtime import MetricsSample, SandboxInfo, SandboxSpec, SandboxState


class FakeAdminRuntime:
    def __init__(self) -> None:
        self.states: dict[str, SandboxState] = {}
        self.images: dict[str, str] = {}
        self.created_at: dict[str, datetime] = {}
        self.metrics_data: dict[str, MetricsSample] = {}
        self.inspect_data: dict[str, dict] = {}
        self.logs_data: dict[str, str] = {}
        self.status_data: dict[str, dict] = {}
        self.calls: list[tuple[str, str]] = []  # (op, handle)
        self.created: list[SandboxSpec] = []  # specs passed to create()
        self.host_ports: set[int] = set()  # seed to simulate ports already bound on the host
        # ImageRuntime fakes.
        self.image_list: list[ImageInfo] = []
        self.builds: list[BuildImageSpec] = []  # specs passed to build_image()
        self.build_log: list[str] = ["building…", "done"]
        self.build_should_fail: bool = False
        self.activated: list[str] = []  # tags passed to activate_image()
        self.image_env_data: dict[str, str] = {}  # ENV the "image" bakes (upgrade subtraction)

    def seed(
        self,
        name: str,
        *,
        state: SandboxState = SandboxState.RUNNING,
        image: str = "reef-oc:test",
        inspect: dict | None = None,
        metrics: MetricsSample | None = None,
        logs: str = "",
        status: dict | None = None,
    ) -> FakeAdminRuntime:
        self.states[name] = state
        self.images[name] = image
        self.created_at[name] = datetime(2026, 6, 1, tzinfo=UTC)
        if inspect is not None:
            self.inspect_data[name] = inspect
        if metrics is not None:
            self.metrics_data[name] = metrics
        if status is not None:
            self.status_data[name] = status
        self.logs_data[name] = logs
        return self

    # ── AgentRuntime ──
    async def create(self, spec: SandboxSpec) -> str:
        self.states[spec.sandbox_id] = SandboxState.CREATING
        self.images[spec.sandbox_id] = spec.image
        self.created.append(spec)
        # Mirror what a real `inspect` returns for a created sandbox: its image +
        # the env it was created with. Microsandbox (the prod runtime — note the
        # backend below) reports env as ``{"key","value"}`` objects, NOT the
        # ``[[k, v]]`` pairs docker emits; use the object shape here so create()-based
        # detail/access tests stay honest against prod (`_env_dict` accepts both).
        # `setdefault` keeps any explicitly seeded inspect.
        self.inspect_data.setdefault(
            spec.sandbox_id,
            {
                "config": {
                    "name": spec.sandbox_id,
                    "image": {"Oci": {"reference": spec.image}},
                    "env": [{"key": k, "value": v} for k, v in spec.env.items()],
                }
            },
        )
        return spec.sandbox_id

    async def start(self, handle: str) -> None:
        self.calls.append(("start", handle))
        self.states[handle] = SandboxState.RUNNING

    async def stop(self, handle: str) -> None:
        self.calls.append(("stop", handle))
        self.states[handle] = SandboxState.STOPPED

    async def destroy(self, handle: str) -> None:
        self.calls.append(("destroy", handle))
        self.states[handle] = SandboxState.DESTROYED

    async def status(self, handle: str) -> SandboxState:
        return self.states.get(handle, SandboxState.DESTROYED)

    # ── FleetRuntime ──
    async def list_sandboxes(self) -> list[SandboxInfo]:
        return [
            SandboxInfo(
                name=n,
                image=self.images.get(n, ""),
                state=s,
                created_at=self.created_at.get(n),
            )
            for n, s in self.states.items()
            if s is not SandboxState.DESTROYED
        ]

    async def metrics(self) -> list[MetricsSample]:
        return [
            m for n, m in self.metrics_data.items() if self.states.get(n) is SandboxState.RUNNING
        ]

    async def metrics_for(self, handle: str) -> MetricsSample | None:
        if self.states.get(handle) is SandboxState.RUNNING:
            return self.metrics_data.get(handle)
        return None

    async def inspect(self, handle: str) -> dict:
        return self.inspect_data.get(handle, {"config": {"name": handle}})

    async def logs(self, handle: str, *, tail: int | None = None, since: str | None = None) -> str:
        return self.logs_data.get(handle, "")

    async def read_status(self, handle: str) -> dict | None:
        return self.status_data.get(handle)

    async def used_host_ports(self) -> set[int]:
        return set(self.host_ports)

    # ── ImageRuntime ──
    async def list_images(self) -> list[ImageInfo]:
        return list(self.image_list)

    async def build_image(self, spec: BuildImageSpec):
        # Yield canned log lines so the BuildJobManager flow is testable without
        # docker. Records the spec + (on success) "promotes" by prepending a row.
        self.builds.append(spec)
        for line in self.build_log:
            yield line
        if self.build_should_fail:
            raise RuntimeUnavailable("fake build failed")
        self.image_list.insert(
            0,
            ImageInfo(
                tag=active_tag(spec.agent_type),
                image_id="sha256:fakebuilt",
                created_at=datetime(2026, 6, 2, tzinfo=UTC),
                size_bytes=1,
                reef_image_version="fake-stack",
                runtime_version=spec.runtime_version or "fake",
                component_version=spec.component_version or "fake-component",
                is_active=True,
                agent_type=spec.agent_type,
            ),
        )

    async def activate_image(self, tag: str) -> None:
        self.activated.append(tag)

    async def image_env(self, image: str) -> dict[str, str]:
        return dict(self.image_env_data)
