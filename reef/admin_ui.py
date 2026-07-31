"""Local-only operator dashboard server.

Serves the built admin-ui SPA (``reef/admin-ui/dist``) and reverse-proxies
``/api/*`` to the Reef API. Binds **loopback by design** — the dashboard is
reached over an SSH local-forward, never the public Cloudflare tunnel (that
tunnel maps only the API on ``:8787``; this server is on a separate port the
tunnel never sees). The admin token still gates every byte of data: the SPA's
AuthDialog sends it as an ``Authorization: Bearer`` that this server forwards to
the API, which enforces ``admin_auth``. The static shell itself is unauthed
(like the dev Vite server), but it shows nothing until the API accepts the token.

Why a dedicated server (not a StaticFiles mount on the API app): mounting the
SPA on ``:8787`` would expose it at ``https://reef.<domain>/`` through the
tunnel. Keeping it on its own loopback port + proxying ``/api`` keeps dev and
prod symmetric (both reach the API at the relative ``/api`` base — see
``admin-ui/src/lib/api.ts``) and structurally off the tunnel.

Run: ``python -m reef.admin_ui``  (or ``uvicorn reef.admin_ui:app``)
"""

from __future__ import annotations

import contextlib
import logging
import os
from collections.abc import AsyncIterator
from pathlib import Path

import httpx
from fastapi import FastAPI, Request, Response
from fastapi.responses import FileResponse

logger = logging.getLogger("reef.admin_ui")

# Headers that are connection-specific and must not be forwarded either way.
# ``host``/``content-length`` are recomputed by httpx/Starlette per hop.
_HOP_BY_HOP = frozenset(
    {
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailers",
        "transfer-encoding",
        "upgrade",
        "host",
        "content-length",
    }
)

_PROXY_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]


def _default_dist_dir() -> Path:
    """``REEF_ADMIN_UI_DIR`` when set, else the built ``dist`` next to the source
    (a dev convenience; in prod the dist is produced off-box and the env points
    at it)."""
    override = os.getenv("REEF_ADMIN_UI_DIR")
    if override:
        return Path(override)
    return Path(__file__).resolve().parent / "admin-ui" / "dist"


def _default_api_base() -> str:
    """The Reef API to proxy ``/api/*`` to. Defaults to the same host:port the API
    binds (``REEF_API_HOST``/``REEF_API_PORT``); a ``0.0.0.0``/``::`` *bind* maps
    to a ``127.0.0.1`` *connect* target."""
    if base := os.getenv("REEF_ADMIN_UI_API_BASE"):
        return base.rstrip("/")
    host = os.getenv("REEF_API_HOST", "127.0.0.1")
    if host in ("0.0.0.0", "::"):
        host = "127.0.0.1"
    port = os.getenv("REEF_API_PORT", "8787")
    return f"http://{host}:{port}"


def _client(app: FastAPI) -> httpx.AsyncClient:
    """Shared app-lifetime upstream client (lazy, parked on ``app.state``), closed
    in the lifespan. read/write timeouts off — ``/fleet/{id}/logs`` and friends
    are quick, but keep parity with the API's own long-lived calls."""
    client: httpx.AsyncClient | None = getattr(app.state, "api_client", None)
    if client is None or client.is_closed:
        client = httpx.AsyncClient(
            timeout=httpx.Timeout(connect=5.0, read=None, write=None, pool=5.0),
            follow_redirects=False,
        )
        app.state.api_client = client
    return client


@contextlib.asynccontextmanager
async def _lifespan(app: FastAPI) -> AsyncIterator[None]:
    try:
        yield
    finally:
        client = getattr(app.state, "api_client", None)
        if client is not None and not client.is_closed:
            await client.aclose()


