"""The ``blackjack`` widget: two players at one table against the house, for chips worth nothing.

Each seat starts with 1000 chips and plays ten rounds; the seat holding more chips after the last
one wins the match, and a seat that can't cover the smallest bet ends it early. A round opens with
both bets, then a fresh deck deals two cards each and two to the dealer, the second face down. A
dealer showing an ace or a ten checks for blackjack before anyone acts. Seats then play their hands
in turn, the first seat alternating by round, and the dealer draws to 17, standing on a soft 17.
Blackjack pays 3 to 2. A seat may double on two cards and split one pair; split aces take one card
each.

Chips are play money inside this widget: nothing turns them into, or out of, anything of value.

Every card on the table is face up but the dealer's second, so seats keep no secrets from each
other: the kind is ``private`` so that each seat reads its own scene ("You hit"), and the deck and
the hole card stay in the state, which never leaves the server.

State: ``{"round": n, "phase": "betting" | "playing", "stacks": {seat: chips},
"bets": {seat: chips}, "placed": [seat], "order": [seat, seat], "deck": [card], "dealer": [card],
"hands": {seat: [{"cards": [card], "bet": chips, "split": bool, "done": bool}]},
"to_act": seat | None, "active": i, "result": {seat: [net]} | None, "log": [event]}``. ``bets``
are what each seat stakes on the next deal; a dealt hand carries its own. ``hands``, ``dealer`` and
``result`` show the last round until the next deal.
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
from clawbits.widgets.cards import card_text, shuffled_deck

SEATS = ("red", "blue")
START_STACK = 1000
ROUNDS = 10
MIN_BET = 10  # bets go in tens, so a 3:2 payout is always whole chips
FIRST_BET = 100
_LOG_KEEP = 12
_RESIGN = {"type": "resign", "label": "Resign", "tone": "danger", "confirm": "Resign this match?"}
_ABORT = {"type": "abort", "label": "Abort", "confirm": "Abort this match?"}


def _other(seat: str) -> str:
    return SEATS[1 - SEATS.index(seat)]


def _value(card: str) -> int:
    return 11 if card[0] == "A" else 10 if card[0] in "TJQK" else int(card[0])


def total(cards: list[str]) -> tuple[int, bool]:
    """The best total of ``cards``, and whether it is soft: an ace in it still counting 11."""
    points = sum(_value(card) for card in cards)
    aces = sum(card[0] == "A" for card in cards)
    while points > 21 and aces:
        points -= 10
        aces -= 1
    return points, aces > 0


def _natural(cards: list[str], split: bool = False) -> bool:
    """Blackjack: 21 in the first two cards, which a split hand never has."""
    return not split and len(cards) == 2 and total(cards)[0] == 21


def _most(stack: int) -> int:
    """The largest bet ``stack`` covers."""
    return stack // MIN_BET * MIN_BET


def _log(state: dict[str, Any], *events: dict[str, Any]) -> list[dict[str, Any]]:
    return [*state["log"], *events][-_LOG_KEEP:]


def _deal(state: dict[str, Any]) -> Step:
    """Both bets are in: a fresh deck, two cards each and two for the dealer, the second face down."""
    deck = shuffled_deck()
    first, second = state["order"]
    cards = {first: [deck[0], deck[3]], second: [deck[1], deck[4]]}
    dealer = [deck[2], deck[5]]
    bets = state["bets"]
    hands = {
        seat: [{"cards": cards[seat], "bet": bets[seat], "split": False, "done": _natural(cards[seat])}]
        for seat in SEATS
    }
    events = [{"t": "shows", "card": dealer[0]}]
    events += [{"t": "blackjack", "s": seat} for seat in state["order"] if hands[seat][0]["done"]]
    state = {
        **state,
        "phase": "playing",
        "stacks": {seat: state["stacks"][seat] - bets[seat] for seat in SEATS},
        "placed": [],
        "deck": deck[6:],
        "dealer": dealer,
        "hands": hands,
        "result": None,
        "log": _log(state, *events),
    }
    if _value(dealer[0]) >= 10 and _natural(dealer):  # the dealer peeks: nobody plays into a blackjack
        return _settle(state)
    return _next(state)


def _next(state: dict[str, Any]) -> Step:
    """The next hand to play, in seat order; with none left, the dealer's turn and the payout."""
    for seat in state["order"]:
        for i, hand in enumerate(state["hands"][seat]):
            if not hand["done"]:
                return Step({**state, "to_act": seat, "active": i})
    return _settle(_dealer_draws(state))


