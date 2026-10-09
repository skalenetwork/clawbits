"""The poker widget, heads-up hold'em: blinds, betting order, raises, showdowns, and secret cards."""

import random

import pytest

import clawbits.widgets.poker as poker
from clawbits.widgets import KINDS, InvalidAction, NotYourTurn, Step
from clawbits.widgets.cards import DECK

PK = KINDS["poker"]


def stack(monkeypatch, *tops: str) -> None:
    """Deal hands from decks that start with ``tops``: the dealer's two cards, the other seat's two,
    then the flop, the turn and the river. The rest of each deck follows in order."""
    decks = [top.split() + [card for card in DECK if card not in top.split()] for top in tops]
    monkeypatch.setattr(poker, "shuffled_deck", lambda: decks.pop(0))


def act(state: dict, seat: str, kind: str, **args) -> Step:
    return PK.act(state, seat, {"type": kind, "args": args})


def rows(state: dict, seat: str | None, status: str = "active", outcome: dict | None = None) -> dict:
    return {row["id"]: row for row in PK.scene(state, status, outcome, seat)["table"]["rows"]}


def check_down(state: dict) -> dict:
    """The dealer limps, then both check to the showdown."""
    state = act(state, "red", "call").state
    state = act(state, "blue", "check").state
    for _ in range(3):
        state = act(state, "blue", "check").state
        state = act(state, "red", "check").state
    return state


def test_a_hand_opens_with_the_blinds_and_the_dealer_to_act():
    state = PK.init()
    assert (state["button"], state["bets"], state["stacks"]) == (
        "red", {"red": 10, "blue": 20}, {"red": 990, "blue": 980},
    )
    assert PK.turn(state) == "red"
    assert sorted(state["hole"]["red"] + state["hole"]["blue"] + state["deck"]) == sorted(DECK)


def test_each_seat_sees_only_its_own_cards():
    state = PK.init()
    red = PK.scene(state, "active", None, "red")
    assert [row["id"] for row in red["table"]["rows"]] == ["blue", "board", "red"]
    table = rows(state, "red")
    assert table["red"]["cards"] == state["hole"]["red"] and table["blue"]["cards"] == ["back", "back"]
    assert (table["board"]["cards"], table["board"]["note"]) == ([None] * 5, "Pot 30")
    assert "deck" not in red and "hole" not in red
    assert red["seat_notes"] == {"red": "990 chips · dealer", "blue": "980 chips"}
    public = rows(state, None)
    assert public["red"]["cards"] == public["blue"]["cards"] == ["back", "back"]
    assert PK.scene(state, "active", None)["actions"] == {}


def test_the_dealer_acts_first_before_the_flop_and_last_after_it(monkeypatch):
    stack(monkeypatch, "As Kd 7c 7d 2h 9s Jc 4d Qh")
    state = act(PK.init(), "red", "call").state
    assert PK.turn(state) == "blue"  # the big blind's option
    with pytest.raises(InvalidAction, match="Nothing to call"):
        act(state, "blue", "call")
    state = act(state, "blue", "check").state
    assert (state["board"], state["pot"], PK.turn(state)) == (["2h", "9s", "Jc"], 40, "blue")
    with pytest.raises(NotYourTurn):
        act(state, "red", "check")
    state = act(act(state, "blue", "check").state, "red", "check").state
    assert state["board"][3:] == ["4d"] and PK.turn(state) == "blue"
    assert PK.scene(state, "active", None, "red")["log"][-4:] == [
        "Flop 2♥ 9♠ J♣.", "They check.", "You check.", "Turn 4♦.",
    ]


