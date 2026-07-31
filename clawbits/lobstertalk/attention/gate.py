"""The attention gate: a semantic-router classifier over two competing routes.

An incoming message is embedded once and scored against a ``needs_attention``
route (help-seeking / questions / blockers / decisions) and a competing
``resolved_or_social`` decoy (acks / resolutions / chit-chat). ``semantic-router``
returns whichever route wins above threshold, so a question and its answer —
close on topic — land on opposite sides; the gate escalates only when
``needs_attention`` wins. Each route scores as its single closest utterance
(max aggregation), so an utterance can only ever help its own route: coverage
— especially the decoy's — is the tuning surface, not the threshold.

The encoder is FastEmbed (ONNX, CPU) — no per-agent model server, which is what
lets this run in one shared server process. ``semantic_router`` / ``fastembed``
(the ``router`` extra) are imported lazily inside :meth:`AttentionGate.build`, so
importing this module never requires them; a missing dep or model just disables
the gate.
"""

from __future__ import annotations

import logging
import os
import threading
from dataclasses import dataclass

logger = logging.getLogger(__name__)

NEEDS_ATTENTION = "needs_attention"
RESOLVED_SOCIAL = "resolved_or_social"

# Topic-independent forms that warrant an agent's look.
NEEDS_ATTENTION_UTTERANCES = [
    "does anyone know how to do this?",
    "how do I get this working?",
    "what's the best way to approach this?",
    "can someone help me with this?",
    "I'm stuck on this and not sure what to try next",
    "any idea why this isn't working?",
    "is it possible to do this?",
    "has anyone run into this before?",
    "we're blocked on this",
    "I've tried everything and it still fails",
    "nobody has gotten back to me on this",
    "should we go with option A or option B?",
    "any objections to this approach?",
    "what do you think about this?",
    "who can help with this?",
    # trouble / regression reports stated without question form
    "the pipeline started failing after the latest change",
    "production is broken and nobody can log in",
    "this worked yesterday and now it doesn't",
    # review / take-a-look requests (polite-future phrasing, counters "will do")
    "can somebody review my pull request?",
    "could you take a look at this change when you have a moment?",
    # doc / where-is asks
    "is there documentation for how this works?",
    "where is this configured?",
    # error paste with trailing ask
    "I'm seeing an error when I run it, any ideas what's wrong?",
    # indirect / ownership report
    "not sure who owns this, but something seems off",
]

# The decoy: acks, resolutions, social noise. A message that routes here (or
# clears no route's threshold) is dropped without a nudge.
RESOLVED_SOCIAL_UTTERANCES = [
    "thanks, that worked!",
    "sounds good to me",
    "will do",
    "nice, appreciate it",
    "never mind, I figured it out",
    "fixed it, it was a typo",
    "here's the answer: you set the flag in config",
    "lol same",
    "good morning everyone",
    "great work team",
    "ok cool",
    "see you tomorrow",
    # status / progress updates
    "update: the fix is deployed and everything looks stable",
    "pushed the change, the pipeline is running now",
    "I'll take care of it tomorrow",
    "merged and closing this out",
    # link drops / announcements
    "sharing this article, worth a read",
    "FYI the meeting moved to Thursday",
    # social questions (question form, no work content)
    "who's up for coffee later?",
    "how was your weekend?",
    "can you believe it's already July?",
    # answer follow-ups
    "does that answer your question?",
    "let me know if that helps",
    # answers that point at docs (counterweight to the doc-ask utterances —
    # topic-sharing question/answer pairs need an anchor on both sides)
    "it's documented in the README, see the setup section",
    "the answer is in the docs, check the configuration page",
    # micro-ack
    "+1",
]

# Floor on the winning route's similarity — vestigial in practice. bge-small's
# compressed range puts every probed message's winning route at ~0.52+ (emoji-
# only, URL drops and non-English text all clear it), so this only drops true
# garbage. The needs-vs-decoy contest is the actual mechanism: tune the
# utterance sets (a misrouted form gets an anchor on the right side), not this.
DEFAULT_THRESHOLD = 0.41
DEFAULT_COOLDOWN_SECONDS = 300
QUERY_CHAR_LIMIT = 512
_CLIP_SEP = " … "


def _clip_query(text: str) -> str:
    """Bound the embedded query to ``QUERY_CHAR_LIMIT``, keeping head and tail.

    Long messages put the ask at one end — context first, question last, or the
    reverse — so a head-only cut makes a trailing ask invisible to the gate.
    Over-long text keeps both ends around an ellipsis instead.
    """
    if len(text) <= QUERY_CHAR_LIMIT:
        return text
    half = (QUERY_CHAR_LIMIT - len(_CLIP_SEP)) // 2
    return f"{text[:half]}{_CLIP_SEP}{text[-half:]}"


