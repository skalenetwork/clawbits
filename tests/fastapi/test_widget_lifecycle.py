"""A player leaving: their game ends ("left") for the others, whichever way they go."""

import uuid

import pytest
from sqlmodel import Session, select
from starlette.testclient import TestClient

from clawbits.db.models import MmChannelMember, MmWidget, MmWidgetSeat
from clawbits.db.table_write import TableWrite
from clawbits.widgets import KINDS
from tests.fastapi._auth_helpers import auth_headers, login_human, personal_org_id
from tests.fastapi.test_mattermost import _write_headers
from tests.fastapi.test_widgets import _FakeBus, _game, _widget_turns, _widget_updates

_LEFT = {"reason": "left"}


def _seat_agent(tc: TestClient, widget: dict, seat: str, agent_id: str) -> None:
    """Hand ``seat`` to an agent behind the API's back: through the API an agent takes a seat only in
    its own DM or agent chat, and this game is between people. Not a member of the chat, so a full
    delete leaves the DM (and its game) standing."""
    with Session(tc.app._engine) as db:
        row = db.exec(
            select(MmWidgetSeat)
            .where(MmWidgetSeat.widget_id == widget["widget_id"])
            .where(MmWidgetSeat.seat == seat)
        ).one()
        row.human_id, row.agent_id = None, agent_id
        db.add(row)
        db.commit()


def _ended(tc: TestClient, widget: dict) -> tuple[str, dict | None, list[str]]:
    with Session(tc.app._engine) as db:
        row = db.get(MmWidget, widget["widget_id"])
        return row.status, row.outcome, row.waiting_on


def test_leaving_a_dm_ends_its_game_for_the_one_who_stays(test_client, monkeypatch):
    from clawbits.realtime import bus as bus_module

    alice, bob, _, channel_id, widget = _game(test_client, "wleave")
    fake = _FakeBus()
    monkeypatch.setattr(bus_module, "_bus", fake)
    r = test_client.delete(
        f"/api/human/mm/channels/{channel_id}/members/{bob['user']['id']}?member_type=human",
        headers=auth_headers(bob["access_token"]),
    )
    assert r.status_code == 200, r.text
    assert r.json()["channel_deleted"] is False  # Alice is still in it
    assert _ended(test_client, widget) == ("aborted", _LEFT, [])
    updates = _widget_updates(fake)
    assert [(u["widget_id"], u["status"], u["outcome"]) for u in updates] == [
        (widget["widget_id"], "aborted", _LEFT)
    ]
    assert {e["data"]["my_turn"] for _, e in _widget_turns(fake, 2)} == {False}
    r = test_client.get(
        f"/api/human/mm/widgets/{widget['widget_id']}", headers=auth_headers(alice["access_token"])
    )
    assert (r.json()["status"], r.json()["outcome"]) == ("aborted", _LEFT)


def test_leaving_a_dm_with_an_agent_tells_the_agent_its_game_ended(test_client, monkeypatch):
    """The last person leaving takes the DM and its game along, but the agent seated in it still
    hears the game end, read before the cascade."""
    from clawbits.realtime import bus as bus_module
    from tests.fastapi.test_agent_widgets import _begin, _setup

    _, bob, agent, _, dm = _setup(test_client, "wleaveagent")
    r = _begin(test_client, bob, dm, "chess", "black")  # the agent has White: it's its move
    assert r.status_code == 201, r.text
    widget_id = r.json()["widget_id"]
    fake = _FakeBus()
    monkeypatch.setattr(bus_module, "_bus", fake)
    r = test_client.delete(
        f"/api/human/mm/channels/{dm}/members/{bob['user']['id']}?member_type=human",
        headers=auth_headers(bob["access_token"]),
    )
    assert r.status_code == 200, r.text
    assert r.json()["channel_deleted"] is True
    with Session(test_client.app._engine) as db:
        assert db.get(MmWidget, widget_id) is None
    updates = _widget_updates(fake)
    assert [(u["widget_id"], u["status"], u["outcome"]) for u in updates] == [(widget_id, "aborted", _LEFT)]
    wakes = [e["data"] for t, e in _widget_turns(fake, 2) if t == f"agent:{agent['agent_id']}"]
    assert [(w["widget_id"], w["rev"], w["waiting"], w["status"]) for w in wakes] == [
        (widget_id, 1, False, "aborted")
    ]


