"""A chat's score: each player's wins and the draws over its finished games, every kind together,
on every widget people see and from its own route; never on what an agent reads."""

import asyncio
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlmodel import Session
from starlette.testclient import TestClient

import clawbits.widgets.blackjack as blackjack
from clawbits.db.models import MmWidget, MmWidgetSeat
from clawbits.db.table_read import TableRead
from clawbits.widgets import KINDS
from clawbits.widgets import service as widget_service
from clawbits.widgets.cards import DECK
from clawbits.widgets.service import Participant
from tests.fastapi._auth_helpers import add_human_to_org, auth_headers, register_human
from tests.fastapi.test_agent_widgets import _begin
from tests.fastapi.test_agent_widgets import _setup as _agent_setup
from tests.fastapi.test_agentic_widgets import _acted, _human_move
from tests.fastapi.test_widgets import (
    _act,
    _dm,
    _FakeBus,
    _setup,
    _start,
    _switch_chat,
    _switch_org,
    _widget_updates,
)


def _people(tc: TestClient, prefix: str) -> tuple[dict, dict, str, str]:
    """Alice and Bob's DM with both switches on, no game yet."""
    alice, bob, org_id, channel_id = _setup(tc, prefix)
    assert _switch_org(tc, alice, org_id, True).status_code == 200
    assert _switch_chat(tc, bob, channel_id, True).status_code == 200
    return alice, bob, org_id, channel_id


def _play(tc: TestClient, starter: dict, channel_id: str, seat: str, loser: dict, kind: str = "chess") -> dict:
    """``starter`` takes ``seat`` in a new game; ``loser`` resigns it."""
    r = _begin(tc, starter, channel_id, kind, seat)
    assert r.status_code == 201, r.text
    return _resign(tc, loser, r.json())


def _resign(tc: TestClient, who: dict, widget: dict) -> dict:
    r = _act(tc, who, widget, {"type": "resign"})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "finished"
    return r.json()


def _score(tc: TestClient, who: dict, channel_id: str):
    return tc.get(f"/api/human/mm/channels/{channel_id}/widgets/score", headers=auth_headers(who["access_token"]))


def _tally(tc: TestClient, who: dict, channel_id: str) -> tuple[list[tuple[str, int]], int, int]:
    r = _score(tc, who, channel_id)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["channel_id"] == channel_id
    return [(p["display_name"], p["wins"]) for p in body["players"]], body["draws"], body["finished"]


def _wins(widget: dict) -> dict[str, int]:
    return {s["display_name"]: s["wins"] for s in widget["seats"]}


def _history(tc: TestClient, who: dict, channel_id: str) -> list[dict]:
    r = tc.get(
        f"/api/human/mm/channels/{channel_id}/widgets",
        params={"active": "false"},
        headers=auth_headers(who["access_token"]),
    )
    assert r.status_code == 200, r.text
    return r.json()["widgets"]


def test_wins_follow_the_players_not_their_seats(test_client):
    alice, bob, _, channel_id = _people(test_client, "scseat")
    _play(test_client, alice, channel_id, "white", bob)  # Alice wins as White
    _play(test_client, alice, channel_id, "black", bob)  # and as Black
    last = _play(test_client, bob, channel_id, "white", alice)  # Bob wins as White
    assert (_wins(last), last["draws"]) == ({"Alice": 2, "Bob": 1}, 0)
    started = _start(test_client, alice, channel_id, seat="black").json()  # the game after shows it too
    assert (_wins(started), started["draws"]) == ({"Alice": 2, "Bob": 1}, 0)
    alice_id, bob_id = alice["user"]["id"], bob["user"]["id"]
    seats = {s["human_id"]: (s["seat"], s["wins"]) for s in started["seats"]}
    assert seats == {alice_id: ("black", 2), bob_id: ("white", 1)}
    got = test_client.get(f"/api/human/mm/widgets/{started['widget_id']}", headers=auth_headers(bob["access_token"]))
    assert _wins(got.json()) == {"Alice": 2, "Bob": 1}
    assert all(_wins(w) == {"Alice": 2, "Bob": 1} for w in _history(test_client, bob, channel_id))
    assert _tally(test_client, bob, channel_id) == ([("Alice", 2), ("Bob", 1)], 0, 3)


def test_every_kind_counts_together(test_client):
    alice, bob, _, channel_id = _people(test_client, "sckinds")
    for kind, seat in (("chess", "white"), ("battleship", "red"), ("poker", "blue"), ("blackjack", "red")):
        widget = _begin(test_client, alice, channel_id, kind, seat).json()
        if kind == "battleship":  # resigning needs the battle on: both fleets placed
            _human_move(test_client, alice, widget["widget_id"], {"type": "ready"})
            widget = _human_move(test_client, bob, widget["widget_id"], {"type": "ready"})
        last = _resign(test_client, bob, widget)
        assert last["outcome"]["winner"] == seat
    assert (_wins(last), last["draws"]) == ({"Alice": 4, "Bob": 0}, 0)
    assert _tally(test_client, bob, channel_id) == ([("Alice", 4), ("Bob", 0)], 0, 4)


