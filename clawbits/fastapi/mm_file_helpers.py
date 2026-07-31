"""Helpers for the chat-attachments endpoints (humans + agents).

Pure-function utilities that don't touch the DB or HTTP — config loading,
key generation, filename sanitization, MIME validation, and response
building. Factored out of ``human_mm_endpoints.py`` so agent endpoints
can reuse them when we mirror the surface in a follow-up.
"""
from __future__ import annotations

import datetime as _dt
import io
import logging
import os
import re
import time as _time
import unicodedata
import uuid
from dataclasses import dataclass

import httpx

from clawbits.cloudflare.r2_presign import R2Presigner
from clawbits.datastructures.mm_models import MmFileResponse
from clawbits.db.models import MmFile
from clawbits.utils.parse import format_db_timestamp

_logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Presigned-URL cache
# ---------------------------------------------------------------------------
#
# Files are immutable after ``/confirm`` — only their presigned URL needs
# to be refreshed when the previous one approaches its TTL. The post-list
# safety-net poll fires periodically (30s in this build); without this
# cache we'd sign O(files_in_view) fresh URLs per poll and the response
# body would churn on every request (different signature = different
# bytes, defeating the ETag/304 short-circuit). Process-local in-memory
# dict is fine: a multi-worker setup just signs once per worker per
# file, which is still vastly better than per-request.
#
# Eviction: lazy, on lookup. Entries are dropped when ``expires_at``
# minus a safety buffer is in the past. We don't bound the cache size —
# in practice it's bounded by the active channel set × posts × files,
# and each entry is ~200 bytes. Revisit if memory becomes a concern.

_URL_CACHE_BUFFER_SECONDS = 60  # don't hand out a URL within 60s of expiry
_url_cache: dict[str, tuple[str, float]] = {}  # cache_key -> (url, expires_at)


def cached_presigned_get(
    presigner: R2Presigner,
    *,
    cache_key: str,
    object_key: str,
    ttl: int,
    download_filename: str | None = None,
) -> tuple[str, int]:
    """Return ``(url, expires_at)`` for a presigned GET, reusing the cached
    one when possible.

    ``cache_key`` should uniquely identify what's being signed — e.g.
    ``f"{file_id}:original"`` for the full image, ``f"{file_id}:thumb"``
    for the 1024px thumbnail. The function signs lazily and caches the
    URL until ``ttl - 60s`` so the response body stays stable across
    the post-list polls (and SSE-driven refetches), which is what lets
    the ETag/304 short-circuit fire.

    ``expires_at`` is the absolute unix-epoch second when the URL stops
    being valid on R2. Callers propagate this to the client so a URL
    that was already cached for most of its TTL is treated as
    short-lived rather than "freshly issued."
    """
    now = _time.time()
    cached = _url_cache.get(cache_key)
    if cached is not None and cached[1] > now + _URL_CACHE_BUFFER_SECONDS:
        return cached[0], int(cached[1])
    out = presigner.presign_get(
        object_key, expires=ttl, download_filename=download_filename
    )
    url = out["url"]
    expires_at = now + ttl
    _url_cache[cache_key] = (url, expires_at)
    return url, int(expires_at)


def clear_presigned_url_cache() -> None:
    """Wipe the cache. Exposed for tests; production has no caller."""
    _url_cache.clear()


# ---------------------------------------------------------------------------
# Image-dimension probe
# ---------------------------------------------------------------------------
#
# Fallback path for the rare case where the client's confirm payload
# doesn't carry width/height (Canvas decode failed, headless environment,
# truncated file, etc.). The frontend uses these dimensions as the
# message-row's reserved aspect ratio — missing them produces a 0px-tall
# image slot that resizes on byte arrival, which is the layout shift the
# whole chat-scroll rewrite is trying to eliminate.
#
# The probe fetches just the first ~64 KB via a Range GET. Every common
# image format embeds its dimensions in the first few KB of the header
# (JPEG SOF marker, PNG IHDR, GIF logical-screen, WebP VP8/VP8L/VP8X),
# so this is enough for Pillow to read them without downloading the
# full image bytes. 64KB covers progressive JPEGs and large EXIF blobs.

