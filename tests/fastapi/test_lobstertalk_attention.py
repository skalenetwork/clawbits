"""Server-side LobsterTalk attention gate + post-consideration gates.

semantic-router/FastEmbed and Redis are stubbed: the risky logic is the verdict
adaptation (escalate only when ``needs_attention`` wins) and the per-agent
native-handling/cooldown gates, not the embedding model itself. A fake router
returns a preset ``RouteChoice`` so the decision is deterministic and offline.
"""

import asyncio
from types import SimpleNamespace

from clawbits.lobstertalk.attention import gate as gate_mod
from clawbits.lobstertalk.attention import service as svc
from clawbits.lobstertalk.attention.gate import AttentionGate, Verdict
from clawbits.lobstertalk.attention.service import (
    AttentionCandidate,
    AttentionContext,
    consider_post,
)
from clawbits.lobstertalk.attention.triage import LlmTriageConfig, TriageDecision

# --- gate logic: escalate only when the needs_attention route wins ---------


class _FakeChoice:
    def __init__(self, name, score):
        self.name = name
        self.similarity_score = score


class _FakeRouter:
    """Stands in for semantic_router.SemanticRouter: returns a preset choice."""

    def __init__(self, name, score=0.7):
        self._choice = _FakeChoice(name, score)
        self.seen: list[str] = []

    def __call__(self, text, **kwargs):
        self.seen.append(text)
        return self._choice


def test_escalates_when_attention_route_wins():
    v = AttentionGate(_FakeRouter("needs_attention", 0.62)).evaluate("how do I do this?")
    assert v.escalate is True
    assert v.route == "needs_attention" and v.score == 0.62


def test_no_escalation_when_decoy_wins():
    v = AttentionGate(_FakeRouter("resolved_or_social", 0.71)).evaluate("thanks!")
    assert v.escalate is False
    assert v.route == "resolved_or_social"


def test_no_escalation_when_no_route_clears_threshold():
    v = AttentionGate(_FakeRouter(None, None)).evaluate("the quarterly numbers are attached")
    assert v.escalate is False
    assert v.route is None


def test_long_query_is_clipped_keeping_head_and_tail():
    # Asks often trail long messages; the clip must keep both ends, bounded by
    # the char limit, so a trailing question stays visible to the gate.
    router = _FakeRouter("needs_attention")
    AttentionGate(router).evaluate("context first " + "x" * 5000 + " so how do I fix it?")
    seen = router.seen[0]
    assert len(seen) <= gate_mod.QUERY_CHAR_LIMIT
    assert seen.startswith("context first ")
    assert seen.endswith(" so how do I fix it?")


def test_short_query_is_passed_through_unclipped():
    router = _FakeRouter("needs_attention")
    AttentionGate(router).evaluate("how do I fix it?")
    assert router.seen[0] == "how do I fix it?"


# --- consider_post gates --------------------------------------------------


def _ctx(*candidates):
    return AttentionContext(channel_type="public", candidates=tuple(candidates))


_LLM = LlmTriageConfig(base_url="http://llm.local/v1", model="m1", api_key=None)


def _cascade_ctx(*candidates, llm=_LLM):
    return AttentionContext(
        channel_type="public",
        candidates=tuple(candidates),
        channel_label="general",
        mode="cascade",
        llm=llm,
    )


def _run(
    monkeypatch,
    *,
    post,
    context,
    author_agent_id,
    verdict=Verdict(True, "needs_attention", 0.9),
    on_cooldown=False,
    engine=None,
    transcript=({"message": "earlier"},),
    triage_decision=None,
    deliver_lands=True,
    calls=None,
):
    """Run consider_post with every side effect faked. ``calls`` (an optional
    caller-supplied list) receives ``(step, arg)`` tuples in execution order —
    claim/transcript/triage/deliver/refund — so cascade tests can assert both
    what ran and in which order (the claim-before-triage watermark semantics).
    ``transcript=None`` simulates a failed transcript load; ``triage_decision``
    may be a single value or a list consumed one per call; ``deliver_lands``
    False simulates a nudge that found no live agent socket."""
    delivered: list[str] = []
    log = calls if calls is not None else []
    decisions = list(triage_decision) if isinstance(triage_decision, list) else None
    monkeypatch.setattr(svc, "evaluate_text", lambda text: verdict)

    async def fake_claim(agent_id, channel_id):
        log.append(("claim", agent_id))
        return not on_cooldown

    def fake_load_transcript(engine_, channel_id, through_post_id=None):
        log.append(("transcript", through_post_id))
        return list(transcript) if transcript is not None else None

    async def fake_triage(*, config, agent_id, description, channel_id,
                          channel_label, posts, focus_post_id=None):
        log.append(("triage", agent_id))
        if decisions is not None:
            return decisions.pop(0)
        return triage_decision

    async def fake_release(agent_id, channel_id):
        log.append(("refund", agent_id))

    async def fake_deliver(agent_id, *a):
        log.append(("deliver", agent_id))
        if not deliver_lands:
            return False
        delivered.append(agent_id)
        return True

    monkeypatch.setattr(svc, "_claim_cooldown", fake_claim)
    monkeypatch.setattr(svc, "_load_transcript", fake_load_transcript)
    monkeypatch.setattr(svc, "triage_decide", fake_triage)
    monkeypatch.setattr(svc, "_release_cooldown", fake_release)
    monkeypatch.setattr(svc, "_deliver", fake_deliver)
    asyncio.run(
        consider_post(
            post=post,
            channel_id="c1",
            context=context,
            author_agent_id=author_agent_id,
            engine=engine,
        )
    )
    return delivered


