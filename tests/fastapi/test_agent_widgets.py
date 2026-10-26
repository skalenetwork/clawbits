"""Agents in widget seats, the human side: who may start a game with an agent, its consent, the
agent's seat as people see it, its operator's End, the poker showdown deal, and older boards."""

import pytest
from sqlmodel import Session, select
from starlette.testclient import TestClient

from clawbits.db.models import Agent, MmWidget, MmWidgetSeat
from clawbits.db.table_read import TableRead
from clawbits.widgets import KINDS
from clawbits.widgets import service as widget_service
from clawbits.widgets.service import Participant, WidgetError
from tests.fastapi._auth_helpers import (
    add_human_to_org,
    auth_headers,
    personal_org_id,
    register_human,
)
from tests.fastapi.test_agent_contact_permissions import _grant
from tests.fastapi.test_human_mattermost import _create_agent, _open_dm
from tests.fastapi.test_widgets import (
    _act,
    _FakeBus,
    _move,
    _start,
    _switch_chat,
    _switch_org,
    _widget_turns,
    _widget_updates,
)
from tests.fastapi.test_widgets import _game as _people_game

_CANT_PLAY = "This agent can't play games"
_END = {"type": "end", "args": {}}


def _alive(tc: TestClient, agent: dict, agent_type: str, capabilities: list[str]) -> None:
    r = tc.post(
        "/api/agentic/alive",
        json={"agent_type": agent_type, "capabilities": capabilities},
        headers=auth_headers(agent["api_key"]),
    )
    assert r.status_code == 200, r.text


def _settings(tc: TestClient, who: dict, org_id: str, agent_id: str, **body):
    return tc.patch(
        f"/api/human/orgs/{org_id}/agents/{agent_id}/settings",
        json=body,
        headers=auth_headers(who["access_token"]),
    )


def _setup(tc: TestClient, prefix: str) -> tuple[dict, dict, dict, str, str]:
    """Alice owns the org and operates an agent that may play; Bob, a member allowed to DM it,
    opens a DM with it that Alice isn't in. Both widget switches on there."""
    alice = register_human(tc, f"{prefix}-alice@test.com", "Alice")
    bob = register_human(tc, f"{prefix}-bob@test.com", "Bob")
    org_id = personal_org_id(tc, alice["access_token"])
    add_human_to_org(tc, alice["access_token"], org_id, bob["user"]["email"])
    agent = _create_agent(tc, owner_email=f"{prefix}-alice@test.com")
    _alive(tc, agent, "openclaw", ["widgets"])
    r = _settings(tc, alice, org_id, agent["agent_id"], widgets_enabled=True)
    assert (r.status_code, r.json()["widgets_enabled"]) == (200, True), r.text
    r = _grant(tc, alice["access_token"], agent["agent_id"], "human", bob["user"]["id"], can_dm=True)
    assert r.status_code == 200, r.text
    assert _switch_org(tc, alice, org_id, True).status_code == 200
    dm = _open_dm(tc, bob["access_token"], org_id, agent["agent_id"], "agent")["channel_id"]
    assert _switch_chat(tc, bob, dm, True).status_code == 200
    return alice, bob, agent, org_id, dm


def _begin(tc: TestClient, who: dict, channel_id: str, kind: str, seat: str):
    return tc.post(
        f"/api/human/mm/channels/{channel_id}/widgets",
        json={"kind": kind, "seat": seat},
        headers=auth_headers(who["access_token"]),
    )


def _agent_act(tc: TestClient, agent: dict, widget_id: str, kind: str, **args) -> dict:
    """An agent's move through the service itself, past its REST route (``test_agentic_widgets``
    covers that), so these tests read the service's own answers."""
    with Session(tc.app._engine) as db:
        action = {"type": kind, "args": args}
        return widget_service.act(db, Participant.agent(agent["agent_id"]), widget_id, action, None).view


def _row(tc: TestClient, widget_id: str) -> MmWidget:
    with Session(tc.app._engine) as db:
        return db.get(MmWidget, widget_id)


def _channels(tc: TestClient, who: dict, org_id: str) -> dict[str, dict]:
    r = tc.get(f"/api/human/mm/channels?org_id={org_id}", headers=auth_headers(who["access_token"]))
    assert r.status_code == 200, r.text
    return {c["channel_id"]: c for c in r.json()["channels"]}