def test_raises_are_at_least_the_last_raise():
    state = PK.init()
    with pytest.raises(InvalidAction, match="at least 40"):
        act(state, "red", "raise", to=30)
    state = act(state, "red", "raise", to=60).state
    assert (state["raise"], PK.turn(state)) == (40, "blue")
    with pytest.raises(InvalidAction, match="at least 100"):
        act(state, "blue", "raise", to=90)
    with pytest.raises(InvalidAction, match="1000 at most"):
        act(state, "blue", "raise", to=5000)
    with pytest.raises(InvalidAction, match="args.to"):
        act(state, "blue", "raise")
    with pytest.raises(InvalidAction, match="call, raise or fold"):
        act(state, "blue", "check")


def test_the_seat_to_act_gets_its_choices_and_a_sized_raise():
    state = PK.init()
    red = PK.scene(state, "active", None, "red")["actions"]["red"]
    assert [(a["type"], a["label"]) for a in red] == [
        ("fold", "Fold"),
        ("call", "Call 10"),
        ("raise", "Raise to"),
        ("allin", "All-in 990"),
        ("resign", "Resign"),
        ("abort", "Abort"),
    ]
    assert red[2]["amount"] == {
        "arg": "to", "min": 40, "max": 1000, "step": 10, "value": 40,
        "presets": [{"label": "Min", "value": 40}, {"label": "Pot", "value": 60}],
    }
    assert [a["type"] for a in PK.scene(state, "active", None, "blue")["actions"]["blue"]] == ["resign", "abort"]
    state = act(act(state, "red", "call").state, "blue", "check").state
    blue = PK.scene(state, "active", None, "blue")["actions"]["blue"]
    assert [a["label"] for a in blue[:3]] == ["Check", "Bet", "All-in 980"]
    assert blue[1]["amount"]["presets"] == [{"label": "Min", "value": 20}, {"label": "Pot", "value": 40}]


def test_a_fold_deals_the_next_hand_with_the_button_moved():
    state = act(PK.init(), "red", "fold").state
    assert (state["hand"], state["button"], PK.turn(state)) == (2, "blue", "blue")
    assert (state["stacks"], state["bets"]) == ({"red": 970, "blue": 1000}, {"red": 20, "blue": 10})
    assert PK.scene(state, "active", None, "red")["log"][-3:] == ["You fold.", "They win 20.", "Hand 2."]


def test_a_showdown_waits_for_a_deal(monkeypatch):
    stack(monkeypatch, "As Ad Kc Kd 2h 7s 9c Jd 3h", "2c 3c 4d 5d")
    state = check_down(PK.init())
    assert (state["phase"], state["stacks"], PK.turn(state)) == ("showdown", {"red": 1020, "blue": 980}, "blue")
    red = PK.scene(state, "active", None, "red")
    assert red["status"]["text"] == "You win 40 with a pair of aces"
    table = rows(state, "red")
    assert table["blue"]["cards"] == ["Kc", "Kd"] and table["blue"]["note"] == "A pair of kings"
    assert (table["red"]["lift"], table["board"]["lift"]) == ([0, 1], [1, 2, 3])
    assert [a["type"] for a in red["actions"]["red"]] == ["deal", "resign", "abort"]
    with pytest.raises(InvalidAction, match="deal the next one"):
        act(state, "red", "check")
    state = act(state, "red", "deal").state
    assert (state["hand"], state["button"], state["hole"]["blue"]) == (2, "blue", ["2c", "3c"])
    assert state["result"] is None and rows(state, "red")["blue"]["cards"] == ["back", "back"]