def test_human_post_nudges_eligible_agents(monkeypatch):
    ctx = _ctx(
        AttentionCandidate("Alpha", snoozed=False, inter_agent_mode=False),
        AttentionCandidate("Beta", snoozed=False, inter_agent_mode=False),
    )
    delivered = _run(
        monkeypatch,
        post={"message": "any idea why this isn't working?", "post_id": 1},
        context=ctx,
        author_agent_id=None,
    )
    assert set(delivered) == {"Alpha", "Beta"}


def test_snoozed_and_mentioned_and_own_are_skipped(monkeypatch):
    ctx = _ctx(
        AttentionCandidate("Snoozy", snoozed=True, inter_agent_mode=False),
        AttentionCandidate("Tagged", snoozed=False, inter_agent_mode=False),
        AttentionCandidate("Free", snoozed=False, inter_agent_mode=False),
    )
    delivered = _run(
        monkeypatch,
        post={"message": "@Tagged any idea why this isn't working?", "post_id": 2},
        context=ctx,
        author_agent_id=None,
    )
    assert delivered == ["Free"]  # Snoozy snoozed, Tagged @mentioned


def test_no_escalation_delivers_nothing(monkeypatch):
    ctx = _ctx(AttentionCandidate("Alpha", snoozed=False, inter_agent_mode=False))
    delivered = _run(
        monkeypatch,
        post={"message": "thanks!", "post_id": 3},
        context=ctx,
        author_agent_id=None,
        verdict=Verdict(False, "resolved_or_social", 0.8),
    )
    assert delivered == []


def test_cooldown_suppresses(monkeypatch):
    ctx = _ctx(AttentionCandidate("Alpha", snoozed=False, inter_agent_mode=False))
    delivered = _run(
        monkeypatch,
        post={"message": "help me please", "post_id": 4},
        context=ctx,
        author_agent_id=None,
        on_cooldown=True,
    )
    assert delivered == []


def test_agent_authored_needs_inter_agent_mode(monkeypatch):
    ctx = _ctx(
        AttentionCandidate("Poster", snoozed=False, inter_agent_mode=False),
        AttentionCandidate("NoInter", snoozed=False, inter_agent_mode=False),
        AttentionCandidate("YesInter", snoozed=False, inter_agent_mode=True),
    )
    delivered = _run(
        monkeypatch,
        post={"message": "any idea why this isn't working?", "post_id": 5},
        context=ctx,
        author_agent_id="Poster",  # agent-authored
    )
    assert delivered == ["YesInter"]  # Poster=own, NoInter lacks inter-agent


def test_gate_disabled_is_noop(monkeypatch):
    # evaluate_text returns None when the encoder is unavailable → no delivery.
    ctx = _ctx(AttentionCandidate("Alpha", snoozed=False, inter_agent_mode=False))
    delivered = _run(
        monkeypatch,
        post={"message": "any idea why this isn't working?", "post_id": 6},
        context=ctx,
        author_agent_id=None,
        verdict=None,
    )
    assert delivered == []


# --- cascade confirm stage: LLM triage between cooldown claim and delivery --