@pytest.mark.parametrize("chat", ["direct", "agent_chat"])
def test_a_person_starts_a_game_with_an_agent(test_client, chat):
    alice, bob, agent, org_id, channel_id = _setup(test_client, f"awstart-{chat}")
    agent_id = agent["agent_id"]
    r = test_client.patch(  # its id is a generated name too: give it one of its own
        f"/api/human/orgs/{org_id}/agents/{agent_id}/name",
        json={"nickname": "Deep Blue"},
        headers=auth_headers(alice["access_token"]),
    )
    assert r.status_code == 200, r.text
    if chat == "agent_chat":
        r = test_client.post(
            "/api/human/mm/agent-chats",
            json={"org_id": org_id, "agent_id": agent_id},
            headers=auth_headers(bob["access_token"]),
        )
        assert r.status_code == 200, r.text
        channel_id = r.json()["channel_id"]
        assert _start(test_client, bob, channel_id).status_code == 403  # the chat's switch is off
        assert _switch_chat(test_client, bob, channel_id, True).json()["widgets_enabled"] is True
    r = _start(test_client, bob, channel_id)
    assert r.status_code == 201, r.text
    widget = r.json()
    with Session(test_client.app._engine) as db:
        rows = db.exec(select(MmWidgetSeat).where(MmWidgetSeat.widget_id == widget["widget_id"])).all()
    assert sorted((s.seat, s.human_id, s.agent_id) for s in rows) == [
        ("black", None, agent_id),
        ("white", bob["user"]["id"], None),
    ]
    assert [(s["seat"], s["display_name"], s["is_agent"]) for s in widget["seats"]] == [
        ("white", "Bob", False),
        ("black", "Deep Blue", True),
    ]
    assert all(s["avatar"]["url"] for s in widget["seats"])
    assert (widget["turn"], widget["waiting_on"]) == ("white", ["white"])
    posts = test_client.get(
        f"/api/human/mm/channels/{channel_id}/posts", headers=auth_headers(bob["access_token"])
    ).json()["posts"]
    assert [p["widget_id"] for p in posts] == [widget["widget_id"]]
    assert posts[0]["message"].startswith("♟ Bob started a chess game · ")
    # The agent's move comes back to Bob as people's do.
    widget = _act(test_client, bob, widget, {"type": "move", "args": {"move": "e4"}}).json()
    widget = _agent_act(test_client, agent, widget["widget_id"], "move", move="e5")
    assert (widget["rev"], widget["turn"], widget["scene"]["log"]) == (2, "white", ["1. e4", "e5"])
    assert _channels(test_client, bob, org_id)[channel_id]["widget_turn"] is True


def test_an_agent_sees_its_own_seat(test_client):
    _, bob, agent, _, dm = _setup(test_client, "awview")
    r = _begin(test_client, bob, dm, "battleship", "red")
    assert r.status_code == 201, r.text
    widget_id = r.json()["widget_id"]
    with Session(test_client.app._engine) as db:
        mine = TableRead.get_mm_widget(db, widget_id, viewer_agent_id=agent["agent_id"])
        public = TableRead.get_mm_widget(db, widget_id)
    own, enemy = mine["scene"]["boards"]
    assert (own["id"], len(own["tokens"]), enemy["id"], enemy["tokens"]) == ("blue", 10, "red", [])
    assert all(board["tokens"] == [] for board in public["scene"]["boards"])


@pytest.mark.parametrize(
    "why", ["no_capability", "setting_off", "ironclaw", "no_type", "snoozed"]
)
def test_an_agent_that_cant_play_is_refused(test_client, why):
    alice, bob, agent, org_id, dm = _setup(test_client, f"awrefuse-{why}")
    agent_id = agent["agent_id"]
    if why == "no_capability":
        _alive(test_client, agent, "openclaw", [])
    elif why == "setting_off":
        assert _settings(test_client, alice, org_id, agent_id, widgets_enabled=False).status_code == 200
    elif why == "ironclaw":
        _alive(test_client, agent, "ironclaw", ["widgets"])
    elif why == "no_type":
        with Session(test_client.app._engine) as db:
            row = db.get(Agent, agent_id)
            row.agent_type = None
            db.add(row)
            db.commit()
    else:
        assert _settings(test_client, alice, org_id, agent_id, snoozed=True).status_code == 200
    r = _start(test_client, bob, dm)
    assert (r.status_code, r.json()["detail"]) == (422, _CANT_PLAY)
    # The chat offers a game only where one could start now: a snoozed agent's no more than the rest.
    assert _channels(test_client, bob, org_id)[dm]["widgets_supported"] is False
    with Session(test_client.app._engine) as db:
        assert db.exec(select(MmWidget).where(MmWidget.channel_id == dm)).all() == []


