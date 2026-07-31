"""MicrosandboxRuntime read ops (list/metrics/inspect/logs) against a fake `msb`
runner — validates parsing of the real --format json shapes (v0.5.4).
"""

import asyncio
import json

from reef.microsandbox_runtime import MicrosandboxRuntime
from reef.runtime import SandboxState

LIST_JSON = json.dumps(
    [
        {
            "created_at": "2026-06-02T12:27:11.857467+00:00",
            "image": "reef-oc:plugin",
            "name": "reefexp",
            "status": "Running",
        },
        {
            "created_at": "2026-06-01T20:25:01.017152+00:00",
            "image": "reef-oc:try",
            "name": "oc-try",
            "status": "Stopped",
        },
    ]
)
METRICS_JSON = json.dumps(
    [
        {
            "name": "reefexp",
            "cpu_percent": 0.5,
            "memory_bytes": 12304384,
            "memory_limit_bytes": 2147483648,
            "disk_read_bytes": 1,
            "disk_write_bytes": 2,
            "net_rx_bytes": 3,
            "net_tx_bytes": 4,
            "uptime_secs": 63417.0,
        }
    ]
)
INSPECT_JSON = json.dumps({"config": {"name": "reefexp", "cpus": 1, "memory_mib": 2048}})


def make_runner(responses: dict[str, tuple[int, str, str]]):
    """Build an injectable runner returning canned (rc, out, err) per subcommand."""
    calls: list[list[str]] = []

    async def runner(argv):
        argv = list(argv)
        calls.append(argv)
        sub = argv[1] if len(argv) > 1 else ""
        return responses.get(sub, (0, "", ""))

    runner.calls = calls
    return runner


def test_list_sandboxes_parses_rows_and_state():
    runner = make_runner({"list": (0, LIST_JSON, "")})
    rt = MicrosandboxRuntime(runner=runner)
    infos = asyncio.run(rt.list_sandboxes())
    assert [i.name for i in infos] == ["reefexp", "oc-try"]
    assert infos[0].state is SandboxState.RUNNING
    assert infos[1].state is SandboxState.STOPPED
    assert infos[0].image == "reef-oc:plugin"
    assert infos[0].created_at is not None and infos[0].created_at.year == 2026


def test_metrics_parses_samples():
    runner = make_runner({"metrics": (0, METRICS_JSON, "")})
    rt = MicrosandboxRuntime(runner=runner)
    samples = asyncio.run(rt.metrics())
    assert samples[0].name == "reefexp"
    assert samples[0].memory_limit_bytes == 2147483648
    assert samples[0].net_tx_bytes == 4


def test_metrics_is_best_effort_on_failure():
    runner = make_runner({"metrics": (1, "", "no running sandboxes")})
    rt = MicrosandboxRuntime(runner=runner)
    assert asyncio.run(rt.metrics()) == []


def test_metrics_for_filters_by_name():
    runner = make_runner({"metrics": (0, METRICS_JSON, "")})
    rt = MicrosandboxRuntime(runner=runner)
    m = asyncio.run(rt.metrics_for("reefexp"))
    assert m is not None and m.cpu_percent == 0.5
    assert asyncio.run(rt.metrics_for("absent")) is None


def test_inspect_returns_parsed_dict():
    runner = make_runner({"inspect": (0, INSPECT_JSON, "")})
    rt = MicrosandboxRuntime(runner=runner)
    raw = asyncio.run(rt.inspect("reefexp"))
    assert raw["config"]["name"] == "reefexp"


def test_logs_builds_argv_with_tail_and_timestamps():
    runner = make_runner({"logs": (0, "2026-06-02 line1\n2026-06-02 line2\n", "")})
    rt = MicrosandboxRuntime(runner=runner)
    out = asyncio.run(rt.logs("reefexp", tail=50))
    assert "line1" in out
    logs_call = next(c for c in runner.calls if c[1] == "logs")
    assert "--timestamps" in logs_call
    assert logs_call[logs_call.index("--tail") + 1] == "50"


def test_logs_fall_back_to_kernel_log_for_init_output(tmp_path):
    runner = make_runner({"logs": (0, "", "")})
    kernel = tmp_path / "sandboxes" / "reefexp" / "logs" / "kernel.log"
    kernel.parent.mkdir(parents=True)
    kernel.write_text("boot\ngateway ready\n", encoding="utf-8")
    rt = MicrosandboxRuntime(runner=runner, volumes_dir=str(tmp_path / "volumes"))

    out = asyncio.run(rt.logs("reefexp", tail=1))

    assert out == "gateway ready\n"
