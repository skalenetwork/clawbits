"""Chat widgets over HTTP: the two switches, one game's lifecycle, and every way one ends."""

import asyncio
import time
from datetime import UTC, datetime, timedelta

import pytest
from sqlmodel import Session, select
from starlette.testclient import TestClient

import clawbits.fastapi.widget_endpoints as widget_endpoints
import clawbits.widgets.blackjack as blackjack
from clawbits.db.models import MmPost, MmWidget
from clawbits.widgets.cards import DECK
from tests.fastapi._auth_helpers import (
    add_human_to_org,
    auth_headers,
    personal_org_id,
    register_human,
)


def _dm(tc: TestClient, a: dict, b: dict, org_id: str) -> str:
    r = tc.post(
        "/api/human/mm/direct",
        json={"org_id": org_id, "target_type": "human", "target_id": str(b["user"]["id"])},
        headers=auth_headers(a["access_token"]),
    )
    assert r.status_code == 200, r.text
    return r.json()["channel_id"]


def _setup(tc: TestClient, prefix: str) -> tuple[dict, dict, str, str]:
    """Alice owns the org, Bob is a member, and they share a DM. Both switches still off."""
    alice = register_human(tc, f"{prefix}-alice@test.com", "Alice")
    bob = register_human(tc, f"{prefix}-bob@test.com", "Bob")
    org_id = personal_org_id(tc, alice["access_token"])
    add_human_to_org(tc, alice["access_token"], org_id, bob["user"]["email"])
    return alice, bob, org_id, _dm(tc, alice, bob, org_id)


def _switch_org(tc: TestClient, who: dict, org_id: str, enabled: bool):
    return tc.put(
        f"/api/human/orgs/{org_id}/widgets",
        json={"enabled": enabled},
        headers=auth_headers(who["access_token"]),
    )


def _switch_chat(tc: TestClient, who: dict, channel_id: str, enabled: bool):
    return tc.patch(
        f"/api/human/mm/channels/{channel_id}",
        json={"widgets_enabled": enabled},
        headers=auth_headers(who["access_token"]),
    )


def _start(tc: TestClient, who: dict, channel_id: str, seat: str | None = "white"):
    body = {"kind": "chess"} if seat is None else {"kind": "chess", "seat": seat}
    return tc.post(
        f"/api/human/mm/channels/{channel_id}/widgets",
        json=body,
        headers=auth_headers(who["access_token"]),
    )


def _act(tc: TestClient, who: dict, widget: dict, action: dict, rev: int | None = None):
    return tc.post(
        f"/api/human/mm/widgets/{widget['widget_id']}/actions",
        json={"action": action, "expected_rev": widget["rev"] if rev is None else rev},
        headers=auth_headers(who["access_token"]),
    )


def _move(tc: TestClient, who: dict, widget: dict, move: str) -> dict:
    r = _act(tc, who, widget, {"type": "move", "args": {"move": move}})
    assert r.status_code == 200, r.text
    return r.json()


def _game(tc: TestClient, prefix: str) -> tuple[dict, dict, str, str, dict]:
    """Both switches on and a game started, Alice playing White."""
    alice, bob, org_id, channel_id = _setup(tc, prefix)
    assert _switch_org(tc, alice, org_id, True).status_code == 200
    assert _switch_chat(tc, bob, channel_id, True).status_code == 200
    r = _start(tc, alice, channel_id)
    assert r.status_code == 201, r.text
    return alice, bob, org_id, channel_id, r.json()


def test_widgets_need_both_switches(test_client):
    alice, bob, org_id, channel_id = _setup(test_client, "wsw")
    assert _start(test_client, alice, channel_id).status_code == 403
    assert _switch_org(test_client, bob, org_id, True).status_code == 403  # owner only
    assert _switch_org(test_client, alice, org_id, True).status_code == 200
    r = _start(test_client, alice, channel_id)
    assert r.status_code == 403 and "chat" in r.json()["detail"]
    assert _switch_chat(test_client, bob, channel_id, True).json()["widgets_enabled"] is True
    assert _start(test_client, alice, channel_id).status_code == 201
    r = test_client.get(f"/api/human/orgs/{org_id}/widgets", headers=auth_headers(bob["access_token"]))
    assert r.json() == {"enabled": True, "active_count": 1}


