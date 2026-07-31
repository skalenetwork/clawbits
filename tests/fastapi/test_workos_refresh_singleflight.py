"""Cross-worker single-flight refresh test.

The bug we're guarding against: in production we run multiple uvicorn
workers behind nginx round-robin. When a page fires N parallel queries and
the access token has just expired, every worker enters the refresh path.
WorkOS rotates the refresh token on each ``session.refresh()`` so only the
first call wins — sibling workers see ``authenticated=False`` and the user
gets logged out mid-page-load. The fix is a Redis-coordinated single-flight
that caches the freshly-minted sealed session for siblings to reuse.

These tests inject a thread-safe in-memory ``FakeRedis`` into the auth
module's ``_redis_client`` slot and verify that ``session.refresh()`` is
called exactly once even under heavy concurrency.
"""
from __future__ import annotations

import threading
import time
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any

import pytest

from clawbits.fastapi import workos_auth

# ---------------------------------------------------------------------------
# FakeRedis — minimal subset of the redis-py sync client we actually use.
# ---------------------------------------------------------------------------


@dataclass
class _Entry:
    value: str
    expires_at: float  # monotonic seconds


class FakeRedis:
    """In-memory Redis stand-in supporting GET / SET-NX-EX / EVAL(cmpdel)."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._store: dict[str, _Entry] = {}

    def _gc(self) -> None:
        now = time.monotonic()
        for k, e in list(self._store.items()):
            if e.expires_at <= now:
                self._store.pop(k, None)

    def get(self, key: str) -> str | None:
        with self._lock:
            self._gc()
            entry = self._store.get(key)
            return entry.value if entry is not None else None

    def set(
        self, key: str, value: str, *, nx: bool = False, ex: int | None = None,
    ) -> bool | None:
        with self._lock:
            self._gc()
            if nx and key in self._store:
                return None
            expires_at = time.monotonic() + (ex or 10**9)
            self._store[key] = _Entry(value=value, expires_at=expires_at)
            return True

    def eval(self, script: str, numkeys: int, *args: str) -> int:
        # We only call the compare-and-delete script — implement that.
        if "redis.call('get'" not in script or "redis.call('del'" not in script:
            raise NotImplementedError(script)
        key = args[0]
        expected = args[1]
        with self._lock:
            self._gc()
            entry = self._store.get(key)
            if entry is not None and entry.value == expected:
                del self._store[key]
                return 1
            return 0


# ---------------------------------------------------------------------------
# Counting refresh fake — counts WorkOS calls so we can assert single-flight.
#
# We monkey-patch ``workos_auth._do_workos_refresh`` (the leaf function that
# would otherwise hit the real WorkOS API). The fake increments a counter
# and either returns a fresh sealed string or ``None`` to simulate failure.
# Single-flight semantics are tested at the layer above
# (``_refresh_single_flight``) regardless of what happens inside the
# WorkOS call itself.
# ---------------------------------------------------------------------------


@dataclass
class _Counter:
    calls: int = 0


def _install_counting_refresh(
    monkeypatch: pytest.MonkeyPatch,
    *,
    succeed: bool = True,
    delay: float = 0.0,
) -> _Counter:
    counter = _Counter()

    def fake_refresh(_client: Any, _sealed: str) -> str | None:
        # Sleep so siblings enter the wait path before the result lands.
        time.sleep(delay)
        counter.calls += 1
        return f"sealed-v{counter.calls}" if succeed else None

    monkeypatch.setattr(workos_auth, "_do_workos_refresh", fake_refresh)
    return counter


# ---------------------------------------------------------------------------
# Fixtures: install a FakeRedis into the auth module for each test.
# ---------------------------------------------------------------------------


@pytest.fixture
def fake_redis() -> Iterator[FakeRedis]:
    fake = FakeRedis()
    saved_client = workos_auth._redis_client
    saved_disabled = workos_auth._redis_disabled
    workos_auth._redis_client = fake
    workos_auth._redis_disabled = False
    workos_auth._LOCAL_REFRESH_CACHE.clear()
    try:
        yield fake
    finally:
        workos_auth._redis_client = saved_client
        workos_auth._redis_disabled = saved_disabled
        workos_auth._LOCAL_REFRESH_CACHE.clear()


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_concurrent_refreshes_call_workos_once(
    fake_redis: FakeRedis, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """20 threads racing to refresh the same sealed cookie → 1 WorkOS call."""
    counter = _install_counting_refresh(monkeypatch, succeed=True, delay=0.05)
    sealed = "sealed-v0"
    results: list[str | None] = [None] * 20

    def worker(i: int) -> None:
        results[i] = workos_auth._refresh_single_flight(None, sealed)

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(20)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert counter.calls == 1, f"expected exactly one refresh, got {counter.calls}"
    assert all(r == "sealed-v1" for r in results), results


def test_failed_refresh_is_cached(
    fake_redis: FakeRedis, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A failed refresh caches a sentinel so siblings don't all retry."""
    counter = _install_counting_refresh(monkeypatch, succeed=False)
    sealed = "sealed-bad"

    first = workos_auth._refresh_single_flight(None, sealed)
    second = workos_auth._refresh_single_flight(None, sealed)
    third = workos_auth._refresh_single_flight(None, sealed)

    assert first is None and second is None and third is None
    assert counter.calls == 1, "failed refresh should be cached"


def test_falls_back_to_local_when_redis_unreachable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """If Redis returns no client, the per-process path still single-flights."""
    saved_client = workos_auth._redis_client
    saved_disabled = workos_auth._redis_disabled
    workos_auth._redis_client = None
    workos_auth._redis_disabled = True
    workos_auth._LOCAL_REFRESH_CACHE.clear()
    try:
        counter = _install_counting_refresh(monkeypatch, succeed=True, delay=0.05)
        sealed = "sealed-local"
        results: list[str | None] = [None] * 10

        def worker(i: int) -> None:
            results[i] = workos_auth._refresh_single_flight(None, sealed)

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(10)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert counter.calls == 1
        assert all(r == "sealed-v1" for r in results), results
    finally:
        workos_auth._redis_client = saved_client
        workos_auth._redis_disabled = saved_disabled
        workos_auth._LOCAL_REFRESH_CACHE.clear()


def test_redis_exception_falls_back_to_local(
    fake_redis: FakeRedis, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A Redis error mid-call doesn't fail the request — local path takes over."""
    class BoomRedis:
        def get(self, *a: Any, **kw: Any) -> Any:
            raise RuntimeError("redis blip")

        def set(self, *a: Any, **kw: Any) -> Any:
            raise RuntimeError("redis blip")

        def eval(self, *a: Any, **kw: Any) -> Any:
            raise RuntimeError("redis blip")

    workos_auth._redis_client = BoomRedis()
    counter = _install_counting_refresh(monkeypatch, succeed=True)
    out = workos_auth._refresh_single_flight(None, "sealed-x")
    assert out == "sealed-v1"
    assert counter.calls == 1
