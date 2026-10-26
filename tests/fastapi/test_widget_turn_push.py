"""A person's "your move" ping: which moves arm one, what the server rechecks before it goes, the
one ping per game until they act, the copy a lock screen shows, and the payloads it reaches their
web push, iOS and desktop with."""

import asyncio
import json
import time
from collections.abc import Callable
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from sqlmodel import Session, select
from starlette.testclient import TestClient

import clawbits.widgets.blackjack as blackjack
import clawbits.widgets.poker as poker
from clawbits.db.models import HumanUser, MmChannelMember, MmWidget, PushDevice
from clawbits.db.table_write import TableWrite
from clawbits.realtime import apns_push, web_push
from clawbits.realtime.bus import human_topic
from clawbits.widgets import KINDS, limits, turn_push
from clawbits.widgets import service as widget_service
from clawbits.widgets.cards import DECK
from clawbits.widgets.service import Participant
from tests.fastapi._auth_helpers import auth_headers
from tests.fastapi.test_agent_contact_permissions import _grant
from tests.fastapi.test_agent_widgets import _begin
from tests.fastapi.test_agent_widgets import _setup as _agent_setup
from tests.fastapi.test_agentic_widgets import _acted, _human_move
from tests.fastapi.test_widgets import _FakeBus, _game, _move, _setup, _switch_chat, _switch_org

_E4 = {"type": "move", "args": {"move": "e4"}}
_E5 = {"type": "move", "args": {"move": "e5"}}


class _Bus(_FakeBus):
    """The fake bus with a person's global presence, as the heartbeat route sets it."""

    def __init__(self, presence: str = "offline") -> None:
        super().__init__()
        self.presence = presence

    async def user_presence_get(self, human_id: int) -> str:
        return self.presence

    async def user_presence_get_many(self, human_ids: list[int]) -> dict[int, str]:
        return dict.fromkeys(human_ids, self.presence)


@pytest.fixture
def bus(monkeypatch) -> _Bus:
    from clawbits.realtime import bus as bus_module

    fake = _Bus()
    monkeypatch.setattr(bus_module, "_bus", fake)
    return fake


@pytest.fixture
def scheduled(monkeypatch) -> list[tuple[str, int, dict[str, int]]]:
    """``(widget_id, rev, handed)`` for each published change, in place of arming its timers."""
    calls: list[tuple[str, int, dict[str, int]]] = []
    monkeypatch.setattr(
        turn_push, "schedule", lambda widget, handed: calls.append((widget["widget_id"], widget["rev"], dict(handed)))
    )
    return calls


@pytest.fixture
def publish_loop(test_client, monkeypatch) -> asyncio.AbstractEventLoop:
    """The app's loop as the publish loop, as its lifespan records it: earlier test files shut a bus
    down (``shutdown_bus`` clears it) while the session's app keeps running."""
    from clawbits.realtime import bus as bus_module

    loop = test_client.portal.call(asyncio.get_running_loop)
    monkeypatch.setattr(bus_module, "_publish_loop", loop)
    return loop


@pytest.fixture
def dispatched(publish_loop, monkeypatch) -> list:
    """The push dispatcher running on the app's publish loop, as with VAPID configured: each turn
    job it takes is recorded instead of sent."""
    jobs: list = []

    async def record(job) -> None:
        jobs.append(job)

    monkeypatch.setattr(web_push, "dispatch_turn_push", record)
    monkeypatch.setattr(web_push, "VAPID_PUBLIC_KEY", "BPublicKeyStub")
    monkeypatch.setattr(web_push, "VAPID_PRIVATE_KEY", "PrivateKeyStub")

    async def start() -> None:
        web_push.start_push_dispatcher()

    asyncio.run_coroutine_threadsafe(start(), publish_loop).result(5)
    yield jobs
    asyncio.run_coroutine_threadsafe(web_push.stop_push_dispatcher(), publish_loop).result(5)


def _until(found: Callable[[], bool], seconds: float = 3) -> None:
    deadline = time.monotonic() + seconds
    while not found() and time.monotonic() < deadline:
        time.sleep(0.01)


def _row(tc: TestClient, widget_id: str) -> MmWidget:
    with Session(tc.app._engine) as db:
        return db.get(MmWidget, widget_id)


def _do(tc: TestClient, who: dict, widget_id: str, kind: str, **args) -> dict:
    return _human_move(tc, who, widget_id, {"type": kind, "args": args})


def _due(tc: TestClient, widget_id: str, seat: str, who: dict, rev: int) -> turn_push.Notice | None:
    with Session(tc.app._engine) as db:
        return turn_push.due(db, widget_id, seat, who["user"]["id"], rev)


