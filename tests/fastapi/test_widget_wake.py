"""Waking an agent for its games: a ``widget.turn`` on its own topic at every change (ids only, once
per rev, within a daily budget), the game waiting on it in its channel list and WS snapshot for the
wakes it missed, and the hour a person waits on a stalled agent before the reaper ends the game."""

import asyncio
import logging
import queue
import time
from datetime import UTC, datetime, timedelta

import pytest
from sqlmodel import Session
from starlette.testclient import TestClient

from clawbits.db.models import MmWidget
from clawbits.db.table_read import TableRead
from clawbits.fastapi.widget_endpoints import publish_widget
from clawbits.realtime.bus import agent_topic, channel_topic
from clawbits.widgets import limits
from tests.fastapi._auth_helpers import auth_headers
from tests.fastapi.test_agent_widgets import _begin, _setup
from tests.fastapi.test_agentic_widgets import _acted, _human_move, _row
from tests.fastapi.test_widgets import _FakeBus
from tests.fastapi.test_widgets import _game as _people_game

_E4 = {"type": "move", "args": {"move": "e4"}}
_E5 = {"type": "move", "args": {"move": "e5"}}


def _bus(monkeypatch, fake: _FakeBus | None = None) -> _FakeBus:
    from clawbits.realtime import bus as bus_module

    fake = fake or _FakeBus()
    monkeypatch.setattr(bus_module, "_bus", fake)
    return fake


def _game(
    tc: TestClient, monkeypatch, prefix: str, kind: str = "chess", seat: str = "white"
) -> tuple[dict, dict, str, str, _FakeBus]:
    """Bob takes ``seat`` against the agent in their DM, every event from the start on a fake bus."""
    _, bob, agent, _, dm = _setup(tc, prefix)
    fake = _bus(monkeypatch)
    r = _begin(tc, bob, dm, kind, seat)
    assert r.status_code == 201, r.text
    return bob, agent, dm, r.json()["widget_id"], fake


def _wakes(fake: _FakeBus, agent: dict, count: int) -> list[dict]:
    """The ``widget.turn`` events on the agent's topic, once ``count`` arrived and a beat passed for
    any extra one to show."""
    topic = agent_topic(agent["agent_id"])

    def found() -> list[dict]:
        return [e for t, e in fake.published if t == topic and e["type"] == "widget.turn"]

    deadline = time.monotonic() + 2
    while len(found()) < count and time.monotonic() < deadline:
        time.sleep(0.01)
    time.sleep(0.1)
    return found()


def _revs(wakes: list[dict]) -> list[tuple[int, bool, str]]:
    """Each wake's rev, whether it waits on the agent, and the status, by rev: publishes of
    back-to-back changes may land out of order."""
    return sorted((w["data"]["rev"], w["data"]["waiting"], w["data"]["status"]) for w in wakes)


def _public(tc: TestClient, widget_id: str) -> dict:
    with Session(tc.app._engine) as db:
        widget = TableRead.get_mm_widget(db, widget_id)
    assert widget is not None
    return widget


def test_a_persons_move_wakes_the_agent_with_ids_only(test_client, monkeypatch):
    bob, agent, dm, widget_id, fake = _game(test_client, monkeypatch, "wkmove")
    assert _revs(_wakes(fake, agent, 1)) == [(0, False, "active")]  # White (Bob) moves first
    fake.published.clear()
    _human_move(test_client, bob, widget_id, _E4)
    assert _wakes(fake, agent, 1) == [
        {
            "type": "widget.turn",
            "channel_id": dm,
            "data": {
                "widget_id": widget_id,
                "rev": 1,
                "kind": "chess",
                "seat": "black",
                "waiting": True,
                "status": "active",
            },
        }
    ]
    # The person's own "your move" is unchanged beside it.
    humans = [e["data"] for t, e in fake.published if t.startswith("human:") and e["type"] == "widget.turn"]
    assert humans == [{"my_turn": False, "widget_id": widget_id, "rev": 1}]


def test_the_agents_own_chess_move_wakes_it_as_no_longer_waiting(test_client, monkeypatch):
    bob, agent, _, widget_id, fake = _game(test_client, monkeypatch, "wkself")
    _human_move(test_client, bob, widget_id, _E4)
    assert len(_wakes(fake, agent, 2)) == 2
    fake.published.clear()
    assert _acted(test_client, agent, widget_id, _E5)["your_move"] is False
    assert _revs(_wakes(fake, agent, 1)) == [(2, False, "active")]


