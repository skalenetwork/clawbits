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

**Development only.** The ring is an unauthenticated cross-user activity
timeline, so ``add_span`` no-ops unless ``CLAWBITS_ENV`` names a dev
environment (see ``is_trace_enabled``). Production observability is unaffected:
the server's structured ``TRACE`` log line is emitted independently of this
ring. Everything that lands here is sanitised first — see ``_sanitize``.

Clock-skew caveat (inherited from the span emitters): cross-process ``t_*_ms``
deltas are only exact on a single host; across machines the bars can drift.
"""
from __future__ import annotations

import re
import threading
from collections import OrderedDict
from typing import Any

from clawbits.domain import is_dev_env

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


def is_trace_enabled() -> bool:
    """Whether the debug tracer accepts writes and serves reads. Fails closed.

    Dev-only by design: the ring is an unauthenticated cross-user activity
    timeline and the viewer page exposes the internal endpoint map, so it must
    never be live in a real deployment. There is no admin/operator role in this
    codebase to gate it on, and the one auth dependency we do have
    (``get_current_human_user``) is binary any-registered-human — which would
    still expose every user's traffic to every other user. Env is the right gate.

    Both writers funnel through ``add_span`` — the HTTP sink in
    ``trace_endpoints`` and the in-process push from
    ``clawbits_server.request_duration_middleware`` — so gating there closes
    every write path at once. Unmounting the router would not: the middleware
    imports this module directly.
    """
    return is_dev_env()


# --- Input hardening -------------------------------------------------------
# Defence in depth. After the gate above the write path is dev-only, but the
# sink stays unauthenticated there, so a span must not be able to carry markup
# into the viewer or pin unbounded memory. Every cap below has ~2x headroom
# over the largest value a real emitter sends.
_KNOWN_SUBSYSTEMS = frozenset({"frontend", "server", "plugin"})
_OTHER_SUBSYSTEM = "other"
# 64 matches ``mm_models.MmPostRequest.trace_id``, so any id that legitimately
# round-trips a post fits by construction (the frontend mints ``tr_<uuid4>``,
# 39 chars). The charset excludes ``<>"'&``, whitespace and control characters:
# ``server.http``'s id comes straight from the ``x-clawbits-trace-id`` header.
_MAX_TRACE_ID_LEN = 64
_TRACE_ID_RE = re.compile(rf"[A-Za-z0-9_.:-]{{1,{_MAX_TRACE_ID_LEN}}}")
_MAX_SPAN_NAME_LEN = 128
_TIMING_KEYS = ("t_start_ms", "t_end_ms", "dur_ms")
_MAX_KEY_LEN = 64
_MAX_VALUE_LEN = 256
_MAX_SPAN_KEYS = 24


def is_valid_trace_id(trace_id: object) -> bool:
    """A trace id must be short and boring: it is the ring key, it is echoed
    into the server's ``TRACE`` log line, and the viewer renders it into HTML.
    """
    return isinstance(trace_id, str) and _TRACE_ID_RE.fullmatch(trace_id) is not None


def _sanitize(span: dict[str, Any]) -> dict[str, Any] | None:
    """Coerce one emitter-supplied span into a bounded, scalar-only dict.

    Returns ``None`` only for an unusable ``trace_id`` — every other field is
    normalised or truncated rather than dropped, so a legitimate span never
    disappears just because one attribute was odd.
    """
    trace_id = span.get("trace_id")
    if not is_valid_trace_id(trace_id):
        return None

    # Core keys first so they always survive the key cap below.
    out: dict[str, Any] = {"trace_id": trace_id}

    # Display-only, so truncating costs no timing data. Never ``str()`` a
    # container first — that materialises an arbitrarily large string before
    # we get a chance to slice it.
    name = span.get("span")
    out["span"] = name[:_MAX_SPAN_NAME_LEN] if isinstance(name, str) else "unknown"

    # Feeds the viewer's badge class and bar colour. Bucket to "other" (which
    # the viewer already renders) rather than dropping the span. The isinstance
    # guard is load-bearing: a JSON value can be a list or dict, and testing
    # those for membership of a frozenset raises TypeError.
    sub = span.get("subsystem")
    out["subsystem"] = sub if isinstance(sub, str) and sub in _KNOWN_SUBSYSTEMS else _OTHER_SUBSYSTEM

    # Timings: numbers or nothing. ``_trace_bounds`` and the waterfall sort
    # already assume that, and a string here would render as "NaNs" in the
    # viewer's bar label. ``bool`` is an ``int`` subclass, hence the exclusion.
    for key in _TIMING_KEYS:
        value = span.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            out[key] = value

    # Free-form attributes: JSON scalars only. No real emitter sends a nested
    # structure, and allowing one would leave the span unbounded in size — a
    # per-string cap alone does not bound a nested dict.
    for key, value in span.items():
        if not isinstance(key, str) or len(key) > _MAX_KEY_LEN or key in out:
            continue
        # A timing key absent from ``out`` was *rejected* above, not missed —
        # don't let the generic scalar rule quietly re-admit it.
        if key in _TIMING_KEYS:
            continue
        if len(out) >= _MAX_SPAN_KEYS:
            break
        if isinstance(value, str):
            out[key] = value[:_MAX_VALUE_LEN]
        elif value is None or isinstance(value, (bool, int, float)):
            out[key] = value
        # dict / list / anything else: dropped.
    return out


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

    Untraced spans (``trace_id`` null/empty/malformed) carry no correlation
    value for the viewer, so they're dropped here rather than bucketed. Tracing
    must never be able to break a request, so callers should treat this as
    best-effort.

    No-ops entirely outside development — see ``is_trace_enabled``. This is the
    single choke point for both writers, so the check belongs here rather than
    around the router.
    """
    if not is_trace_enabled():
        return
    sanitized = _sanitize(span)
    if sanitized is None:
        return
    trace_id = sanitized["trace_id"]
    s = _normalize(sanitized)
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