def test_a_chess_draw_and_level_blackjack_stacks_are_draws(test_client, monkeypatch):
    alice, bob, _, channel_id = _people(test_client, "scdraw")
    chess = _begin(test_client, alice, channel_id, "chess", "white").json()
    chess = _act(test_client, alice, chess, {"type": "offer_draw"}).json()
    drawn = _act(test_client, bob, chess, {"type": "accept_draw"}).json()
    assert (drawn["status"], drawn["outcome"]["winner"], drawn["draws"]) == ("finished", None, 1)
    # Both hands play the same cards against the dealer's 17 in the last round: level stacks.
    deck = "Tc Td Th 9c 9d 7h".split()
    monkeypatch.setattr(blackjack, "shuffled_deck", lambda: deck + [c for c in DECK if c not in deck])
    match = _begin(test_client, alice, channel_id, "blackjack", "red").json()
    with Session(test_client.app._engine) as db:
        row = db.get(MmWidget, match["widget_id"])
        row.state = {**row.state, "round": blackjack.ROUNDS}
        db.add(row)
        db.commit()
    _human_move(test_client, alice, match["widget_id"], {"type": "bet", "args": {"amount": 100}})
    _human_move(test_client, bob, match["widget_id"], {"type": "bet", "args": {"amount": 100}})
    _human_move(test_client, alice, match["widget_id"], {"type": "stand"})
    over = _human_move(test_client, bob, match["widget_id"], {"type": "stand"})
    assert (over["status"], over["outcome"]["winner"]) == ("finished", None)
    assert (_wins(over), over["draws"]) == ({"Alice": 0, "Bob": 0}, 2)
    assert _tally(test_client, alice, channel_id) == ([("Alice", 0), ("Bob", 0)], 2, 2)


@pytest.mark.parametrize("ending", ["end", "abort", "idle"])
def test_games_that_never_finished_never_count(test_client, monkeypatch, ending):
    from clawbits.fastapi.mm_maintenance import reap_idle_widgets_once
    from clawbits.realtime import bus as bus_module

    alice, bob, _, channel_id = _people(test_client, f"scvoid-{ending}")
    widget = _begin(test_client, alice, channel_id, "chess", "white").json()
    if ending == "idle":
        monkeypatch.setattr(bus_module, "_bus", _FakeBus())
        engine = test_client.app._engine
        with Session(engine) as db:
            row = db.get(MmWidget, widget["widget_id"])
            row.updated_at = datetime.now(UTC) - timedelta(days=2, minutes=1)
            db.add(row)
            db.commit()
        assert asyncio.run(reap_idle_widgets_once(engine)) == 1
    else:
        assert _act(test_client, bob, widget, {"type": ending}).json()["status"] == "aborted"
    assert _tally(test_client, alice, channel_id) == ([], 0, 0)
    started = _start(test_client, bob, channel_id).json()
    assert (_wins(started), started["draws"]) == ({"Alice": 0, "Bob": 0}, 0)


def test_each_chat_keeps_its_own_score(test_client):
    alice, bob, org_id, channel_id = _people(test_client, "scchat")
    carol = register_human(test_client, "scchat-carol@test.com", "Carol")
    add_human_to_org(test_client, alice["access_token"], org_id, carol["user"]["email"])
    other = _dm(test_client, alice, carol, org_id)
    assert _switch_chat(test_client, carol, other, True).status_code == 200
    _play(test_client, alice, channel_id, "white", bob)
    _play(test_client, carol, other, "white", alice)
    _play(test_client, carol, other, "black", alice)
    assert _tally(test_client, alice, channel_id) == ([("Alice", 1), ("Bob", 0)], 0, 1)
    assert _tally(test_client, alice, other) == ([("Carol", 2), ("Alice", 0)], 0, 2)


def test_every_finished_game_counts_past_the_lists_twenty(test_client):
    alice, bob, _, channel_id = _people(test_client, "scmany")
    with Session(test_client.app._engine) as db:
        for i in range(23):
            widget_id = uuid.uuid4().hex
            db.add(MmWidget(
                widget_id=widget_id, channel_id=channel_id, kind="chess", status="finished", state=KINDS["chess"].init(),
                outcome={"termination": "resign", "winner": "white" if i % 3 else "black"},
            ))
            db.flush()
            db.add(MmWidgetSeat(widget_id=widget_id, seat="white", human_id=alice["user"]["id"]))
            db.add(MmWidgetSeat(widget_id=widget_id, seat="black", human_id=bob["user"]["id"]))
        db.commit()
    assert _tally(test_client, bob, channel_id) == ([("Alice", 15), ("Bob", 8)], 0, 23)
    assert len(_history(test_client, bob, channel_id)) == 20
    started = _start(test_client, alice, channel_id).json()
    assert _wins(started) == {"Alice": 15, "Bob": 8}