def test_a_battleship_hit_wakes_the_agent_to_shoot_again(test_client, monkeypatch):
    bob, agent, _, widget_id, fake = _game(test_client, monkeypatch, "wkhit", "battleship", "blue")
    _acted(test_client, agent, widget_id, {"type": "ready"}, private=1)
    _human_move(test_client, bob, widget_id, {"type": "ready"})
    # Both fleets placing (rev 0), the agent's ready (rev 1), Bob's (rev 2): Red shoots first.
    assert _revs(_wakes(fake, agent, 3)) == [(0, True, "active"), (1, False, "active"), (2, True, "active")]
    fleet = _row(test_client, widget_id).state["fleets"]["blue"]
    ship = next(ship for ship in fleet if len(ship) > 1)
    fake.published.clear()
    hit = _acted(test_client, agent, widget_id, {"type": "fire", "args": {"at": ship[0]}}, private=1)
    assert hit["your_move"] is True
    assert _revs(_wakes(fake, agent, 1)) == [(3, True, "active")]


@pytest.mark.parametrize(("action", "status"), [("resign", "finished"), ("end", "aborted")])
def test_an_ending_wakes_the_agent_to_stop_waiting(test_client, monkeypatch, action, status):
    bob, agent, dm, widget_id, fake = _game(test_client, monkeypatch, f"wkend-{action}")
    _human_move(test_client, bob, widget_id, _E4)
    assert len(_wakes(fake, agent, 2)) == 2
    fake.published.clear()
    _human_move(test_client, bob, widget_id, {"type": action})
    (wake,) = _wakes(fake, agent, 1)
    assert (wake["channel_id"], wake["data"]["widget_id"]) == (dm, widget_id)
    assert _revs([wake]) == [(2, False, status)]


def test_an_agent_is_woken_once_per_rev(test_client, monkeypatch):
    bob, agent, _, widget_id, fake = _game(test_client, monkeypatch, "wkonce")
    _human_move(test_client, bob, widget_id, _E4)
    assert _revs(_wakes(fake, agent, 2)) == [(0, False, "active"), (1, True, "active")]
    # The same rev published again (a retry, a second path): the chat hears it, the agent doesn't.
    asyncio.run(publish_widget(fake, _public(test_client, widget_id)))
    assert len(_wakes(fake, agent, 3)) == 2
    updates = [e["data"]["rev"] for _, e in fake.published if e["type"] == "widget.updated"]
    assert sorted(updates) == [0, 1, 1]


def test_the_daily_budget_stops_wakes_but_not_the_game(test_client, monkeypatch, caplog):
    monkeypatch.setattr(limits, "AGENT_DAILY_WAKES", 2)
    bob, agent, _, widget_id, fake = _game(test_client, monkeypatch, "wkbudget")
    _human_move(test_client, bob, widget_id, _E4)
    assert len(_wakes(fake, agent, 2)) == 2  # the budget's two
    caplog.set_level(logging.WARNING, logger="clawbits.fastapi.widget_endpoints")
    assert _acted(test_client, agent, widget_id, _E5)["ok"] is True
    deadline = time.monotonic() + 2
    while "past its daily widget wakes" not in caplog.text and time.monotonic() < deadline:
        time.sleep(0.01)
    assert f"agent {agent['agent_id']} is past its daily widget wakes" in caplog.text
    assert _revs(_wakes(fake, agent, 2)) == [(0, False, "active"), (1, True, "active")]
    # Bob still hears it's his move.
    humans = [e["data"] for t, e in fake.published if t.startswith("human:") and e["type"] == "widget.turn"]
    assert {"my_turn": True, "widget_id": widget_id, "rev": 2} in humans


def test_a_wake_nobody_hears_is_logged(test_client, monkeypatch, caplog):
    class _Nobody(_FakeBus):
        async def publish(self, topic: str, event: dict) -> int:
            await super().publish(topic, event)
            return 0

    caplog.set_level(logging.INFO, logger="clawbits.fastapi.widget_endpoints")
    bob, agent, _, widget_id, _ = _game(test_client, monkeypatch, "wknobody")
    fake = _bus(monkeypatch, _Nobody())
    _human_move(test_client, bob, widget_id, _E4)
    assert len(_wakes(fake, agent, 1)) == 1
    assert f"agent {agent['agent_id']} has no live socket for widget {widget_id} rev 1" in caplog.text


def _channel_waiting(tc: TestClient, agent: dict) -> dict[str, dict | None]:
    r = tc.get("/api/agentic/mm/channels", headers=auth_headers(agent["api_key"]))
    assert r.status_code == 200, r.text
    return {c["channel_id"]: c["widget_waiting"] for c in r.json()["channels"]}


def _snapshot_waiting(tc: TestClient, agent: dict) -> dict[str, dict | None]:
    with tc.websocket_connect(f"/api/agentic/mm/events/ws?api_key={agent['api_key']}") as ws:
        snapshot = ws.receive_json()
        ws.close()
    assert snapshot["type"] == "snapshot"
    return {c["channel_id"]: c["widget_waiting"] for c in snapshot["data"]["channels"]}


