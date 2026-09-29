"""The adapter's health reporting: the status file ``hermes clawbits doctor`` reads."""

from __future__ import annotations

import argparse
import asyncio
import importlib
import json
import logging
import os
import sys
import threading
import time
import types
from pathlib import Path
from typing import Any

import pytest

from tests.poc.hermes_stubs import _FakePlatformConfig, _load_hermes_module

PKG = "hermes_clawbits_test"


@pytest.fixture
def mod(monkeypatch):
    mod = _load_hermes_module()
    utils = types.ModuleType("utils")

    def atomic_json_write(path, data, *, indent=2, mode=None):
        Path(path).write_text(json.dumps(data))
        os.chmod(path, mode or 0o644)

    utils.atomic_json_write = atomic_json_write
    monkeypatch.setitem(sys.modules, "utils", utils)
    return mod


def _adapter(mod, **extra: Any):
    config = _FakePlatformConfig(extra={"api_key": "k", "agent_id": "agent", **extra})
    return mod.ClawbitsAdapter(config)


def _status() -> dict[str, Any]:
    path = Path(os.environ["HERMES_HOME"]) / "plugin-data" / "clawbits-platform" / "status.json"
    return json.loads(path.read_text())


class _Client:
    """Answers one poll or liveness ping, then stops the adapter."""

    def __init__(self, adapter, error: Exception | None = None) -> None:
        self.adapter, self.error = adapter, error

    def _answer(self, value: Any) -> Any:
        self.adapter._running = False
        if self.error:
            raise self.error
        return value

    def list_channels(self) -> list[Any]:
        return self._answer([])

    def alive(self) -> dict[str, Any]:
        return self._answer({})

    def agent_info(self, agent_id: str) -> dict[str, Any]:
        return {}


def _run_loop(adapter, loop: str, error: Exception | None = None) -> dict[str, Any]:
    assert asyncio.run(adapter._open_journal())
    adapter.client, adapter._running = _Client(adapter, error), True
    adapter.poll_interval = adapter.liveness_interval = 0
    adapter._ready.set()
    asyncio.run(getattr(adapter, loop)())
    adapter._health.flush(force=True)
    return _status()["subsystems"]


async def _idle(*_: Any, **__: Any) -> None:
    return None


def test_loops_record_health_as_codes(mod) -> None:
    adapter = _adapter(mod)
    loops = (("_poll_loop", "chat"), ("_liveness_loop", "liveness"))
    for loop, name in loops:
        entry = _run_loop(adapter, loop)[name]
        assert entry["last_ok_at"] and entry["error"] is None and entry["interval_s"] == 0
        entry = _run_loop(adapter, loop, RuntimeError("HTTP 503: body sk-SECRET"))[name]
        assert entry["error"] == "http_503" and entry["failures"] == 1
    assert "SECRET" not in json.dumps(_status())


class _Operator:
    """agent-info and operator-channel answers for one ``_operator_identity`` lookup."""

    def __init__(self, info: Any, channel: str | None) -> None:
        self.info, self.channel = info, channel

    def agent_info(self, agent_id: str) -> dict[str, Any]:
        if isinstance(self.info, Exception):
            raise self.info
        return self.info

    def operator_channel(self, agent_id: str) -> str | None:
        return self.channel


def test_operator_lookups_report_the_controls_subsystem(mod) -> None:
    adapter = _adapter(mod)

    def identity(info: Any, channel: str | None) -> dict[str, Any]:
        adapter._operator, adapter.client = None, _Operator(info, channel)
        asyncio.run(adapter._operator_identity())
        adapter._health.flush(force=True)
        return _status()["subsystems"]["controls"]

    assert identity({"operator_id": None}, "dm")["error"] == "operator_unresolved"
    assert identity({"operator_id": 7}, None)["error"] == "operator_unresolved"
    lookup_failed = identity(RuntimeError("HTTP 503: body sk-SECRET"), "dm")
    assert (lookup_failed["error"], lookup_failed["failures"]) == ("http_503", 3)
    assert "SECRET" not in json.dumps(_status())
    bound = identity({"operator_id": 7}, "dm")
    assert bound["error"] is None and bound["state"] == "operator_bound"
    assert "interval_s" not in bound, "event-driven: a quiet agent must not read as stalled"


