"""Automation catch-up and profile binding against the REAL Hermes cron store.

Unlike test_hermes_extension.py, nothing here fakes ``cron.jobs``: jobs.json and the
execution ledger live under a temp HERMES_HOME and a frozen clock drives both the
plugin and Hermes. Runs against whatever Hermes is importable (the pinned min/current
runtimes in CI; the ``hermes-agent`` checkout otherwise) and skips when none is.
"""

from __future__ import annotations

import asyncio
import importlib
import importlib.util
import json
import sys
import threading
import time
import types
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import pytest

REPO = Path(__file__).resolve().parents[2]
PLUGIN_DIR = REPO / "extensions" / "hermes"
# Stub-suite modules that would shadow the real runtime (and are restored afterwards).
_SHADOWED = ("cron", "gateway", "hermes_constants", "hermes_time", "hermes_cli", "agent", "utils")
T0 = datetime(2026, 9, 21, 8, 0, tzinfo=UTC)


def _ms(dt: datetime) -> int:
    return int(dt.timestamp() * 1000)


class _Clock:
    now = T0.timestamp()


class _FrozenDatetime(datetime):
    @classmethod
    def now(cls, tz=None):  # type: ignore[override]
        real = datetime.fromtimestamp(_Clock.now, tz or UTC)
        if tz is None:
            real = real.astimezone().replace(tzinfo=None)
        return cls.combine(real.date(), real.timetz(), tzinfo=real.tzinfo).replace(fold=real.fold)


class Rt(types.SimpleNamespace):
    """The real runtime plus the plugin module under test."""

    def at(self, dt: datetime) -> None:
        _Clock.now = dt.timestamp()

    def advance(self, **delta: float) -> None:
        _Clock.now += timedelta(**delta).total_seconds()

    def reconcile(self, client: Client, home: Path | None = None, agent_id: str = "agent") -> dict:
        self.mod.reconcile_automations_once(client, agent_id, "chan", hermes_home=home or self.home)
        return client.reports[-1]

    def restart(self, home: Path | None = None) -> int:
        """connect() in a fresh process: the in-process running set starts empty."""
        for job_id in self.scheduler.get_running_job_ids():
            self.scheduler.release_running_job(job_id)
        return self.reconnect(home)

    def reconnect(self, home: Path | None = None) -> int:
        """connect() again in the live process, as the reconnect watcher drives it."""
        return self.mod.hold_missed_slots(home or self.home)

    def start(self) -> list[tuple[str, str, str]]:
        """Hermes's tick up to the agent turn: due scan, pre-advance, ledger row, fire claim."""
        jobs, ex = self.jobs, self.executions
        started = []
        due = jobs.get_due_jobs()
        jobs.advance_next_runs([job["id"] for job in due])
        for job in due:
            row = ex.create_execution(job["id"], source="builtin", scheduled_instant=job.get("_scheduled_instant"))
            claimed = jobs.claim_job_for_fire(job["id"], return_job=True)
            if not claimed:
                ex.finish_execution(row["id"], success=False, error="claim lost")
                continue
            ex.mark_execution_running(row["id"])
            self.scheduler.try_register_running_job(job["id"])
            started.append((job["id"], row["id"], claimed["fire_claim"]["by"]))
        return started

    def finish(self, started: list[tuple[str, str, str]], *, ok: bool = True, delivery: str = "delivered") -> list[str]:
        """The end of the agent turn: mark the job run, then close its ledger row."""
        error = None if ok else "boom"
        for job_id, row_id, owner in started:
            self.scheduler.release_running_job(job_id)
            self.jobs.mark_job_run(job_id, ok, error, expected_fire_owner=owner)
            self.executions.finish_execution(row_id, success=ok, error=error, delivery_outcome=delivery)
        return [job_id for job_id, _, _ in started]

    def tick(self, *, ok: bool = True, delivery: str = "delivered") -> list[str]:
        """Hermes's tick, minus the agent."""
        return self.finish(self.start(), ok=ok, delivery=delivery)

    def job(self, automation_id: str = "a1") -> dict | None:
        return next(
            (j for j in self.jobs.list_jobs(include_disabled=True)
             if j.get("clawbits_automation_id") == automation_id),
            None,
        )


class Client:
    """Fake Clawbits server; echoes the reported gateway_job_id like get_desired_automations."""

    def __init__(self, *items: dict) -> None:
        self.items = list(items)
        self.reports: list[dict] = []
        self.job_ids: dict[str, str] = {}

    def set(self, *items: dict) -> None:
        self.items = list(items)

    def automations_desired(self) -> dict:
        return {"automations": [
            {**i, "gateway_job_id": i.get("gateway_job_id") or self.job_ids.get(i["automation_id"])}
            for i in self.items
        ]}

    def automations_state(self, report: dict) -> dict:
        self.reports.append(json.loads(json.dumps(report)))
        for entry in report["managed"]:
            if entry.get("gateway_job_id"):
                self.job_ids[entry["automation_id"]] = entry["gateway_job_id"]
        return {}


def spec(schedule: dict, **over: Any) -> dict:
    return {
        "name": "Digest",
        "payload": {"kind": "agentTurn", "message": "summarise"},
        "schedule": schedule,
        "enabled": True,
        "sessionTarget": "isolated",
        "wakeMode": "now",
        **over,
    }


