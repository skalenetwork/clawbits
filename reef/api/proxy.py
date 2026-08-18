"""Surface proxy — ``/s/{digest}/…`` → the agent's loopback UI/terminal port.

The remote-access story for a single public hostname: the operator exposes ONE
origin (this API, e.g. over a cloudflared tunnel) and it carries the fleet API
*and* every agent surface. Without this, ``DirectPortExposure`` mints
``http://127.0.0.1:<port>`` access URLs that only work on the Reef host itself.

The ``digest`` is the same unguessable construction as
``SubdomainProxyExposure``'s subdomains — ``sha256(secret:sandbox_id[:surface])
[:32]`` (``reef.exposure.surface_digest``), keyed by ``REEF_SUBDOMAIN_SECRET``.
The auth model mirrors the prod subdomain proxy:

- the proxy hop itself is NOT behind ``admin_auth`` — browsers must reach it
  cold, exactly like a subdomain;
- secrecy of the path comes from the digest (set ``REEF_SUBDOMAIN_SECRET`` —
  without it, digests are computable from sandbox ids);
- each surface still enforces its OWN auth end-to-end: the Control UI's
  gateway token (``#token=`` fragment) and the terminal's ttyd basic-auth.
  Those secrets are a ONE-TIME reveal at agent creation (``manager.expose``) —
  reef neither stores nor can recompute them, and never re-reveals them on
  ``GET /fleet/{id}``. The proxy is transparent: it forwards whatever credential
  the operator's browser presents and holds none itself.

HTTP is streamed both ways via a shared ``httpx`` client; WebSockets are
bridged frame-by-frame via ``websockets``. ``Origin`` is rewritten to the
upstream's own origin so the gateway's allowed-origins check (pinned to its
boot-time ``OPENCLAW_PUBLIC_URL``) doesn't reject tunnel origins it has never
heard of.
"""

import asyncio
import contextlib
import json
import logging
import os
import re
from collections.abc import AsyncIterator
from urllib.parse import urlsplit

import httpx
import websockets
from fastapi import APIRouter, Request, WebSocket
from starlette.background import BackgroundTask
from starlette.responses import JSONResponse, RedirectResponse, Response, StreamingResponse

from reef.exposure import surface_digest
from reef.fleet import FleetService

logger = logging.getLogger("reef.api.proxy")

router = APIRouter(prefix="/s", tags=["surface-proxy"])

_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]

# Hop-by-hop headers (RFC 9110 §7.6.1) — meaningful per-connection, never forwarded.
_HOP_BY_HOP = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
}

_LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}


def proxy_secret() -> str:
    """Digest key for surface paths — ``REEF_SUBDOMAIN_SECRET`` (the same env the
    nginx subdomain proxy uses). Empty string when unset (dev): paths are then
    derivable from sandbox ids, and only the surfaces' own one-time secret
    protects them."""
    return os.getenv("REEF_SUBDOMAIN_SECRET") or ""


def proxied_surface_url(base_url: str, sandbox_id: str, surface: str) -> str:
    """Absolute surface-proxy URL under ``base_url`` (the origin the caller used
    to reach this API — localhost or the tunnel — so it is always reachable from
    that caller's browser)."""
    digest = surface_digest(proxy_secret(), sandbox_id, surface)
    return f"{base_url.rstrip('/')}/s/{digest}/"


def is_loopback_url(url: str | None) -> bool:
    """True for URLs only reachable on the Reef host itself (the ones
    ``DirectPortExposure`` mints) — the ones worth swapping for proxy URLs."""
    if not url:
        return False
    try:
        host = urlsplit(url).hostname
    except ValueError:
        return False
    return host in _LOOPBACK_HOSTS


