"""Chat games over the agentic API: an agent lists its games, reads one, and takes its moves with
its bearer key. Refusals are a 200 with a code and a fresh view; moves cost no CB_TOKENS and are
capped per minute in Redis, as people's moves and starts are."""

import logging
import re

import pytest
import redis
from sqlmodel import Session
from starlette.testclient import TestClient

from clawbits.db.models import Agent, MmWidget
from clawbits.widgets import chess, limits
from clawbits.widgets.cards import card_text
from tests.fastapi._auth_helpers import auth_headers
from tests.fastapi.test_agent_contact_permissions import _grant
from tests.fastapi.test_agent_widgets import _begin, _setup
from tests.fastapi.test_human_mattermost import _create_agent
from tests.fastapi.test_widgets import _act, _FakeBus, _widget_turns, _widget_updates

_NOT_FOUND = (404, "Widget not found")


def _list(tc: TestClient, agent: dict, **params) -> list[dict]:
    r = tc.get("/api/agentic/mm/widgets", params=params, headers=auth_headers(agent["api_key"]))
    assert r.status_code == 200, r.text
    return r.json()["widgets"]


def _get(tc: TestClient, agent: dict, widget_id: str, **params):
    return tc.get(f"/api/agentic/mm/widgets/{widget_id}", params=params, headers=auth_headers(agent["api_key"]))


def _view(tc: TestClient, agent: dict, widget_id: str, **params) -> dict:
    r = _get(tc, agent, widget_id, **params)
    assert r.status_code == 200, r.text
    return r.json()


def _agent_act(tc: TestClient, agent: dict, widget_id: str, body: dict, **params):
    return tc.post(
        f"/api/agentic/mm/widgets/{widget_id}/actions",
        json=body,
        params=params,
        headers=auth_headers(agent["api_key"]),
    )


def _acted(tc: TestClient, agent: dict, widget_id: str, body: dict, **params) -> dict:
    r = _agent_act(tc, agent, widget_id, body, **params)
    assert r.status_code == 200, r.text
    return r.json()


def _row(tc: TestClient, widget_id: str) -> MmWidget:
    with Session(tc.app._engine) as db:
        return db.get(MmWidget, widget_id)


def _human_move(tc: TestClient, who: dict, widget_id: str, action: dict) -> dict:
    row = _row(tc, widget_id)
    r = _act(tc, who, {"widget_id": widget_id, "rev": row.rev}, action)
    assert r.status_code == 200, r.text
    return r.json()


def _tokens(tc: TestClient, agent_id: str) -> int:
    with Session(tc.app._engine) as db:
        return db.get(Agent, agent_id).cb_tokens


def _chess(tc: TestClient, prefix: str) -> tuple[dict, dict, str, str]:
    """Bob plays White against the agent in their DM."""
    _, bob, agent, _, dm = _setup(tc, prefix)
    r = _begin(tc, bob, dm, "chess", "white")
    assert r.status_code == 201, r.text
    return bob, agent, dm, r.json()["widget_id"]


def test_an_agent_lists_its_games_and_those_waiting_on_it(test_client):
    bob, agent, dm, widget_id = _chess(test_client, "agwlist")
    (entry,) = _list(test_client, agent)
    assert entry == {
        "widget_id": widget_id,
        "channel_id": dm,
        "kind": "chess",
        "status": "active",
        "rev": 0,
        "seat": "black",
        "waiting_on": ["white"],
        "your_move": False,
        "opponent": {"name": "Bob", "type": "human", "id": f"human:{bob['user']['id']}"},
    }
    assert _list(test_client, agent, waiting=1) == []
    _human_move(test_client, bob, widget_id, {"type": "move", "args": {"move": "e4"}})
    (waiting,) = _list(test_client, agent, waiting=1)
    assert (waiting["widget_id"], waiting["rev"], waiting["your_move"]) == (widget_id, 1, True)
    assert [w["widget_id"] for w in _list(test_client, agent, channel_id=dm)] == [widget_id]
    assert _list(test_client, agent, channel_id="no-such-chat") == []


