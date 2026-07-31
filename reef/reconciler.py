"""The reconciliation loop — Reef's self-healing controller.

A periodic background pass that drives every *managed* sandbox toward its
``desired_state`` per its ``restart_policy``, with crash-loop backoff. Two firm
boundaries make it safe:

- It only ever **starts** an existing-but-stopped/crashed container. It can't
  recreate a *removed* one — the access secret lives only in the guest env, never
  persisted (docs/REEF.md §9) — so a vanished container is surfaced as ``failed``.
- It never fights a deliberate stop: an operator ``stop`` sets ``desired_state =
  STOPPED``, and the reconciler leaves those alone.

Wired into the API lifespan (``reef.api.app``); disable with ``REEF_RECONCILE=0``.
"""

import asyncio
import logging
from datetime import UTC, datetime

from reef.errors import RuntimeUnavailable
from reef.models import Sandbox
from reef.runtime import AdminRuntime, DesiredState, RestartPolicy, SandboxState
from reef.store import SandboxStore

logger = logging.getLogger("reef.reconciler")


def _now() -> datetime:
    return datetime.now(UTC)


class Reconciler:
    """Drives managed sandboxes toward their desired state. Single-process,
    cooperative with the API handlers (shared event loop) — it re-reads the store
    record right before persisting so a racing operator action always wins.
    """

    def __init__(
        self,
        runtime: AdminRuntime,
        store: SandboxStore,
        *,
        interval: float = 15.0,
        backoff_base: float = 10.0,
        backoff_cap: float = 300.0,
        stable_reset: float = 300.0,
    ) -> None:
        self._runtime = runtime
        self._store = store
        self._interval = interval
        self._backoff_base = backoff_base
        self._backoff_cap = backoff_cap
        self._stable_reset = stable_reset
        # Liveness / observability (surfaced via ``health()`` on ``/healthz``).
        self._started_at: datetime | None = None
        self._last_pass_at: datetime | None = None
        self._passes = 0
        self._restarts = 0
        self._last_error: str | None = None

    async def run(self) -> None:
        """Reconcile every ``interval`` seconds until cancelled."""
        self._started_at = _now()
        logger.info("reconciler started (interval=%ss)", self._interval)
        try:
            while True:
                await self.reconcile_once()
                await asyncio.sleep(self._interval)
        except asyncio.CancelledError:
            logger.info("reconciler stopped")
            raise

    async def reconcile_once(self) -> None:
        """One pass over all managed sandboxes. Never raises: a transient runtime
        error skips the cycle, a per-sandbox error skips that sandbox."""
        try:
            records = await self._store.list()
        except Exception as exc:  # noqa: BLE001 — the control loop must survive a store hiccup
            logger.exception("reconciler: store.list() failed; skipping cycle")
            self._last_error = f"store.list: {exc}"
            return
        for rec in records:
            try:
                await self._reconcile_one(rec)
            except RuntimeUnavailable as exc:
                logger.warning("reconciler: runtime unavailable for %s", rec.sandbox_id)
                self._last_error = f"{rec.sandbox_id}: {exc}"
            except Exception as exc:  # noqa: BLE001 — one bad sandbox must not abort the pass
                logger.exception("reconciler: failed to reconcile %s", rec.sandbox_id)
                self._last_error = f"{rec.sandbox_id}: {exc}"
        self._last_pass_at = _now()
        self._passes += 1

    def health(self) -> dict:
        """A liveness snapshot for ``/healthz`` and external monitoring. ``healthy``
        is False when the loop has gone too long without a completed pass (wedged or
        dead) — alert on it."""
        now = _now()
        last = self._last_pass_at
        age = (now - last).total_seconds() if last is not None else None
        threshold = max(self._interval * 3, self._interval + 30)
        if last is not None:
            healthy = age is not None and age <= threshold
        elif self._started_at is not None:
            healthy = (now - self._started_at).total_seconds() <= threshold
        else:
            healthy = True  # not started yet
        return {
            "enabled": True,
            "interval_secs": self._interval,
            "last_pass_at": last,
            "seconds_since_pass": age,
            "passes": self._passes,
            "restarts": self._restarts,
            "last_error": self._last_error,
            "healthy": healthy,
        }

    async def _reconcile_one(self, rec: Sandbox) -> None:
        if rec.state is SandboxState.CREATING:
            return  # a create/expose is in flight — leave it alone
        observed = await self._runtime.status(rec.sandbox_id)

        if rec.desired_state is not DesiredState.RUNNING:
            await self._record(rec, observed)  # operator wants it down — keep state honest
            return

        if observed is SandboxState.RUNNING:
            await self._mark_healthy(rec)
            return

        if observed is SandboxState.DESTROYED:
            # Container gone; we can't recreate it (no persisted secrets) → surface failed.
            await self._record(rec, SandboxState.FAILED)
            return

        # STOPPED or FAILED while we want it RUNNING → a crash / unexpected exit.
        if not self._policy_heals(rec.restart_policy, observed):
            await self._record(rec, observed)
            return
        if not self._backoff_elapsed(rec):
            return  # still cooling down from the last restart
        await self._heal(rec)

    @staticmethod
    def _policy_heals(policy: RestartPolicy | None, observed: SandboxState) -> bool:
        if policy is RestartPolicy.NEVER:
            return False
        if policy is RestartPolicy.ALWAYS:
            return observed in (SandboxState.STOPPED, SandboxState.FAILED)
        # ON_FAILURE (and the None fallback): only a genuine crash, not a clean exit.
        return observed is SandboxState.FAILED

    def _backoff_elapsed(self, rec: Sandbox) -> bool:
        if rec.last_restart_at is None:
            return True
        delay = min(self._backoff_base * (2 ** min(rec.restart_count, 16)), self._backoff_cap)
        return (_now() - rec.last_restart_at).total_seconds() >= delay

    async def _heal(self, rec: Sandbox) -> None:
        logger.info(
            "reconciler: restarting %s (policy=%s, restart #%d)",
            rec.sandbox_id,
            rec.restart_policy.value if rec.restart_policy else "?",
            rec.restart_count + 1,
        )
        await self._runtime.start(rec.sandbox_id)
        self._restarts += 1
        fresh = await self._store.get(rec.sandbox_id)  # re-read: an operator may have raced us
        if fresh is None or fresh.desired_state is not DesiredState.RUNNING:
            return
        fresh.state = SandboxState.RUNNING
        fresh.restart_count += 1
        fresh.last_restart_at = _now()
        fresh.updated_at = _now()
        await self._store.put(fresh)

    async def _mark_healthy(self, rec: Sandbox) -> None:
        """It's running as desired. Sync the recorded state, and once it has been
        stable for ``stable_reset`` seconds, forget the crash-loop history."""
        stable = (
            rec.last_restart_at is not None
            and (_now() - rec.last_restart_at).total_seconds() >= self._stable_reset
        )
        if rec.state is SandboxState.RUNNING and not stable:
            return  # already consistent, nothing to write
        fresh = await self._store.get(rec.sandbox_id)
        if fresh is None:
            return
        fresh.state = SandboxState.RUNNING
        if stable:
            fresh.restart_count = 0
            fresh.last_restart_at = None
        fresh.updated_at = _now()
        await self._store.put(fresh)

    async def _record(self, rec: Sandbox, state: SandboxState) -> None:
        """Persist an observed state change (no lifecycle action)."""
        if rec.state is state:
            return
        fresh = await self._store.get(rec.sandbox_id)
        if fresh is None:
            return
        fresh.state = state
        fresh.updated_at = _now()
        await self._store.put(fresh)