def test_cascade_triage_yes_delivers_after_claim(monkeypatch):
    """Triage confirms → nudge lands; the cooldown claim strictly precedes the
    triage call (a "no" must consume the window — sidecar watermark semantics)."""
    ctx = _cascade_ctx(AttentionCandidate("Alpha", snoozed=False, inter_agent_mode=False))
    calls: list = []
    delivered = _run(
        monkeypatch,
        post={"message": "any idea why this isn't working?", "post_id": 10},
        context=ctx,
        author_agent_id=None,
        engine=object(),
        triage_decision=TriageDecision(needs_input=True, reason="open question"),
        calls=calls,
    )
    assert delivered == ["Alpha"]
    steps = [step for step, _ in calls]
    assert steps.index("claim") < steps.index("triage") < steps.index("deliver")


def test_cascade_triage_no_suppresses_and_keeps_cooldown(monkeypatch):
    """Triage declines → no nudge, and the cooldown is NOT refunded: the spend
    bound is one LLM call per (agent, channel) window."""
    ctx = _cascade_ctx(AttentionCandidate("Alpha", snoozed=False, inter_agent_mode=False))
    calls: list = []
    delivered = _run(
        monkeypatch,
        post={"message": "any idea why this isn't working?", "post_id": 11},
        context=ctx,
        author_agent_id=None,
        engine=object(),
        triage_decision=TriageDecision(needs_input=False, reason="already answered"),
        calls=calls,
    )
    assert delivered == []
    assert ("claim", "Alpha") in calls
    assert all(step != "refund" for step, _ in calls)


def test_cascade_triage_undecided_fails_open(monkeypatch):
    """Triage None (unreachable/unparseable — anything) → deliver on the gate
    verdict: a broken LLM must never mute agents."""
    ctx = _cascade_ctx(AttentionCandidate("Alpha", snoozed=False, inter_agent_mode=False))
    delivered = _run(
        monkeypatch,
        post={"message": "any idea why this isn't working?", "post_id": 12},
        context=ctx,
        author_agent_id=None,
        engine=object(),
        triage_decision=None,
    )
    assert delivered == ["Alpha"]


def test_cascade_without_llm_config_fails_open(monkeypatch):
    """Cascade armed but the org's LLM config was unusable (context.llm=None)
    → deliver without ever calling triage."""
    ctx = _cascade_ctx(
        AttentionCandidate("Alpha", snoozed=False, inter_agent_mode=False), llm=None
    )
    calls: list = []
    delivered = _run(
        monkeypatch,
        post={"message": "any idea why this isn't working?", "post_id": 13},
        context=ctx,
        author_agent_id=None,
        engine=object(),
        calls=calls,
    )
    assert delivered == ["Alpha"]
    assert all(step not in ("triage", "transcript") for step, _ in calls)


def test_cascade_without_engine_fails_open(monkeypatch):
    """No engine passed (defensive default) → same fail-open, no triage."""
    ctx = _cascade_ctx(AttentionCandidate("Alpha", snoozed=False, inter_agent_mode=False))
    calls: list = []
    delivered = _run(
        monkeypatch,
        post={"message": "any idea why this isn't working?", "post_id": 14},
        context=ctx,
        author_agent_id=None,
        engine=None,
        calls=calls,
    )
    assert delivered == ["Alpha"]
    assert all(step not in ("triage", "transcript") for step, _ in calls)


def test_cascade_transcript_failure_fails_open(monkeypatch):
    """Transcript load failed → deliver on the gate verdict, triage never runs
    (it would have nothing to reason over)."""
    ctx = _cascade_ctx(AttentionCandidate("Alpha", snoozed=False, inter_agent_mode=False))
    calls: list = []
    delivered = _run(
        monkeypatch,
        post={"message": "any idea why this isn't working?", "post_id": 15},
        context=ctx,
        author_agent_id=None,
        engine=object(),
        transcript=None,
        calls=calls,
    )
    assert delivered == ["Alpha"]
    steps = [step for step, _ in calls]
    assert "transcript" in steps and "triage" not in steps


def test_cascade_transcript_loaded_once_for_many_candidates(monkeypatch):
    """The transcript is per-post state: two surviving candidates → two triage
    calls but a single DB fetch."""
    ctx = _cascade_ctx(
        AttentionCandidate("Alpha", snoozed=False, inter_agent_mode=False),
        AttentionCandidate("Beta", snoozed=False, inter_agent_mode=False),
    )
    calls: list = []
    delivered = _run(
        monkeypatch,
        post={"message": "any idea why this isn't working?", "post_id": 16},
        context=ctx,
        author_agent_id=None,
        engine=object(),
        triage_decision=TriageDecision(needs_input=True, reason="r"),
        calls=calls,
    )
    assert set(delivered) == {"Alpha", "Beta"}
    steps = [step for step, _ in calls]
    assert steps.count("transcript") == 1
    assert steps.count("triage") == 2


