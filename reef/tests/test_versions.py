"""Latest-version resolution + semver compare: optional, best-effort, cached. No
real network — the outbound fetchers (and, for the parse tests, httpx) are stubbed."""

import asyncio

import pytest

from reef import versions


@pytest.fixture(autouse=True)
def _clear_cache():
    versions._cache.clear()
    yield
    versions._cache.clear()


def test_disabled_returns_local_only(monkeypatch):
    monkeypatch.setenv("REEF_VERSION_CHECK", "0")
    # Stubs would raise if called — disabled must not touch the network.
    monkeypatch.setattr(versions, "_openclaw_latest", _boom)
    monkeypatch.setattr(versions, "_clawhub_plugin_latest", _boom)
    out = asyncio.run(versions.latest_versions())
    assert out["enabled"] is False
    assert out["fetched_at"] is None
    assert out["openclaw"]["runtime"]["latest"] is None
    assert out["openclaw"]["component"]["latest"] is None
    assert out["ironclaw"]["runtime"]["latest"] is None
    assert out["ironclaw"]["component"]["latest"] is None


def test_enabled_resolves_with_stubs(monkeypatch):
    monkeypatch.setenv("REEF_VERSION_CHECK", "1")
    monkeypatch.setattr(versions, "_openclaw_latest", _stub("2026.6.1"))
    monkeypatch.setattr(versions, "_clawhub_plugin_latest", _stub("0.11.0"))
    out = asyncio.run(versions.latest_versions())
    assert out["enabled"] is True
    assert out["fetched_at"] is not None
    assert out["openclaw"]["runtime"] == {"latest": "2026.6.1", "source": "npm"}
    assert out["openclaw"]["component"] == {"latest": "0.11.0", "source": "clawhub"}
    # IronClaw has no external floor yet — engine self-built, channel ships in-tree.
    assert out["ironclaw"]["runtime"]["latest"] is None
    assert out["ironclaw"]["component"]["latest"] is None


def test_plugin_resolves_from_clawhub_standalone(monkeypatch):
    # The plugin floor now rides the PUBLIC ClawHub registry — no clawbits-server
    # pairing (REEF_CLAWBITS_URL) required, so it resolves in a bare reef too.
    monkeypatch.delenv("REEF_CLAWBITS_URL", raising=False)
    monkeypatch.setenv("REEF_VERSION_CHECK", "1")
    monkeypatch.setattr(versions, "_openclaw_latest", _stub("2026.6.1"))
    monkeypatch.setattr(versions, "_clawhub_plugin_latest", _stub("0.11.0"))
    out = asyncio.run(versions.latest_versions())
    assert out["openclaw"]["component"]["latest"] == "0.11.0"
    assert out["openclaw"]["component"]["source"] == "clawhub"


def test_clawhub_plugin_latest_extracts_latest_version(monkeypatch):
    # {package: {latestVersion}} is the ClawHub package-metadata shape.
    monkeypatch.setattr(
        versions.httpx,
        "AsyncClient",
        lambda *a, **k: _FakeClient({"package": {"latestVersion": "0.11.0"}}),
    )
    assert asyncio.run(versions._clawhub_plugin_latest()) == "0.11.0"


def test_clawhub_plugin_latest_none_on_bad_shape(monkeypatch):
    # Missing field / unexpected shape ⇒ None (→ last-good cache or null), never raise.
    for payload in ({"package": {}}, {}, {"package": {"latestVersion": 5}}):
        monkeypatch.setattr(
            versions.httpx, "AsyncClient", lambda *a, _p=payload, **k: _FakeClient(_p)
        )
        assert asyncio.run(versions._clawhub_plugin_latest()) is None


def test_image_tag_candidates():
    # npm-only respin ⇒ also try the X.Y.Z base the image is published under.
    assert versions._image_tag_candidates("2026.7.1-2") == ["2026.7.1-2", "2026.7.1"]
    assert versions._image_tag_candidates("2026.7.1-beta.2") == ["2026.7.1-beta.2", "2026.7.1"]
    # A plain release maps to itself only.
    assert versions._image_tag_candidates("2026.7.1") == ["2026.7.1"]


def _ghcr_routes(existing_tags):
    """get/head routing for a fake ghcr that knows ``existing_tags``."""
    return {
        versions._GHCR_TOKEN_URL: _FakeResp({"token": "tok"}),
        **{
            versions._GHCR_MANIFEST_URL.format(tag=t): _FakeResp({}, status_code=200)
            for t in existing_tags
        },
    }


def test_openclaw_latest_normalizes_npm_respin_to_image_tag(monkeypatch):
    # The live failure: npm says 2026.7.1-2 but ghcr only publishes 2026.7.1 —
    # the floor must be the pullable tag, or "Build latest" bakes a 404 FROM.
    routes = {versions._NPM_OPENCLAW: _FakeResp({"version": "2026.7.1-2"}), **_ghcr_routes(["2026.7.1"])}
    monkeypatch.setattr(versions.httpx, "AsyncClient", lambda *a, **k: _RoutedClient(routes))
    assert asyncio.run(versions._openclaw_latest()) == "2026.7.1"


