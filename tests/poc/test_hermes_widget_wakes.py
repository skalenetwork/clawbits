"""The chat game wake loop for Hermes (extensions/hermes/widget_wakes.py) and its adapter glue: one
silent turn per move in the game's own session, catch-up, dedupe and backoff, the session-busy gate,
the silence gates and the game-start post. tests/hermes_runtime/test_widgets.py runs it in Hermes."""

from __future__ import annotations

import asyncio
import json
import sys
import types
from typing import Any

import pytest

from tests.poc.hermes_stubs import _drain, _load_hermes_module
from tests.poc.intake_fakes import FakeClawbits, FakeGateway, adapter_for, run

WIDGET = "0123456789abcdef0123456789abcdef"
OTHER = "fedcba9876543210fedcba9876543210"
GAME_CHAT = f"widget-{WIDGET}"


class Clock:
    """Monotonic time and timers the test advances by hand."""

    def __init__(self) -> None:
        self.t = 100.0
        self.timers: list[list[Any]] = []

    def now(self) -> float:
        return self.t

    def call_later(self, delay: float, run: Any) -> Any:
        timer = [self.t + delay, run, True]
        self.timers.append(timer)
        return lambda: timer.__setitem__(2, False)

    def advance(self, seconds: float) -> None:
        self.t += seconds
        for timer in [t for t in self.timers if t[2] and t[0] <= self.t]:
            timer[2] = False
            timer[1]()


def _view(rev: int = 1, **fields: Any) -> dict[str, Any]:
    return {"widget_id": WIDGET, "channel_id": "dm", "kind": "chess", "status": "active", "rev": rev,
            "seat": "white", "your_move": True, "text": "Board · hand A♠", "legal": [{"type": "move"}],
            "instructions": "Your move.", **fields}


class Loop:
    """A WidgetWakes with scripted reads, recorded dispatches and ends."""

    def __init__(self, mod: Any) -> None:
        self.mod, self.clock = mod.widget_wakes, Clock()
        self.views: dict[str, Any] = {WIDGET: _view()}
        self.dispatched: list[tuple[str, int, int]] = []
        self.ended: list[str] = []
        self.end_outcome: str | None = "deleted"
        self.hold: asyncio.Event | None = None
        self.dispatch_error: Exception | None = None
        self.flags = {"enabled": True, "snoozed": False, "paused": False}
        self.tasks: list[asyncio.Task[Any]] = []
        self.wakes = self.mod.WidgetWakes(
            read=self.read, dispatch=self.dispatch, ended=self.end, spawn=self.spawn,
            enabled=lambda: self.flags["enabled"], snoozed=lambda: self.flags["snoozed"],
            paused=lambda: self.flags["paused"], now=self.clock.now, call_later=self.clock.call_later,
        )

    async def read(self, widget_id: str) -> dict[str, Any]:
        view = self.views[widget_id]
        if isinstance(view, Exception):
            raise view
        return dict(view)

    async def dispatch(self, view: dict[str, Any], attempt: int) -> bool:
        self.dispatched.append((view["widget_id"], view["rev"], attempt))
        if self.hold is not None:
            await self.hold.wait()
        if self.dispatch_error is not None:
            raise self.dispatch_error
        return True

    async def end(self, widget_id: str) -> str | None:
        self.ended.append(widget_id)
        return self.end_outcome

    def spawn(self, coro: Any) -> asyncio.Task[Any]:
        task = asyncio.get_running_loop().create_task(coro)
        self.tasks.append(task)
        return task

    def offer(self, rev: int = 1, *, waiting: bool = True, status: str = "active", widget: str = WIDGET) -> None:
        self.wakes.offer(self.mod.WidgetSignal(widget, "dm", rev, "chess", "white", waiting, status), "ws")

    async def settle(self) -> None:
        while pending := [t for t in self.tasks if not t.done()]:
            await asyncio.gather(*pending)


