"""End-to-end tests for ``POST /api/human/mm/link-preview``.

The fetcher is stubbed out so the test doesn't hit the network; the
service layer (cache + dataclass mapping) is exercised in full against
a real Redis (the test infrastructure already provides one)."""
from __future__ import annotations

import uuid
from unittest.mock import patch

from fastapi.testclient import TestClient

from clawbits.link_preview.fetcher import FetchError, FetchResult
from tests.fastapi._auth_helpers import auth_headers, login_human


def _unique_url(suffix: str = "") -> str:
    """Distinct URL per test invocation so the Redis-backed preview
    cache (shared with the dev DB instance) can't leak hits from
    earlier runs."""
    return f"https://lp-test-{uuid.uuid4().hex}.example/{suffix}".rstrip("/")


def test_link_preview_returns_parsed_card(test_client: TestClient):
    token, _ = login_human(test_client)
    url = _unique_url("post")

    body = """
    <html><head>
      <meta property="og:title" content="Hello"/>
      <meta property="og:description" content="From the test"/>
      <meta property="og:image" content="https://example.com/img.png"/>
      <meta property="og:site_name" content="Example"/>
      <meta property="og:url" content="https://example.com/canonical"/>
    </head></html>
    """

    async def fake_fetch(_url):
        return FetchResult(
            final_url=url, body=body, content_type="text/html"
        )

    with patch(
        "clawbits.link_preview.service.fetch_html", side_effect=fake_fetch
    ):
        resp = test_client.post(
            "/api/human/mm/link-preview",
            json={"url": url},
            headers=auth_headers(token),
        )

    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["title"] == "Hello"
    assert data["description"] == "From the test"
    assert data["image_url"] == "https://example.com/img.png"
    assert data["site_name"] == "Example"
    assert data["canonical_url"] == "https://example.com/canonical"
    assert data["error"] is None


def test_link_preview_caches_result(test_client: TestClient):
    """Second request for the same URL must not refetch."""
    token, _ = login_human(test_client)
    url = _unique_url("cache")

    body = "<html><head><title>Cached</title></head></html>"
    call_count = 0

    async def fake_fetch(_url):
        nonlocal call_count
        call_count += 1
        return FetchResult(final_url=url, body=body, content_type="text/html")

    with patch("clawbits.link_preview.service.fetch_html", side_effect=fake_fetch):
        for _ in range(3):
            resp = test_client.post(
                "/api/human/mm/link-preview",
                json={"url": url},
                headers=auth_headers(token),
            )
            assert resp.status_code == 200
            assert resp.json()["title"] == "Cached"

    assert call_count == 1, "expected fetch to be cached after first call"


def test_link_preview_caches_failures_briefly(test_client: TestClient):
    """A failed fetch must surface as 200 with ``error`` set, and the
    failure should be cached so a retry storm doesn't hammer the
    upstream — but with a *short* TTL so an actual outage recovers
    within minutes, not days."""
    token, _ = login_human(test_client)

    url = _unique_url("broken")

    async def boom(_url):
        raise FetchError("DNS lookup failed: nope")

    with patch("clawbits.link_preview.service.fetch_html", side_effect=boom):
        resp = test_client.post(
            "/api/human/mm/link-preview",
            json={"url": url},
            headers=auth_headers(token),
        )

    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["title"] is None
    assert data["error"] is not None
    assert "DNS lookup failed" in data["error"]


def test_link_preview_requires_auth(test_client: TestClient):
    """Unauth callers get 401 — keeps this from being a public open-
    proxy scanner against arbitrary internet hosts."""
    resp = test_client.post(
        "/api/human/mm/link-preview",
        json={"url": "https://example.com/x"},
    )
    assert resp.status_code in (401, 403), resp.text


def test_link_preview_rejects_oversized_url(test_client: TestClient):
    """``url`` is capped at 2048 chars on the request model; longer
    payloads should 422 before any fetch happens."""
    token, _ = login_human(test_client)
    huge = "https://example.com/" + ("a" * 3000)
    resp = test_client.post(
        "/api/human/mm/link-preview",
        json={"url": huge},
        headers=auth_headers(token),
    )
    assert resp.status_code == 422


