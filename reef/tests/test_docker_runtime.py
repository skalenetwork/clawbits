"""DockerRuntime command construction + output parsing, against a fake `docker`
runner (no real Docker daemon). Mirrors test_microsandbox_runtime.py."""

import asyncio
import json
from dataclasses import replace

from reef import Limits, RuntimeUnavailable, SandboxSpec, SandboxState
from reef.docker_runtime import LABEL, DockerRuntime, _parse_size, _pct, _split_pair
from reef.status import read_status_file


class FakeDocker:
    """Records argv lists; returns canned results keyed by subcommand."""

    def __init__(self) -> None:
        self.calls: list[list[str]] = []
        self.status_value = "running"
        self.status_rc = 0
        self.ps_json = ""
        self.stats_json = ""
        self.inspect_json = "[]"
        self.logs_out = ""
        self.run_rc = 0
        self.run_err = ""

    async def __call__(self, argv):
        argv = list(argv)
        self.calls.append(argv)
        sub = argv[1] if len(argv) > 1 else ""
        if sub == "inspect" and "-f" in argv:  # status probe
            if self.status_rc != 0:
                return (self.status_rc, "", "No such container")
            return (0, f"{self.status_value}\n", "")
        if sub == "inspect":  # full inspect
            return (0, self.inspect_json, "")
        if sub == "ps":
            return (0, self.ps_json, "")
        if sub == "stats":
            return (0, self.stats_json, "")
        if sub == "logs":
            return (0, self.logs_out, "")
        if sub == "run":
            return (self.run_rc, "", self.run_err)
        return (0, "", "")  # volume / start / stop / rm

    def call(self, sub: str) -> list[str] | None:
        return next((c for c in self.calls if len(c) > 1 and c[1] == sub), None)


SPEC = SandboxSpec(
    sandbox_id="agent-1",
    image="reef-oc:test",
    env={"FOO": "bar", "ANTHROPIC_API_KEY": "sk-secret"},
    volume="reef-agent-1",
    limits=Limits(cpus=2.0, memory_mb=2048),
)


def test_create_builds_expected_argv():
    fake = FakeDocker()
    rt = DockerRuntime(docker_bin="docker", runner=fake)

    handle = asyncio.run(rt.create(SPEC))

    assert handle == "agent-1"
    assert fake.call("volume")[:3] == ["docker", "volume", "create"]
    assert fake.call("rm") is not None  # `--replace` semantics: rm -f before run
    run = fake.call("run")
    assert run is not None and "-d" in run
    assert run[run.index("--name") + 1] == "agent-1"
    assert run[run.index("--memory") + 1] == "2048m"
    assert run[run.index("--cpus") + 1] == "2.0"
    assert run[run.index("-v") + 1] == "reef-agent-1:/workspace"
    assert "--label" in run and LABEL in run
    # Host reachable from the guest for local dev (e.g. clawbits on localhost:8000).
    assert run[run.index("--add-host") + 1] == "host.docker.internal:host-gateway"
    assert "FOO=bar" in run
    assert run[-1] == "reef-oc:test"  # image is the last positional arg


def test_ports_add_forwards():
    fake = FakeDocker()
    rt = DockerRuntime(runner=fake)

    asyncio.run(rt.create(replace(SPEC, ports=("127.0.0.1:19000:18789",))))

    run = fake.call("run")
    assert run[run.index("-p") + 1] == "127.0.0.1:19000:18789"


def test_extra_volumes_are_created_and_mounted():
    fake = FakeDocker()
    rt = DockerRuntime(runner=fake)

    asyncio.run(
        rt.create(
            replace(SPEC, extra_volumes=(("reef-agent-1-config", "/home/node/.config/openclaw"),))
        )
    )

    volume_creates = [c[1:] for c in fake.calls if len(c) > 1 and c[1] == "volume"]
    assert ["volume", "create", "reef-agent-1-config"] in volume_creates
    run = fake.call("run")
    assert "reef-agent-1-config:/home/node/.config/openclaw" in run


