"""High-level avatar lifecycle: build SVG bytes + ensure they're in R2.

Avatars are fetched from the DiceBear HTTP API (``DICEBEAR_BASE`` — a
self-hosted ``dicebear/api`` sidecar in each env, falling back to the
public https://api.dicebear.com) per a per-entity-type style choice and
then cached forever in our R2. Users get the ``glass`` style (frosted-blur
gradient blobs), agents get ``bottts-neutral`` (legibly "AI" robots),
channels get ``shapes`` (Bauhaus geometric). Each entity's R2 URL is
versioned so a style change is a single ``avatar_version`` bump — old
SVGs stay until a sweep removes them.

End users never hit DiceBear directly: every fetch flows through this
module once, lands in R2, and is served from our custom domain
thereafter. The dependency on dicebear.com is bounded to backfills +
new-entity creation and is recoverable (R2 is the source of truth).

Uploaded avatars short-circuit the DiceBear fetch — the bytes came
from the user's PUT and the row's ``avatar_kind`` is ``"uploaded"``.

R2 uploads use the dedicated avatars :class:`R2S3Client` (S3 API;
see :mod:`clawbits.avatars.config`). Callers that live inside a sync
DB transaction should defer the upload until after ``session.commit()``
— failing the upload should never roll back the entity insert.
"""
from __future__ import annotations

import enum
import logging
import os

import httpx

from clawbits.avatars import icons
from clawbits.avatars.compose import compose_stitched_glass, compose_with_icon
from clawbits.avatars.storage import (
    AVATAR_CACHE_CONTROL,
    AVATAR_CONTENT_TYPE,
    agent_avatar_object_key,
    agent_avatar_url,
    channel_avatar_object_key,
    channel_avatar_url,
    user_avatar_object_key,
    user_avatar_url,
)
from clawbits.cloudflare.r2_s3_client import R2S3Client

logger = logging.getLogger(__name__)

# DiceBear style per entity type — see https://www.dicebear.com/styles/.
# Humans and channels both ride on the ``glass`` style (frosted blur
# blobs) and are differentiated by a centered overlay icon (user / hash
# / lock), composed server-side before the SVG is uploaded to R2. Agents
# get ``bottts-neutral`` because the robot face is already a strong "AI"
# signal — no overlay needed.
# Base URL for the DiceBear HTTP API. Defaults to the public API (v10, the
# current latest) but is overridden per-env to a self-hosted sidecar
# (``dicebear/api`` container) so avatar generation never depends on a third
# party — set ``DICEBEAR_BASE`` (e.g. ``http://dicebear:3000/10.x`` in-cluster,
# ``http://localhost:3000/10.x`` for the host dev server). The path version
# MUST match the styles the sidecar serves (the stock image serves 10.x).
DICEBEAR_BASE = os.getenv("DICEBEAR_BASE", "https://api.dicebear.com/10.x")
USER_STYLE = "glass"
AGENT_STYLE = "bottts-neutral"
CHANNEL_STYLE = "glass"
# 200 keeps the SVG payload tight (~1-3KB) while leaving DiceBear
# headroom to position internal elements without aliasing.
DICEBEAR_SIZE = 200
# Single shared httpx client — keepalive on the api.dicebear.com host
# pays off during the backfill (one connection across 50+ requests).
# Re-used across ensure_* calls in the same process.
_HTTP_TIMEOUT = httpx.Timeout(15.0, connect=5.0)

# Five curated background palettes for the channel ``glass`` style.
# DiceBear's default backgroundColor list is short and tends to repeat
# the same blue + orange combo across channels; passing our own list
# (and rotating by channel-id hash) gives the sidebar real visual
# variety. We only specify ``backgroundColor`` for glass — the inner
# letter blobs come from DiceBear's algorithm and are blended over the
# bg via mix-blend-mode, so we don't try to control them.
#
# Each palette is a LIST of hex values (not a comma string): httpx sends
# a list as repeated ``backgroundColor=`` params, which DiceBear parses as
# an array and picks one per seed. The self-hosted (Fastify) API rejects
# the ``%2C``-encoded comma-string form with a 400 — only the public API
# was lenient about it — so the array form is the portable one.
CHANNEL_PALETTES: tuple[dict[str, list[str]], ...] = (
    # 0 — Coral sunset (warm, soft pink-amber)
    {"backgroundColor": ["ff6b6b", "ffa94d", "ffd166"]},
    # 1 — Pacific (saturated blues + teal)
    {"backgroundColor": ["0ea5e9", "06b6d4", "2563eb"]},
    # 2 — Moss (deep green + lime accents)
    {"backgroundColor": ["059669", "10b981", "84cc16"]},
    # 3 — Plum (purple + rose, premium feel)
    {"backgroundColor": ["7c3aed", "c026d3", "db2777"]},
    # 4 — Cement (architectural neutrals, Linear-like)
    {"backgroundColor": ["374151", "52525b", "71717a"]},
)


