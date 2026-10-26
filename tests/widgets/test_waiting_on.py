"""Who each kind waits on, phase by phase: ``turn`` names one seat, ``waiting_on`` every seat that
may act now, so both players of a setup or a betting round see "your move"."""

import random

import pytest

import clawbits.widgets.blackjack as blackjack
import clawbits.widgets.poker as poker
from clawbits.db.models import MmWidget
from clawbits.db.table_write import TableWrite
from clawbits.widgets import KINDS, WidgetKind
from clawbits.widgets.cards import DECK

BS, BJ, PK, CHESS = KINDS["battleship"], KINDS["blackjack"], KINDS["poker"], KINDS["chess"]


def act(kind: WidgetKind, state: dict, seat: str, action: str, **args) -> dict:
    return kind.act(state, seat, {"type": action, "args": args}).state


def stack(monkeypatch, module, top: str) -> None:
    deck = top.split() + [card for card in DECK if card not in top.split()]
    monkeypatch.setattr(module, "shuffled_deck", lambda: list(deck))


def test_battleship_waits_on_each_fleet_until_ready_then_on_the_shooter():
    state = BS.init()
    assert (BS.turn(state), BS.waiting_on(state)) == (None, ("red", "blue"))
    state = act(BS, state, "red", "ready")
    assert BS.waiting_on(state) == ("blue",)
    state = act(BS, state, "blue", "ready")
    assert (BS.turn(state), BS.waiting_on(state)) == ("red", ("red",))
    miss = next(f"{c}{r}" for c in "ABCDEFGHIJ" for r in range(1, 11)
                if not any(f"{c}{r}" in ship for ship in state["fleets"]["blue"]))
    state = act(BS, state, "red", "fire", at=miss)
    assert (BS.turn(state), BS.waiting_on(state)) == ("blue", ("blue",))


def test_blackjack_waits_on_every_bet_then_on_the_hand_to_play(monkeypatch):
    stack(monkeypatch, blackjack, "9c 5d Td 7h 6s 8c")
    state = BJ.init()
    assert (BJ.turn(state), BJ.waiting_on(state)) == (None, ("red", "blue"))
    state = act(BJ, state, "red", "bet", amount=50)
    assert (BJ.turn(state), BJ.waiting_on(state)) == ("blue", ("blue",))
    state = act(BJ, state, "blue", "bet", amount=100)
    assert (state["phase"], BJ.waiting_on(state)) == ("playing", ("red",))
    state = act(BJ, state, "red", "stand")
    assert BJ.waiting_on(state) == ("blue",)
    state = act(BJ, state, "blue", "stand")  # the dealer plays: round 2's bets, both again
    assert (state["round"], BJ.waiting_on(state)) == (2, ("red", "blue"))


def test_poker_waits_on_the_seat_to_act_and_after_a_showdown_on_the_next_dealer():
    state = PK.init()
    assert PK.waiting_on(state) == ("red",)  # the dealer acts first before the flop
    state = act(PK, state, "red", "call")
    assert PK.waiting_on(state) == ("blue",)  # the big blind's option
    state = act(PK, state, "blue", "check")
    for _ in range(3):
        state = act(PK, state, "blue", "check")
        state = act(PK, state, "red", "check")
    assert state["phase"] == "showdown" and state["button"] == "red"
    # Either seat may deal, but only the next dealer is waited on.
    assert (PK.turn(state), PK.waiting_on(state)) == ("blue", ("blue",))
    state = act(PK, state, "red", "deal")
    assert (state["button"], PK.waiting_on(state)) == ("blue", ("blue",))


def test_chess_waits_on_the_side_to_move():
    state = CHESS.init()
    assert CHESS.waiting_on(state) == ("white",)
    state = act(CHESS, state, "white", "move", move="e4")
    assert CHESS.waiting_on(state) == ("black",)
    state = act(CHESS, state, "black", "offer_draw")  # an offer leaves the move where it was
    assert CHESS.waiting_on(state) == ("black",)