def test_an_agent_reads_chess_as_fen_and_san(test_client):
    bob, agent, _, widget_id = _chess(test_client, "agwchess")
    _human_move(test_client, bob, widget_id, {"type": "move", "args": {"move": "e4"}})
    view = _view(test_client, agent, widget_id, private=1)
    assert (view["seat"], view["rev"], view["waiting_on"], view["your_move"]) == ("black", 1, ["black"], True)
    bob_key = f"human:{bob['user']['id']}"
    assert view["players"] == [
        {"seat": "white", "name": "Bob", "type": "human", "id": bob_key},
        {"seat": "black", "name": "You", "type": "agent", "id": None},
    ]
    assert (view["started_by"], view["move_deadline"]) == (bob_key, None)
    fen = chess.position({"moves": ["e2e4"]}).fen()
    assert f"Position (FEN): {fen}" in view["text"]
    assert "Legal moves (SAN, as args.move): " in view["text"]
    assert {"type": "move", "args": {"move": "e5"}} in view["legal"]
    assert "call the clawbits_widget_act tool directly" in view["instructions"]  # it runs OpenClaw
    assert view["instructions"].endswith("NO_REPLY.")
    # An ordinary chat turn sees the same position, but no moves and no rule against chatting.
    public = _view(test_client, agent, widget_id)
    assert f"Position (FEN): {fen}" in public["text"] and public["legal"] == []
    assert "clawbits_widget_act" not in public["instructions"] and "NO_REPLY" not in public["instructions"]


def test_a_hermes_agent_is_told_the_tool_call_shape(test_client):
    from tests.fastapi.test_agent_widgets import _alive

    bob, agent, _, widget_id = _chess(test_client, "agwhermes")
    _alive(test_client, agent, "hermes", ["widgets"])
    _human_move(test_client, bob, widget_id, {"type": "move", "args": {"move": "d4"}})
    instructions = _view(test_client, agent, widget_id, private=1)["instructions"]
    assert 'tool_call {"calls":[{"name":"clawbits_widget_act","arguments":{"widget_id":"' + widget_id in instructions


def test_only_a_game_session_asks_for_the_seats_own_view(test_client):
    _, bob, agent, _, dm = _setup(test_client, "agwprivate")
    r = _begin(test_client, bob, dm, "poker", "blue")  # the agent has the button and acts first
    assert r.status_code == 201, r.text
    widget_id = r.json()["widget_id"]
    hole = _row(test_client, widget_id).state["hole"]
    mine = [card_text(card) for card in hole["red"]]
    bobs = [card_text(card) for card in hole["blue"]]
    public = _view(test_client, agent, widget_id)
    assert (public["your_move"], public["legal"]) == (True, [])
    assert "This is the public view" in public["text"]
    assert "take no action here" in public["instructions"]
    own = _view(test_client, agent, widget_id, private=1)
    assert f"Your cards: {mine[0]} {mine[1]}" in own["text"]
    assert "TOTAL your bet on this street comes to" in own["text"]
    assert {"type": "raise", "args_spec": {"arg": "to", "min": 40, "max": 1000, "step": 10}} in own["legal"]
    for text in (public["text"], own["text"]):
        assert not any(card in text for card in bobs)
    assert not any(card in public["text"] for card in mine)


def test_nobody_outside_the_chat_reads_or_plays(test_client):
    _, bob, agent, _, dm = _setup(test_client, "agwout")
    other = _create_agent(test_client, owner_email="agwout-alice@test.com")  # same org, not in the DM
    widget_id = _begin(test_client, bob, dm, "chess", "white").json()["widget_id"]
    r = _get(test_client, other, widget_id)
    assert (r.status_code, r.json()["detail"]) == _NOT_FOUND
    r = _agent_act(test_client, other, widget_id, {"type": "resign"})
    assert (r.status_code, r.json()["detail"]) == _NOT_FOUND
    assert _list(test_client, other) == []
    r = _get(test_client, agent, "no-such-widget")
    assert (r.status_code, r.json()["detail"]) == _NOT_FOUND
    r = test_client.get(f"/api/agentic/mm/widgets/{widget_id}", headers=auth_headers("fc_not-a-key"))
    assert r.status_code == 401
    assert _row(test_client, widget_id).rev == 0