def test_start_posts_one_message_and_seats_both(test_client):
    alice, bob, _, channel_id, widget = _game(test_client, "wstart")
    assert widget["status"] == "active" and widget["rev"] == 0 and widget["turn"] == "white"
    assert [(s["seat"], s["human_id"], s["display_name"]) for s in widget["seats"]] == [
        ("white", alice["user"]["id"], "Alice"),
        ("black", bob["user"]["id"], "Bob"),
    ]
    posts = test_client.get(
        f"/api/human/mm/channels/{channel_id}/posts", headers=auth_headers(bob["access_token"])
    ).json()["posts"]
    assert len(posts) == 1
    assert posts[0]["widget_id"] == widget["widget_id"]
    assert widget["post_id"] == posts[0]["post_id"]  # the dock scrolls the chat to it
    assert posts[0]["message"].startswith("♟ Alice started a chess game · ")
    assert posts[0]["message"].endswith(f"/widgets/{widget['widget_id']}")
    assert _start(test_client, bob, channel_id).status_code == 409  # one active per chat
    listed = test_client.get(
        f"/api/human/mm/channels/{channel_id}/widgets", headers=auth_headers(bob["access_token"])
    ).json()["widgets"]
    assert [w["widget_id"] for w in listed] == [widget["widget_id"]]
    assert listed[0]["post_id"] == posts[0]["post_id"]


def test_widgets_run_only_in_dms_between_people(test_client):
    alice, _, org_id, _ = _setup(test_client, "wdm")
    r = test_client.post(
        "/api/human/mm/channels",
        json={"org_id": org_id, "name": "wdm-general"},
        headers=auth_headers(alice["access_token"]),
    )
    assert r.status_code == 200, r.text
    assert _switch_chat(test_client, alice, r.json()["channel_id"], True).status_code == 400


def test_moves_alternate_validate_and_post_nothing(test_client):
    alice, bob, _, channel_id, widget = _game(test_client, "wmove")
    assert _act(test_client, bob, widget, {"type": "move", "args": {"move": "e5"}}).status_code == 403
    widget = _move(test_client, alice, widget, "e4")
    assert widget["rev"] == 1 and widget["turn"] == "black"
    assert widget["scene"]["log"] == ["1. e4"]
    r = _act(test_client, bob, widget, {"type": "move", "args": {"move": "e4"}})
    assert r.status_code == 422 and "Legal moves" in r.json()["detail"]
    r = _act(test_client, bob, widget, {"type": "move", "args": {"move": "e5"}}, rev=0)
    assert r.status_code == 409  # stale board
    widget = _move(test_client, bob, widget, "e5")
    assert widget["scene"]["log"] == ["1. e4", "e5"]
    with Session(test_client.app._engine) as db:
        assert len(db.exec(select(MmPost).where(MmPost.channel_id == channel_id)).all()) == 1


def test_outsiders_cannot_see_or_play(test_client):
    _, _, org_id, _, widget = _game(test_client, "wout")
    eve = register_human(test_client, "wout-eve@test.com")
    r = test_client.get(
        f"/api/human/mm/widgets/{widget['widget_id']}", headers=auth_headers(eve["access_token"])
    )
    assert r.status_code == 404
    assert _act(test_client, eve, widget, {"type": "resign"}).status_code == 404


def test_checkmate_ends_the_game_and_freezes_it(test_client):
    alice, bob, _, _, widget = _game(test_client, "wmate")
    for who, move in zip(
        (alice, bob) * 4, ("e4", "e5", "Bc4", "Nc6", "Qh5", "Nf6", "Qxf7#"), strict=False
    ):
        widget = _move(test_client, who, widget, move)
    assert widget["status"] == "finished" and widget["turn"] is None
    assert widget["outcome"]["winner"] == "white"
    assert _act(test_client, bob, widget, {"type": "resign"}).status_code == 409