def test_signals_parse_strictly() -> None:
    ww = _load_hermes_module().widget_wakes
    data = {"widget_id": WIDGET, "rev": 3, "kind": "poker", "seat": "red", "waiting": True, "status": "active"}
    assert ww.turn_signal("dm", data) == ww.WidgetSignal(WIDGET, "dm", 3, "poker", "red", True, "active")
    for bad in ({**data, "rev": "3"}, {**data, "rev": True}, {**data, "widget_id": ""}, {**data, "status": None}, "x"):
        assert ww.turn_signal("dm", bad) is None, bad
    assert ww.turn_signal(None, data) is None
    snapshot = {"channels": [
        {"channel_id": "dm", "widget_waiting": {"widget_id": WIDGET, "rev": 3, "kind": "chess", "seat": "white"}},
        {"channel_id": "pub", "widget_waiting": None}, {"channel_id": "x", "widget_waiting": {"rev": 1}},
    ]}
    assert ww.waiting_signals(snapshot) == [ww.WidgetSignal(WIDGET, "dm", 3, "chess", "white", True, "active")]
    summary = {"widget_id": WIDGET, "channel_id": "dm", "kind": "chess", "status": "active", "rev": 3,
               "seat": "white", "your_move": False}
    assert ww.summary_signal(summary).waiting is False


def test_one_wake_per_move_however_often_it_is_reported() -> None:
    loop = Loop(_load_hermes_module())

    async def scenario() -> None:
        for _ in range(3):
            loop.offer(1)
        await loop.settle()
        loop.offer(1)  # the snapshot again, after the turn
        await loop.settle()
        assert loop.dispatched == [(WIDGET, 1, 1)]
        loop.offer(0)  # older: ignored
        loop.views[WIDGET] = _view(2)
        loop.offer(2)
        await loop.settle()
        assert loop.dispatched == [(WIDGET, 1, 1), (WIDGET, 2, 1)]

    run(scenario())


def test_a_newer_rev_replaces_the_pending_wake_and_waits_for_the_running_one() -> None:
    loop = Loop(_load_hermes_module())
    loop.hold = asyncio.Event()

    async def scenario() -> None:
        loop.offer(1)
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        assert loop.dispatched == [(WIDGET, 1, 1)]
        loop.views[WIDGET] = _view(3)
        loop.offer(2)
        loop.offer(3)
        await asyncio.sleep(0.01)
        assert loop.dispatched == [(WIDGET, 1, 1)], "one wake per game at a time"
        loop.hold.set()
        await loop.settle()
        assert loop.dispatched == [(WIDGET, 1, 1), (WIDGET, 3, 1)]

    run(scenario())


def test_not_waiting_drops_the_pending_wake() -> None:
    loop = Loop(_load_hermes_module())
    loop.hold = asyncio.Event()

    async def scenario() -> None:
        loop.offer(1, widget=OTHER)  # unknown to read: keeps another task busy, irrelevant here
        loop.offer(1)
        await asyncio.sleep(0.01)
        loop.views[WIDGET] = _view(2)
        loop.offer(2)
        loop.offer(3, waiting=False)  # the opponent's move now
        loop.hold.set()
        await loop.settle()
        assert [d for d in loop.dispatched if d[0] == WIDGET] == [(WIDGET, 1, 1)]

    loop.views[OTHER] = RuntimeError("down")
    run(scenario())


def test_a_rev_is_woken_again_only_on_its_backoff() -> None:
    loop = Loop(_load_hermes_module())

    async def scenario() -> None:
        loop.offer(1)
        await loop.settle()
        for wait in (59, 1, 300, 900):
            loop.offer(1)  # reported again before the backoff: nothing
            loop.clock.advance(wait)
            await loop.settle()
        assert loop.dispatched == [(WIDGET, 1, 1), (WIDGET, 1, 2), (WIDGET, 1, 3), (WIDGET, 1, 4)]
        loop.clock.advance(3600)
        loop.offer(1)
        await loop.settle()
        assert len(loop.dispatched) == 4, "then not until the rev changes"

    run(scenario())


def test_the_read_at_dispatch_decides() -> None:
    mod = _load_hermes_module()
    loop = Loop(mod)

    async def scenario() -> None:
        loop.views[WIDGET] = _view(your_move=False)
        loop.offer(1)
        await loop.settle()
        assert loop.dispatched == []
        loop.views[WIDGET] = RuntimeError("HTTP 503")
        loop.offer(2)
        await loop.settle()
        assert loop.dispatched == [] and loop.ended == []
        loop.views[WIDGET] = mod.widget_wakes.GameGone(WIDGET)
        loop.offer(3)
        await loop.settle()
        assert loop.ended == [WIDGET]
        loop.views[WIDGET] = _view(4)
        loop.offer(4)
        await loop.settle()
        assert loop.dispatched == [] and loop.wakes.seated(WIDGET), "an ended game is never woken again"

    run(scenario())