def _people(tc: TestClient, prefix: str, kind: str, seat: str) -> tuple[dict, dict, str, str, str]:
    """Alice takes ``seat`` against Bob in their DM, both switches on."""
    alice, bob, org_id, channel_id = _setup(tc, prefix)
    assert _switch_org(tc, alice, org_id, True).status_code == 200
    assert _switch_chat(tc, bob, channel_id, True).status_code == 200
    r = _begin(tc, alice, channel_id, kind, seat)
    assert r.status_code == 201, r.text
    return alice, bob, org_id, channel_id, r.json()["widget_id"]


def _stack(monkeypatch, top: str) -> None:
    deck = top.split() + [card for card in DECK if card not in top.split()]
    monkeypatch.setattr(blackjack, "shuffled_deck", lambda: list(deck))


def _to_showdown(tc: TestClient, red: dict, blue: dict, widget_id: str) -> None:
    """Check the hand down to a showdown: Red has the button, so Blue deals the next."""
    _do(tc, red, widget_id, "call")
    _do(tc, blue, widget_id, "check")
    for _ in range(3):
        _do(tc, blue, widget_id, "check")
        _do(tc, red, widget_id, "check")
    assert _row(tc, widget_id).state["phase"] == "showdown"


def _fire(widget_id: str, seat: str, who: dict, rev: int) -> None:
    """The timer's job, run now."""
    asyncio.run(turn_push._fire(widget_id, seat, who["user"]["id"], rev))


def _notices(fake: _FakeBus) -> list[tuple[str, dict]]:
    return [(t, e) for t, e in fake.published if e["type"] == "widget.notify"]


# --- what arms a ping ---------------------------------------------------------------------------


def test_a_persons_move_arms_a_ping_for_the_opponent_only(test_client, scheduled, bus):
    alice, bob, _, _, widget = _game(test_client, "tpmove")
    _until(lambda: len(scheduled) == 1)
    assert scheduled == [(widget["widget_id"], 0, {})]  # starting a game hands nothing
    scheduled.clear()
    _move(test_client, alice, widget, "e4")
    _until(lambda: len(scheduled) == 1)
    assert scheduled == [(widget["widget_id"], 1, {"black": 1})]


def test_an_agents_move_arms_a_ping_for_the_person(test_client, scheduled, bus):
    _, bob, agent, _, dm = _agent_setup(test_client, "tpagent")
    widget_id = _begin(test_client, bob, dm, "chess", "white").json()["widget_id"]
    _human_move(test_client, bob, widget_id, _E4)
    _acted(test_client, agent, widget_id, _E5)
    _until(lambda: len(scheduled) == 3)
    assert sorted(scheduled, key=lambda c: c[1]) == [
        (widget_id, 0, {}),
        (widget_id, 1, {"black": 1}),  # the agent's seat: woken instead (see schedule)
        (widget_id, 2, {"white": 2}),
    ]


def test_ending_a_game_arms_nothing(test_client, scheduled, bus):
    alice, _, _, _, widget = _game(test_client, "tpend")
    widget = _move(test_client, alice, widget, "e4")
    _until(lambda: len(scheduled) == 2)
    scheduled.clear()
    _do(test_client, alice, widget["widget_id"], "end")
    _until(lambda: len(scheduled) == 1)
    assert scheduled == [(widget["widget_id"], 2, {})]


def test_a_poker_deal_by_the_seat_not_waited_on_hands_nothing(test_client, scheduled, bus):
    alice, bob, _, _, widget_id = _people(test_client, "tppoker", "poker", "red")
    _to_showdown(test_client, alice, bob, widget_id)
    showdown = _row(test_client, widget_id)
    assert showdown.waiting_on == ["blue"]
    _until(lambda: len(scheduled) == 9)
    assert (widget_id, showdown.rev, {"blue": showdown.rev}) in scheduled  # the showdown hands Blue the deal
    scheduled.clear()
    _do(test_client, alice, widget_id, "deal")  # Red deals though Blue was waited on: Blue acts first
    _until(lambda: len(scheduled) == 1)
    assert scheduled == [(widget_id, showdown.rev + 1, {})]  # the dealer isn't handed the move
    assert _row(test_client, widget_id).waiting_on == ["blue"]
    assert _due(test_client, widget_id, "blue", bob, showdown.rev) is not None  # Blue's mark stands


def test_schedule_arms_a_timer_per_person_and_none_for_agents(monkeypatch):
    fired: list[tuple[str, str, int, int]] = []

    async def fire(widget_id: str, seat: str, human_id: int, rev: int) -> None:
        fired.append((widget_id, seat, human_id, rev))

    monkeypatch.setattr(turn_push, "_fire", fire)
    monkeypatch.setattr(turn_push, "DELAY_SECONDS", 0.01)
    seats = [
        {"seat": "red", "human_id": 7, "agent_id": None},
        {"seat": "blue", "human_id": None, "agent_id": "an-agent"},
    ]

    async def run(widget: dict, handed: dict[str, int]) -> None:
        turn_push.schedule(widget, handed)
        await asyncio.sleep(0.1)

    asyncio.run(run({"widget_id": "w", "status": "active", "seats": seats}, {"red": 3, "blue": 3}))
    assert fired == [("w", "red", 7, 3)]
    asyncio.run(run({"widget_id": "w", "status": "finished", "seats": seats}, {"red": 4}))
    assert len(fired) == 1