def item(sp: dict, gen: int = 1, automation_id: str = "a1", **over: Any) -> dict:
    return {"automation_id": automation_id, "intent": "present", "desired_generation": gen,
            "desired_spec": sp, **over}


CRON_9 = {"kind": "cron", "expr": "0 9 * * *", "tz": "UTC"}
EVERY_60M = {"kind": "every", "everyMs": 3_600_000, "anchorMs": _ms(T0)}
EVERY_90S = {"kind": "every", "everyMs": 90_000, "anchorMs": _ms(T0)}


@pytest.fixture
def rt(monkeypatch, tmp_path) -> Rt:
    # The stub suite leaves file-less fakes (cron, cron.jobs, gateway.*) in sys.modules;
    # hide them for this test and put them back after. Real modules stay cached.
    fakes = {
        n: m for n, m in sys.modules.items()
        if n.split(".")[0] in _SHADOWED and getattr(m, "__file__", None) is None
    }
    for name in fakes:
        del sys.modules[name]
    scheduler = None
    try:
        # No installed Hermes: use the checkout, also when an earlier test cached it (its
        # lazy imports still need it on sys.path).
        checkout = REPO / "hermes-agent"
        found = importlib.util.find_spec("hermes_constants")
        if found is None or checkout in Path(found.origin or "").parents:
            # The checkout is a read-only reference: never write __pycache__ into it.
            monkeypatch.setattr(sys, "dont_write_bytecode", True)
            monkeypatch.syspath_prepend(str(checkout))
        home = tmp_path / "home"
        home.mkdir()
        monkeypatch.setenv("HERMES_HOME", str(home))
        monkeypatch.setenv("HERMES_TIMEZONE", "UTC")
        # create_job snapshots the default provider; skip boto3's EC2-metadata probe (~8 s).
        monkeypatch.setenv("AWS_EC2_METADATA_DISABLED", "true")
        try:
            jobs = importlib.import_module("cron.jobs")
            executions = importlib.import_module("cron.executions")
            scheduler = importlib.import_module("cron.scheduler")
            hermes_time = importlib.import_module("hermes_time")
        except Exception as exc:  # noqa: BLE001
            pytest.skip(f"real Hermes cron is not importable here: {exc}")
        # Process-global in Hermes: no run may leak into the next test's hold decisions.
        for job_id in scheduler.get_running_job_ids():
            scheduler.release_running_job(job_id)
        hermes_time.reset_cache()
        package = types.ModuleType("hermes_clawbits_catchup")
        package.__path__ = [str(PLUGIN_DIR)]
        monkeypatch.setitem(sys.modules, package.__name__, package)
        loaded = importlib.util.spec_from_file_location(f"{package.__name__}.automations",
                                                        PLUGIN_DIR / "automations.py")
        mod = importlib.util.module_from_spec(loaded)
        monkeypatch.setitem(sys.modules, loaded.name, mod)
        loaded.loader.exec_module(mod)
        _Clock.now = T0.timestamp()
        monkeypatch.setattr(time, "time", lambda: _Clock.now)
        monkeypatch.setattr(hermes_time, "datetime", _FrozenDatetime)
        monkeypatch.setattr(mod, "datetime", _FrozenDatetime)
        yield Rt(mod=mod, jobs=jobs, executions=executions, scheduler=scheduler,
                 home=home, tmp=tmp_path)
    finally:
        for job_id in (scheduler.get_running_job_ids() if scheduler else ()):
            scheduler.release_running_job(job_id)
        sys.modules.update(fakes)


@pytest.fixture
def croniter_available():
    pytest.importorskip("croniter")


def _catch_up_off(home: Path) -> None:
    (home / "config.yaml").write_text("cron:\n  catch_up_missed: false\n", encoding="utf-8")


def _runs(report: dict, prefix: str = "") -> list[dict]:
    return [r for r in report["runs"] if str(r.get("gateway_run_id")).startswith(prefix)]


def _prompts(home: Path) -> list[str]:
    data = json.loads((home / "cron" / "jobs.json").read_text())
    return [j["prompt"] for j in (data["jobs"] if isinstance(data, dict) else data)]


# --- pause across a slot, then resume ------------------------------------------------------


@pytest.mark.parametrize("schedule", [CRON_9, EVERY_60M], ids=["cron", "native-every"])
def test_resume_after_a_paused_slot_runs_it_once(rt, request, schedule) -> None:
    if schedule["kind"] == "cron":
        request.getfixturevalue("croniter_available")
    client = Client(item(spec(schedule)))
    rt.reconcile(client)
    rt.at(T0.replace(minute=30))
    client.set(item(spec(schedule, enabled=False), gen=2))
    rt.reconcile(client)
    assert rt.job()["state"] == "paused", "pause markers set, not just enabled=False"

    rt.at(T0.replace(hour=9, minute=30))
    assert rt.tick() == []
    client.set(item(spec(schedule), gen=3))
    rt.reconcile(client)
    assert rt.job()["clawbits_missed"]["slot_ms"] == _ms(T0.replace(hour=9))
    assert rt.job()["clawbits_missed"]["decision"] == "catch_up"

    rt.advance(seconds=30)
    assert len(rt.tick()) == 1, "the slot missed while paused runs exactly once"
    rt.advance(seconds=30)
    report = rt.reconcile(client)
    rt.advance(minutes=10)
    assert rt.tick() == [], "no second catch-up"
    [run] = [r for r in report["runs"] if r.get("status") == "ok"]
    assert run["summary"]["catch_up_for_ms"] == _ms(T0.replace(hour=9))