def _dealer_draws(state: dict[str, Any]) -> dict[str, Any]:
    """The dealer draws to 17 and stands on a soft 17; with no hand left to beat, it only turns its card."""
    live = any(
        total(hand["cards"])[0] <= 21 and not _natural(hand["cards"], hand["split"])
        for hands in state["hands"].values()
        for hand in hands
    )
    dealer, deck = list(state["dealer"]), list(state["deck"])
    while live and total(dealer)[0] < 17:
        dealer.append(deck.pop(0))
    return {**state, "dealer": dealer, "deck": deck}


def _net(hand: dict[str, Any], dealer: list[str]) -> int:
    """What ``hand`` wins (or, below zero, loses) against the dealer's cards."""
    points, bet = total(hand["cards"])[0], hand["bet"]
    dealer_points = total(dealer)[0]
    if points > 21:
        return -bet
    if _natural(hand["cards"], hand["split"]):
        return 0 if _natural(dealer) else bet * 3 // 2
    if _natural(dealer):
        return -bet
    if dealer_points > 21 or points > dealer_points:
        return bet
    return 0 if points == dealer_points else -bet


def _settle(state: dict[str, Any]) -> Step:
    """Every hand paid against the dealer's; then the next round's bets, or the end of the match."""
    stacks = dict(state["stacks"])
    result: dict[str, list[int]] = {}
    events: list[dict[str, Any]] = [
        {"t": "dealer", "total": total(state["dealer"])[0], "natural": _natural(state["dealer"])}
    ]
    for seat in state["order"]:
        result[seat] = [_net(hand, state["dealer"]) for hand in state["hands"][seat]]
        stacks[seat] += sum(hand["bet"] for hand in state["hands"][seat]) + sum(result[seat])
        events.append({"t": "settle", "s": seat, "net": sum(result[seat])})
    settled = {
        **state,
        "phase": "betting",
        "stacks": stacks,
        "to_act": None,
        "active": 0,
        "result": result,
        "log": _log(state, *events),
    }
    broke = any(stacks[seat] < MIN_BET for seat in SEATS)
    if state["round"] >= ROUNDS or broke:
        red, blue = (stacks[seat] for seat in SEATS)
        winner = None if red == blue else max(SEATS, key=lambda seat: stacks[seat])
        return Step(settled, "finished", {"termination": "broke" if broke else "rounds", "winner": winner})
    n = state["round"] + 1
    return Step({
        **settled,
        "round": n,
        "order": state["order"][::-1],  # the other seat plays first next round
        "bets": {seat: max(MIN_BET, min(state["bets"][seat], _most(stacks[seat]))) for seat in SEATS},
        "log": _log(settled, {"t": "round", "n": n}),
    })


def _who(seat: str, viewer: str | None) -> tuple[str, str]:
    """How ``viewer`` names ``seat``, and the verb ending that goes with the name."""
    if viewer is None:
        return seat.capitalize(), "s"
    return ("You" if seat == viewer else "They"), ""