def _pick_channel_palette(channel_id: str) -> dict[str, list[str]]:
    """Pick one of :data:`CHANNEL_PALETTES` deterministically by channel id.

    SHA-256 mod len gives uniform distribution and is stable across
    Python versions (unlike ``hash()``). Same channel → same palette
    forever, so the version-bump path (re-fetch on visual change) is
    the only thing that can shuffle the look.
    """
    import hashlib
    digest = hashlib.sha256(channel_id.encode("utf-8")).digest()
    idx = int.from_bytes(digest[:4], "big") % len(CHANNEL_PALETTES)
    return CHANNEL_PALETTES[idx]


class AvatarKind(enum.StrEnum):
    """Discriminator stored in the ``avatar_kind`` column.

    ``GENERATED`` means the server can refetch the bytes from DiceBear
    using the seed (id + version). ``UPLOADED`` means the bytes live in
    R2 only — the user PUT them once and the server has no way to
    recreate them, so the R2 object is authoritative.
    """

    GENERATED = "generated"
    UPLOADED = "uploaded"


# --- URL builders ----------------------------------------------------------
# Pure functions — no I/O, safe to call from sync DB code when assembling
# response payloads. Mirror the storage-key helpers but spit out URLs.

avatar_url_for_user = user_avatar_url
avatar_url_for_agent = agent_avatar_url
avatar_url_for_channel = channel_avatar_url


# --- DiceBear fetch + R2 upload -------------------------------------------

async def _fetch_dicebear(
    style: str,
    seed: str,
    extra_params: dict[str, str | list[str]] | None = None,
) -> bytes:
    """Fetch one SVG from the DiceBear HTTP API.

    ``seed`` is what makes the avatar deterministic — same seed +
    style always returns the same bytes. We pass our own entity-typed
    seed (e.g. ``user-3-v2``) so two different entities never collide
    on the same avatar even by accident.

    ``extra_params`` is merged into the query string and is how the
    channel path passes per-palette colour overrides. A *list* value
    (e.g. ``backgroundColor``) is sent as repeated params so DiceBear
    reads it as an array and picks one per seed — see
    :data:`CHANNEL_PALETTES` for why the array form (not a comma string)
    is required against the self-hosted API.
    """
    url = f"{DICEBEAR_BASE}/{style}/svg"
    params: dict[str, str | list[str]] = {"seed": seed, "size": str(DICEBEAR_SIZE)}
    if extra_params:
        params.update(extra_params)
    async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as client:
        resp = await client.get(url, params=params)
        resp.raise_for_status()
        return resp.content


async def _fetch_and_upload(
    r2: R2S3Client,
    *,
    object_key: str,
    style: str,
    seed: str,
    extra_params: dict[str, str] | None = None,
    overlay_icon: str | None = None,
    overlay_stroke_color: str | None = None,
) -> bool:
    """Fetch a DiceBear SVG, optionally overlay an icon, upload to R2.

    ``overlay_icon`` is an SVG path string from
    :mod:`clawbits.avatars.icons`. When supplied, the DiceBear bytes
    are post-processed by :func:`compose_with_icon` before upload.
    ``overlay_stroke_color`` lets the caller pin the icon stroke to a
    fixed colour (e.g. ``#ffffff`` for channels); leave it None to use
    the contrast-tint derived from the chosen background.
    """
    try:
        body = await _fetch_dicebear(style, seed, extra_params=extra_params)
    except httpx.HTTPError as exc:
        logger.warning(
            "dicebear fetch failed for style=%s seed=%s: %s",
            style, seed, exc,
        )
        return False
    if overlay_icon is not None:
        body = compose_with_icon(body, overlay_icon, stroke_color=overlay_stroke_color)
    result = await r2.upload_file(
        object_key,
        body,
        content_type=AVATAR_CONTENT_TYPE,
        cache_control=AVATAR_CACHE_CONTROL,
    )
    if not result.get("success"):
        logger.warning(
            "avatar upload failed for key=%s: %s",
            object_key,
            result.get("error"),
        )
        return False
    return True