def test_a_game_that_ends_while_its_move_waits_is_ended() -> None:
    mod = _load_hermes_module()
    loop = Loop(mod)
    loop.dispatch_error = mod.widget_wakes.GameGone(WIDGET)

    async def scenario() -> None:
        loop.offer(1)
        await loop.settle()
        assert loop.ended == [WIDGET] and loop.clock.timers == [], "ended, no retry"
        loop.dispatch_error = None
        loop.offer(2)
        await loop.settle()
        assert loop.dispatched == [(WIDGET, 1, 1)]

    run(scenario())


@pytest.mark.parametrize(("flag", "value"), [("snoozed", True), ("paused", True), ("enabled", False)])
def test_no_wake_while_snoozed_paused_or_off(flag: str, value: bool) -> None:
    loop = Loop(_load_hermes_module())
    loop.flags[flag] = value

    async def scenario() -> None:
        loop.offer(1)
        await loop.settle()
        assert loop.dispatched == []

    run(scenario())


def test_an_ended_game_is_cleaned_up_once_its_turns_are_over(monkeypatch) -> None:
    mod = _load_hermes_module()
    monkeypatch.setattr(mod.widget_wakes, "CLEANUP_RETRY_S", (0.0, 0.0, 0.0))
    loop = Loop(mod)
    loop.end_outcome = "busy"

    async def scenario() -> None:
        loop.offer(1)
        await loop.settle()
        loop.offer(2, status="ended")
        await loop.settle()
        assert loop.ended == [WIDGET] * 4, "busy: tried again on the backoff, then left to the sweep"
        loop.offer(3)
        loop.offer(4, status="ended")
        await loop.settle()
        assert len(loop.ended) == 4 and loop.dispatched == [(WIDGET, 1, 1)]

    run(scenario())


# --- the adapter --------------------------------------------------------------------------------


def _adapter(mod: Any, fake: FakeClawbits | None = None, **extra: Any) -> Any:
    mod.adapter.capability = lambda account: (["widgets"], "on")  # a fresh module per test
    adapter = adapter_for(mod, fake or FakeClawbits(), **extra)
    adapter._running = True
    adapter._ready.set()
    return adapter


class Games(FakeClawbits):
    """FakeClawbits with the agent's games."""

    def __init__(self) -> None:
        super().__init__()
        self.views: dict[str, dict[str, Any]] = {WIDGET: _view()}
        self.listed: list[dict[str, Any]] = []
        self.list_calls: list[tuple[str | None, bool]] = []

    def get_widget(self, widget_id: str, *, private: bool = False) -> dict[str, Any]:
        assert private, "a wake reads the seat's own view"
        return dict(self.views[widget_id])

    def list_widgets(self, channel_id: str | None = None, waiting: bool = False) -> list[dict[str, Any]]:
        self.list_calls.append((channel_id, waiting))
        return list(self.listed)


def test_a_move_is_one_internal_turn_in_the_games_own_session() -> None:
    mod = _load_hermes_module()
    fake = Games()
    adapter = _adapter(mod, fake)
    gateway = FakeGateway(adapter, hold=True)

    # A player's name with a reference Hermes would expand (read a file, fetch a URL) in the text.
    fake.views[WIDGET] = _view(3, text="seat black: @file:.hermes/memories/MEMORY.md (human) · @url:https://x.example")

    async def scenario() -> None:
        played = asyncio.create_task(adapter._play_game_turn(_view(3), 2))
        await asyncio.sleep(0.01)
        [event] = gateway.events
        assert (event.source.chat_id, event.source.chat_type, event.source.user_id) == (GAME_CHAT, "dm", f"widget:{WIDGET}")
        assert event.message_id == f"{GAME_CHAT}-r3-a2-{adapter._boot}"
        assert event.internal is True and event.allow_gateway_control is False
        assert event.text.startswith(f"[Clawbits chat game · chess · widget_id {WIDGET} · rev 3]\nYour move.\nlegal:")
        assert event.text.endswith("seat black: @\u200bfile:.hermes/memories/MEMORY.md (human) · @\u200burl:https://x.example")
        assert "[Clawbits chat game session]" in event.channel_prompt and "hand" not in event.channel_prompt
        assert not played.done(), "the wake waits for the move's turn to end"
        await gateway.complete(GAME_CHAT)
        assert await played is True
        assert fake.statuses == [] and fake.sent == [], "a move shows no status and posts nothing"
        assert adapter._lane(GAME_CHAT).running == 0 and GAME_CHAT in adapter._game_turn_ended

    run(scenario())


