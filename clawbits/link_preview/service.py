"""Fetch-parse-cache pipeline for link previews.

A two-tier cache: Redis stores the structured preview (or a small
``status="error"`` marker) keyed by the canonicalised input URL. On a
hit we return immediately; on a miss we run the fetcher + parser, then
write the result back to Redis with a long TTL on success and a short
TTL on failure so a transient outage doesn't poison the cache for a day.

The cache key includes the URL verbatim — URLs that differ only in
query order, trailing slash, or fragment are kept separate by design,
because the OG-bearing page may genuinely differ between them. We do
strip the fragment (it's never sent to the server) before keying.
"""
from __future__ import annotations

import json
import logging
import time
from dataclasses import asdict, dataclass

from redis.asyncio import Redis

from clawbits.link_preview.fetcher import FetchError, fetch_html
from clawbits.link_preview.parser import parse_preview

log = logging.getLogger(__name__)

# Success entries live for a day; the URL is content-versioned in
# practice (sites change their OG tags rarely), so a longer TTL trades
# cache freshness for fewer outbound fetches.
SUCCESS_TTL_S = 24 * 60 * 60
# Failure entries are cached briefly so a retry from another user later
# in the same day will actually try again rather than serving the same
# error message.
ERROR_TTL_S = 5 * 60

_CACHE_PREFIX = "lp:v1:"


@dataclass
class LinkPreview:
    """Public preview payload returned to clients and stored in Redis."""

    url: str
    """The exact URL the caller asked about."""
    canonical_url: str | None
    """``og:url`` or ``<link rel=canonical>`` when present."""
    title: str | None
    description: str | None
    image_url: str | None
    site_name: str | None
    fetched_at: float
    """Unix seconds — lets the client show "fetched X minutes ago" if
    they ever want to surface freshness; not exposed in the UI today."""
    error: str | None = None
    """Set when the fetch failed. The other fields will all be ``None``."""


def _cache_key(url: str) -> str:
    # Drop the fragment — it's a browser-only construct and would just
    # split the cache into per-anchor entries that all resolve to the
    # same HTML.
    head, _, _ = url.partition("#")
    return f"{_CACHE_PREFIX}{head}"


async def get_link_preview(redis: Redis, url: str) -> LinkPreview:
    """Return a preview for ``url``, using Redis as a write-through cache.

    Always returns a :class:`LinkPreview` — failures land as objects
    with ``error`` set and the data fields ``None``, so callers don't
    have to handle exceptions. This also makes the failure-caching
    layer trivial (we just JSON-dump whatever we'd return anyway).
    """
    key = _cache_key(url)
    cached = await _read_cache(redis, key)
    if cached is not None:
        return cached
    preview = await _build_preview(url)
    ttl = SUCCESS_TTL_S if preview.error is None else ERROR_TTL_S
    await _write_cache(redis, key, preview, ttl)
    return preview


async def _build_preview(url: str) -> LinkPreview:
    """Run the fetcher + parser, mapping errors onto an ``error`` field
    instead of bubbling them out — the cache layer relies on this."""
    now = time.time()
    try:
        fetched = await fetch_html(url)
    except FetchError as exc:
        log.info("link-preview fetch failed: url=%s error=%s", url, exc)
        return LinkPreview(
            url=url,
            canonical_url=None,
            title=None,
            description=None,
            image_url=None,
            site_name=None,
            fetched_at=now,
            error=str(exc),
        )
    parsed = parse_preview(fetched.body, fetched.final_url)
    return LinkPreview(
        url=url,
        canonical_url=parsed.canonical or fetched.final_url,
        title=parsed.title,
        description=parsed.description,
        image_url=parsed.image,
        site_name=parsed.site_name,
        fetched_at=now,
    )


async def _read_cache(redis: Redis, key: str) -> LinkPreview | None:
    try:
        raw = await redis.get(key)
    except Exception as exc:
        # Redis down → fall through to a live fetch. We never want a
        # cache outage to break message rendering.
        log.warning("link-preview cache read failed: %s", exc)
        return None
    if raw is None:
        return None
    try:
        return LinkPreview(**json.loads(raw))
    except (json.JSONDecodeError, TypeError) as exc:
        log.warning("link-preview cache parse failed: %s", exc)
        return None


async def _write_cache(
    redis: Redis, key: str, preview: LinkPreview, ttl: int
) -> None:
    try:
        await redis.set(key, json.dumps(asdict(preview)), ex=ttl)
    except Exception as exc:
        log.warning("link-preview cache write failed: %s", exc)
