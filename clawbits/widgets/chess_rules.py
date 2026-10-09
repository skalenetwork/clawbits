"""Chess rules: positions, legal moves, SAN and game endings. No search, no engine.

Written here rather than taken from ``python-chess``, which is GPL-3.0 while this repository is MIT
and ships in published images. Squares are 0..63 with a1 = 0 and h8 = 63; a position is immutable,
and :meth:`Position.push` returns the next one. Correctness is pinned by perft counts in the tests.
"""
from __future__ import annotations

import re
from collections.abc import Iterator
from dataclasses import dataclass

START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
FILES = "abcdefgh"
PROMOTIONS = "qrbn"

_KNIGHT = ((1, 2), (2, 1), (2, -1), (1, -2), (-1, -2), (-2, -1), (-2, 1), (-1, 2))
_KING = ((1, 0), (1, 1), (0, 1), (-1, 1), (-1, 0), (-1, -1), (0, -1), (1, -1))
_DIAGONAL = ((1, 1), (1, -1), (-1, 1), (-1, -1))
_STRAIGHT = ((1, 0), (-1, 0), (0, 1), (0, -1))
_SLIDES = {"b": _DIAGONAL, "r": _STRAIGHT, "q": _DIAGONAL + _STRAIGHT}
_UCI = re.compile(r"[a-h][1-8][a-h][1-8][qrbn]?")
# The castling rights a square's original occupant guards: a move from or onto it drops them.
_RIGHTS_AT = {0: "Q", 4: "KQ", 7: "K", 56: "q", 60: "kq", 63: "k"}


class IllegalMove(ValueError):
    """The move is malformed, ambiguous or not legal in the position."""


def square(name: str) -> int:
    if len(name) != 2 or name[0] not in FILES or name[1] not in "12345678":
        raise ValueError(f"invalid square {name!r}")
    return FILES.index(name[0]) + 8 * (int(name[1]) - 1)


