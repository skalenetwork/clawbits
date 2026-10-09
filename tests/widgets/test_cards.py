"""Playing cards: the deck, the shuffle, and poker's hand ranking."""

from clawbits.widgets.cards import DECK, best_hand, card_text, describe, rank_five, shuffled_deck


def rank(cards: str) -> tuple[int, ...]:
    return rank_five(cards.split())


def test_categories_rank_in_order():
    hands = [
        "2c 5d 9h Js Kc",  # high card
        "Kc Kd 4h 7s 9c",  # pair
        "Kc Kd 4h 4s 9c",  # two pair
        "7c 7d 7h Ks 2c",  # three of a kind
        "5c 6d 7h 8s 9c",  # straight
        "2h 6h 9h Jh Kh",  # flush
        "7c 7d 7h Ks Kc",  # full house
        "9c 9d 9h 9s 2c",  # four of a kind
        "5d 6d 7d 8d 9d",  # straight flush
    ]
    ranks = [rank(hand) for hand in hands]
    assert [r[0] for r in ranks] == list(range(9)) and ranks == sorted(ranks)


def test_the_wheel_is_the_lowest_straight():
    assert rank("Ac 2d 3h 4s 5c") == (4, 5) < rank("2c 3d 4h 5s 6c")
    assert rank("Tc Jd Qh Ks Ac") == (4, 14)
    assert rank("Ah 2h 3h 4h 5h") == (8, 5)


def test_kickers_break_ties_and_suits_never_do():
    assert rank("Kc Kd Ah 7s 2c") > rank("Kh Ks Qh 7d 2d")
    assert rank("Kc Kd 7h 7s Ac") > rank("Kh Ks 7d 7c Qd")
    assert rank("2c 5d 9h Js Kc") == rank("2d 5h 9s Jc Kd")


def test_the_best_five_of_seven():
    best, five = best_hand("As Ks 7s 2s 9d 4s Kd".split())
    assert best[0] == 5 and set(five) == {"As", "Ks", "7s", "2s", "4s"}
    assert best_hand("Ac Ad Kc Kd Qc Qd 2h".split())[0] == (2, 14, 13, 12)


def test_hands_in_words():
    assert describe(rank("Kc Kd 7h 7s 2c")) == "two pair, kings and sevens"
    assert describe(rank("6c 6d 6h Ks Kc")) == "a full house, sixes over kings"
    assert describe(rank("Tc Jc Qc Kc Ac")) == "a royal flush"
    assert describe(rank("Ac Ad 7h 4s 2c")) == "a pair of aces"
    assert describe(rank("2c 5d 9h Js Kc")) == "king high"
    assert (card_text("Td"), card_text("As")) == ("10♦", "A♠")


def test_a_shuffle_is_a_whole_deck():
    assert len(set(DECK)) == 52
    assert sorted(shuffled_deck()) == sorted(DECK)
