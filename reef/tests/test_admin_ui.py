"""Local-only operator dashboard server (``reef.admin_ui``) — static SPA serving
with deep-link fallback + the ``/api/*`` reverse proxy to the Reef API.
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from reef.admin_ui import create_admin_ui_app


# ── a fake "Reef API" upstream the proxy forwards to ─────────────────────────
class _ApiHandler(BaseHTTPRequestHandler):
    def _reply(self, body: bytes = b"") -> None:
        payload = json.dumps(
            {
                "method": self.command,
                "path": self.path,  # includes query — proves stripping + forwarding
                "authorization": self.headers.get("Authorization"),
                "body": body.decode() if body else "",
            }
        ).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self) -> None:  # noqa: N802
        if self.path.startswith("/needs-auth") and not self.headers.get("Authorization"):
            self.send_response(401)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self._reply()

    def do_POST(self) -> None:  # noqa: N802
        n = int(self.headers.get("Content-Length") or 0)
        self._reply(self.rfile.read(n))

    def log_message(self, *args: object) -> None:
        return


@pytest.fixture()
def api_upstream():
    server = ThreadingHTTPServer(("127.0.0.1", 0), _ApiHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()


@pytest.fixture()
def dist(tmp_path: Path) -> Path:
    d = tmp_path / "dist"
    (d / "assets").mkdir(parents=True)
    (d / "index.html").write_text("<!doctype html><div id=root></div>")
    (d / "assets" / "app-abc123.js").write_text("console.log('hi')")
    (d / "favicon.ico").write_text("icon")
    return d


def _client(dist: Path, api_base: str) -> TestClient:
    return TestClient(create_admin_ui_app(dist_dir=dist, api_base=api_base))


# ── static SPA serving ───────────────────────────────────────────────────────
def test_root_serves_index(dist, api_upstream):
    with _client(dist, api_upstream) as c:
        r = c.get("/")
        assert r.status_code == 200
        assert "id=root" in r.text
        assert r.headers["cache-control"] == "no-store"


def test_hashed_asset_is_served_immutable(dist, api_upstream):
    with _client(dist, api_upstream) as c:
        r = c.get("/assets/app-abc123.js")
        assert r.status_code == 200
        assert "console.log" in r.text
        assert "immutable" in r.headers["cache-control"]


def test_deep_link_falls_back_to_index(dist, api_upstream):
    # BrowserRouter deep link refreshed directly → must serve the SPA shell, 200.
    with _client(dist, api_upstream) as c:
        r = c.get("/agents/oc-1")
        assert r.status_code == 200
        assert "id=root" in r.text
        assert r.headers["cache-control"] == "no-store"


def test_non_asset_real_file_served(dist, api_upstream):
    with _client(dist, api_upstream) as c:
        assert c.get("/favicon.ico").status_code == 200


def test_path_traversal_is_contained(dist, api_upstream, tmp_path):
    # A secret next to (outside) dist must never be served via ../ escapes.
    (tmp_path / "secret.txt").write_text("TOPSECRET")
    with _client(dist, api_upstream) as c:
        r = c.get("/../secret.txt")
        # Either normalized away by the client/route or served as the SPA shell —
        # never the secret.
        assert "TOPSECRET" not in r.text


# ── /api reverse proxy ───────────────────────────────────────────────────────
def test_api_proxy_strips_prefix_and_forwards(dist, api_upstream):
    with _client(dist, api_upstream) as c:
        r = c.get("/api/fleet?state=running")
        assert r.status_code == 200
        body = r.json()
        assert body["method"] == "GET"
        assert body["path"] == "/fleet?state=running"  # /api stripped, query kept


def test_api_proxy_forwards_authorization(dist, api_upstream):
    with _client(dist, api_upstream) as c:
        # No token → upstream 401 (the admin-token gate is enforced end-to-end).
        assert c.get("/api/needs-auth").status_code == 401
        r = c.get("/api/needs-auth", headers={"Authorization": "Bearer s3cret"})
        assert r.status_code == 200
        assert r.json()["authorization"] == "Bearer s3cret"


def test_api_proxy_forwards_post_body(dist, api_upstream):
    with _client(dist, api_upstream) as c:
        r = c.post("/api/fleet", content=b'{"type":"openclaw"}')
        assert r.status_code == 200
        assert r.json()["body"] == '{"type":"openclaw"}'


def test_api_proxy_upstream_down_is_502(dist):
    # Point at a dead port — the dashboard reports 502, not a 500 traceback.
    with _client(dist, "http://127.0.0.1:1") as c:
        assert c.get("/api/fleet").status_code == 502


def test_missing_dist_is_503(tmp_path, api_upstream):
    with _client(tmp_path / "nope", api_upstream) as c:
        assert c.get("/").status_code == 503