def create_admin_ui_app(
    dist_dir: Path | str | None = None,
    api_base: str | None = None,
) -> FastAPI:
    """Build the dashboard server. ``dist_dir``/``api_base`` default from env so
    tests can inject a tmp dist + a stub upstream."""
    dist = Path(dist_dir) if dist_dir is not None else _default_dist_dir()
    dist = dist.resolve()
    base = (api_base.rstrip("/") if api_base is not None else _default_api_base())

    app = FastAPI(title="Reef Admin UI", lifespan=_lifespan, openapi_url=None)
    app.state.dist_dir = dist
    app.state.api_base = base

    @app.api_route("/api/{path:path}", methods=_PROXY_METHODS, include_in_schema=False)
    async def proxy_api(path: str, request: Request) -> Response:
        """Forward ``/api/<path>`` → ``<api_base>/<path>`` verbatim (method, query,
        body, headers — including the operator's ``Authorization: Bearer`` so the
        API's ``admin_auth`` enforces the token). The browser only ever talks to
        this one loopback origin, so a single SSH forward reaches everything."""
        upstream_url = f"{request.app.state.api_base}/{path}"
        fwd_headers = {k: v for k, v in request.headers.items() if k.lower() not in _HOP_BY_HOP}
        body = await request.body()
        try:
            upstream = await _client(request.app).request(
                request.method,
                upstream_url,
                params=request.query_params,
                headers=fwd_headers,
                content=body or None,
            )
        except httpx.ConnectError:
            return Response(
                content=b'{"detail":"Reef API unreachable from the dashboard server"}',
                status_code=502,
                media_type="application/json",
            )
        resp_headers = [
            (k, v) for k, v in upstream.headers.items() if k.lower() not in _HOP_BY_HOP
        ]
        return Response(
            content=upstream.content,
            status_code=upstream.status_code,
            headers=dict(resp_headers),
        )

    @app.get("/{full_path:path}", include_in_schema=False)
    async def spa(full_path: str) -> Response:
        """Serve a real file from ``dist`` when one exists; otherwise fall back to
        ``index.html`` so client-side (BrowserRouter) deep links resolve on
        refresh. Hashed assets cache forever; ``index.html`` is ``no-store`` so a
        post-upgrade shell never points at a removed ``/assets/<oldhash>`` chunk."""
        dist = app.state.dist_dir
        index = dist / "index.html"
        if full_path:
            # Contain within dist — reject traversal (``..``) and absolute escapes.
            candidate = (dist / full_path).resolve()
            if dist in candidate.parents and candidate.is_file():
                cache = (
                    "public, max-age=31536000, immutable"
                    if full_path.startswith("assets/")
                    else "no-cache"
                )
                return FileResponse(candidate, headers={"Cache-Control": cache})
        if not index.is_file():
            return Response(
                content=b"admin-ui dist not found; build it (bun run build) and set "
                b"REEF_ADMIN_UI_DIR",
                status_code=503,
                media_type="text/plain",
            )
        return FileResponse(index, headers={"Cache-Control": "no-store"})

    return app


app = create_admin_ui_app()


def main() -> None:
    import uvicorn

    logging.basicConfig(
        level=os.getenv("REEF_LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    host = os.getenv("REEF_ADMIN_UI_HOST", "127.0.0.1")
    port = int(os.getenv("REEF_ADMIN_UI_PORT", "8788"))
    dist = _default_dist_dir()
    if not (dist / "index.html").is_file():
        logger.warning(
            "admin-ui dist not found at %s — the dashboard will 503 until you build "
            "it (cd reef/admin-ui && bun run build) and/or set REEF_ADMIN_UI_DIR.",
            dist,
        )
    if host not in ("127.0.0.1", "localhost", "::1"):
        # The dashboard is admin-token-gated but meant to ride an SSH forward, not
        # be exposed. A non-loopback bind is intentional only for a trusted LAN.
        logger.warning(
            "REEF_ADMIN_UI_HOST=%s is not loopback — the dashboard will be reachable "
            "on that interface (token-gated, but never put it on the public tunnel).",
            host,
        )
    logger.info(
        "Reef dashboard on http://%s:%d  (proxying /api -> %s). "
        "Reach it via:  ssh -L %d:127.0.0.1:%d <host>",
        host,
        port,
        _default_api_base(),
        port,
        port,
    )
    uvicorn.run("reef.admin_ui:app", host=host, port=port, loop="asyncio")


if __name__ == "__main__":
    main()