@pytest.mark.parametrize("how", ["put", "delete"])
def test_revoking_a_persons_contact_ends_their_game_with_the_agent(test_client, monkeypatch, how):
    from clawbits.realtime import bus as bus_module

    alice, bob, agent, _, dm = _setup(test_client, f"agwrevoke-{how}")
    agent_id, bob_id = agent["agent_id"], bob["user"]["id"]
    widget_id = _begin(test_client, bob, dm, "chess", "white").json()["widget_id"]
    _human_move(test_client, bob, widget_id, {"type": "move", "args": {"move": "e4"}})
    fake = _FakeBus()
    monkeypatch.setattr(bus_module, "_bus", fake)
    if how == "put":  # tagging may stay; writing to it doesn't
        r = _grant(test_client, alice["access_token"], agent_id, "human", bob_id, can_dm=False, can_tag=True)
    else:
        r = test_client.delete(
            f"/api/human/agents/{agent_id}/contact-permissions/human/{bob_id}",
            headers=auth_headers(alice["access_token"]),
        )
    assert r.status_code == 200, r.text
    row = _row(test_client, widget_id)
    assert (row.status, row.outcome, row.waiting_on, row.rev) == ("aborted", {"reason": "left"}, [], 2)
    # Published after commit: the chat, Bob, and the agent's last wake, which it can't read past.
    assert [(u["widget_id"], u["status"]) for u in _widget_updates(fake)] == [(widget_id, "aborted")]
    turns = {topic: e["data"] for topic, e in _widget_turns(fake, 2)}
    assert turns[f"human:{bob_id}"]["my_turn"] is False
    assert (turns[f"agent:{agent_id}"]["status"], turns[f"agent:{agent_id}"]["waiting"]) == ("aborted", False)
    # Both sides of the DM shut: the agent's reads and moves are a 404 ...
    assert (_get(test_client, agent, widget_id).status_code, _list(test_client, agent)) == (404, [])
    r = _agent_act(test_client, agent, widget_id, {"type": "move", "args": {"move": "e5"}})
    assert (r.status_code, r.json()["detail"]) == _NOT_FOUND
    # ... and so are Bob's, as everything else in that DM is; only End still answers him.
    r = test_client.get(f"/api/human/mm/widgets/{widget_id}", headers=auth_headers(bob["access_token"]))
    assert (r.status_code, r.json()["detail"]) == _NOT_FOUND
    r = _act(test_client, bob, {"widget_id": widget_id, "rev": 2}, {"type": "move", "args": {"move": "d4"}})
    assert (r.status_code, r.json()["detail"]) == _NOT_FOUND
    r = _act(test_client, bob, {"widget_id": widget_id, "rev": 2}, {"type": "end"})
    assert (r.status_code, r.json()["detail"]) == (409, "This widget has ended")


def test_a_grant_that_keeps_the_dm_open_leaves_the_game_be(test_client):
    alice, bob, agent, _, dm = _setup(test_client, "agwkeep")
    widget_id = _begin(test_client, bob, dm, "chess", "white").json()["widget_id"]
    r = _grant(test_client, alice["access_token"], agent["agent_id"], "human", bob["user"]["id"], can_dm=True, can_tag=True)
    assert r.status_code == 200, r.text
    other = _create_agent(test_client, owner_email="agwkeep-alice@test.com")
    r = _grant(test_client, alice["access_token"], agent["agent_id"], "agent", other["agent_id"], can_dm=False, can_tag=True)
    assert r.status_code == 200, r.text  # another principal's grant: Bob's DM is untouched
    assert (_row(test_client, widget_id).status, _row(test_client, widget_id).rev) == ("active", 0)


def test_an_agents_move_reaches_the_person_and_theirs_the_agent(test_client, monkeypatch):
    from clawbits.realtime import bus as bus_module

    bob, agent, dm, widget_id = _chess(test_client, "agwmove")
    _human_move(test_client, bob, widget_id, {"type": "move", "args": {"move": "e4"}})
    fake = _FakeBus()
    monkeypatch.setattr(bus_module, "_bus", fake)
    acted = _acted(test_client, agent, widget_id, {"type": "move", "args": {"move": "e5"}})
    assert acted == {"ok": True, "compact": "ok · rev 2 · waiting on white", "your_move": False, "view": None}
    # Published as a person's move is: the chat's scene, and Bob's turn.
    assert [(u["widget_id"], u["rev"]) for u in _widget_updates(fake)] == [(widget_id, 2)]
    turns = [(topic, e["data"]["my_turn"]) for topic, e in _widget_turns(fake, 1) if topic.startswith("human:")]
    assert turns == [(f"human:{bob['user']['id']}", True)]
    seen = test_client.get(f"/api/human/mm/widgets/{widget_id}", headers=auth_headers(bob["access_token"])).json()
    assert (seen["rev"], seen["waiting_on"], seen["scene"]["log"]) == (2, ["white"], ["1. e4", "e5"])
    _human_move(test_client, bob, widget_id, {"type": "move", "args": {"move": "Nf3"}})
    view = _view(test_client, agent, widget_id)
    assert (view["rev"], view["your_move"]) == (3, True)
    assert "1. e4 / e5 / 2. Nf3" in view["text"]
    # With the current rev a move goes through too.
    acted = _acted(test_client, agent, widget_id, {"type": "move", "args": {"move": "Nc6"}, "rev": 3})
    assert (acted["ok"], acted["compact"]) == (True, "ok · rev 4 · waiting on white")
    # The act tool's input passed on whole, its widget_id and a null args included, is taken too.
    _human_move(test_client, bob, widget_id, {"type": "move", "args": {"move": "Bc4"}})
    body = {"widget_id": widget_id, "type": "move", "args": {"move": "Nf6"}, "rev": 5}
    assert _acted(test_client, agent, widget_id, body)["compact"] == "ok · rev 6 · waiting on white"
    _human_move(test_client, bob, widget_id, {"type": "move", "args": {"move": "Ng5"}})
    refused = _acted(test_client, agent, widget_id, {"widget_id": widget_id, "type": "move", "args": None})
    assert (refused["ok"], refused["code"]) == (False, "illegal_action")