def test_later_runs_are_not_labelled_as_the_catch_up(rt) -> None:
    client = Client(item(spec(EVERY_60M)))
    rt.reconcile(client)
    client.set(item(spec(EVERY_60M, enabled=False), gen=2))
    rt.reconcile(client)
    rt.at(T0.replace(hour=9, minute=30))
    client.set(item(spec(EVERY_60M), gen=3))
    rt.reconcile(client)
    rt.advance(seconds=30)
    assert len(rt.tick()) == 1
    rt.advance(hours=1)
    assert len(rt.tick()) == 1, "the next regular run"
    rt.advance(seconds=30)
    [run] = [r for r in rt.reconcile(client)["runs"] if r.get("status") == "ok"]
    assert "catch_up_for_ms" not in run["summary"]


def test_native_interval_resume_never_calls_resume_job(rt, monkeypatch) -> None:
    """Hermes 0.21.3's resume_job recomputes from now and would drop the overdue slot."""
    monkeypatch.setattr(rt.jobs, "resume_job", lambda *a, **k: pytest.fail("resume_job used"))
    client = Client(item(spec(EVERY_60M)))
    rt.reconcile(client)
    client.set(item(spec(EVERY_60M, enabled=False), gen=2))
    rt.reconcile(client)
    rt.at(T0.replace(hour=9, minute=30))
    client.set(item(spec(EVERY_60M), gen=3))
    rt.reconcile(client)
    assert rt.job()["next_run_at"].startswith("2026-09-21T09:00:00"), "overdue slot kept for Hermes"


def _resume_after_pause(rt: Rt, client: Client, schedule: dict, resume: datetime) -> tuple[int, dict]:
    """Pause just after creation, resume at ``resume``; returns (first slot, resume report)."""
    rt.reconcile(client)
    slot = rt.mod._iso_ms(rt.job()["next_run_at"])
    rt.at(T0.replace(second=30))
    client.set(item(spec(schedule, enabled=False), gen=2))
    rt.reconcile(client)
    rt.at(resume)
    client.set(item(spec(schedule), gen=3))
    return slot, rt.reconcile(client)


@pytest.mark.parametrize("schedule", [CRON_9, EVERY_90S, EVERY_60M], ids=["cron", "every-90s", "native-every"])
def test_skip_policy_records_a_visible_skipped_row(rt, request, schedule) -> None:
    if schedule["kind"] == "cron":
        request.getfixturevalue("croniter_available")
    _catch_up_off(rt.home)
    resume = T0.replace(hour=11, minute=30)  # beyond Hermes's late grace for all three
    slot, report = _resume_after_pause(rt, Client(item(spec(schedule))), schedule, resume)

    [row] = _runs(report, "missed:")
    assert row["gateway_run_id"] == f"missed:{slot}"
    assert row["status"] == "skipped" and row["summary"]["did_not_run"] is True
    assert rt.mod._iso_ms(rt.job()["next_run_at"]) > _ms(resume)
    rt.advance(seconds=30)
    assert rt.tick() == [], "skipped means not run"


@pytest.mark.parametrize(
    ("schedule", "resume"),
    [
        (CRON_9, T0.replace(hour=10, minute=30)),  # 90 min late, grace 2 h
        (EVERY_90S, T0.replace(minute=3, second=10)),  # 100 s late, grace 120 s
        (EVERY_60M, T0.replace(hour=9, minute=20)),  # 20 min late, grace 30 min
    ],
    ids=["cron", "every-90s", "native-every"],
)
def test_skip_policy_still_runs_a_slot_late_within_hermes_grace(rt, request, schedule, resume) -> None:
    if schedule["kind"] == "cron":
        request.getfixturevalue("croniter_available")
    _catch_up_off(rt.home)
    slot, report = _resume_after_pause(rt, Client(item(spec(schedule))), schedule, resume)

    assert _runs(report, "missed:") == []
    assert rt.job()["clawbits_missed"] == {"slot_ms": slot, "decision": "catch_up", "at_ms": _ms(resume)}
    rt.advance(seconds=30)
    assert len(rt.tick()) == 1, "late within grace runs once, as native Hermes would"


def test_catch_up_collapses_many_missed_slots_into_one_run(rt, croniter_available) -> None:
    schedule = {"kind": "cron", "expr": "*/10 * * * *", "tz": "UTC"}
    client = Client(item(spec(schedule)))
    rt.reconcile(client)
    client.set(item(spec(schedule, enabled=False), gen=2))
    rt.reconcile(client)
    rt.at(T0 + timedelta(hours=5, minutes=3))  # 30 slots missed
    client.set(item(spec(schedule), gen=3))
    rt.reconcile(client)
    rt.advance(seconds=30)
    assert len(rt.tick()) == 1
    rt.advance(seconds=30)
    rt.reconcile(client)
    assert rt.job()["next_run_at"].startswith("2026-09-21T13:10:00"), "next future slot, not a replay"


