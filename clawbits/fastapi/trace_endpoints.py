"""Standalone end-to-end latency trace viewer — sink, read API, and static page.

Deliberately decoupled from the React SPA: no build step, no router, no auth
coupling. A single self-contained ``trace_viewer.html`` is served at ``/trace``
and talks to the read endpoints below; subsystems ship their spans to the sink.

  POST /api/trace/spans         — span sink (one span, or a list). Best-effort.
  GET  /api/trace/traces        — recent traces (summaries), newest-active first.
  GET  /api/trace/traces/{id}   — all spans for one trace, ordered for a waterfall.
  GET  /trace                   — the viewer page itself.

The store is an in-memory ring (see ``trace_store``); restarting the server
clears it. This is a live debugging surface, not durable telemetry.
"""
from __future__ import annotations

import os
from typing import Any

from fastapi import APIRouter, Body
from fastapi.responses import FileResponse, JSONResponse

from clawbits.fastapi import trace_store

trace_router = APIRouter()

_VIEWER_HTML = os.path.join(os.path.dirname(__file__), "trace_viewer.html")


@trace_router.post("/api/trace/spans", include_in_schema=False)
async def ingest_spans(payload: Any = Body(...)) -> JSONResponse:
    """Accept one span object or a list of them. Always 200s — tracing is
    best-effort and must never surface an error back to an emitter."""
    spans = payload if isinstance(payload, list) else [payload]
    accepted = 0
    for span in spans:
        if isinstance(span, dict):
            trace_store.add_span(span)
            accepted += 1
    return JSONResponse({"accepted": accepted})


@trace_router.get("/api/trace/traces", include_in_schema=False)
async def list_traces(limit: int = 100) -> JSONResponse:
    return JSONResponse({"traces": trace_store.list_traces(limit=min(limit, 500))})


@trace_router.get("/api/trace/traces/{trace_id}", include_in_schema=False)
async def get_trace(trace_id: str) -> JSONResponse:
    trace = trace_store.get_trace(trace_id)
    if trace is None:
        return JSONResponse({"error": "not found", "trace_id": trace_id}, status_code=404)
    return JSONResponse(trace)


@trace_router.get("/trace", include_in_schema=False)
async def trace_viewer() -> FileResponse:
    return FileResponse(_VIEWER_HTML, media_type="text/html")
