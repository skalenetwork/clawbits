"""Trust contract for plugin-built MessageEvents (package A).

``allow_gateway_control`` is True only for a live post by the verified operator
(``human_id == agent_info.operator_id``, no ``agent_id``) in the canonical
operator DM; every other source stays conversational. tests/hermes_runtime
covers the same contract against the real gateway.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import types
from pathlib import Path
from typing import Any

import pytest

from tests.poc.hermes_stubs import _drain, _FakePlatformConfig, _load_hermes_module
from tests.poc.intake_fakes import FakeClawbits, idle, pump

OPERATOR = 1


@pytest.fixture(autouse=True)
def _greeted() -> None:
    home = Path(os.environ["HERMES_HOME"])
    home.mkdir(parents=True, exist_ok=True)
    (home / ".clawbits_greeted").touch()


class _Client(FakeClawbits):
    """Fake Clawbits: operator identity lookups (counted) plus the calls intake makes."""

    def __init__(self, *, operator_id: Any = OPERATOR, operator_channel: Any = "dm", fail=False):
        super().__init__({})
        self.operator_id = operator_id
        self.operator_channel_id = operator_channel
        self.fail = fail
        self.info_calls = 0
        self.channel_calls = 0

    def agent_info(self, agent_id: str) -> dict[str, Any]:
        self.info_calls += 1
        if self.fail:
            raise RuntimeError("HTTP 503: unavailable")
        return {} if self.operator_id is None else {"operator_id": self.operator_id}

    def operator_channel(self, agent_id: str) -> str | None:
        self.channel_calls += 1
        return self.operator_channel_id


def _adapter(mod, client: _Client | None = None, **extra: Any):
    cfg = _FakePlatformConfig(extra={"api_key": "key", "agent_id": "agent", **extra})
    adapter = mod.ClawbitsAdapter(cfg)
    adapter.client = client or _Client()
    return adapter


_serial = iter(range(100, 10_000))


def _post(message: str, **fields: Any) -> dict[str, Any]:
    serial = next(_serial)
    created = f"2026-06-04 12:{serial // 60 % 60:02d}:{serial % 60:02d}"
    return {"post_id": serial, "created_at": created, "message": message, **fields}


def _dispatch(adapter, channel, *posts: dict[str, Any]) -> list[Any]:
    """Deliver live posts in ``channel`` through the journal intake (sources created first)."""
    client = adapter.client
    client.types.setdefault(channel.id, channel.channel_type)
    client.posts.setdefault(channel.id, [])

    async def run() -> None:
        assert await adapter._open_journal()
        await pump(adapter, passes=1)
        client.posts[channel.id].extend({**post, "channel_id": channel.id} for post in posts)
        await pump(adapter, passes=len(posts) + 1)
        await _drain(adapter)

    asyncio.run(run())
    return adapter.events


def test_operator_dm_post_gets_gateway_control() -> None:
    mod = _load_hermes_module()
    adapter = _adapter(mod)
    dm = mod._Channel("dm", "direct", "DM")
    events = _dispatch(adapter, dm, _post("/stop", human_id=OPERATOR))

    assert len(events) == 1
    assert events[0].text == "/stop"
    assert events[0].allow_gateway_control is True
    assert events[0].internal is False
    assert events[0].channel_prompt == mod._clawbits_channel_prompt("dm", "agent")
    assert events[0].channel_context is None


@pytest.mark.parametrize(
    "case",
    [
        "forged_human",
        "operator_in_shared_channel",
        "operator_in_agent_chat",
        "agent_chat_named_as_operator_channel",
        "agent_post",
        "fallback_channel_not_canonical",
        "identity_lookup_fails",
        "no_operator_id",
    ],
)
def test_gateway_control_denied_for_untrusted_sources(case: str) -> None:
    mod = _load_hermes_module()
    dm = mod._Channel("dm", "direct", "DM")
    channel, post, client, extra = dm, _post("/stop", human_id=OPERATOR), _Client(), {}
    if case == "forged_human":
        post = _post("/stop", human_id=8, poster_display_name="Op")
    elif case == "operator_in_shared_channel":
        channel = mod._Channel("pub", "public", "General")
        post = _post("@agent /stop", human_id=OPERATOR)
    elif case == "operator_in_agent_chat":
        channel = mod._Channel("session-1", "agent_chat", "Session")
    elif case == "agent_chat_named_as_operator_channel":
        channel = mod._Channel("session-1", "agent_chat", "Session")
        client = _Client(operator_channel="session-1")
    elif case == "agent_post":
        post = _post("/stop", human_id=OPERATOR, agent_id="peer")
    elif case == "fallback_channel_not_canonical":
        channel, extra = mod._Channel("dm2", "direct", "Other"), {"channel_id": "dm2"}
    elif case == "identity_lookup_fails":
        client = _Client(fail=True)
    elif case == "no_operator_id":
        client = _Client(operator_id=None)
    adapter = _adapter(mod, client, **extra)
    client.inter_agent = True

    events = _dispatch(adapter, channel, post)

    assert len(events) == 1, "untrusted sources still chat; they only lose control"
    assert events[0].allow_gateway_control is False
    assert events[0].internal is False


@pytest.mark.parametrize(
    ("kind", "message", "control"), [("direct", "/stop", True), ("public", "@agent /stop", False)]
)
def test_realtime_post_control_needs_the_listed_operator_dm(kind: str, message: str, control: bool):
    mod = _load_hermes_module()
    adapter = _adapter(mod)
    client = adapter.client
    client.types["dm"], client.posts["dm"] = kind, []

    async def run() -> None:
        assert await adapter._open_journal()
        await pump(adapter, passes=1)
        created = {"type": "post.created", "channel_id": "dm", "data": client.post(message)}
        await adapter._dispatch_realtime_post(created)
        await adapter._poll_once(await adapter._next_wake())
        await idle(adapter)

    asyncio.run(run())
    events = [(event.text, event.allow_gateway_control) for event in adapter.events]
    assert events == [("/stop", control)], "the WebSocket post only wakes the forward read"


def test_operator_identity_is_cached_and_invalidated(monkeypatch) -> None:
    mod = _load_hermes_module()
    client = _Client()
    adapter = _adapter(mod, client)
    dm = mod._Channel("dm", "direct", "DM")

    _dispatch(adapter, dm, _post("one", human_id=OPERATOR), _post("two", human_id=OPERATOR))
    assert (client.info_calls, client.channel_calls) == (1, 1)

    monkeypatch.setattr(mod.adapter, "_OPERATOR_TTL_SECONDS", 0.0)
    _dispatch(adapter, dm, _post("three", human_id=OPERATOR))
    assert (client.info_calls, client.channel_calls) == (2, 2), "an expired identity is refetched"
    assert all(event.allow_gateway_control for event in adapter.events)

    monkeypatch.setattr(mod.adapter, "_OPERATOR_TTL_SECONDS", 300.0)
    client.fail = True
    adapter._operator = None
    _dispatch(adapter, dm, _post("four", human_id=OPERATOR), _post("five", human_id=OPERATOR))
    assert client.info_calls == 4, "a failed lookup is not cached"
    assert adapter._operator is None


def test_ws_snapshot_invalidates_the_operator_identity(monkeypatch) -> None:
    mod = _load_hermes_module()
    adapter = _adapter(mod)
    adapter._operator = ("1", "dm", 0.0)

    class FakeSocket:
        async def __aenter__(self) -> FakeSocket:
            return self

        async def __aexit__(self, *exc: Any) -> None:
            return None

        def __aiter__(self):
            return self._messages()

        async def _messages(self):
            yield json.dumps({"type": "snapshot", "data": {"snoozed": True}})
            adapter._running = False

    socket = types.SimpleNamespace(connect=lambda *a, **k: FakeSocket())
    monkeypatch.setitem(sys.modules, "websockets", socket)
    adapter._running = True
    asyncio.run(adapter._lobstertalk_ws_loop())

    assert adapter._operator is None
    assert adapter._snoozed is True


def test_snoozed_admits_only_verified_operator_native_commands() -> None:
    mod = _load_hermes_module()
    adapter = _adapter(mod)
    adapter.client.snoozed = True
    dm = mod._Channel("dm", "direct", "DM")

    events = _dispatch(
        adapter,
        dm,
        _post("hello", human_id=OPERATOR),
        _post("/nosuch", human_id=OPERATOR),
        _post("/stop", human_id=8),
        _post("/stop", human_id=OPERATOR),
    )

    assert [(event.text, event.allow_gateway_control) for event in events] == [("/stop", True)]


def test_catch_up_never_gets_gateway_control_nor_runs_a_command() -> None:
    mod = _load_hermes_module()
    client = _Client()
    client.types["dm"], client.posts["dm"] = "direct", []
    client.post("/stop", serial=11)
    client.post("restart the build", serial=12)
    client.pointers["dm"] = 10
    adapter = _adapter(mod, client)

    async def run() -> None:
        assert await adapter._open_journal()
        await pump(adapter, passes=2)
        await _drain(adapter)

    asyncio.run(run())
    [event] = adapter.events
    assert (event.text, event.allow_gateway_control) == ("restart the build", False)
    assert event.channel_context is None
    stop = adapter._journal.lane_item(adapter._journal.source("chat", "dm"), "post", 11)
    assert (stop.state, stop.note) == ("ignored", "historical_command")
    assert client.info_calls == 0, "a replayed post is never even considered for control"


def test_cb_usage_in_dm_is_left_to_the_server() -> None:
    mod = _load_hermes_module()
    adapter = _adapter(mod)
    dm = mod._Channel("dm", "direct", "DM")
    usage = _post("/cb-usage", human_id=OPERATOR)

    assert _dispatch(adapter, dm, usage) == [], "the server answers /cb-usage in DMs"
    assert adapter._skip_reason(dm, _post(" /CB-usage ", human_id=OPERATOR)) == "server_command"

    pub = mod._Channel("pub", "public", "General")
    events = _dispatch(adapter, pub, _post("@agent /cb-usage", human_id=OPERATOR))
    assert [event.text for event in events] == ["/cb-usage"]
    assert events[0].allow_gateway_control is False
