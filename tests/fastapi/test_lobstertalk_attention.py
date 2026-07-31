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


def _run(
    monkeypatch,
    *,
    post,
    context,
    author_agent_id,
    verdict=Verdict(True, "needs_attention", 0.9),
    on_cooldown=False,
):
    delivered: list[str] = []
    monkeypatch.setattr(svc, "evaluate_text", lambda text: verdict)

    async def fake_claim(agent_id, channel_id):
        return not on_cooldown

    async def fake_deliver(agent_id, *a):
        delivered.append(agent_id)
        return True  # landed — no cooldown refund

    monkeypatch.setattr(svc, "_claim_cooldown", fake_claim)
    monkeypatch.setattr(svc, "_deliver", fake_deliver)
    asyncio.run(
        consider_post(
            post=post, channel_id="c1", context=context, author_agent_id=author_agent_id
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

    def fake_consider(*, post, channel_id, context, author_agent_id):
        calls.update(
            post_id=post.get("post_id"),
            channel_id=channel_id,
            context=context,
            author_agent_id=author_agent_id,
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

    def fake_consider(*, post, channel_id, context, author_agent_id):
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


# --- build_attention_context: the per-agent lobstertalk_enabled gate ----------


class _FakeSession:
    """Minimal Session stand-in: routes ``get`` by model name."""

    def __init__(self, channel, agents):
        self._channel = channel
        self._agents = agents

    def get(self, model, key):
        return self._channel if model.__name__ == "MmChannel" else self._agents.get(key)


def _agent_row(*, enabled, snoozed=False, inter_agent=False):
    return SimpleNamespace(
        lobstertalk_enabled=enabled,
        snoozed=snoozed,
        inter_agent_mode_enabled=inter_agent,
    )


def test_build_context_only_includes_lobstertalk_enabled_agents(monkeypatch):
    channel = SimpleNamespace(channel_type="public", org_id="o1")
    agents = {"On": _agent_row(enabled=True), "Off": _agent_row(enabled=False)}
    monkeypatch.setattr(svc.TableRead, "get_org_attention_enabled", lambda session, org_id: True)
    monkeypatch.setattr(
        svc.TableRead,
        "get_mm_channel_members",
        lambda session, cid: [{"agent_id": "On"}, {"agent_id": "Off"}, {"agent_id": None}],
    )
    ctx = svc.build_attention_context(_FakeSession(channel, agents), "c1")
    assert ctx is not None
    assert [c.agent_id for c in ctx.candidates] == ["On"]


def test_build_context_none_when_no_agent_enabled(monkeypatch):
    channel = SimpleNamespace(channel_type="public", org_id="o1")
    agents = {"Off": _agent_row(enabled=False)}
    monkeypatch.setattr(svc.TableRead, "get_org_attention_enabled", lambda session, org_id: True)
    monkeypatch.setattr(
        svc.TableRead,
        "get_mm_channel_members",
        lambda session, cid: [{"agent_id": "Off"}],
    )
    assert svc.build_attention_context(_FakeSession(channel, agents), "c1") is None


def test_build_context_none_when_org_not_enabled(monkeypatch):
    """The org-level opt-in is the product switch: off → None, before any member
    enumeration (which is stubbed to blow up if reached)."""
    channel = SimpleNamespace(channel_type="public", org_id="o1")
    monkeypatch.setattr(svc.TableRead, "get_org_attention_enabled", lambda session, org_id: False)

    def _boom(session, cid):
        raise AssertionError("member enumeration should not run when the org is disabled")

    monkeypatch.setattr(svc.TableRead, "get_mm_channel_members", _boom)
    assert svc.build_attention_context(_FakeSession(channel, {}), "c1") is None


def test_build_context_none_when_channel_has_no_org(monkeypatch):
    """A legacy/org-less channel (org_id None) can't opt in → None."""
    channel = SimpleNamespace(channel_type="public", org_id=None)
    assert svc.build_attention_context(_FakeSession(channel, {}), "c1") is None


def test_build_context_none_for_dm(monkeypatch):
    channel = SimpleNamespace(channel_type="direct")
    ctx = svc.build_attention_context(_FakeSession(channel, {}), "c1")
    assert ctx is None
