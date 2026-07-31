"""MicrosandboxRuntime command construction + status parsing, against a fake
`msb` runner (no real microVMs). Validates the exact flags we confirmed by hand.
"""

import asyncio
import json
from dataclasses import replace

from reef import Limits, RuntimeUnavailable, SandboxSpec, SandboxState
from reef.microsandbox_runtime import MicrosandboxRuntime


class FakeMsb:
    """Records argv lists; returns canned results. status() reports `status_value`."""

    def __init__(self, status_value: str = "Running", status_rc: int = 0) -> None:
        self.calls: list[list[str]] = []
        self.status_value = status_value
        self.status_rc = status_rc

    async def __call__(self, argv):
        argv = list(argv)
        self.calls.append(argv)
        sub = argv[1] if len(argv) > 1 else ""
        if sub == "status":
            if self.status_rc != 0:
                return (self.status_rc, "", "not found")
            return (0, json.dumps({"name": argv[2], "image": "x", "status": self.status_value}), "")
        return (0, "", "")

    def call(self, sub: str) -> list[str] | None:
        return next((c for c in self.calls if len(c) > 1 and c[1] == sub), None)


SPEC = SandboxSpec(
    sandbox_id="agent-1",
    image="openclaw-runtime:test",
    env={"FOO": "bar", "ANTHROPIC_API_KEY": "sk-secret"},
    init="/usr/local/bin/reef-entrypoint.sh",
    volume="reef-agent-1",
    limits=Limits(cpus=2.0, memory_mb=2048),
)


def test_create_builds_expected_argv():
    fake = FakeMsb()
    rt = MicrosandboxRuntime(msb_bin="msb", runner=fake)

    handle = asyncio.run(rt.create(SPEC))

    assert handle == "agent-1"
    assert fake.call("volume")[1:] == ["volume", "create", "reef-agent-1"]
    create = fake.call("create")
    assert create is not None
    assert create[create.index("-n") + 1] == "agent-1"
    assert create[create.index("-c") + 1] == "2"
    assert create[create.index("-m") + 1] == "2048M"
    assert create[create.index("-v") + 1] == "reef-agent-1:/workspace"
    assert create[create.index("--init") + 1] == "/usr/local/bin/reef-entrypoint.sh"
    assert "FOO=bar" in create
    assert "--replace" in create
    assert create[-1] == "openclaw-runtime:test"  # image is the positional arg, last
    # no egress restriction unless an allowlist is configured
    assert "--net-default-egress" not in create


def test_create_without_init_omits_init_flag():
    fake = FakeMsb()
    rt = MicrosandboxRuntime(msb_bin="msb", runner=fake)

    asyncio.run(rt.create(replace(SPEC, init=None)))

    create = fake.call("create")
    assert create is not None
    assert "--init" not in create


def test_create_rejects_fractional_cpus_for_msb():
    fake = FakeMsb()
    rt = MicrosandboxRuntime(msb_bin="msb", runner=fake)

    try:
        asyncio.run(rt.create(replace(SPEC, limits=Limits(cpus=1.5, memory_mb=2048))))
        raise AssertionError("expected RuntimeUnavailable")
    except RuntimeUnavailable as e:
        assert "whole-number CPUs" in str(e)
    assert fake.calls == []


def test_net_allow_on_spec_adds_egress_allowlist():
    fake = FakeMsb()
    rt = MicrosandboxRuntime(runner=fake)

    asyncio.run(rt.create(replace(SPEC, net_allow=("api.anthropic.com", "*.npmjs.org"))))

    create = fake.call("create")
    assert create[create.index("--net-default-egress") + 1] == "deny"
    assert "allow@api.anthropic.com" in create
    assert "allow@*.npmjs.org" in create


def test_ports_add_forwards():
    fake = FakeMsb()
    rt = MicrosandboxRuntime(runner=fake)

    asyncio.run(rt.create(replace(SPEC, ports=("127.0.0.1:19000:18789",))))

    create = fake.call("create")
    assert create[create.index("-p") + 1] == "127.0.0.1:19000:18789"


def test_volume_dest_from_spec_is_mounted():
    fake = FakeMsb()
    rt = MicrosandboxRuntime(runner=fake)

    asyncio.run(rt.create(replace(SPEC, volume_dest="/home/node/.openclaw/workspace")))

    create = fake.call("create")
    assert create[create.index("-v") + 1] == "reef-agent-1:/home/node/.openclaw/workspace"


def test_extra_volumes_are_created_and_mounted():
    fake = FakeMsb()
    rt = MicrosandboxRuntime(runner=fake)

    asyncio.run(
        rt.create(
            replace(SPEC, extra_volumes=(("reef-agent-1-config", "/home/node/.config/openclaw"),))
        )
    )

    volume_creates = [c[1:] for c in fake.calls if len(c) > 1 and c[1] == "volume"]
    assert ["volume", "create", "reef-agent-1-config"] in volume_creates
    create = fake.call("create")
    assert "reef-agent-1-config:/home/node/.config/openclaw" in create


def test_create_failure_redacts_secret_env():
    # msb `create` fails -> the secret in -e must never leak into the exception.
    async def runner(argv):
        return (1, "", "boom") if argv[1] == "create" else (0, "", "")

    rt = MicrosandboxRuntime(runner=runner)
    try:
        asyncio.run(rt.create(replace(SPEC, env={"ANTHROPIC_API_KEY": "sk-supersecret"})))
        raise AssertionError("expected RuntimeUnavailable")
    except RuntimeUnavailable as e:
        msg = str(e)
        assert "sk-supersecret" not in msg
        assert "ANTHROPIC_API_KEY=***" in msg


def test_status_maps_running():
    fake = FakeMsb(status_value="Running")
    rt = MicrosandboxRuntime(runner=fake)
    assert asyncio.run(rt.status("agent-1")) is SandboxState.RUNNING


def test_status_not_found_is_destroyed():
    fake = FakeMsb(status_rc=1)
    rt = MicrosandboxRuntime(runner=fake)
    assert asyncio.run(rt.status("agent-1")) is SandboxState.DESTROYED


def test_start_is_noop_when_already_running():
    fake = FakeMsb(status_value="Running")
    rt = MicrosandboxRuntime(runner=fake)
    asyncio.run(rt.start("agent-1"))
    assert fake.call("start") is None  # didn't call `msb start` — already running


def test_start_starts_a_stopped_sandbox():
    fake = FakeMsb(status_value="Stopped")
    rt = MicrosandboxRuntime(runner=fake)
    asyncio.run(rt.start("agent-1"))
    started = fake.call("start")
    assert started is not None and started[1:] == ["start", "agent-1"]
