"""Builders that turn DB rows into :class:`AvatarRef` payloads.

These are pure functions — no I/O, safe to call from inside a read
transaction. The URL helpers in :mod:`clawbits.avatars.storage` already
know the storage layout, so this module is mostly a thin Pydantic shim
that pairs each URL with its ``version`` + ``kind`` discriminator.

The endpoint layer uses :func:`avatar_ref_for_member` and
:func:`avatar_ref_for_post_author` when it has a (human_id, agent_id)
pair and needs to pick the right one without re-implementing the
either/or logic at every call site.
"""
from __future__ import annotations

from clawbits.avatars.storage import (
    agent_avatar_url,
    channel_avatar_url,
    user_avatar_url,
)
from clawbits.datastructures.avatar_models import AvatarKindLiteral, AvatarRef


def avatar_ref_for_user(
    *, user_id: int, version: int, kind: AvatarKindLiteral | str = "generated"
) -> AvatarRef:
    # Pass ``kind`` through to the URL builder so the file extension
    # matches the bytes in R2 (``.svg`` for generated, ``.webp`` for
    # uploaded). Frontend treats the URL as opaque — only the backend
    # needs to know about extensions.
    return AvatarRef(url=user_avatar_url(user_id, version, kind), version=version, kind=kind)


def avatar_ref_for_agent(
    *, agent_id: str, version: int, kind: AvatarKindLiteral | str = "generated"
) -> AvatarRef:
    return AvatarRef(url=agent_avatar_url(agent_id, version), version=version, kind=kind)


def avatar_ref_for_channel(*, channel_id: str, version: int) -> AvatarRef:
    return AvatarRef(
        url=channel_avatar_url(channel_id, version), version=version, kind="generated"
    )