def _threshold() -> float:
    raw = os.environ.get("CLAWBITS_ATTENTION_THRESHOLD", "").strip()
    try:
        return float(raw) if raw else DEFAULT_THRESHOLD
    except ValueError:
        logger.warning("bad CLAWBITS_ATTENTION_THRESHOLD %r; using %.2f", raw, DEFAULT_THRESHOLD)
        return DEFAULT_THRESHOLD


def cooldown_seconds() -> int:
    raw = os.environ.get("CLAWBITS_ATTENTION_COOLDOWN_SECONDS", "").strip()
    try:
        return int(raw) if raw else DEFAULT_COOLDOWN_SECONDS
    except ValueError:
        return DEFAULT_COOLDOWN_SECONDS


@dataclass(frozen=True)
class Verdict:
    escalate: bool
    route: str | None  # winning route (None when nothing clears threshold)
    score: float | None  # winning route's similarity


class AttentionGate:
    """Wraps a two-route ``SemanticRouter``; escalates when needs_attention wins."""

    def __init__(self, router: object) -> None:
        self._router = router

    @classmethod
    def build(cls, threshold: float) -> AttentionGate:
        """Embed the utterance set once (FastEmbed, CPU) and return a ready gate."""
        from semantic_router import Route
        from semantic_router.encoders import FastEmbedEncoder
        from semantic_router.routers import SemanticRouter

        model_name = os.environ.get("CLAWBITS_ATTENTION_EMBED_MODEL", "").strip() or None
        encoder_kwargs: dict[str, object] = {"score_threshold": threshold}
        if model_name:
            encoder_kwargs["name"] = model_name
        encoder = FastEmbedEncoder(**encoder_kwargs)
        routes = [
            Route(name=NEEDS_ATTENTION, utterances=list(NEEDS_ATTENTION_UTTERANCES)),
            Route(name=RESOLVED_SOCIAL, utterances=list(RESOLVED_SOCIAL_UTTERANCES)),
        ]
        # auto_sync="local" computes and holds the utterance embeddings in
        # memory. aggregation="max": a route scores as its closest utterance.
        # The default mean-over-top-5 dilutes dense routes (four ~0.59 matches
        # lose to a lone 0.60 decoy) and averages a long message's one strong
        # ask-clause match away against context matches.
        router = SemanticRouter(
            encoder=encoder, routes=routes, auto_sync="local", aggregation="max"
        )
        return cls(router)

    def evaluate(self, text: str) -> Verdict:
        choice = self._router(_clip_query(text))
        if isinstance(choice, list):  # limit>1 returns a list; we only want the top
            choice = choice[0] if choice else None
        name = getattr(choice, "name", None)
        score = getattr(choice, "similarity_score", None)
        return Verdict(escalate=name == NEEDS_ATTENTION, route=name, score=score)


_gate: AttentionGate | None = None
_gate_disabled = False
# Serializes the one-time build. Without it, N posts arriving before the gate
# exists each run the expensive build (model download + utterance embedding)
# concurrently on their own to_thread worker.
_build_lock = threading.Lock()


def get_gate() -> AttentionGate | None:
    """Lazily build the process-wide gate. None once we've learned it can't load
    (missing dep or model), so the feature fails soft instead of erroring per post.

    Called eagerly from the server lifespan when the feature is enabled (see
    ``main.lifespan``) so the model download and any load failure surface in
    the boot log rather than inside the first post's background task."""
    global _gate, _gate_disabled
    if _gate is not None:
        return _gate
    if _gate_disabled:
        return None
    with _build_lock:
        # Re-check under the lock: another thread may have finished (or
        # failed) the build while we waited.
        if _gate is not None:
            return _gate
        if _gate_disabled:
            return None
        try:
            gate = AttentionGate.build(_threshold())
        except ImportError as e:
            logger.warning(
                "attention gate: semantic-router/fastembed not installed (%s); disabled. "
                "Install the 'router' extra.",
                e,
            )
            _gate_disabled = True
            return None
        except Exception as e:  # model download/load failure — disable, don't crash posts
            logger.warning("attention gate: encoder unavailable (%s); disabled", e)
            _gate_disabled = True
            return None
        _gate = gate
    logger.info(
        "attention gate ready (threshold=%.2f, %d attention / %d decoy utterances)",
        _threshold(), len(NEEDS_ATTENTION_UTTERANCES), len(RESOLVED_SOCIAL_UTTERANCES),
    )
    return gate


def evaluate_text(text: str) -> Verdict | None:
    """Blocking (CPU-bound embed) — callers run it via ``asyncio.to_thread``.
    None means the gate is unavailable (treated as no-escalation)."""
    gate = get_gate()
    return gate.evaluate(text) if gate is not None else None
