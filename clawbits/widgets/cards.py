"""Playing cards for card widgets: the deck, a fair shuffle, and how poker ranks a hand.

A card is two characters, rank then suit: ``"As"``, ``"Td"``, ``"7c"``. Ranks run ``23456789TJQKA``;
suits are clubs, diamonds, hearts and spades. A shuffle draws from the OS's random source, so nothing
on the server predicts a deal, and the shuffled deck lives only in a widget's state, which never
leaves the server.
"""
from __future__ import annotations

import random
from collections import Counter
from collections.abc import Sequence
from itertools import combinations

RANKS = "23456789TJQKA"
SUITS = "cdhs"
DECK = tuple(rank + suit for suit in SUITS for rank in RANKS)
_rng = random.SystemRandom()

_SUIT_TEXT = {"c": "♣", "d": "♦", "h": "♥", "s": "♠"}
_NAMES = {
    2: "two", 3: "three", 4: "four", 5: "five", 6: "six", 7: "seven", 8: "eight",
    9: "nine", 10: "ten", 11: "jack", 12: "queen", 13: "king", 14: "ace",
}
_PLURAL = {value: "sixes" if value == 6 else f"{name}s" for value, name in _NAMES.items()}

# The category first (0 high card … 8 straight flush), then the card values that break ties.
type HandRank = tuple[int, ...]


def shuffled_deck() -> list[str]:
    deck = list(DECK)
    _rng.shuffle(deck)
    return deck


def card_text(card: str) -> str:
    """``"Td"`` as ``"10♦"``, for text a person reads."""
    return ("10" if card[0] == "T" else card[0]) + _SUIT_TEXT[card[1]]


def _value(card: str) -> int:
    return RANKS.index(card[0]) + 2


def rank_five(cards: Sequence[str]) -> HandRank:
    """Five cards' poker rank; a higher rank wins and an equal one splits."""
    values = sorted((_value(card) for card in cards), reverse=True)
    flush = len({card[1] for card in cards}) == 1
    # Pairs and sets before single cards, the higher first: (2, 13), (2, 7), (1, 4) for kings and sevens.
    groups = sorted(Counter(values).items(), key=lambda group: (group[1], group[0]), reverse=True)
    counts = [count for _, count in groups]
    tops = [value for value, _ in groups]
    straight = None
    if len(groups) == 5:
        if values[0] - values[4] == 4:
            straight = values[0]
        elif values == [14, 5, 4, 3, 2]:
            straight = 5  # the wheel: the ace plays low
    if straight and flush:
        return (8, straight)
    if counts[0] == 4:
        return (7, *tops)
    if counts == [3, 2]:
        return (6, *tops)
    if flush:
        return (5, *values)
    if straight:
        return (4, straight)
    if counts[0] == 3:
        return (3, *tops)
    if counts[:2] == [2, 2]:
        return (2, *tops)
    if counts[0] == 2:
        return (1, *tops)
    return (0, *values)


def best_hand(cards: Sequence[str]) -> tuple[HandRank, tuple[str, ...]]:
    """The best five of five to seven ``cards``, and their rank."""
    return max(((rank_five(five), five) for five in combinations(cards, 5)), key=lambda pair: pair[0])


def describe(rank: HandRank) -> str:
    """A rank in words: ``(2, 13, 7, 4)`` is ``"two pair, kings and sevens"``."""
    category, top, *rest = rank
    match category:
        case 8:
            return "a royal flush" if top == 14 else f"a straight flush, {_NAMES[top]} high"
        case 7:
            return f"four {_PLURAL[top]}"
        case 6:
            return f"a full house, {_PLURAL[top]} over {_PLURAL[rest[0]]}"
        case 5:
            return f"a flush, {_NAMES[top]} high"
        case 4:
            return f"a straight, {_NAMES[top]} high"
        case 3:
            return f"three {_PLURAL[top]}"
        case 2:
            return f"two pair, {_PLURAL[top]} and {_PLURAL[rest[0]]}"
        case 1:
            return f"a pair of {_PLURAL[top]}"
        case _:
            return f"{_NAMES[top]} high"