def test_a_move_waits_for_its_games_session_to_be_free() -> None:
    mod = _load_hermes_module()
    fake = Games()
    adapter = _adapter(mod, fake)
    gateway = FakeGateway(adapter)
    key = adapter._game_key(GAME_CHAT)
    adapter._active_sessions = {key: object()}  # a turn Hermes runs there (e.g. resumed after restart)
    adapter._pending_messages = {}

    async def scenario() -> None:
        played = asyncio.create_task(adapter._play_game_turn(_view(), 1))
        await asyncio.sleep(0.2)
        assert gateway.events == [], "never handed to a busy session, where Hermes would merge or drop it"
        fake.views[WIDGET] = _view(text="Board · hand A♠ · the opponent chatted")
        del adapter._active_sessions[key]
        assert await played is True
        [event] = gateway.events
        assert event.source.chat_id == GAME_CHAT and event.text.endswith("the opponent chatted"), "read again"

    run(scenario())


@pytest.mark.parametrize("now", ["moved", "newer", "ended", "gone", "snoozed", "memory_provider"])
def test_a_move_no_longer_due_after_its_wait_is_not_played(now: str) -> None:
    """Hermes resumed the game's session after a restart and made the move meanwhile; the game moved
    on, or ended; or games can no longer be played here."""
    mod = _load_hermes_module()
    fake = Games()
    adapter = _adapter(mod, fake)
    gateway = FakeGateway(adapter)
    key = adapter._game_key(GAME_CHAT)
    adapter._active_sessions = {key: object()}
    adapter._pending_messages = {}

    def get_widget(widget_id: str, *, private: bool = False) -> dict[str, Any]:
        if now == "gone":
            raise RuntimeError("HTTP 404: Widget not found")
        return {"moved": _view(2, your_move=False), "newer": _view(3), "ended": _view(2, status="ended")}.get(now, _view())

    async def scenario() -> None:
        played = asyncio.create_task(adapter._play_game_turn(_view(), 1))
        await asyncio.sleep(0.05)
        fake.get_widget = get_widget
        adapter._snoozed = now == "snoozed"
        mod.adapter.capability = lambda account: ([], "memory_provider") if now == "memory_provider" else (["widgets"], "on")
        del adapter._active_sessions[key]
        if now in ("ended", "gone"):
            with pytest.raises(mod.widget_wakes.GameGone):
                await played
        else:
            assert await played is False
        assert gateway.events == []

    mod.adapter.http_status = lambda exc: 404 if "404" in str(exc) else None
    run(scenario())


def test_a_human_message_never_shares_the_games_session() -> None:
    mod = _load_hermes_module()
    adapter = _adapter(mod, Games())
    dm = mod._Channel("dm", "direct", "DM")
    human = adapter._session_source(dm, {"human_id": 7, "post_id": 9})
    assert (human.chat_id, human.chat_type) == ("dm", "dm")
    assert adapter._game_source(GAME_CHAT, WIDGET).chat_id != human.chat_id
    assert adapter.toolsets_for_source(adapter._game_source(GAME_CHAT, WIDGET)) == ["clawbits", "no_mcp"]
    assert adapter.toolsets_for_source(human) is None


