"""In-memory ring buffer for end-to-end latency trace spans.

This is the single sink the standalone trace viewer reads from. Every subsystem
that takes part in a message round-trip emits spans tagged with one
``trace_id`` (minted by the originating client — see ``mm_models.MmPostRequest``)
and ships them here:

  * ``frontend.send_post``                — the React client, POSTed from ``api.ts``
  * ``server.http``                       — this server's request-duration middleware (pushed in-process)
  * ``plugin.pickup_lag`` / ``agent_turn`` — the OpenClaw plugin, POSTed from its file-logger sink

Spans are grouped by ``trace_id`` so the viewer can render one waterfall per
round-trip. Storage is a bounded, newest-wins ring held only in process memory:
no migration, no durability across restarts — deliberately, this is a live
debug tool, not an audit log. Bump ``_MAX_TRACES`` if you need a deeper history.

Clock-skew caveat (inherited from the span emitters): cross-process ``t_*_ms``
deltas are only exact on a single host; across machines the bars can drift.
"""
from __future__ import annotations

import threading
from collections import OrderedDict
from typing import Any

# Newest-wins ring: at most this many distinct traces are retained. A human-
# paced channel produces a handful of spans per round-trip, so this is plenty
# of recent history while staying trivially bounded.
_MAX_TRACES = 500
# Hard cap on spans per trace so a pathological/looping id can't grow without
# bound (e.g. a client that reuses one trace_id forever).
_MAX_SPANS_PER_TRACE = 200

_lock = threading.Lock()
# trace_id -> list[span dict]; insertion-ordered, oldest first. We move a trace
# to the end whenever a new span lands so the most *recently active* traces win
# eviction, not merely the most recently created.
_traces: OrderedDict[str, list[dict[str, Any]]] = OrderedDict()


def _normalize(span: dict[str, Any]) -> dict[str, Any]:
    """Fill in a start time when an emitter only gave us ``dur_ms`` + ``t_end_ms``.

    The server ``server.http`` span is timed with a monotonic clock and only
    reports its end wall-clock + duration; deriving the start here lets the
    viewer place every bar on one timeline without special-casing.
    """
    s = dict(span)
    if s.get("t_start_ms") is None:
        end = s.get("t_end_ms")
        dur = s.get("dur_ms")
        if isinstance(end, (int, float)) and isinstance(dur, (int, float)):
            s["t_start_ms"] = end - dur
    return s


def add_span(span: dict[str, Any]) -> None:
    """Record one span. No-op (silently) for spans without a real ``trace_id``.

    Untraced spans (``trace_id`` null/empty) carry no correlation value for the
    viewer, so they're dropped here rather than bucketed. Tracing must never be
    able to break a request, so callers should treat this as best-effort.
    """
    trace_id = span.get("trace_id")
    if not isinstance(trace_id, str) or not trace_id:
        return
    s = _normalize(span)
    with _lock:
        spans = _traces.get(trace_id)
        if spans is None:
            spans = []
            _traces[trace_id] = spans
            # Evict the oldest trace(s) once we're over budget.
            while len(_traces) > _MAX_TRACES:
                _traces.popitem(last=False)
        _traces.move_to_end(trace_id)
        if len(spans) < _MAX_SPANS_PER_TRACE:
            spans.append(s)


def _trace_bounds(spans: list[dict[str, Any]]) -> tuple[int | None, int | None]:
    starts = [s["t_start_ms"] for s in spans if isinstance(s.get("t_start_ms"), (int, float))]
    ends = [s["t_end_ms"] for s in spans if isinstance(s.get("t_end_ms"), (int, float))]
    start = min(starts) if starts else None
    end = max(ends) if ends else None
    return start, end


def list_traces(limit: int = 100) -> list[dict[str, Any]]:
    """Recent traces, newest-active first, as lightweight summaries."""
    with _lock:
        items = list(_traces.items())
    out: list[dict[str, Any]] = []
    for trace_id, spans in reversed(items):
        start, end = _trace_bounds(spans)
        subsystems = sorted({str(s.get("subsystem")) for s in spans if s.get("subsystem")})
        out.append(
            {
                "trace_id": trace_id,
                "span_count": len(spans),
                "subsystems": subsystems,
                "t_start_ms": start,
                "t_end_ms": end,
                "total_ms": (end - start) if (start is not None and end is not None) else None,
            }
        )
        if len(out) >= limit:
            break
    return out


def get_trace(trace_id: str) -> dict[str, Any] | None:
    """All spans for one trace, ordered for a waterfall (by start, then end)."""
    with _lock:
        spans = _traces.get(trace_id)
        spans = list(spans) if spans is not None else None
    if spans is None:
        return None
    spans.sort(
        key=lambda s: (
            s.get("t_start_ms") if isinstance(s.get("t_start_ms"), (int, float)) else float("inf"),
            s.get("t_end_ms") if isinstance(s.get("t_end_ms"), (int, float)) else float("inf"),
        )
    )
    start, end = _trace_bounds(spans)
    return {
        "trace_id": trace_id,
        "spans": spans,
        "t_start_ms": start,
        "t_end_ms": end,
        "total_ms": (end - start) if (start is not None and end is not None) else None,
    }


def clear() -> None:
    """Drop all retained traces (test/debug helper)."""
    with _lock:
        _traces.clear()
