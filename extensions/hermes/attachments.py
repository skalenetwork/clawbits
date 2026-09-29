"""Inbound Clawbits chat attachment caching."""

from __future__ import annotations

import logging
from typing import Any

from .media import _ATTACHMENT_DOWNLOAD_MAX_BYTES, _download_attachment_bytes
from .messages import _extract_files

logger = logging.getLogger(__name__)


def _cache_bytes(data: bytes, filename: str, content_type: str) -> tuple[str, str, str] | None:
    # Runtime-only import: gateway media caching is supplied by Hermes, not by
    # the standalone plugin test environment.
    from gateway.platforms.base import cache_media_bytes

    cached = cache_media_bytes(data, filename=filename, mime_type=content_type)
    if cached is None:
        return None
    return cached.path, cached.media_type, cached.context_note()


def cache_post_attachments(client: Any, post: dict[str, Any]) -> tuple[list[str], list[str], list[str]]:
    """Fetch authenticated Clawbits files and cache them for MessageEvent."""
    paths: list[str] = []
    types: list[str] = []
    notes: list[str] = []
    for file in _extract_files(post):
        try:
            if file.size_bytes > _ATTACHMENT_DOWNLOAD_MAX_BYTES:
                raise ValueError(f"attachment exceeds {_ATTACHMENT_DOWNLOAD_MAX_BYTES} bytes")
            last_error: Exception | None = None
            payload: bytes | None = None
            fetched_type: str | None = None
            if file.download_url:
                try:
                    payload, fetched_type = _download_attachment_bytes(file.download_url)
                except Exception as exc:
                    last_error = exc
            if payload is None:
                try:
                    fresh = client.file_url(file.file_id)
                    if fresh and fresh != file.download_url:
                        payload, fetched_type = _download_attachment_bytes(fresh)
                except Exception as exc:
                    last_error = exc
            if payload is None:
                raise last_error or RuntimeError("attachment has no download URL")
            cached = _cache_bytes(
                payload,
                file.filename,
                file.content_type or fetched_type or "application/octet-stream",
            )
            if cached is None:
                raise ValueError("Hermes rejected attachment bytes")
            path, media_type, note = cached
            paths.append(path)
            types.append(media_type)
            notes.append(note)
        except Exception:
            logger.warning(
                "clawbits: failed to cache attachment %s (%s)",
                file.file_id,
                file.filename,
                exc_info=True,
            )
            notes.append(f"[attachment '{file.filename}' could not be downloaded]")
    return paths, types, notes
