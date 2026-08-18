"""Standalone end-to-end latency trace viewer — sink, read API, and static page.

Deliberately decoupled from the React SPA: no build step, no router. A single
self-contained ``trace_viewer.html`` is served at ``/trace`` and talks to the
read endpoints below; subsystems ship their spans to the sink.

  POST /api/trace/spans         — span sink (one span, or a list). Best-effort.
  GET  /api/trace/traces        — recent traces (summaries), newest-active first.
  GET  /api/trace/traces/{id}   — all spans for one trace, ordered for a waterfall.
  GET  /trace                   — the viewer page itself.

**Development only.** Every route here is gated on ``trace_store.is_trace_enabled``
and 404s outside a dev ``CLAWBITS_ENV``: the read side is an unauthenticated map
of internal endpoints plus a cross-user activity timeline, and the write side is
an unauthenticated sink into a page that renders what it stores. There is no
operator role in this codebase to gate on instead, and the only auth dependency
(``get_current_human_user``) is binary any-registered-human — which would expose
every user's traffic to every other user while silently 401ing both emitters,
neither of which authenticates its span POST.

The store is an in-memory ring (see ``trace_store``); restarting the server
clears it. This is a live debugging surface, not durable telemetry.

Note the viewer page has only ever been reachable on direct app access
(``localhost:8000``, or a port-forward) — both nginx configs route ``/`` to the
frontend container, so ``/trace`` through the proxy serves the SPA. That is
pre-existing and unrelated to the gate above.
"""
from __future__ import annotations

import os

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse

from clawbits.fastapi import trace_store

_VIEWER_HTML = os.path.join(os.path.dirname(__file__), "trace_viewer.html")

# One POST can carry a list of spans. Bound the work per request: nginx allows
# a 25m body, and the ring itself caps at 200 spans per trace anyway.
_MAX_SPANS_PER_POST = 200


def _require_trace_enabled() -> None:
    """404 (not 403) when the tracer is off, so it leaves no detectable surface
    in prod — the same contract ``dev_auth`` uses for its own dev-only routes.

    Declared on the router rather than per-route so it covers every route in
    this module, including any added later.
    """
    if not trace_store.is_trace_enabled():
        raise HTTPException(status_code=404, detail="Not Found")


trace_router = APIRouter(dependencies=[Depends(_require_trace_enabled)])


@trace_router.post("/api/trace/spans", include_in_schema=False)
async def ingest_spans(request: Request) -> JSONResponse:
    """Accept one span object or a list of them. Always 200s — tracing is
    best-effort and must never surface an error back to an emitter.

    Takes the raw ``Request`` rather than declaring a ``Body(...)`` parameter on
    purpose: FastAPI reads and JSON-decodes a declared body *before* router
    dependencies run, so a malformed payload would answer 422 even with the gate
    off — an enumeration signal that defeats the 404 contract above. Parsing
    here keeps the gate strictly first, and avoids buffering an arbitrary body
    on a disabled endpoint.

    ``accepted`` counts the dicts handed to the store, not the spans it retained
    after sanitising. That is the pre-existing semantics, and both emitters
    ignore the response.
    """
    try:
        payload = await request.json()
    except Exception:  # noqa: BLE001 - a malformed emitter payload is not an error
        return JSONResponse({"accepted": 0})
    spans = payload if isinstance(payload, list) else [payload]
    accepted = 0
    for span in spans[:_MAX_SPANS_PER_POST]:
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