# --- edits ---------------------------------------------------------------------------------


@pytest.mark.parametrize("schedule", [EVERY_60M, EVERY_90S], ids=["native-every", "every-90s"])
def test_prompt_and_name_edits_keep_interval_cadence(rt, schedule) -> None:
    client = Client(item(spec(schedule)))
    rt.reconcile(client)
    before = rt.job()["next_run_at"]
    rt.advance(seconds=20)
    client.set(item(spec(schedule, name="Renamed", payload={"kind": "agentTurn", "message": "p2"}), gen=2))
    rt.reconcile(client)
    assert rt.job()["next_run_at"] == before
    assert rt.job()["prompt"] == "p2"


def test_edit_after_a_missed_slot_does_not_drop_it(rt, croniter_available) -> None:
    client = Client(item(spec(CRON_9)))
    rt.reconcile(client)
    rt.at(T0.replace(hour=9, minute=30))  # gateway was down across 09:00; reconcile wins the race
    client.set(item(spec(CRON_9, payload={"kind": "agentTurn", "message": "edited"}), gen=2))
    rt.reconcile(client)
    assert rt.job()["clawbits_missed"]["decision"] == "catch_up"
    rt.advance(seconds=30)
    assert len(rt.tick()) == 1


def test_schedule_edit_supersedes_the_owed_slot(rt, croniter_available) -> None:
    client = Client(item(spec(CRON_9)))
    rt.reconcile(client)
    client.set(item(spec(CRON_9, enabled=False), gen=2))
    rt.reconcile(client)
    rt.at(T0.replace(hour=9, minute=30))
    client.set(item(spec({**CRON_9, "expr": "0 18 * * *"}), gen=3))
    rt.reconcile(client)
    assert rt.job()["next_run_at"].startswith("2026-09-21T18:00:00")
    assert "clawbits_missed" not in rt.job()


# --- gateway downtime ----------------------------------------------------------------------


@pytest.mark.parametrize("order", ["tick-first", "reconcile-first"])
def test_slot_missed_while_down_is_held_then_caught_up(rt, croniter_available, order) -> None:
    client = Client(item(spec(CRON_9)))
    rt.reconcile(client)
    rt.at(T0.replace(hour=9, minute=30))
    assert rt.restart() == 1
    if order == "tick-first":
        assert rt.tick() == [], "held, so the first tick neither runs nor retires it"
        assert rt.job() is not None
    rt.reconcile(client)
    rt.advance(seconds=30)
    fired = rt.tick()
    assert len(fired) == 1


def test_native_interval_is_not_held_and_follows_hermes_policy(rt) -> None:
    client = Client(item(spec(EVERY_60M)))
    rt.reconcile(client)
    rt.at(T0.replace(hour=9, minute=30))
    assert rt.restart() == 0, "Hermes owns a native interval's missed slot"
    assert len(rt.tick()) == 1, "cron.catch_up_missed default: one run"


def test_one_time_slot_missed_while_down_is_skipped_visibly(rt) -> None:
    at = _ms(T0.replace(hour=9))
    client = Client(item(spec({"kind": "at", "at": at})))
    rt.reconcile(client)
    rt.at(T0.replace(hour=9, minute=30))
    rt.restart()
    assert rt.tick() == []
    report = rt.reconcile(client)
    entry = report["managed"][0]
    assert entry["status"] == "applied"
    assert entry["reported_state"]["state"] == "completed"
    assert "lastRunStatus" not in entry["reported_state"], "never ran: no invented ok"
    assert _runs(report, "missed:")[0]["gateway_run_id"] == f"missed:{at}"
    rt.advance(minutes=5)
    assert rt.tick() == []


def test_vanished_one_time_job_reports_the_ledger_outcome(rt) -> None:
    at = _ms(T0.replace(hour=9))
    client = Client(item(spec({"kind": "at", "at": at})))
    rt.reconcile(client)
    rt.at(T0.replace(hour=9, second=20))
    rt.tick(ok=False)
    job_id = rt.job()["id"]
    rt.jobs.remove_job(job_id)  # Hermes's completed-one-shot retention sweep, 7 days later
    rt.advance(days=7)
    entry = rt.reconcile(client)["managed"][0]
    assert entry["gateway_job_id"] == job_id
    assert entry["reported_state"]["lastRunStatus"] == "error", "the failure, not an assumed ok"


def test_one_time_job_retired_by_hermes_reports_a_missed_row(rt) -> None:
    at = _ms(T0.replace(hour=9))
    client = Client(item(spec({"kind": "at", "at": at})))
    rt.reconcile(client)
    rt.at(T0.replace(hour=9, minute=30))
    assert rt.tick() == []  # no hold: Hermes retires it unrun
    assert rt.job() is None
    first, second = rt.reconcile(client), rt.reconcile(client)
    assert "lastRunStatus" not in first["managed"][0]["reported_state"]
    [row] = _runs(first, "missed:")
    assert row["gateway_run_id"] == f"missed:{at}" and row["status"] == "skipped"
    assert _runs(second, "missed:") == [row], "re-reports upsert the same row"