def test_status_maps_docker_states():
    cases = {
        "running": SandboxState.RUNNING,
        "restarting": SandboxState.RUNNING,
        "exited": SandboxState.STOPPED,
        "created": SandboxState.STOPPED,
        "paused": SandboxState.STOPPED,
        "dead": SandboxState.FAILED,
    }
    for value, expected in cases.items():
        fake = FakeDocker()
        fake.status_value = value
        rt = DockerRuntime(runner=fake)
        assert asyncio.run(rt.status("agent-1")) is expected


def test_status_missing_is_destroyed():
    fake = FakeDocker()
    fake.status_rc = 1
    rt = DockerRuntime(runner=fake)
    assert asyncio.run(rt.status("ghost")) is SandboxState.DESTROYED


def test_status_nonzero_exit_reads_as_failed():
    # The reconciler's ``on-failure`` policy keys off FAILED: a crash (``exited`` with
    # a non-zero code) must read as FAILED, a clean exit (0) as STOPPED.
    fake = FakeDocker()
    rt = DockerRuntime(runner=fake)
    fake.status_value = "exited 137"
    assert asyncio.run(rt.status("agent-1")) is SandboxState.FAILED
    fake.status_value = "exited 0"
    assert asyncio.run(rt.status("agent-1")) is SandboxState.STOPPED


def test_list_filters_by_label_and_parses():
    fake = FakeDocker()
    fake.ps_json = (
        '{"Names":"agent-1","Image":"reef-oc:test","State":"running",'
        '"CreatedAt":"2026-06-02 14:43:05 +0100 WEST"}\n'
        '{"Names":"agent-2","Image":"reef-oc:test","State":"exited",'
        '"CreatedAt":"2026-06-02 10:00:00 +0000 UTC"}\n'
    )
    rt = DockerRuntime(runner=fake)

    infos = asyncio.run(rt.list_sandboxes())

    assert [i.name for i in infos] == ["agent-1", "agent-2"]
    assert infos[0].state is SandboxState.RUNNING
    assert infos[1].state is SandboxState.STOPPED
    assert infos[0].created_at is not None  # Go-format timestamp parsed
    assert f"label={LABEL}" in fake.call("ps")  # fleet scoped to Reef agents


def test_used_host_ports_parses_running_bindings():
    fake = FakeDocker()
    fake.ps_json = (
        '{"Names":"oc-a","Ports":"127.0.0.1:19000->18789/tcp, 127.0.0.1:19001->7681/tcp"}\n'
        '{"Names":"oc-b","Ports":"0.0.0.0:8080->80/tcp"}\n'
        '{"Names":"oc-c","Ports":""}\n'
    )
    rt = DockerRuntime(runner=fake)

    assert asyncio.run(rt.used_host_ports()) == {19000, 19001, 8080}


def test_metrics_parses_human_sizes():
    fake = FakeDocker()
    fake.stats_json = (
        '{"Name":"agent-1","CPUPerc":"67.55%","MemUsage":"772.5MiB / 7.806GiB",'
        '"NetIO":"23.4kB / 14.8kB","BlockIO":"150MB / 94.2kB"}\n'
    )
    rt = DockerRuntime(runner=fake)

    samples = asyncio.run(rt.metrics())

    assert len(samples) == 1
    m = samples[0]
    assert m.name == "agent-1"
    assert m.cpu_percent == 67.55
    assert m.memory_bytes == int(772.5 * 1024**2)
    assert m.memory_limit_bytes == int(7.806 * 1024**3)
    assert m.net_rx_bytes == int(23.4 * 1000)
    assert m.net_tx_bytes == int(14.8 * 1000)