def test_cascade_transcript_is_anchored_to_the_triggering_post(monkeypatch):
    """The window ends at the post that tripped the gate — otherwise a burst
    of newer messages could push it out entirely and the model would judge a
    conversation the gate never saw. The reader's cursor is exclusive, hence
    the +1."""
    ctx = _cascade_ctx(AttentionCandidate("Alpha", snoozed=False, inter_agent_mode=False))
    calls: list = []
    _run(
        monkeypatch,
        post={"message": "any idea why this isn't working?", "post_id": 4242},
        context=ctx,
        author_agent_id=None,
        engine=object(),
        triage_decision=TriageDecision(needs_input=True, reason="r"),
        calls=calls,
    )
    assert ("transcript", 4242) in calls


def test_cascade_triage_failure_skips_remaining_candidates(monkeypatch):
    """Candidates run in sequence, so a dead endpoint would cost a full
    timeout each. After the first undecided answer the confirm stage is
    dropped for the rest of this post — every candidate still fails open."""
    ctx = _cascade_ctx(
        AttentionCandidate("Alpha", snoozed=False, inter_agent_mode=False),
        AttentionCandidate("Beta", snoozed=False, inter_agent_mode=False),
        AttentionCandidate("Gamma", snoozed=False, inter_agent_mode=False),
    )
    calls: list = []
    delivered = _run(
        monkeypatch,
        post={"message": "any idea why this isn't working?", "post_id": 18},
        context=ctx,
        author_agent_id=None,
        engine=object(),
        triage_decision=None,  # endpoint unreachable / unparseable
        calls=calls,
    )
    assert set(delivered) == {"Alpha", "Beta", "Gamma"}  # all fail open
    assert [step for step, _ in calls].count("triage") == 1  # circuit broken


def test_cascade_keeps_cooldown_when_paid_nudge_does_not_land(monkeypatch):
    """The refund exists so an offline agent isn't locked out — but once we've
    paid for triage, refunding would let the next flagged post pay again for
    as long as the agent stays offline. Spend bound wins over a 30s re-entry
    delay."""
    ctx = _cascade_ctx(AttentionCandidate("Alpha", snoozed=False, inter_agent_mode=False))
    calls: list = []
    delivered = _run(
        monkeypatch,
        post={"message": "any idea why this isn't working?", "post_id": 19},
        context=ctx,
        author_agent_id=None,
        engine=object(),
        triage_decision=TriageDecision(needs_input=True, reason="r"),
        deliver_lands=False,
        calls=calls,
    )
    assert delivered == []
    assert ("deliver", "Alpha") in calls
    assert all(step != "refund" for step, _ in calls)


def test_embedding_mode_still_refunds_unlanded_nudge(monkeypatch):
    """No triage call, nothing paid for — the original refund behavior is
    untouched for the default mode."""
    ctx = _ctx(AttentionCandidate("Alpha", snoozed=False, inter_agent_mode=False))
    calls: list = []
    _run(
        monkeypatch,
        post={"message": "any idea why this isn't working?", "post_id": 20},
        context=ctx,
        author_agent_id=None,
        deliver_lands=False,
        calls=calls,
    )
    assert ("refund", "Alpha") in calls


def test_cascade_declined_nudge_never_refunds(monkeypatch):
    """A triage "no" short-circuits before delivery, so the cooldown it
    claimed stays consumed — one paid call per (agent, channel) window."""
    ctx = _cascade_ctx(AttentionCandidate("Alpha", snoozed=False, inter_agent_mode=False))
    calls: list = []
    _run(
        monkeypatch,
        post={"message": "any idea why this isn't working?", "post_id": 21},
        context=ctx,
        author_agent_id=None,
        engine=object(),
        triage_decision=TriageDecision(needs_input=False, reason="resolved"),
        deliver_lands=False,
        calls=calls,
    )
    assert all(step not in ("deliver", "refund") for step, _ in calls)


def test_embedding_mode_never_touches_triage(monkeypatch):
    """The default mode is byte-for-byte the pre-cascade behavior: no
    transcript fetch, no triage call, even with an engine available."""
    ctx = _ctx(AttentionCandidate("Alpha", snoozed=False, inter_agent_mode=False))
    calls: list = []
    delivered = _run(
        monkeypatch,
        post={"message": "any idea why this isn't working?", "post_id": 17},
        context=ctx,
        author_agent_id=None,
        engine=object(),
        calls=calls,
    )
    assert delivered == ["Alpha"]
    assert all(step not in ("triage", "transcript") for step, _ in calls)