# --- the recheck --------------------------------------------------------------------------------


def test_a_ping_is_due_after_the_hand_off_until_the_seat_acts(test_client, bus, scheduled):
    alice, bob, _, _, widget = _game(test_client, "tpdue")
    _move(test_client, alice, widget, "e4")
    notice = _due(test_client, widget["widget_id"], "black", bob, 1)
    assert notice == turn_push.Notice(
        bob["user"]["id"], widget["channel_id"], widget["widget_id"], 1, "Your move", "Chess with Alice"
    )
    assert _due(test_client, widget["widget_id"], "black", alice, 1) is None  # not her seat
    _human_move(test_client, bob, widget["widget_id"], _E5)  # from any device
    assert _due(test_client, widget["widget_id"], "black", bob, 1) is None


@pytest.mark.parametrize("ending", ["abort", "resign", "idle"])
def test_no_ping_is_due_once_the_game_is_over(test_client, bus, ending):
    from clawbits.fastapi.mm_maintenance import reap_idle_widgets_once

    alice, bob, _, _, widget = _game(test_client, f"tpover-{ending}")
    _move(test_client, alice, widget, "e4")
    if ending == "idle":
        engine = test_client.app._engine
        with Session(engine) as db:
            row = db.get(MmWidget, widget["widget_id"])
            row.updated_at = datetime.now(UTC) - timedelta(days=2, minutes=1)
            db.add(row)
            db.commit()
        assert asyncio.run(reap_idle_widgets_once(engine)) == 1
    else:
        _do(test_client, bob if ending == "abort" else alice, widget["widget_id"], ending)
    assert _row(test_client, widget["widget_id"]).status != "active"
    assert _due(test_client, widget["widget_id"], "black", bob, 1) is None


def test_no_ping_is_due_in_a_muted_chat(test_client, bus):
    alice, bob, _, channel_id, widget = _game(test_client, "tpmute")
    _move(test_client, alice, widget, "e4")
    r = test_client.post(
        f"/api/human/mm/channels/{channel_id}/mute", json={"muted": True}, headers=auth_headers(bob["access_token"])
    )
    assert r.status_code == 200, r.text
    assert _due(test_client, widget["widget_id"], "black", bob, 1) is None


def test_no_ping_is_due_to_a_seat_the_game_no_longer_waits_on(test_client, bus, scheduled, monkeypatch):
    """A showdown waits on Blue to deal; Red deals instead. Blue, down to 5 chips, is all-in on the
    small blind, so nobody acts: the board runs out to a split pot and the next showdown waits on
    Red. Blue's mark still reads the first showdown's rev, but the game no longer waits on Blue."""
    hands = ["Ah Ad 2c 7d As Kc 9h 5s 3d", "2c 3d 4c 5d As Ks Qs Js Ts"]  # Red's aces, then the board plays
    decks = [hand.split() + [card for card in DECK if card not in hand.split()] for hand in hands]
    monkeypatch.setattr(poker, "shuffled_deck", lambda: decks.pop(0))
    alice, bob, _, _, widget_id = _people(test_client, "tpwaiting", "poker", "red")
    _do(test_client, alice, widget_id, "raise", to=995)
    _do(test_client, bob, widget_id, "call")
    for _ in range(3):
        _do(test_client, bob, widget_id, "check")
        _do(test_client, alice, widget_id, "check")
    showdown = _row(test_client, widget_id)
    assert (showdown.state["stacks"], showdown.waiting_on) == ({"red": 1995, "blue": 5}, ["blue"])
    assert _due(test_client, widget_id, "blue", bob, showdown.rev) is not None
    _do(test_client, alice, widget_id, "deal")  # out of turn: either seat may deal
    row = _row(test_client, widget_id)
    assert (row.status, row.state["hand"], row.state["phase"]) == ("active", 2, "showdown")
    assert row.state["stacks"] == {"red": 1995, "blue": 5}
    assert (row.waiting_on, row.acted_revs["blue"]) == (["red"], showdown.rev)
    assert _due(test_client, widget_id, "blue", bob, showdown.rev) is None