def test_a_person_the_agent_no_longer_takes_cannot_start_one(test_client):
    alice, bob, agent, _, dm = _setup(test_client, "awcontact")
    r = _grant(test_client, alice["access_token"], agent["agent_id"], "human", bob["user"]["id"], can_dm=False)
    assert r.status_code == 200, r.text
    # The chat's own gate answers first, as for any other request in it ...
    r = _start(test_client, bob, dm)
    assert (r.status_code, r.json()["detail"]) == (403, "Not permitted to contact this agent")
    # ... and the service checks the agent's side again whoever calls it.
    with Session(test_client.app._engine) as db, pytest.raises(WidgetError) as refused:
        widget_service.create(db, bob["user"]["id"], dm, "chess", "white", frontend_root="http://x")
    assert (refused.value.code, refused.value.status_code, refused.value.detail) == (
        "agent_unavailable",
        422,
        _CANT_PLAY,
    )


def test_the_chat_list_says_where_games_can_start(test_client):
    alice, bob, agent, org_id, dm = _setup(test_client, "awlist")
    people = test_client.post(
        "/api/human/mm/direct",
        json={"org_id": org_id, "target_type": "human", "target_id": str(alice["user"]["id"])},
        headers=auth_headers(bob["access_token"]),
    ).json()["channel_id"]
    group = test_client.post(
        "/api/human/mm/channels",
        json={"org_id": org_id, "name": "awlist-general"},
        headers=auth_headers(alice["access_token"]),
    ).json()["channel_id"]
    chat = test_client.post(
        "/api/human/mm/agent-chats",
        json={"org_id": org_id, "agent_id": agent["agent_id"]},
        headers=auth_headers(bob["access_token"]),
    ).json()["channel_id"]
    supported = {k: c["widgets_supported"] for k, c in _channels(test_client, bob, org_id).items()}
    assert (supported[dm], supported[people], supported[chat]) == (True, True, True)
    assert not _channels(test_client, alice, org_id)[group]["widgets_supported"]
    assert _switch_chat(test_client, alice, group, True).status_code == 400  # groups: not yet
    assert _settings(test_client, alice, org_id, agent["agent_id"], widgets_enabled=False).status_code == 200
    supported = {k: c["widgets_supported"] for k, c in _channels(test_client, bob, org_id).items()}
    assert (supported[dm], supported[people], supported[chat]) == (False, True, False)


def test_switching_an_agents_games_off_ends_them(test_client, monkeypatch):
    from clawbits.realtime import bus as bus_module

    alice, bob, agent, org_id, dm = _setup(test_client, "awoff")
    widget = _start(test_client, bob, dm).json()
    fake = _FakeBus()
    monkeypatch.setattr(bus_module, "_bus", fake)
    test_client.app.state.workos.audit_events.clear()
    r = _settings(test_client, alice, org_id, agent["agent_id"], widgets_enabled=False)
    assert (r.status_code, r.json()["widgets_enabled"]) == (200, False), r.text
    ended = test_client.get(
        f"/api/human/mm/widgets/{widget['widget_id']}", headers=auth_headers(bob["access_token"])
    ).json()
    assert (ended["status"], ended["outcome"], ended["waiting_on"]) == ("aborted", {"reason": "games_off"}, [])
    assert ended["scene"]["status"]["text"] == "The agent's games were switched off"
    updates = _widget_updates(fake)
    assert [(u["widget_id"], u["status"]) for u in updates] == [(widget["widget_id"], "aborted")]
    turns = [e["data"]["my_turn"] for t, e in _widget_turns(fake, 1) if t.startswith("human:")]
    assert turns == [False]
    audited = [
        e["event"] for e in test_client.app.state.workos.audit_events
        if e["event"].action == "agent.widgets_updated"
    ]
    assert [(e.targets[0].id, e.metadata) for e in audited] == [
        (agent["agent_id"], {"enabled": "false", "ended": "1"})
    ]
    assert _start(test_client, bob, dm).status_code == 422


