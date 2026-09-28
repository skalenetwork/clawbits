"""Reconcile Clawbits-managed automations into Hermes cron jobs.

The Hermes side of this is ``cron.jobs`` (``/opt/hermes/cron/jobs.py``), plus
``cron.executions`` where available. Two properties are load-bearing and were
verified against the image Reef actually builds — NOT against a stale local
``hermes-agent:latest``, which lags the real base by weeks and is missing APIs
this module depends on:

- ``update_job`` merges ``{**job, **updates}`` and saves, and neither it nor
  ``list_jobs`` whitelists fields — so the ``clawbits_*`` sentinel keys below
  survive a round trip. That is what lets a job carry its own reconciliation
  state instead of needing a side table. It refuses to reactivate a
  completed job and ``trigger_job`` refuses a terminal one; ``rearm_oneshot``
  is the only way back, so a fired one-shot goes through it before an edit
  or a manual run.
- ``cron.executions.latest_execution`` is the real run log (id, claimed/started,
  finished, error). It does not exist on older Hermes builds, so
  :func:`_run_report` falls back to synthesising a row from the job record's
  ``last_run_at`` / ``last_status`` / ``last_error``.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import logging
import math
import os
import time
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from .manifest import PLUGIN_VERSION

logger = logging.getLogger(__name__)

AUTOMATIONS_RECONCILE_INTERVAL_SECONDS = 60.0
# Floor between two passes when a wake nudge lands mid-pass. Each pass forks two
# agent-CLI subprocesses, so an ``automation.sync`` storm must not turn into a
# fork storm.
AUTOMATIONS_MIN_REPASS_SECONDS = 2.0

_MANAGED_KEY = "clawbits_automation_id"
# The agent a managed job was armed for: a job stamped for another one belongs to a
# forgotten enrollment (a --reset, or a re-enrolled Reef agent) and is retired.
_OWNER_KEY = "clawbits_agent"
_GENERATION_KEY = "clawbits_desired_generation"
_SCHEDULE_KEY = "clawbits_desired_schedule"
_HASH_KEY = "clawbits_spec_hash"
_ANCHOR_KEY = "clawbits_anchor_ms"
_RUN_OBSERVED_KEY = "clawbits_run_observed_generation"
_STREAK_KEY = "clawbits_consecutive_errors"
_RUN_SEEN_KEY = "clawbits_last_run_seen_ms"
_RUNNING_KEY = "clawbits_running_at_ms"
# {"slot_ms", "decision": "catch_up" | "skipped", "at_ms"}: the recorded fate of an
# occurrence that was not run on time, written in the same store write as the re-arm.
_MISSED_KEY = "clawbits_missed"
_HOLD_REASON = "Clawbits: missed run held for a catch-up decision"
# Hermes's own terminal shape for a finished one-shot (cron.jobs._complete_job_record);
# ``state`` alone leaves an enabled terminal record that update_job then refuses to touch.
_DISARM = {
    "state": "completed",
    "enabled": False,
    "next_run_at": None,
    "repeat": {"times": 1, "completed": 1},
}

# Tolerance when deciding whether a one-shot's stored fire time has passed, and
# when matching ``last_run_at`` against it. The scheduler's own tick granularity
# plus clock skew live in here.
_ONE_SHOT_SKEW_MS = 120_000
# A slot later than this is missed and gets an explicit catch-up/skip decision. It is
# inside Hermes's 120 s one-shot grace, so a slot kept as merely late is still one
# that update_job/rearm_oneshot accept and the ticker runs.
_MISSED_AFTER_MS = 90_000
# Hermes's late-run grace bounds (cron.jobs._compute_grace_seconds): half the period,
# clamped. Within it a late slot still runs when cron.catch_up_missed is false.
_MIN_GRACE_MS = 120_000
_MAX_GRACE_MS = 7_200_000
# Hermes's one-shot run-claim TTL floor (ONESHOT_RUN_CLAIM_TTL_SECONDS). A live run
# re-stamps its fire and run claims every 60 s, so a younger claim is a run in flight.
_CLAIM_LIVE_MS = 1_800_000

# Server-side caps (``ClawBitsServer.AUTOMATION_REPORT_MAX_ITEMS`` and
# ``ingest_automation_runs``). Mirrored here because the report is serialised
# onto argv for the agent CLI, where ARG_MAX is the only other ceiling.
_MAX_REPORT_ITEMS = 500
_MAX_REPORT_RUNS = 200

# Hermes ``last_status`` vocabulary folded onto the three values the Clawbits UI
# understands. An unknown value is deliberately NOT mapped to "ok": green has to
# mean "we looked and it did not fail", never "we did not look".
_OK_RUN_STATUSES = frozenset({"ok", "success", "succeeded", "completed", "done", "delivered"})
_ERROR_RUN_STATUSES = frozenset(
    {"error", "failed", "failure", "timeout", "timed_out", "exception", "crashed"}
)
_SKIPPED_RUN_STATUSES = frozenset({"skipped", "cancelled", "canceled", "aborted"})
# Ledger failures written by Hermes's claim/shutdown machinery rather than by the job
# (cron/scheduler.py): whether the job's side effects happened is unknown.
_UNCERTAIN_ERROR_PREFIXES = ("Interrupted by", "Fire claim")
# First line of the output file Hermes writes when it retires a one-shot unrun
# (cron.jobs._write_missed_oneshot_diagnostic).
_RETIRED_UNRUN_HEADING = "# Cron job removed before firing"

# Why a manual run did not happen. Keys mirror the OpenClaw plugin's
# RUN_NOW_MISS_MESSAGES (plugin/src/automations/reconcile.ts) so both runtimes
# put the same sentence in front of an operator.
_RUN_NOW_MISS_MESSAGES = {
    "already-running": "A run was already in progress, so the manual run was skipped.",
    "restart-recovery-pending": (
        "The agent is still recovering after a restart — try the manual run again shortly."
    ),
    "not-due": "The job was not due to run.",
    "stopped": "This automation is paused — enable it, then run it.",
    "invalid-spec": "The automation's schedule or target is invalid — check its settings.",
    "rejected": "The gateway declined to run this automation.",
}
_TRANSIENT_RUN_REASONS = frozenset({"already-running", "restart-recovery-pending", "not-due"})


def _canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _spec_hash(spec: dict[str, Any]) -> str:
    return hashlib.sha256(_canonical(spec).encode("utf-8")).hexdigest()


def _as_int(value: Any, default: int = 0) -> int:
    """Coerce a server- or gateway-supplied number without ever raising.

    Every ``int(...)`` on untrusted input in this module goes through here: a
    single ``ValueError`` from a malformed generation used to abort the whole
    pass, which left every other automation on the agent stuck on "requested".
    """
    if isinstance(value, bool):
        return default
    if isinstance(value, (int, float)):
        return int(value)
    if isinstance(value, str):
        try:
            return int(float(value.strip()))
        except (TypeError, ValueError):
            return default
    return default


def _job_id(job: Any) -> str | None:
    if not isinstance(job, dict):
        return None
    value = job.get("id")
    return str(value) if value not in (None, "") else None


def _iso_ms(value: Any) -> int | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None
    if parsed.tzinfo is None:
        # A naive stamp would otherwise be read as container-local time, which
        # would skew every derived value (run ids, streak keys) by the offset.
        parsed = parsed.replace(tzinfo=UTC)
    try:
        return int(parsed.timestamp() * 1000)
    except (OverflowError, OSError, ValueError):
        return None


def _iso_at(timestamp_ms: int) -> str:
    return datetime.fromtimestamp(timestamp_ms / 1000, UTC).isoformat()


def _run_status(raw: Any, has_error: bool) -> str | None:
    value = str(raw or "").strip().lower()
    if value in _ERROR_RUN_STATUSES:
        return "error"
    if value in _OK_RUN_STATUSES:
        return "ok"
    if value in _SKIPPED_RUN_STATUSES:
        return "skipped"
    return "error" if has_error else None


def _reject_unsupported(spec: dict[str, Any], agent_id: str) -> None:
    """Refuse a spec Hermes cannot honour, rather than silently doing something else.

    Fields deliberately ignored (each degrades safely, so rejecting would only
    block valid work): ``wakeMode`` — Hermes cron fires the agent directly, there
    is no heartbeat to wait for; ``failureAlert`` — the Clawbits-side equivalent
    is ``consecutiveErrors`` (see :func:`_fold_streak`); ``description`` — Hermes
    has no such field and the spec is echoed back verbatim anyway. A job always
    runs in the profile that reconciles it, so ``agentId`` may only name this
    agent and ``sessionKey`` is refused.
    """
    session_target = spec.get("sessionTarget")
    if session_target is not None and session_target != "isolated":
        raise ValueError(f"Hermes runs automations in an isolated session, not {session_target!r}")
    if spec.get("agentId") not in (None, "", agent_id):
        raise ValueError("Hermes runs automations for this agent only, not another agentId")
    if spec.get("sessionKey") not in (None, ""):
        raise ValueError("Hermes runs automations in an isolated session, not a sessionKey")
    delivery = spec.get("delivery")
    if isinstance(delivery, dict):
        mode = delivery.get("mode")
        if mode is not None and mode != "announce":
            raise ValueError(f"Hermes supports announce delivery only, not {mode!r}")


def _catch_up_missed() -> bool:
    """Hermes's own ``cron.catch_up_missed`` for the active profile (default: run once)."""
    try:
        from hermes_cli.config import load_config

        return ((load_config() or {}).get("cron") or {}).get("catch_up_missed", True) is not False
    except Exception:
        return True


