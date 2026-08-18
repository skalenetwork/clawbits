"""Surface proxy (``/s/{digest}/…``) — digest naming, resolution, HTTP/WS
bridging against real local upstreams, and the access-reveal URL swap
(loopback → request-origin proxy URLs)."""

import asyncio
import contextlib
import json
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from reef.api.app import create_app
from reef.exposure import SubdomainProxyExposure, surface_digest
from reef.fleet import FleetService
from reef.models import Sandbox
from reef.runtime import SandboxState
from reef.store import InMemorySandboxStore
from reef.tests.fakes import FakeAdminRuntime
from reef.tests.test_fleet import INSPECT, INSPECT_EXPOSED

SECRET = "test-master"


def _rec(
    sandbox_id: str = "oc-1",
    *,
    port: int | None = None,
    terminal_port: int | None = None,
    url: str | None = None,
    terminal_url: str | None = None,
) -> Sandbox:
    return Sandbox(
        sandbox_id=sandbox_id,
        profile="openclaw",
        backend="docker",
        state=SandboxState.RUNNING,
        image="reef-oc:plugin",
        volume=f"reef-{sandbox_id}",
        port=port,
        url=url,
        terminal_port=terminal_port,
        terminal_url=terminal_url,
    )


def _make_app(records: list[Sandbox], runtime: FakeAdminRuntime | None = None):
    store = InMemorySandboxStore()
    for rec in records:
        asyncio.run(store.put(rec))
    return create_app(service=FleetService(runtime or FakeAdminRuntime(), store))


# ── upstream fixtures ────────────────────────────────────────────────────────


class _EchoHandler(BaseHTTPRequestHandler):
    """Reports back what the proxy actually sent (path, headers, body)."""

    def _reply(self, body: bytes = b"") -> None:
        payload = json.dumps(
            {
                "method": self.command,
                "path": self.path,
                "origin": self.headers.get("Origin"),
                "prefix": self.headers.get("X-Forwarded-Prefix"),
                "authorization": self.headers.get("Authorization"),
                "body": body.decode() if body else "",
            }
        ).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self) -> None:  # noqa: N802 — http.server API
        if self.path.startswith("/redirect-abs"):
            self.send_response(302)
            self.send_header(
                "Location", f"http://127.0.0.1:{self.server.server_port}/after"
            )
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if self.path.startswith("/redirect-rel"):
            self.send_response(302)
            self.send_header("Location", "/after")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if self.path.startswith("/page"):
            html = b"<!doctype html><html><head><title>agent</title></head><body>hi</body></html>"
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(html)))
            self.end_headers()
            self.wfile.write(html)
            return
        self._reply()

    def do_POST(self) -> None:  # noqa: N802
        n = int(self.headers.get("Content-Length") or 0)
        self._reply(self.rfile.read(n))

    def log_message(self, *args: object) -> None:  # quiet
        return


