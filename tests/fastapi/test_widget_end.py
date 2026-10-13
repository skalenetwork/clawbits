"""Ending a widget by hand, the switches every other action rechecks, and the service under both."""

import pytest
from sqlmodel import Session, select
from starlette.testclient import TestClient

from clawbits.db.models import MmChannel, MmChannelMember, MmWidgetSeat, Organization
from clawbits.widgets import service as widget_service
from clawbits.widgets.service import Participant, WidgetError
from tests.fastapi._auth_helpers import auth_headers, register_human
from tests.fastapi.test_widgets import (
    _act,
    _FakeBus,
    _game,
    _move,
    _switched_on,
    _widget_turns,
    _widget_updates,
)

_END = {"type": "end", "args": {}}


def _begin(tc: TestClient, who: dict, channel_id: str, kind: str, seat: str) -> dict:
    r = tc.post(
        f"/api/human/mm/channels/{channel_id}/widgets",
        json={"kind": kind, "seat": seat},
        headers=auth_headers(who["access_token"]),
    )
    assert r.status_code == 201, r.text
    return r.json()


def _ok(tc: TestClient, who: dict, widget: dict, action: str, **args) -> dict:
    r = _act(tc, who, widget, {"type": action, "args": args})
    assert r.status_code == 200, r.text
    return r.json()


def _chess_underway(tc: TestClient, alice: dict, bob: dict, channel_id: str) -> tuple[dict, dict]:
    """Three moves in: past the point where ``abort`` is allowed. Bob ends it."""
    widget = _begin(tc, alice, channel_id, "chess", "white")
    for who, move in ((alice, "e4"), (bob, "e5"), (alice, "Nf3")):
        widget = _ok(tc, who, widget, "move", move=move)
    assert _act(tc, bob, widget, {"type": "abort"}).status_code == 422
    return widget, bob


def _battleship_in_battle(tc: TestClient, alice: dict, bob: dict, channel_id: str) -> tuple[dict, dict]:
    """Both fleets set and a shot fired. Bob ends it."""
    widget = _begin(tc, alice, channel_id, "battleship", "red")
    widget = _ok(tc, alice, widget, "ready")
    widget = _ok(tc, bob, widget, "ready")
    widget = _ok(tc, alice, widget, "fire", at="A1")
    assert widget["turn"] is not None  # the battle is on: someone has the shot
    return widget, bob


def _poker_mid_hand(tc: TestClient, alice: dict, bob: dict, channel_id: str) -> tuple[dict, dict]:
    """Red raised; Blue, facing it, ends it instead."""
    widget = _begin(tc, alice, channel_id, "poker", "red")
    widget = _ok(tc, alice, widget, "raise", to=60)
    assert widget["waiting_on"] == ["blue"]
    return widget, bob


def _blackjack_mid_bets(tc: TestClient, alice: dict, bob: dict, channel_id: str) -> tuple[dict, dict]:
    """Red has bet and Blue not yet; Red, waiting, ends it."""
    widget = _begin(tc, alice, channel_id, "blackjack", "red")
    widget = _ok(tc, alice, widget, "bet", amount=50)
    assert widget["waiting_on"] == ["blue"]
    return widget, alice


@pytest.mark.parametrize(
    "underway",
    [_chess_underway, _battleship_in_battle, _poker_mid_hand, _blackjack_mid_bets],
    ids=["chess", "battleship", "poker", "blackjack"],
)
def test_a_seated_player_ends_any_kind_in_any_phase(test_client, monkeypatch, underway):
    from clawbits.realtime import bus as bus_module

    alice, bob, _, channel_id = _switched_on(test_client, f"wstop-{underway.__name__}")
    widget, ender = underway(test_client, alice, bob, channel_id)
    fake = _FakeBus()
    monkeypatch.setattr(bus_module, "_bus", fake)
    r = _act(test_client, ender, widget, _END)
    assert r.status_code == 200, r.text
    ended = r.json()
    assert (ended["status"], ended["outcome"], ended["turn"], ended["waiting_on"]) == (
        "aborted",
        {"reason": "stopped"},
        None,
        [],
    )
    assert ended["rev"] == widget["rev"] + 1
    assert ended["scene"]["status"]["text"] == "A player ended it"
    updates = _widget_updates(fake)
    assert [(u["widget_id"], u["status"], u["scene"]["status"]["text"]) for u in updates] == [
        (widget["widget_id"], "aborted", "A player ended it")
    ]
    assert {e["data"]["my_turn"] for _, e in _widget_turns(fake, 2)} == {False}


def test_end_skips_the_rev_check(test_client):
    alice, bob, _, _, widget = _game(test_client, "wstopstale")
    moved = _move(test_client, alice, widget, "e4")
    r = _act(test_client, bob, widget, _END, rev=0)  # Bob never saw e4
    assert r.status_code == 200, r.text
    assert (r.json()["status"], r.json()["rev"]) == ("aborted", moved["rev"] + 1)