@pytest.mark.parametrize(("kind", "module"), [(BJ, blackjack), (PK, poker)])
def test_turn_is_always_waited_on_and_each_waited_on_seat_may_act(monkeypatch, kind, module):
    rng = random.Random(5)

    def deck() -> list[str]:
        cards = list(DECK)
        rng.shuffle(cards)
        return cards

    monkeypatch.setattr(module, "shuffled_deck", deck)
    for _ in range(20):
        state, status = kind.init(), "active"
        for _ in range(300):
            waiting = kind.waiting_on(state)
            assert waiting and (kind.turn(state) is None or kind.turn(state) in waiting)
            moves = {
                seat: [a for a in kind.scene(state, status, None, seat)["actions"].get(seat, [])
                       if a["type"] not in ("resign", "abort") and not a.get("disabled")]
                for seat in waiting
            }
            assert all(moves.values())
            seat = rng.choice(waiting)
            choice = rng.choice(moves[seat])
            args = {}
            if amount := choice.get("amount"):
                args = {amount["arg"]: rng.randrange(amount["min"], amount["max"] + 1, amount["step"])}
            step = kind.act(state, seat, {"type": choice["type"], "args": args})
            state, status = step.state, step.status
            if status != "active":
                break


class _Session:
    """Enough of a session for a step that only sets fields on the row it is given."""

    def add(self, _row: object) -> None: ...

    def flush(self) -> None: ...


@pytest.mark.parametrize("action", ["resign", "abort"])
def test_an_ended_widget_waits_on_no_one(action):
    state = BS.init()
    widget = MmWidget(widget_id="w", channel_id="c", kind="battleship", state=state,
                      waiting_on=list(BS.waiting_on(state)))
    if action == "resign":
        state = act(BS, act(BS, state, "red", "ready"), "blue", "ready")
    step = BS.act(state, "red", {"type": action})
    assert step.status != "active"
    TableWrite.save_mm_widget_step(
        _Session(), widget, state=step.state, status=step.status, outcome=step.outcome,
        turn=BS.turn(step.state), waiting_on=BS.waiting_on(step.state),
    )
    assert (widget.status, widget.turn, widget.waiting_on, widget.rev) == (step.status, None, [], 1)


def _step(kind: WidgetKind, widget: MmWidget, seat: str, action: str, **args) -> dict[str, int]:
    """Apply one action to ``widget`` as the service does and return the hand-off marks."""
    step = kind.act(widget.state, seat, {"type": action, "args": args})
    return TableWrite.save_mm_widget_step(
        _Session(), widget, state=step.state, status=step.status, outcome=step.outcome,
        turn=kind.turn(step.state), waiting_on=kind.waiting_on(step.state), seat=seat,
    )


def _widget(kind: WidgetKind, state: dict | None = None) -> MmWidget:
    state = kind.init() if state is None else state
    return MmWidget(widget_id="w", channel_id="c", kind="k", state=state,
                    waiting_on=list(kind.waiting_on(state)))


def test_a_chess_move_hands_the_move_to_the_other_side():
    widget = _widget(CHESS)
    assert _step(CHESS, widget, "white", "move", move="e4") == {"black": 1}
    assert widget.acted_revs == {"white": 1, "black": 1}
    assert _step(CHESS, widget, "black", "offer_draw") == {"black": 2}  # it keeps the move


def test_checkmate_hands_the_move_to_no_one():
    widget = _widget(CHESS)
    for seat, move in zip(("white", "black") * 3, ("e4", "e5", "Bc4", "Nc6", "Qh5", "Nf6"), strict=True):
        _step(CHESS, widget, seat, "move", move=move)
    assert _step(CHESS, widget, "white", "move", move="Qxf7#") == {}
    assert widget.status == "finished"


def test_a_battleship_hit_keeps_the_move_with_the_shooter():
    state = act(BS, act(BS, BS.init(), "red", "ready"), "blue", "ready")
    widget = _widget(BS, state)
    ship = next(ship for ship in state["fleets"]["blue"] if len(ship) > 1)
    assert _step(BS, widget, "red", "fire", at=ship[0]) == {"red": 1}


def test_a_blackjack_settle_hands_both_bets_out_the_settler_included(monkeypatch):
    stack(monkeypatch, blackjack, "9c 5d Td 7h 6s 8c")
    widget = _widget(BJ)
    assert _step(BJ, widget, "red", "bet", amount=50) == {}  # Blue was waited on already
    assert _step(BJ, widget, "blue", "bet", amount=100) == {"red": 2}
    assert _step(BJ, widget, "red", "stand") == {"blue": 3}
    # The dealer plays and round 2's bets open: Red gets the move, Blue (who settled) keeps it.
    assert _step(BJ, widget, "blue", "stand") == {"red": 4, "blue": 4}
    assert _step(BJ, widget, "red", "bet", amount=100) == {}  # Blue's mark stands at 4
    assert widget.acted_revs["blue"] == 4