@pytest.fixture()
def http_upstream():
    server = ThreadingHTTPServer(("127.0.0.1", 0), _EchoHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server.server_port
    finally:
        server.shutdown()


class _KeepAliveHandler(BaseHTTPRequestHandler):
    """A keep-alive-capable upstream that records the source port of every
    request, so a test can tell a reused connection from a fresh one."""

    protocol_version = "HTTP/1.1"  # without this http.server closes after each response
    seen: list[int] = []

    def do_GET(self) -> None:  # noqa: N802 — http.server API
        type(self).seen.append(self.client_address[1])
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", "2")
        self.end_headers()
        self.wfile.write(b"{}")

    def log_message(self, *args: object) -> None:  # quiet
        return


@pytest.fixture()
def keepalive_upstream():
    _KeepAliveHandler.seen = []
    server = ThreadingHTTPServer(("127.0.0.1", 0), _KeepAliveHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server.server_port, _KeepAliveHandler.seen
    finally:
        server.shutdown()


@pytest.fixture()
def truncating_html_upstream():
    """Promises more HTML than it delivers, then hangs up — what a surface that
    dies mid-response looks like to the proxy."""
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen(8)

    def serve() -> None:
        with contextlib.suppress(OSError):
            while True:
                conn, _ = listener.accept()
                with conn:
                    conn.recv(65536)
                    conn.sendall(
                        b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n"
                        b"Content-Length: 500\r\n\r\n<!doctype html><html><head></head>"
                    )

    thread = threading.Thread(target=serve, daemon=True)
    thread.start()
    try:
        yield listener.getsockname()[1]
    finally:
        listener.close()


@pytest.fixture()
def ws_upstream():
    from websockets.sync.server import serve

    def echo(ws) -> None:
        with contextlib.suppress(Exception):
            for msg in ws:
                ws.send(msg)

    server = serve(echo, "127.0.0.1", 0)
    port = server.socket.getsockname()[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield port
    finally:
        server.shutdown()


@pytest.fixture()
def ws_header_upstream():
    """An echo WS upstream that also records the handshake's ``Authorization``
    header, so a test can assert the proxy forwarded it (Hermes' dashboard WS —
    /api/ws, /api/pty — is basic-auth-gated, so a dropped header ⇒ dead chat)."""
    from websockets.sync.server import serve

    captured: dict[str, str | None] = {}

    def echo(ws) -> None:
        captured["authorization"] = ws.request.headers.get("Authorization")
        with contextlib.suppress(Exception):
            for msg in ws:
                ws.send(msg)

    server = serve(echo, "127.0.0.1", 0)
    port = server.socket.getsockname()[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield port, captured
    finally:
        server.shutdown()


# ── digest construction ──────────────────────────────────────────────────────


def test_surface_digest_matches_subdomain_construction():
    exp = SubdomainProxyExposure("agents.example.com", secret="s3")
    assert exp.subdomain("oc-1") == surface_digest("s3", "oc-1")
    assert exp.subdomain("oc-1", "terminal") == surface_digest("s3", "oc-1", "terminal")


def test_surface_digest_distinct_per_surface_and_secret():
    assert surface_digest("k", "a") != surface_digest("k", "a", "terminal")
    assert surface_digest("k", "a") != surface_digest("k2", "a")
    assert surface_digest("k", "a") != surface_digest("k", "b")
    assert len(surface_digest("k", "a")) == 32


# ── HTTP proxying ────────────────────────────────────────────────────────────


def test_http_proxy_round_trip(http_upstream, monkeypatch):
    monkeypatch.setenv("REEF_SUBDOMAIN_SECRET", SECRET)
    app = _make_app([_rec(port=http_upstream)])
    digest = surface_digest(SECRET, "oc-1")
    with TestClient(app) as client:
        r = client.get(
            f"/s/{digest}/echo/path?x=1",
            headers={"Origin": "https://tunnel.example", "Authorization": "Basic abc"},
        )
        assert r.status_code == 200
        body = r.json()
        assert body["method"] == "GET"
        assert body["path"] == "/echo/path?x=1"  # prefix stripped, query kept
        assert body["origin"] == f"http://127.0.0.1:{http_upstream}"  # rewritten
        assert body["prefix"] == f"/s/{digest}"
        assert body["authorization"] == "Basic abc"  # surface auth passes through

        r = client.post(f"/s/{digest}/submit", content=b"hello")
        assert r.json()["method"] == "POST"
        assert r.json()["body"] == "hello"


def test_html_proxy_injects_ws_prefix_shim(http_upstream, monkeypatch):
    # The agent UI roots its gateway WS at "/" (dropping the surface prefix);
    # the proxy splices a shim into served HTML to put the prefix back, so the
    # WS reaches THIS agent instead of the API root (the contentless-1006 bug).
    monkeypatch.setenv("REEF_SUBDOMAIN_SECRET", SECRET)
    app = _make_app([_rec(port=http_upstream)])
    digest = surface_digest(SECRET, "oc-1")
    with TestClient(app) as client:
        r = client.get(f"/s/{digest}/page")
        assert r.status_code == 200
        assert r.headers["content-type"].startswith("text/html")
        # Shim carries this surface's prefix and runs before the app's own markup.
        assert f'"/s/{digest}"' in r.text
        assert "window.WebSocket = new Proxy" in r.text
        assert r.text.index("<script>") < r.text.index("<title>")
        # Rewritten body re-lengthed; stale content-length/encoding not forwarded.
        assert int(r.headers["content-length"]) == len(r.text.encode())

        # Non-HTML responses are passed through untouched (no shim).
        assert "WebSocket" not in client.get(f"/s/{digest}/echo").text


def test_http_proxy_root_redirects_to_slashed_form(http_upstream, monkeypatch):
    monkeypatch.setenv("REEF_SUBDOMAIN_SECRET", SECRET)
    app = _make_app([_rec(port=http_upstream)])
    digest = surface_digest(SECRET, "oc-1")
    with TestClient(app) as client:
        r = client.get(f"/s/{digest}", follow_redirects=False)
        assert r.status_code == 307
        assert r.headers["location"].endswith(f"/s/{digest}/")


def test_http_proxy_rewrites_locations_back_into_the_prefix(http_upstream, monkeypatch):
    monkeypatch.setenv("REEF_SUBDOMAIN_SECRET", SECRET)
    app = _make_app([_rec(port=http_upstream)])
    digest = surface_digest(SECRET, "oc-1")
    with TestClient(app) as client:
        r = client.get(f"/s/{digest}/redirect-rel", follow_redirects=False)
        assert r.status_code == 302
        assert r.headers["location"] == f"/s/{digest}/after"
        r = client.get(f"/s/{digest}/redirect-abs", follow_redirects=False)
        assert r.headers["location"] == f"/s/{digest}/after"


def test_http_proxy_unknown_or_wrong_secret_digest_is_404(http_upstream, monkeypatch):
    monkeypatch.setenv("REEF_SUBDOMAIN_SECRET", SECRET)
    app = _make_app([_rec(port=http_upstream)])
    with TestClient(app) as client:
        assert client.get("/s/deadbeefdeadbeefdeadbeefdeadbeef/").status_code == 404
        wrong = surface_digest("other-secret", "oc-1")
        assert client.get(f"/s/{wrong}/").status_code == 404


def test_http_proxy_upstream_down_is_502(monkeypatch):
    monkeypatch.setenv("REEF_SUBDOMAIN_SECRET", SECRET)
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    dead_port = sock.getsockname()[1]
    sock.close()  # nothing listens here anymore
    app = _make_app([_rec(port=dead_port)])
    digest = surface_digest(SECRET, "oc-1")
    with TestClient(app) as client:
        r = client.get(f"/s/{digest}/")
        assert r.status_code == 502
        assert "not reachable" in r.json()["detail"]


def test_http_proxy_does_not_reuse_upstream_connections(keepalive_upstream, monkeypatch):
    # Regression: agent surfaces (ttyd) hang up after a response without saying
    # so, and a pooled dead socket made every SECOND proxied request 502 — which
    # basic auth hits every time, since the 401 challenge and the credentialed
    # retry are milliseconds apart.
    port, seen = keepalive_upstream
    monkeypatch.setenv("REEF_SUBDOMAIN_SECRET", SECRET)
    app = _make_app([_rec(port=port)])
    digest = surface_digest(SECRET, "oc-1")
    with TestClient(app) as client:
        assert client.get(f"/s/{digest}/first").status_code == 200
        assert client.get(f"/s/{digest}/second").status_code == 200
    assert len(seen) == 2
    assert len(set(seen)) == 2, "proxy reused a pooled upstream connection"


def test_html_proxy_body_dying_mid_read_is_502(truncating_html_upstream, monkeypatch):
    # The HTML branch buffers (to splice the WS shim), so a body that dies is
    # caught before anything reaches the client: it must become reef's own
    # diagnosable 502, not an exception that drops the connection.
    monkeypatch.setenv("REEF_SUBDOMAIN_SECRET", SECRET)
    app = _make_app([_rec(port=truncating_html_upstream)])
    digest = surface_digest(SECRET, "oc-1")
    with TestClient(app) as client:
        r = client.get(f"/s/{digest}/")
        assert r.status_code == 502
        assert "not reachable" in r.json()["detail"]


def test_terminal_surface_resolves_to_terminal_port(http_upstream, monkeypatch):
    monkeypatch.setenv("REEF_SUBDOMAIN_SECRET", SECRET)
    # ui port is dead; only the terminal digest should reach the upstream.
    app = _make_app([_rec(port=1, terminal_port=http_upstream)])
    digest = surface_digest(SECRET, "oc-1", "terminal")
    with TestClient(app) as client:
        r = client.get(f"/s/{digest}/")
        assert r.status_code == 200
        assert r.json()["prefix"] == f"/s/{digest}"


# ── WebSocket proxying ───────────────────────────────────────────────────────


def test_ws_proxy_echoes_text_and_bytes(ws_upstream, monkeypatch):
    monkeypatch.setenv("REEF_SUBDOMAIN_SECRET", SECRET)
    app = _make_app([_rec(port=ws_upstream)])
    digest = surface_digest(SECRET, "oc-1")
    with TestClient(app) as client, client.websocket_connect(f"/s/{digest}/ws") as ws:
        ws.send_text("hello")
        assert ws.receive_text() == "hello"
        ws.send_bytes(b"\x01\x02\x03")
        assert ws.receive_bytes() == b"\x01\x02\x03"


def test_ws_proxy_accepts_bare_digest_without_trailing_slash(ws_upstream, monkeypatch):
    # The Control UI derives its gateway URL from the page's base path, which
    # normalizes away the trailing slash (ws://…/s/{digest}). WS handshakes
    # can't follow proxy_root's 307, so the bare path must connect directly.
    monkeypatch.setenv("REEF_SUBDOMAIN_SECRET", SECRET)
    app = _make_app([_rec(port=ws_upstream)])
    digest = surface_digest(SECRET, "oc-1")
    with TestClient(app) as client, client.websocket_connect(f"/s/{digest}") as ws:
        ws.send_text("hello")
        assert ws.receive_text() == "hello"


def test_ws_unknown_digest_rejects_handshake(monkeypatch):
    monkeypatch.setenv("REEF_SUBDOMAIN_SECRET", SECRET)
    app = _make_app([])
    with (
        TestClient(app) as client,
        pytest.raises(WebSocketDisconnect),
        client.websocket_connect("/s/deadbeefdeadbeefdeadbeefdeadbeef/ws"),
    ):
        pass


def test_ws_proxy_forwards_authorization_to_upstream(ws_header_upstream, monkeypatch):
    # Hermes' dashboard drives its Chat/TUI over a basic-auth-gated WebSocket; the
    # surface proxy must carry the client's Authorization header through the
    # handshake, or the page loads but chat sits "disconnected". Locks proxy.py's
    # header forwarding so a future refactor can't silently drop it.
    monkeypatch.setenv("REEF_SUBDOMAIN_SECRET", SECRET)
    port, captured = ws_header_upstream
    app = _make_app([_rec(port=port)])
    digest = surface_digest(SECRET, "oc-1")
    with (
        TestClient(app) as client,
        client.websocket_connect(
            f"/s/{digest}/ws", headers={"Authorization": "Basic cmVlZjpwdw=="}
        ) as ws,
    ):
        ws.send_text("ping")
        assert ws.receive_text() == "ping"
    assert captured["authorization"] == "Basic cmVlZjpwdw=="


# ── password re-reveal (POST /fleet/{id}/reveal) ─────────────────────────────


def test_reveal_endpoint_returns_password_and_proxy_url(monkeypatch):
    # The deliberate opt-in recovery of the one-time password: the endpoint reads
    # the gateway token back from the guest env AND publicizes the loopback URL.
    monkeypatch.setenv("REEF_SUBDOMAIN_SECRET", SECRET)
    rt = FakeAdminRuntime().seed("oc-1", inspect=INSPECT_EXPOSED)
    rec = _rec(port=40001, url="http://127.0.0.1:40001")
    app = _make_app([rec], runtime=rt)
    with TestClient(app) as client:
        r = client.post("/fleet/oc-1/reveal")
    assert r.status_code == 200
    body = r.json()
    assert body["password"] == "s3cret-pw"
    assert body["url"] == f"http://testserver/s/{surface_digest(SECRET, 'oc-1')}/"


def test_reveal_endpoint_404_when_not_exposed(monkeypatch):
    monkeypatch.setenv("REEF_SUBDOMAIN_SECRET", SECRET)
    rt = FakeAdminRuntime().seed("oc-2", inspect=INSPECT)  # loopback — not exposed
    app = _make_app([_rec(sandbox_id="oc-2")], runtime=rt)
    with TestClient(app) as client:
        assert client.post("/fleet/oc-2/reveal").status_code == 404


# ── access reveal: loopback URLs → request-origin proxy URLs ─────────────────


def test_access_reveal_swaps_loopback_for_proxy_urls(monkeypatch):
    monkeypatch.setenv("REEF_SUBDOMAIN_SECRET", SECRET)
    rt = FakeAdminRuntime().seed("oc-1", inspect=INSPECT_EXPOSED)
    rec = _rec(
        port=40001,
        url="http://127.0.0.1:40001",
        terminal_port=40002,
        terminal_url="http://127.0.0.1:40002",
    )
    app = _make_app([rec], runtime=rt)
    with TestClient(app) as client:
        access = client.get("/fleet/oc-1").json()["access"]
    assert access["url"] == f"http://testserver/s/{surface_digest(SECRET, 'oc-1')}/"
    assert (
        access["terminal_url"]
        == f"http://testserver/s/{surface_digest(SECRET, 'oc-1', 'terminal')}/"
    )
    # One-time model: detail surfaces the URLs but NEVER the password — reef can't
    # recompute it. It is revealed only in the create response.
    assert access["password"] is None


def test_access_reveal_keeps_publicly_minted_urls(monkeypatch):
    monkeypatch.setenv("REEF_SUBDOMAIN_SECRET", SECRET)
    rt = FakeAdminRuntime().seed("oc-1", inspect=INSPECT_EXPOSED)
    rec = _rec(
        port=40001,
        url="https://abc123.agents.example.com",
        terminal_port=40002,
        terminal_url="https://def456.agents.example.com",
    )
    app = _make_app([rec], runtime=rt)
    with TestClient(app) as client:
        access = client.get("/fleet/oc-1").json()["access"]
    assert access["url"] == "https://abc123.agents.example.com"
    assert access["terminal_url"] == "https://def456.agents.example.com"