def test_an_org_owner_may_switch_an_agents_games_but_nothing_else(test_client):
    alice, bob, agent, org_id, _ = _setup(test_client, "awowner")
    carol = register_human(test_client, "awowner-carol@test.com", "Carol")
    add_human_to_org(test_client, alice["access_token"], org_id, carol["user"]["email"])
    with Session(test_client.app._engine) as db:  # Carol operates it now; Alice only owns the org
        row = db.get(Agent, agent["agent_id"])
        row.operator_id = carol["user"]["id"]
        db.add(row)
        db.commit()
    agent_id = agent["agent_id"]
    assert _settings(test_client, alice, org_id, agent_id, widgets_enabled=False).json()["widgets_enabled"] is False
    assert _settings(test_client, alice, org_id, agent_id, widgets_enabled=True, snoozed=False).status_code == 403
    assert _settings(test_client, bob, org_id, agent_id, widgets_enabled=True).status_code == 403
    assert _settings(test_client, carol, org_id, agent_id, widgets_enabled=True).json()["widgets_enabled"] is True


def test_the_agents_operator_ends_its_game_from_outside_the_chat(test_client, monkeypatch):
    from clawbits.realtime import bus as bus_module

    alice, bob, _, org_id, dm = _setup(test_client, "awopend")
    eve = register_human(test_client, "awopend-eve@test.com", "Eve")
    add_human_to_org(test_client, alice["access_token"], org_id, eve["user"]["email"])
    widget = _start(test_client, bob, dm).json()
    for outsider in (eve, alice):  # neither may move here; only Alice operates the agent
        r = _act(test_client, outsider, widget, {"type": "move", "args": {"move": "e4"}})
        assert (r.status_code, r.json()["detail"]) == (404, "Widget not found")
    r = _act(test_client, eve, widget, _END)
    assert (r.status_code, r.json()["detail"]) == (404, "Widget not found")
    fake = _FakeBus()
    monkeypatch.setattr(bus_module, "_bus", fake)
    r = _act(test_client, alice, widget, _END)
    assert r.status_code == 200, r.text
    assert (r.json()["status"], r.json()["outcome"]) == ("aborted", {"reason": "stopped"})
    assert [(u["widget_id"], u["status"]) for u in _widget_updates(fake)] == [(widget["widget_id"], "aborted")]
    r = _act(test_client, alice, widget, _END)
    assert (r.status_code, r.json()["detail"]) == (409, "This widget has ended")


def test_an_operator_removed_from_the_org_can_no_longer_end_its_game(test_client):
    alice, bob, agent, org_id, dm = _setup(test_client, "awopgone")
    carol = register_human(test_client, "awopgone-carol@test.com", "Carol")
    add_human_to_org(test_client, alice["access_token"], org_id, carol["user"]["email"])
    with Session(test_client.app._engine) as db:  # Carol operates the agent
        row = db.get(Agent, agent["agent_id"])
        row.operator_id = carol["user"]["id"]
        db.add(row)
        db.commit()
    widget = _start(test_client, bob, dm).json()
    r = test_client.delete(
        f"/api/human/orgs/{org_id}/members/{carol['user']['id']}", headers=auth_headers(alice["access_token"])
    )
    assert r.status_code == 200, r.text
    # Still the agent's operator_id, but out of its org: no power over it, nor a look at the game.
    r = _act(test_client, carol, widget, _END)
    assert (r.status_code, r.json()["detail"]) == (404, "Widget not found")
    assert _row(test_client, widget["widget_id"]).status == "active"


def test_at_a_poker_showdown_against_an_agent_the_person_deals(test_client):
    _, bob, agent, org_id, dm = _setup(test_client, "awdeal")
    r = _begin(test_client, bob, dm, "poker", "red")  # Bob has the button in hand 1
    assert r.status_code == 201, r.text
    widget_id = r.json()["widget_id"]
    for _ in range(20):  # call and check it down to the showdown
        row = _row(test_client, widget_id)
        if row.state["phase"] == "showdown":
            break
        (seat,) = row.waiting_on
        for move in ("check", "call"):
            if seat == "red":
                r = _act(test_client, bob, {"widget_id": widget_id, "rev": row.rev}, {"type": move})
                if r.status_code == 200:
                    break
                assert r.status_code == 422, r.text
            else:
                try:
                    _agent_act(test_client, agent, widget_id, move)
                    break
                except WidgetError as e:
                    assert e.code == "illegal_action"
    row = _row(test_client, widget_id)
    assert (row.status, row.state["phase"]) == ("active", "showdown")
    # The next hand is the agent's to deal, but Bob deals it.
    assert KINDS["poker"].waiting_on(row.state) == ("blue",)
    assert (row.turn, row.waiting_on) == ("red", ["red"])
    assert _channels(test_client, bob, org_id)[dm]["widget_turn"] is True
    with pytest.raises(WidgetError) as refused:
        _agent_act(test_client, agent, widget_id, "deal")
    assert (refused.value.code, refused.value.status_code) == ("not_your_turn", 403)
    r = _act(test_client, bob, {"widget_id": widget_id, "rev": row.rev}, {"type": "deal"})
    assert r.status_code == 200, r.text
    dealt = _row(test_client, widget_id)
    assert (dealt.state["hand"], dealt.state["button"], dealt.waiting_on) == (2, "blue", ["blue"])
    with Session(test_client.app._engine) as db:
        mine = TableRead.get_mm_widget(db, widget_id, viewer_agent_id=agent["agent_id"])
    hands = {row["id"]: row["cards"] for row in mine["scene"]["table"]["rows"]}
    assert hands["red"] == ["back", "back"] and "back" not in hands["blue"]


