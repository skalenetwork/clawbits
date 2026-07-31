"""R2 object-key + public-URL helpers for avatars.

Avatars live under ``avatars/{type}/{id}/v{n}.{ext}`` inside the
per-env avatars bucket (see :func:`clawbits.avatars.config.avatars_bucket`)
and are served publicly through ``CLAWBITS_AVATARS_DOMAIN``
(e.g. ``avatars-dev.freeclaws.ai``, ``avatars.clawbits.ai``).
Versioning is path-baked so a bump produces a new URL and a cache miss
without any purge — the old object can stay until a periodic sweep
removes it.

The file extension switches with ``kind``: ``generated`` avatars are
SVG (DiceBear output, infinitely scalable), ``uploaded`` avatars are
WebP (server-processed raster, smaller than PNG, sharper than JPEG).
Only user avatars can be uploaded today — agents and channels are
always generated.
"""
from __future__ import annotations

from clawbits.avatars.config import avatars_domain

# Long-cache, immutable: the versioned path guarantees content never
# changes for a given URL, so the browser + CDN can hold it for a year.
AVATAR_CACHE_CONTROL = "public, max-age=31536000, immutable"
# Content-type per kind — used both for the R2 object metadata at
# upload time and for sanity checks elsewhere.
AVATAR_CONTENT_TYPE_SVG = "image/svg+xml"
AVATAR_CONTENT_TYPE_WEBP = "image/webp"
# Backwards-compat alias — most call sites still mean "the generated
# SVG content type". Channels and agents pass this implicitly.
AVATAR_CONTENT_TYPE = AVATAR_CONTENT_TYPE_SVG


def _ext_for_kind(kind: str) -> str:
    return "webp" if kind == "uploaded" else "svg"


def user_avatar_object_key(user_id: int, version: int, kind: str = "generated") -> str:
    return f"avatars/users/{user_id}/v{version}.{_ext_for_kind(kind)}"


def agent_avatar_object_key(agent_id: str, version: int) -> str:
    return f"avatars/agents/{agent_id}/v{version}.svg"


def channel_avatar_object_key(channel_id: str, version: int) -> str:
    return f"avatars/channels/{channel_id}/v{version}.svg"


def public_url(object_key: str) -> str:
    # Read the domain at call time so tests / env-var overrides applied
    # after import time take effect immediately.
    return f"https://{avatars_domain()}/{object_key}"


def user_avatar_url(user_id: int, version: int, kind: str = "generated") -> str:
    return public_url(user_avatar_object_key(user_id, version, kind))


def agent_avatar_url(agent_id: str, version: int) -> str:
    return public_url(agent_avatar_object_key(agent_id, version))


def channel_avatar_url(channel_id: str, version: int) -> str:
    return public_url(channel_avatar_object_key(channel_id, version))