def test_one_time_job_removed_by_hand_invents_no_outcome(rt) -> None:
    at = _ms(T0.replace(hour=9))
    client = Client(item(spec({"kind": "at", "at": at})))
    rt.reconcile(client)
    rt.jobs.remove_job(rt.job()["id"])
    rt.at(T0.replace(hour=9, minute=30))
    report = rt.reconcile(client)
    assert report["runs"] == []
    assert "lastRunStatus" not in report["managed"][0]["reported_state"]


def test_vanished_recurring_job_reports_a_missed_row(rt, croniter_available) -> None:
    client = Client(item(spec(CRON_9)))
    rt.reconcile(client)
    old = rt.job()["id"]
    rt.jobs.remove_job(old)  # retired unrun by a tick that beat the hold
    report = rt.reconcile(client)
    assert _runs(report, "missed:")[0]["gateway_run_id"] == f"missed:{old}"
    assert rt.job()["id"] != old


# --- decision durability -------------------------------------------------------------------


def test_restart_between_decision_and_rearm_keeps_one_catch_up(rt, croniter_available, monkeypatch) -> None:
    client = Client(item(spec(CRON_9)))
    rt.reconcile(client)
    rt.at(T0.replace(hour=9, second=30))
    assert len(rt.tick()) == 1
    rt.at(datetime(2026, 9, 23, 10, 0, tzinfo=UTC))  # server unreachable for two days
    real = rt.jobs.rearm_oneshot
    monkeypatch.setattr(rt.jobs, "rearm_oneshot", lambda *a, **k: (_ for _ in ()).throw(OSError("killed")))
    assert rt.reconcile(client)["managed"][0]["status"] == "failed"
    recorded = rt.job()["clawbits_missed"]
    assert recorded["slot_ms"] == _ms(datetime(2026, 9, 22, 9, tzinfo=UTC)), "decision persisted first"
    monkeypatch.setattr(rt.jobs, "rearm_oneshot", real)
    rt.reconcile(client)
    assert rt.job()["clawbits_missed"]["slot_ms"] == recorded["slot_ms"]
    rt.advance(seconds=30)
    assert len(rt.tick()) == 1
    rt.advance(seconds=30)
    rt.reconcile(client)
    assert rt.job()["next_run_at"].startswith("2026-09-24T09:00:00")


def test_unrun_catch_up_keeps_its_original_slot_after_a_long_restart(rt, croniter_available) -> None:
    client = Client(item(spec(CRON_9)))
    rt.reconcile(client)
    client.set(item(spec(CRON_9, enabled=False), gen=2))
    rt.reconcile(client)
    rt.at(T0.replace(hour=9, minute=30))
    client.set(item(spec(CRON_9), gen=3))
    rt.reconcile(client)  # catch-up armed at 09:30 ...
    rt.at(T0.replace(hour=10))  # ... but the gateway died before it ran
    rt.restart()
    rt.reconcile(client)
    assert rt.job()["clawbits_missed"]["slot_ms"] == _ms(T0.replace(hour=9))
    rt.advance(seconds=30)
    assert len(rt.tick()) == 1


@pytest.mark.parametrize("catch_up", [True, False], ids=["catch-up", "skip"])
def test_a_run_in_flight_past_its_slot_is_not_a_miss(rt, croniter_available, catch_up) -> None:
    if not catch_up:
        _catch_up_off(rt.home)
    client = Client(item(spec(CRON_9)))
    rt.reconcile(client)
    rt.at(T0.replace(hour=9, second=5))
    started = rt.start()
    assert len(started) == 1
    rt.at(T0.replace(hour=9, minute=2))  # the agent turn is still running
    rt.reconcile(client)
    assert "clawbits_missed" not in rt.job()
    assert rt.job()["next_run_at"].startswith("2026-09-21T09:00:00")

    rt.at(T0.replace(hour=9, minute=3))
    rt.finish(started)
    rt.advance(seconds=30)
    report = rt.reconcile(client)
    assert _runs(report, "missed:") == []
    [run] = [r for r in report["runs"] if r.get("status") == "ok"]
    assert "catch_up_for_ms" not in run["summary"]
    assert rt.job()["next_run_at"].startswith("2026-09-22T09:00:00")
    rt.advance(minutes=10)
    assert rt.tick() == []


@pytest.mark.parametrize("seen", ["held-at-restart", "claims-aged-out"])
def test_a_run_interrupted_by_a_restart_is_not_rerun(rt, croniter_available, seen) -> None:
    """At most once, as Hermes's own recurring jobs: a crash loop must not replay the slot."""
    client = Client(item(spec(CRON_9)))
    rt.reconcile(client)
    rt.at(T0.replace(hour=9, second=5))
    assert len(rt.start()) == 1  # ... and the gateway dies mid-turn
    if seen == "held-at-restart":
        rt.at(T0.replace(hour=9, minute=5))
        assert rt.restart() == 1
    else:
        rt.at(T0.replace(hour=9, minute=15))
        rt.reconcile(client)
        assert rt.job()["next_run_at"].startswith("2026-09-21T09:00:00"), "a fresh claim may be live"
        rt.at(T0.replace(hour=9, minute=40))
    rt.reconcile(client)
    job = rt.job()
    assert "clawbits_missed" not in job
    assert job["next_run_at"].startswith("2026-09-22T09:00:00")
    assert job["fire_claim"] is None and job["run_claim"] is None, "the dead runner's claims are gone"
    rt.advance(minutes=5)
    assert rt.tick() == []
    rt.at(datetime(2026, 9, 22, 9, 0, 30, tzinfo=UTC))
    assert len(rt.tick()) == 1, "the next slot runs"