def test_all_in_runs_the_board_out_and_the_last_chip_ends_the_match(monkeypatch):
    stack(monkeypatch, "As Ad Kc Kd 2h 7s 9c Jd 3h")
    state = act(PK.init(), "red", "allin").state
    blue = PK.scene(state, "active", None, "blue")["actions"]["blue"]
    assert [(a["type"], a["label"]) for a in blue[:2]] == [("fold", "Fold"), ("call", "Call 980 · all-in")]
    assert [a["type"] for a in blue] == ["fold", "call", "resign", "abort"]
    with pytest.raises(InvalidAction, match="all-in: call or fold"):
        act(state, "blue", "raise", to=1000)
    step = act(state, "blue", "allin")  # nothing to raise into: a call
    assert step.status == "finished" and step.outcome == {"termination": "chips", "winner": "red"}
    assert (step.state["board"], step.state["stacks"]) == (["2h", "7s", "9c", "Jd", "3h"], {"red": 2000, "blue": 0})
    blue_view = PK.scene(step.state, step.status, step.outcome, "blue")
    assert blue_view["status"]["text"] == "You're out of chips" and blue_view["actions"] == {}
    assert PK.scene(step.state, step.status, step.outcome, "red")["status"]["text"] == "Every chip is yours"
    assert PK.scene(step.state, step.status, step.outcome)["status"]["text"] == "Blue is out of chips"
    assert rows(step.state, "blue", step.status, step.outcome)["red"]["cards"] == ["As", "Ad"]


def test_an_uncalled_bet_comes_back(monkeypatch):
    stack(monkeypatch, "Kc Kd As Ad 2h 7s 9c Jd 3h")
    state = PK.init() | {"stacks": {"red": 1490, "blue": 480}}
    state = act(state, "red", "allin").state
    step = act(state, "blue", "call")
    assert step.status == "active" and step.state["stacks"] == {"red": 1000, "blue": 1000}
    assert PK.scene(step.state, "active", None, "red")["log"][-6:] == [
        "You raise to 1500, all-in.", "They call 480, all-in.",
        "Flop 2♥ 7♠ 9♣.", "Turn J♦.", "River 3♥.", "They win 1000 with a pair of aces.",
    ]


def test_a_tie_splits_the_pot(monkeypatch):
    stack(monkeypatch, "2c 3d 4c 5d Ts Js Qs Ks As")
    state = check_down(PK.init())
    assert state["stacks"] == {"red": 1000, "blue": 1000}
    assert PK.scene(state, "active", None, "blue")["status"]["text"] == "Split pot, 20 each"


def test_blinds_double_every_ten_hands():
    state = act(PK.init() | {"hand": 10}, "red", "fold").state
    assert (state["hand"], state["bets"]) == (11, {"blue": 20, "red": 40})
    assert PK.scene(state, "active", None, "red")["log"][-1] == "Hand 11, blinds 20/40."


def test_abort_only_in_the_first_hand_and_resign_any_time():
    state = PK.init()
    assert act(state, "blue", "abort").status == "aborted"
    state = act(state, "red", "fold").state
    with pytest.raises(InvalidAction, match="resign instead"):
        act(state, "blue", "abort")
    step = act(state, "red", "resign")
    assert step.status == "finished" and step.outcome == {"termination": "resign", "winner": "blue"}
    assert PK.scene(step.state, step.status, step.outcome, "red")["status"]["text"] == "You resigned"
    with pytest.raises(InvalidAction, match="Unknown action"):
        act(state, "blue", "shuffle")


def test_random_play_never_loses_a_chip(monkeypatch):
    rng = random.Random(7)

    def deck() -> list[str]:
        cards = list(DECK)
        rng.shuffle(cards)
        return cards

    monkeypatch.setattr(poker, "shuffled_deck", deck)
    for _ in range(60):
        state, status = PK.init(), "active"
        for _ in range(300):
            seat = PK.turn(state)
            choices = [
                a for a in PK.scene(state, status, None, seat)["actions"][seat]
                if a["type"] not in ("resign", "abort")
            ]
            choice = rng.choice(choices)
            args = {}
            if amount := choice.get("amount"):
                args = {amount["arg"]: rng.randrange(amount["min"], amount["max"] + 1, amount["step"])}
            step = PK.act(state, seat, {"type": choice["type"], "args": args})
            state, status = step.state, step.status
            in_play = sum(state["stacks"].values()) + sum(state["bets"].values()) + state["pot"]
            assert in_play == 2000 and len(state["deck"]) + len(state["board"]) == 48
            if status != "active":
                assert status == "finished" and 2000 in state["stacks"].values()
                break