def test_chat_switch_holds_while_a_widget_is_active(test_client):
    _, bob, _, channel_id, widget = _game(test_client, "wchat")
    r = _switch_chat(test_client, bob, channel_id, False)
    assert r.status_code == 409
    assert _act(test_client, bob, widget, {"type": "abort"}).json()["status"] == "aborted"
    assert _switch_chat(test_client, bob, channel_id, False).json()["widgets_enabled"] is False


def test_org_switch_holds_until_an_owner_ends_active_widgets(test_client):
    alice, bob, org_id, _, widget = _game(test_client, "worg")
    r = _switch_org(test_client, alice, org_id, False)
    assert r.status_code == 409 and r.json()["detail"].startswith("1 widget still active")
    end = f"/api/human/orgs/{org_id}/widgets/end-active"
    assert test_client.post(end, headers=auth_headers(bob["access_token"])).status_code == 403
    r = test_client.post(end, headers=auth_headers(alice["access_token"]))
    assert r.json() == {"ended": 1}
    ended = test_client.get(
        f"/api/human/mm/widgets/{widget['widget_id']}", headers=auth_headers(bob["access_token"])
    ).json()
    assert ended["status"] == "aborted" and ended["outcome"] == {"reason": "ended"}
    assert ended["scene"]["status"]["text"] == "An organization admin ended it"
    assert _switch_org(test_client, alice, org_id, False).json() == {"enabled": False, "active_count": 0}


def test_sidebar_marks_the_chat_waiting_on_you(test_client):
    alice, bob, org_id, channel_id, widget = _game(test_client, "wturn")

    def waiting(who: dict) -> bool:
        channels = test_client.get(
            f"/api/human/mm/channels?org_id={org_id}", headers=auth_headers(who["access_token"])
        ).json()["channels"]
        return next(c for c in channels if c["channel_id"] == channel_id)["widget_turn"]

    assert (waiting(alice), waiting(bob)) == (True, False)
    _move(test_client, alice, widget, "e4")
    assert (waiting(alice), waiting(bob)) == (False, True)


def test_a_move_publishes_the_scene_and_each_players_turn(test_client, monkeypatch):
    alice, bob, _, channel_id, widget = _game(test_client, "wpub")
    updates: list[tuple[str, int]] = []
    turns: list[tuple[int, bool]] = []

    async def _updated(_bus, channel, payload):
        updates.append((channel, payload["rev"]))

    async def _turn(_bus, human_id, _channel, my_turn):
        turns.append((human_id, my_turn))

    monkeypatch.setattr(widget_endpoints, "publish_widget_updated", _updated)
    monkeypatch.setattr(widget_endpoints, "publish_widget_turn", _turn)
    _move(test_client, alice, widget, "e4")
    deadline = time.monotonic() + 2
    while len(turns) < 2 and time.monotonic() < deadline:
        time.sleep(0.01)
    assert updates == [(channel_id, 1)]
    assert sorted(turns) == sorted([(alice["user"]["id"], False), (bob["user"]["id"], True)])


class _FakeBus:
    def __init__(self) -> None:
        self.published: list[tuple[str, dict]] = []

    async def publish(self, topic: str, event: dict) -> None:
        self.published.append((topic, event))