def test_inspect_normalizes_to_msb_shape():
    fake = FakeDocker()
    fake.inspect_json = json.dumps(
        [
            {
                "Config": {
                    "Image": "reef-oc:test",
                    "Env": ["FOO=bar", "ANTHROPIC_API_KEY=sk-x"],
                    "Entrypoint": ["/usr/local/bin/reef-entrypoint.sh"],
                    "Cmd": None,
                },
                "HostConfig": {"NanoCpus": 2_000_000_000, "Memory": 2147483648},
                "Mounts": [
                    {
                        "Type": "volume",
                        "Name": "reef-agent-1",
                        "Destination": "/workspace",
                        "RW": True,
                    }
                ],
            }
        ]
    )
    rt = DockerRuntime(runner=fake)

    cfg = asyncio.run(rt.inspect("agent-1"))["config"]

    assert cfg["image"]["Oci"]["reference"] == "reef-oc:test"
    assert ["FOO", "bar"] in cfg["env"]  # env is [[k, v], …] like msb
    assert cfg["cpus"] == 2.0
    assert cfg["memory_mib"] == 2048
    assert cfg["mounts"][0]["guest"] == "/workspace"
    assert cfg["mounts"][0]["host"] == "reef-agent-1"
    assert cfg["network"]["policy"]["rules"] == []


def test_create_failure_redacts_secret_env():
    fake = FakeDocker()
    fake.run_rc = 1
    fake.run_err = "boom"
    rt = DockerRuntime(runner=fake)
    try:
        asyncio.run(rt.create(replace(SPEC, env={"ANTHROPIC_API_KEY": "sk-supersecret"})))
        raise AssertionError("expected RuntimeUnavailable")
    except RuntimeUnavailable as e:
        msg = str(e)
        assert "sk-supersecret" not in msg
        assert "ANTHROPIC_API_KEY=***" in msg


def test_status_mount_added_and_read(tmp_path):
    fake = FakeDocker()
    rt = DockerRuntime(runner=fake, state_dir=str(tmp_path))

    asyncio.run(rt.create(replace(SPEC, status_dest="/home/node/.reef")))

    run = fake.call("run")
    host_dir = tmp_path / "agents" / "agent-1"
    assert f"{host_dir}:/home/node/.reef" in run  # status dir bind-mounted
    assert host_dir.is_dir()  # created host-side for the agent to write into
    assert asyncio.run(rt.read_status("agent-1")) is None  # agent hasn't written yet
    (host_dir / "status.json").write_text('{"versions": {"openclaw": "2026.5.28"}}')
    assert asyncio.run(rt.read_status("agent-1"))["versions"]["openclaw"] == "2026.5.28"


def test_no_status_mount_when_unset(tmp_path):
    fake = FakeDocker()
    rt = DockerRuntime(runner=fake, state_dir=str(tmp_path))
    asyncio.run(rt.create(SPEC))  # SPEC has no status_dest
    run = fake.call("run")
    assert not any(a.endswith(":/home/node/.reef") for a in run)
    assert asyncio.run(rt.read_status("agent-1")) is None


def test_read_status_file_helper(tmp_path):
    assert read_status_file(tmp_path) is None  # missing
    (tmp_path / "status.json").write_text('{"a": 1}')
    assert read_status_file(tmp_path) == {"a": 1}
    (tmp_path / "status.json").write_text("not json")
    assert read_status_file(tmp_path) is None  # malformed
    (tmp_path / "status.json").write_text("[1, 2]")
    assert read_status_file(tmp_path) is None  # not an object


def test_size_and_pct_helpers():
    assert _parse_size("772.5MiB") == int(772.5 * 1024**2)
    assert _parse_size("23.4kB") == int(23.4 * 1000)
    assert _parse_size("0B") == 0
    assert _parse_size("") == 0
    assert _pct("67.55%") == 67.55
    assert _pct("--") == 0.0
    assert _split_pair("772.5MiB / 7.806GiB") == ("772.5MiB", "7.806GiB")
