"""In-process agent-image build jobs with a pollable log buffer.

A build is long (docker pulls + layers), so the API can't block on it. Each build
runs as a background ``asyncio`` task that streams ``runtime.build_image`` into an
in-memory ring of log lines; the dashboard polls ``GET /images/builds/{id}`` for
status + the log tail. One build runs at a time (concurrent builds of the same
``reef-oc`` tags would race), and a successful build auto-promotes the floating
tag (that promotion is build.sh's default — see ``reef.image_ops``).

Jobs are in-memory only: an API restart loses the log (the image may still have
finished). That is an accepted trade-off for v1 — see ``deploy/PROD_RUNBOOK.md``.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import secrets
from collections import deque
from dataclasses import dataclass, field
from datetime import UTC, datetime

from reef.errors import BuildInProgress
from reef.image_ops import BuildImageSpec
from reef.runtime import ImageRuntime

logger = logging.getLogger("reef.build_jobs")

_MAX_LOG_LINES = 4000  # ring cap per job; a clean build is well under this
_MAX_JOBS = 50  # keep the newest N finished jobs


def _now() -> datetime:
    return datetime.now(UTC)


@dataclass(slots=True)
class BuildJob:
    """One image build. ``lines`` is a bounded ring; ``status`` is the lifecycle."""

    id: str
    spec: BuildImageSpec
    status: str = "running"  # running | succeeded | failed
    lines: deque[str] = field(default_factory=lambda: deque(maxlen=_MAX_LOG_LINES))
    error: str | None = None
    started_at: datetime = field(default_factory=_now)
    finished_at: datetime | None = None


class BuildJobManager:
    """Owns the running build task + the job history. One build at a time."""

    def __init__(self, runtime: ImageRuntime) -> None:
        self._runtime = runtime
        self._jobs: dict[str, BuildJob] = {}
        self._order: list[str] = []  # insertion order, newest last
        self._tasks: dict[str, asyncio.Task[None]] = {}

    def active(self) -> BuildJob | None:
        for job in self._jobs.values():
            if job.status == "running":
                return job
        return None

    async def start(self, spec: BuildImageSpec) -> BuildJob:
        if self.active() is not None:
            raise BuildInProgress("an image build is already running")
        job_id = f"build-{secrets.token_hex(4)}"
        job = BuildJob(id=job_id, spec=spec)
        self._jobs[job_id] = job
        self._order.append(job_id)
        self._evict()
        self._tasks[job_id] = asyncio.create_task(self._run(job))
        return job

    async def _run(self, job: BuildJob) -> None:
        try:
            async for line in self._runtime.build_image(job.spec):
                job.lines.append(line)
            job.status = "succeeded"
        except asyncio.CancelledError:
            job.status = "failed"
            job.error = "build cancelled (API shutting down)"
            raise
        except Exception as exc:  # noqa: BLE001 — surface any build failure as a failed job
            job.status = "failed"
            job.error = str(exc)
            logger.warning("image build %s failed: %s", job.id, exc)
        finally:
            job.finished_at = _now()
            self._tasks.pop(job.id, None)

    def get(self, job_id: str) -> BuildJob | None:
        return self._jobs.get(job_id)

    def list(self) -> list[BuildJob]:
        return [self._jobs[i] for i in reversed(self._order) if i in self._jobs]

    def _evict(self) -> None:
        # Drop the oldest FINISHED jobs once over the cap (never a running one).
        while len(self._order) > _MAX_JOBS:
            for idx, jid in enumerate(self._order):
                job = self._jobs.get(jid)
                if job is None or job.status != "running":
                    self._order.pop(idx)
                    self._jobs.pop(jid, None)
                    break
            else:
                break  # all remaining are running — leave them

    async def shutdown(self) -> None:
        for task in list(self._tasks.values()):
            task.cancel()
        for task in list(self._tasks.values()):
            with contextlib.suppress(asyncio.CancelledError):
                await task