def _slot_after(schedule: dict[str, Any], after_ms: int, anchor_ms: int | None) -> int:
    """First occurrence strictly after ``after_ms``: the ``every`` anchor grid, or cron in its tz."""
    if schedule.get("kind") == "every":
        every_ms = _as_int(schedule.get("everyMs"))
        anchor = after_ms if anchor_ms is None else anchor_ms
        return anchor + max(1, math.floor((after_ms - anchor) / every_ms) + 1) * every_ms
    expression = str(schedule.get("expr") or "").strip()
    if not expression:
        raise ValueError("cron automation has no expression")
    timezone_name = str(schedule.get("tz") or "UTC")
    try:
        zone = ZoneInfo(timezone_name)
    except Exception as exc:
        raise ValueError(f"invalid automation timezone: {timezone_name}") from exc
    from croniter import croniter

    stagger = max(0, _as_int(schedule.get("staggerMs")))
    base = after_ms - stagger
    # As Hermes's compute_next_run: croniter on the zone's naive wall clock, then the
    # earliest fold strictly after the base (croniter on an aware time lands an hour
    # late the day after a fall-back).
    wall = croniter(expression, datetime.fromtimestamp(base / 1000, zone).replace(tzinfo=None))
    for _ in range(3):
        candidate = wall.get_next(datetime)
        for fold in (0, 1):
            at = int(candidate.replace(tzinfo=zone, fold=fold).timestamp() * 1000)
            if at > base:
                return at + stagger
    raise ValueError(f"cron expression {expression!r} has no next occurrence")


def _owed_slot_ms(
    job: dict[str, Any] | None, schedule: dict[str, Any], anchor: int | None
) -> int | None:
    """The occurrence a job still owes under an unchanged schedule, or None."""
    if not job or _canonical(job.get(_SCHEDULE_KEY)) != _canonical(schedule):
        return None
    if job.get("state") != "completed":
        return _iso_ms(job.get("next_run_at"))
    armed_schedule = job.get("schedule")
    armed = _iso_ms(armed_schedule.get("run_at")) if isinstance(armed_schedule, dict) else None
    if armed is None or schedule.get("kind") == "at":
        return None
    last_run = _iso_ms(job.get("last_run_at"))
    if last_run is not None and last_run >= armed - _ONE_SHOT_SKEW_MS:
        return _slot_after(schedule, armed, anchor)  # it ran its slot: the next one is owed
    return armed  # a manual run completed it early; the armed slot is still owed


def _claims(job: dict[str, Any], now_ms: int) -> str | None:
    """Hermes's run claims on the job: "live" while a run owns its slot, "dead" if its runner died."""
    claims = [job.get(key) for key in ("fire_claim", "run_claim") if isinstance(job.get(key), dict)]
    if not claims:
        return None
    # A held job's claims belong to the gateway that went down.
    if job.get("paused_reason") != _HOLD_REASON and any(
        (_iso_ms(claim.get("at")) or 0) > now_ms - _CLAIM_LIVE_MS for claim in claims
    ):
        return "live"
    return "dead"


