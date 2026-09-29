"""Where Clawbits framing lands (prompt vs transcript) and which events carry gateway control."""

from __future__ import annotations

from conftest import _text
from fake_clawbits import AGENT_ID

CONTEXT = "[Clawbits context]"


def _attention(post: dict) -> dict:
    return {"type": "lobstertalk.consider", "channel_id": post["channel_id"], "data": post}


def _user_rows(gw) -> list[str]:
    return [content for role, content in gw.transcript() if role == "user"]


def test_context_rides_channel_prompt_once(gateway):
    async def scenario(gw):
        texts = ["first question", "second question"]
        requests = len(gw.fake.model_requests)
        for text in texts:
            await gw.settled(gw.fake.post(text))
        assert len(gw.fake.model_requests) == requests + 2
        for request in gw.fake.model_requests[requests:]:
            system = "".join(
                _text(m["content"]) for m in request["messages"] if m["role"] == "system")
            assert system.count(CONTEXT) == 1, system
            assert f"You are the Clawbits agent {AGENT_ID}" in system
            others = [m for m in request["messages"] if m["role"] != "system"]
            assert not any(CONTEXT in _text(m.get("content")) for m in others), others
        assert _user_rows(gw) == texts
        stored = gw.query("select prompt from system_prompts")
        stored += gw.query("select system_prompt from sessions")
        assert stored and not any(CONTEXT in str(prompt) for (prompt,) in stored)

    gateway(scenario)


def test_event_trust_flags_by_source(gateway):
    async def scenario(gw):
        ids: dict[str, str] = {}
        for label, post in (
            ("operator_dm", lambda: gw.fake.post("hi")),
            ("operator_in_shared_channel",
             lambda: gw.fake.post(f"@{AGENT_ID} hi all", channel="pub")),
            ("forged_human", lambda: gw.fake.post("hi", human_id=8, name="Op")),
            ("agent_post", lambda: gw.fake.post("hi", agent_id="agent-y", name="agent-y")),
        ):
            posted = post()
            ids[label] = str(posted["post_id"])
            await gw.settled(posted)

        nudge = gw.fake.post("anyone around?", channel="pub", human_id=8, name="Bob")
        await gw.push_ws(_attention(nudge))
        ids["attention"] = str(nudge["post_id"])
        await gw.settled(nudge)

        await gw.stop()
        missed = gw.fake.post("while you were away")
        ids["catch_up"] = str(missed["post_id"])
        await gw.start()
        await gw.settled(missed)

        events = {e.message_id: e for e in gw.events}
        assert {label: events[i].allow_gateway_control for label, i in ids.items()} == {
            label: label == "operator_dm" for label in ids
        }
        assert all(e.internal is False and e.channel_prompt.startswith(CONTEXT) for e in gw.events)

    gateway.fake.inter_agent = True
    gateway(scenario)


def _note(gw, post: dict) -> tuple[str, str | None]:
    """(state, note) of the post's journal item."""
    journal = gw.adapter._journal
    item = journal.lane_item(journal.source("chat", post["channel_id"]), "post", post["post_id"])
    return item.state, item.note


def test_catch_up_never_executes_historical_commands(gateway):
    async def scenario(gw):
        await gw.settled(gw.fake.post("hello"))
        for missed in (["/usage", "/new", "please summarise", "/stop"], ["/usage"]):
            await gw.stop()
            posts = [gw.fake.post(text) for text in missed]
            sessions, requests = gw.sessions(), len(gw.fake.model_requests)
            events, start = len(gw.events), len(gw.fake.posts)
            await gw.start()
            await gw.settled(posts[-1])

            chat = [text for text in missed if not text.startswith("/")]
            assert gw.replies(start) == ["stub reply" for _ in chat], gw.dump()
            assert gw.sessions() == sessions
            triggers = [(e.text, e.allow_gateway_control) for e in gw.events[events:]]
            assert triggers == [(text, False) for text in chat]
            inputs = gw.user_inputs()[requests:]
            commands = [post for post in posts if post["message"].startswith("/")]
            assert len(inputs) == len(chat), inputs
            assert not any(post["message"] in text for post in commands for text in inputs), inputs
            assert {_note(gw, post) for post in commands} == {("ignored", "historical_command")}

    gateway(scenario)


def test_catch_up_and_attention_context_persisted_once_and_bounded(gateway):
    async def scenario(gw):
        await gw.settled(gw.fake.post("hello"))
        await gw.stop()
        gw.fake.post("x" * 1000)
        trigger = gw.fake.post("latest question")
        events = len(gw.events)
        await gw.start()
        await gw.settled(trigger)

        event = gw.events[events]
        assert event.text == "latest question"
        context = event.channel_context
        assert _user_rows(gw)[-1] == f"{context}\n\n[New message]\n{event.text}"
        assert _user_rows(gw)[-1].count("[Missed messages]") == 1
        assert "x" * 399 + "…" in context and "x" * 400 not in context, "each missed line is capped"

        nudge = gw.fake.post("anyone around?", channel="pub", human_id=8, name="Bob")
        await gw.push_ws(_attention(nudge))
        # An unaddressed post is acked without waiting for its attention turn.
        await gw.wait_for(lambda: any("[Attention]" in text for text in gw.user_inputs()))
        await gw.settled(nudge)
        row = _user_rows(gw)[-1]
        assert row.count("[Attention]") == 1 and row.endswith("[New message]\nanyone around?"), row

    gateway(scenario)


def test_identity_unavailable_denies_controls_keeps_chat(gateway):
    async def scenario(gw):
        requests, start = len(gw.fake.model_requests), len(gw.fake.posts)
        await gw.settled(gw.fake.post("/usage"))
        assert len(gw.fake.model_requests) == requests + 1 and "/usage" in gw.user_inputs()[-1]
        await gw.settled(gw.fake.post("hello"))
        assert gw.replies(start) == ["stub reply", "stub reply"], gw.dump()
        assert [e.allow_gateway_control for e in gw.events] == [False, False]

    gateway.fake.identity_status = 503
    gateway(scenario)