@pytest.mark.parametrize("way", ["org_removal", "account_delete"])
def test_no_ping_is_due_once_the_person_is_gone(test_client, bus, way):
    alice, bob, org_id, _, widget = _game(test_client, f"tpgone-{way}")
    _move(test_client, alice, widget, "e4")
    if way == "org_removal":
        r = test_client.delete(
            f"/api/human/orgs/{org_id}/members/{bob['user']['id']}", headers=auth_headers(alice["access_token"])
        )
    else:
        r = test_client.delete("/api/human/account", headers=auth_headers(bob["access_token"]))
    assert r.status_code in (200, 204), r.text
    assert _due(test_client, widget["widget_id"], "black", bob, 1) is None


def test_no_ping_is_due_once_the_person_cant_reach_the_chat(test_client, bus, scheduled):
    """Bob leaves the chat but the game runs on and he keeps his seat. The routes that remove
    someone end their games too, so his membership row goes directly here."""
    alice, bob, _, channel_id, widget = _game(test_client, "tpreach")
    widget_id = widget["widget_id"]
    _move(test_client, alice, widget, "e4")
    assert _due(test_client, widget_id, "black", bob, 1) is not None
    with Session(test_client.app._engine) as db:
        db.delete(
            db.exec(
                select(MmChannelMember)
                .where(MmChannelMember.channel_id == channel_id)
                .where(MmChannelMember.human_id == bob["user"]["id"])
            ).one()
        )
        db.commit()
    row = _row(test_client, widget_id)
    assert (row.status, row.waiting_on, row.acted_revs["black"]) == ("active", ["black"], 1)
    assert _due(test_client, widget_id, "black", bob, 1) is None


def test_no_ping_is_due_once_the_agents_contact_is_revoked(test_client, bus):
    alice, bob, agent, org_id, dm = _agent_setup(test_client, "tprevoke")
    r = test_client.patch(
        f"/api/human/orgs/{org_id}/agents/{agent['agent_id']}/name",
        json={"nickname": "Deep Blue"},
        headers=auth_headers(alice["access_token"]),
    )
    assert r.status_code == 200, r.text
    widget_id = _begin(test_client, bob, dm, "chess", "white").json()["widget_id"]
    _human_move(test_client, bob, widget_id, _E4)
    _acted(test_client, agent, widget_id, _E5)
    assert _due(test_client, widget_id, "white", bob, 2).body == "Chess with Deep Blue"
    r = _grant(test_client, alice["access_token"], agent["agent_id"], "human", bob["user"]["id"], can_dm=False)
    assert r.status_code == 200, r.text
    assert _due(test_client, widget_id, "white", bob, 2) is None


def test_the_mark_is_the_hand_off_rev_taken_under_the_lock(test_client, bus, monkeypatch):
    """Blue settles a blackjack round, handing Red the next bet and keeping its own; Red bets
    before Blue's call reads the widget back. Blue's ping hangs on the settle's rev, not the rev
    read back, so Blue is still owed it."""
    _stack(monkeypatch, "9c 5d Td 7h 6s 8c")
    alice, bob, _, _, widget_id = _people(test_client, "tprace", "blackjack", "red")
    _do(test_client, alice, widget_id, "bet", amount=100)
    _do(test_client, bob, widget_id, "bet", amount=100)
    _do(test_client, alice, widget_id, "stand")
    engine = test_client.app._engine
    read_back = widget_service._result

    def raced(db, widget_id_, participant, post_id=None, handed=None):
        monkeypatch.setattr(widget_service, "_result", read_back)
        with Session(engine) as other:
            action = {"type": "bet", "args": {"amount": 100}}
            widget_service.act(other, Participant.human(alice["user"]["id"]), widget_id_, action, None)
        return read_back(db, widget_id_, participant, post_id, handed)

    monkeypatch.setattr(widget_service, "_result", raced)
    with Session(engine) as db:
        stand = {"type": "stand", "args": {}}
        result = widget_service.act(db, Participant.human(bob["user"]["id"]), widget_id, stand, 3)
    assert result.handed == {"red": 4, "blue": 4}
    assert (result.public["rev"], result.public["waiting_on"]) == (5, ["blue"])
    assert _due(test_client, widget_id, "blue", bob, 4).body == "Blackjack with Alice"
    assert _due(test_client, widget_id, "blue", bob, 5) is None  # the rev read back was no hand-off
    assert _due(test_client, widget_id, "red", alice, 4) is None  # she bet


def test_a_shooter_who_keeps_the_move_is_pinged_when_it_stalls(test_client, bus, scheduled):
    alice, bob, _, _, widget_id = _people(test_client, "tphit", "battleship", "red")
    _do(test_client, bob, widget_id, "ready")
    _do(test_client, alice, widget_id, "ready")
    ship = next(ship for ship in _row(test_client, widget_id).state["fleets"]["blue"] if len(ship) > 1)
    _do(test_client, alice, widget_id, "fire", at=ship[0])
    row = _row(test_client, widget_id)
    assert row.waiting_on == ["red"]
    assert _due(test_client, widget_id, "red", alice, row.rev).body == "Battleship with Bob"