def test_deliver_publishes_nudge_on_agent_topic(monkeypatch):
    """_deliver logs *and* publishes a lobstertalk.consider event for the agent."""
    sent: dict = {}

    async def fake_publish(bus, agent_id, channel_id, post):
        sent.update(agent_id=agent_id, channel_id=channel_id, post=post)
        return 1  # one live subscriber

    monkeypatch.setattr(svc, "get_bus", lambda: object())
    monkeypatch.setattr(svc, "publish_attention_nudge", fake_publish)
    landed = asyncio.run(
        svc._deliver(
            "Alpha", "c1", {"post_id": 7, "message": "help"}, Verdict(True, "needs_attention", 0.9)
        )
    )
    assert landed is True
    assert sent == {
        "agent_id": "Alpha",
        "channel_id": "c1",
        "post": {"post_id": 7, "message": "help"},
    }


def test_deliver_reports_no_subscribers(monkeypatch):
    """Zero receivers (agent socket down) → False, so the cooldown is refunded."""

    async def fake_publish(bus, agent_id, channel_id, post):
        return 0

    monkeypatch.setattr(svc, "get_bus", lambda: object())
    monkeypatch.setattr(svc, "publish_attention_nudge", fake_publish)
    landed = asyncio.run(
        svc._deliver("Alpha", "c1", {"post_id": 8, "message": "help"}, Verdict(True, "needs_attention", 0.9))
    )
    assert landed is False


def test_failed_delivery_refunds_cooldown(monkeypatch):
    """A nudge that doesn't land must release the claimed (agent, channel)
    cooldown so the next qualifying post can try again immediately."""
    refunded: list[str] = []
    monkeypatch.setattr(
        svc, "evaluate_text", lambda text: Verdict(True, "needs_attention", 0.9)
    )

    async def fake_claim(agent_id, channel_id):
        return True

    async def fake_deliver(agent_id, *a):
        return False  # publish failed / no subscriber

    async def fake_release(agent_id, channel_id):
        refunded.append(agent_id)

    monkeypatch.setattr(svc, "_claim_cooldown", fake_claim)
    monkeypatch.setattr(svc, "_deliver", fake_deliver)
    monkeypatch.setattr(svc, "_release_cooldown", fake_release)
    ctx = _ctx(AttentionCandidate("Alpha", snoozed=False, inter_agent_mode=False))
    asyncio.run(
        consider_post(
            post={"message": "any idea why this isn't working?", "post_id": 9},
            channel_id="c1",
            context=ctx,
            author_agent_id=None,
        )
    )
    assert refunded == ["Alpha"]


# --- endpoint wiring: agent posts run the attention pass --------------------


def _wire_attention_fakes(monkeypatch):
    """Patch the module attrs the endpoint resolves at call time (it imports
    from clawbits.lobstertalk.attention inside the request). The consider_post fake records
    synchronously — at coroutine-creation time, inline in the endpoint — so
    assertions don't race the fire-and-forget scheduling; the returned no-op
    coroutine keeps fire_and_forget happy."""
    import clawbits.lobstertalk.attention as mut

    sentinel = _ctx(AttentionCandidate("Other", snoozed=False, inter_agent_mode=True))
    calls: dict = {}
    monkeypatch.setattr(mut, "build_attention_context", lambda db, cid: sentinel)

    def fake_consider(*, post, channel_id, context, author_agent_id, engine=None):
        calls.update(
            post_id=post.get("post_id"),
            channel_id=channel_id,
            context=context,
            author_agent_id=author_agent_id,
            engine=engine,
        )

        async def _noop():
            return None

        return _noop()

    monkeypatch.setattr(mut, "consider_post", fake_consider)
    return sentinel, calls


def _agent_with_channel(test_client):
    from tests.fastapi.conftest import _create_agent
    from tests.fastapi.test_mattermost import _write_headers

    agent = _create_agent(test_client)
    r = test_client.post(
        "/api/agentic/mm/channels",
        json={"name": "lobstertalk-wire", "channel_type": "public"},
        headers=_write_headers(test_client, agent["api_key"]),
    )
    assert r.status_code == 200, r.text
    return agent, r.json()["channel_id"]


def _agent_post(test_client, agent, ch_id, body):
    from tests.fastapi.test_mattermost import _write_headers

    return test_client.post(
        f"/api/agentic/mm/channels/{ch_id}/posts",
        json=body,
        headers=_write_headers(test_client, agent["api_key"]),
    )


