"""Route-level tests for the debug tracer: the dev-only 404 gate, the
malformed-body leak, and the in-process middleware write path.

Two of these pin decisions that are easy to undo by accident:

* ``test_malformed_body_404s_not_422`` pins ``ingest_spans``' raw-``Request``
  signature. FastAPI decodes a declared ``Body(...)`` *before* router
  dependencies run, so re-declaring one would answer 422 in production and
  re-open the enumeration signal the 404 contract exists to remove.
* ``test_middleware_write_is_gated`` pins the gate's *location*. The audit
  suggested an ``if`` around ``include_router``; that would leave this path —
  ``clawbits_server.request_duration_middleware`` pushing in-process — wide open.
"""
from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient

from clawbits.fastapi import trace_store

TRACE_ROUTES = [
    ("GET", "/trace"),
    ("GET", "/api/trace/traces"),
    ("GET", "/api/trace/traces/some-id"),
    ("POST", "/api/trace/spans"),
]

# Anything that is not in the dev allow-list, including the fail-closed cases.
NON_DEV_ENVS = [None, "", "production", "staging"]


def _set_env(monkeypatch, env: str | None) -> None:
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
# Gated off outside development
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("env", NON_DEV_ENVS)
@pytest.mark.parametrize(("method", "path"), TRACE_ROUTES)
def test_routes_404_outside_dev(test_client: TestClient, monkeypatch, env, method, path):
    _set_env(monkeypatch, env)
    resp = test_client.request(method, path, json={"trace_id": "t"} if method == "POST" else None)
    assert resp.status_code == 404
    # main.py's global HTTPException handler reshapes the body; "Not Found" is
    # the same detail an absent route produces, which is the point.
    assert resp.json()["detail"] == "Not Found"


@pytest.mark.parametrize("env", NON_DEV_ENVS)
def test_malformed_body_404s_not_422(test_client: TestClient, monkeypatch, env):
    """A declared ``Body(...)`` would leak a 422 straight through the gate."""
    _set_env(monkeypatch, env)
    resp = test_client.post(
        "/api/trace/spans",
        content=b"{",
        headers={"content-type": "application/json"},
    )
    assert resp.status_code == 404
    assert resp.json()["detail"] == "Not Found"


# ---------------------------------------------------------------------------
# Live in development
# ---------------------------------------------------------------------------


def test_round_trip_in_dev(test_client: TestClient, monkeypatch):
    _set_env(monkeypatch, "development")
    trace_id = f"tr_{uuid.uuid4()}"
    span = {
        "trace_id": trace_id,
        "span": "frontend.send_post",
        "subsystem": "frontend",
        "t_start_ms": 1000,
        "t_end_ms": 1040,
        "dur_ms": 40,
    }

    assert test_client.post("/api/trace/spans", json=span).json() == {"accepted": 1}

    listed = test_client.get("/api/trace/traces").json()["traces"]
    assert [t["trace_id"] for t in listed] == [trace_id]
    assert listed[0]["subsystems"] == ["frontend"]

    detail = test_client.get(f"/api/trace/traces/{trace_id}").json()
    assert detail["total_ms"] == 40
    assert detail["spans"][0]["span"] == "frontend.send_post"


def test_viewer_page_served_in_dev(test_client: TestClient, monkeypatch):
    _set_env(monkeypatch, "development")
    resp = test_client.get("/trace")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/html")
    assert "trace viewer" in resp.text


def test_a_list_payload_is_accepted(test_client: TestClient, monkeypatch):
    _set_env(monkeypatch, "development")
    body = [{"trace_id": "a", "span": "x"}, {"trace_id": "b", "span": "y"}, "not-a-dict"]
    assert test_client.post("/api/trace/spans", json=body).json() == {"accepted": 2}


def test_malformed_body_is_accepted_quietly_in_dev(test_client: TestClient, monkeypatch):
    """Tracing is best-effort: a bad payload must never 4xx an emitter."""
    _set_env(monkeypatch, "development")
    resp = test_client.post(
        "/api/trace/spans",
        content=b"{",
        headers={"content-type": "application/json"},
    )
    assert resp.status_code == 200
    assert resp.json() == {"accepted": 0}


def test_missing_trace_404_is_distinguishable_from_the_gate(test_client: TestClient, monkeypatch):
    """The store's own miss and the gate's refusal must not look alike."""
    _set_env(monkeypatch, "development")
    resp = test_client.get("/api/trace/traces/tr_absent")
    assert resp.status_code == 404
    # The store answers with its own JSONResponse, so it never reaches the
    # global HTTPException handler and stays distinguishable from the gate's.
    assert resp.json() == {"error": "not found", "trace_id": "tr_absent"}


# ---------------------------------------------------------------------------
# The in-process middleware write — the path an include_router gate would miss
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("env", NON_DEV_ENVS)
def test_middleware_write_is_gated(test_client: TestClient, monkeypatch, env):
    _set_env(monkeypatch, env)
    trace_id = f"tr_{uuid.uuid4()}"
    test_client.get("/api/status", headers={"x-clawbits-trace-id": trace_id})
    assert trace_store.get_trace(trace_id) is None


def test_middleware_records_server_span_in_dev(test_client: TestClient, monkeypatch):
    _set_env(monkeypatch, "development")
    trace_id = f"tr_{uuid.uuid4()}"
    test_client.get("/api/status", headers={"x-clawbits-trace-id": trace_id})

    trace = trace_store.get_trace(trace_id)
    assert trace is not None
    span = trace["spans"][0]
    assert span["span"] == "server.http"
    assert span["subsystem"] == "server"
    assert span["path"] == "/api/status"


@pytest.mark.parametrize("header", ["x" * 5000, "tr_<img src=x>", "tr id", ""])
def test_malformed_trace_header_is_ignored(test_client: TestClient, monkeypatch, header):
    """The header also feeds the ungated ``TRACE`` log line, so validate it at
    the read site rather than relying on the store's own drop."""
    _set_env(monkeypatch, "development")
    resp = test_client.get("/api/status", headers={"x-clawbits-trace-id": header})
    assert resp.status_code == 200
    assert trace_store.list_traces() == []
