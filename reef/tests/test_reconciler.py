"""The reconciler: desired-state convergence, restart policies, crash-loop backoff.

All in-memory — a ``FakeAdminRuntime`` stands in for the VMM (its ``status`` reads
seeded state; ``start`` is recorded in ``calls``).
"""

import asyncio
from datetime import UTC, datetime, timedelta

from reef.models import Sandbox
from reef.reconciler import Reconciler
from reef.runtime import DesiredState, RestartPolicy, SandboxState
from reef.store import InMemorySandboxStore
from reef.tests.fakes import FakeAdminRuntime


def _rec(**kw) -> Sandbox:
    return Sandbox(
        sandbox_id=kw.get("sandbox_id", "a"),
        profile="openclaw",
        backend="fake",
        state=kw.get("state", SandboxState.RUNNING),
        image="reef-oc:plugin",
        volume="reef-a",
        desired_state=kw.get("desired_state", DesiredState.RUNNING),
        restart_policy=kw.get("restart_policy", RestartPolicy.ON_FAILURE),
        restart_count=kw.get("restart_count", 0),
        last_restart_at=kw.get("last_restart_at"),
    )


def _setup(
    observed: SandboxState, rec: Sandbox
) -> tuple[FakeAdminRuntime, InMemorySandboxStore, Reconciler]:
    rt = FakeAdminRuntime()
    rt.states[rec.sandbox_id] = observed
    rt.images[rec.sandbox_id] = rec.image
    store = InMemorySandboxStore()
    asyncio.run(store.put(rec))
    return rt, store, Reconciler(rt, store, backoff_base=10, backoff_cap=300, stable_reset=300)


def _ago(secs: float) -> datetime:
    return datetime.now(UTC) - timedelta(seconds=secs)


# ── Restart policies ──────────────────────────────────────────────────────────


def test_on_failure_restarts_a_crash():
    rt, store, r = _setup(SandboxState.FAILED, _rec(state=SandboxState.FAILED))
    asyncio.run(r.reconcile_once())
    assert ("start", "a") in rt.calls
    rec = asyncio.run(store.get("a"))
    assert rec.restart_count == 1 and rec.last_restart_at is not None
    assert rec.state is SandboxState.RUNNING


def test_on_failure_ignores_a_clean_stop():
    # Desired running, but a clean exit (STOPPED, not FAILED): on-failure leaves it.
    rt, store, r = _setup(SandboxState.STOPPED, _rec())
    asyncio.run(r.reconcile_once())
    assert ("start", "a") not in rt.calls
    assert asyncio.run(store.get("a")).restart_count == 0


def test_always_restarts_a_clean_stop():
    rt, store, r = _setup(SandboxState.STOPPED, _rec(restart_policy=RestartPolicy.ALWAYS))
    asyncio.run(r.reconcile_once())
    assert ("start", "a") in rt.calls
    assert asyncio.run(store.get("a")).restart_count == 1


def test_never_leaves_a_crash_down():
    rt, store, r = _setup(SandboxState.FAILED, _rec(restart_policy=RestartPolicy.NEVER))
    asyncio.run(r.reconcile_once())
    assert ("start", "a") not in rt.calls
    assert asyncio.run(store.get("a")).state is SandboxState.FAILED


# ── Desired state ─────────────────────────────────────────────────────────────


def test_desired_stopped_and_stopped_is_a_noop():
    rt, store, r = _setup(
        SandboxState.STOPPED, _rec(desired_state=DesiredState.STOPPED, state=SandboxState.STOPPED)
    )
    asyncio.run(r.reconcile_once())
    assert rt.calls == []


def test_desired_stopped_but_running_is_not_force_stopped():
    # Conservative: the reconciler heals, it does NOT kill a desired-stopped VM that's
    # somehow up — it just records the observed state.
    rt, store, r = _setup(
        SandboxState.RUNNING, _rec(desired_state=DesiredState.STOPPED, state=SandboxState.STOPPED)
    )
    asyncio.run(r.reconcile_once())
    assert ("stop", "a") not in rt.calls
    assert asyncio.run(store.get("a")).state is SandboxState.RUNNING


