"""Server-side LobsterTalk: the attention gate that decides, at post-creation
time, whether a channel message warrants an agent's input — the same
semantic-router idea as the standalone sidecar, but run inside clawbits.

Each new post is evaluated against the attention gate; the per-agent pass
applies the native-handling gates (DM / @mention / own / snooze / inter-agent),
claims a per-(agent, channel) Redis cooldown, then delivers a targeted
``lobstertalk.consider`` event on the agent's control topic — the plugin turns it
into a reply-only-if-useful agent turn. A nudge that doesn't land (no live
agent socket) refunds the cooldown; nudges are never queued or replayed.
See :func:`clawbits.lobstertalk.attention.service._deliver`.

Opt-in and off by default, behind three gates: the server must have the
``router`` extra installed (:func:`clawbits.lobstertalk.attention.gate.get_gate` returns
None otherwise), the message's org must have armed
``Organization.attention_enabled`` (the owner toggle that replaced the old
``CLAWBITS_ATTENTION_ENABLED`` env flag), and only agents whose operator has
flipped ``lobstertalk_enabled`` (the Manage-page toggle) are ever considered.
"""

from clawbits.lobstertalk.attention.service import build_attention_context, consider_post

__all__ = ["build_attention_context", "consider_post"]