def _http_client(request: Request) -> httpx.AsyncClient:
    # Shared app-lifetime client (lazy, parked on app.state): connection pooling
    # across proxied requests, one client per app/event-loop. read/write
    # timeouts are off — agent surfaces hold long-poll/SSE streams. Closed by
    # the app's lifespan teardown (see ``reef.api.app``).
    client: httpx.AsyncClient | None = getattr(request.app.state, "surface_proxy_client", None)
    if client is None or client.is_closed:
        client = httpx.AsyncClient(
            timeout=httpx.Timeout(connect=5.0, read=None, write=None, pool=5.0),
            # NO keep-alive reuse. Agent surfaces hang up right after a response
            # (ttyd/libwebsockets does it on every 401 challenge), but say
            # nothing about it in the response, so httpx parks the dead socket
            # in its pool for keepalive_expiry (5s by default) and the NEXT
            # proxied request within that window dies on it. Basic auth makes
            # that pair unavoidable — the browser's 401 challenge and its
            # credentialed retry are milliseconds apart — so every other
            # terminal open used to 502. Over loopback a fresh connection per
            # request costs nothing.
            limits=httpx.Limits(max_keepalive_connections=0),
            follow_redirects=False,
        )
        request.app.state.surface_proxy_client = client
    return client


_IDEMPOTENT = {"GET", "HEAD", "OPTIONS"}


def _unreachable(sandbox_id: str, url: str, exc: Exception) -> JSONResponse:
    """The one 502 reef itself mints: the surface did not answer. Say which
    sandbox — the alternative is Cloudflare's contentless "Bad gateway", which
    tells the operator nothing about which of the two hops failed."""
    logger.info("surface proxy: upstream %s unreachable for %s: %s", url, sandbox_id, exc)
    return JSONResponse(
        status_code=502,
        content={"detail": f"agent surface not reachable (sandbox {sandbox_id}) — is it running?"},
    )


async def _send_upstream(
    client: httpx.AsyncClient,
    request: Request,
    url: str,
    headers: dict[str, str],
    *,
    has_body: bool,
) -> httpx.Response:
    """Send the proxied request, retrying ONCE on a connection-level failure.

    Only for bodyless idempotent requests: a retry must not replay a side
    effect, and a request body is an already-consumed ``request.stream()``.
    Covers the surface coming back mid-request (a restarted agent accepts the
    connection before its UI binds), which would otherwise surface as a 502 on
    the first click after a restart."""
    attempts = 2 if not has_body and request.method.upper() in _IDEMPOTENT else 1
    last: httpx.HTTPError | None = None
    for attempt in range(attempts):
        upstream_req = client.build_request(
            request.method, url, headers=headers, content=request.stream() if has_body else None
        )
        try:
            return await client.send(upstream_req, stream=True)
        except httpx.HTTPError as e:
            last = e
            if attempt + 1 < attempts:
                logger.info("surface proxy: retrying %s after %s", url, e)
    raise last  # type: ignore[misc]  # attempts >= 1, so last is set


def _rewrite_location(location: str, digest: str, upstream_base: str) -> str:
    """Keep upstream redirects inside the proxied path: absolute-to-upstream and
    root-relative Locations both escape ``/s/{digest}/`` if left alone."""
    if location.startswith(upstream_base):
        return f"/s/{digest}{location[len(upstream_base):] or '/'}"
    if location.startswith("/"):
        return f"/s/{digest}{location}"
    return location  # relative or external — already correct


# Spliced into proxied HTML. The agent UI (OpenClaw's Control UI) derives its
# gateway WebSocket URL from ``window.location`` but roots the path at ``/`` —
# dropping the ``/s/{digest}/`` prefix it is actually served under. On the
# single-hostname surface proxy, agents are addressed by PATH, so that root WS
# lands on the API (no per-agent WS route) and the browser reports a contentless
# ``1006``. This shim wraps ``window.WebSocket`` so same-origin, unprefixed WS
# URLs regain the prefix; already-prefixed and cross-origin URLs pass through.
# ``__PREFIX__`` is replaced with a JSON-encoded ``"/s/{digest}"`` string literal.
_WS_SHIM = """<script>(function(){
  var PREFIX = __PREFIX__;
  var Native = window.WebSocket;
  if (!Native || typeof Proxy === "undefined") return;
  function rewrite(url){
    try{
      var u = new URL(url, window.location.href);
      if (u.host === window.location.host && u.pathname !== PREFIX
          && u.pathname.lastIndexOf(PREFIX + "/", 0) !== 0){
        u.pathname = PREFIX + (u.pathname === "/" ? "/" : u.pathname);
        return u.toString();
      }
    }catch(e){}
    return url;
  }
  window.WebSocket = new Proxy(Native, {construct:function(target, args){
    if (args.length) args[0] = rewrite(args[0]);
    return new target(...args);
  }});
})();</script>"""