def _grace_ms(schedule: dict[str, Any], slot_ms: int, anchor: int | None) -> int:
    """How late ``slot_ms`` may run under Hermes's own late-run grace."""
    period = _slot_after(schedule, slot_ms, anchor) - slot_ms
    return max(_MIN_GRACE_MS, min(period // 2, _MAX_GRACE_MS))


def _next_schedule_ms(
    schedule: dict[str, Any],
    existing: dict[str, Any] | None,
    *,
    enabled: bool = True,
    catch_up: bool = True,
) -> tuple[int, int | None, dict[str, Any] | None]:
    """Return ``(fire ms, interval anchor, missed decision)``; an owed slot is never dropped.

    A slot more than :data:`_MISSED_AFTER_MS` late is kept while the automation is
    paused or a live run owns it; a run that died mid-turn used it, as Hermes's recurring
    jobs run at most once. Otherwise it gets an explicit decision under Hermes's
    ``cron.catch_up_missed``: one catch-up run now (however many slots were missed),
    or, with catch-up off, a run within Hermes's late grace and a recorded skip beyond
    it. One-time automations are never caught up, like Hermes one-shots. A schedule
    edit supersedes the owed slot, as in ``update_job``.
    """
    now_ms = int(time.time() * 1000)
    kind = schedule.get("kind")
    anchor: int | None = None
    if kind == "every":
        if _as_int(schedule.get("everyMs")) < 60_000:
            raise ValueError("Hermes automations require intervals of at least one minute")
        raw_anchor = schedule.get("anchorMs")
        if not isinstance(raw_anchor, (int, float)):
            raw_anchor = existing.get(_ANCHOR_KEY) if existing else None
        anchor = int(raw_anchor) if isinstance(raw_anchor, (int, float)) else now_ms
    elif kind not in ("at", "cron"):
        raise ValueError(f"unsupported automation schedule kind: {kind!r}")

    owed = _owed_slot_ms(existing, schedule, anchor)
    claims = _claims(existing, now_ms) if existing and owed is not None else None
    if (
        claims == "dead"
        and isinstance(existing.get("fire_claim"), dict)
        and kind != "at"
        and not _native_interval(schedule)
    ):
        # At most once, as Hermes's recurring jobs: a computed slot whose run died mid-turn
        # is used (a native interval's fire claim has already advanced next_run_at).
        owed = _slot_after(schedule, owed, anchor)
    if owed is not None and (owed > now_ms - _MISSED_AFTER_MS or not enabled or claims == "live"):
        return owed, anchor, None
    if owed is None:
        if kind == "at":
            at = _as_int(schedule.get("at"))
            if at <= now_ms - _ONE_SHOT_SKEW_MS:
                raise ValueError("one-shot automation time is in the past")
            return at, None, None
        return _slot_after(schedule, now_ms, anchor), anchor, None

    record = (existing or {}).get(_MISSED_KEY) or {}
    # Our own catch-up arm that never ran (a restart) still stands for the original
    # slot; the ISO round trip through next_run_at drops sub-second precision.
    ours = abs(_as_int(record.get("at_ms")) - owed) < 1000
    slot = _as_int(record.get("slot_ms"), owed) if ours else owed
    if kind != "at" and (catch_up or now_ms - slot <= _grace_ms(schedule, slot, anchor)):
        return now_ms, anchor, {"slot_ms": slot, "decision": "catch_up", "at_ms": now_ms}
    decision = {"slot_ms": slot, "decision": "skipped", "at_ms": now_ms}
    return (owed if kind == "at" else _slot_after(schedule, now_ms, anchor)), anchor, decision


def _hermes_schedule(schedule: dict[str, Any], target_ms: int) -> tuple[str, bool]:
    """Return ``(schedule string, is_native_interval)`` for create/update.

    ``kind: "every"`` hands the cadence to Hermes's own interval scheduler, so
    the job re-arms itself. A computed one-shot would only re-arm on the next
    reconcile pass, and with a 60s pass against a 60s minimum interval that
    halves the effective rate.

    ``cron`` and ``at`` stay on a computed one-shot: a cron expression carries a
    per-automation timezone and Hermes's native cron has only a profile-wide
    one, so the next fire has to be computed here.
    """
    if _native_interval(schedule):
        return f"every {_as_int(schedule.get('everyMs')) // 60_000}m", True
    return _iso_at(target_ms), False


def _native_interval(schedule: dict[str, Any]) -> bool:
    """Can Hermes's own interval scheduler carry this schedule (whole minutes)?"""
    every_ms = _as_int(schedule.get("everyMs"))
    return schedule.get("kind") == "every" and every_ms >= 60_000 and every_ms % 60_000 == 0


def _one_shot_fired(schedule: dict[str, Any], job: dict[str, Any] | None) -> bool:
    """Has this ``kind: "at"`` job already run?

    Checked three ways because ``state`` alone is not enough: a run-now resets it
    to ``scheduled`` for the duration of the manual run, and falling through to
    :func:`_next_schedule_ms` in that window would raise on the now-past ``at``.
    """
    if job is None or schedule.get("kind") != "at":
        return False
    if job.get("state") == "completed":
        return True
    repeat = job.get("repeat")
    if isinstance(repeat, dict):
        times = repeat.get("times")
        if isinstance(times, int) and _as_int(repeat.get("completed")) >= times:
            return True
    last_run_ms = _iso_ms(job.get("last_run_at"))
    at = _as_int(schedule.get("at"))
    return last_run_ms is not None and at > 0 and last_run_ms >= at - _ONE_SHOT_SKEW_MS


def _fold_streak(
    job: dict[str, Any], last_run_ms: int | None, status: str | None
) -> tuple[int, dict[str, Any]]:
    """Return ``(consecutive errors, sentinel updates)``.

    Hermes has no error counter, so the plugin keeps one on the job record. The
    sentinel is written only when ``last_run_at`` actually moved — at most once
    per real run, not once per 60s pass.

    Known limitation, shared with the OpenClaw reconciler: runs that happen
    between two passes collapse into a single observation.
    """
    streak = _as_int(job.get(_STREAK_KEY))
    seen = _as_int(job.get(_RUN_SEEN_KEY), default=-1)
    if last_run_ms is None or last_run_ms == seen:
        return streak, {}
    streak = streak + 1 if status == "error" else 0
    return streak, {_STREAK_KEY: streak, _RUN_SEEN_KEY: last_run_ms}


def _running_at_ms(job: dict[str, Any], triggered_ms: int | None) -> int | None:
    """Best-effort "a run is in flight right now" timestamp.

    An exact value for a manual run; for a scheduled fire, the due time once it
    has passed but ``last_run_at`` has not caught up. The UI bounds staleness
    itself (10 minutes, plus a ``lastRunAt >= runningAt`` guard), so a wedged
    scheduler clears rather than pinning a permanent "Running now".
    """
    if triggered_ms is not None:
        return triggered_ms
    candidate = _as_int(job.get(_RUNNING_KEY)) or None
    last_run = _iso_ms(job.get("last_run_at"))
    if candidate is None:
        next_run = _iso_ms(job.get("next_run_at"))
        now_ms = int(time.time() * 1000)
        if (
            next_run is not None
            # A completed one-shot keeps a stale next_run_at; without this guard
            # every fired one-shot would report a phantom "Running now".
            and job.get("state") == "scheduled"
            and job.get("enabled", True)
            and next_run <= now_ms
        ):
            candidate = next_run
    if candidate is None:
        return None
    if last_run is not None and last_run >= candidate:
        return None
    return candidate


def _interpret_trigger(result: Any, exc: Exception | None = None) -> tuple[bool, str | None]:
    """Did ``trigger_job`` actually start a run? Returns ``(started, reason)``.

    An unrecognised dict counts as started. The authoritative outcome arrives as
    a run row on the next pass, so inventing a failure here would only put an
    error in front of an operator who has nothing to do about it.
    """
    if exc is not None:
        return False, str(exc) or "rejected"
    if result is None:
        return False, "rejected"
    if isinstance(result, dict):
        if result.get("ok") is False:
            return False, "rejected"
        if result.get("ran") is False:
            return False, str(result.get("reason") or "rejected")
        if result.get("error"):
            return False, str(result["error"])
    return True, None


def _run_now_miss(
    automation_id: str, job_id: str | None, requested: int, reason: str | None
) -> dict[str, Any]:
    """A run row saying, in words, that the manual run did not happen."""
    key = reason if reason in _RUN_NOW_MISS_MESSAGES else "rejected"
    message = _RUN_NOW_MISS_MESSAGES[key]
    if reason and reason not in _RUN_NOW_MISS_MESSAGES:
        message = f"{message} ({reason})"
    at = int(time.time() * 1000)
    return {
        "automation_id": automation_id,
        "gateway_job_id": job_id,
        "gateway_run_id": f"run-now:{requested}",
        "status": "skipped" if key in _TRANSIENT_RUN_REASONS else "error",
        "started_at_ms": at,
        "finished_at_ms": at,
        # ``did_not_run`` is what makes the UI render the amber "didn't run"
        # rather than falling through to a grey row labelled "ran".
        "summary": {"run_now": True, "did_not_run": True, "error": message, "reason": key},
    }


def _job_state(
    job: dict[str, Any],
    *,
    terminal: bool = False,
    consecutive_errors: int | None = None,
    running_at_ms: int | None = None,
) -> dict[str, Any]:
    state: dict[str, Any] = {
        "lastRunAtMs": _iso_ms(job.get("last_run_at")),
        "lastRunStatus": _run_status(job.get("last_status"), bool(job.get("last_error"))),
        "lastError": job.get("last_error"),
        "lastDeliveryError": job.get("last_delivery_error"),
        "enabled": bool(job.get("enabled", True)),
        "state": "completed" if terminal else job.get("state"),
        "consecutiveErrors": consecutive_errors,
        "runningAtMs": running_at_ms,
    }
    if not terminal:
        # A finished one-shot keeps a stale next_run_at; reporting it would put a
        # "Next" chip on an automation that will never run again.
        state["nextRunAtMs"] = _iso_ms(job.get("next_run_at"))
    return {key: value for key, value in state.items() if value is not None}


def _external_spec(job: dict[str, Any]) -> dict[str, Any]:
    return {
        "name": job.get("name"),
        "schedule": job.get("schedule"),
        "payload": {"kind": "agentTurn", "message": job.get("prompt") or ""},
        "enabled": bool(job.get("enabled", True)),
        "delivery": job.get("deliver"),
    }


def _latest_execution(job_id: str) -> dict[str, Any] | None:
    """Hermes's newest execution-ledger row for ``job_id`` (the job may already be gone)."""
    try:
        from cron.executions import latest_execution

        execution = latest_execution(job_id)
    except Exception:
        return None
    return execution if isinstance(execution, dict) and execution.get("id") else None


def _retired_unrun_ms(job_id: str) -> int | None:
    """When Hermes retired this one-shot without firing it, from the diagnostic it leaves behind."""
    if not job_id.isalnum():
        return None
    try:
        from cron.jobs import get_cron_output_dir

        for path in (get_cron_output_dir() / job_id).glob("*.md"):
            if path.read_text(encoding="utf-8").startswith(_RETIRED_UNRUN_HEADING):
                return int(path.stat().st_mtime * 1000)
    except Exception:
        return None
    return None


def _missed_run(automation_id: str, job_id: str | None, missed: dict[str, Any]) -> dict[str, Any]:
    """The visible "didn't run" row for a skipped occurrence; keyed by slot so re-reports upsert."""
    slot = _as_int(missed.get("slot_ms"))
    at = _as_int(missed.get("at_ms"))
    return {
        "automation_id": automation_id,
        "gateway_job_id": job_id,
        "gateway_run_id": f"missed:{slot or job_id}",
        "status": "skipped",
        "started_at_ms": slot or at,
        "finished_at_ms": at or None,
        "summary": {
            "did_not_run": True,
            "reason": "missed",
            "error": str(
                missed.get("message")
                or "The scheduled time passed while the automation was paused or the agent "
                "was offline; this run was skipped."
            ),
        },
    }


def _execution_run_report(automation_id: str, job: dict[str, Any]) -> dict[str, Any] | None:
    """The latest run row from Hermes's execution log, when it has one.

    Preferred over :func:`_job_run_report` because it carries a real execution
    id, both endpoints, the recorded error and the delivery outcome.
    ``cron.executions`` is absent on older Hermes builds, hence the fallback.
    """
    job_id = _job_id(job)
    if job_id is None:
        return None
    execution = _latest_execution(job_id)
    if execution is None:
        return None
    started = execution.get("started_at") or execution.get("claimed_at")
    started_ms = _iso_ms(started)
    if started_ms is None:
        return None
    error = execution.get("error")
    summary: dict[str, Any] = {}
    if error:
        summary["error"] = str(error)
    # Delivery is this execution's own outcome, never the job's last run, which is a
    # different attempt while this one is still in flight.
    delivery = execution.get("delivery_outcome")
    if delivery == "failed":
        summary["delivered"] = False
        summary["delivery_error"] = str(job.get("last_delivery_error") or "delivery failed")
    elif delivery == "delivered":
        summary["delivered"] = True
    elif delivery:
        summary["delivery_status"] = str(delivery)  # queued, suppressed, not_configured, ...
    missed = job.get(_MISSED_KEY) or {}
    if (
        missed.get("decision") == "catch_up"
        and abs(started_ms - _as_int(missed.get("at_ms"))) <= _ONE_SHOT_SKEW_MS
    ):
        summary["catch_up_for_ms"] = _as_int(missed.get("slot_ms"))
    report: dict[str, Any] = {
        "automation_id": automation_id,
        "gateway_job_id": job_id,
        "gateway_run_id": str(execution["id"]),
        "started_at_ms": started_ms,
        "summary": summary,
    }
    # A claimed/running attempt has no terminal status yet — omit rather than
    # calling it ok, and omit finished_at so the UI shows it as still going.
    # ``unknown`` (the owner died mid-run) and claim/shutdown interruptions are
    # uncertainty, not failures.
    raw_status = execution.get("status")
    uncertain = raw_status == "unknown" or (
        raw_status == "failed" and str(error or "").startswith(_UNCERTAIN_ERROR_PREFIXES)
    )
    if uncertain:
        summary["outcome_unknown"] = True
    status = None if uncertain else _run_status(raw_status, bool(error))
    if status is not None:
        report["status"] = status
    finished_ms = _iso_ms(execution.get("finished_at"))
    if finished_ms is not None:
        report["finished_at_ms"] = finished_ms
    return report


def _job_run_report(automation_id: str, job: dict[str, Any]) -> dict[str, Any] | None:
    """Fallback run row synthesised from the job record.

    Used when ``cron.executions`` is unavailable. The run id is keyed on
    ``last_run_at`` — not the job id — so a re-armed or recreated job does not
    fragment one automation's history, and re-reporting the same run every pass
    upserts rather than duplicating (the server dedupes on
    ``(automation_id, gateway_run_id)``).

    ``finished_at_ms`` is omitted deliberately: the job record carries no
    duration, and ``finished == started`` would render a false "0s".
    """
    job_id = _job_id(job)
    last_run_ms = _iso_ms(job.get("last_run_at"))
    if job_id is None or last_run_ms is None:
        return None
    error = job.get("last_error")
    delivery_error = job.get("last_delivery_error")
    status = _run_status(job.get("last_status"), bool(error))
    summary: dict[str, Any] = {}
    if error:
        summary["error"] = str(error)
    if delivery_error:
        summary["delivery_error"] = str(delivery_error)
        summary["delivered"] = False
    report: dict[str, Any] = {
        "automation_id": automation_id,
        "gateway_job_id": job_id,
        "gateway_run_id": f"run:{last_run_ms}",
        "started_at_ms": last_run_ms,
        "summary": summary,
    }
    if status is not None:
        report["status"] = status
    return report


def _run_report(automation_id: str, job: dict[str, Any]) -> dict[str, Any] | None:
    return _execution_run_report(automation_id, job) or _job_run_report(automation_id, job)


def _managed_updates(
    automation_id: str,
    agent_id: str,
    generation: int,
    spec: dict[str, Any],
    spec_hash: str,
    schedule: dict[str, Any],
    anchor_ms: int | None,
    run_observed: int,
) -> dict[str, Any]:
    updates: dict[str, Any] = {
        _MANAGED_KEY: automation_id,
        _OWNER_KEY: agent_id,
        _GENERATION_KEY: generation,
        "clawbits_desired_spec": spec,
        _SCHEDULE_KEY: schedule,
        _HASH_KEY: spec_hash,
        _RUN_OBSERVED_KEY: run_observed,
    }
    if anchor_ms is not None:
        updates[_ANCHOR_KEY] = anchor_ms
    return updates


def _active_home() -> Path:
    """The active profile's Hermes home, with ``~`` and ``$VAR`` expanded."""
    from hermes_constants import get_hermes_home

    return Path(os.path.expandvars(str(get_hermes_home()))).expanduser()


@contextlib.contextmanager
def _profile_scope(hermes_home: Path) -> Iterator[None]:
    """Pin this thread's Hermes home and cron store to one profile, as Hermes's own ticker does."""
    from cron.jobs import use_cron_store
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override

    token = set_hermes_home_override(str(hermes_home))
    try:
        with use_cron_store(hermes_home):
            yield
    finally:
        reset_hermes_home_override(token)


def hold_missed_slots(hermes_home: Path) -> int:
    """Pause managed one-shots whose slot passed while down, so the first tick cannot retire them.

    Meant for ``connect()``: the gateway starts its cron ticker only after adapters
    connect, so the next reconcile records the catch-up/skip decision with the
    desired spec in hand. Native intervals follow Hermes's own missed-run policy.
    A run in flight in this process already owns its slot and keeps it: ``connect()``
    also runs on a reconnect, with the ticker live.
    """
    from cron.jobs import list_jobs, pause_job
    from cron.scheduler import get_running_job_ids

    held = 0
    running = get_running_job_ids()
    with _profile_scope(hermes_home):
        cutoff = int(time.time() * 1000) - _MISSED_AFTER_MS
        for job in list_jobs(include_disabled=False):
            schedule = job.get("schedule")
            due = _iso_ms(job.get("next_run_at"))
            if (
                job.get(_MANAGED_KEY)
                and isinstance(schedule, dict)
                and schedule.get("kind") == "once"
                and job.get("state") != "completed"
                and due is not None
                and due <= cutoff
                and str(job["id"]) not in running
            ):
                held += bool(pause_job(str(job["id"]), _HOLD_REASON))
    return held


def reconcile_automations_once(
    client: Any, agent_id: str, fallback_channel_id: str, *, hermes_home: Path | None = None
) -> None:
    """One synchronous reconcile pass, called off the event loop.

    It is pinned to ``hermes_home``, or to the active profile's home when omitted.
    """
    with _profile_scope(hermes_home or _active_home()):
        _reconcile_pass(client, agent_id, fallback_channel_id)


def _reconcile_pass(client: Any, agent_id: str, fallback_channel_id: str) -> None:
    from cron.jobs import (
        create_job,
        list_jobs,
        pause_job,
        rearm_oneshot,
        remove_job,
        trigger_job,
        update_job,
    )

    catch_up = _catch_up_missed()
    desired = client.automations_desired()
    items = desired.get("automations")
    if not isinstance(items, list):
        raise RuntimeError("automations desired response has no automations list")

    jobs = list_jobs(include_disabled=True)
    managed_by_id: dict[str, dict[str, Any]] = {}
    by_job_id: dict[str, dict[str, Any]] = {}
    for job in jobs:
        job_id = _job_id(job)
        if job_id:
            by_job_id[job_id] = job
        sentinel = job.get(_MANAGED_KEY)
        if isinstance(sentinel, str) and sentinel:
            managed_by_id[sentinel] = job

    managed_report: list[dict[str, Any]] = []
    run_report: list[dict[str, Any]] = []
    desired_ids: set[str] = set()
    pending_deletes: list[str] = []

    def _apply(
        raw: dict[str, Any],
        automation_id: str,
        generation: int,
        existing: dict[str, Any] | None,
    ) -> tuple[dict[str, Any], list[dict[str, Any]], str | None]:
        """Converge one present automation.

        Returns ``(managed entry, run rows, job id to delete after reporting)``.
        Raises on anything that should surface as ``status: "failed"``.
        """
        spec = raw.get("desired_spec")
        if not isinstance(spec, dict):
            raise ValueError("desired_spec is missing")
        _reject_unsupported(spec, agent_id)
        payload = spec.get("payload")
        if not isinstance(payload, dict) or payload.get("kind") != "agentTurn":
            raise ValueError("Hermes supports agentTurn automations only")
        prompt = str(payload.get("message") or "").strip()
        if not prompt:
            raise ValueError("automation prompt is empty")
        schedule = spec.get("schedule")
        if not isinstance(schedule, dict):
            raise ValueError("automation schedule is missing")

        desired_hash = str(raw.get("spec_hash") or _spec_hash(spec))
        # max(), not an `or` chain: run_observed_generation only ever advances
        # server-side, so a stale sentinel must not win and re-fire a manual run.
        run_observed = max(
            _as_int((existing or {}).get(_RUN_OBSERVED_KEY)),
            _as_int(raw.get("run_observed_generation")),
        )
        delivery = spec.get("delivery")
        target_channel = (
            str(delivery.get("to") or "") if isinstance(delivery, dict) else fallback_channel_id
        ) or fallback_channel_id
        deliver = f"clawbits:{target_channel}" if target_channel else "clawbits"
        enabled = spec.get("enabled") is not False
        model = payload.get("model") if isinstance(payload.get("model"), str) else None
        delete_after_run = spec.get("deleteAfterRun") is True
        name = str(spec.get("name") or "Automation")

        now_ms = int(time.time() * 1000)
        prior_job_id = str(raw.get("gateway_job_id") or "")
        vanished_runs: list[dict[str, Any]] = []
        # A one-shot that is gone: deleted by deleteAfterRun, pruned by Hermes's
        # completed-job retention, or retired unrun. The server keeps emitting it as
        # `present`, so without this branch every pass would recreate and re-run it.
        # Its outcome comes from the execution ledger or Hermes's retire trace, never assumed.
        if (
            existing is None
            and schedule.get("kind") == "at"
            and _as_int(schedule.get("at")) <= now_ms - _ONE_SHOT_SKEW_MS
        ):
            if not prior_job_id:
                # Never applied at all — a genuinely un-schedulable past
                # time, which is the one case where "failed" is honest.
                raise ValueError("one-shot automation time is in the past")
            state: dict[str, Any] = {"state": "completed", "enabled": enabled}
            run = _execution_run_report(automation_id, {"id": prior_job_id})
            if run is not None:
                state["lastRunAtMs"] = run["started_at_ms"]
                if run.get("status"):
                    state["lastRunStatus"] = run["status"]
            elif (retired_ms := _retired_unrun_ms(prior_job_id)) is not None:
                missed = {"slot_ms": schedule.get("at"), "at_ms": retired_ms}
                run = _missed_run(automation_id, prior_job_id, missed)
            entry = {
                "automation_id": automation_id,
                "gateway_job_id": prior_job_id,
                "observed_generation": generation,
                "run_observed_generation": run_observed,
                "status": "applied",
                "reported_spec": spec,
                "reported_state": state,
            }
            return entry, [run] if run else [], None
        if existing is None and prior_job_id and schedule.get("kind") in ("cron", "every"):
            # Our recurring job vanished (retired unrun by a tick that beat the hold, or
            # removed by hand): whatever it owed was not run.
            vanished_runs.append(
                _missed_run(
                    automation_id,
                    prior_job_id,
                    {
                        "at_ms": now_ms,
                        "message": "The scheduled job disappeared before its run was recorded "
                        "(retired while the agent was offline, or removed by hand); it was "
                        "recreated and the missed run was skipped.",
                    },
                )
            )

        # Gated on the hash so an *edited* one-shot (new time, or a pause/resume,
        # both of which change the spec) still re-arms, unless its time has passed:
        # a completed one-shot is never re-run by an edit.
        terminal = (
            existing is not None
            and _one_shot_fired(schedule, existing)
            and (
                existing.get(_HASH_KEY) == desired_hash
                or _as_int(schedule.get("at")) <= now_ms - _ONE_SHOT_SKEW_MS
            )
        )

        if terminal:
            job_id = _job_id(existing)
            if existing.get("state") != "completed":
                # Self-heal after a run-now left it armed: a past next_run_at on
                # an armed job is a second unintended fire waiting to happen.
                existing = update_job(job_id, dict(_DISARM)) or existing
            if existing.get(_GENERATION_KEY) != generation:
                existing = update_job(job_id, {_GENERATION_KEY: generation}) or existing
        else:
            target_ms, anchor_ms, missed = _next_schedule_ms(
                schedule, existing, enabled=enabled, catch_up=catch_up
            )
            schedule_str, native_interval = _hermes_schedule(schedule, target_ms)
            sentinels = _managed_updates(
                automation_id, agent_id, generation, spec, desired_hash, schedule, anchor_ms,
                run_observed,
            )
            if missed is not None:
                sentinels[_MISSED_KEY] = missed

            if existing is not None and missed is not None and schedule.get("kind") == "at":
                # A one-time slot missed while paused or offline is never caught up
                # (Hermes one-shot contract): retire it with the skip in the same write.
                existing = update_job(_job_id(existing), {**_DISARM, **sentinels}) or existing
                terminal = True
            elif existing is None:
                job = create_job(
                    prompt=prompt,
                    schedule=schedule_str,
                    name=name,
                    # A native interval is unbounded — Hermes owns the re-arm.
                    repeat=None if native_interval else 1,
                    deliver=deliver,
                    model=model,
                )
                created_id = _job_id(job)
                if created_id is None:
                    raise RuntimeError(f"create_job returned no id: {job!r}")
                # Stamp the sentinels separately; if that write fails the job is
                # already reported under created_id, so the next pass finds it by
                # gateway_job_id instead of creating a duplicate.
                existing = update_job(created_id, sentinels) or {**job, **sentinels}
                managed_by_id[automation_id] = existing
            else:
                job_id = _job_id(existing)
                schedule_changed = _canonical(existing.get(_SCHEDULE_KEY)) != _canonical(schedule)
                completed = existing.get("state") == "completed"
                # A completed job whose owed slot is already missed stays terminal while
                # paused (rearm_oneshot refuses a past time); resuming re-derives the slot.
                keep_terminal = (
                    completed and not enabled and target_ms <= now_ms - _MISSED_AFTER_MS
                )
                # A completed job must be re-armed to run again. Otherwise a computed
                # one-shot is re-armed only when its fire time moves; rewriting an owed
                # slot that is already past would be refused by update_job.
                rearm = not keep_terminal and (
                    completed
                    or (not native_interval and target_ms != _iso_ms(existing.get("next_run_at")))
                )
                drift = (
                    existing.get(_HASH_KEY) != desired_hash
                    or existing.get("prompt") != prompt
                    or existing.get("deliver") != deliver
                    or bool(existing.get("enabled", True)) != enabled
                    or rearm
                    or missed is not None
                )
                if drift:
                    updates: dict[str, Any] = {
                        "name": name,
                        "prompt": prompt,
                        "deliver": deliver,
                        "model": model,
                        "enabled": enabled,
                        **sentinels,
                    }
                    reactivate = completed and rearm
                    if reactivate:
                        # rearm_oneshot is the only call that may reactivate a completed
                        # job; a native interval then gets its own schedule below. The
                        # decision is persisted first, so a restart in between re-derives
                        # the same slot instead of losing it.
                        if missed is not None:
                            update_job(job_id, {_MISSED_KEY: missed})
                        existing = rearm_oneshot(job_id, _iso_at(target_ms)) or existing
                    if reactivate and not native_interval:
                        # rearm_oneshot also set the schedule. A disabled automation is
                        # paused again below, marker included.
                        updates.pop("enabled")
                    else:
                        if enabled:
                            updates.update(
                                {"state": "scheduled", "paused_at": None, "paused_reason": None}
                            )
                        # update_job recomputes next_run_at whenever `schedule` is
                        # present, so sending it on an unrelated edit would restart a
                        # native interval's grid and starve the job.
                        if schedule_changed or rearm:
                            updates["schedule"] = schedule_str
                            if not native_interval:
                                updates["repeat"] = {"times": 1, "completed": 0}
                            if _claims(existing, now_ms) == "dead":
                                # Hermes would skip the new slot over a dead runner's claims.
                                updates.update({"run_claim": None, "fire_claim": None})
                        elif native_interval and missed and missed["decision"] == "skipped":
                            # Hermes would run the overdue slot on resume; the recorded
                            # skip moves it to the next slot in the same write.
                            updates["next_run_at"] = _iso_at(target_ms)
                    existing = update_job(job_id, updates) or existing
                elif existing.get(_GENERATION_KEY) != generation:
                    existing = update_job(job_id, {_GENERATION_KEY: generation}) or existing

        job_id = _job_id(existing)
        # update_job has already cleared `enabled`; the pause marker is what Hermes
        # (and `hermes cron list`) reads as paused.
        if not enabled and (
            existing.get("state") not in ("paused", "completed")
            or existing.get("paused_reason") == _HOLD_REASON
        ):
            existing = pause_job(job_id, "Paused in Clawbits") or existing

        # --- run now -------------------------------------------------------
        item_runs: list[dict[str, Any]] = []
        triggered_ms: int | None = None
        requested = _as_int(raw.get("run_requested_generation"))
        if requested > run_observed:
            if not enabled:
                item_runs.append(_run_now_miss(automation_id, job_id, requested, "stopped"))
            else:
                if terminal or existing.get("state") == "completed":
                    existing = rearm_oneshot(job_id, _iso_at(now_ms)) or existing
                try:
                    started, reason = _interpret_trigger(trigger_job(job_id))
                except Exception as exc:  # noqa: BLE001 - reported, never raised
                    started, reason = _interpret_trigger(None, exc)
                if started:
                    triggered_ms = int(time.time() * 1000)
                else:
                    item_runs.append(_run_now_miss(automation_id, job_id, requested, reason))
                    if terminal:
                        # Re-disarm: a declined run must not leave a past
                        # next_run_at armed. A run that DID start re-disarms on
                        # the next pass, once _one_shot_fired sees its last_run_at.
                        existing = update_job(job_id, dict(_DISARM)) or existing
            run_observed = requested
            existing = update_job(job_id, {_RUN_OBSERVED_KEY: run_observed}) or existing

        # --- telemetry -----------------------------------------------------
        # Its own guard: a run row that fails to build must never demote an
        # apply that actually succeeded.
        streak: int | None = None
        running_at: int | None = None
        try:
            last_run_ms = _iso_ms(existing.get("last_run_at"))
            status = _run_status(existing.get("last_status"), bool(existing.get("last_error")))
            streak, streak_updates = _fold_streak(existing, last_run_ms, status)
            if triggered_ms is not None:
                streak_updates[_RUNNING_KEY] = triggered_ms
            if streak_updates:
                existing = update_job(job_id, streak_updates) or existing
            running_at = _running_at_ms(existing, triggered_ms)
            latest = _run_report(automation_id, existing)
            if latest:
                item_runs.append(latest)
            recorded = existing.get(_MISSED_KEY) or {}
            if recorded.get("decision") == "skipped":
                item_runs.append(_missed_run(automation_id, job_id, recorded))
        except Exception:
            logger.warning(
                "clawbits: run telemetry for automation %s failed", automation_id, exc_info=True
            )

        # Keep a failed one-shot so it stays retryable and keeps feeding the
        # error streak; only a clean, finished run is disarmed.
        delete_job_id = (
            job_id
            if delete_after_run
            and terminal
            and triggered_ms is None
            and _run_status(existing.get("last_status"), bool(existing.get("last_error"))) != "error"
            else None
        )

        entry = {
            "automation_id": automation_id,
            "gateway_job_id": job_id,
            "observed_generation": generation,
            "run_observed_generation": run_observed,
            "status": "applied",
            "reported_spec": spec,
            "reported_state": _job_state(
                existing,
                terminal=terminal,
                consecutive_errors=streak,
                running_at_ms=running_at,
            ),
        }
        return entry, vanished_runs + item_runs, delete_job_id

    for raw in items:
        if not isinstance(raw, dict):
            continue
        automation_id = str(raw.get("automation_id") or "")
        if not automation_id:
            continue
        desired_ids.add(automation_id)
        generation = _as_int(raw.get("desired_generation"))
        existing = managed_by_id.get(automation_id) or by_job_id.get(
            str(raw.get("gateway_job_id") or "")
        )
        # Assigned exactly once, appended exactly once. The previous shape could
        # append an "applied" entry and then an "failed" one for the same
        # automation; the server is last-write-wins, so a good apply was
        # recorded as a sync failure.
        entry: dict[str, Any] | None = None
        item_runs: list[dict[str, Any]] = []
        try:
            if raw.get("intent") == "absent":
                # remove_job returns False for a job that is already gone — that
                # is success. Only an exception is a failure, and it must NOT
                # report "removed": the server deletes the row and its run
                # history on that word, while the job keeps firing here.
                if existing is not None:
                    remove_job(_job_id(existing))
                entry = {
                    "automation_id": automation_id,
                    "gateway_job_id": _job_id(existing) or raw.get("gateway_job_id"),
                    "observed_generation": generation,
                    "status": "removed",
                }
            else:
                entry, item_runs, delete_job_id = _apply(raw, automation_id, generation, existing)
                if delete_job_id:
                    pending_deletes.append(delete_job_id)
        except Exception as exc:  # noqa: BLE001 - one bad item must not stop the pass
            logger.warning(
                "clawbits: automation %s failed to reconcile", automation_id, exc_info=True
            )
            entry = {
                "automation_id": automation_id,
                "gateway_job_id": _job_id(existing),
                "observed_generation": generation,
                "status": "failed",
                "error": str(exc),
            }
        if entry is not None:
            managed_report.append(entry)
            run_report.extend(item_runs)

    current_jobs = list_jobs(include_disabled=True)
    external_report = []
    for job in current_jobs:
        sentinel = job.get(_MANAGED_KEY)
        if isinstance(sentinel, str) and sentinel and sentinel in desired_ids:
            continue  # already covered by the managed lane this pass
        job_id = _job_id(job)
        if job_id is None:
            continue
        owner = job.get(_OWNER_KEY)
        if sentinel and isinstance(owner, str) and owner and owner != agent_id:
            # Armed for an agent this profile has forgotten: its deliver target is that
            # agent's channel, so retire it rather than let it keep firing. Claiming the
            # stamp makes this a one-time write.
            job = update_job(job_id, {**_DISARM, _OWNER_KEY: agent_id}) or job
        # A job whose sentinel points at an automation the server no longer
        # lists is an orphan: it still fires, but Clawbits has no row for it.
        # Mirroring it as external is what makes it visible at all.
        external_report.append(
            {
                "gateway_job_id": job_id,
                "name": job.get("name"),
                "reported_spec": _external_spec(job),
                "reported_state": _job_state(job),
            }
        )

    client.automations_state(
        {
            "plugin_version": PLUGIN_VERSION,
            "managed": managed_report[:_MAX_REPORT_ITEMS],
            "external": external_report[:_MAX_REPORT_ITEMS],
            "runs": run_report[:_MAX_REPORT_RUNS],
        }
    )

    # Deferred until the report landed: if the POST had raised, the terminal
    # state and the run row would be re-sent next pass instead of being lost
    # with the job. A failed delete simply retries — the job is inert.
    for job_id in pending_deletes:
        try:
            remove_job(job_id)
        except Exception:
            logger.warning("clawbits: could not delete completed job %s", job_id, exc_info=True)


async def run_automations_reconciler(
    client: Any,
    agent_id: str,
    fallback_channel_id: str,
    wake: asyncio.Event,
    running: Any,
    *,
    hermes_home: Path | None = None,
    health: Any | None = None,
) -> None:
    """Reconcile loop; every pass runs in a worker thread pinned to one profile home.

    Without ``hermes_home`` the home active when the loop starts is used, which is the
    owning profile's when the task is created in the adapter's own scope. Each pass reports
    the ``automations`` subsystem to ``health``.
    """
    home = hermes_home or _active_home()
    loop = asyncio.get_running_loop()
    while running():
        started = loop.time()
        # Cleared BEFORE the pass: a nudge that lands while the pass is running
        # describes state the pass has not read yet, so clearing afterwards
        # would drop it and make the operator wait a full interval.
        wake.clear()
        try:
            await asyncio.to_thread(
                reconcile_automations_once,
                client,
                agent_id,
                fallback_channel_id,
                hermes_home=home,
            )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            if health is not None:
                health.fail("automations", exc, interval_s=AUTOMATIONS_RECONCILE_INTERVAL_SECONDS)
            logger.warning("clawbits: automations reconcile failed", exc_info=True)
        else:
            if health is not None:
                health.ok("automations", interval_s=AUTOMATIONS_RECONCILE_INTERVAL_SECONDS)
        if wake.is_set():
            gap = AUTOMATIONS_MIN_REPASS_SECONDS - (loop.time() - started)
            if gap > 0:
                await asyncio.sleep(gap)
            continue
        try:
            await asyncio.wait_for(wake.wait(), timeout=AUTOMATIONS_RECONCILE_INTERVAL_SECONDS)
        except TimeoutError:
            pass