def test_agent_post_runs_attention_pass_with_author(test_client, monkeypatch):
    """A published agent post triggers consider_post with author_agent_id set."""
    sentinel, calls = _wire_attention_fakes(monkeypatch)

    agent, ch_id = _agent_with_channel(test_client)
    r = _agent_post(
        test_client, agent, ch_id, {"message": "anyone know how to fix this?"}
    )
    assert r.status_code == 200, r.text
    assert calls["author_agent_id"] == agent["agent_id"]
    assert calls["channel_id"] == ch_id
    assert calls["context"] is sentinel
    assert calls["post_id"] == r.json()["post_id"]
    assert calls["engine"] is not None  # cascade's transcript fetch needs it


def test_streaming_agent_post_skips_attention_pass(test_client, monkeypatch):
    """A streaming *create* is an empty placeholder — nothing to classify.
    Group replies stream by default (groupChannelShimmer), so their attention
    pass runs at finalize (mm_patch_post done=true), never at create; this
    pins the create-side status gate."""
    _, calls = _wire_attention_fakes(monkeypatch)

    agent, ch_id = _agent_with_channel(test_client)
    r = _agent_post(
        test_client, agent, ch_id, {"message": "…", "status": "streaming"}
    )
    assert r.status_code == 200, r.text
    assert calls == {}


def test_finalized_streaming_post_runs_attention_pass(test_client, monkeypatch):
    """done=true on a streaming post (the default group-reply flow) runs the
    attention pass on the finalised text with author_agent_id set."""
    from tests.fastapi.test_mattermost import _write_headers

    sentinel, calls = _wire_attention_fakes(monkeypatch)

    agent, ch_id = _agent_with_channel(test_client)
    r = _agent_post(
        test_client, agent, ch_id, {"message": "", "status": "streaming"}
    )
    assert r.status_code == 200, r.text
    post_id = r.json()["post_id"]
    assert calls == {}  # nothing at create time

    r = test_client.patch(
        f"/api/agentic/mm/channels/{ch_id}/posts/{post_id}",
        json={"replace": "anyone know how to fix this?", "done": True},
        headers=_write_headers(test_client, agent["api_key"]),
    )
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "published"
    assert calls["author_agent_id"] == agent["agent_id"]
    assert calls["channel_id"] == ch_id
    assert calls["context"] is sentinel
    assert calls["post_id"] == post_id


def test_cancelled_streaming_post_skips_attention_pass(test_client, monkeypatch):
    """cancel=true deletes the streaming row — no attention pass."""
    from tests.fastapi.test_mattermost import _write_headers

    _, calls = _wire_attention_fakes(monkeypatch)

    agent, ch_id = _agent_with_channel(test_client)
    r = _agent_post(
        test_client, agent, ch_id, {"message": "", "status": "streaming"}
    )
    assert r.status_code == 200, r.text
    post_id = r.json()["post_id"]

    r = test_client.patch(
        f"/api/agentic/mm/channels/{ch_id}/posts/{post_id}",
        json={"cancel": True},
        headers=_write_headers(test_client, agent["api_key"]),
    )
    assert r.status_code == 204, r.text
    assert calls == {}


def test_agent_post_skips_attention_pass_when_org_not_enabled(test_client, monkeypatch):
    """Org opt-in off (the default) → the real build_attention_context returns
    None, so consider_post is never scheduled on the agent post path."""
    import clawbits.lobstertalk.attention as mut

    calls: dict = {}

    def fake_consider(*, post, channel_id, context, author_agent_id, engine=None):
        calls["called"] = True

        async def _noop():
            return None

        return _noop()

    # Leave build_attention_context REAL: the test channel's org has
    # attention_enabled=False by default, so it short-circuits to None.
    monkeypatch.setattr(mut, "consider_post", fake_consider)

    agent, ch_id = _agent_with_channel(test_client)
    r = _agent_post(test_client, agent, ch_id, {"message": "hello"})
    assert r.status_code == 200, r.text
    assert calls == {}


# --- _load_transcript: the real DB path, unmocked ---------------------------