_PROBE_RANGE_BYTES = 65535


async def probe_image_dimensions(
    presigner: R2Presigner,
    object_key: str,
) -> tuple[int, int] | None:
    """Read width/height from an R2 image without downloading the full file.

    Returns ``(width, height)`` on success, ``None`` on any failure
    (network error, non-image bytes, unreadable header). Designed to be
    safe to call as a best-effort fallback — never raises.
    """
    try:
        # 60s expires is more than enough; we're calling it immediately.
        # Don't go through ``cached_presigned_get`` — this URL is for one
        # request, not the long-lived browser cache.
        out = presigner.presign_get(object_key, expires=60)
        url = out["url"]
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(
                url,
                headers={"Range": f"bytes=0-{_PROBE_RANGE_BYTES}"},
            )
            # R2 returns 206 (Partial Content) for a valid Range request,
            # 200 if it ignores the range (rare). Both are usable.
            if resp.status_code not in (200, 206):
                _logger.warning(
                    "probe_image_dimensions: unexpected status %d for %s",
                    resp.status_code,
                    object_key,
                )
                return None
            data = resp.content
    except Exception as e:
        _logger.warning("probe_image_dimensions: fetch failed for %s: %s", object_key, e)
        return None

    # Import lazily — Pillow is heavy and only this probe path needs it
    # in this module. Other Pillow users (avatars, thumbnails) import
    # directly in their own modules.
    try:
        from PIL import Image  # noqa: PLC0415

        with Image.open(io.BytesIO(data)) as im:
            # ``size`` is (width, height); read before exiting the context
            # manager so the image object's data is still accessible.
            w, h = im.size
            if w <= 0 or h <= 0:
                return None
            return int(w), int(h)
    except Exception as e:
        _logger.warning("probe_image_dimensions: decode failed for %s: %s", object_key, e)
        return None


# Longest-side cap for server-generated thumbnails — matches the client's
# 1024px tier (frontend/src/lib/imageThumbnail.ts) and the
# ``thumb-1024.jpg`` object-key naming in :func:`build_object_key`.
_THUMBNAIL_MAX_PX = 1024


def decode_image_and_thumbnail(
    data: bytes, max_px: int = _THUMBNAIL_MAX_PX
) -> tuple[int, int, bytes | None] | None:
    """Decode image bytes once, returning ``(width, height, thumb_jpeg | None)``.

    Used by the *direct* upload route, where the server holds the full
    bytes anyway — one Pillow decode yields the dimensions the frontend
    needs to reserve the aspect-ratio box, plus a 1024px JPEG thumbnail
    when the image exceeds ``max_px`` on its longest side (smaller images
    don't need one; ``ImageThumb`` falls back to ``download_url``).

    Returns ``None`` when the bytes don't decode as an image. **Blocking
    (CPU-bound Pillow work) — async callers must wrap in
    ``asyncio.to_thread``**; never call it bare from a coroutine.
    """
    try:
        from PIL import Image, ImageOps  # noqa: PLC0415 — heavy, probe-path only

        with Image.open(io.BytesIO(data)) as im:
            # Bake in EXIF orientation so dimensions and thumbnail match
            # what a browser renders (same normalization the avatar
            # upload path applies).
            im = ImageOps.exif_transpose(im)
            w, h = im.size
            if w <= 0 or h <= 0:
                return None
            thumb: bytes | None = None
            if max(w, h) > max_px:
                im.thumbnail((max_px, max_px))
                if im.mode not in ("RGB", "L"):
                    # JPEG has no alpha. A bare convert("RGB") composites
                    # transparency onto black; flatten onto white instead so
                    # transparent PNG/WebP thumbs read naturally in the UI.
                    rgba = im.convert("RGBA")
                    background = Image.new("RGB", rgba.size, (255, 255, 255))
                    background.paste(rgba, mask=rgba.getchannel("A"))
                    im = background
                buf = io.BytesIO()
                im.save(buf, format="JPEG", quality=85)
                thumb = buf.getvalue()
            return int(w), int(h), thumb
    except Exception as e:
        _logger.warning("decode_image_and_thumbnail: decode failed: %s", e)
        return None