def test_everything_a_move_would_show_is_dropped() -> None:
    mod = _load_hermes_module()
    fake = Games()
    adapter = _adapter(mod, fake)
    adapter.set_status_text = mod.ClawbitsAdapter.set_status_text.__get__(adapter)
    adapter._loop = None

    async def scenario() -> None:
        assert (await adapter.send(GAME_CHAT, "my hand is A♠")).success
        assert (await adapter.send(GAME_CHAT, "", metadata={"expect_edits": True})).success
        assert (await adapter.send(GAME_CHAT, "💬 thinking about the queen")).success
        assert (await adapter.edit_message(GAME_CHAT, "game-1", "text", finalize=True)).success
        assert await adapter.delete_message(GAME_CHAT, "game-1") is True
        assert (await adapter.send_image(GAME_CHAT, "https://example.com/a.png")).success
        assert (await adapter.send_image_file(GAME_CHAT, "/tmp/a.png")).success
        await adapter._set_status_best_effort(GAME_CHAT, "generating")
        await adapter._set_activity_best_effort(GAME_CHAT, {"kind": "tool", "label": "x"})
        assert await adapter.get_chat_info(GAME_CHAT) == {"name": "Clawbits game", "type": "dm"}
        event = types.SimpleNamespace(source=types.SimpleNamespace(chat_id=GAME_CHAT), message_id="m")
        await adapter.on_processing_start(event)
        await adapter.on_processing_complete(event, mod.adapter.ProcessingOutcome.FAILURE)
        assert adapter._turns == {} and adapter._lane(GAME_CHAT).running == 0
        assert fake.statuses == [] and fake.sent == []

    run(scenario())


def test_ws_widget_turn_and_resync_required_reach_the_wake_loop(monkeypatch) -> None:
    mod = _load_hermes_module()
    fake = Games()
    fake.listed = [{"widget_id": OTHER, "channel_id": "dm", "kind": "chess", "status": "active", "rev": 2,
                    "seat": "white", "your_move": True}]
    adapter = _adapter(mod, fake)
    offered: list[tuple[str, int, str]] = []
    adapter._widget_wakes.offer = lambda signal, source: offered.append((signal.widget_id, signal.rev, source))
    adapter._full_pass_at = 1e12
    events = [
        {"type": "widget.turn", "channel_id": "dm", "data": {"widget_id": WIDGET, "rev": 5, "kind": "chess",
                                                             "seat": "white", "waiting": True, "status": "active"}},
        {"type": "widget.turn", "channel_id": "dm", "data": {"rev": 5}},  # malformed: ignored
        {"type": "resync_required", "reason": "queue_full"},
    ]

    class Socket:
        async def __aenter__(self) -> Socket:
            return self

        async def __aexit__(self, *exc: Any) -> None:
            return None

        def __aiter__(self):
            return self._messages()

        async def _messages(self):
            for event in events:
                yield json.dumps(event)
            await asyncio.gather(*list(adapter._handoffs))
            adapter._running = False

    monkeypatch.setitem(sys.modules, "websockets", types.SimpleNamespace(connect=lambda *a, **k: Socket()))
    run(adapter._lobstertalk_ws_loop())
    assert offered == [(WIDGET, 5, "ws"), (OTHER, 2, "list")]
    assert fake.list_calls == [(None, True)], "resync_required reads ?waiting=1"
    assert adapter._full_pass_at == 0.0 and adapter._wake_event.is_set(), "and forces a full pass"


def test_the_channel_list_catches_up_waiting_games() -> None:
    mod = _load_hermes_module()
    adapter = _adapter(mod, Games())
    offered: list[tuple[str, str]] = []
    adapter._widget_wakes.offer = lambda signal, source: offered.append((signal.widget_id, source))
    adapter._apply_controls({"channels": [
        {"channel_id": "dm", "type": "direct", "widget_waiting": {"widget_id": WIDGET, "rev": 2, "kind": "chess", "seat": "white"}},
        {"channel_id": "pub", "type": "public"},
    ]})
    assert offered == [(WIDGET, "snapshot")]


def test_a_game_start_post_is_skipped_not_answered() -> None:
    mod = _load_hermes_module()
    adapter = _adapter(mod, Games())
    dm, pub = mod._Channel("dm", "direct", "DM"), mod._Channel("pub", "public", "pub")
    start = {"post_id": 3, "human_id": 7, "message": "Ann started a game of chess", "widget_id": WIDGET}
    assert adapter._skip_reason(dm, start) == "game_start"
    assert adapter._skip_reason(pub, {**start, "message": "@agent go"}) is None, "no game it sits in"
    adapter._widget_wakes.offer(mod.widget_wakes.WidgetSignal(WIDGET, "pub", 1, "chess", "white", False, "active"), "ws")
    assert adapter._skip_reason(pub, {**start, "message": "@agent go"}) == "game_start", "a game it sits in"
    assert adapter._skip_reason(dm, {"post_id": 4, "human_id": 7, "message": "hi"}) is None