def _say(event: dict[str, Any], viewer: str | None) -> str:
    """A log event as ``viewer`` reads it."""
    kind = event["t"]
    if kind == "round":
        return f"Round {event['n']}"
    if kind == "shows":
        return f"Dealer shows {card_text(event['card'])}"
    if kind == "dealer":
        if event["natural"]:
            return "Dealer has blackjack"
        return f"Dealer busts with {event['total']}" if event["total"] > 21 else f"Dealer has {event['total']}"
    who, s = _who(event["s"], viewer)
    match kind:
        case "bet":
            return f"{who} bet{s} {event['n']}"
        case "blackjack":
            return f"{who} {'has' if s else 'have'} blackjack"
        case "stand":
            return f"{who} stand{s} on {event['total']}"
        case "split":
            return f"{who} split{s}"
        case "settle":
            net = event["net"]
            if not net:
                return f"{who} break{s} even"
            return f"{who} win{s} {net}" if net > 0 else f"{who} lose{s} {-net}"
        case _:  # hit or double: a card drawn
            drew = f"{who} hit{s}" if kind == "hit" else f"{who} double{s} and draw{s}"
            points = event["total"]
            return f"{drew} {card_text(event['card'])}" + (
                f" and bust{s} with {points}" if points > 21 else f" for {points}"
            )


def _hand_text(cards: list[str], split: bool) -> str:
    points, soft = total(cards)
    if points > 21:
        return f"Bust {points}"
    if _natural(cards, split):
        return "Blackjack"
    return f"Soft {points}" if soft and points < 21 else str(points)


def _status(
    state: dict[str, Any], status: WidgetStatus, outcome: dict[str, Any] | None, seat: str | None
) -> tuple[str, str]:
    stacks = state["stacks"]
    if status == "aborted":
        return ABORT_TEXT.get((outcome or {}).get("reason", "aborted"), ABORT_TEXT["aborted"]), "muted"
    if status == "finished" and outcome:
        # The reason alone: clients show who won, with a cup.
        winner = outcome["winner"]
        if outcome["termination"] == "resign":
            if seat is None:
                return f"{_other(winner).capitalize()} resigned", "info"
            return ("They resigned" if winner == seat else "You resigned"), "info"
        if winner is None:
            return f"{stacks[SEATS[0]]} chips each", "info"
        # The viewer's chips first; a spectator's, the winner's.
        first = seat or winner
        return f"{stacks[first]} chips to {stacks[_other(first)]}", "info"
    n = state["round"]
    if state["phase"] == "betting":
        if seat is None:
            return f"Round {n}: bets", "neutral"
        if seat in state["placed"]:
            return "Waiting for their bet", "neutral"
        net = sum((state["result"] or {}).get(seat, []))
        if not state["result"]:
            lead = ""
        elif net:
            lead = f"You won {net} · " if net > 0 else f"You lost {-net} · "
        else:
            lead = "You broke even · "
        return f"{lead}Bet for round {n} of {ROUNDS}", "neutral"
    to_act = state["to_act"]
    if seat is None:
        return f"{to_act.capitalize()} to play", "neutral"
    if to_act != seat:
        return "Their turn", "neutral"
    hands = state["hands"][seat]
    hand = hands[state["active"]]
    which = f", hand {state['active'] + 1}" if len(hands) > 1 else ""
    return f"Your turn{which} · {_hand_text(hand['cards'], hand['split'])}", "neutral"