# --- once per game until they act --------------------------------------------------------------


def test_a_persons_ping_is_claimed_once_until_they_act(test_client, bus):
    alice, bob, _, _, widget = _game(test_client, "tponce")
    _move(test_client, alice, widget, "e4")
    assert limits.claim_turn_push(bob["user"]["id"], widget["widget_id"]) is True
    assert limits.claim_turn_push(bob["user"]["id"], widget["widget_id"]) is False
    assert limits.claim_turn_push(alice["user"]["id"], widget["widget_id"]) is True  # hers is apart
    _human_move(test_client, bob, widget["widget_id"], _E5)
    assert limits.claim_turn_push(bob["user"]["id"], widget["widget_id"]) is True


def test_a_move_handed_back_again_and_again_pings_once_until_they_act(test_client, bus):
    """However a game keeps handing someone the move without them acting (a fold and a deal, say),
    they hear about it once; acting frees the next one."""
    alice, bob, _, _, widget = _game(test_client, "tploop")
    widget_id = widget["widget_id"]
    _move(test_client, alice, widget, "e4")
    _fire(widget_id, "black", bob, 1)
    assert len(_notices(bus)) == 1
    engine = test_client.app._engine
    for _ in range(3):  # the move leaves Black and comes back, Black never acting
        with Session(engine) as db:
            row = TableWrite.lock_mm_widget(db, widget_id)
            state = row.state
            TableWrite.save_mm_widget_step(
                db, row, state=state, status="active", outcome=None, turn="white", waiting_on=["white"], seat="white"
            )
            marks = TableWrite.save_mm_widget_step(
                db, row, state=state, status="active", outcome=None, turn="black", waiting_on=["black"], seat="white"
            )
            db.commit()
        assert _due(test_client, widget_id, "black", bob, marks["black"]) is not None
        _fire(widget_id, "black", bob, marks["black"])
    assert len(_notices(bus)) == 1
    _human_move(test_client, bob, widget_id, _E5)
    _human_move(test_client, alice, widget_id, {"type": "move", "args": {"move": "Nf3"}})
    _fire(widget_id, "black", bob, _row(test_client, widget_id).rev)
    assert len(_notices(bus)) == 2


def test_a_move_between_the_check_and_the_claim_gives_the_key_back(test_client, bus, scheduled, monkeypatch):
    """Bob moves after the timer found his ping due and before it claimed the key, so his move
    cleared no key: no ping goes, and the key is free for his next hand-off."""
    alice, bob, _, _, widget = _game(test_client, "tpclaim")
    widget_id = widget["widget_id"]
    _move(test_client, alice, widget, "e4")
    claim = limits.claim_turn_push

    def moved_first(human_id: int, widget_id_: str) -> bool:
        _human_move(test_client, bob, widget_id_, _E5)
        return claim(human_id, widget_id_)

    monkeypatch.setattr(limits, "claim_turn_push", moved_first)
    _fire(widget_id, "black", bob, 1)
    assert _notices(bus) == []
    assert _row(test_client, widget_id).rev == 2  # his move landed
    assert claim(bob["user"]["id"], widget_id) is True  # given back


@pytest.mark.parametrize("fails", ["recheck", "notify", "push"])
def test_a_failure_after_the_claim_gives_the_key_back_until_the_ping_went_out(
    test_client, bus, scheduled, monkeypatch, fails
):
    """The recheck after the claim, or ``widget.notify`` itself, fails: nothing went out, so the key
    is given back for Bob's next hand-off. Once ``widget.notify`` went out, it stays spent."""
    alice, bob, _, _, widget = _game(test_client, f"tpfail-{fails}")
    widget_id = widget["widget_id"]
    _move(test_client, alice, widget, "e4")
    due_now = turn_push._due_now
    checks: list[int] = []

    def boom(*args, **kwargs) -> None:
        raise RuntimeError(f"{fails} failed")

    def recheck_fails(*args) -> turn_push.Notice | None:
        checks.append(args[3])
        return due_now(*args) if len(checks) == 1 else boom()

    if fails == "recheck":
        monkeypatch.setattr(turn_push, "_due_now", recheck_fails)
    elif fails == "notify":
        monkeypatch.setattr(turn_push, "publish_widget_notify", boom)
    else:
        monkeypatch.setattr(web_push, "schedule_turn_push", boom)
    _fire(widget_id, "black", bob, 1)
    went_out = fails == "push"
    assert len(_notices(bus)) == int(went_out)
    if fails == "recheck":
        assert checks == [1, 1]  # the second check runs only once the key is claimed
    assert limits.claim_turn_push(bob["user"]["id"], widget_id) is not went_out