def test_the_channel_list_and_snapshot_carry_the_game_waiting_on_the_agent(test_client):
    _, bob, agent, _, dm = _setup(test_client, "wkcatch")
    r = _begin(test_client, bob, dm, "chess", "white")
    assert r.status_code == 201, r.text
    widget_id = r.json()["widget_id"]
    for read in (_channel_waiting, _snapshot_waiting):
        listed = read(test_client, agent)
        assert dm in listed and all(w is None for w in listed.values())  # Bob's move
    _human_move(test_client, bob, widget_id, _E4)
    waiting = {"widget_id": widget_id, "rev": 1, "kind": "chess", "seat": "black"}
    for read in (_channel_waiting, _snapshot_waiting):
        listed = read(test_client, agent)
        assert listed.pop(dm) == waiting
        assert all(w is None for w in listed.values())
    _acted(test_client, agent, widget_id, _E5)
    assert _channel_waiting(test_client, agent)[dm] is None


class _QueueBus:
    """Delivers what's published once a topic is subscribed, and records which are."""

    def __init__(self) -> None:
        self.queues: dict[str, queue.Queue[dict]] = {}
        self.subscribed: set[str] = set()

    def _queue(self, topic: str) -> queue.Queue[dict]:
        return self.queues.setdefault(topic, queue.Queue())

    def publish_now(self, topic: str, event: dict) -> None:
        self._queue(topic).put(event)

    async def subscribe(self, topic: str, *, ready: asyncio.Event | None = None):
        q = self._queue(topic)
        self.subscribed.add(topic)
        if ready is not None:
            ready.set()
        while True:
            try:
                yield q.get_nowait()
            except queue.Empty:
                await asyncio.sleep(0.01)


def test_the_agent_socket_subscribes_before_it_reads_the_snapshot(test_client, monkeypatch):
    import clawbits.realtime as realtime

    _, _, agent, _, dm = _setup(test_client, "wkorder")
    fake = _QueueBus()
    monkeypatch.setattr(realtime, "get_bus", lambda: fake)
    wake = {"type": "widget.turn", "channel_id": dm, "data": {"widget_id": "w", "rev": 3}}
    seen: dict[str, set[str]] = {}
    read = TableRead.get_mm_channels_for_agent

    def reading(session: Session, agent_id: str) -> list[dict]:
        seen["subscribed"] = set(fake.subscribed)
        # Published while the snapshot is read: it still arrives, right after the snapshot.
        fake.publish_now(agent_topic(agent_id), wake)
        return read(session, agent_id)

    monkeypatch.setattr(TableRead, "get_mm_channels_for_agent", staticmethod(reading))
    with test_client.websocket_connect(f"/api/agentic/mm/events/ws?api_key={agent['api_key']}") as ws:
        first, second = ws.receive_json(), ws.receive_json()
        ws.close()
    assert first["type"] == "snapshot" and dm in {c["channel_id"] for c in first["data"]["channels"]}
    assert second == wake
    assert {agent_topic(agent["agent_id"]), channel_topic(dm)} <= seen["subscribed"]


def _age(tc: TestClient, widget_id: str, seconds: int) -> None:
    with Session(tc.app._engine) as db:
        row = db.get(MmWidget, widget_id)
        row.updated_at = datetime.now(UTC) - timedelta(seconds=seconds)
        db.add(row)
        db.commit()


def test_a_game_stalled_on_its_agent_ends_after_an_hour(test_client, monkeypatch):
    from clawbits.fastapi.mm_maintenance import WIDGET_AGENT_IDLE_SECONDS, reap_idle_widgets_once

    engine = test_client.app._engine
    *_, people = _people_game(test_client, "wkreap-people")
    bob, agent, _, widget_id, _ = _game(test_client, monkeypatch, "wkreap")
    over = WIDGET_AGENT_IDLE_SECONDS + 60
    # Waiting on the person, an hour is nothing: only the two-day rule applies.
    _age(test_client, widget_id, over)
    _age(test_client, people["widget_id"], over)
    assert asyncio.run(reap_idle_widgets_once(engine)) == 0
    _human_move(test_client, bob, widget_id, _E4)
    _age(test_client, widget_id, over)
    fake = _bus(monkeypatch)
    assert asyncio.run(reap_idle_widgets_once(engine)) == 1
    row = _row(test_client, widget_id)
    assert (row.status, row.outcome, row.waiting_on) == ("aborted", {"reason": "agent_idle"}, [])
    assert _row(test_client, people["widget_id"]).status == "active"
    seen = test_client.get(f"/api/human/mm/widgets/{widget_id}", headers=auth_headers(bob["access_token"])).json()
    assert seen["scene"]["status"]["text"] == "The agent stopped responding"
    # Published after commit, as every ending is: the chat, Bob, and the agent's last wake.
    assert [e["data"]["status"] for _, e in fake.published if e["type"] == "widget.updated"] == ["aborted"]
    assert _revs(_wakes(fake, agent, 1)) == [(2, False, "aborted")]