def test_a_run_this_process_is_firing_keeps_its_slot_across_a_reconnect(rt, croniter_available):
    """connect() also runs on a reconnect, with the ticker live: a live run is not a missed slot."""
    client = Client(item(spec(CRON_9)))
    rt.reconcile(client)
    rt.at(T0.replace(hour=9, second=5))
    started = rt.start()
    assert len(started) == 1
    rt.at(T0.replace(hour=9, minute=2))  # past the miss cutoff, the agent turn still running

    assert rt.reconnect() == 0
    job = rt.job()
    assert job["paused_reason"] is None and job["fire_claim"] is not None

    rt.finish(started)
    rt.advance(seconds=30)
    report = rt.reconcile(client)
    assert [r.get("status") for r in report["runs"]] == ["ok"]
    assert _runs(report, "missed:") == []
    assert rt.job()["next_run_at"].startswith("2026-09-22T09:00:00")


def test_pausing_a_fired_job_whose_next_slot_passed_keeps_it_owed(rt, croniter_available) -> None:
    schedule = {"kind": "cron", "expr": "*/10 * * * *", "tz": "UTC"}
    client = Client(item(spec(schedule)))
    rt.reconcile(client)
    rt.at(T0.replace(minute=10, second=5))
    assert len(rt.tick()) == 1
    rt.at(T0.replace(minute=40))  # server unreachable across 08:20 and 08:30, then paused
    client.set(item(spec(schedule, enabled=False), gen=2))
    for _ in range(2):
        assert rt.reconcile(client)["managed"][0]["status"] == "applied"
        rt.advance(minutes=5)
        assert rt.tick() == []

    rt.at(T0.replace(minute=55))
    client.set(item(spec(schedule), gen=3))
    rt.reconcile(client)
    assert rt.job()["clawbits_missed"]["slot_ms"] == _ms(T0.replace(minute=20))
    rt.advance(seconds=30)
    assert len(rt.tick()) == 1
    rt.advance(seconds=30)
    rt.reconcile(client)
    assert rt.job()["next_run_at"].startswith("2026-09-21T09:00:00")


def test_a_fired_cron_job_can_become_a_native_interval(rt, croniter_available) -> None:
    client = Client(item(spec(CRON_9)))
    rt.reconcile(client)
    rt.at(T0.replace(hour=9, second=5))
    assert len(rt.tick()) == 1
    rt.advance(seconds=25)
    client.set(item(spec(EVERY_60M), gen=2))
    assert rt.reconcile(client)["managed"][0]["status"] == "applied"
    assert rt.job()["schedule"]["kind"] == "interval"
    for hour in (10, 11):
        rt.at(T0.replace(hour=hour, second=30))
        assert len(rt.tick()) == 1, "an unbounded interval, not a spent one-shot"


# --- DST -----------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("expr", "start", "expected_utc"),
    [
        ("30 1 * * *", datetime(2026, 11, 1, 1, 30, 40, tzinfo=ZoneInfo("America/New_York")),
         datetime(2026, 11, 2, 6, 30, tzinfo=UTC)),  # 01:30 EST, not 02:30
        ("30 2 * * *", datetime(2026, 3, 7, 2, 30, 40, tzinfo=ZoneInfo("America/New_York")),
         datetime(2026, 3, 8, 7, 30, tzinfo=UTC)),  # nonexistent 02:30 runs at 03:30 EDT
    ],
    ids=["fall-back", "spring-forward"],
)
def test_tz_cron_keeps_wall_clock_across_dst(rt, croniter_available, expr, start, expected_utc) -> None:
    schedule = {"kind": "cron", "expr": expr, "tz": "America/New_York"}
    assert rt.mod._slot_after(schedule, _ms(start.replace(second=0)) - 1000, None) == _ms(start.replace(second=0))
    assert rt.mod._slot_after(schedule, _ms(start), None) == _ms(expected_utc)


# --- run now -------------------------------------------------------------------------------


def test_run_now_while_paused_is_a_miss_and_keeps_the_owed_slot(rt, croniter_available) -> None:
    client = Client(item(spec(CRON_9)))
    rt.reconcile(client)
    client.set(item(spec(CRON_9, enabled=False), gen=2))
    rt.reconcile(client)
    rt.at(T0.replace(hour=9, minute=30))
    client.set(item(spec(CRON_9, enabled=False), gen=2, run_requested_generation=1))
    report = rt.reconcile(client)
    assert _runs(report, "run-now:")[0]["summary"]["reason"] == "stopped"
    assert rt.tick() == []
    assert rt.job()["next_run_at"].startswith("2026-09-21T09:00:00")