_HEAD_RE = re.compile(rb"<head[^>]*>", re.IGNORECASE)


def _inject_ws_shim(body: bytes, digest: str) -> bytes:
    """Splice the WebSocket-prefix shim into a proxied HTML document so the agent
    UI connects through ``/s/{digest}/`` instead of the host root. Inserted right
    after ``<head>`` so it runs before the app bundle; prepended if there is no
    head (unexpected, but still ahead of any script)."""
    tag = _WS_SHIM.replace("__PREFIX__", json.dumps(f"/s/{digest}")).encode()
    m = _HEAD_RE.search(body)
    return body[: m.end()] + tag + body[m.end() :] if m else tag + body


@router.api_route("/{digest}", methods=_METHODS, include_in_schema=False)
async def proxy_root(digest: str, request: Request) -> Response:
    # Canonicalize to the slashed form: agent UIs use RELATIVE asset/WS URLs,
    # which only resolve under /s/{digest}/ (not /s/).
    return RedirectResponse(str(request.url.replace(path=f"/s/{digest}/")), status_code=307)


@router.api_route("/{digest}/{path:path}", methods=_METHODS, include_in_schema=False)
async def proxy_http(digest: str, path: str, request: Request) -> Response:
    service: FleetService = request.app.state.fleet_service
    resolved = await service.resolve_surface(digest, secret=proxy_secret())
    if resolved is None:
        return JSONResponse(status_code=404, content={"detail": "unknown surface"})
    sandbox_id, _surface, port = resolved

    upstream_base = f"http://127.0.0.1:{port}"
    url = f"{upstream_base}/{path}"
    if request.url.query:
        url = f"{url}?{request.url.query}"

    headers: dict[str, str] = {}
    for k, v in request.headers.items():
        lk = k.lower()
        if lk in _HOP_BY_HOP or lk in ("host", "referer"):
            continue
        if lk == "origin":
            v = upstream_base  # see module docstring: the gateway trusts its own origin
        headers[k] = v
    headers["X-Forwarded-For"] = request.client.host if request.client else ""
    headers["X-Forwarded-Proto"] = request.url.scheme
    headers["X-Forwarded-Host"] = request.headers.get("host", "")
    headers["X-Forwarded-Prefix"] = f"/s/{digest}"

    client = _http_client(request)
    # Forward a body ONLY when the client sent one: unconditionally streaming
    # turns bodyless GETs into Transfer-Encoding: chunked requests, which some
    # surface servers (ttyd's libwebsockets) answer with headers but no body.
    has_body = "content-length" in request.headers or "transfer-encoding" in request.headers
    try:
        upstream = await _send_upstream(client, request, url, headers, has_body=has_body)
    except httpx.HTTPError as e:
        return _unreachable(sandbox_id, url, e)

    # HTML documents bootstrap the agent UI: buffer and splice in the WebSocket
    # shim (see _inject_ws_shim) so its gateway connection keeps the /s/{digest}/
    # prefix. GET only — a HEAD shares the content-type but must stay bodyless.
    # httpx's aread() returns the DECODED body, so any content-encoding is gone:
    # drop that header and let Response re-derive content-length from the new body.
    ctype = upstream.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if request.method == "GET" and ctype == "text/html":
        # A body that dies mid-read is still a dead surface, and nothing has
        # reached the client yet — answer it like an unreachable upstream
        # instead of letting the exception tear the connection down (which
        # reaches the browser as an opaque proxy-level 502).
        try:
            body = _inject_ws_shim(await upstream.aread(), digest)
        except httpx.HTTPError as e:
            return _unreachable(sandbox_id, url, e)
        finally:
            await upstream.aclose()
        html = Response(content=body, status_code=upstream.status_code)
        if "content-type" in html.headers:
            del html.headers["content-type"]  # mirror upstream exactly
        for k, v in upstream.headers.multi_items():
            lk = k.lower()
            if lk in _HOP_BY_HOP or lk in ("content-length", "content-encoding"):
                continue
            if lk == "location":
                v = _rewrite_location(v, digest, upstream_base)
            html.headers.append(k, v)
        return html

    async def body() -> AsyncIterator[bytes]:
        # Headers are already on the wire here, so a failure can no longer
        # become a 502 — log it so a truncated response is traceable to the
        # surface rather than looking like a client-side bug.
        try:
            async for chunk in upstream.aiter_raw():
                yield chunk
        except httpx.HTTPError as e:
            logger.info("surface proxy: stream from %s for %s failed: %s", url, sandbox_id, e)
            raise

    # aiter_raw streams the still-encoded entity bytes, so content-length and
    # content-encoding pass through untouched.
    out = StreamingResponse(
        body(),
        status_code=upstream.status_code,
        background=BackgroundTask(upstream.aclose),
    )
    del out.headers["content-type"]  # StreamingResponse defaults one; mirror upstream exactly
    for k, v in upstream.headers.multi_items():
        lk = k.lower()
        if lk in _HOP_BY_HOP:
            continue
        if lk == "location":
            v = _rewrite_location(v, digest, upstream_base)
        out.headers.append(k, v)
    return out


