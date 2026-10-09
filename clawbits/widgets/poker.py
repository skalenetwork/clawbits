"""The ``poker`` widget: heads-up no-limit Texas hold'em, for chips worth nothing.

Each seat starts with 1000 chips. Blinds start at 10/20 and double every ten hands, so a match
ends. The dealer posts the small blind, acts first before the flop and last after it. A hand ends
at a fold, which deals the next one at once, or at a showdown, which waits for either seat to deal
so both can see what won. The match ends when one seat holds every chip.

Chips are play money inside this widget: nothing turns them into, or out of, anything of value.

Cards are secret, so the kind is ``private``: a seat sees its own two cards and the board, and the
other seat's only when a showdown shows them. The deck stays in the state, which never leaves the
server.

State: ``{"hand": n, "button": seat, "stacks": {seat: chips}, "bets": {seat: chips}, "pot": chips,
"deck": [card], "hole": {seat: [card, card]}, "board": [card], "phase": "betting" | "showdown",
"to_act": seat | None, "acted": [seat], "raise": chips, "result": {...} | None, "log": [event]}``.
``stacks`` are the chips behind, ``bets`` this street's and ``pot`` the earlier streets'; ``acted``
is who has acted since the street's last bet, and ``raise`` the smallest raise allowed.
"""
from __future__ import annotations

from typing import Any

from clawbits.widgets.base import (
    ABORT_TEXT,
    InvalidAction,
    NotYourTurn,
    Step,
    WidgetStatus,
)
from clawbits.widgets.cards import best_hand, card_text, describe, shuffled_deck

SEATS = ("red", "blue")
START_STACK = 1000
SMALL_BLIND = 10
LEVEL_HANDS = 10  # blinds double this often
_LOG_KEEP = 12
_STREETS = {0: "flop", 3: "turn", 4: "river"}  # the street dealt next, by the cards already out
_RESIGN = {"type": "resign", "label": "Resign", "tone": "danger", "confirm": "Resign this match?"}
_ABORT = {"type": "abort", "label": "Abort", "confirm": "Abort this match?"}


def _other(seat: str) -> str:
    return SEATS[1 - SEATS.index(seat)]