def test_idle_widgets_are_reaped(test_client, monkeypatch):
    from clawbits.fastapi.mm_maintenance import reap_idle_widgets_once
    from clawbits.realtime import bus as bus_module

    _, bob, _, channel_id, widget = _game(test_client, "widle")
    engine = test_client.app._engine
    assert asyncio.run(reap_idle_widgets_once(engine)) == 0
    with Session(engine) as db:
        row = db.get(MmWidget, widget["widget_id"])
        row.updated_at = datetime.now(UTC) - timedelta(days=2, minutes=1)
        db.add(row)
        db.commit()
    fake = _FakeBus()
    monkeypatch.setattr(bus_module, "_bus", fake)
    assert asyncio.run(reap_idle_widgets_once(engine)) == 1
    reaped = test_client.get(
        f"/api/human/mm/widgets/{widget['widget_id']}", headers=auth_headers(bob["access_token"])
    ).json()
    assert reaped["status"] == "aborted" and reaped["outcome"] == {"reason": "idle"}
    updates = [e for topic, e in fake.published if e["type"] == "widget.updated"]
    assert [(u["channel_id"], u["data"]["status"]) for u in updates] == [(channel_id, "aborted")]
    assert {e["data"]["my_turn"] for _, e in fake.published if e["type"] == "widget.turn"} == {False}


@pytest.mark.parametrize("way", ["delete_post", "leave_org"])
def test_losing_the_message_or_a_player_ends_the_widget(test_client, way):
    alice, bob, org_id, channel_id, widget = _game(test_client, f"wend-{way}")
    if way == "delete_post":
        post_id = test_client.get(
            f"/api/human/mm/channels/{channel_id}/posts", headers=auth_headers(alice["access_token"])
        ).json()["posts"][0]["post_id"]
        r = test_client.delete(f"/api/human/mm/posts/{post_id}", headers=auth_headers(alice["access_token"]))
        assert r.status_code == 204
        reason = "host_deleted"
    else:
        r = test_client.delete(
            f"/api/human/orgs/{org_id}/members/{bob['user']['id']}",
            headers=auth_headers(alice["access_token"]),
        )
        assert r.status_code in (200, 204), r.text
        reason = "left"
    with Session(test_client.app._engine) as db:
        row = db.get(MmWidget, widget["widget_id"])
        assert (row.status, row.outcome) == ("aborted", {"reason": reason})
    assert _switch_org(test_client, alice, org_id, False).status_code == 200


def test_battleship_keeps_each_fleet_private(test_client, monkeypatch):
    alice, bob, org_id, channel_id = _setup(test_client, "wbs")
    assert _switch_org(test_client, alice, org_id, True).status_code == 200
    assert _switch_chat(test_client, alice, channel_id, True).status_code == 200
    published: list[dict] = []

    async def _updated(_bus, _channel, payload):
        published.append(payload)

    monkeypatch.setattr(widget_endpoints, "publish_widget_updated", _updated)
    r = test_client.post(
        f"/api/human/mm/channels/{channel_id}/widgets",
        json={"kind": "battleship", "seat": "red"},
        headers=auth_headers(alice["access_token"]),
    )
    assert r.status_code == 201, r.text
    widget = r.json()
    assert widget["private"] is True and widget["turn"] is None
    own, enemy = widget["scene"]["boards"]
    assert (own["id"], len(own["tokens"]), enemy["tokens"]) == ("red", 10, [])
    as_bob = test_client.get(
        f"/api/human/mm/widgets/{widget['widget_id']}", headers=auth_headers(bob["access_token"])
    ).json()
    assert [b["id"] for b in as_bob["scene"]["boards"]] == ["blue", "red"]
    assert len(as_bob["scene"]["boards"][0]["tokens"]) == 10 and as_bob["scene"]["boards"][1]["tokens"] == []
    deadline = time.monotonic() + 2
    while not published and time.monotonic() < deadline:
        time.sleep(0.01)
    assert published and all(b["tokens"] == [] for b in published[0]["scene"]["boards"])

    widget = _act(test_client, alice, widget, {"type": "ready"}).json()
    widget = _act(test_client, bob, as_bob | {"rev": widget["rev"]}, {"type": "ready"}).json()
    assert widget["turn"] == "red" and widget["scene"]["input"] == {}