@router.websocket("/{digest}")
async def proxy_ws_root(websocket: WebSocket, digest: str) -> None:
    # The slash-less twin of proxy_root, but for WebSockets — which can't follow
    # its 307. The Control UI derives its gateway URL from the page's base path,
    # which normalizes away the trailing slash (ws://…/s/{digest}), so without
    # this route the handshake is rejected 403 and the UI sits at "disconnected".
    await proxy_ws(websocket, digest, "")


@router.websocket("/{digest}/{path:path}")
async def proxy_ws(websocket: WebSocket, digest: str, path: str) -> None:
    service: FleetService = websocket.app.state.fleet_service
    resolved = await service.resolve_surface(digest, secret=proxy_secret())
    if resolved is None:
        # Uvicorn logs this close-before-accept as a bare "403 Forbidden"; say
        # why: a stale URL (destroyed sandbox) or a REEF_SUBDOMAIN_SECRET change.
        logger.info("surface proxy: ws handshake for unknown digest %s rejected", digest)
        await websocket.close(code=1008)  # rejects the handshake
        return
    sandbox_id, _surface, port = resolved

    url = f"ws://127.0.0.1:{port}/{path}"
    if websocket.url.query:
        url = f"{url}?{websocket.url.query}"

    # Credentials/cookies travel through; Origin is pinned to the upstream's own
    # origin (same reasoning as HTTP). Subprotocols are negotiated end-to-end.
    fwd = {
        k: v
        for k, v in websocket.headers.items()
        if k.lower() in ("authorization", "cookie", "user-agent", "accept-language")
    }
    offered = [
        p.strip()
        for p in websocket.headers.get("sec-websocket-protocol", "").split(",")
        if p.strip()
    ]

    try:
        upstream = await websockets.connect(
            url,
            additional_headers=fwd,
            subprotocols=offered or None,  # type: ignore[arg-type]  # plain strs are accepted
            origin=f"http://127.0.0.1:{port}",  # type: ignore[arg-type]
            max_size=None,
            open_timeout=10,
        )
    except Exception as e:  # noqa: BLE001 — any handshake/connect failure ⇒ surface down
        logger.info("surface proxy: ws upstream %s unreachable for %s: %s", url, sandbox_id, e)
        await websocket.close(code=1014)  # "bad gateway"
        return

    await websocket.accept(subprotocol=upstream.subprotocol)

    async def client_to_upstream() -> None:
        while True:
            msg = await websocket.receive()
            if msg["type"] == "websocket.disconnect":
                return
            text = msg.get("text")
            if text is not None:
                await upstream.send(text)
                continue
            data = msg.get("bytes")
            if data is not None:
                await upstream.send(data)

    async def upstream_to_client() -> None:
        async for frame in upstream:
            if isinstance(frame, str):
                await websocket.send_text(frame)
            else:
                await websocket.send_bytes(frame)

    pumps = [
        asyncio.create_task(client_to_upstream()),
        asyncio.create_task(upstream_to_client()),
    ]
    try:
        # Either side closing (or erroring) ends the bridge; the other pump is
        # cancelled and both ends are closed below.
        _done, pending = await asyncio.wait(pumps, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
            with contextlib.suppress(BaseException):
                await task
    finally:
        with contextlib.suppress(Exception):
            await upstream.close()
        with contextlib.suppress(Exception):
            await websocket.close()