@dataclass(frozen=True)
class MmFileConfig:
    """Resolved limits/policy for chat attachments.

    Constructed at request time from env vars; safe defaults match what's
    in ``.env.example`` so unset envs still produce a working surface.
    """
    max_bytes: int
    max_per_post: int
    mime_allowlist: tuple[str, ...]
    download_url_ttl: int
    # Longer-lived presigned GET for video/audio: playback can outlast a
    # 1h URL (a long recording, or open → pause → resume later), and the
    # ``<video>`` element keeps the *original* signed URL it was given — a
    # mid-playback expiry 403s with no recovery beyond a re-fetch. Sign
    # media URLs for a span comfortably longer than any plausible watch.
    media_download_url_ttl: int


def load_file_config() -> MmFileConfig:
    raw_allowlist = os.getenv(
        "MM_FILES_MIME_ALLOWLIST",
        "image/*,video/*,audio/*,application/pdf,text/*,application/zip",
    )
    return MmFileConfig(
        max_bytes=int(os.getenv("MM_FILES_MAX_BYTES", str(15 * 1024 * 1024))),
        max_per_post=int(os.getenv("MM_FILES_MAX_PER_POST", "5")),
        mime_allowlist=tuple(
            p.strip() for p in raw_allowlist.split(",") if p.strip()
        ),
        download_url_ttl=int(os.getenv("MM_FILES_DOWNLOAD_URL_TTL", "3600")),
        media_download_url_ttl=int(
            os.getenv("MM_FILES_MEDIA_DOWNLOAD_URL_TTL", str(6 * 3600)),
        ),
    )


def is_mime_allowed(content_type: str, allowlist: tuple[str, ...]) -> bool:
    """Match ``content_type`` against the allowlist.

    Entries ending in ``/*`` match by prefix (e.g. ``image/*`` matches
    ``image/png``). Other entries match exactly.
    """
    ct = content_type.lower().strip()
    for pattern in allowlist:
        p = pattern.lower().strip()
        if p.endswith("/*"):
            if ct.startswith(p[:-1]):  # keep the trailing slash
                return True
        elif ct == p:
            return True
    return False


_UNSAFE_FILENAME_CHARS = re.compile(r"[^A-Za-z0-9._-]")


def safe_filename(filename: str) -> str:
    """Normalize a user-supplied filename for use in an R2 key.

    Strips path components, NFKD-normalizes to ASCII-ish, replaces unsafe
    chars with ``_``, and caps length at 200 chars. Always returns a
    non-empty string — if the input sanitizes to empty we fall back to
    ``"file"``.
    """
    # Strip directory components — never trust the client.
    name = filename.split("/")[-1].split("\\")[-1]
    # ASCII-ish fold so non-Latin scripts don't crash the R2 key codec.
    name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    name = _UNSAFE_FILENAME_CHARS.sub("_", name).strip("._")
    if not name:
        name = "file"
    return name[:200]


def build_object_key(file_id: str, filename: str, *, thumbnail: bool = False) -> str:
    """Deterministic R2 key for a file or its thumbnail.

    Layout: ``mm/files/{yyyy}/{mm}/{file_id}/original/{safe_filename}`` for
    the original, ``mm/files/{yyyy}/{mm}/{file_id}/thumb-1024.jpg`` for the
    thumbnail. The ``{file_id}`` segment is a uuid, so a leaked partial key
    can't enumerate other files.
    """
    now = _dt.datetime.now(_dt.UTC)
    prefix = f"mm/files/{now:%Y/%m}/{file_id}"
    if thumbnail:
        return f"{prefix}/thumb-1024.jpg"
    return f"{prefix}/original/{safe_filename(filename)}"


def new_file_id() -> str:
    return uuid.uuid4().hex