def test_a_failed_reconcile_pass_reaches_the_status_file(mod, monkeypatch) -> None:
    automations = sys.modules[f"{PKG}.automations"]
    monkeypatch.setattr(automations, "AUTOMATIONS_MIN_REPASS_SECONDS", 0)
    adapter = _adapter(mod)

    def one_pass(error: Exception | None) -> dict[str, Any]:
        passes: list[int] = []

        async def run() -> None:
            wake = asyncio.Event()

            def once(*args: Any, **kwargs: Any) -> None:
                passes.append(1)
                wake.set()  # ends the pass without waiting out the interval
                if error:
                    raise error

            monkeypatch.setattr(automations, "reconcile_automations_once", once)
            await automations.run_automations_reconciler(
                None, "agent", "dm", wake, lambda: not passes, health=adapter._health
            )

        asyncio.run(run())
        adapter._health.flush(force=True)
        return _status()["subsystems"]["automations"]

    failed = one_pass(RuntimeError("HTTP 503: body sk-SECRET"))
    assert failed["error"] == "http_503" and failed["failures"] == 1
    assert failed["interval_s"] == automations.AUTOMATIONS_RECONCILE_INTERVAL_SECONDS
    assert one_pass(None)["error"] is None
    assert "SECRET" not in json.dumps(_status())


def test_controls_and_automations_warn_rather_than_fail(mod) -> None:
    doctor = importlib.import_module(f"{PKG}.doctor")
    entry = {"error": "operator_unresolved", "failures": 2}
    levels = [doctor._subsystem(name, entry, 0.0).level for name in ("controls", "automations")]
    assert levels == [doctor.WARN, doctor.WARN], "an upgrade must not roll back on either"


def test_connect_writes_status_and_disconnect_records_the_stop(mod, monkeypatch, caplog) -> None:
    monkeypatch.setattr(mod.adapter, "run_automations_reconciler", _idle)
    monkeypatch.setattr(mod.adapter, "hold_missed_slots", lambda home: 0)
    monkeypatch.setenv("CLAWBITS_EMAIL_ENABLED", "false")
    scale = types.SimpleNamespace(scale_to_zero_enabled=lambda: True)
    relay = types.SimpleNamespace(relay_wake_url=lambda: "https://relay/wake")
    monkeypatch.setitem(sys.modules, "gateway.scale_to_zero", scale)
    monkeypatch.setitem(sys.modules, "gateway.relay", relay)
    adapter = _adapter(mod)
    for loop in ("_poll_loop", "_liveness_loop", "_lobstertalk_ws_loop"):
        setattr(adapter, loop, _idle)

    async def run() -> dict[str, Any]:
        assert await adapter.connect()
        while not adapter._health.path.exists():
            await asyncio.sleep(0.01)
        running = _status()
        await adapter.disconnect()
        return running

    with caplog.at_level(logging.WARNING):
        running = asyncio.run(run())
    assert running["plugin_version"] == mod.PLUGIN_VERSION and running["pid"] == os.getpid()
    assert running["subsystems"]["email"]["state"] == "disabled" and "stopped_at" not in running
    assert _status()["stopped_at"] and adapter._status_task is None
    assert [r for r in caplog.records if "wake path" in r.getMessage()]


def test_a_real_poll_satisfies_doctor(mod, monkeypatch) -> None:
    since = time.time() - 1
    adapter = _adapter(mod)
    doctor = importlib.import_module(f"{PKG}.doctor")
    monkeypatch.setattr(doctor, "gateway_checks", lambda home: [])  # Hermes's side of the report
    monkeypatch.setattr(doctor, "live_checks", lambda: [])
    args = argparse.Namespace(wait=0, since=since, preflight=False, json=False)
    adapter._health.flush()
    assert doctor.run(args) == 3, "connected but not polled yet"
    _run_loop(adapter, "_poll_loop")
    assert doctor.run(args) == 0