@pytest.mark.parametrize("cancelled", ["recheck", "notify"])
def test_a_cancel_gives_the_key_back_until_the_publish_started(test_client, bus, scheduled, monkeypatch, cancelled):
    """Shutdown cancels the timer's job. During the recheck after the claim nothing went out, so the
    key is given back; once ``widget.notify`` is being published it may be out, so it stays spent."""
    alice, bob, _, _, widget = _game(test_client, f"tpcancel-{cancelled}")
    widget_id = widget["widget_id"]
    _move(test_client, alice, widget, "e4")
    due_now = turn_push._due_now
    checks: list[int] = []

    def cancel(*args, **kwargs) -> None:
        raise asyncio.CancelledError

    def recheck_cancelled(*args) -> turn_push.Notice | None:
        checks.append(args[3])
        return due_now(*args) if len(checks) == 1 else cancel()

    if cancelled == "recheck":
        monkeypatch.setattr(turn_push, "_due_now", recheck_cancelled)
    else:
        monkeypatch.setattr(turn_push, "publish_widget_notify", cancel)
    with pytest.raises(asyncio.CancelledError):
        _fire(widget_id, "black", bob, 1)
    assert _notices(bus) == []
    assert limits.claim_turn_push(bob["user"]["id"], widget_id) is (cancelled == "recheck")


# --- the copy -----------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("kind", "game"), [("poker", "Hold'em"), ("blackjack", "Blackjack"), ("battleship", "Battleship")]
)
def test_the_copy_names_the_game_and_the_opponent_only(test_client, bus, scheduled, monkeypatch, kind, game):
    _stack(monkeypatch, "9c 5d Td 7h 6s 8c")  # no blackjack dealt: Red plays first
    alice, bob, _, _, widget_id = _people(test_client, f"tpcopy-{kind}", kind, "red")
    if kind == "poker":
        _do(test_client, alice, widget_id, "call")  # Red (the button) first: Blue's option
    elif kind == "blackjack":
        _do(test_client, alice, widget_id, "bet", amount=100)
        _do(test_client, bob, widget_id, "bet", amount=100)  # the deal: Red plays first
    else:
        _do(test_client, alice, widget_id, "ready")
        _do(test_client, bob, widget_id, "ready")  # both fleets placed: Red shoots first
    row = _row(test_client, widget_id)
    (seat,) = row.waiting_on
    who, other = (alice, "Bob") if seat == "red" else (bob, "Alice")
    notice = _due(test_client, widget_id, seat, who, row.acted_revs[seat])
    # Not a card, a coordinate, a chip count or a move: what the lock screen shows is all there is.
    assert (notice.title, notice.body) == ("Your move", f"{game} with {other}")


def _rename(tc: TestClient, who: dict, name: str | None) -> None:
    with Session(tc.app._engine) as db:
        row = db.get(HumanUser, who["user"]["id"])
        row.display_name = name
        db.add(row)
        db.commit()


def test_a_person_without_a_display_name_is_your_opponent_never_their_email(test_client, bus, scheduled):
    alice, bob, _, _, widget = _game(test_client, "tpemail")
    _move(test_client, alice, widget, "e4")
    _rename(test_client, alice, None)
    notice = _due(test_client, widget["widget_id"], "black", bob, 1)
    assert notice.body == "Chess with your opponent"
    assert "@" not in notice.body


def test_a_name_loses_controls_and_bidi_and_is_cut_to_forty(test_client, bus, scheduled):
    alice, bob, _, _, widget = _game(test_client, "tpname")
    _move(test_client, alice, widget, "e4")
    _rename(test_client, alice, "Al‮ice\nSmith​ " + "x" * 60)
    notice = _due(test_client, widget["widget_id"], "black", bob, 1)
    name = notice.body.removeprefix("Chess with ")
    assert name == ("Alice Smith " + "x" * 60)[:40] and len(name) == 40
    assert turn_push._clean_name("‮\t​") == "your opponent"


# --- delivery -----------------------------------------------------------------------------------


def _devices(tc: TestClient, who: dict) -> None:
    """A browser and an iPhone for ``who``."""
    human_id = who["user"]["id"]
    endpoint = f"https://fcm.googleapis.com/fcm/send/tp{human_id}"
    with Session(tc.app._engine) as db:
        db.add(PushDevice(human_id=human_id, transport="webpush", token=endpoint, p256dh="p", auth="a"))
        db.add(PushDevice(human_id=human_id, transport="apns", app="ios", token=format(human_id, "064x")))
        db.commit()