def test_run_now_on_a_completed_one_time_job_runs_once(rt) -> None:
    schedule = {"kind": "at", "at": _ms(T0.replace(hour=9))}
    client = Client(item(spec(schedule)))
    rt.reconcile(client)
    rt.at(T0.replace(hour=9, second=20))
    assert len(rt.tick()) == 1
    rt.reconcile(client)
    rt.at(T0.replace(hour=9, minute=10))
    client.set(item(spec(schedule), run_requested_generation=1))
    rt.reconcile(client)
    assert len(rt.tick()) == 1
    for _ in range(3):
        rt.advance(minutes=1)
        assert rt.reconcile(client)["managed"][0]["reported_state"]["state"] == "completed"
        assert rt.tick() == [], "run generation is observed once"


def test_declined_run_now_disarms_without_refusing_later_writes(rt, monkeypatch) -> None:
    schedule = {"kind": "at", "at": _ms(T0.replace(hour=9))}
    client = Client(item(spec(schedule)))
    rt.reconcile(client)
    rt.at(T0.replace(hour=9, second=20))
    rt.tick()
    rt.reconcile(client)
    monkeypatch.setattr(rt.jobs, "trigger_job", lambda job_id: {"ok": False})
    client.set(item(spec(schedule), run_requested_generation=1))
    assert rt.reconcile(client)["managed"][0]["status"] == "applied"
    assert rt.job()["enabled"] is False and rt.job()["state"] == "completed"


# --- execution vs delivery outcome -----------------------------------------------------------


@pytest.mark.parametrize(
    ("finish", "status", "summary"),
    [
        ({"success": True, "delivery_outcome": "failed"}, "ok", {"delivered": False}),
        ({"success": True, "delivery_outcome": "delivered"}, "ok", {"delivered": True}),
        ({"success": False, "error": "boom", "delivery_outcome": "suppressed_acked"}, "error",
         {"delivery_status": "suppressed_acked"}),
        (None, None, {}),  # claimed, still running
    ],
    ids=["ran-not-delivered", "delivered", "suppressed-repeat-alert", "in-flight"],
)
def test_run_row_keeps_execution_and_delivery_separate(rt, finish, status, summary) -> None:
    client = Client(item(spec(EVERY_60M)))
    rt.reconcile(client)
    job_id = rt.job()["id"]
    rt.jobs.update_job(job_id, {"last_delivery_error": "old run's error"})
    row = rt.executions.create_execution(job_id, source="builtin")
    if finish is not None:
        rt.executions.finish_execution(row["id"], **finish)
    [run] = [r for r in rt.reconcile(client)["runs"] if r["gateway_run_id"] == row["id"]]
    assert run.get("status") == status
    for key, value in summary.items():
        assert run["summary"][key] == value
    if finish is None:
        assert "finished_at_ms" not in run and "delivery_error" not in run["summary"]


def test_interrupted_execution_is_uncertain_not_failed(rt) -> None:
    sched = importlib.import_module("cron.scheduler")
    client = Client(item(spec(EVERY_60M)))
    rt.reconcile(client)
    row = rt.executions.create_execution(rt.job()["id"], source="builtin")
    rt.executions.finish_execution(row["id"], success=False, error=sched._OWNERSHIP_LOST_INTERRUPTED)
    [run] = [r for r in rt.reconcile(client)["runs"] if r["gateway_run_id"] == row["id"]]
    assert "status" not in run and run["summary"]["outcome_unknown"] is True


def test_unknown_execution_is_uncertain_not_failed(rt) -> None:
    client = Client(item(spec(EVERY_60M)))
    rt.reconcile(client)
    job_id = rt.job()["id"]
    row = rt.executions.create_execution(job_id, source="builtin")
    with rt.executions._transaction() as conn:  # what recover_interrupted_executions writes
        conn.execute("UPDATE executions SET status='unknown', error='owner exited' WHERE id=?", (row["id"],))
    [run] = [r for r in rt.reconcile(client)["runs"] if r["gateway_run_id"] == row["id"]]
    assert "status" not in run
    assert run["summary"]["outcome_unknown"] is True


# --- agent binding -------------------------------------------------------------------------


@pytest.mark.parametrize(("agent_id", "retired"), [("other", True), ("agent", False)],
                         ids=["foreign", "own"])
def test_an_orphan_managed_job_is_retired_only_for_a_foreign_agent(rt, agent_id, retired) -> None:
    """--reset and Reef re-enrollment keep cron/jobs.json; the owner stamp retires what is left."""
    at = _ms(T0.replace(hour=9))
    client = Client(item(spec({"kind": "at", "at": at})))
    rt.reconcile(client)
    job_id = rt.job()["id"]
    assert rt.job()[rt.mod._OWNER_KEY] == "agent"

    client.set()  # the automation is not in this agent's desired list
    report = rt.reconcile(client, agent_id=agent_id)
    assert [e["gateway_job_id"] for e in report["external"]] == [job_id]
    assert (rt.job()["state"] == "completed") is retired
    assert rt.job()[rt.mod._OWNER_KEY] == agent_id, "claimed, so the retire is a one-time write"

    rt.at(T0.replace(hour=9, minute=1))
    assert (rt.tick() == []) is retired


