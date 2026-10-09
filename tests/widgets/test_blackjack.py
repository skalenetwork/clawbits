"""The blackjack widget: two seats against the house, bets, hits, doubles, splits, and the dealer's rules."""

import random

import pytest

import clawbits.widgets.blackjack as blackjack
from clawbits.widgets import KINDS, InvalidAction, NotYourTurn, Step
from clawbits.widgets.blackjack import total
from clawbits.widgets.cards import DECK

BJ = KINDS["blackjack"]


def stack(monkeypatch, *tops: str) -> None:
    """Deal rounds from decks that start with ``tops``: the first seat's card, the second's, the
    dealer's up card, the first seat's second, the second's, the dealer's hole card, then draws."""
    decks = [top.split() + [card for card in DECK if card not in top.split()] for top in tops]
    monkeypatch.setattr(blackjack, "shuffled_deck", lambda: decks.pop(0))


def act(state: dict, seat: str, kind: str, **args) -> Step:
    return BJ.act(state, seat, {"type": kind, "args": args})


def dealt(state: dict, red: int = 100, blue: int = 100) -> dict:
    return act(act(state, "red", "bet", amount=red).state, "blue", "bet", amount=blue).state


def rows(state: dict, seat: str | None, status: str = "active", outcome: dict | None = None) -> dict:
    return {row["id"]: row for row in BJ.scene(state, status, outcome, seat)["table"]["rows"]}


def test_aces_count_eleven_until_that_would_bust():
    assert total(["As", "6d"]) == (17, True)
    assert total(["As", "6d", "9c"]) == (16, False)
    assert total(["As", "Ad"]) == (12, True)
    assert total(["Kd", "Qs", "2c"]) == (22, False)


def test_both_bets_deal_the_round(monkeypatch):
    stack(monkeypatch, "9c 5d Td 7h 6s 8c")
    state = BJ.init()
    assert BJ.turn(state) is None
    red = BJ.scene(state, "active", None, "red")
    assert [a["type"] for a in red["actions"]["red"]] == ["bet", "resign", "abort"]
    assert red["actions"]["red"][0]["amount"] == {"arg": "amount", "min": 10, "max": 1000, "step": 10, "value": 100}
    assert [row["cards"] for row in red["table"]["rows"]] == [[None, None]] * 3
    state = act(state, "red", "bet", amount=50).state
    assert BJ.turn(state) == "blue"
    assert BJ.scene(state, "active", None, "red")["status"]["text"] == "Waiting for their bet"
    with pytest.raises(InvalidAction, match="bet is in"):
        act(state, "red", "bet", amount=50)
    with pytest.raises(InvalidAction, match="in tens"):
        act(state, "blue", "bet", amount=15)
    with pytest.raises(InvalidAction, match="in tens"):
        act(state, "blue", "bet", amount=2000)
    with pytest.raises(InvalidAction, match="bet first"):
        act(state, "red", "hit")
    state = act(state, "blue", "bet", amount=100).state
    assert (state["phase"], BJ.turn(state), state["stacks"]) == ("playing", "red", {"red": 950, "blue": 900})
    table = rows(state, "blue")
    assert list(table) == ["red-0", "dealer", "blue-0"]
    assert (table["dealer"]["cards"], table["dealer"]["note"]) == (["Td", "back"], "Dealer shows 10♦")
    assert (table["red-0"]["cards"], table["red-0"]["note"], table["red-0"]["active"]) == (["9c", "7h"], "16 · bet 50", True)
    with pytest.raises(NotYourTurn):
        act(state, "blue", "hit")


def test_hit_stand_double_and_the_dealer_draws_to_17(monkeypatch):
    stack(monkeypatch, "9c 5d Td 7h 6s 6c 2d 9h Ks")
    state = act(dealt(BJ.init()), "red", "hit").state
    assert (BJ.turn(state), total(state["hands"]["red"][0]["cards"])) == ("red", (18, False))
    state = act(state, "red", "stand").state
    blue = BJ.scene(state, "active", None, "blue")["actions"]["blue"]
    assert [a["label"] for a in blue[:3]] == ["Hit", "Stand", "Double to 200"]
    state = act(state, "blue", "double").state
    assert (state["round"], state["phase"], state["order"]) == (2, "betting", ["blue", "red"])
    assert state["stacks"] == {"red": 1100, "blue": 1200} and state["bets"] == {"red": 100, "blue": 100}
    red = BJ.scene(state, "active", None, "red")
    assert red["status"]["text"] == "You won 100 · Bet for round 2 of 10"
    table = rows(state, "red")
    assert (table["red-0"]["note"], table["blue-0"]["note"]) == ("18 · +100", "20 · +200")
    assert (table["dealer"]["cards"], table["dealer"]["note"]) == (["Td", "6c", "Ks"], "Dealer busts · 26")
    assert red["log"][-7:] == [
        "You hit 2♦ for 18.", "You stand on 18.", "They double and draw 9♥ for 20.",
        "Dealer busts with 26.", "You win 100.", "They win 200.", "Round 2.",
    ]


