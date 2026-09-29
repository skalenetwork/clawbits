"""health.py status file, ``hermes clawbits doctor`` and the signup CLI wiring."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import subprocess
import sys
import time
import types
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from tests.poc.hermes_stubs import _load_hermes_module

PKG = "hermes_clawbits_test"


def _hermes_home(monkeypatch, home: Path, **helpers: Any) -> Any:
    """Point the (stubbed or bare) hermes_constants and HERMES_HOME at ``home``."""
    monkeypatch.setenv("HERMES_HOME", str(home))
    hc = sys.modules.get("hermes_constants") or types.ModuleType("hermes_constants")
    monkeypatch.setitem(sys.modules, "hermes_constants", hc)
    for name, value in {"get_hermes_home": lambda: home, **helpers}.items():
        monkeypatch.setattr(hc, name, value, raising=False)
    return hc


def _load(monkeypatch, home: Path) -> tuple[Any, Any]:
    """Load the plugin with fake Hermes helpers rooted at ``home``; no journal, no account module."""
    _load_hermes_module()
    _hermes_home(monkeypatch, home, get_default_hermes_root=lambda: home,
                 profile_name_for_home=lambda p: Path(p).name if Path(p).parent.name == "profiles" else "default")
    utils = types.ModuleType("utils")

    def atomic_json_write(path, data, *, indent=2, mode=None):
        Path(path).write_text(json.dumps(data))
        os.chmod(path, mode or 0o644)

    utils.atomic_json_write = atomic_json_write
    monkeypatch.setitem(sys.modules, "utils", utils)
    redact = types.ModuleType("agent.redact")
    redact.calls = []

    def redact_sensitive_text(text, **kwargs):
        redact.calls.append(kwargs)
        return text.replace("sk-SECRETKEY", "***")

    redact.redact_sensitive_text = redact_sensitive_text
    monkeypatch.setitem(sys.modules, "agent", sys.modules.get("agent") or types.ModuleType("agent"))
    monkeypatch.setitem(sys.modules, "agent.redact", redact)
    monkeypatch.setitem(sys.modules, f"{PKG}.inbox_state", None)
    monkeypatch.setitem(sys.modules, f"{PKG}.account", None)
    import importlib

    return importlib.import_module(f"{PKG}.health"), importlib.import_module(f"{PKG}.doctor")


def _gateway(monkeypatch, beat_home: Path, *, running=True, source="pid", state="running",
             platforms=None, runtime=None, beat_age=5.0) -> list[dict[str, Any]]:
    """Fake Hermes liveness; returns the recorded resolve_gateway_liveness kwargs."""
    calls: list[dict[str, Any]] = []
    status = types.ModuleType("gateway.status")

    def resolve_gateway_liveness(**kwargs):
        calls.append(kwargs)
        return SimpleNamespace(running=running, pid=os.getpid() if running else None, source=source, runtime=runtime)

    status.resolve_gateway_liveness = resolve_gateway_liveness
    status.read_runtime_status = lambda path=None: {
        "gateway_state": state, "platforms": platforms or {"clawbits": {"state": "connected"}}}
    monkeypatch.setitem(sys.modules, "gateway.status", status)
    watchdog = types.ModuleType("gateway.shutdown_watchdog")
    watchdog.get_loop_heartbeat_path = lambda home=None: Path(home) / "state" / "gateway.heartbeat"
    monkeypatch.setitem(sys.modules, "gateway.shutdown_watchdog", watchdog)
    beat = beat_home / "state" / "gateway.heartbeat"
    beat.parent.mkdir(parents=True, exist_ok=True)
    beat.write_text(json.dumps({"pid": 1, "updated_at": datetime.fromtimestamp(time.time() - beat_age, UTC).isoformat()}))
    return calls


def _status(health, doctor, home: Path, version: str | None = None):
    return health.HealthStatus.for_home(home, version or doctor.PLUGIN_VERSION)


def _ready(health, doctor, home: Path):
    h = _status(health, doctor, home)
    h.ok("chat", interval_s=3)
    h.flush()
    return h


def _args(**kw: Any) -> argparse.Namespace:
    return argparse.Namespace(**{"wait": 0, "since": None, "preflight": False, "json": False, **kw})


# --- health.py --------------------------------------------------------------


def test_status_records_codes_not_messages(monkeypatch, tmp_path) -> None:
    health, _ = _load(monkeypatch, tmp_path)
    h = health.HealthStatus(health.state_dir(tmp_path), plugin_version="0.10.0", profile="default")
    h.fail("chat", RuntimeError("HTTP 500: https://x/?api_key=sk-SECRET mail body"))
    h.fail("email", "HTTP 500 body sk-SECRET")
    h.fail("reader", "restricted_boundary_unavailable")
    h.hold("journal at /home/u: sk-SECRET")
    h.flush()
    path = tmp_path / "plugin-data" / "clawbits-platform" / "status.json"
    text = path.read_text()
    doc = json.loads(text)
    assert doc["subsystems"]["chat"]["error"] == "http_500"
    assert doc["subsystems"]["email"]["error"] == "invalid_code" and doc["hold"] == "invalid_code"
    assert doc["subsystems"]["reader"]["error"] == "restricted_boundary_unavailable"
    assert "SECRET" not in text and "mail body" not in text
    assert path.stat().st_mode & 0o777 == 0o600
    assert path.parent.stat().st_mode & 0o777 == 0o700
    assert health.read_status(tmp_path)["plugin_version"] == "0.10.0"


def test_error_code_is_status_timeout_cli_code_or_class(monkeypatch, tmp_path) -> None:
    health, _ = _load(monkeypatch, tmp_path)
    cli_client = sys.modules[f"{PKG}.cli_client"]

    class FakeCliError(RuntimeError):
        def __init__(self, code: str) -> None:
            super().__init__(f"agent-cli: {code}")
            self.status, self.code = None, code

    monkeypatch.setattr(cli_client, "ClawbitsCliError", FakeCliError, raising=False)
    assert health.error_code(RuntimeError("HTTP 503: {\"detail\": \"x\"}")) == "http_503"
    assert health.error_code(subprocess.TimeoutExpired(["cli", "--api-key", "sk-1"], 60)) == "timeout"
    assert health.error_code(TimeoutError()) == "timeout"
    assert health.error_code(FakeCliError("URLError")) == "URLError"
    assert health.error_code(FakeCliError("leaks a body")) == "FakeCliError"
    assert health.error_code(ValueError("secret text")) == "ValueError"


def test_status_flush_is_throttled_and_off_loop(monkeypatch, tmp_path) -> None:
    health, _ = _load(monkeypatch, tmp_path)
    writes: list[dict[str, Any]] = []
    monkeypatch.setattr(sys.modules["utils"], "atomic_json_write", lambda path, data, **kw: writes.append(data))
    clock = [1000.0]
    monkeypatch.setattr(health, "time", SimpleNamespace(time=lambda: clock[0]))
    h = health.HealthStatus(tmp_path, plugin_version="0.10.0", profile="default")
    h.ok("chat", interval_s=3)
    h.flush()
    h.ok("chat", interval_s=3)
    h.receipt("chat")
    h.flush()
    assert len(writes) == 1, "an unchanged state is not rewritten"
    assert writes[0] is not h.doc and "last_receipt_at" not in writes[0]["subsystems"]["chat"], "a snapshot is written"
    h.fail("chat", "http_503")
    h.flush()
    h.fail("chat", "http_503")
    h.flush()
    assert len(writes) == 2 and writes[-1]["subsystems"]["chat"]["failures"] == 1
    clock[0] += 31
    h.flush()
    assert len(writes) == 3 and writes[-1]["subsystems"]["chat"]["failures"] == 2, "the refresh carries the count"
    h.hold("journal_schema_newer")
    h.flush()
    h.stopped()
    h.flush()
    assert len(writes) == 5 and writes[-1]["hold"] == "journal_schema_newer" and writes[-1]["stopped_at"]

    flushed: list[Any] = []

    async def to_thread(fn, *args):
        flushed.append(fn)
        return fn(*args)

    monkeypatch.setattr(health.asyncio, "to_thread", to_thread)
    ticks = iter([True, True, False])
    h = health.HealthStatus(tmp_path, plugin_version="0.10.0", profile="default")
    asyncio.run(health.run_status_writer(h, lambda: next(ticks), tick_s=0))
    assert flushed == [h.flush] * 3 and writes[-1]["stopped_at"], "the stop is flushed on exit"


def test_status_writer_records_a_cancelled_stop(monkeypatch, tmp_path) -> None:
    health, _ = _load(monkeypatch, tmp_path)
    h = health.HealthStatus.for_home(tmp_path, "0.10.0")

    async def run() -> None:
        task = asyncio.create_task(health.run_status_writer(h, lambda: True, tick_s=60))
        while health.read_status(tmp_path) is None:
            await asyncio.sleep(0.01)
        assert "stopped_at" not in health.read_status(tmp_path)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(run())
    assert health.read_status(tmp_path)["stopped_at"]


def test_for_home_names_the_profile(monkeypatch, tmp_path) -> None:
    health, _ = _load(monkeypatch, tmp_path)
    home = tmp_path / "profiles" / "b"
    h = health.HealthStatus.for_home(home, "0.10.0")
    assert h.path == home / "plugin-data" / "clawbits-platform" / "status.json" and h.doc["profile"] == "b"
    monkeypatch.setitem(sys.modules, "hermes_constants", None)
    assert health.HealthStatus.for_home(home, "0.10.0").doc["profile"] == "default"


def test_failed_status_write_is_retried(monkeypatch, tmp_path) -> None:
    health, _ = _load(monkeypatch, tmp_path)
    attempts: list[dict[str, Any]] = []

    def atomic_json_write(path, data, **kw):
        attempts.append(data)
        if len(attempts) == 1:
            raise OSError("disk full")

    monkeypatch.setattr(sys.modules["utils"], "atomic_json_write", atomic_json_write)
    h = health.HealthStatus(tmp_path, plugin_version="0.10.0", profile="default")
    h.flush()
    h.flush()
    h.flush()
    assert len(attempts) == 2, "a failed write stays dirty and the next flush retries it"


def test_state_dir_expands_user_and_env(monkeypatch, tmp_path) -> None:
    health, _ = _load(monkeypatch, tmp_path)
    monkeypatch.setenv("CBX", str(tmp_path))
    state = Path("plugin-data/clawbits-platform")
    assert health.state_dir("$CBX/p") == tmp_path / "p" / state
    assert health.state_dir("~/h") == Path.home() / "h" / state
    monkeypatch.setattr(sys.modules["hermes_constants"], "get_hermes_home", lambda: "$CBX/unexpanded")
    assert health.state_dir() == tmp_path / "unexpanded" / state
    monkeypatch.setitem(sys.modules, "hermes_constants", None)
    monkeypatch.setenv("HERMES_HOME", "$CBX/env-home")
    assert health.state_dir() == tmp_path / "env-home" / state


def test_read_status_ignores_missing_and_foreign_files(monkeypatch, tmp_path) -> None:
    health, _ = _load(monkeypatch, tmp_path)
    assert health.read_status(tmp_path) is None
    health.state_dir(tmp_path).mkdir(parents=True)
    (health.state_dir(tmp_path) / "status.json").write_text('{"format": 99}')
    assert health.read_status(tmp_path) is None


# --- doctor -----------------------------------------------------------------


def test_doctor_ready_after_restart(monkeypatch, tmp_path, capsys) -> None:
    health, doctor = _load(monkeypatch, tmp_path)
    liveness = _gateway(monkeypatch, tmp_path)
    monkeypatch.setattr(doctor, "live_checks", lambda: [])
    since = time.time() - 1
    h = _status(health, doctor, tmp_path)
    h.ok("chat", interval_s=3)
    h.fail("email", "http_503", interval_s=60)
    h.flush()
    rc = doctor.run(_args(since=since))
    out = capsys.readouterr().out
    assert rc == 1 and "[fail] email" in out and "[ok  ] chat" in out and "[ok  ] gateway" in out
    assert liveness == [{"use_cache": False}], "the liveness query is unscoped and uncached"
    redact = sys.modules["agent.redact"]
    assert redact.calls and all(c == {"force": True, "redact_url_credentials": True} for c in redact.calls)


def test_doctor_subsystem_levels(monkeypatch, tmp_path, capsys) -> None:
    health, doctor = _load(monkeypatch, tmp_path)
    _gateway(monkeypatch, tmp_path)
    monkeypatch.setattr(doctor, "live_checks", lambda: [])
    h = _ready(health, doctor, tmp_path)
    h.fail("events", "websockets_missing")
    h.ok("email", interval_s=60, state="not_configured")
    h.doc["subsystems"]["email"]["last_ok_at"] = time.time() - 600
    h.flush()
    assert doctor.run(_args()) == 0
    out = capsys.readouterr().out
    assert "[warn] events" in out and "state not_configured" in out, "email switched off is never stalled"
    h.ok("outbox", interval_s=10)
    h.doc["subsystems"]["outbox"]["last_ok_at"] = time.time() - 600
    h.flush(force=True)
    assert doctor.run(_args()) == 1 and "stalled" in capsys.readouterr().out
    h.doc["subsystems"]["chat"]["last_ok_at"] = h.doc["started_at"] - 1
    h.flush(force=True)
    assert doctor.run(_args()) == 3 and "no successful poll since start" in capsys.readouterr().out


def test_doctor_not_ready_when_old_version_runs(monkeypatch, tmp_path, capsys) -> None:
    health, doctor = _load(monkeypatch, tmp_path)
    _gateway(monkeypatch, tmp_path)
    monkeypatch.setattr(doctor, "live_checks", lambda: [])
    _status(health, doctor, tmp_path, version="0.0.1").flush()
    assert doctor.run(_args()) == 3 and "restart pending" in capsys.readouterr().out


def test_doctor_not_ready_without_status(monkeypatch, tmp_path, capsys) -> None:
    _, doctor = _load(monkeypatch, tmp_path)
    _gateway(monkeypatch, tmp_path)
    monkeypatch.setattr(doctor, "live_checks", lambda: [])
    assert doctor.run(_args()) == 3 and "no status from a running plugin" in capsys.readouterr().out


def test_doctor_not_ready_before_the_first_poll(monkeypatch, tmp_path, capsys) -> None:
    health, doctor = _load(monkeypatch, tmp_path)
    _gateway(monkeypatch, tmp_path)
    monkeypatch.setattr(doctor, "live_checks", lambda: [])
    _status(health, doctor, tmp_path).flush()
    assert doctor.run(_args()) == 3 and "[down] chat" in capsys.readouterr().out


def test_doctor_not_ready_before_since_or_when_held(monkeypatch, tmp_path, capsys) -> None:
    health, doctor = _load(monkeypatch, tmp_path)
    _gateway(monkeypatch, tmp_path)
    monkeypatch.setattr(doctor, "live_checks", lambda: [])
    h = _ready(health, doctor, tmp_path)
    assert doctor.run(_args(since=time.time() + 10)) == 3 and "not restarted" in capsys.readouterr().out
    h.hold("journal_schema_newer")
    h.flush()
    assert doctor.run(_args()) == 3 and "intake held: journal_schema_newer" in capsys.readouterr().out
    h.hold(None)
    proc = subprocess.Popen([sys.executable, "-c", "pass"])
    proc.wait()
    h.doc["pid"] = proc.pid
    h.flush(force=True)
    assert doctor.run(_args()) == 3 and "not running" in capsys.readouterr().out
    h.doc["pid"] = os.getpid()
    h.stopped()
    h.flush()
    assert doctor.run(_args()) == 3 and "not running" in capsys.readouterr().out


@pytest.mark.parametrize("kwargs", [{"beat_age": 600}, {"state": "degraded"},
                                    {"platforms": {"clawbits": {"state": "retrying"}}}])
def test_doctor_stale_heartbeat_degrades(monkeypatch, tmp_path, capsys, kwargs) -> None:
    health, doctor = _load(monkeypatch, tmp_path)
    _gateway(monkeypatch, tmp_path, **kwargs)
    monkeypatch.setattr(doctor, "live_checks", lambda: [])
    _ready(health, doctor, tmp_path)
    assert doctor.run(_args()) == 1 and "[fail] gateway" in capsys.readouterr().out


def test_doctor_starting_gateway_is_not_ready(monkeypatch, tmp_path, capsys) -> None:
    health, doctor = _load(monkeypatch, tmp_path)
    _gateway(monkeypatch, tmp_path, state="starting")
    monkeypatch.setattr(doctor, "live_checks", lambda: [])
    _ready(health, doctor, tmp_path)
    assert doctor.run(_args()) == 3 and "[down] gateway" in capsys.readouterr().out


def test_doctor_gateway_down_is_not_ready(monkeypatch, tmp_path, capsys) -> None:
    health, doctor = _load(monkeypatch, tmp_path)
    _gateway(monkeypatch, tmp_path, running=False)
    monkeypatch.setattr(doctor, "live_checks", lambda: [])
    _ready(health, doctor, tmp_path)
    assert doctor.run(_args()) == 3 and "[down] gateway" in capsys.readouterr().out


def test_doctor_served_profile_reads_multiplexer_runtime(monkeypatch, tmp_path, capsys) -> None:
    root = tmp_path / "root"
    home = root / "profiles" / "b"
    health, doctor = _load(monkeypatch, home)
    monkeypatch.setattr(sys.modules["hermes_constants"], "get_default_hermes_root", lambda: root)
    _gateway(monkeypatch, root, source="multiplexer",
             runtime={"gateway_state": "running", "platforms": {"b:clawbits": {"state": "connected"}}})
    monkeypatch.setattr(doctor, "live_checks", lambda: [])
    _ready(health, doctor, home)
    rc = doctor.run(_args(json=True))
    gateway = json.loads(capsys.readouterr().out)[0]
    assert rc == 0 and gateway["level"] == "ok" and "(multiplexer)" in gateway["detail"]
    assert "clawbits connected" in gateway["detail"]


def _fake_account(monkeypatch, doctor, agent_info) -> list[Any]:
    """Install a B-style account module and client; returns the accounts the client was built for."""
    built: list[Any] = []
    account = SimpleNamespace(agent_id="agent-1", base_url="http://cb.test", api_key="sk-SECRETKEY", usable=True)
    module = types.ModuleType(f"{PKG}.account")
    module.resolve_account = lambda config=None: account
    monkeypatch.setitem(sys.modules, f"{PKG}.account", module)

    class Client:
        @classmethod
        def for_account(cls, acct, cli_path=None):
            built.append(acct)
            return cls()

        def agent_info(self, agent_id):
            return agent_info(agent_id)

    monkeypatch.setattr(doctor, "_ClawbitsCli", Client)
    return built


def test_doctor_identity_rejected(monkeypatch, tmp_path, capsys) -> None:
    health, doctor = _load(monkeypatch, tmp_path)
    _gateway(monkeypatch, tmp_path)

    def rejected(agent_id):
        raise RuntimeError("HTTP 401: invalid key sk-SECRETKEY")

    _fake_account(monkeypatch, doctor, rejected)
    _ready(health, doctor, tmp_path)
    rc = doctor.run(_args(json=True))
    out = capsys.readouterr().out
    assert rc == 3 and "SECRETKEY" not in out
    assert json.loads(out)[-1] == {"name": "identity", "level": "down", "detail": "agent agent-1 rejected (HTTP 401)"}


def test_doctor_backend_unreachable_is_degraded(monkeypatch, tmp_path, capsys) -> None:
    health, doctor = _load(monkeypatch, tmp_path)
    _gateway(monkeypatch, tmp_path)

    def timeout(agent_id):
        raise subprocess.TimeoutExpired(["cli", "--api-key", "sk-SECRETKEY"], 60)

    _fake_account(monkeypatch, doctor, timeout)
    _ready(health, doctor, tmp_path)
    rc = doctor.run(_args())
    out = capsys.readouterr().out
    assert rc == 1 and "[fail] backend" in out and "http://cb.test unreachable (timeout)" in out
    assert "SECRETKEY" not in out


def test_doctor_uses_the_profile_account(monkeypatch, tmp_path, capsys) -> None:
    health, doctor = _load(monkeypatch, tmp_path)
    _gateway(monkeypatch, tmp_path)
    monkeypatch.setenv("CLAWBITS_API_KEY", "launch-key")
    monkeypatch.setenv("CLAWBITS_AGENT_ID", "launch-agent")
    built = _fake_account(monkeypatch, doctor, lambda agent_id: {"agent_id": agent_id, "operator_id": "u1"})
    _ready(health, doctor, tmp_path)
    assert doctor.run(_args()) == 0
    out = capsys.readouterr().out
    assert [a.agent_id for a in built] == ["agent-1"] and "launch-agent" not in out
    assert "agent agent-1 accepted by http://cb.test" in out and "[ok  ] operator" in out and "u1 bound" in out


def test_doctor_falls_back_to_env_identity_without_account_module(monkeypatch, tmp_path, capsys) -> None:
    health, doctor = _load(monkeypatch, tmp_path)
    _gateway(monkeypatch, tmp_path)
    _ready(health, doctor, tmp_path)
    assert doctor.run(_args()) == 3 and "[down] identity" in capsys.readouterr().out
    seen: list[tuple[str, str]] = []

    class Client:
        def __init__(self, cli_path, base_url, api_key):
            seen.append((base_url, api_key))

        def agent_info(self, agent_id):
            return {}

    monkeypatch.setattr(doctor, "_ClawbitsCli", Client)
    monkeypatch.setenv("CLAWBITS_API_KEY", "env-key")
    monkeypatch.setenv("CLAWBITS_AGENT_ID", "env-agent")
    monkeypatch.setenv("CLAWBITS_ENDPOINT", "http://env.test/")
    assert doctor.run(_args()) == 0
    out = capsys.readouterr().out
    assert seen == [("http://env.test", "env-key")] and "[warn] operator" in out and "no operator binding" in out


def test_doctor_queue_and_outbox_from_journal(monkeypatch, tmp_path, capsys) -> None:
    health, doctor = _load(monkeypatch, tmp_path)
    _gateway(monkeypatch, tmp_path)
    monkeypatch.setattr(doctor, "live_checks", lambda: [])
    _ready(health, doctor, tmp_path)
    stats: dict[str, Any] = {
        "schema": 1, "min_reader": 1, "supported": True, "oldest_open_age_s": 125.7, "stalled": False,
        "items": {"pending": 3, "needs_review": 2, "processed": 40}, "replies": {"unknown": 1, "sent": 9},
        "sources_needing_review": 0,
    }
    seen: list[Path] = []
    journal = types.ModuleType(f"{PKG}.inbox_state")
    journal.read_stats = lambda home: seen.append(home) or stats
    monkeypatch.setitem(sys.modules, f"{PKG}.inbox_state", journal)
    rc = doctor.run(_args(json=True))
    checks = {c["name"]: c for c in json.loads(capsys.readouterr().out)}
    assert rc == 1 and seen and seen[0] == tmp_path
    assert checks["queue"]["level"] == "fail"
    assert checks["queue"]["detail"] == "needs_review 2, pending 3, oldest open 125s"
    assert checks["outbox"] == {"name": "outbox", "level": "fail", "detail": "unknown 1"}
    stats.update(items={"pending": 1}, replies={}, sources_needing_review=["email:1"])
    assert doctor.run(_args()) == 1 and "1 source(s) need migration review" in capsys.readouterr().out
    stats.update(supported=False, schema=3, min_reader=2)
    assert doctor.run(_args()) == 3 and "[down] queue" in capsys.readouterr().out
    monkeypatch.setitem(sys.modules, f"{PKG}.inbox_state", None)
    assert doctor.run(_args()) == 0 and "queue" not in capsys.readouterr().out


def test_doctor_warns_on_spool_and_scale_to_zero(monkeypatch, tmp_path, capsys) -> None:
    health, doctor = _load(monkeypatch, tmp_path)
    _gateway(monkeypatch, tmp_path)
    monkeypatch.setattr(doctor, "live_checks", lambda: [])
    _ready(health, doctor, tmp_path)
    spool = tmp_path / "pending_messages"
    spool.mkdir()
    for n in (1, 2):
        (spool / f"pending-{n}.json").write_text("{}")
    s2z = types.ModuleType("gateway.scale_to_zero")
    s2z.scale_to_zero_enabled = lambda: True
    relay = types.ModuleType("gateway.relay")
    relay.relay_wake_url = lambda: "https://relay.test/wake"
    monkeypatch.setitem(sys.modules, "gateway.scale_to_zero", s2z)
    monkeypatch.setitem(sys.modules, "gateway.relay", relay)
    rc = doctor.run(_args())
    out = capsys.readouterr().out
    assert rc == 0 and "[warn] transcripts" in out and "2 spooled" in out and "[warn] suspension" in out


def test_doctor_fails_closed_without_redactor(monkeypatch, tmp_path, capsys) -> None:
    health, doctor = _load(monkeypatch, tmp_path)
    monkeypatch.setitem(sys.modules, "agent.redact", None)
    _gateway(monkeypatch, tmp_path)
    monkeypatch.setattr(doctor, "live_checks", lambda: [])
    _ready(health, doctor, tmp_path)
    doctor.run(_args())
    lines = capsys.readouterr().out.splitlines()
    assert lines and {line.split()[-1] for line in lines} == {"[redacted]"}


def test_doctor_wait_polls_until_ready(monkeypatch, tmp_path, capsys) -> None:
    health, doctor = _load(monkeypatch, tmp_path)
    _gateway(monkeypatch, tmp_path)
    live = []
    monkeypatch.setattr(doctor, "live_checks", lambda: live.append(1) or [])
    h = _status(health, doctor, tmp_path)
    sleeps = []

    def sleep(seconds):
        sleeps.append(seconds)
        assert not live, "live checks run once, after the wait"
        if len(sleeps) == 2:
            h.ok("chat", interval_s=3)
            h.flush()

    monkeypatch.setattr(doctor.time, "sleep", sleep)
    assert doctor.run(_args(wait=60)) == 0
    assert len(sleeps) == 2 and live == [1]


def test_preflight_runs_agent_cli_under_current_interpreter(monkeypatch, tmp_path, capsys) -> None:
    _, doctor = _load(monkeypatch, tmp_path)
    cmds: list[list[str]] = []
    rc = [0]

    def run(cmd, **kwargs):
        cmds.append(cmd)
        return SimpleNamespace(returncode=rc[0])

    monkeypatch.setattr(doctor.subprocess, "run", run)
    assert doctor.run(_args(preflight=True)) == 0
    assert cmds[0][0] == sys.executable and cmds[0][1].endswith("agent-cli/clawbits_agent_cli.py")
    assert cmds[0][2:] == ["--help"]
    rc[0] = 1
    assert doctor.run(_args(preflight=True)) == 3 and "[down] agent_cli" in capsys.readouterr().out


def test_cli_registers_doctor(monkeypatch, tmp_path, capsys) -> None:
    _, doctor = _load(monkeypatch, tmp_path)
    signup = sys.modules[f"{PKG}.signup"]
    parser = argparse.ArgumentParser()
    signup._setup_cli(parser)
    args = parser.parse_args(["doctor", "--wait", "5", "--since", "1.5", "--preflight", "--json"])
    assert (args.wait, args.since, args.preflight, args.json) == (5.0, 1.5, True, True)
    seen = []
    monkeypatch.setattr(doctor, "run", lambda a: seen.append(a) or 7)
    assert args.func(args) == 7 and seen == [args]
    assert signup._cli_command(argparse.Namespace(clawbits_command=None)) == 2
    assert "{signup,doctor}" in capsys.readouterr().out


# --- signup -----------------------------------------------------------------


def _signup(monkeypatch, tmp_path, env_text: str, responses: dict[str, Any], endpoint: str | None = None):
    _load_hermes_module()
    _hermes_home(monkeypatch, tmp_path)
    env = tmp_path / ".env"
    env.write_text(env_text, encoding="utf-8")
    signup = sys.modules[f"{PKG}.signup"]
    urls: list[str] = []

    def fake_cli(cli_path: str, base_url: str, *args: str, **_: Any) -> Any:
        urls.append(base_url)
        answer = responses[args[0]]
        if isinstance(answer, BaseException):
            raise answer
        return answer

    monkeypatch.setattr(signup, "_run_agent_cli", fake_cli)
    monkeypatch.setattr(signup, "_mint_initial_tokens", lambda *a, **k: True)
    rc = signup._cli_command(argparse.Namespace(clawbits_command="signup", endpoint=endpoint, signup_token="tok"))
    return rc, env.read_text(), urls


_REVOKED = {
    "agent-info": RuntimeError("HTTP 401: revoked"),
    "signup-commit": {"agent_id": "new-agent", "api_key": "new-key"},
    "mm-operator-channel": {"channel_id": "chan-9"},
}


def test_signup_persists_explicit_endpoint(monkeypatch, tmp_path) -> None:
    old = "CLAWBITS_ENDPOINT=http://old\nCLAWBITS_API_KEY=old-key\nCLAWBITS_AGENT_ID=old-agent\n"
    rc, env, urls = _signup(monkeypatch, tmp_path, old, _REVOKED, endpoint="http://x:8000/")
    assert rc == 0 and set(urls) == {"http://x:8000"}
    lines = env.splitlines()
    assert [line for line in lines if line.startswith("CLAWBITS_ENDPOINT=")] == ["CLAWBITS_ENDPOINT=http://x:8000"]
    assert "CLAWBITS_API_KEY=new-key" in lines and "old-key" not in env
    rc, env, _ = _signup(monkeypatch, tmp_path, "CLAWBITS_API_KEY=old-key\nCLAWBITS_AGENT_ID=old-agent\n", _REVOKED)
    assert rc == 0 and "CLAWBITS_ENDPOINT" not in env


@pytest.mark.parametrize("created", [{"api_key": "SYNTH_ISSUED", "agent_id": ""}, "raw SYNTH_ISSUED output"])
def test_signup_failure_never_prints_the_issued_api_key(monkeypatch, tmp_path, capsys, caplog, created) -> None:
    rc, env, _ = _signup(monkeypatch, tmp_path, "", {**_REVOKED, "signup-commit": created})
    out = capsys.readouterr()
    assert rc == 1 and "signup failed" in out.err
    assert "SYNTH_ISSUED" not in out.out + out.err + caplog.text + env
