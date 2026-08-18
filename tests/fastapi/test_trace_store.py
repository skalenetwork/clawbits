"""Unit tests for the debug tracer's ring buffer — the dev-only gate and the
span sanitiser.

The gate lives in ``add_span`` rather than around the router because that is the
only choke point both writers share: the HTTP sink in ``trace_endpoints`` and
the in-process push from ``clawbits_server.request_duration_middleware``. See
``test_trace_endpoints`` for the middleware half of that proof.
"""
from __future__ import annotations

import uuid

import pytest

from clawbits.domain import DEV_ENVS
from clawbits.fastapi import trace_store


def _set_env(monkeypatch, env: str | None) -> None:
    """Set or unset ``CLAWBITS_ENV``. ``None`` deletes it."""
    if env is None:
        monkeypatch.delenv("CLAWBITS_ENV", raising=False)
    else:
        monkeypatch.setenv("CLAWBITS_ENV", env)


@pytest.fixture(autouse=True)
def _empty_ring():
    trace_store.clear()
    yield
    trace_store.clear()


# ---------------------------------------------------------------------------
# Gate truth table
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("env", [None, "", "   ", "production", "staging", "prod"])
def test_add_span_noops_outside_dev(monkeypatch, env):
    """Fail-closed: unset, empty and unknown environments are NOT dev."""
    _set_env(monkeypatch, env)
    assert trace_store.is_trace_enabled() is False
    trace_store.add_span({"trace_id": "t", "span": "s", "subsystem": "server"})
    assert trace_store.list_traces() == []


@pytest.mark.parametrize("env", sorted(DEV_ENVS))
def test_add_span_records_in_dev(monkeypatch, env):
    _set_env(monkeypatch, env)
    assert trace_store.is_trace_enabled() is True
    trace_store.add_span({"trace_id": "t", "span": "s", "subsystem": "server"})
    assert [t["trace_id"] for t in trace_store.list_traces()] == ["t"]


def test_gate_ignores_case_and_surrounding_space(monkeypatch):
    _set_env(monkeypatch, "  Development  ")
    assert trace_store.is_trace_enabled() is True


# ---------------------------------------------------------------------------
# trace_id validation — it is the ring key, so bad ids are dropped, not fixed
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "trace_id",
    [None, 123, "", [], {}, "a" * 65, "tr_<img src=x>", "ok id", "tr_\n", "tr_é"],
)
def test_invalid_trace_id_drops_span(monkeypatch, trace_id):
    _set_env(monkeypatch, "development")
    trace_store.add_span({"trace_id": trace_id, "span": "s"})
    assert trace_store.list_traces() == []
    assert trace_store.is_valid_trace_id(trace_id) is False


@pytest.mark.parametrize("trace_id", ["a", "a" * 64, "tr_" + str(uuid.uuid4()), "a.b:c-d_e"])
def test_valid_trace_id_kept(monkeypatch, trace_id):
    _set_env(monkeypatch, "development")
    assert trace_store.is_valid_trace_id(trace_id) is True
    trace_store.add_span({"trace_id": trace_id, "span": "s"})
    assert trace_store.get_trace(trace_id) is not None


def test_trace_id_is_never_truncated(monkeypatch):
    """Truncating the ring key would silently merge distinct traces."""
    _set_env(monkeypatch, "development")
    long_id = "a" * 64
    trace_store.add_span({"trace_id": long_id + "b", "span": "s"})
    assert trace_store.get_trace(long_id) is None


# ---------------------------------------------------------------------------
# Sanitisation — normalise or truncate, never drop a legitimate span
# ---------------------------------------------------------------------------


def _one_span(**extra):
    trace_store.add_span({"trace_id": "t", **extra})
    trace = trace_store.get_trace("t")
    assert trace is not None
    return trace["spans"][0]


@pytest.mark.parametrize("sub", ["frontend", "server", "plugin"])
def test_known_subsystem_preserved(monkeypatch, sub):
    _set_env(monkeypatch, "development")
    assert _one_span(subsystem=sub)["subsystem"] == sub


@pytest.mark.parametrize(
    "sub",
    [
        "toString",       # inherited-key probe against the viewer's barColor
        "constructor",
        "clawbits-fetch",  # a real-looking but wrong value
        "<img src=x>",
        123,
        None,
        [],                # unhashable: a bare `in frozenset` would raise TypeError
        {},
    ],
)
def test_unknown_subsystem_buckets_to_other(monkeypatch, sub):
    """The span is kept — the viewer already renders an 'other' bucket."""
    _set_env(monkeypatch, "development")
    assert _one_span(subsystem=sub, span="s")["subsystem"] == "other"


def test_span_name_truncated_and_coerced(monkeypatch):
    _set_env(monkeypatch, "development")
    assert len(_one_span(span="x" * 500)["span"]) == 128
    trace_store.clear()
    assert _one_span(span={"not": "a string"})["span"] == "unknown"


def test_extra_attributes_are_bounded(monkeypatch):
    _set_env(monkeypatch, "development")
    span = _one_span(
        span="server.http",
        subsystem="server",
        path="/x" * 5000,
        flag=True,
        nothing=None,
        nested={"a": [1, 2]},
        listy=[1, 2, 3],
        **{"k" * 65: "over-long key", **{f"extra{i}": i for i in range(40)}},
    )
    # 24 keys max, plus t_start_ms back-filled by _normalize afterwards.
    assert len(span) <= 25
    # Core keys are written first, so they always survive the cap.
    for key in ("trace_id", "span", "subsystem"):
        assert key in span
    assert len(span["path"]) == 256
    assert span["flag"] is True
    assert span["nothing"] is None
    # Containers are dropped: a per-string cap would leave these unbounded.
    assert "nested" not in span
    assert "listy" not in span
    assert "k" * 65 not in span


def test_normalize_still_backfills_start(monkeypatch):
    _set_env(monkeypatch, "development")
    span = _one_span(span="server.http", subsystem="server", t_end_ms=1000, dur_ms=40)
    assert span["t_start_ms"] == 960


@pytest.mark.parametrize("bad", ["soon", [1], {"a": 1}, None, True])
def test_non_numeric_timings_dropped(monkeypatch, bad):
    """``_trace_bounds`` and the waterfall sort assume these are numeric when
    present, and the viewer would render a string as "NaNs"."""
    _set_env(monkeypatch, "development")
    span = _one_span(span="s", t_end_ms=bad, dur_ms=bad, t_start_ms=bad)
    assert "t_end_ms" not in span
    assert "dur_ms" not in span
    assert "t_start_ms" not in span
    assert trace_store.get_trace("t")["total_ms"] is None


def test_numeric_timings_kept(monkeypatch):
    _set_env(monkeypatch, "development")
    span = _one_span(span="s", t_start_ms=10, t_end_ms=30.5, dur_ms=20.5)
    assert (span["t_start_ms"], span["t_end_ms"], span["dur_ms"]) == (10, 30.5, 20.5)
    assert trace_store.get_trace("t")["total_ms"] == 20.5
