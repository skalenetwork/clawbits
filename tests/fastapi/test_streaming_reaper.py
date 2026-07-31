"""Reaper for abandoned ``streaming`` posts (``clawbits/fastapi/mm_maintenance.py``).

A streaming post only leaves that state through its owner's PATCH; an agent
that dies mid-stream leaves the row stuck, pinning its "generating…" presence
and freezing watermark-based consumers (the IronClaw channel never advances
past a non-published post). These tests drive one deterministic reap pass.
"""
from __future__ import annotations

import asyncio
from typing import Any

import pytest
from sqlalchemy import text
from sqlmodel import Session

from clawbits.fastapi.mm_maintenance import reap_stale_streaming_posts_once
from tests.fastapi.test_mattermost import _auth, _create_owned_agent, _write_headers


class FakeBus:
    """Captures the realtime fallout the reaper must emit."""

    def __init__(self) -> None:
        self.published: list[tuple[str, dict[str, Any]]] = []
        self.presence: list[tuple[str, str, str, str]] = []

    async def publish(self, topic: str, event: dict[str, Any]) -> None:
        self.published.append((topic, event))

    async def presence_set(self, channel_id, member_kind, member_id, status) -> None:
        self.presence.append((channel_id, member_kind, str(member_id), status))

    # The post-create endpoint touches these on the way in; no-ops suffice.
    async def presence_clear(self, *_args, **_kwargs) -> None:
        return None

    async def presence_snapshot(self, _channel_id: str):
        return []


@pytest.fixture
def fake_bus(monkeypatch: pytest.MonkeyPatch) -> FakeBus:
    from clawbits.realtime import bus as bus_module

    fake = FakeBus()
    monkeypatch.setattr(bus_module, "_bus", fake)
    return fake


def _make_channel(tc, agent: dict) -> str:
    r = tc.post(
        "/api/agentic/mm/channels",
        json={"name": "reap-lab", "channel_type": "public"},
        headers=_write_headers(tc, agent["api_key"]),
    )
    assert r.status_code == 200, r.text
    return r.json()["channel_id"]


def _make_streaming_post(tc, agent: dict, channel_id: str) -> int:
    r = tc.post(
        f"/api/agentic/mm/channels/{channel_id}/posts",
        json={"status": "streaming"},
        headers=_write_headers(tc, agent["api_key"]),
    )
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "streaming"
    return r.json()["post_id"]


def _backdate_post(engine, post_id: int, seconds: int) -> None:
    with Session(engine) as db:
        db.execute(
            text(
                "UPDATE mm_posts SET updated_at = now() - (:s * interval '1 second') "
                "WHERE post_id = :pid"
            ),
            {"s": seconds, "pid": post_id},
        )
        db.commit()


def _post_ids(tc, agent: dict, channel_id: str) -> list[int]:
    r = tc.get(
        f"/api/agentic/mm/channels/{channel_id}/posts",
        headers=_auth(agent["api_key"]),
    )
    assert r.status_code == 200, r.text
    return [p["post_id"] for p in r.json()["posts"]]


def test_reaper_deletes_only_stale_streaming_posts(test_client, _test_engine, fake_bus):
    agent = _create_owned_agent(test_client)
    ch = _make_channel(test_client, agent)

    # A published post, a stale stream, and a fresh (still-live) stream.
    r = test_client.post(
        f"/api/agentic/mm/channels/{ch}/posts",
        json={"message": "keep me"},
        headers=_write_headers(test_client, agent["api_key"]),
    )
    assert r.status_code == 200
    published = r.json()["post_id"]
    stale = _make_streaming_post(test_client, agent, ch)
    fresh = _make_streaming_post(test_client, agent, ch)
    _backdate_post(_test_engine, stale, 600)

    fake_bus.published.clear()
    fake_bus.presence.clear()
    assert asyncio.run(reap_stale_streaming_posts_once(_test_engine, ttl_seconds=300)) == 1

    ids = _post_ids(test_client, agent, ch)
    assert stale not in ids, "abandoned stream must be deleted"
    assert published in ids and fresh in ids, "healthy posts must survive"

    deleted_events = [
        ev for _, ev in fake_bus.published if ev.get("type") == "post.deleted"
    ]
    assert [ev["data"]["post_id"] for ev in deleted_events] == [stale]

    # The same agent still has a live stream in the channel — its
    # "generating…" presence is legitimate and must not be flipped.
    assert fake_bus.presence == []


def test_reaper_unsticks_presence_when_no_live_stream_remains(
    test_client, _test_engine, fake_bus
):
    agent = _create_owned_agent(test_client)
    ch = _make_channel(test_client, agent)
    stale = _make_streaming_post(test_client, agent, ch)
    _backdate_post(_test_engine, stale, 600)

    fake_bus.published.clear()
    fake_bus.presence.clear()
    assert asyncio.run(reap_stale_streaming_posts_once(_test_engine, ttl_seconds=300)) == 1

    assert fake_bus.presence == [(ch, "agent", agent["agent_id"], "online")]
    member_events = [
        ev for _, ev in fake_bus.published if ev.get("type") == "member.status"
    ]
    assert member_events and member_events[0]["data"]["status"] == "online"


def test_reaper_is_a_noop_without_stale_streams(test_client, _test_engine, fake_bus):
    agent = _create_owned_agent(test_client)
    ch = _make_channel(test_client, agent)
    fresh = _make_streaming_post(test_client, agent, ch)

    fake_bus.published.clear()
    assert asyncio.run(reap_stale_streaming_posts_once(_test_engine, ttl_seconds=300)) == 0
    assert fresh in _post_ids(test_client, agent, ch)
    assert fake_bus.published == []