@pytest.mark.parametrize("apns", [True, False])
def test_a_turn_ping_reaches_web_push_and_apns_unless_online(test_client, bus, monkeypatch, apns):
    alice, bob, _, channel_id, widget = _game(test_client, f"tpsend-{apns}")
    _devices(test_client, bob)
    _devices(test_client, alice)  # never hers
    monkeypatch.setattr(web_push, "VAPID_PUBLIC_KEY", "BPublicKeyStub")
    monkeypatch.setattr(web_push, "VAPID_PRIVATE_KEY", "PrivateKeyStub")
    monkeypatch.setattr(apns_push, "_KEY", "key")
    monkeypatch.setattr(apns_push, "_KEY_ID", "kid")
    monkeypatch.setattr(apns_push, "_TEAM_ID", "team")
    sent: list[tuple[dict, dict]] = []
    alerted: list[tuple[list[dict], tuple, dict]] = []
    monkeypatch.setattr(
        web_push, "_send_one", lambda target, data, ttl=0: sent.append((target, json.loads(data))) or "ok"
    )

    async def fan_out(devices, *args, **kwargs) -> list[int]:
        alerted.append((devices, args, kwargs))
        return []

    monkeypatch.setattr(apns_push, "fan_out", fan_out)
    job = web_push._TurnJob(bob["user"]["id"], channel_id, widget["widget_id"], "Your move", "Chess with Alice", apns)
    asyncio.run(web_push.dispatch_turn_push(job))
    assert [(t["human_id"], p) for t, p in sent] == [
        (
            bob["user"]["id"],
            {
                "title": "Your move",
                "body": "Chess with Alice",
                "channelId": channel_id,
                "widgetId": widget["widget_id"],
                "url": f"{web_push.APP_URL}/channels/{channel_id}?widget={widget['widget_id']}",
                "tag": f"turn:{channel_id}",
            },
        )
    ]
    if apns:
        ((devices, args, kwargs),) = alerted
        assert [d["human_id"] for d in devices] == [bob["user"]["id"]]
        assert args == ("Your move", "Chess with Alice", channel_id)
        assert kwargs == {"collapse_id": f"turn:{channel_id}", "data": {"widgetId": widget["widget_id"]}}
    else:
        assert alerted == []


def test_a_turn_web_push_waits_ten_minutes_for_the_browser_and_a_message_push_does_not(test_client, bus, monkeypatch):
    """The push service keeps a turn ping for a browser that isn't connected (``TTL: 600``); a
    message push keeps pywebpush's ``TTL: 0``: delivered now or dropped."""
    alice, bob, _, channel_id, widget = _game(test_client, "tpttl")
    _devices(test_client, bob)
    monkeypatch.setattr(web_push, "VAPID_PUBLIC_KEY", "BPublicKeyStub")
    monkeypatch.setattr(web_push, "VAPID_PRIVATE_KEY", "PrivateKeyStub")
    monkeypatch.setattr(apns_push, "_KEY", "")  # web push only
    monkeypatch.setattr("clawbits.ssrf._resolve", lambda host: ["93.184.216.34"])
    ttls: list[int] = []
    # ``_send_one`` imports ``webpush`` at call time: replace it on pywebpush itself.
    monkeypatch.setattr("pywebpush.webpush", lambda **kwargs: ttls.append(kwargs["ttl"]))
    job = web_push._TurnJob(bob["user"]["id"], channel_id, widget["widget_id"], "Your move", "Chess with Alice")
    asyncio.run(web_push.dispatch_turn_push(job))
    post = {"channel_id": channel_id, "human_id": alice["user"]["id"], "message": "hi"}
    asyncio.run(web_push.dispatch_post_web_push(channel_id, post, [alice["user"]["id"], bob["user"]["id"]]))
    assert ttls == [600, 0]  # the turn ping, then the message


class _Response:
    status_code = 200


def _apns_sent(monkeypatch) -> list[dict]:
    calls: list[dict] = []
    monkeypatch.setattr(apns_push, "_bearer_token", lambda: "token")
    monkeypatch.setattr(httpx, "post", lambda url, **kwargs: calls.append({"url": url, **kwargs}) or _Response())
    return calls


def test_an_apns_message_push_keeps_its_collapse_id_and_nests_its_data_under_body(monkeypatch):
    calls = _apns_sent(monkeypatch)
    assert apns_push.send_apns("ab12", "Bob", "hi", "chan1") == "ok"
    (call,) = calls
    assert call["headers"]["apns-collapse-id"] == "chan1"
    assert json.loads(call["content"]) == {
        "aps": {"alert": {"title": "Bob", "body": "hi"}, "sound": "default", "thread-id": "chan1"},
        "channelId": "chan1",
        "body": {"channelId": "chan1"},
    }