def enrich_post_files_with_urls(
    post_dict: dict,
    presigner: R2Presigner | None,
    *,
    ttl: int,
) -> None:
    """In-place enrichment of a post's ``files`` list with presigned URLs.

    Each file dict in ``post_dict["files"]`` carries ``_object_key`` and
    ``_thumbnail_object_key`` from the DB layer. For images we presign a
    GET URL (so ``<img src>`` works without a round trip); the underscore
    keys are silently dropped by Pydantic when the dict is turned into
    :class:`MmFileResponse`.

    Skip the work when no presigner is configured — clients will still
    get the metadata, just no download URLs (they can request via
    ``/files/{id}/url`` later).
    """
    if presigner is None:
        return
    files = post_dict.get("files") or []
    for f in files:
        ct = (f.get("content_type") or "").lower()
        is_image = ct.startswith("image/")
        file_id = f.get("file_id")
        # Eagerly inline the full download URL only for images (``<img src>``
        # needs it without a round trip). Other types resolve on demand.
        if is_image:
            obj_key = f.get("_object_key")
            if obj_key and file_id:
                url, expires_at = cached_presigned_get(
                    presigner,
                    cache_key=f"{file_id}:original",
                    object_key=obj_key,
                    ttl=ttl,
                    download_filename=f.get("filename"),
                )
                f["download_url"] = url
                f["download_url_expires_at"] = expires_at
        # Thumbnail/poster: present for images *and* videos (the composer
        # captures a client-side poster frame for video). Surface it for any
        # file that has one so video tiles render a real frame, not a blank.
        thumb_key = f.get("_thumbnail_object_key")
        if thumb_key and file_id:
            url, expires_at = cached_presigned_get(
                presigner,
                cache_key=f"{file_id}:thumb",
                object_key=thumb_key,
                ttl=ttl,
            )
            f["thumbnail_url"] = url
            f["thumbnail_url_expires_at"] = expires_at


def build_file_response(
    f: MmFile,
    presigner: R2Presigner | None,
    *,
    ttl: int,
    inline_url_for_images: bool = True,
) -> MmFileResponse:
    """Build the public response model for a single file row.

    For image files (``content_type`` starts ``image/``) we *eagerly*
    presign a download URL and bundle it in the response — this is what
    makes ``<img src>`` work without a second round trip per image. For
    non-image files we leave ``download_url`` null and the client fetches
    it on demand via ``/files/{id}/url``. Set
    ``inline_url_for_images=False`` to suppress the eager URL (used by the
    upload-confirm response, where there's no point in pre-signing).
    """
    download_url: str | None = None
    download_url_expires_at: int | None = None
    thumbnail_url: str | None = None
    thumbnail_url_expires_at: int | None = None
    is_image = f.content_type.lower().startswith("image/")
    if presigner is not None and inline_url_for_images:
        # Eager full download URL only for images (``<img src>``). The
        # poster/thumbnail is surfaced for any file that has one — including
        # videos — so the Media grid renders a real frame instead of a blank
        # tile with a play glyph.
        if is_image:
            download_url, download_url_expires_at = cached_presigned_get(
                presigner,
                cache_key=f"{f.file_id}:original",
                object_key=f.object_key,
                ttl=ttl,
                download_filename=f.filename,
            )
        if f.thumbnail_object_key:
            thumbnail_url, thumbnail_url_expires_at = cached_presigned_get(
                presigner,
                cache_key=f"{f.file_id}:thumb",
                object_key=f.thumbnail_object_key,
                ttl=ttl,
            )
    return MmFileResponse(
        file_id=f.file_id,
        channel_id=f.channel_id,
        filename=f.filename,
        content_type=f.content_type,
        size_bytes=f.size_bytes,
        status=f.status,
        width=f.width,
        height=f.height,
        duration_ms=f.duration_ms,
        created_at=format_db_timestamp(f.created_at),
        uploaded_at=format_db_timestamp(f.uploaded_at) if f.uploaded_at else None,
        download_url=download_url,
        download_url_expires_at=download_url_expires_at,
        thumbnail_url=thumbnail_url,
        thumbnail_url_expires_at=thumbnail_url_expires_at,
        uploader_human_id=f.uploader_human_id,
        uploader_agent_id=f.uploader_agent_id,
        post_id=f.post_id,
    )
