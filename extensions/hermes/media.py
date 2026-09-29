"""Size-capped media downloads used by the Clawbits adapter."""

from __future__ import annotations

import contextlib
import mimetypes
import os
import tempfile
import urllib.parse
from pathlib import Path

from .pinned_http import fetch

# Cap for image downloads in send_image (URL → temp file → native upload).
# Matches the server's MM_FILES_MAX_BYTES default so anything we pull down
# is also acceptable to the upload route.
_IMAGE_DOWNLOAD_MAX_BYTES = 15 * 1024 * 1024
_ATTACHMENT_DOWNLOAD_MAX_BYTES = _IMAGE_DOWNLOAD_MAX_BYTES
# Whole-download deadlines (connect, redirects, body), not per-read timeouts. Attachment
# downloads hold up chat dispatch, so theirs is shorter (15 MiB in 30 s is about 4 Mbit/s).
_IMAGE_DOWNLOAD_DEADLINE_S = 60.0
_ATTACHMENT_DOWNLOAD_DEADLINE_S = 30.0

# Hosts exempt from the private-address guard, for self-hosted image
# providers that serve from localhost/LAN (a local ComfyUI, a dev MinIO).
# Comma-separated exact hostnames; each hop is matched on its own hostname,
# so a redirect never inherits another host's exemption.
_ALLOW_PRIVATE_HOSTS_ENV = "CLAWBITS_IMAGE_ALLOW_PRIVATE_HOSTS"


def _allowed_private_hosts() -> frozenset[str]:
    """Exact hostnames from ``CLAWBITS_IMAGE_ALLOW_PRIVATE_HOSTS``, lowercased."""
    raw = os.getenv(_ALLOW_PRIVATE_HOSTS_ENV, "")
    return frozenset(h.strip().lower() for h in raw.split(",") if h.strip())


def _download_attachment_bytes(
    url: str,
    *,
    max_bytes: int = _ATTACHMENT_DOWNLOAD_MAX_BYTES,
) -> tuple[bytes, str | None]:
    """Download a server-issued attachment URL with a strict byte cap.

    These URLs come from Clawbits's authenticated file-metadata endpoint and
    are normally short-lived object-store presigns, so the first hop may be
    private (self-hosted Clawbits/MinIO). A redirect off it is not trusted: it
    is vetted like any model-authored URL.
    """
    return fetch(
        url,
        max_bytes=max_bytes,
        timeout=_ATTACHMENT_DOWNLOAD_DEADLINE_S,
        allow_private_hosts=_allowed_private_hosts(),
        trust_first_hop=True,
    )


def _download_to_tempfile(image_url: str) -> tuple[str, str | None]:
    """Fetch a model-authored ``image_url`` into a temp file (size-capped).

    Returns ``(path, content_type)`` — the response's Content-Type rides
    along so the upload route can store the server-reported MIME instead of
    re-guessing from the (possibly extension-less) filename. Blocking —
    callers run it via ``asyncio.to_thread``.
    """
    data, content_type = fetch(
        image_url,
        max_bytes=_IMAGE_DOWNLOAD_MAX_BYTES,
        timeout=_IMAGE_DOWNLOAD_DEADLINE_S,
        allow_private_hosts=_allowed_private_hosts(),
    )
    suffix = Path(urllib.parse.urlsplit(image_url).path).suffix
    if not suffix and content_type:
        suffix = mimetypes.guess_extension(content_type) or ""
    fd, path = tempfile.mkstemp(prefix="clawbits-img-", suffix=suffix or ".bin")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(path)
        raise
    return path, content_type