def _blinds(hand: int) -> tuple[int, int]:
    small = SMALL_BLIND * 2 ** ((hand - 1) // LEVEL_HANDS)
    return small, 2 * small


def _log(state: dict[str, Any], *events: dict[str, Any]) -> list[dict[str, Any]]:
    return [*state["log"], *events][-_LOG_KEEP:]


def _deal(hand: int, button: str, stacks: dict[str, int], log: list[dict[str, Any]]) -> Step:
    """Hand ``hand``: a fresh deck, two cards each, and the blinds, or what a stack holds of them."""
    deck = shuffled_deck()
    other = _other(button)
    small, big = _blinds(hand)
    bets = {button: min(small, stacks[button]), other: min(big, stacks[other])}
    event: dict[str, Any] = {"t": "hand", "n": hand}
    if hand == 1 or _blinds(hand - 1) != (small, big):
        event["blinds"] = [small, big]
    state = {
        "hand": hand,
        "button": button,
        "stacks": {seat: stacks[seat] - bets[seat] for seat in SEATS},
        "bets": bets,
        "pot": 0,
        "deck": deck[4:],
        "hole": {button: deck[0:2], other: deck[2:4]},
        "board": [],
        "phase": "betting",
        "to_act": None,
        "acted": [],
        "raise": big,
        "result": None,
        "log": [*log, event][-_LOG_KEEP:],
    }
    return _advance(state)


def _advance(state: dict[str, Any]) -> Step:
    """The seat to act next; when none need to, the street is over."""
    bets, stacks, button = state["bets"], state["stacks"], state["button"]
    high = max(bets.values())
    live = [seat for seat in SEATS if stacks[seat] > 0]
    order = (_other(button), button) if state["board"] else (button, _other(button))
    # A seat with chips behind acts when it faces a bet, or, while the other could still answer, when
    # it hasn't acted on this street: the big blind's option is one.
    pending = [
        seat
        for seat in order
        if seat in live and (bets[seat] < high or (len(live) == 2 and seat not in state["acted"]))
    ]
    if pending:
        return Step({**state, "to_act": pending[0]})
    return _close_street(state)


def _close_street(state: dict[str, Any]) -> Step:
    """Called bets into the pot and an uncalled one back to its owner; then the next street, or every
    street left when someone is all-in; the showdown after the river."""
    bets = state["bets"]
    matched = min(bets.values())
    stacks = {seat: state["stacks"][seat] + bets[seat] - matched for seat in SEATS}
    state = {
        **state,
        "stacks": stacks,
        "bets": {seat: 0 for seat in SEATS},
        "pot": state["pot"] + matched * len(SEATS),
        "to_act": None,
        "acted": [],
        "raise": _blinds(state["hand"])[1],
    }
    all_in = any(stacks[seat] == 0 for seat in SEATS)
    while len(state["board"]) < 5:
        count = 3 if not state["board"] else 1
        cards = state["deck"][:count]
        event = {"t": "street", "name": _STREETS[len(state["board"])], "cards": cards}
        state = {
            **state,
            "board": [*state["board"], *cards],
            "deck": state["deck"][count:],
            "log": _log(state, event),
        }
        if not all_in:
            return _advance(state)
    return _showdown(state)


def _showdown(state: dict[str, Any]) -> Step:
    """Both hands shown and the pot to the better; a tie splits it, the odd chip to the big blind."""
    hands = {seat: best_hand([*state["hole"][seat], *state["board"]]) for seat in SEATS}
    top = max(rank for rank, _ in hands.values())
    winners = [seat for seat in SEATS if hands[seat][0] == top]
    pot = state["pot"]
    won = {seat: pot // len(winners) for seat in winners}
    if len(winners) > 1:
        won[_other(state["button"])] += pot % len(winners)
    stacks = {seat: state["stacks"][seat] + won.get(seat, 0) for seat in SEATS}
    result = {
        "won": won,
        "rank": list(top),
        "shown": {seat: {"rank": list(rank), "best": list(best)} for seat, (rank, best) in hands.items()},
    }
    next_state = {
        **state,
        "stacks": stacks,
        "pot": 0,
        "phase": "showdown",
        "to_act": None,
        "result": result,
        "log": _log(state, {"t": "win", "won": won, "rank": list(top)}),
    }
    broke = [seat for seat in SEATS if stacks[seat] == 0]
    if broke:
        return Step(next_state, "finished", {"termination": "chips", "winner": _other(broke[0])})
    return Step(next_state)


def _call(state: dict[str, Any], seat: str, amount: int) -> Step:
    bets = {**state["bets"], seat: state["bets"][seat] + amount}
    stacks = {**state["stacks"], seat: state["stacks"][seat] - amount}
    event = {"t": "call", "s": seat, "n": amount, "allin": stacks[seat] == 0}
    return _advance({
        **state,
        "bets": bets,
        "stacks": stacks,
        "acted": [*state["acted"], seat],
        "log": _log(state, event),
    })


def _raise(state: dict[str, Any], seat: str, to: object) -> Step:
    """Bet or raise so ``seat``'s chips on this street come to ``to``. Short of a full raise only
    when that is all ``seat`` has."""
    bets, stacks = state["bets"], state["stacks"]
    if not isinstance(to, int) or isinstance(to, bool):
        raise InvalidAction("Say how much in args.to: what your bet on this street comes to")
    if stacks[_other(seat)] == 0:
        raise InvalidAction("They're all-in: call or fold")
    high = max(bets.values())
    most = bets[seat] + stacks[seat]
    least = high + state["raise"]
    if to > most:
        raise InvalidAction(f"You have {most} at most")
    if to <= high or (to < least and to != most):
        raise InvalidAction(f"{'Raise to' if high else 'Bet'} at least {min(least, most)}")
    event = {"t": "raise" if high else "bet", "s": seat, "to": to, "allin": to == most}
    return _advance({
        **state,
        "bets": {**bets, seat: to},
        "stacks": {**stacks, seat: most - to},
        "acted": [seat],
        "raise": max(to - high, state["raise"]),
        "log": _log(state, event),
    })


def _fold(state: dict[str, Any], seat: str) -> Step:
    """The other seat takes the pot and the bets, and the next hand deals at once: nothing to show."""
    other = _other(seat)
    bets = state["bets"]
    stacks = {**state["stacks"], other: state["stacks"][other] + state["pot"] + sum(bets.values())}
    won = state["pot"] + 2 * min(bets.values())  # what the other seat's bet was called for
    log = _log(state, {"t": "fold", "s": seat}, {"t": "win", "won": {other: won}})
    return _deal(state["hand"] + 1, _other(state["button"]), stacks, log)


def _cap(text: str) -> str:
    return text[:1].upper() + text[1:]


def _who(seat: str, viewer: str | None) -> tuple[str, str]:
    """How ``viewer`` names ``seat``, and the verb ending that goes with the name."""
    if viewer is None:
        return seat.capitalize(), "s"
    return ("You" if seat == viewer else "They"), ""


def _say(event: dict[str, Any], viewer: str | None) -> str:
    """A log event as ``viewer`` reads it."""
    kind = event["t"]
    if kind == "hand":
        blinds = event.get("blinds")
        return f"Hand {event['n']}, blinds {blinds[0]}/{blinds[1]}" if blinds else f"Hand {event['n']}"
    if kind == "street":
        return f"{event['name'].capitalize()} {' '.join(card_text(card) for card in event['cards'])}"
    if kind == "win":
        won = event["won"]
        if len(won) > 1:
            return f"Split pot, {min(won.values())} each"
        seat, amount = next(iter(won.items()))
        who, s = _who(seat, viewer)
        rank = event.get("rank")
        return f"{who} win{s} {amount}" + (f" with {describe(tuple(rank))}" if rank else "")
    who, s = _who(event["s"], viewer)
    all_in = ", all-in" if event.get("allin") else ""
    match kind:
        case "fold":
            return f"{who} fold{s}"
        case "check":
            return f"{who} check{s}"
        case "call":
            return f"{who} call{s} {event['n']}{all_in}"
        case "bet":
            return f"{who} bet{s} {event['to']}{all_in}"
        case _:
            return f"{who} raise{s} to {event['to']}{all_in}"


def _status(
    state: dict[str, Any], status: WidgetStatus, outcome: dict[str, Any] | None, seat: str | None
) -> tuple[str, str]:
    if status == "aborted":
        return ABORT_TEXT.get((outcome or {}).get("reason", "aborted"), ABORT_TEXT["aborted"]), "muted"
    if status == "finished" and outcome:
        # The reason alone: clients show who won, with a cup.
        winner = outcome["winner"]
        resigned = outcome["termination"] == "resign"
        if seat is None:
            loser = _other(winner).capitalize()
            return (f"{loser} resigned" if resigned else f"{loser} is out of chips"), "info"
        if resigned:
            return ("They resigned" if winner == seat else "You resigned"), "info"
        return ("Every chip is yours" if winner == seat else "You're out of chips"), "info"
    if state["phase"] == "showdown":
        result = state["result"]
        return _say({"t": "win", "won": result["won"], "rank": result["rank"]}, seat), "info"
    to_act = state["to_act"]
    if seat is None:
        return f"{to_act.capitalize()} to act", "neutral"
    if to_act != seat:
        return "Their turn", "neutral"
    owe = max(state["bets"].values()) - state["bets"][seat]
    return (f"Your turn · {min(owe, state['stacks'][seat])} to call" if owe else "Your turn"), "neutral"


class Poker:
    seats = SEATS
    private = True

    def init(self) -> dict[str, Any]:
        return _deal(1, SEATS[0], {seat: START_STACK for seat in SEATS}, []).state

    def turn(self, state: dict[str, Any]) -> str | None:
        if state["phase"] == "showdown":
            return _other(state["button"])  # the next hand's dealer, first to act in it
        return state["to_act"]

    def act(self, state: dict[str, Any], seat: str, action: dict[str, Any]) -> Step:
        kind = action.get("type")
        args = action.get("args") or {}
        if not isinstance(args, dict):
            raise InvalidAction("args must be an object")
        if kind == "resign":
            return Step(state, "finished", {"termination": "resign", "winner": _other(seat)})
        if kind == "abort":
            if state["hand"] > 1:
                raise InvalidAction("The match is underway: resign instead")
            return Step(state, "aborted", {"reason": "aborted", "by": seat})
        if kind == "deal":
            if state["phase"] != "showdown":
                raise InvalidAction("This hand is still being played")
            return _deal(state["hand"] + 1, _other(state["button"]), state["stacks"], state["log"])
        if kind not in ("fold", "check", "call", "bet", "raise", "allin"):
            raise InvalidAction(f"Unknown action {kind!r}")
        if state["phase"] != "betting":
            raise InvalidAction("This hand is over: deal the next one")
        if seat != state["to_act"]:
            raise NotYourTurn("It's not your turn")
        bets, stacks = state["bets"], state["stacks"]
        owe = max(bets.values()) - bets[seat]
        most = bets[seat] + stacks[seat]
        if kind == "check":
            if owe:
                raise InvalidAction(f"{owe} to call: call, raise or fold")
            event = {"t": "check", "s": seat}
            return _advance({**state, "acted": [*state["acted"], seat], "log": _log(state, event)})
        if kind in ("fold", "call") and not owe:
            raise InvalidAction("Nothing to call: check instead")
        if kind == "fold":
            return _fold(state, seat)
        # All-in is a call when no raise is left: the other seat is all-in, or this one can't top the bet.
        can_raise = stacks[_other(seat)] > 0 and most > max(bets.values())
        if kind == "call" or (kind == "allin" and not can_raise):
            return _call(state, seat, min(owe, stacks[seat]))
        return _raise(state, seat, most if kind == "allin" else args.get("to"))

    def scene(
        self,
        state: dict[str, Any],
        status: WidgetStatus,
        outcome: dict[str, Any] | None,
        seat: str | None = None,
    ) -> dict[str, Any]:
        active = status == "active"
        result = state["result"] or {}
        shown = result.get("shown", {})
        winners = set(result.get("won", {}))
        # The viewer's cards at the bottom, the way a table seats you.
        top, bottom = (_other(seat), seat) if seat else (SEATS[1], SEATS[0])
        text, tone = _status(state, status, outcome, seat)
        return {
            "v": 1,
            "title": "Hold'em",
            "table": {
                "rows": [
                    self._hand(state, top, seat, shown, winners),
                    self._board(state, shown, winners),
                    self._hand(state, bottom, seat, shown, winners),
                ]
            },
            "seat_notes": {
                s: f"{state['stacks'][s]} chips" + (" · dealer" if s == state["button"] else "")
                for s in SEATS
            },
            "turn": self.turn(state) if active else None,
            "input": {},
            "actions": {seat: self._actions(state, seat)} if active and seat else {},
            "status": {"text": text, "tone": tone},
            "log": [f"{_say(event, seat)}." for event in state["log"]],
        }

    @staticmethod
    def _hand(
        state: dict[str, Any], owner: str, viewer: str | None, shown: dict[str, Any], winners: set[str]
    ) -> dict[str, Any]:
        cards = state["hole"][owner]
        whose = "Your" if owner == viewer else "Their" if viewer else f"{owner.capitalize()}'s"
        row: dict[str, Any] = {
            "id": owner,
            "seat": owner,
            "label": f"{whose} cards",
            "cards": cards if owner == viewer or owner in shown else ["back", "back"],
        }
        if owner in shown:
            row["note"] = _cap(describe(tuple(shown[owner]["rank"])))
            if owner in winners:
                row["lift"] = [i for i, card in enumerate(cards) if card in shown[owner]["best"]]
        elif bet := state["bets"][owner]:
            row["note"] = f"Bet {bet}" + (" · all-in" if not state["stacks"][owner] else "")
        return row

    @staticmethod
    def _board(state: dict[str, Any], shown: dict[str, Any], winners: set[str]) -> dict[str, Any]:
        board = state["board"]
        if shown:
            pot = sum(state["result"]["won"].values())
        else:
            pot = state["pot"] + sum(state["bets"].values())
        row: dict[str, Any] = {
            "id": "board",
            "label": "Board",
            "cards": [*board, *[None] * (5 - len(board))],
            "note": f"Pot {pot}",
        }
        if shown:
            best = {card for seat in winners for card in shown[seat]["best"]}
            row["lift"] = [i for i, card in enumerate(board) if card in best]
        return row

    @staticmethod
    def _actions(state: dict[str, Any], seat: str) -> list[dict[str, Any]]:
        """Deal after a showdown, or the seat's betting choices on its turn; resign always, and abort
        in the first hand."""
        actions: list[dict[str, Any]] = []
        if state["phase"] == "showdown":
            actions.append({"type": "deal", "label": "Deal next hand", "tone": "primary"})
        elif state["to_act"] == seat:
            actions += _choices(state, seat)
        actions.append(_RESIGN)
        if state["hand"] == 1:
            actions.append(_ABORT)
        return actions


def _choices(state: dict[str, Any], seat: str) -> list[dict[str, Any]]:
    """Fold and call, or check; then a bet of any size, with the smallest raise, half the pot and the
    pot as quick picks, and all-in. The size goes in ``args.to``."""
    bets, stacks = state["bets"], state["stacks"]
    high = max(bets.values())
    owe = high - bets[seat]
    most = bets[seat] + stacks[seat]
    if owe:
        call = min(owe, stacks[seat])
        label = f"Call {call}" + (" · all-in" if call == stacks[seat] else "")
        choices = [{"type": "fold", "label": "Fold"}, {"type": "call", "label": label, "tone": "primary"}]
    else:
        choices = [{"type": "check", "label": "Check", "tone": "primary"}]
    if stacks[_other(seat)] == 0 or most <= high:
        return choices
    pot = state["pot"] + sum(bets.values()) + owe  # the pot once this seat has called
    least = high + state["raise"]
    if least < most:
        picks: dict[int, str] = {}
        for label, to in (("Min", least), ("½ pot", high + pot // 2), ("Pot", high + pot)):
            if least <= to < most:
                picks.setdefault(to, label)
        kind, verb = ("raise", "Raise to") if high else ("bet", "Bet")
        choices.append({
            "type": kind,
            "label": verb,
            "amount": {
                "arg": "to",
                "min": least,
                "max": most,
                "step": SMALL_BLIND,
                "value": min(max(least, high + pot // 2), most),
                "presets": [{"label": label, "value": to} for to, label in picks.items()],
            },
        })
    choices.append({
        "type": "allin",
        "label": f"All-in {stacks[seat]}",
        "confirm": f"Go all-in for {stacks[seat]}?",
    })
    return choices


POKER = Poker()
