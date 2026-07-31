"""Image download with SSRF guarding, for native image delivery.

The adapter's ``send_image`` pulls agent-influenced URLs onto disk before
uploading them as native attachments; everything security-relevant about that
fetch lives here: the private-address guard, its redirect re-check, and the
size-capped download itself.
"""

from __future__ import annotations

import contextlib
import mimetypes
import os
import re
import tempfile
import urllib.parse
import urllib.request
from pathlib import Path

# Cap for image downloads in send_image (URL → temp file → native upload).
# Matches the server's MM_FILES_MAX_BYTES default so anything we pull down
# is also acceptable to the upload route.
_IMAGE_DOWNLOAD_MAX_BYTES = 15 * 1024 * 1024

# Hosts exempt from the private-address guard below, for self-hosted image
# providers that serve from localhost/LAN (a local ComfyUI, a dev MinIO).
# Comma-separated hostnames; mirrors IronClaw's
# IRONCLAW_ALLOW_INSECURE_HTTP_HOSTS escape-hatch pattern.
_ALLOW_PRIVATE_HOSTS_ENV = "CLAWBITS_IMAGE_ALLOW_PRIVATE_HOSTS"


def _reject_private_host(url: str) -> None:
    """Raise ``ValueError`` when ``url`` points at a private/internal address.

    SSRF guard for agent-influenced image URLs: without it, send_image would
    happily fetch cloud metadata endpoints (169.254.169.254), localhost admin
    ports, or LAN hosts — and upload the response bytes into the channel.
    Hostnames are resolved and *every* returned address must be public;
    literal IPs are checked directly. Hosts listed in
    ``CLAWBITS_IMAGE_ALLOW_PRIVATE_HOSTS`` are exempt.
    """
    import ipaddress
    import socket

    host = urllib.parse.urlsplit(url).hostname
    if not host:
        raise ValueError(f"no host in image URL: {url!r}")
    allowed = {
        h.strip().lower()
        for h in os.getenv(_ALLOW_PRIVATE_HOSTS_ENV, "").split(",")
        if h.strip()
    }
    if host.lower() in allowed:
        return
    try:
        literal = ipaddress.ip_address(host)
        addresses = [literal]
    except ValueError:
        try:
            infos = socket.getaddrinfo(host, None, proto=socket.IPPROTO_TCP)
        except OSError as e:
            raise ValueError(f"cannot resolve image host {host!r}: {e}") from e
        addresses = [ipaddress.ip_address(info[4][0]) for info in infos]
    for addr in addresses:
        if (
            addr.is_private
            or addr.is_loopback
            or addr.is_link_local
            or addr.is_reserved
            or addr.is_multicast
            or addr.is_unspecified
        ):
            raise ValueError(
                f"image host {host!r} resolves to non-public address {addr}; "
                f"set {_ALLOW_PRIVATE_HOSTS_ENV} to allow it"
            )


class _PrivateHostRejectingRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Re-run the private-address guard on every redirect hop.

    A public URL 302ing to an internal address is the classic SSRF bypass;
    stdlib urllib otherwise follows it silently.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        _reject_private_host(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _download_to_tempfile(image_url: str) -> tuple[str, str | None]:
    """Fetch ``image_url`` into a temp file (size-capped).

    Returns ``(path, content_type)`` — the response's Content-Type rides
    along so the upload route can store the server-reported MIME instead of
    re-guessing from the (possibly extension-less) filename. Blocking
    (stdlib urllib) — callers run it via ``asyncio.to_thread``. The suffix
    is preserved from the URL (or derived from Content-Type) so the stored
    filename stays sensible.
    """
    if not re.match(r"^https?://", image_url, re.IGNORECASE):
        raise ValueError(f"not an http(s) URL: {image_url!r}")
    _reject_private_host(image_url)
    opener = urllib.request.build_opener(_PrivateHostRejectingRedirectHandler())
    req = urllib.request.Request(image_url, headers={"User-Agent": "clawbits-hermes-plugin"})
    with opener.open(req, timeout=30) as resp:
        content_type = (resp.headers.get("Content-Type") or "").split(";")[0].strip()
        suffix = Path(image_url.split("?", 1)[0]).suffix
        if not suffix and content_type:
            suffix = mimetypes.guess_extension(content_type) or ""
        data = resp.read(_IMAGE_DOWNLOAD_MAX_BYTES + 1)
        if len(data) > _IMAGE_DOWNLOAD_MAX_BYTES:
            raise ValueError(
                f"image exceeds {_IMAGE_DOWNLOAD_MAX_BYTES} bytes: {image_url!r}"
            )
    fd, path = tempfile.mkstemp(prefix="clawbits-img-", suffix=suffix or ".bin")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(path)
        raise
    return path, content_type or None