def test_an_apns_turn_push_collapses_apart_from_messages(monkeypatch):
    calls = _apns_sent(monkeypatch)
    monkeypatch.setattr(apns_push, "_KEY", "key")
    monkeypatch.setattr(apns_push, "_KEY_ID", "kid")
    monkeypatch.setattr(apns_push, "_TEAM_ID", "team")
    devices = [{"id": 1, "token": "ab12"}]
    dead = asyncio.run(
        apns_push.fan_out(
            devices, "Your move", "Chess with Bob", "chan1", collapse_id="turn:chan1", data={"widgetId": "w1"}
        )
    )
    assert dead == []
    (call,) = calls
    assert call["url"].endswith("/3/device/ab12")
    assert call["headers"]["apns-collapse-id"] == "turn:chan1"
    assert json.loads(call["content"]) == {
        "aps": {"alert": {"title": "Your move", "body": "Chess with Bob"}, "sound": "default", "thread-id": "chan1"},
        "channelId": "chan1",
        "widgetId": "w1",
        "body": {"channelId": "chan1", "widgetId": "w1"},
    }


# --- end to end, on the app's own loop ----------------------------------------------------------


def _stall(tc: TestClient, monkeypatch, prefix: str) -> tuple[dict, dict, dict]:
    """Alice moves; Bob doesn't, past a grace shortened to a blink."""
    monkeypatch.setattr(turn_push, "DELAY_SECONDS", 0.05)
    alice, bob, _, _, widget = _game(tc, prefix)
    _move(tc, alice, widget, "e4")
    return alice, bob, widget


@pytest.mark.parametrize(("presence", "apns"), [("offline", True), ("idle", True), ("online", False)])
def test_a_stalled_hand_off_pings_each_device_once(test_client, bus, dispatched, monkeypatch, presence, apns):
    bus.presence = presence
    alice, bob, widget = _stall(test_client, monkeypatch, f"tpe2e-{presence}")
    _until(lambda: _notices(bus) and dispatched)
    assert _notices(bus) == [
        (
            human_topic(bob["user"]["id"]),
            {
                "type": "widget.notify",
                "channel_id": widget["channel_id"],
                "data": {"widget_id": widget["widget_id"], "rev": 1, "title": "Your move", "body": "Chess with Alice"},
            },
        )
    ]
    # Online on web or desktop: the phone keeps quiet; web push and the desktop banner still go.
    assert dispatched == [
        web_push._TurnJob(bob["user"]["id"], widget["channel_id"], widget["widget_id"], "Your move", "Chess with Alice", apns)
    ]
    time.sleep(0.2)
    assert len(_notices(bus)) == 1 and len(dispatched) == 1
    assert limits.claim_turn_push(bob["user"]["id"], widget["widget_id"]) is False  # spent


def test_a_move_inside_the_grace_pings_no_one(test_client, bus, dispatched, scheduled):
    alice, bob, _, _, widget = _game(test_client, "tpquick")
    widget_id = widget["widget_id"]
    _move(test_client, alice, widget, "e4")
    _human_move(test_client, bob, widget_id, _E5)
    _human_move(test_client, alice, widget_id, {"type": "move", "args": {"move": "Nf3"}})
    _until(lambda: len(scheduled) == 4)
    # Every grace ends after the three moves: only the last hand-off, to Bob at rev 3, still stands.
    players = {"white": alice, "black": bob}
    for _, _, handed in sorted(scheduled, key=lambda call: call[1]):
        for seat, rev in handed.items():
            _fire(widget_id, seat, players[seat], rev)
    _until(lambda: bool(dispatched))
    assert [e["data"]["rev"] for _, e in _notices(bus)] == [3]
    assert [job.human_id for job in dispatched] == [bob["user"]["id"]]


def test_widget_notify_goes_out_without_vapid_or_apns(test_client, publish_loop, bus, monkeypatch):
    assert web_push._main_loop is None  # no push transport: no dispatcher
    _, bob, widget = _stall(test_client, monkeypatch, "tpnopush")
    _until(lambda: bool(_notices(bus)))
    assert [(t, e["data"]["body"]) for t, e in _notices(bus)] == [(human_topic(bob["user"]["id"]), "Chess with Alice")]


def test_the_kill_switch_turns_pings_off(test_client, bus, dispatched, monkeypatch):
    monkeypatch.setattr(turn_push, "ENABLED", False)
    _, bob, widget = _stall(test_client, monkeypatch, "tpkill")
    time.sleep(0.5)
    assert _notices(bus) == [] and dispatched == []
    assert limits.claim_turn_push(bob["user"]["id"], widget["widget_id"]) is True  # never spent


def test_kinds_name_their_scene_titles():
    """The copy's game names: the public scene's own titles."""
    titles = {name: kind.scene(kind.init(), "active", None, None)["title"] for name, kind in KINDS.items()}
    assert titles == {"chess": "Chess", "battleship": "Battleship", "poker": "Hold'em", "blackjack": "Blackjack"}