def test_healthy_running_is_a_noop():
    rt, store, r = _setup(SandboxState.RUNNING, _rec())
    asyncio.run(r.reconcile_once())
    assert rt.calls == []


# ── Crash-loop backoff + stability reset ──────────────────────────────────────


def test_backoff_skips_restart_within_window():
    # restart_count=2 → delay = 10*2^2 = 40s; only 5s since the last restart.
    rt, store, r = _setup(
        SandboxState.FAILED,
        _rec(state=SandboxState.FAILED, restart_count=2, last_restart_at=_ago(5)),
    )
    asyncio.run(r.reconcile_once())
    assert ("start", "a") not in rt.calls
    assert asyncio.run(store.get("a")).restart_count == 2  # untouched


def test_backoff_restarts_after_window():
    rt, store, r = _setup(
        SandboxState.FAILED,
        _rec(state=SandboxState.FAILED, restart_count=2, last_restart_at=_ago(100)),
    )
    asyncio.run(r.reconcile_once())
    assert ("start", "a") in rt.calls
    assert asyncio.run(store.get("a")).restart_count == 3


def test_stable_running_resets_the_restart_counter():
    rt, store, r = _setup(SandboxState.RUNNING, _rec(restart_count=3, last_restart_at=_ago(600)))
    asyncio.run(r.reconcile_once())
    rec = asyncio.run(store.get("a"))
    assert rec.restart_count == 0 and rec.last_restart_at is None


# ── Edge cases ────────────────────────────────────────────────────────────────


def test_removed_container_is_marked_failed_not_recreated():
    # No persisted secrets → can't recreate a vanished container; surface it failed.
    rt, store, r = _setup(SandboxState.DESTROYED, _rec())
    asyncio.run(r.reconcile_once())
    assert ("start", "a") not in rt.calls
    assert asyncio.run(store.get("a")).state is SandboxState.FAILED


def test_creating_sandbox_is_skipped():
    rt, store, r = _setup(SandboxState.RUNNING, _rec(state=SandboxState.CREATING))
    asyncio.run(r.reconcile_once())
    assert rt.calls == []


def test_drift_without_a_record_is_ignored():
    # The reconciler only iterates the store; a runtime-only sandbox is left alone.
    rt = FakeAdminRuntime().seed("drift", state=SandboxState.FAILED)
    r = Reconciler(rt, InMemorySandboxStore())
    asyncio.run(r.reconcile_once())
    assert rt.calls == []


def test_reconciles_each_sandbox_independently():
    rt = FakeAdminRuntime()
    rt.states.update({"heal": SandboxState.FAILED, "ok": SandboxState.RUNNING})
    rt.images.update({"heal": "img", "ok": "img"})
    store = InMemorySandboxStore()
    asyncio.run(store.put(_rec(sandbox_id="heal", state=SandboxState.FAILED)))
    asyncio.run(store.put(_rec(sandbox_id="ok")))
    asyncio.run(Reconciler(rt, store).reconcile_once())
    assert ("start", "heal") in rt.calls and ("start", "ok") not in rt.calls


def test_health_tracks_passes_and_restarts():
    rt, store, r = _setup(SandboxState.FAILED, _rec(state=SandboxState.FAILED))
    h0 = r.health()
    assert h0["passes"] == 0 and h0["restarts"] == 0 and h0["last_pass_at"] is None
    asyncio.run(r.reconcile_once())  # heals the crash
    h1 = r.health()
    assert h1["passes"] == 1 and h1["restarts"] == 1
    assert h1["last_pass_at"] is not None and h1["enabled"] is True
    assert h1["healthy"] is True  # a pass just completed


def test_run_loops_and_cancels_cleanly():
    rt, store, _ = _setup(SandboxState.FAILED, _rec(state=SandboxState.FAILED))
    reconciler = Reconciler(rt, store, interval=0.01, backoff_base=10)

    async def go() -> None:
        task = asyncio.create_task(reconciler.run())
        await asyncio.sleep(0.05)  # let a few passes run
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    asyncio.run(go())
    assert ("start", "a") in rt.calls  # healed inside the loop