def square_name(sq: int) -> str:
    return FILES[sq % 8] + str(sq // 8 + 1)


def _white(piece: str) -> bool:
    return piece.isupper()


@dataclass(frozen=True, slots=True)
class Move:
    src: int
    dst: int
    promotion: str = ""  # "q", "r", "b" or "n" on a promoting pawn move

    def uci(self) -> str:
        return square_name(self.src) + square_name(self.dst) + self.promotion


@dataclass(frozen=True, slots=True)
class Position:
    board: tuple[str, ...]  # 64 squares, a1 first; "" when empty
    turn: str  # "w" | "b"
    castling: str  # subset of "KQkq"
    ep: int | None  # en passant target, kept only when an enemy pawn stands ready to take
    halfmove: int
    fullmove: int

    @classmethod
    def from_fen(cls, fen: str) -> Position:
        try:
            placement, turn, castling, ep, halfmove, fullmove = fen.split()
            ranks = placement.split("/")
            if len(ranks) != 8 or turn not in ("w", "b"):
                raise ValueError
            board = [""] * 64
            for rank, row in enumerate(reversed(ranks)):
                file = 0
                for ch in row:
                    if ch in "12345678":
                        file += int(ch)
                    elif ch in "PNBRQKpnbrqk" and file < 8:
                        board[rank * 8 + file] = ch
                        file += 1
                    else:
                        raise ValueError
                if file != 8:
                    raise ValueError
            if board.count("K") != 1 or board.count("k") != 1:
                raise ValueError
            if any(board[sq] in ("P", "p") for sq in (*range(8), *range(56, 64))):
                raise ValueError
            if not re.fullmatch(r"-|K?Q?k?q?", castling):
                raise ValueError
            return cls(
                board=tuple(board),
                turn=turn,
                castling="" if castling == "-" else castling,
                ep=None if ep == "-" else square(ep),
                halfmove=int(halfmove),
                fullmove=int(fullmove),
            )
        except ValueError as e:
            raise ValueError(f"invalid FEN {fen!r}") from e

    def fen(self) -> str:
        rows = []
        for rank in range(7, -1, -1):
            row, empty = "", 0
            for file in range(8):
                piece = self.board[rank * 8 + file]
                if piece:
                    row += (str(empty) if empty else "") + piece
                    empty = 0
                else:
                    empty += 1
            rows.append(row + (str(empty) if empty else ""))
        ep = square_name(self.ep) if self.ep is not None else "-"
        return f"{'/'.join(rows)} {self.turn} {self.castling or '-'} {ep} {self.halfmove} {self.fullmove}"

    def key(self) -> str:
        """What repetition compares: placement, side to move, castling rights and en passant."""
        return self.fen().rsplit(" ", 2)[0]

    def king(self, color: str) -> int:
        return self.board.index("K" if color == "w" else "k")

    def attacked(self, sq: int, by: str) -> bool:
        """Whether a piece of colour ``by`` attacks ``sq``."""
        file, rank = sq % 8, sq // 8
        white = by == "w"
        pawn_rank = rank - 1 if white else rank + 1
        if 0 <= pawn_rank < 8:
            pawn = "P" if white else "p"
            for df in (-1, 1):
                if 0 <= file + df < 8 and self.board[pawn_rank * 8 + file + df] == pawn:
                    return True
        for steps, piece in ((_KNIGHT, "N"), (_KING, "K")):
            piece = piece if white else piece.lower()
            for df, dr in steps:
                f, r = file + df, rank + dr
                if 0 <= f < 8 and 0 <= r < 8 and self.board[r * 8 + f] == piece:
                    return True
        for directions, sliders in ((_DIAGONAL, "BQ"), (_STRAIGHT, "RQ")):
            sliders = sliders if white else sliders.lower()
            for df, dr in directions:
                f, r = file + df, rank + dr
                while 0 <= f < 8 and 0 <= r < 8:
                    piece = self.board[r * 8 + f]
                    if piece:
                        if piece in sliders:
                            return True
                        break
                    f, r = f + df, r + dr
        return False

    def in_check(self) -> bool:
        return self.attacked(self.king(self.turn), "b" if self.turn == "w" else "w")

    def _pseudo_moves(self) -> Iterator[Move]:
        white = self.turn == "w"
        for sq, piece in enumerate(self.board):
            if not piece or _white(piece) != white:
                continue
            kind = piece.lower()
            file, rank = sq % 8, sq // 8
            if kind == "p":
                yield from self._pawn_moves(sq, file, rank, white)
                continue
            if kind in ("n", "k"):
                for df, dr in _KNIGHT if kind == "n" else _KING:
                    f, r = file + df, rank + dr
                    if 0 <= f < 8 and 0 <= r < 8:
                        target = self.board[r * 8 + f]
                        if not target or _white(target) != white:
                            yield Move(sq, r * 8 + f)
                continue
            for df, dr in _SLIDES[kind]:
                f, r = file + df, rank + dr
                while 0 <= f < 8 and 0 <= r < 8:
                    target = self.board[r * 8 + f]
                    if target and _white(target) == white:
                        break
                    yield Move(sq, r * 8 + f)
                    if target:
                        break
                    f, r = f + df, r + dr
        yield from self._castling_moves(white)

    def _pawn_moves(self, sq: int, file: int, rank: int, white: bool) -> Iterator[Move]:
        step = 8 if white else -8
        last_rank = 7 if white else 0

        def to(dst: int) -> Iterator[Move]:
            if dst // 8 == last_rank:
                for promotion in PROMOTIONS:
                    yield Move(sq, dst, promotion)
            else:
                yield Move(sq, dst)

        one = sq + step
        if not self.board[one]:
            yield from to(one)
            if rank == (1 if white else 6) and not self.board[one + step]:
                yield Move(sq, one + step)
        for df in (-1, 1):
            if 0 <= file + df < 8:
                dst = one + df
                target = self.board[dst]
                if (target and _white(target) != white) or dst == self.ep:
                    yield from to(dst)

    def _castling_moves(self, white: bool) -> Iterator[Move]:
        home, king, rook, short, long = (
            (4, "K", "R", "K", "Q") if white else (60, "k", "r", "k", "q")
        )
        enemy = "b" if white else "w"
        board = self.board
        if board[home] != king or not (short in self.castling or long in self.castling):
            return
        if self.attacked(home, enemy):
            return
        if (
            short in self.castling
            and board[home + 3] == rook
            and not board[home + 1]
            and not board[home + 2]
            and not self.attacked(home + 1, enemy)
            and not self.attacked(home + 2, enemy)
        ):
            yield Move(home, home + 2)
        if (
            long in self.castling
            and board[home - 4] == rook
            and not board[home - 1]
            and not board[home - 2]
            and not board[home - 3]
            and not self.attacked(home - 1, enemy)
            and not self.attacked(home - 2, enemy)
        ):
            yield Move(home, home - 2)

    def legal_moves(self) -> list[Move]:
        enemy = "b" if self.turn == "w" else "w"
        legal = []
        for move in self._pseudo_moves():
            after = self.push(move)
            if not after.attacked(after.king(self.turn), enemy):
                legal.append(move)
        return legal

    def push(self, move: Move) -> Position:
        """The position after ``move``, which must be pseudo-legal here: it is not re-checked."""
        white = self.turn == "w"
        board = list(self.board)
        piece = board[move.src]
        kind = piece.lower()
        captured = board[move.dst]
        board[move.src] = ""
        if kind == "p" and move.dst == self.ep and not captured:
            captured = board[move.dst - 8 if white else move.dst + 8]
            board[move.dst - 8 if white else move.dst + 8] = ""
        if kind == "k" and abs(move.dst - move.src) == 2:
            rook_src, rook_dst = (
                (move.src + 3, move.src + 1) if move.dst > move.src else (move.src - 4, move.src - 1)
            )
            board[rook_dst], board[rook_src] = board[rook_src], ""
        if move.promotion:
            piece = move.promotion.upper() if white else move.promotion
        board[move.dst] = piece
        dropped = _RIGHTS_AT.get(move.src, "") + _RIGHTS_AT.get(move.dst, "")
        ep = None
        if kind == "p" and abs(move.dst - move.src) == 16:
            file, enemy_pawn = move.dst % 8, "p" if white else "P"
            if any(0 <= file + df < 8 and board[move.dst + df] == enemy_pawn for df in (-1, 1)):
                ep = (move.src + move.dst) // 2
        return Position(
            board=tuple(board),
            turn="b" if white else "w",
            castling="".join(c for c in self.castling if c not in dropped),
            ep=ep,
            halfmove=0 if kind == "p" or captured else self.halfmove + 1,
            fullmove=self.fullmove + (0 if white else 1),
        )

    def _san_body(self, move: Move, legal: list[Move]) -> str:
        piece = self.board[move.src].upper()
        if piece == "K" and abs(move.dst - move.src) == 2:
            return "O-O" if move.dst > move.src else "O-O-O"
        capture = bool(self.board[move.dst]) or (piece == "P" and move.dst == self.ep)
        if piece == "P":
            text = (FILES[move.src % 8] + "x" if capture else "") + square_name(move.dst)
            return text + ("=" + move.promotion.upper() if move.promotion else "")
        rivals = [
            m.src for m in legal
            if m.dst == move.dst and m.src != move.src and self.board[m.src] == self.board[move.src]
        ]
        hint = ""
        if rivals:
            if all(r % 8 != move.src % 8 for r in rivals):
                hint = FILES[move.src % 8]
            elif all(r // 8 != move.src // 8 for r in rivals):
                hint = str(move.src // 8 + 1)
            else:
                hint = square_name(move.src)
        return piece + hint + ("x" if capture else "") + square_name(move.dst)

    def san(self, move: Move, legal: list[Move] | None = None) -> str:
        """Standard algebraic notation for a legal ``move``, with ``+`` or ``#``."""
        text = self._san_body(move, self.legal_moves() if legal is None else legal)
        after = self.push(move)
        if after.in_check():
            text += "+" if after.legal_moves() else "#"
        return text

    def parse_move(self, text: str, legal: list[Move] | None = None) -> Move:
        """A legal move from UCI (``e2e4``, ``e7e8q``) or SAN (``Nf3``, ``exd5``, ``O-O``, ``e8=Q+``)."""
        legal = self.legal_moves() if legal is None else legal
        raw = text.strip()
        if _UCI.fullmatch(raw):
            found = next((m for m in legal if m.uci() == raw), None)
        else:
            wanted = _normalize_san(raw)
            found = next((m for m in legal if _normalize_san(self._san_body(m, legal)) == wanted), None)
        if found is None:
            raise IllegalMove(f"{text!r} is not a legal move here")
        return found

    def insufficient_material(self) -> bool:
        """Neither side can ever mate: bare kings, one minor piece, or only same-coloured bishops."""
        others = [(sq, p.lower()) for sq, p in enumerate(self.board) if p and p.lower() != "k"]
        if len(others) <= 1:
            return all(kind in ("n", "b") for _, kind in others)
        return all(kind == "b" for _, kind in others) and len(
            {(sq % 8 + sq // 8) % 2 for sq, _ in others}
        ) == 1


def _normalize_san(text: str) -> str:
    """Lenient SAN: no check, capture, promotion ``=`` or annotation marks, and ``0-0`` as ``O-O``."""
    return re.sub(r"[+#!?x=]", "", text.strip().replace("0", "O"))