# --- profile binding -----------------------------------------------------------------------


def test_two_profiles_with_the_same_automation_id_stay_in_their_own_store(rt) -> None:
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override

    home_b = rt.tmp / "profiles" / "b"
    home_b.mkdir(parents=True)
    client_a = Client(item(spec(EVERY_60M, payload={"kind": "agentTurn", "message": "A"})))
    client_b = Client(item(spec(EVERY_60M, payload={"kind": "agentTurn", "message": "B"})))

    def run_b_with_a_ambient() -> None:
        token = set_hermes_home_override(str(rt.home))  # a wrong ambient scope must not win
        try:
            rt.reconcile(client_b, home=home_b)
            rt.restart(home_b)
        finally:
            reset_hermes_home_override(token)

    threads = [threading.Thread(target=rt.reconcile, args=(client_a,)), threading.Thread(target=run_b_with_a_ambient)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert _prompts(rt.home) == ["A"]
    assert _prompts(home_b) == ["B"]
    assert client_a.reports[-1]["external"] == [] and client_b.reports[-1]["external"] == []
    assert client_a.job_ids["a1"] != client_b.job_ids["a1"]


def test_reconciler_without_a_home_pins_the_profile_active_at_start(rt, monkeypatch) -> None:
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override

    home_b = rt.tmp / "profiles" / "b"
    home_b.mkdir(parents=True)
    monkeypatch.setattr(rt.mod, "AUTOMATIONS_RECONCILE_INTERVAL_SECONDS", 0.01)
    client = Client(item(spec(EVERY_60M)))

    async def scenario() -> None:
        token = set_hermes_home_override(str(home_b))  # the scope the adapter connects in
        try:
            task = asyncio.create_task(
                rt.mod.run_automations_reconciler(
                    client, "agent", "chan", asyncio.Event(), lambda: not client.reports
                )
            )
        finally:
            reset_hermes_home_override(token)
        await task

    asyncio.run(scenario())
    assert _prompts(home_b) == ["summarise"]
    assert not (rt.home / "cron" / "jobs.json").exists()


@pytest.mark.parametrize("raw", ["$CB_PROFILES/b", "~/profiles/b"])
def test_default_home_expands_user_and_env_vars(rt, monkeypatch, raw) -> None:
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override

    monkeypatch.setenv("CB_PROFILES", str(rt.tmp / "profiles"))
    monkeypatch.setenv("HOME", str(rt.tmp))
    token = set_hermes_home_override(raw)
    try:
        assert rt.mod._active_home() == rt.tmp / "profiles" / "b"
    finally:
        reset_hermes_home_override(token)


@pytest.mark.parametrize(
    ("over", "ok"),
    [({"agentId": "agent"}, True), ({"agentId": "someone-else"}, False), ({"sessionKey": "main"}, False)],
    ids=["own-agent", "other-agent", "session-key"],
)
def test_cross_agent_targeting_is_rejected(rt, over, ok) -> None:
    entry = rt.reconcile(Client(item(spec(EVERY_60M, **over))))["managed"][0]
    assert (entry["status"] == "applied") is ok
    assert (rt.job() is not None) is ok


def test_transient_claim_loss_after_delivery_keeps_an_ok_run(rt, monkeypatch) -> None:
    """A fire-claim heartbeat sample that misses after delivery is not a failed run.

    Hermes fixed this in the scheduler after 0.21.3 (eafed27cf0); the plugin must report
    the ledger's real outcome and keep delivery separate, not re-derive it.
    """
    sched = importlib.import_module("cron.scheduler")
    native_fix = hasattr(sched, "_FIRE_CLAIM_MISS_CONFIRM_SECONDS")  # eafed27cf0, after 0.21.3
    client = Client(item(spec(EVERY_60M)))
    rt.reconcile(client)
    job_id = rt.job()["id"]
    assert rt.jobs.claim_job_for_fire(job_id) is True
    real_heartbeat = sched.heartbeat_fire_claim
    samples = {"n": 0}

    def sampled(jid, *, expected_owner):
        samples["n"] += 1
        return False if samples["n"] == 3 else real_heartbeat(jid, expected_owner=expected_owner)

    monkeypatch.setattr(sched, "heartbeat_fire_claim", sampled)
    monkeypatch.setattr(sched, "run_job", lambda job, **kw: (True, "out", "report", None))
    monkeypatch.setattr(sched, "_deliver_result", lambda job, content, **kw: None)
    monkeypatch.setattr(sched, "_launch_external_cron_worker", lambda job: False)
    job = rt.jobs.get_job(job_id)
    assert sched.run_one_job(job, cancel_event=threading.Event()) is True
    assert samples["n"] >= 3, "the post-delivery sample really missed"
    [run] = [r for r in rt.reconcile(client)["runs"] if not r["gateway_run_id"].startswith("missed:")]
    if native_fix:
        assert run["status"] == "ok"
        assert run["summary"].get("delivered") is not False
    else:  # 0.21.3 writes _OWNERSHIP_LOST_INTERRUPTED: uncertain, never a false error
        assert "status" not in run
        assert run["summary"]["outcome_unknown"] is True