def test_load_transcript_reads_real_posts(test_client):
    """Everything above fakes this function, so exercise it for real once —
    its blanket ``except`` would otherwise turn an API drift into a silent
    "cascade never runs" (transcript None → fail open, forever)."""
    agent, ch_id = _agent_with_channel(test_client)
    ids = [
        _agent_post(test_client, agent, ch_id, {"message": m}).json()["post_id"]
        for m in ("first message", "second message", "third message")
    ]

    posts = svc._load_transcript(test_client.app._engine, ch_id)
    assert posts is not None
    assert [p["message"] for p in posts] == [
        "first message", "second message", "third message",
    ]  # oldest-first, as the prompt expects
    assert [p["post_id"] for p in posts] == ids
    assert all(p["who"] == agent["agent_id"] for p in posts)
    assert all(p["created_at"] for p in posts)

    # Anchoring really bounds the window at the given post.
    anchored = svc._load_transcript(test_client.app._engine, ch_id, ids[1])
    assert [p["post_id"] for p in anchored] == ids[:2]

    # And the shape is what format_transcript consumes.
    from clawbits.lobstertalk.attention.triage import format_transcript

    rendered = format_transcript(posts, agent["agent_id"], ids[-1])
    assert "third message" in rendered
    assert "(this agent)" in rendered


def test_load_transcript_returns_none_on_db_failure():
    """A broken engine must read as "no transcript" (fail open), not raise
    into the fire-and-forget task."""
    assert svc._load_transcript(object(), "c1") is None


# --- build_attention_context: the per-agent lobstertalk_enabled gate ----------


class _FakeSession:
    """Minimal Session stand-in: routes ``get`` by model name."""

    def __init__(self, channel, agents, profiles=None):
        self._channel = channel
        self._agents = agents
        self._profiles = profiles if profiles is not None else {}

    def get(self, model, key):
        if model.__name__ == "MmChannel":
            return self._channel
        if model.__name__ == "AgentProfile":
            return self._profiles.get(key)
        return self._agents.get(key)


def _channel(**over):
    base = dict(channel_type="public", org_id="o1", display_name=None, name="general")
    base.update(over)
    return SimpleNamespace(**base)


def _lt_config(**over):
    """An org row as get_org_lobstertalk_config returns it (enabled, embedding
    defaults — the post-migration shape of a fresh org)."""
    base = dict(
        enabled=True, mode="embedding", base_url=None, model=None, api_key_encrypted=None
    )
    base.update(over)
    return base


def _agent_row(*, enabled, snoozed=False, inter_agent=False):
    return SimpleNamespace(
        lobstertalk_enabled=enabled,
        snoozed=snoozed,
        inter_agent_mode_enabled=inter_agent,
    )


def test_build_context_only_includes_lobstertalk_enabled_agents(monkeypatch):
    channel = _channel()
    agents = {"On": _agent_row(enabled=True), "Off": _agent_row(enabled=False)}
    monkeypatch.setattr(
        svc.TableRead, "get_org_lobstertalk_config", lambda session, org_id: _lt_config()
    )
    monkeypatch.setattr(
        svc.TableRead,
        "get_mm_channel_members",
        lambda session, cid: [{"agent_id": "On"}, {"agent_id": "Off"}, {"agent_id": None}],
    )
    ctx = svc.build_attention_context(_FakeSession(channel, agents), "c1")
    assert ctx is not None
    assert [c.agent_id for c in ctx.candidates] == ["On"]
    assert ctx.mode == "embedding" and ctx.llm is None


def test_build_context_none_when_no_agent_enabled(monkeypatch):
    channel = _channel()
    agents = {"Off": _agent_row(enabled=False)}
    monkeypatch.setattr(
        svc.TableRead, "get_org_lobstertalk_config", lambda session, org_id: _lt_config()
    )
    monkeypatch.setattr(
        svc.TableRead,
        "get_mm_channel_members",
        lambda session, cid: [{"agent_id": "Off"}],
    )
    assert svc.build_attention_context(_FakeSession(channel, agents), "c1") is None


def test_build_context_none_when_org_not_enabled(monkeypatch):
    """The org-level opt-in is the product switch: off → None, before any member
    enumeration (which is stubbed to blow up if reached)."""
    channel = _channel()
    monkeypatch.setattr(
        svc.TableRead,
        "get_org_lobstertalk_config",
        lambda session, org_id: _lt_config(enabled=False),
    )

    def _boom(session, cid):
        raise AssertionError("member enumeration should not run when the org is disabled")

    monkeypatch.setattr(svc.TableRead, "get_mm_channel_members", _boom)
    assert svc.build_attention_context(_FakeSession(channel, {}), "c1") is None


def test_build_context_none_when_channel_has_no_org(monkeypatch):
    """A legacy/org-less channel (org_id None) can't opt in → None."""
    channel = _channel(org_id=None)
    assert svc.build_attention_context(_FakeSession(channel, {}), "c1") is None