def test_a_person_may_act_on_a_board_only_the_other_seat_changed(test_client):
    _, bob, agent, _, dm = _setup(test_client, "awstale")
    r = _begin(test_client, bob, dm, "battleship", "red")
    assert r.status_code == 201, r.text
    at_start = r.json()
    shuffled = _act(test_client, bob, at_start, {"type": "shuffle"}).json()  # rev 1: Bob acted
    _agent_act(test_client, agent, at_start["widget_id"], "ready")  # rev 2: only the agent
    stale = (409, "The widget changed meanwhile; try again")
    # Bob's own shuffle came after rev 0, so that board is too old for him ...
    r = _act(test_client, bob, at_start, {"type": "ready"})
    assert (r.status_code, r.json()["detail"]) == stale
    # ... and on rev 1 an action the kind refuses now is still the old board's fault ...
    r = _act(test_client, bob, shuffled, {"type": "fire", "args": {"at": "A1"}})
    assert (r.status_code, r.json()["detail"]) == stale
    # ... but nothing of his changed since rev 1, so his ready on it counts.
    r = _act(test_client, bob, shuffled, {"type": "ready"})
    assert r.status_code == 200, r.text
    assert (r.json()["rev"], r.json()["turn"]) == (3, "red")


def test_an_older_board_is_too_old_once_the_move_came_back(test_client):
    """Bob's board from before his last move came round again: what it shows isn't his position."""
    alice, bob, _, _, at_start = _people_game(test_client, "awstalehanded")
    after_e4 = _move(test_client, alice, at_start, "e4")
    after_e5 = _move(test_client, bob, after_e4, "e5")
    _move(test_client, alice, after_e5, "Nf3")  # rev 3: the move is Bob's again
    r = _act(test_client, bob, after_e5, {"type": "move", "args": {"move": "Nc6"}})
    assert (r.status_code, r.json()["detail"]) == (409, "The widget changed meanwhile; try again")


def test_a_malformed_capability_list_never_costs_the_ping(test_client):
    alice, _, agent, org_id, _ = _setup(test_client, "awcaps")
    for capabilities in (None, "widgets", [1, {"x": 1}]):
        r = test_client.post(
            "/api/agentic/alive",
            json={"agent_type": "openclaw", "capabilities": capabilities},
            headers=auth_headers(agent["api_key"]),
        )
        assert (r.status_code, r.json()["status"]) == (200, "available"), r.text
        with Session(test_client.app._engine) as db:
            assert db.get(Agent, agent["agent_id"]).capabilities == []
    _alive(test_client, agent, "openclaw", [7, "widgets"])  # the strings in it still count
    with Session(test_client.app._engine) as db:
        assert db.get(Agent, agent["agent_id"]).capabilities == ["widgets"]


def test_two_people_placing_fleets_dont_trip_each_other(test_client):
    from tests.fastapi.test_widgets import _start_battleship, _switched_on

    alice, bob, _, channel_id = _switched_on(test_client, "awstalepeople")
    widget = _start_battleship(test_client, alice, channel_id)
    assert _act(test_client, alice, widget, {"type": "ready"}).status_code == 200
    r = _act(test_client, bob, widget, {"type": "ready"})  # Bob's board is rev 0, Alice's rev 1
    assert r.status_code == 200, r.text
    assert (r.json()["rev"], r.json()["turn"]) == (2, "red")