# --- ensure_* entrypoints --------------------------------------------------
# Each is idempotent: re-uploading the same DiceBear-derived bytes to
# the same versioned key is wasted but harmless. The backfill HEADs the
# object first to skip the wasted work.

async def ensure_user_avatar(
    r2: R2S3Client,
    *,
    user_id: int,
    version: int,
    kind: AvatarKind | str = AvatarKind.GENERATED,
) -> str:
    """Make sure the user's avatar SVG exists in R2; return its URL.

    Uploaded avatars are skipped (the bytes already arrived via the
    upload endpoint). Generated avatars are a **two-tone stitch** of
    two DiceBear ``glass`` renders — top 50% from seed ``-A``, bottom
    50% from seed ``-B`` — giving every user a unique two-block tile
    instead of a single frosted blob.
    """
    if AvatarKind(kind) is AvatarKind.GENERATED:
        # Fetch both halves in parallel so we don't pay 2× DiceBear
        # latency. ``return_exceptions=True`` lets a single-half
        # failure bubble up as an exception below (which the caller's
        # try/except swallows + logs).
        import asyncio
        top, bot = await asyncio.gather(
            _fetch_dicebear(USER_STYLE, f"user-{user_id}-v{version}-A"),
            _fetch_dicebear(USER_STYLE, f"user-{user_id}-v{version}-B"),
        )
        body = compose_stitched_glass(top, bot)
        await r2.upload_file(
            user_avatar_object_key(user_id, version),
            body,
            content_type=AVATAR_CONTENT_TYPE,
            cache_control=AVATAR_CACHE_CONTROL,
        )
    return user_avatar_url(user_id, version)


async def ensure_agent_avatar(
    r2: R2S3Client,
    *,
    agent_id: str,
    version: int,
    kind: AvatarKind | str = AvatarKind.GENERATED,
) -> str:
    """Make sure the agent's avatar SVG exists in R2; return its URL.

    The DiceBear ``bottts-neutral`` style is keyed on ``agent_id`` so
    each agent keeps a stable robot identity across version bumps.
    """
    if AvatarKind(kind) is AvatarKind.GENERATED:
        await _fetch_and_upload(
            r2,
            object_key=agent_avatar_object_key(agent_id, version),
            style=AGENT_STYLE,
            seed=f"agent-{agent_id}-v{version}",
        )
    return agent_avatar_url(agent_id, version)


async def ensure_channel_avatar(
    r2: R2S3Client,
    *,
    channel_id: str,
    version: int,
    channel_type: str = "public",
) -> str:
    """Make sure the channel's avatar SVG exists in R2; return its URL.

    Channels are always generated in V1 (no upload path), so no kind
    discriminator is needed. The overlay icon is keyed on
    ``channel_type``:

    - ``"public"`` → hash glyph
    - ``"private"`` → padlock glyph
    - ``"direct"`` → no overlay (DM tiles are rendered as a stacked
      member-avatar via the frontend ``ChatAvatar`` — the underlying
      channel avatar is hidden in practice)
    """
    overlay = None
    if channel_type == "public":
        overlay = icons.HASHTAG
    elif channel_type == "private":
        overlay = icons.LOCK_CLOSED
    await _fetch_and_upload(
        r2,
        object_key=channel_avatar_object_key(channel_id, version),
        style=CHANNEL_STYLE,
        seed=f"channel-{channel_id}-v{version}",
        extra_params=_pick_channel_palette(channel_id),
        overlay_icon=overlay,
        # Channels pin the icon to pure black so the # / lock reads
        # maximally clearly on every palette — the contrast-tint we
        # use elsewhere washed out on the lighter palettes, and black
        # gives the most consistent silhouette across both the warm
        # (coral / cream) and cool (navy / slate) bgs.
        overlay_stroke_color="#000000",
    )
    return channel_avatar_url(channel_id, version)
