"""Reconcile Clawbits-managed automations into Hermes cron jobs."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import math
import time
from datetime import UTC, datetime
from typing import Any
from zoneinfo import ZoneInfo

from .manifest import PLUGIN_VERSION

logger = logging.getLogger(__name__)

AUTOMATIONS_RECONCILE_INTERVAL_SECONDS = 60.0
_MANAGED_KEY = "clawbits_automation_id"


def _canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _spec_hash(spec: dict[str, Any]) -> str:
    return hashlib.sha256(_canonical(spec).encode("utf-8")).hexdigest()


def _iso_ms(value: Any) -> int | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000)
    except ValueError:
        return None


def _iso_at(timestamp_ms: int) -> str:
    return datetime.fromtimestamp(timestamp_ms / 1000, UTC).isoformat()


def _next_schedule_ms(
    schedule: dict[str, Any],
    existing: dict[str, Any] | None,
) -> tuple[int, int | None]:
    """Return the next fire and optional interval anchor in epoch milliseconds."""
    now_ms = int(time.time() * 1000)
    kind = schedule.get("kind")
    current_schedule = existing.get("clawbits_desired_schedule") if existing else None
    current_next = _iso_ms(existing.get("next_run_at")) if existing else None
    if (
        existing
        and existing.get("enabled", True)
        and existing.get("state") != "completed"
        and current_next is not None
        and current_next > now_ms
        and _canonical(current_schedule) == _canonical(schedule)
    ):
        return current_next, existing.get("clawbits_anchor_ms")

    if kind == "at":
        at = int(schedule.get("at") or 0)
        if at <= now_ms - 120_000:
            raise ValueError("one-shot automation time is in the past")
        return at, None

    if kind == "every":
        every_ms = int(schedule.get("everyMs") or 0)
        if every_ms < 60_000:
            raise ValueError("Hermes automations require intervals of at least one minute")
        anchor = schedule.get("anchorMs")
        if not isinstance(anchor, (int, float)):
            anchor = existing.get("clawbits_anchor_ms") if existing else None
        if not isinstance(anchor, (int, float)):
            anchor = now_ms
        anchor = int(anchor)
        steps = max(1, math.floor((now_ms - anchor) / every_ms) + 1)
        return anchor + steps * every_ms, anchor

    if kind == "cron":
        expression = str(schedule.get("expr") or "").strip()
        if not expression:
            raise ValueError("cron automation has no expression")
        timezone_name = str(schedule.get("tz") or "UTC")
        try:
            zone = ZoneInfo(timezone_name)
        except Exception as exc:
            raise ValueError(f"invalid automation timezone: {timezone_name}") from exc
        from croniter import croniter

        now = datetime.now(zone)
        next_at = croniter(expression, now).get_next(datetime)
        stagger_ms = int(schedule.get("staggerMs") or 0)
        return int(next_at.timestamp() * 1000) + max(0, stagger_ms), None

    raise ValueError(f"unsupported automation schedule kind: {kind!r}")


def _job_state(job: dict[str, Any]) -> dict[str, Any]:
    state: dict[str, Any] = {
        "nextRunAtMs": _iso_ms(job.get("next_run_at")),
        "lastRunAtMs": _iso_ms(job.get("last_run_at")),
        "lastRunStatus": job.get("last_status"),
        "lastError": job.get("last_error"),
        "lastDeliveryError": job.get("last_delivery_error"),
        "enabled": bool(job.get("enabled", True)),
        "state": job.get("state"),
    }
    return {key: value for key, value in state.items() if value is not None}


def _external_spec(job: dict[str, Any]) -> dict[str, Any]:
    return {
        "name": job.get("name"),
        "schedule": job.get("schedule"),
        "payload": {"kind": "agentTurn", "message": job.get("prompt") or ""},
        "enabled": bool(job.get("enabled", True)),
        "delivery": job.get("deliver"),
    }


def _run_report(automation_id: str, job: dict[str, Any]) -> dict[str, Any] | None:
    try:
        from cron.executions import latest_execution

        execution = latest_execution(str(job["id"]))
    except Exception:
        execution = None
    if not execution:
        return None
    started = execution.get("started_at") or execution.get("claimed_at")
    finished = execution.get("finished_at")
    status = str(execution.get("status") or "")
    if status == "completed":
        status = "ok"
    elif status in {"failed", "unknown"}:
        status = "error"
    summary: dict[str, Any] = {}
    if execution.get("error"):
        summary["error"] = execution["error"]
    if job.get("last_delivery_error"):
        summary["delivery_error"] = job["last_delivery_error"]
    return {
        "automation_id": automation_id,
        "gateway_job_id": str(job["id"]),
        "gateway_run_id": str(execution["id"]),
        "status": status,
        "started_at_ms": _iso_ms(started),
        "finished_at_ms": _iso_ms(finished),
        "summary": summary,
    }


def _managed_updates(
    automation_id: str,
    generation: int,
    spec: dict[str, Any],
    spec_hash: str,
    schedule: dict[str, Any],
    anchor_ms: int | None,
    run_observed: int,
) -> dict[str, Any]:
    updates: dict[str, Any] = {
        _MANAGED_KEY: automation_id,
        "clawbits_desired_generation": generation,
        "clawbits_desired_spec": spec,
        "clawbits_desired_schedule": schedule,
        "clawbits_spec_hash": spec_hash,
        "clawbits_run_observed_generation": run_observed,
    }
    if anchor_ms is not None:
        updates["clawbits_anchor_ms"] = anchor_ms
    return updates


def reconcile_automations_once(client: Any, agent_id: str, fallback_channel_id: str) -> None:
    """One synchronous reconcile pass. Called off the event loop."""
    from cron.jobs import create_job, list_jobs, pause_job, remove_job, trigger_job, update_job

    desired = client.automations_desired()
    items = desired.get("automations")
    if not isinstance(items, list):
        raise RuntimeError("automations desired response has no automations list")

    jobs = list_jobs(include_disabled=True)
    managed_by_id = {
        str(job.get(_MANAGED_KEY)): job
        for job in jobs
        if isinstance(job.get(_MANAGED_KEY), str) and job.get(_MANAGED_KEY)
    }
    managed_report: list[dict[str, Any]] = []
    run_report: list[dict[str, Any]] = []
    desired_ids: set[str] = set()

    for raw in items:
        if not isinstance(raw, dict):
            continue
        automation_id = str(raw.get("automation_id") or "")
        if not automation_id:
            continue
        desired_ids.add(automation_id)
        generation = int(raw.get("desired_generation") or 0)
        existing = managed_by_id.get(automation_id)
        if raw.get("intent") == "absent":
            if existing:
                remove_job(str(existing["id"]))
            managed_report.append(
                {
                    "automation_id": automation_id,
                    "gateway_job_id": str(existing["id"]) if existing else raw.get("gateway_job_id"),
                    "observed_generation": generation,
                    "status": "removed",
                }
            )
            continue

        spec = raw.get("desired_spec")
        if not isinstance(spec, dict):
            managed_report.append(
                {
                    "automation_id": automation_id,
                    "gateway_job_id": str(existing["id"]) if existing else None,
                    "observed_generation": generation,
                    "status": "failed",
                    "error": "desired_spec is missing",
                }
            )
            continue

        try:
            payload = spec.get("payload")
            if not isinstance(payload, dict) or payload.get("kind") != "agentTurn":
                raise ValueError("Hermes supports agentTurn automations only")
            prompt = str(payload.get("message") or "").strip()
            if not prompt:
                raise ValueError("automation prompt is empty")
            schedule = spec.get("schedule")
            if not isinstance(schedule, dict):
                raise ValueError("automation schedule is missing")
            target_ms, anchor_ms = _next_schedule_ms(schedule, existing)
            desired_hash = str(raw.get("spec_hash") or _spec_hash(spec))
            run_observed = int(
                (existing or {}).get("clawbits_run_observed_generation")
                or raw.get("run_observed_generation")
                or 0
            )
            delivery = spec.get("delivery")
            target_channel = (
                str(delivery.get("to") or "")
                if isinstance(delivery, dict)
                else fallback_channel_id
            ) or fallback_channel_id
            deliver = f"clawbits:{target_channel}" if target_channel else "clawbits"
            enabled = spec.get("enabled") is not False
            model = payload.get("model") if isinstance(payload.get("model"), str) else None
            schedule_iso = _iso_at(target_ms)

            if existing is None:
                job = create_job(
                    prompt=prompt,
                    schedule=schedule_iso,
                    name=str(spec.get("name") or "Automation"),
                    repeat=1,
                    deliver=deliver,
                    model=model,
                )
                updates = _managed_updates(
                    automation_id,
                    generation,
                    spec,
                    desired_hash,
                    schedule,
                    anchor_ms,
                    run_observed,
                )
                job = update_job(str(job["id"]), updates) or job
                managed_by_id[automation_id] = job
                existing = job
            else:
                drift = (
                    existing.get("clawbits_spec_hash") != desired_hash
                    or existing.get("prompt") != prompt
                    or existing.get("deliver") != deliver
                    or bool(existing.get("enabled", True)) != enabled
                    or existing.get("state") == "completed" and schedule.get("kind") != "at"
                )
                if drift:
                    updates = {
                        "name": str(spec.get("name") or "Automation"),
                        "prompt": prompt,
                        "schedule": schedule_iso,
                        "repeat": {"times": 1, "completed": 0},
                        "deliver": deliver,
                        "model": model,
                        "enabled": True,
                        "state": "scheduled",
                        "paused_at": None,
                        "paused_reason": None,
                        **_managed_updates(
                            automation_id,
                            generation,
                            spec,
                            desired_hash,
                            schedule,
                            anchor_ms,
                            run_observed,
                        ),
                    }
                    existing = update_job(str(existing["id"]), updates) or existing
                elif existing.get("clawbits_desired_generation") != generation:
                    existing = update_job(
                        str(existing["id"]),
                        {"clawbits_desired_generation": generation},
                    ) or existing

            if not enabled and existing.get("enabled", True):
                existing = pause_job(str(existing["id"]), "Paused in Clawbits") or existing

            requested = int(raw.get("run_requested_generation") or 0)
            synthetic_run: dict[str, Any] | None = None
            if requested > run_observed:
                if not enabled:
                    at = int(time.time() * 1000)
                    synthetic_run = {
                        "automation_id": automation_id,
                        "gateway_job_id": str(existing["id"]),
                        "gateway_run_id": f"run-now:{requested}",
                        "status": "skipped",
                        "started_at_ms": at,
                        "finished_at_ms": at,
                        "summary": {"run_now": True, "error": "Automation is paused."},
                    }
                else:
                    # Hermes retains completed one-shots with repeat.completed=1.
                    # Reset the claim before forcing a manual rerun.
                    if existing.get("state") == "completed":
                        existing = update_job(
                            str(existing["id"]),
                            {
                                "repeat": {"times": 1, "completed": 0},
                                "enabled": True,
                                "state": "scheduled",
                            },
                        ) or existing
                    trigger_job(str(existing["id"]))
                run_observed = requested
                existing = update_job(
                    str(existing["id"]),
                    {"clawbits_run_observed_generation": run_observed},
                ) or existing

            refreshed = next(
                (job for job in list_jobs(include_disabled=True) if job.get("id") == existing.get("id")),
                existing,
            )
            managed_report.append(
                {
                    "automation_id": automation_id,
                    "gateway_job_id": str(refreshed["id"]),
                    "observed_generation": generation,
                    "run_observed_generation": run_observed,
                    "status": "applied",
                    "reported_spec": spec,
                    "reported_state": _job_state(refreshed),
                }
            )
            if synthetic_run:
                run_report.append(synthetic_run)
            latest = _run_report(automation_id, refreshed)
            if latest:
                run_report.append(latest)
        except Exception as exc:
            logger.warning("clawbits: automation %s failed to reconcile", automation_id, exc_info=True)
            managed_report.append(
                {
                    "automation_id": automation_id,
                    "gateway_job_id": str(existing["id"]) if existing else None,
                    "observed_generation": generation,
                    "status": "failed",
                    "error": str(exc),
                }
            )

    current_jobs = list_jobs(include_disabled=True)
    external_report = [
        {
            "gateway_job_id": str(job["id"]),
            "name": job.get("name"),
            "reported_spec": _external_spec(job),
            "reported_state": _job_state(job),
        }
        for job in current_jobs
        if not job.get(_MANAGED_KEY)
    ]
    client.automations_state(
        {
            "plugin_version": PLUGIN_VERSION,
            "managed": managed_report,
            "external": external_report,
            "runs": run_report,
        }
    )


async def run_automations_reconciler(
    client: Any,
    agent_id: str,
    fallback_channel_id: str,
    wake: asyncio.Event,
    running: Any,
) -> None:
    while running():
        try:
            await asyncio.to_thread(
                reconcile_automations_once,
                client,
                agent_id,
                fallback_channel_id,
            )
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.warning("clawbits: automations reconcile failed", exc_info=True)
        wake.clear()
        try:
            await asyncio.wait_for(wake.wait(), timeout=AUTOMATIONS_RECONCILE_INTERVAL_SECONDS)
        except TimeoutError:
            pass
