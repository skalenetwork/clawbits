"""Fetcher tests — uses an in-process httpx mock transport to avoid
real network access. The SSRF / scheme checks don't need the network
at all; the redirect + size cap tests do, and we drive both via the
mock.

The repo doesn't use ``pytest-asyncio``, so each test wraps its async
body with ``asyncio.run``.
"""
from __future__ import annotations

import asyncio
from unittest.mock import patch

import httpx
import pytest

from clawbits.link_preview import fetcher
from clawbits.link_preview.fetcher import (
    MAX_BYTES,
    FetchError,
    fetch_html,
)


def test_rejects_non_http_schemes():
    for url in [
        "file:///etc/passwd",
        "javascript:alert(1)",
        "ftp://example.com/x",
        "data:text/html,<h1>x</h1>",
    ]:
        with pytest.raises(FetchError, match="unsupported scheme"):
            asyncio.run(fetch_html(url))


def test_rejects_missing_host():
    with pytest.raises(FetchError, match="missing host"):
        asyncio.run(fetch_html("http:///path-only"))


def test_rejects_private_address():
    # Bypass DNS by patching getaddrinfo to return a loopback IP, then
    # confirm the SSRF guard fires before we hit the network.
    with patch.object(
        fetcher.socket,
        "getaddrinfo",
        return_value=[(0, 0, 0, "", ("127.0.0.1", 0))],
    ):
        with pytest.raises(FetchError, match="private address"):
            asyncio.run(fetch_html("http://internal.example/"))


def test_rejects_link_local_address():
    with patch.object(
        fetcher.socket,
        "getaddrinfo",
        return_value=[(0, 0, 0, "", ("169.254.169.254", 0))],
    ):
        with pytest.raises(FetchError, match="private address"):
            asyncio.run(fetch_html("http://aws-metadata.example/"))


def test_returns_html_on_happy_path():
    body = "<html><head><title>OK</title></head></html>"

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, content=body.encode(), headers={"content-type": "text/html"}
        )

    transport = httpx.MockTransport(handler)
    with _async_client_with_transport(transport), _allow_public_addresses():
        result = asyncio.run(fetch_html("https://example.com/post"))
    assert result.body == body
    assert result.content_type == "text/html"
    assert result.final_url == "https://example.com/post"


def test_rejects_non_html_content_type():
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            content=b"%PDF-1.4...",
            headers={"content-type": "application/pdf"},
        )

    transport = httpx.MockTransport(handler)
    with _async_client_with_transport(transport), _allow_public_addresses():
        with pytest.raises(FetchError, match="unsupported content-type"):
            asyncio.run(fetch_html("https://example.com/file.pdf"))


def test_propagates_4xx_as_fetch_error():
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, content=b"nope")

    transport = httpx.MockTransport(handler)
    with _async_client_with_transport(transport), _allow_public_addresses():
        with pytest.raises(FetchError, match="HTTP 404"):
            asyncio.run(fetch_html("https://example.com/missing"))


def test_follows_redirect_chain():
    async def handler(request: httpx.Request) -> httpx.Response:
        if str(request.url) == "https://example.com/start":
            return httpx.Response(
                301, headers={"location": "https://example.com/final"}
            )
        return httpx.Response(
            200,
            content=b"<html><head><title>Final</title></head></html>",
            headers={"content-type": "text/html"},
        )

    transport = httpx.MockTransport(handler)
    with _async_client_with_transport(transport), _allow_public_addresses():
        result = asyncio.run(fetch_html("https://example.com/start"))
    assert result.final_url == "https://example.com/final"
    assert "Final" in result.body


def test_stops_after_redirect_cap():
    # Bounce forever; the fetcher must give up at MAX_REDIRECTS + 1.
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(301, headers={"location": "https://example.com/loop"})

    transport = httpx.MockTransport(handler)
    with _async_client_with_transport(transport), _allow_public_addresses():
        with pytest.raises(FetchError, match="too many redirects"):
            asyncio.run(fetch_html("https://example.com/loop"))


def test_size_cap_truncates_oversized_body():
    huge = b"a" * (MAX_BYTES + 100_000)

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, content=huge, headers={"content-type": "text/html"}
        )

    transport = httpx.MockTransport(handler)
    with _async_client_with_transport(transport), _allow_public_addresses():
        result = asyncio.run(fetch_html("https://example.com/big"))
    # Body is ASCII so byte length == char length. The fetcher caps at
    # exactly MAX_BYTES — anything past that should be truncated.
    assert len(result.body.encode("utf-8")) <= MAX_BYTES


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _async_client_with_transport(transport: httpx.MockTransport):
    """Patch httpx.AsyncClient to attach our mock transport. Returns a
    context manager so individual tests can scope the patch."""
    real_client = httpx.AsyncClient

    def factory(*args, **kwargs):
        kwargs["transport"] = transport
        return real_client(*args, **kwargs)

    return patch.object(httpx, "AsyncClient", side_effect=factory)


def _allow_public_addresses():
    """Patch DNS to return a public-looking IP so the SSRF guard doesn't
    reject our mock host."""
    return patch.object(
        fetcher.socket,
        "getaddrinfo",
        return_value=[(0, 0, 0, "", ("93.184.216.34", 0))],
    )