def test_refusals_are_a_200_with_a_code_and_a_fresh_view(test_client):
    bob, agent, _, widget_id = _chess(test_client, "agwrefuse")
    e5 = {"type": "move", "args": {"move": "e5"}}
    refused = _acted(test_client, agent, widget_id, e5)
    assert (refused["ok"], refused["code"], refused["view"]["rev"]) == (False, "not_your_turn", 0)
    assert refused["message"] == "It's not your move"
    _human_move(test_client, bob, widget_id, {"type": "move", "args": {"move": "e4"}})
    refused = _acted(test_client, agent, widget_id, {**e5, "rev": 0})
    assert (refused["code"], refused["view"]["rev"], refused["view"]["your_move"]) == ("stale_rev", 1, True)
    # From the game's own session the view comes back with the moves to pick from.
    refused = _acted(test_client, agent, widget_id, {"type": "move", "args": {"move": "e4"}}, private=1)
    assert refused["code"] == "illegal_action" and "Legal moves" in refused["message"]
    assert {"type": "move", "args": {"move": "e5"}} in refused["view"]["legal"]
    refused = _acted(test_client, agent, widget_id, {"type": "end"})
    assert (refused["code"], refused["message"]) == ("forbidden", "An agent can't end a game")
    assert _row(test_client, widget_id).status == "active"
    _human_move(test_client, bob, widget_id, {"type": "end"})
    refused = _acted(test_client, agent, widget_id, e5)
    assert (refused["code"], refused["view"]["status"], refused["view"]["legal"]) == ("ended", "aborted", [])
    assert refused["view"]["instructions"].startswith("This game is over")
    assert _list(test_client, agent) == []
    # Malformed bodies are the client's bug, not the game's: plain 422s.
    for body in ({"type": "move", "extra": 1}, {"type": "move", "args": {"x": "y" * 1100}}, {"type": ""}):
        assert _agent_act(test_client, agent, widget_id, body).status_code == 422


def test_a_hit_keeps_the_move_and_the_view_comes_back(test_client):
    _, bob, agent, _, dm = _setup(test_client, "agwbattle")
    r = _begin(test_client, bob, dm, "battleship", "blue")  # the agent is red and shoots first
    assert r.status_code == 201, r.text
    widget_id = r.json()["widget_id"]
    ready = _acted(test_client, agent, widget_id, {"type": "ready"}, private=1)
    assert (ready["compact"], ready["your_move"], ready["view"]) == ("ok · rev 1 · waiting on blue", False, None)
    _human_move(test_client, bob, widget_id, {"type": "ready"})
    fleet = _row(test_client, widget_id).state["fleets"]["blue"]
    ship = next(ship for ship in fleet if len(ship) > 1)
    water = next(
        f"{col}{row}"
        for col in "ABCDEFGHIJ"
        for row in range(1, 11)
        if not any(f"{col}{row}" in s for s in fleet)
    )
    hit = _acted(test_client, agent, widget_id, {"type": "fire", "args": {"at": ship[0]}}, private=1)
    assert (hit["ok"], hit["your_move"], hit["compact"]) == (True, True, "ok · rev 3 · waiting on you")
    taps = [e["args"]["at"] for e in hit["view"]["legal"] if e["type"] == "fire"]
    assert len(taps) == 99 and ship[0] not in taps
    assert "Your fleet" in hit["view"]["text"]  # its own seat's view, as asked
    miss = _acted(test_client, agent, widget_id, {"type": "fire", "args": {"at": water}}, private=1)
    assert (miss["your_move"], miss["view"], miss["compact"]) == (False, None, "ok · rev 4 · waiting on blue")