@pytest.mark.parametrize(
    ("error", "reason", "code"),
    [
        ("too_new", "journal_schema_newer", "clawbits_state_too_new"),
        ("backup", "journal_backup_failed", "clawbits_state_migration"),
    ],
)
def test_newer_or_unmigratable_journal_holds_intake(mod, monkeypatch, error, reason, code) -> None:
    inbox = sys.modules[f"{PKG}.inbox_state"]

    def refuse(*args: Any, **kwargs: Any) -> Any:
        if error == "too_new":
            raise inbox.JournalTooNew("newer")
        raise inbox.JournalMigrationError(reason)

    monkeypatch.setattr(mod.adapter, "open_journal", refuse)
    held: list[Any] = []
    monkeypatch.setattr(mod.adapter, "hold_missed_slots", held.append)
    adapter = _adapter(mod)

    assert asyncio.run(adapter.connect()) is False
    assert adapter.fatal_error[0] == code and adapter.fatal_error[2] is True
    assert _status()["hold"] == reason, "flushed at once, before any writer task"
    assert adapter._journal is None and held == [] and adapter._mailroom is None
    tasks = ("_task", "_liveness_task", "_status_task", "_automations_task", "_mailroom_task")
    assert all(getattr(adapter, attr) is None for attr in tasks)


def test_durable_chat_admission_records_a_receipt(mod) -> None:
    from tests.poc.intake_fakes import FakeClawbits, adapter_for, pump

    home = Path(os.environ["HERMES_HOME"])
    home.mkdir(parents=True, exist_ok=True)
    (home / ".clawbits_greeted").touch()
    fake = FakeClawbits()
    adapter = adapter_for(mod, fake)

    async def run() -> None:
        assert await adapter._open_journal()
        await pump(adapter, passes=1)
        assert "last_receipt_at" not in adapter._health.doc["subsystems"].get("chat", {})
        fake.post("hello")
        await pump(adapter, passes=1)

    asyncio.run(run())
    adapter._health.flush(force=True)
    assert _status()["subsystems"]["chat"]["last_receipt_at"]


def test_connect_holds_missed_slots_before_starting_the_reconciler(mod, monkeypatch) -> None:
    calls: list[tuple[str, Any]] = []

    def import_module(name: str) -> None:
        calls.append(("import", name, threading.get_ident()))

    def hold(home: Path) -> None:
        calls.append(("hold", home, threading.get_ident()))

    fake_importlib = types.SimpleNamespace(import_module=import_module)
    monkeypatch.setattr(mod.adapter, "importlib", fake_importlib)
    monkeypatch.setattr(mod.adapter, "hold_missed_slots", hold)

    def reconciler(*args: Any, hermes_home: Any = None, health: Any = None) -> Any:
        calls.append(("reconciler", hermes_home))
        return _idle()

    monkeypatch.setattr(mod.adapter, "run_automations_reconciler", reconciler)
    monkeypatch.setenv("CLAWBITS_EMAIL_ENABLED", "false")
    adapter = _adapter(mod)
    for loop in ("_poll_loop", "_liveness_loop", "_lobstertalk_ws_loop"):
        setattr(adapter, loop, _idle)

    async def run() -> None:
        assert await adapter.connect()
        await adapter.disconnect()

    asyncio.run(run())
    home, loop_thread = adapter.account.hermes_home, threading.get_ident()
    [(_, cron, importer), (_, held, holder), reconciler] = calls
    assert (cron, importer) == ("cron", loop_thread), "cron is first imported on the loop thread"
    assert held == home and holder != loop_thread
    assert reconciler == ("reconciler", home)
