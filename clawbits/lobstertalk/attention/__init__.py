"""Server-side LobsterTalk: the attention gate that decides, at post-creation
time, whether a channel message warrants an agent's input — the same
semantic-router idea as the standalone sidecar, but run inside clawbits.

Each new post is evaluated against the attention gate; the per-agent pass
applies the native-handling gates (DM / @mention / own / snooze / inter-agent),
claims a per-(agent, channel) Redis cooldown, then delivers a targeted
``mutualist.consider`` event (the pre-rename wire name — deployed plugins only
match that one; see :func:`clawbits.realtime.sse.publish_attention_nudge`) on
the agent's control topic — the plugin turns it into a reply-only-if-useful
agent turn. A nudge that doesn't land (no live
agent socket) refunds the cooldown; nudges are never queued or replayed.
See :func:`clawbits.lobstertalk.attention.service._deliver`.

An org can put the gate in ``cascade`` mode, which inserts an LLM confirm
stage (:mod:`clawbits.lobstertalk.attention.triage`) between the cooldown
claim and delivery: the gate becomes a cheap recall pre-filter and the model
votes on whether this agent's input is genuinely needed. Any failure there
falls back to the gate verdict, so a broken endpoint can't mute anyone — and
because a call was already paid for, a cascade nudge that doesn't land keeps
its cooldown instead of refunding it. See the README for the full mode
description, the endpoint rules, and the spend bound.

Opt-in and off by default, behind four gates: the server must have the
``router`` extra installed (:func:`clawbits.lobstertalk.attention.gate.get_gate` returns
None otherwise), the message's org must have armed
``Organization.attention_enabled`` (the owner toggle that replaced the old
``CLAWBITS_ATTENTION_ENABLED`` env flag), the channel must be on the owner's
per-channel allowlist (``MmChannel.lobstertalk_approved`` — closed by default,
approved from Settings → LobsterTalk), and only agents whose operator has
flipped ``lobstertalk_enabled`` (the Manage-page toggle) are ever considered.
"""

from clawbits.lobstertalk.attention.service import build_attention_context, consider_post

__all__ = ["build_attention_context", "consider_post"]