def test_agent_moves_cost_no_tokens(test_client, _test_engine):
    bob, agent, dm, widget_id = _chess(test_client, "agwfree")
    with Session(_test_engine) as db:
        row = db.get(Agent, agent["agent_id"])
        row.cb_tokens = 0
        db.add(row)
        db.commit()
    # A billed write is refused at this balance ...
    r = test_client.post(
        f"/api/agentic/mm/channels/{dm}/posts",
        json={"message": "hi"},
        headers=auth_headers(agent["api_key"]),
    )
    assert r.status_code == 402, r.text
    # ... but moves, refusals and reads go through and cost nothing.
    _human_move(test_client, bob, widget_id, {"type": "move", "args": {"move": "e4"}})
    assert _acted(test_client, agent, widget_id, {"type": "move", "args": {"move": "e4"}})["code"] == "illegal_action"
    assert _acted(test_client, agent, widget_id, {"type": "move", "args": {"move": "e5"}})["ok"] is True
    _view(test_client, agent, widget_id)
    _list(test_client, agent, waiting=1)
    assert _tokens(test_client, agent["agent_id"]) == 0


def test_an_agent_past_its_moves_a_minute_is_told_to_wait(test_client, monkeypatch):
    monkeypatch.setattr(limits, "AGENT_ACT", limits.Limit("agent-act", 2))
    _, agent, _, widget_id = _chess(test_client, "agwlimit")
    e5 = {"type": "move", "args": {"move": "e5"}}
    for _ in range(2):  # refused for the game's reasons, but each one counts
        assert _acted(test_client, agent, widget_id, e5)["code"] == "not_your_turn"
    limited = _acted(test_client, agent, widget_id, e5)
    assert (limited["ok"], limited["code"], limited["view"]["widget_id"]) == (False, "rate_limited", widget_id)
    assert re.fullmatch(r"Too many moves; retry in ~\d+s", limited["message"])


def test_people_past_their_moves_or_starts_a_minute_get_a_429(test_client, monkeypatch):
    monkeypatch.setattr(limits, "HUMAN_ACT", limits.Limit("human-act", 1))
    monkeypatch.setattr(limits, "CREATE", limits.Limit("create", 1))
    bob, _, dm, widget_id = _chess(test_client, "agwhuman")
    r = _begin(test_client, bob, dm, "chess", "white")  # past the cap before the one-active rule
    assert r.status_code == 429 and re.fullmatch(r"Too many requests; retry in ~\d+s", r.json()["detail"])
    _human_move(test_client, bob, widget_id, {"type": "move", "args": {"move": "e4"}})
    r = _act(test_client, bob, {"widget_id": widget_id, "rev": 1}, {"type": "end"})
    assert r.status_code == 429 and re.fullmatch(r"Too many requests; retry in ~\d+s", r.json()["detail"])


def test_each_test_starts_with_no_limit_spent(test_client):
    # This test's own key only: a late wake from the test before, or a dev server on the same
    # Redis, may hold others.
    key = f"{limits.KEY_PREFIX}create:1"
    assert limits.client().get(key) is None
    assert limits.retry_after(limits.CREATE, 1) is None
    assert limits.client().get(key) == "1"


def test_limits_fail_open_without_redis(test_client, monkeypatch, caplog):
    down = redis.Redis.from_url("redis://127.0.0.1:1/0", socket_connect_timeout=0.2, socket_timeout=0.2)
    monkeypatch.setattr(limits, "_client", down)
    with caplog.at_level(logging.WARNING, logger=limits.__name__):
        assert all(limits.retry_after(limits.AGENT_ACT, "agent-x") is None for _ in range(3))
    assert "not checked: Redis unreachable" in caplog.text


@pytest.mark.parametrize("seat", ["red", "blue"])
def test_the_agent_bets_its_blackjack_seat(test_client, seat):
    """Both seats bet at once: whichever the agent holds, its bet goes in while Bob's is awaited."""
    _, bob, agent, _, dm = _setup(test_client, f"agwbj-{seat}")
    other = "blue" if seat == "red" else "red"
    r = _begin(test_client, bob, dm, "blackjack", other)
    assert r.status_code == 201, r.text
    widget_id = r.json()["widget_id"]
    own = _view(test_client, agent, widget_id, private=1)
    assert (own["seat"], own["waiting_on"], own["your_move"]) == (seat, ["red", "blue"], True)
    bet = own["legal"][0]
    assert bet == {"type": "bet", "args_spec": {"arg": "amount", "min": 10, "max": 1000, "step": 10}}
    acted = _acted(test_client, agent, widget_id, {"type": "bet", "args": {"amount": 50}})
    assert (acted["your_move"], acted["compact"]) == (False, f"ok · rev 1 · waiting on {other}")