def test_a_split_plays_two_hands(monkeypatch):
    stack(monkeypatch, "8c 5d Td 8d 6s 7c 3h 2s Ks")
    state = dealt(BJ.init())
    assert [a["type"] for a in BJ.scene(state, "active", None, "red")["actions"]["red"]][:4] == [
        "hit", "stand", "double", "split",
    ]
    state = act(state, "red", "split").state
    assert [h["cards"] for h in state["hands"]["red"]] == [["8c", "3h"], ["8d", "2s"]]
    assert state["stacks"]["red"] == 800 and BJ.turn(state) == "red"
    red = BJ.scene(state, "active", None, "red")
    assert red["status"]["text"] == "Your turn, hand 1 · 11"
    assert [r["id"] for r in red["table"]["rows"]] == ["blue-0", "dealer", "red-0", "red-1"]
    assert red["table"]["rows"][2].get("active") and not red["table"]["rows"][3].get("active")
    state = act(state, "red", "double").state  # double after a split: Ks makes 21
    assert state["active"] == 1 and "split" not in [a["type"] for a in BJ.scene(state, "active", None, "red")["actions"]["red"]]
    with pytest.raises(InvalidAction, match="Split needs"):
        act(state, "red", "split")
    state = act(act(state, "red", "stand").state, "blue", "stand").state
    assert state["result"] == {"red": [200, -100], "blue": [-100]}
    assert state["stacks"] == {"red": 1100, "blue": 900}


def test_split_aces_take_one_card_each_and_21_is_not_blackjack(monkeypatch):
    stack(monkeypatch, "As 5d Td Ad 6s 7c 9c Kd")
    state = act(dealt(BJ.init()), "red", "split").state
    assert BJ.turn(state) == "blue"
    table = rows(state, "red")
    assert (table["red-0"]["note"], table["red-1"]["note"]) == ("Soft 20 · bet 100", "21 · bet 100")


def test_the_dealer_peeks_for_blackjack(monkeypatch):
    stack(monkeypatch, "Ah 5d As Kh 6s Kd")
    state = dealt(BJ.init())
    assert (state["round"], state["result"]) == (2, {"red": [0], "blue": [-100]})
    assert state["stacks"] == {"red": 1000, "blue": 900}
    red = BJ.scene(state, "active", None, "red")
    assert red["status"]["text"] == "You broke even · Bet for round 2 of 10"
    assert red["log"][-4:] == ["Dealer has blackjack.", "You break even.", "They lose 100.", "Round 2."]


def test_blackjack_pays_three_to_two(monkeypatch):
    stack(monkeypatch, "As 5d 9c Kd 6s 8h")
    state = dealt(BJ.init())
    assert BJ.turn(state) == "blue" and rows(state, "red")["red-0"]["note"] == "Blackjack · bet 100"
    state = act(state, "blue", "stand").state
    assert state["result"] == {"red": [150], "blue": [-100]}
    assert state["stacks"] == {"red": 1150, "blue": 900}


def test_the_bigger_stack_wins_after_ten_rounds(monkeypatch):
    stack(monkeypatch, "As 5d 9c Kd 6s 8h", "Td 9d 7c 7h 8s Kc")
    step = act(dealt(BJ.init() | {"round": 10}), "blue", "stand")
    assert step.status == "finished" and step.outcome == {"termination": "rounds", "winner": "red"}
    blue = BJ.scene(step.state, step.status, step.outcome, "blue")
    assert blue["status"]["text"] == "900 chips to 1150" and blue["actions"] == {}
    assert rows(step.state, "blue", step.status, step.outcome)["dealer"]["cards"] == ["9c", "8h"]
    # Both stand on 17 against the dealer's 17: even, and a draw.
    state = dealt(BJ.init() | {"round": 10})
    step = act(act(state, "red", "stand").state, "blue", "stand")
    assert step.outcome == {"termination": "rounds", "winner": None}
    assert BJ.scene(step.state, step.status, step.outcome, "red")["status"]["text"] == "1000 chips each"


def test_a_seat_out_of_chips_ends_the_match(monkeypatch):
    stack(monkeypatch, "9c 5d Td 7h 6s 8c")
    state = BJ.init() | {"stacks": {"red": 100, "blue": 1000}}
    step = act(dealt(state), "red", "stand")  # 16 against 18
    step = act(step.state, "blue", "stand")
    assert step.status == "finished" and step.outcome == {"termination": "broke", "winner": "blue"}


def test_abort_only_in_the_first_round_and_resign_any_time(monkeypatch):
    stack(monkeypatch, "Ah 5d As Kh 6s Kd")
    assert act(BJ.init(), "blue", "abort").status == "aborted"
    state = dealt(BJ.init())  # the dealer's blackjack ends round 1 at once
    with pytest.raises(InvalidAction, match="resign instead"):
        act(state, "red", "abort")
    step = act(state, "red", "resign")
    assert step.outcome == {"termination": "resign", "winner": "blue"}
    assert BJ.scene(step.state, step.status, step.outcome, "blue")["status"]["text"] == "They resigned"
    with pytest.raises(InvalidAction, match="Unknown action"):
        act(state, "red", "surrender")


def test_random_play_always_finishes_with_whole_chips(monkeypatch):
    rng = random.Random(11)

    def deck() -> list[str]:
        cards = list(DECK)
        rng.shuffle(cards)
        return cards

    monkeypatch.setattr(blackjack, "shuffled_deck", deck)
    for _ in range(40):
        state, status = BJ.init(), "active"
        while status == "active":
            if state["phase"] == "betting":
                seat = next(s for s in BJ.seats if s not in state["placed"])
            else:
                seat = state["to_act"]
            choices = [
                a for a in BJ.scene(state, status, None, seat)["actions"][seat]
                if a["type"] not in ("resign", "abort") and not a.get("disabled")
            ]
            choice = rng.choice(choices)
            args = {}
            if amount := choice.get("amount"):
                args = {amount["arg"]: rng.randrange(amount["min"], amount["max"] + 1, amount["step"])}
            step = BJ.act(state, seat, {"type": choice["type"], "args": args})
            state, status = step.state, step.status
            assert all(chips >= 0 and chips % 5 == 0 for chips in state["stacks"].values())
            assert state["round"] <= 10
        assert status == "finished" and step.outcome["termination"] in ("rounds", "broke")
