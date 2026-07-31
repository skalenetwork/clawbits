"""Public payload for avatar references on user / agent / channel responses.

Every entity that has an avatar (humans, agents, channels) carries an
:class:`AvatarRef` on its API response. The frontend renders it with a
plain ``<img src={avatar.url}>`` — no per-request signing, no
client-side generation. ``version`` is the same monotonic counter
baked into the URL path, exposed for diagnostic / cache-debugging use.
``kind`` tells the upload UI whether a "reset to default" affordance
makes sense (only for ``"uploaded"``).
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel

AvatarKindLiteral = Literal["generated", "uploaded"]


class AvatarRef(BaseModel):
    """Avatar reference attached to user / agent / channel responses."""

    url: str
    version: int
    # Channels are always ``"generated"`` in V1 (no upload path); humans
    # and agents flip to ``"uploaded"`` once an owner PUTs custom bytes.
    kind: AvatarKindLiteral = "generated"