def test_the_alive_ping_carries_the_capability(monkeypatch) -> None:
    mod = _load_hermes_module()
    pings: list[Any] = []
    fake = Games()
    fake.alive = lambda capabilities=None: pings.append(capabilities)
    adapter = _adapter(mod, fake)
    monkeypatch.setattr(mod.adapter, "capability", lambda account: (["widgets"], "on"))
    adapter._alive()
    monkeypatch.setattr(mod.adapter, "capability", lambda account: ([], "memory_provider"))
    adapter._alive()
    assert pings == [["widgets"], []]
    assert adapter._health.doc["subsystems"]["widgets"]["state"] == "memory_provider"


def test_a_seated_game_stops_waking_once_the_capability_is_lost(monkeypatch) -> None:
    """The server seats by the capability, then keeps waking: an external memory provider set
    mid-game (it would mirror every move's brief) or a removed toolset stops the moves here."""
    mod = _load_hermes_module()
    fake = Games()
    fake.alive = lambda capabilities=None: None
    adapter = _adapter(mod, fake)
    gateway = FakeGateway(adapter)
    signal = mod.widget_wakes.WidgetSignal(WIDGET, "dm", 1, "chess", "white", True, "active")

    async def scenario() -> None:
        assert adapter._games_on(), "no check has run yet: a move's own check decides"
        monkeypatch.setattr(mod.adapter, "capability", lambda account: ([], "memory_provider"))
        adapter._alive()
        adapter._widget_wakes.offer(signal, "ws")
        await asyncio.gather(*list(adapter._handoffs))
        assert gateway.events == [] and not adapter._games_on()
        monkeypatch.setattr(mod.adapter, "capability", lambda account: (["widgets"], "on"))
        adapter._alive()
        adapter._widget_wakes.offer(signal, "ws")
        await asyncio.sleep(0.05)
        assert [e.source.chat_id for e in gateway.events] == [GAME_CHAT]
        await asyncio.gather(*list(adapter._handoffs))

    run(scenario())


def test_a_retired_generation_is_deleted_while_the_game_plays_on(monkeypatch) -> None:
    mod = _load_hermes_module()
    adapter = _adapter(mod, Games())
    deleted: list[Any] = []
    monkeypatch.setattr(adapter._game_sessions, "delete", lambda wid, gens, busy: deleted.append(gens) or "deleted")
    now = mod.adapter.time.monotonic()
    adapter._game_turn_ended = {GAME_CHAT: now - 60, f"{GAME_CHAT}.g1": now, f"widget-{OTHER}": now - 60}

    async def scenario() -> None:
        assert await adapter._delete_game_sessions(WIDGET, None) == "busy", "the game's last turn just ended"
        assert await adapter._delete_game_sessions(WIDGET, [1]) == "busy"
        assert await adapter._delete_game_sessions(WIDGET, [0]) == "deleted", "its own last turn is old"

    run(scenario())
    assert deleted == [[0]]
    assert sorted(adapter._game_turn_ended) == [f"{GAME_CHAT}.g1", f"widget-{OTHER}"]


def test_the_sweep_deletes_only_games_no_longer_active(monkeypatch) -> None:
    mod = _load_hermes_module()
    fake = Games()
    fake.listed = [{"widget_id": WIDGET}]
    adapter = _adapter(mod, fake)
    deleted: list[tuple[str, Any]] = []
    monkeypatch.setattr(adapter._game_sessions, "games", lambda: {WIDGET: {0, 1, 2}, OTHER: {0}})
    monkeypatch.setattr(
        adapter._game_sessions, "delete", lambda wid, gens, busy: deleted.append((wid, gens)) or "deleted"
    )

    async def scenario() -> None:
        adapter._maybe_sweep_games()
        adapter._maybe_sweep_games()  # single-flight, and not due again for a while
        await _drain(adapter)
        await asyncio.gather(*list(adapter._handoffs))

    run(scenario())
    assert deleted == [(WIDGET, [0, 1]), (OTHER, None)]
