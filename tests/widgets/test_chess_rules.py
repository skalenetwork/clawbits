"""Chess rules: move generation pinned by perft, notation, and the drawn-by-material rule."""

import pytest

from clawbits.widgets.chess_rules import (
    START_FEN,
    IllegalMove,
    Move,
    Position,
    square,
)

KIWIPETE = "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1"


def perft(position: Position, depth: int) -> int:
    moves = position.legal_moves()
    if depth == 1:
        return len(moves)
    return sum(perft(position.push(m), depth - 1) for m in moves)


@pytest.mark.parametrize(
    ("fen", "counts"),
    [
        # Reference counts from the chessprogramming.org perft suite.
        (START_FEN, (20, 400, 8902)),
        (KIWIPETE, (48, 2039)),
        ("8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1", (14, 191, 2812)),
        ("r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1", (6, 264, 9467)),
        ("rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8", (44, 1486)),
        ("r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10", (46, 2079)),
    ],
)
def test_perft_matches_reference_counts(fen, counts):
    position = Position.from_fen(fen)
    for depth, expected in enumerate(counts, start=1):
        assert perft(position, depth) == expected, (fen, depth)


def test_fen_round_trips():
    for fen in (START_FEN, KIWIPETE):
        assert Position.from_fen(fen).fen() == fen


@pytest.mark.parametrize(
    "fen",
    [
        "8/8/8/8/8/8/8/8 w - - 0 1",  # no kings
        "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR x KQkq - 0 1",  # bad side to move
        "rnbqkbnr/pppppppp/9/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",  # rank overflow
        "Pnbqkbnr/pppppppp/8/8/8/8/1PPPPPPP/RNBQKBNR w KQkq - 0 1",  # pawn on the back rank
    ],
)
def test_bad_fen_is_rejected(fen):
    with pytest.raises(ValueError):
        Position.from_fen(fen)


def test_san_disambiguates_castles_promotes_and_marks_check():
    knights = Position.from_fen("4k3/8/8/8/8/8/8/1N2KN2 w - - 0 1")
    assert knights.san(Move(square("b1"), square("d2"))) == "Nbd2"
    rooks = Position.from_fen("4k3/8/8/R7/8/8/8/R3K3 w - - 0 1")
    assert rooks.san(Move(square("a1"), square("a3"))) == "R1a3"
    castle = Position.from_fen("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1")
    assert castle.san(Move(square("e1"), square("g1"))) == "O-O"
    assert castle.san(Move(square("e1"), square("c1"))) == "O-O-O"
    promote = Position.from_fen("7k/1P6/8/8/8/8/8/K7 w - - 0 1")
    assert promote.san(Move(square("b7"), square("b8"), "q")) == "b8=Q+"
    mate = Position.from_fen("6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1")
    assert mate.san(Move(square("a1"), square("a8"))) == "Ra8#"


def test_parse_move_accepts_uci_san_and_loose_san():
    position = Position.from_fen(START_FEN)
    assert position.parse_move("e2e4") == Move(square("e2"), square("e4"))
    assert position.parse_move("Nf3") == Move(square("g1"), square("f3"))
    castle = Position.from_fen("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1")
    assert castle.parse_move("0-0") == Move(square("e1"), square("g1"))
    promote = Position.from_fen("7k/1P6/8/8/8/8/8/K7 w - - 0 1")
    assert promote.parse_move("b8Q") == Move(square("b7"), square("b8"), "q")
    for bad in ("e5", "e2e5", "Nf4", "", "zz"):
        with pytest.raises(IllegalMove):
            position.parse_move(bad)


def test_en_passant_square_is_kept_only_when_a_capture_is_possible():
    lone = Position.from_fen(START_FEN).push(Move(square("e2"), square("e4")))
    assert lone.ep is None
    ready = Position.from_fen("4k3/8/8/8/3p4/8/4P3/4K3 w - - 0 1").push(
        Move(square("e2"), square("e4"))
    )
    assert ready.ep == square("e3")
    assert ready.parse_move("dxe3") == Move(square("d4"), square("e3"))


@pytest.mark.parametrize(
    ("fen", "insufficient"),
    [
        ("4k3/8/8/8/8/8/8/4K3 w - - 0 1", True),
        ("4k3/8/8/8/8/8/8/4KN2 w - - 0 1", True),
        ("4k3/8/8/8/8/8/8/4KB2 w - - 0 1", True),
        ("2b1k3/8/8/8/8/8/8/4KB2 w - - 0 1", True),  # bishops on the same colour
        ("3bk3/8/8/8/8/8/8/4KB2 w - - 0 1", False),  # opposite colours can still mate
        ("4k3/8/8/8/8/8/8/3NKN2 w - - 0 1", False),
        ("4k3/8/8/8/8/8/4P3/4K3 w - - 0 1", False),
    ],
)
def test_insufficient_material(fen, insufficient):
    assert Position.from_fen(fen).insufficient_material() is insufficient
