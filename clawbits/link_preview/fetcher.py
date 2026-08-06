"""Safe, bounded HTTP fetcher for link previews.

Constraints enforced here:

* **Scheme allowlist**: ``http`` / ``https`` only. ``file://``,
  ``javascript:``, ``data:`` etc. are rejected before we touch the
  network so a malicious link in a chat can't probe the local
  filesystem or trigger a redirect to a different scheme.
* **Private IP block**: rejects hosts that resolve to RFC1918 / loopback
  / link-local addresses so a chat link can't be used as a metadata
  endpoint scanner (SSRF). Matches Slack / Discord behavior.
* **Size cap**: body capped at ``MAX_BYTES`` — read incrementally and
  abort as soon as the cap trips. Without this a single message could
  download a 5GB stream.
* **Redirect cap**: at most ``MAX_REDIRECTS`` hops; same scheme checks
  applied to each redirect target.
* **Timeout**: full request budget capped at ``TIMEOUT_S`` seconds.
* **MIME allowlist**: only ``text/html`` (with optional charset). A page
  serving ``application/pdf`` is happy-path skipped — no preview is
  better than a corrupted parse.

The fetcher returns the decoded ``str`` body plus the final URL after
redirects (so the parser can resolve relative ``og:image`` paths against
the *real* host, not the one the user typed). On any failure it raises
:class:`FetchError` with a human-readable reason.
"""
from __future__ import annotations

from dataclasses import dataclass

import httpx

from clawbits.ssrf import UnsafeHostError, check_host_is_public, dialed_host

# Tuned for "fast enough that a chat message paints, large enough to
# capture realistic OG-bearing pages":
TIMEOUT_S = 8.0
MAX_BYTES = 1_500_000  # ~1.5 MB — covers every well-behaved OG page
MAX_REDIRECTS = 4
USER_AGENT = "ClawbitsLinkPreviewBot/1.0 (+https://clawbits.ai)"
ALLOWED_SCHEMES = ("http", "https")


class FetchError(Exception):
    """Raised when a URL can't be safely or successfully fetched."""


@dataclass
class FetchResult:
    """Outcome of a successful fetch."""

    final_url: str
    """URL after redirects. Resolves relative OG paths in the parser."""
    body: str
    """Decoded HTML body, ≤ ``MAX_BYTES``."""
    content_type: str
    """``Content-Type`` minus the charset suffix (e.g., ``text/html``)."""


def _validate_url(url: str) -> str:
    """Reject non-HTTP schemes early so we never even try the DNS lookup."""
    parsed = httpx.URL(url)
    if parsed.scheme not in ALLOWED_SCHEMES:
        raise FetchError(f"unsupported scheme: {parsed.scheme or '(none)'}")
    if not parsed.host:
        raise FetchError("missing host")
    return str(parsed)


def _check_not_private(host: str) -> None:
    """SSRF guard: refuse to fetch URLs whose host resolves to a private,
    loopback, or link-local address. The rule itself lives in
    :mod:`clawbits.ssrf` so the LobsterTalk LLM endpoint enforces the same
    one; this only maps its errors onto the fetcher's ``FetchError``.
    """
    try:
        check_host_is_public(host)
    except UnsafeHostError as exc:
        raise FetchError(str(exc)) from exc


async def fetch_html(url: str) -> FetchResult:
    """Fetch ``url`` and return its HTML body, or raise ``FetchError``.

    Performs URL validation, SSRF check, content-type allowlist, and
    bounded streaming read. Each redirect is re-validated; cookies are
    not persisted across hops to avoid login-aware behavior changing
    based on prior unfurls.
    """
    current = _validate_url(url)
    # Manual redirect handling so we can re-check schemes + hosts after
    # each hop. ``follow_redirects=False`` keeps httpx out of our way.
    async with httpx.AsyncClient(
        timeout=TIMEOUT_S,
        follow_redirects=False,
        headers={
            "User-Agent": USER_AGENT,
            # Some sites serve a stripped page (or 403) when there's no
            # Accept header; advertising what we want gets us the OG-
            # bearing version more often.
            "Accept": (
                "text/html,application/xhtml+xml,"
                "application/xml;q=0.9,*/*;q=0.8"
            ),
            "Accept-Language": "en-US,en;q=0.9",
        },
    ) as client:
        for _hop in range(MAX_REDIRECTS + 1):
            parsed = httpx.URL(current)
            # ``dialed_host``, not ``parsed.host`` — see its docstring: for an
            # internationalised name the two differ, and checking the one we
            # don't dial vets the wrong host.
            _check_not_private(dialed_host(parsed))
            try:
                async with client.stream("GET", current) as resp:
                    if resp.is_redirect:
                        location = resp.headers.get("location")
                        if not location:
                            raise FetchError("redirect with no Location header")
                        # ``urljoin``-style: relative redirects resolve
                        # against the previous request URL.
                        current = str(httpx.URL(current).join(location))
                        _validate_url(current)
                        continue
                    if resp.status_code >= 400:
                        raise FetchError(f"HTTP {resp.status_code}")
                    ct_full = resp.headers.get("content-type", "")
                    ct = ct_full.split(";", 1)[0].strip().lower()
                    if ct and ct not in ("text/html", "application/xhtml+xml"):
                        raise FetchError(f"unsupported content-type: {ct}")
                    # Stream-read with a hard byte cap. Read raw bytes
                    # in fixed-size chunks so a single huge response
                    # can't blow past the cap in one go (the mock
                    # transport in tests, and some real servers, return
                    # the whole body as one chunk to ``aiter_text``).
                    chunks: list[bytes] = []
                    total = 0
                    async for chunk in resp.aiter_bytes(chunk_size=32_768):
                        remaining = MAX_BYTES - total
                        if remaining <= 0:
                            break
                        if len(chunk) > remaining:
                            chunks.append(chunk[:remaining])
                            total = MAX_BYTES
                            break
                        chunks.append(chunk)
                        total += len(chunk)
                    # Decode using the response's detected charset
                    # (httpx falls back to utf-8 if Content-Type doesn't
                    # carry one). errors="replace" so a truncated
                    # multi-byte sequence at the cap boundary doesn't
                    # explode.
                    body_bytes = b"".join(chunks)
                    charset = resp.charset_encoding or "utf-8"
                    body = body_bytes.decode(charset, errors="replace")
                    return FetchResult(
                        final_url=current,
                        body=body,
                        content_type=ct or "text/html",
                    )
            except httpx.HTTPError as exc:
                raise FetchError(f"network error: {exc}") from exc
    raise FetchError(f"too many redirects (> {MAX_REDIRECTS})")