def test_a_deleted_winner_takes_their_wins_along_and_leaves_the_others(test_client):
    alice, bob, _, channel_id = _people(test_client, "scgone")
    _play(test_client, alice, channel_id, "white", bob)
    _play(test_client, bob, channel_id, "white", alice)
    _play(test_client, bob, channel_id, "black", alice)
    assert _tally(test_client, alice, channel_id) == ([("Bob", 2), ("Alice", 1)], 0, 3)
    r = test_client.delete("/api/human/account", headers=auth_headers(bob["access_token"]))
    assert r.status_code == 204, r.text
    assert _tally(test_client, alice, channel_id) == ([("Alice", 1)], 0, 3)
    history = _history(test_client, alice, channel_id)
    assert len(history) == 3 and all(_wins(w) == {"Alice": 1} for w in history)


def test_the_finishing_update_carries_the_new_wins(test_client, monkeypatch):
    from clawbits.realtime import bus as bus_module

    alice, bob, _, channel_id = _people(test_client, "scupd")
    widget = _begin(test_client, alice, channel_id, "chess", "white").json()
    fake = _FakeBus()
    monkeypatch.setattr(bus_module, "_bus", fake)
    _resign(test_client, bob, widget)
    (update,) = _widget_updates(fake)
    assert (update["status"], _wins(update), update["draws"]) == ("finished", {"Alice": 1, "Bob": 0}, 0)


def test_the_score_route_is_for_the_chats_members(test_client):
    alice, bob, org_id, channel_id = _people(test_client, "scauth")
    _play(test_client, alice, channel_id, "white", bob)
    eve = register_human(test_client, "scauth-eve@test.com", "Eve")
    assert _score(test_client, eve, channel_id).status_code == 403
    add_human_to_org(test_client, alice["access_token"], org_id, eve["user"]["email"])
    assert _score(test_client, eve, channel_id).status_code == 403  # in the org, not in the DM
    assert _score(test_client, bob, "no-such-chat").status_code == 403
    test_client.cookies.clear()
    assert test_client.get(f"/api/human/mm/channels/{channel_id}/widgets/score").status_code in (401, 403)


def _keys(value: object) -> set[str]:
    """Every key anywhere in a JSON value."""
    if isinstance(value, dict):
        return set(value) | {k for v in value.values() for k in _keys(v)}
    if isinstance(value, list):
        return {k for v in value for k in _keys(v)}
    return set()


def test_an_agents_own_reads_carry_no_score(test_client):
    _, bob, agent, _, dm = _agent_setup(test_client, "scagent")
    widget_id = _begin(test_client, bob, dm, "chess", "white").json()["widget_id"]
    _human_move(test_client, bob, widget_id, {"type": "move", "args": {"move": "e4"}})
    acted = _acted(test_client, agent, widget_id, {"type": "resign"})
    listed = test_client.get("/api/agentic/mm/widgets", headers=auth_headers(agent["api_key"])).json()
    viewed = test_client.get(f"/api/agentic/mm/widgets/{widget_id}", headers=auth_headers(agent["api_key"])).json()
    assert not {"wins", "draws"} & (_keys(acted) | _keys(listed) | _keys(viewed))
    with Session(test_client.app._engine) as db:
        plain = TableRead.get_mm_widget(db, widget_id)
        assert "draws" not in plain and all("wins" not in s for s in plain["seats"])
        scored = TableRead.get_mm_widget(db, widget_id, with_scores=True)
        assert {s["seat"]: s["wins"] for s in scored["seats"]} == {"white": 1, "black": 0}
    r = test_client.get(f"/api/human/mm/channels/{dm}/widgets/score", headers=auth_headers(bob["access_token"]))
    assert [(p["human_id"], p["agent_id"], p["is_agent"], p["wins"]) for p in r.json()["players"]] == [
        (bob["user"]["id"], None, False, 1),
        (None, agent["agent_id"], True, 0),
    ]
    widget = _begin(test_client, bob, dm, "chess", "black").json()
    with Session(test_client.app._engine) as db:
        result = widget_service.act(
            db, Participant.agent(agent["agent_id"]), widget["widget_id"], {"type": "move", "args": {"move": "e4"}}, None
        )
    assert "draws" not in result.view and "draws" in result.public
