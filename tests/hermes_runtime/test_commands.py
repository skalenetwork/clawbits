"""The verified operator's native gateway commands reach Hermes's own handlers."""

from __future__ import annotations

import asyncio
import json
import os

import pytest
from fake_clawbits import OPERATOR_DM, OPERATOR_ID

LABEL = os.getenv("HERMES_RUNTIME_LABEL", "unpinned")


async def _hold_turn(gw, text: str = "work") -> dict:
    """Start an operator turn whose model call blocks until the fake releases it."""
    gw.fake.hold_model()
    requests = len(gw.fake.model_requests)
    post = gw.fake.post(text)
    await gw.wait_for(lambda: len(gw.fake.model_requests) > requests)
    return post


async def _command(gw, text: str, *markers: str) -> dict:
    """Post an operator command and wait for a reply containing any marker; the command post."""
    start = len(gw.fake.posts)
    post = gw.fake.post(text)
    await gw.wait_for(lambda: any(m in r for r in gw.replies(start) for m in markers))
    return post


async def _new_session(gw) -> dict:
    """/new, confirmed by the operator's /approve when Hermes asks for it; the last command post."""
    post = await _command(gw, "/new", "Confirm /new", "New session", "Session reset")
    if any("Confirm /new" in r for r in gw.replies(gw.fake.posts.index(post))):
        post = await _command(gw, "/approve", "New session", "Session reset")
    return post


async def _late_completion_is_dropped(gw) -> None:
    """Release the held turn with a scripted 'LATE' reply: never posted, nor in the next history."""
    start = len(gw.fake.posts)
    gw.fake.script("LATE")
    gw.fake.release_model()
    await asyncio.sleep(1.5)
    requests = len(gw.fake.model_requests)
    await gw.settled(gw.fake.post("next"))
    assert not any("LATE" in r for r in gw.replies(start)), gw.dump()
    assert "LATE" not in json.dumps(gw.fake.model_requests[requests:]), gw.dump()


def test_usage_and_model_reach_native_handlers(gateway):
    async def scenario(gw):
        await gw.settled(gw.fake.post("hello"))
        requests = len(gw.fake.model_requests)
        for command, marker in (("/usage", "Token Usage"), ("/model", "Current: ")):
            post = gw.fake.post(command)
            await gw.settled(post)
            replies = gw.replies(gw.fake.posts.index(post))
            assert any(marker in r for r in replies), gw.dump()
        assert len(gw.fake.model_requests) == requests, "native commands never reach the model"

    gateway(scenario)


def test_stop_interrupts_blocked_turn(gateway):
    async def scenario(gw):
        await _hold_turn(gw)
        stop = await _command(gw, "/stop", "Stopped")
        await gw.wait_for(lambda: gw.acked(stop))  # the stopped turn and /stop are settled
        await _late_completion_is_dropped(gw)

    gateway(scenario)


@pytest.mark.parametrize("interrupt", ["/stop", "/new"])
def test_restart_after_interrupt_replays_nothing(gateway, interrupt):
    async def scenario(gw):
        await _hold_turn(gw)
        stop = _command(gw, "/stop", "Stopped") if interrupt == "/stop" else _new_session(gw)
        command = await stop
        await gw.wait_for(lambda: gw.acked(command))
        gw.fake.script("LATE")
        requests, start = len(gw.fake.model_requests), len(gw.fake.posts)
        await gw.restart()
        await asyncio.sleep(1.5)
        assert len(gw.fake.model_requests) == requests, gw.dump()
        replayed = [r for r in gw.replies(start) if "LATE" in r or "stub reply" in r]
        assert not replayed, gw.dump()

    gateway(scenario)


def test_stop_works_while_snoozed(gateway):
    async def scenario(gw):
        await _hold_turn(gw)
        gw.fake.snoozed = True
        await gw.wait_for(lambda: gw.adapter._snoozed)
        requests, events = len(gw.fake.model_requests), len(gw.events)
        gw.fake.post("hello")
        await _command(gw, "/stop", "Stopped")
        # Snooze admits only the native command.
        assert [e.text for e in gw.events[events:]] == ["/stop"]
        assert len(gw.fake.model_requests) == requests
        gw.fake.snoozed = False
        await gw.wait_for(lambda: not gw.adapter._snoozed)
        await _late_completion_is_dropped(gw)

    gateway(scenario)


def test_new_creates_fresh_session(gateway):
    async def scenario(gw):
        await gw.settled(gw.fake.post("hello"))
        sessions = gw.sessions()
        await _new_session(gw)
        requests = len(gw.fake.model_requests)
        await gw.settled(gw.fake.post("after new"))
        messages = gw.fake.model_requests[requests]["messages"]
        history = [m for m in messages if m["role"] in ("user", "assistant")]
        assert not any("hello" in str(m.get("content")) for m in history), history
        assert gw.sessions() > sessions

    gateway(scenario)


def test_stale_completion_after_new_does_not_leak(gateway):
    async def scenario(gw):
        await _hold_turn(gw)
        await _new_session(gw)
        await _late_completion_is_dropped(gw)
        newest = gw.query("select id from sessions order by started_at desc limit 1")[0][0]
        rows = gw.query(f"select content from messages where session_id = '{newest}'")
        assert rows and not any("LATE" in str(content) for (content,) in rows), rows

    gateway(scenario)


# The native fix (87cd8a3c84) postdates the minimum Hermes (v2026.9.14).
@pytest.mark.xfail(LABEL == "min", raises=AssertionError, strict=True,
                   reason="parked internal wakes are discarded by /stop before 87cd8a3c84")
def test_stop_keeps_parked_internal_wake(gateway):
    async def scenario(gw):
        from gateway.config import Platform
        from gateway.platforms.base import MessageEvent
        from gateway.session import SessionSource

        await _hold_turn(gw)
        source = SessionSource(platform=Platform("clawbits"), chat_id=OPERATOR_DM, chat_type="dm",
                               user_id=str(OPERATOR_ID))
        wake = MessageEvent(text="[wake] background job finished", source=source, internal=True)
        await gw.adapter.handle_message(wake)
        await _command(gw, "/stop", "Stopped")
        gw.fake.release_model()
        await gw.wait_for(lambda: any("[wake]" in text for text in gw.user_inputs()), 10)

    gateway(scenario)


def test_cb_usage_is_left_to_the_server(gateway):
    async def scenario(gw):
        requests, start = len(gw.fake.model_requests), len(gw.fake.posts)
        gw.fake.post("/cb-usage")
        await gw.settled(gw.fake.post("hello"))
        assert gw.replies(start) == ["stub reply"], gw.dump()
        assert [e.text for e in gw.events] == ["hello"]
        assert len(gw.fake.model_requests) == requests + 1

    gateway(scenario)