def test_openclaw_latest_passes_through_existing_tag(monkeypatch):
    routes = {versions._NPM_OPENCLAW: _FakeResp({"version": "2026.6.11"}), **_ghcr_routes(["2026.6.11"])}
    monkeypatch.setattr(versions.httpx, "AsyncClient", lambda *a, **k: _RoutedClient(routes))
    assert asyncio.run(versions._openclaw_latest()) == "2026.6.11"


def test_openclaw_latest_null_when_no_image_published(monkeypatch):
    # ghcr answers but has neither the version nor its base (npm published first)
    # ⇒ None, so _resolve serves the last-good floor instead of an unbuildable one.
    routes = {versions._NPM_OPENCLAW: _FakeResp({"version": "2026.8.1"}), **_ghcr_routes([])}
    monkeypatch.setattr(versions.httpx, "AsyncClient", lambda *a, **k: _RoutedClient(routes))
    assert asyncio.run(versions._openclaw_latest()) is None


def test_openclaw_latest_unvalidated_when_ghcr_unreachable(monkeypatch):
    # No token (registry down) ⇒ can't validate ⇒ keep the npm value (best-effort).
    routes = {versions._NPM_OPENCLAW: _FakeResp({"version": "2026.7.1-2"})}
    monkeypatch.setattr(versions.httpx, "AsyncClient", lambda *a, **k: _RoutedClient(routes))
    assert asyncio.run(versions._openclaw_latest()) == "2026.7.1-2"


def test_cache_serves_stale_on_failed_refresh(monkeypatch):
    monkeypatch.setenv("REEF_VERSION_CHECK_TTL", "0")  # force a refetch every call
    seq = iter(["1.2.3", None, None])

    async def flaky():
        return next(seq)

    # first resolve caches the good value; later resolves fail → stale-but-good
    assert asyncio.run(versions._resolve("openclaw", flaky)) == "1.2.3"
    assert asyncio.run(versions._resolve("openclaw", flaky)) == "1.2.3"
    assert asyncio.run(versions._resolve("openclaw", flaky)) == "1.2.3"


def test_enabled_flag_parsing(monkeypatch):
    for raw, want in [("1", True), ("true", True), ("", True), ("0", False), ("off", False), ("no", False)]:
        monkeypatch.setenv("REEF_VERSION_CHECK", raw)
        assert versions._enabled() is want


def test_compare_versions():
    assert versions.compare_versions("2026.6.9", "2026.6.10") < 0
    assert versions.compare_versions("2026.6.10", "2026.6.9") > 0
    assert versions.compare_versions("0.8.1", "0.8.1") == 0
    # Missing trailing segments pad with 0.
    assert versions.compare_versions("1.2", "1.2.0") == 0
    # A non-numeric segment reached before any numeric difference ⇒ equal (a parse
    # quirk must never fabricate an "outdated").
    assert versions.compare_versions("2026.6.9-beta", "2026.6.9") == 0


def test_is_outdated():
    assert versions.is_outdated("0.8.0", "0.8.1") is True
    assert versions.is_outdated("0.8.1", "0.8.1") is False
    assert versions.is_outdated("0.9.0", "0.8.1") is False
    # The live case this fixes: baked 0.8.2 is numerically behind clawhub 0.11.0
    # (8 < 11), so a rebuild is available — a naive string compare would miss it.
    assert versions.is_outdated("0.8.2", "0.11.0") is True
    # Missing either side ⇒ never outdated (safe default).
    assert versions.is_outdated(None, "0.8.1") is False
    assert versions.is_outdated("0.8.0", None) is False


def _stub(value):
    async def _f():
        return value

    return _f


async def _boom():
    raise AssertionError("outbound fetch must not run when disabled")


class _FakeResp:
    def __init__(self, payload, status_code=200):
        self._payload = payload
        self.status_code = status_code

    def raise_for_status(self):
        if self.status_code >= 400:
            raise AssertionError(f"HTTP {self.status_code}")

    def json(self):
        return self._payload


class _FakeClient:
    """Minimal async-context-manager stand-in for httpx.AsyncClient."""

    def __init__(self, payload):
        self._payload = payload

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def get(self, _url):
        return _FakeResp(self._payload)


class _RoutedClient:
    """URL-routed httpx.AsyncClient stand-in: get/head answer from ``routes``;
    an unrouted URL raises for GET (npm/token down) and 404s for HEAD (a ghcr
    manifest probe of a tag that doesn't exist)."""

    def __init__(self, routes):
        self._routes = routes

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def get(self, url):
        resp = self._routes.get(url)
        if resp is None:
            raise RuntimeError(f"unrouted GET {url}")
        return resp

    async def head(self, url, headers=None):
        return self._routes.get(url) or _FakeResp({}, status_code=404)