def test_poker_shows_each_player_only_their_own_cards(test_client, monkeypatch):
    alice, bob, org_id, channel_id = _setup(test_client, "wpk")
    assert _switch_org(test_client, alice, org_id, True).status_code == 200
    assert _switch_chat(test_client, alice, channel_id, True).status_code == 200
    published: list[dict] = []

    async def _updated(_bus, _channel, payload):
        published.append(payload)

    monkeypatch.setattr(widget_endpoints, "publish_widget_updated", _updated)
    r = test_client.post(
        f"/api/human/mm/channels/{channel_id}/widgets",
        json={"kind": "poker", "seat": "red"},
        headers=auth_headers(alice["access_token"]),
    )
    assert r.status_code == 201, r.text
    widget = r.json()
    assert widget["private"] is True and widget["turn"] == "red"

    def cards(view: dict) -> dict[str, list]:
        return {row["id"]: row["cards"] for row in view["scene"]["table"]["rows"]}

    mine = cards(widget)
    assert mine["blue"] == ["back", "back"] and "back" not in mine["red"]
    as_bob = test_client.get(
        f"/api/human/mm/widgets/{widget['widget_id']}", headers=auth_headers(bob["access_token"])
    ).json()
    theirs = cards(as_bob)
    assert theirs["red"] == ["back", "back"] and not set(theirs["blue"]) & set(mine["red"])
    deadline = time.monotonic() + 2
    while not published and time.monotonic() < deadline:
        time.sleep(0.01)
    assert published and all(
        card in ("back", None) for row in published[0]["scene"]["table"]["rows"] for card in row["cards"]
    )

    widget = _act(test_client, alice, widget, {"type": "raise", "args": {"to": 60}}).json()
    assert widget["turn"] == "blue" and widget["scene"]["log"][-1] == "You raise to 60."
    assert _act(test_client, alice, widget, {"type": "check"}).status_code == 403


def test_blackjack_keeps_the_hole_card_down_until_the_dealer_plays(test_client, monkeypatch):
    alice, bob, org_id, channel_id = _setup(test_client, "wbj")
    assert _switch_org(test_client, alice, org_id, True).status_code == 200
    assert _switch_chat(test_client, alice, channel_id, True).status_code == 200
    published: list[dict] = []

    async def _updated(_bus, _channel, payload):
        published.append(payload)

    monkeypatch.setattr(widget_endpoints, "publish_widget_updated", _updated)
    deck = "9c 5d Td 7h 6s 8c".split()
    monkeypatch.setattr(blackjack, "shuffled_deck", lambda: deck + [c for c in DECK if c not in deck])
    r = test_client.post(
        f"/api/human/mm/channels/{channel_id}/widgets",
        json={"kind": "blackjack", "seat": "red"},
        headers=auth_headers(alice["access_token"]),
    )
    assert r.status_code == 201, r.text
    widget = r.json()
    assert widget["turn"] is None and widget["scene"]["actions"]["red"][0]["amount"]["arg"] == "amount"
    widget = _act(test_client, alice, widget, {"type": "bet", "args": {"amount": 50}}).json()
    assert widget["turn"] == "blue"
    widget = _act(test_client, bob, widget, {"type": "bet", "args": {"amount": 100}}).json()

    def dealer(view: dict) -> list:
        return next(row["cards"] for row in view["scene"]["table"]["rows"] if row["id"] == "dealer")

    as_alice = test_client.get(
        f"/api/human/mm/widgets/{widget['widget_id']}", headers=auth_headers(alice["access_token"])
    ).json()
    assert widget["turn"] == "red" and dealer(widget) == dealer(as_alice) == ["Td", "back"]
    deadline = time.monotonic() + 2
    while len(published) < 3 and time.monotonic() < deadline:
        time.sleep(0.01)
    assert all(dealer(event) in ([None, None], ["Td", "back"]) for event in published)

    widget = _act(test_client, alice, as_alice, {"type": "stand"}).json()
    widget = _act(test_client, bob, widget, {"type": "stand"}).json()
    assert dealer(widget) == ["Td", "8c"] and widget["scene"]["log"][-1] == "Round 2."