def test_build_context_none_for_dm(monkeypatch):
    channel = _channel(channel_type="direct")
    ctx = svc.build_attention_context(_FakeSession(channel, {}), "c1")
    assert ctx is None


# --- build_attention_context: cascade-mode LLM config resolution -------------


def _cascade_members(monkeypatch):
    monkeypatch.setattr(
        svc.TableRead,
        "get_mm_channel_members",
        lambda session, cid: [{"agent_id": "On"}],
    )


def test_build_context_cascade_resolves_llm_and_descriptions(monkeypatch):
    """A usable cascade config lands on the context: key decrypted, channel
    label captured, candidate descriptions pulled from AgentProfile."""
    from clawbits.lobstertalk.attention.crypto import encrypt_secret

    monkeypatch.setattr(
        svc.TableRead,
        "get_org_lobstertalk_config",
        lambda session, org_id: _lt_config(
            mode="cascade",
            base_url="http://llm.local/v1",
            model="m1",
            api_key_encrypted=encrypt_secret("sk-live"),
        ),
    )
    _cascade_members(monkeypatch)
    session = _FakeSession(
        _channel(display_name="General Chat"),
        {"On": _agent_row(enabled=True)},
        profiles={"On": SimpleNamespace(description="Helps with infra.")},
    )
    ctx = svc.build_attention_context(session, "c1")
    assert ctx is not None
    assert ctx.mode == "cascade"
    assert ctx.channel_label == "General Chat"
    assert ctx.llm == LlmTriageConfig(
        base_url="http://llm.local/v1", model="m1", api_key="sk-live"
    )
    assert ctx.candidates[0].description == "Helps with infra."


def test_build_context_cascade_keyless_endpoint(monkeypatch):
    """No stored key (e.g. Ollama) is a usable config with api_key=None."""
    monkeypatch.setattr(
        svc.TableRead,
        "get_org_lobstertalk_config",
        lambda session, org_id: _lt_config(
            mode="cascade", base_url="http://ollama.local:11434/v1", model="qwen3:4b"
        ),
    )
    _cascade_members(monkeypatch)
    session = _FakeSession(_channel(), {"On": _agent_row(enabled=True)})
    ctx = svc.build_attention_context(session, "c1")
    assert ctx is not None and ctx.llm is not None
    assert ctx.llm.api_key is None


def test_build_context_cascade_undecryptable_key_leaves_llm_none(monkeypatch):
    """A stored-but-undecryptable key (rotated secrets key) must NOT downgrade
    to a key-less client or to embedding mode: llm=None keeps the misconfig
    visible while consider_post fails open."""
    monkeypatch.setattr(
        svc.TableRead,
        "get_org_lobstertalk_config",
        lambda session, org_id: _lt_config(
            mode="cascade",
            base_url="http://llm.local/v1",
            model="m1",
            api_key_encrypted="not-a-fernet-token",
        ),
    )
    _cascade_members(monkeypatch)
    session = _FakeSession(_channel(), {"On": _agent_row(enabled=True)})
    ctx = svc.build_attention_context(session, "c1")
    assert ctx is not None
    assert ctx.mode == "cascade" and ctx.llm is None


def test_build_context_cascade_incomplete_config_leaves_llm_none(monkeypatch):
    """Cascade without base_url+model (only reachable via direct DB edits —
    the API validates) still snapshots cleanly with llm=None."""
    monkeypatch.setattr(
        svc.TableRead,
        "get_org_lobstertalk_config",
        lambda session, org_id: _lt_config(mode="cascade", base_url="http://llm.local/v1"),
    )
    _cascade_members(monkeypatch)
    session = _FakeSession(_channel(), {"On": _agent_row(enabled=True)})
    ctx = svc.build_attention_context(session, "c1")
    assert ctx is not None
    assert ctx.mode == "cascade" and ctx.llm is None


def test_build_context_embedding_skips_profile_lookup(monkeypatch):
    """Embedding mode must not pay the AgentProfile get — the description only
    feeds the triage prompt."""

    class _NoProfiles:
        def get(self, key):
            raise AssertionError("profile lookup should not run in embedding mode")

    monkeypatch.setattr(
        svc.TableRead, "get_org_lobstertalk_config", lambda session, org_id: _lt_config()
    )
    _cascade_members(monkeypatch)
    session = _FakeSession(
        _channel(), {"On": _agent_row(enabled=True)}, profiles=_NoProfiles()
    )
    ctx = svc.build_attention_context(session, "c1")
    assert ctx is not None
    assert ctx.candidates[0].description is None