def test_an_ended_widget_cannot_be_ended_again(test_client):
    alice, bob, _, channel_id, widget = _game(test_client, "wstoptwice")
    assert _act(test_client, alice, widget, _END).status_code == 200
    r = _act(test_client, bob, widget, _END)
    assert (r.status_code, r.json()["detail"]) == (409, "This widget has ended")
    finished = _begin(test_client, bob, channel_id, "chess", "white")
    assert _act(test_client, bob, finished, {"type": "resign"}).status_code == 200
    r = _act(test_client, alice, finished, _END)
    assert (r.status_code, r.json()["detail"]) == (409, "This widget has ended")


def test_an_outsider_cannot_end_a_widget(test_client):
    _, bob, _, _, widget = _game(test_client, "wstopout")
    eve = register_human(test_client, "wstopout-eve@test.com")
    r = _act(test_client, eve, widget, _END)
    assert (r.status_code, r.json()["detail"]) == (404, "Widget not found")
    r = test_client.get(
        f"/api/human/mm/widgets/{widget['widget_id']}", headers=auth_headers(bob["access_token"])
    )
    assert r.json()["status"] == "active"


@pytest.mark.parametrize(
    ("switch", "detail"),
    [("chat", "Widgets are off in this chat"), ("org", "Widgets are off in this organization")],
)
def test_a_switch_found_off_refuses_moves_but_not_end(test_client, switch, detail):
    alice, bob, org_id, channel_id, widget = _game(test_client, f"wstopoff-{switch}")
    # Neither switch turns off while a widget is active; only a write behind the API's back can.
    with Session(test_client.app._engine) as db:
        row = db.get(MmChannel, channel_id) if switch == "chat" else db.get(Organization, org_id)
        row.widgets_enabled = False
        db.add(row)
        db.commit()
    r = _act(test_client, alice, widget, {"type": "move", "args": {"move": "e4"}})
    assert (r.status_code, r.json()["detail"]) == (403, detail)
    assert _act(test_client, bob, widget, {"type": "resign"}).status_code == 403
    r = _act(test_client, bob, widget, _END)
    assert r.status_code == 200, r.text
    assert (r.json()["status"], r.json()["outcome"]) == ("aborted", {"reason": "stopped"})


def test_an_agent_seat_acts_through_the_service(test_client, create_agent_and_key):
    """A seat held by an agent is found by its agent id; the person it replaced has none left."""
    agent_id = str(create_agent_and_key[0])
    alice, bob, _, channel_id, widget = _game(test_client, "wsvcagent")
    widget = _move(test_client, alice, widget, "e4")
    engine = test_client.app._engine
    with Session(engine) as db:
        seat = db.exec(
            select(MmWidgetSeat)
            .where(MmWidgetSeat.widget_id == widget["widget_id"])
            .where(MmWidgetSeat.seat == "black")
        ).one()
        seat.human_id, seat.agent_id = None, agent_id
        db.add(seat)
        db.add(MmChannelMember(channel_id=channel_id, agent_id=agent_id))
        db.commit()
    r = _act(test_client, bob, widget, {"type": "move", "args": {"move": "e5"}})
    assert (r.status_code, r.json()["detail"]) == (403, "You don't have a seat in this widget")
    assert _act(test_client, bob, widget, _END).status_code == 403
    with Session(engine) as db:
        move = {"type": "move", "args": {"move": "e5"}}
        result = widget_service.act(db, Participant.agent(agent_id), widget["widget_id"], move, None)
    assert (result.view["rev"], result.view["turn"], result.public["scene"]["log"]) == (
        2,
        "white",
        ["1. e4", "e5"],
    )
    with Session(engine) as db, pytest.raises(WidgetError) as refused:
        widget_service.act(db, Participant.agent(agent_id), widget["widget_id"], move, 1)
    assert (refused.value.code, refused.value.status_code) == ("stale_rev", 409)
    with Session(engine) as db, pytest.raises(WidgetError) as refused:
        widget_service.act(db, Participant.agent("not-a-member"), widget["widget_id"], move, None)
    assert (refused.value.code, refused.value.status_code) == ("not_found", 404)
    # Ending is a person's way out: the agent itself may not walk away from the game.
    with Session(engine) as db, pytest.raises(WidgetError) as refused:
        widget_service.act(db, Participant.agent(agent_id), widget["widget_id"], {"type": "end"}, None)
    assert (refused.value.code, refused.value.status_code) == ("forbidden", 403)


def test_a_participant_is_a_human_or_an_agent():
    assert Participant.human(7) == Participant(human_id=7)
    assert Participant.agent("a1") == Participant(agent_id="a1")
    with pytest.raises(ValueError):
        Participant()
    with pytest.raises(ValueError):
        Participant(human_id=7, agent_id="a1")