def test_an_agent_removed_over_the_agentic_api_ends_its_game(
    test_client, monkeypatch, create_agent_and_key
):
    from clawbits.realtime import bus as bus_module

    agent_id, api_key = str(create_agent_and_key[0]), str(create_agent_and_key[1])
    r = test_client.post(
        "/api/agentic/mm/channels",
        json={"name": "wagentleave", "channel_type": "public"},
        headers=_write_headers(test_client, api_key),
    )
    assert r.status_code == 200, r.text
    channel_id = r.json()["channel_id"]
    # Seeded: games can't start in group channels yet (agents take seats only in 1:1 chats).
    chess = KINDS["chess"]
    state = chess.init()
    widget = {"widget_id": uuid.uuid4().hex, "channel_id": channel_id}
    with Session(test_client.app._engine) as db:
        db.add(
            MmWidget(
                **widget,
                kind="chess",
                state=state,
                turn=chess.turn(state),
                waiting_on=list(chess.waiting_on(state)),
            )
        )
        db.flush()
        db.add(MmWidgetSeat(widget_id=widget["widget_id"], seat="white", agent_id=agent_id))
        db.commit()
    fake = _FakeBus()
    monkeypatch.setattr(bus_module, "_bus", fake)
    r = test_client.delete(
        f"/api/agentic/mm/channels/{channel_id}/members/{agent_id}",
        headers=_write_headers(test_client, api_key),
    )
    assert r.status_code == 200, r.text
    assert _ended(test_client, widget) == ("aborted", _LEFT, [])
    updates = _widget_updates(fake)
    assert [(u["widget_id"], u["status"], u["outcome"]) for u in updates] == [
        (widget["widget_id"], "aborted", _LEFT)
    ]


@pytest.mark.parametrize("keep_content", [True, False], ids=["keep_content", "full"])
def test_deleting_a_seated_agent_ends_its_game_and_frees_the_seat(
    test_client, monkeypatch, create_agent_and_key, keep_content
):
    """``mm_widget_seats.agent_id`` has no cascade: either delete path drops the seat first."""
    from clawbits.realtime import bus as bus_module

    agent_id = str(create_agent_and_key[0])
    alice, _, _, _, widget = _game(test_client, f"wdelagent-{keep_content}")
    _seat_agent(test_client, widget, "black", agent_id)
    operator_token, _ = login_human(test_client)
    org_id = personal_org_id(test_client, operator_token)
    fake = _FakeBus()
    monkeypatch.setattr(bus_module, "_bus", fake)
    r = test_client.delete(
        f"/api/human/orgs/{org_id}/agents/{agent_id}?keep_content={str(keep_content).lower()}",
        headers=auth_headers(operator_token),
    )
    assert r.status_code == 200, r.text
    assert _ended(test_client, widget) == ("aborted", _LEFT, [])
    with Session(test_client.app._engine) as db:
        seats = db.exec(
            select(MmWidgetSeat.seat, MmWidgetSeat.human_id, MmWidgetSeat.agent_id).where(
                MmWidgetSeat.widget_id == widget["widget_id"]
            )
        ).all()
    assert [tuple(s) for s in seats] == [("white", alice["user"]["id"], None)]
    updates = _widget_updates(fake)
    assert [(u["widget_id"], u["status"], u["outcome"]) for u in updates] == [
        (widget["widget_id"], "aborted", _LEFT)
    ]


def test_a_full_delete_still_announces_its_dms_game(
    test_client, monkeypatch, create_agent_and_key
):
    """The DM goes whole on a full delete, its game with it, but the game was read as ended first,
    so the person in that DM still hears it end."""
    from clawbits.realtime import bus as bus_module

    agent_id = str(create_agent_and_key[0])
    _, _, _, channel_id, widget = _game(test_client, "wdelagentdm")
    _seat_agent(test_client, widget, "black", agent_id)
    with Session(test_client.app._engine) as db:
        db.add(MmChannelMember(channel_id=channel_id, agent_id=agent_id))
        db.commit()
    operator_token, _ = login_human(test_client)
    org_id = personal_org_id(test_client, operator_token)
    fake = _FakeBus()
    monkeypatch.setattr(bus_module, "_bus", fake)
    r = test_client.delete(
        f"/api/human/orgs/{org_id}/agents/{agent_id}", headers=auth_headers(operator_token)
    )
    assert r.status_code == 200, r.text
    with Session(test_client.app._engine) as db:
        assert db.get(MmWidget, widget["widget_id"]) is None
    updates = _widget_updates(fake)
    assert [(u["widget_id"], u["status"], u["outcome"], u["waiting_on"]) for u in updates] == [
        (widget["widget_id"], "aborted", _LEFT, [])
    ]


def test_delete_agent_frees_a_finished_games_seat_too(test_client, create_agent_and_key):
    agent_id = str(create_agent_and_key[0])
    alice, _, _, _, widget = _game(test_client, "wdelagentdone")
    _seat_agent(test_client, widget, "black", agent_id)
    r = test_client.post(
        f"/api/human/mm/widgets/{widget['widget_id']}/actions",
        json={"action": {"type": "resign", "args": {}}, "expected_rev": widget["rev"]},
        headers=auth_headers(alice["access_token"]),
    )
    assert r.status_code == 200, r.text
    with Session(test_client.app._engine) as db:
        TableWrite.delete_agent(db, agent_id, keep_content=True)
        db.commit()
    with Session(test_client.app._engine) as db:
        assert db.exec(select(MmWidgetSeat).where(MmWidgetSeat.agent_id == agent_id)).all() == []
        assert db.get(MmWidget, widget["widget_id"]).status == "finished"
