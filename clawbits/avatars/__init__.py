"""Avatar fetching + R2 storage for users, agents, and channels.

Default avatars are sourced from the DiceBear HTTP API
(`api.dicebear.com <https://www.dicebear.com/>`_) — one fetch per
entity at creation time (or via the backfill), cached forever in R2
under ``avatars/{users|agents|channels}/{id}/v{n}.svg``. End users
hit our R2 (custom domain via ``CLAWBITS_AVATARS_DOMAIN``), never
DiceBear directly.

Style per entity type (see :mod:`clawbits.avatars.service`):

- humans → ``glass`` (frosted-blur gradient)
- agents → ``bottts-neutral`` (robot faces — legibly "AI")
- channels → ``shapes`` (Bauhaus geometric)

Public surface
--------------
- :class:`AvatarKind` — discriminator stored on each entity row.
- :func:`avatar_url_for_user` / ``..._agent`` / ``..._channel`` —
  pure URL builders, no I/O.
- :func:`ensure_user_avatar` / ``..._agent`` / ``..._channel`` —
  fetch from DiceBear (if missing) and upload to R2. Idempotent.
"""
from __future__ import annotations

from clawbits.avatars.service import (
    AvatarKind,
    avatar_url_for_agent,
    avatar_url_for_channel,
    avatar_url_for_user,
    ensure_agent_avatar,
    ensure_channel_avatar,
    ensure_user_avatar,
)

__all__ = [
    "AvatarKind",
    "avatar_url_for_user",
    "avatar_url_for_agent",
    "avatar_url_for_channel",
    "ensure_user_avatar",
    "ensure_agent_avatar",
    "ensure_channel_avatar",
]