class Blackjack:
    seats = SEATS
    private = True

    def init(self) -> dict[str, Any]:
        return {
            "round": 1,
            "phase": "betting",
            "stacks": {seat: START_STACK for seat in SEATS},
            "bets": {seat: FIRST_BET for seat in SEATS},
            "placed": [],
            "order": list(SEATS),
            "deck": [],
            "dealer": [],
            "hands": {},
            "to_act": None,
            "active": 0,
            "result": None,
            "log": [{"t": "round", "n": 1}],
        }

    def turn(self, state: dict[str, Any]) -> str | None:
        if state["phase"] == "playing":
            return state["to_act"]
        waiting = [seat for seat in SEATS if seat not in state["placed"]]
        return waiting[0] if len(waiting) == 1 else None

    def act(self, state: dict[str, Any], seat: str, action: dict[str, Any]) -> Step:
        kind = action.get("type")
        args = action.get("args") or {}
        if not isinstance(args, dict):
            raise InvalidAction("args must be an object")
        if kind == "resign":
            return Step(state, "finished", {"termination": "resign", "winner": _other(seat)})
        if kind == "abort":
            if state["round"] > 1:
                raise InvalidAction("The match is underway: resign instead")
            return Step(state, "aborted", {"reason": "aborted", "by": seat})
        if kind == "bet":
            return self._bet(state, seat, args.get("amount"))
        if kind not in ("hit", "stand", "double", "split"):
            raise InvalidAction(f"Unknown action {kind!r}")
        if state["phase"] != "playing":
            raise InvalidAction("The cards aren't dealt yet: bet first")
        if seat != state["to_act"]:
            raise NotYourTurn("It's not your turn")
        hands = list(state["hands"][seat])
        i = state["active"]
        hand, deck, stacks = hands[i], state["deck"], state["stacks"]
        if kind == "stand":
            hands[i] = {**hand, "done": True}
            event = {"t": "stand", "s": seat, "total": total(hand["cards"])[0]}
        elif kind == "split":
            if not self._can_split(state, seat):
                raise InvalidAction("Split needs two cards of one value, a first hand, and chips to match the bet")
            aces = hand["cards"][0][0] == "A"  # split aces take one card each
            hands = [
                {"cards": [card, extra], "bet": hand["bet"], "split": True, "done": aces or total([card, extra])[0] == 21}
                for card, extra in zip(hand["cards"], deck[:2], strict=True)
            ]
            deck = deck[2:]
            stacks = {**stacks, seat: stacks[seat] - hand["bet"]}
            event = {"t": "split", "s": seat}
        else:
            bet = hand["bet"]
            if kind == "double":
                if len(hand["cards"]) != 2 or stacks[seat] < bet:
                    raise InvalidAction("Double needs your first two cards and chips to match the bet")
                stacks = {**stacks, seat: stacks[seat] - bet}
                bet *= 2
            cards = [*hand["cards"], deck[0]]
            points = total(cards)[0]
            hands[i] = {**hand, "cards": cards, "bet": bet, "done": kind == "double" or points >= 21}
            deck = deck[1:]
            event = {"t": kind, "s": seat, "card": cards[-1], "total": points}
        return _next({
            **state,
            "hands": {**state["hands"], seat: hands},
            "deck": deck,
            "stacks": stacks,
            "log": _log(state, event),
        })

    @staticmethod
    def _bet(state: dict[str, Any], seat: str, amount: object) -> Step:
        if state["phase"] != "betting":
            raise InvalidAction("This round is being played: bet on the next")
        if seat in state["placed"]:
            raise InvalidAction("Your bet is in")
        most = _most(state["stacks"][seat])
        if not isinstance(amount, int) or isinstance(amount, bool):
            raise InvalidAction("Say how much in args.amount")
        if amount % MIN_BET or not MIN_BET <= amount <= most:
            raise InvalidAction(f"Bet {MIN_BET} to {most}, in tens")
        state = {
            **state,
            "bets": {**state["bets"], seat: amount},
            "placed": [*state["placed"], seat],
            "log": _log(state, {"t": "bet", "s": seat, "n": amount}),
        }
        return _deal(state) if len(state["placed"]) == len(SEATS) else Step(state)

    @staticmethod
    def _can_split(state: dict[str, Any], seat: str) -> bool:
        hands = state["hands"][seat]
        cards = hands[0]["cards"]
        return (
            len(hands) == 1
            and len(cards) == 2
            and _value(cards[0]) == _value(cards[1])
            and state["stacks"][seat] >= hands[0]["bet"]
        )

    def scene(
        self,
        state: dict[str, Any],
        status: WidgetStatus,
        outcome: dict[str, Any] | None,
        seat: str | None = None,
    ) -> dict[str, Any]:
        active = status == "active"
        # The other seat's hands at the top, the dealer between, the viewer's own at the bottom.
        top, bottom = (_other(seat), seat) if seat else (SEATS[1], SEATS[0])
        text, tone = _status(state, status, outcome, seat)
        rows = [
            *self._hands(state, top, seat, active),
            self._dealer(state, active),
            *self._hands(state, bottom, seat, active),
        ]
        return {
            "v": 1,
            "title": "Blackjack",
            "table": {"rows": rows},
            "seat_notes": {s: f"{state['stacks'][s]} chips" for s in SEATS},
            "turn": self.turn(state) if active else None,
            "input": {},
            "actions": {seat: self._actions(state, seat)} if active and seat else {},
            "status": {"text": text, "tone": tone},
            "log": [f"{_say(event, seat)}." for event in state["log"]],
        }

    @staticmethod
    def _hands(state: dict[str, Any], owner: str, viewer: str | None, active: bool) -> list[dict[str, Any]]:
        whose = "Your" if owner == viewer else "Their" if viewer else f"{owner.capitalize()}'s"
        hands = state["hands"].get(owner)
        if not hands:
            return [{"id": owner, "seat": owner, "label": f"{whose} cards", "cards": [None, None]}]
        nets = (state["result"] or {}).get(owner)
        rows = []
        for i, hand in enumerate(hands):
            text = _hand_text(hand["cards"], hand["split"])
            if nets is None:
                note = f"{text} · bet {hand['bet']}"
            else:
                net = nets[i]
                note = f"{text} · " + ("push" if not net else f"+{net}" if net > 0 else f"−{-net}")
            row = {
                "id": f"{owner}-{i}",
                "seat": owner,
                "label": f"{whose} cards" + (f", hand {i + 1}" if len(hands) > 1 else ""),
                "cards": hand["cards"],
                "note": note,
            }
            if active and state["phase"] == "playing" and state["to_act"] == owner and state["active"] == i:
                row["active"] = True
            rows.append(row)
        return rows

    @staticmethod
    def _dealer(state: dict[str, Any], active: bool) -> dict[str, Any]:
        dealer = state["dealer"]
        if not dealer:
            return {"id": "dealer", "label": "Dealer", "cards": [None, None]}
        if active and state["phase"] == "playing":
            return {
                "id": "dealer",
                "label": "Dealer",
                "cards": [dealer[0], "back"],
                "note": f"Dealer shows {card_text(dealer[0])}",
            }
        points = total(dealer)[0]
        note = (
            "Dealer blackjack" if _natural(dealer)
            else f"Dealer busts · {points}" if points > 21
            else f"Dealer {points}"
        )
        return {"id": "dealer", "label": "Dealer", "cards": dealer, "note": note}

    @classmethod
    def _actions(cls, state: dict[str, Any], seat: str) -> list[dict[str, Any]]:
        """A bet between rounds, or the seat's moves on its turn; resign always, abort in the first round."""
        actions: list[dict[str, Any]] = []
        if state["phase"] == "betting":
            if seat in state["placed"]:
                actions.append({"type": "bet", "label": f"Bet {state['bets'][seat]} placed", "disabled": True})
            else:
                most = _most(state["stacks"][seat])
                actions.append({
                    "type": "bet",
                    "label": "Bet",
                    "tone": "primary",
                    "amount": {
                        "arg": "amount",
                        "min": MIN_BET,
                        "max": most,
                        "step": MIN_BET,
                        "value": min(state["bets"][seat], most),
                    },
                })
        elif state["to_act"] == seat:
            hand = state["hands"][seat][state["active"]]
            actions += [{"type": "hit", "label": "Hit", "tone": "primary"}, {"type": "stand", "label": "Stand"}]
            if len(hand["cards"]) == 2 and state["stacks"][seat] >= hand["bet"]:
                actions.append({"type": "double", "label": f"Double to {2 * hand['bet']}"})
            if cls._can_split(state, seat):
                actions.append({"type": "split", "label": "Split"})
        actions.append(_RESIGN)
        if state["round"] == 1:
            actions.append(_ABORT)
        return actions


BLACKJACK = Blackjack()
