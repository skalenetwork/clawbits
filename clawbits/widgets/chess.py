"""The ``chess`` widget: White and Black play one game from the standard start.

State is the move list and nothing derived: ``{"moves": [uci], "san": [san], "draw_offer": seat}``.
The position, the repetition count and every piece's identity are replayed from it on each read
(milliseconds at 200 plies), so the stored JSON can never disagree with itself. Piece identities
are what make the client animate a move instead of redrawing the board.
"""
from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass
from typing import Any

from clawbits.widgets.base import (
    ABORT_TEXT,
    InvalidAction,
    NotYourTurn,
    Step,
    WidgetStatus,
)
from clawbits.widgets.chess_rules import (
    FILES,
    START_FEN,
    IllegalMove,
    Move,
    Position,
    square,
    square_name,
)

SEATS = ("white", "black")
_ARG = re.compile(r"[A-Za-z0-9=+#\-]{1,12}")
_RANKS = [str(rank) for rank in range(1, 9)]


@dataclass(frozen=True, slots=True)
class _Replay:
    position: Position
    seen: Counter[str]
    tokens: dict[int, str]
    last: Move | None


def _replay(moves: list[str]) -> _Replay:
    position = Position.from_fen(START_FEN)
    seen = Counter({position.key(): 1})
    tokens = {sq: piece + square_name(sq) for sq, piece in enumerate(position.board) if piece}
    last = None
    for uci in moves:
        last = Move(square(uci[:2]), square(uci[2:4]), uci[4:])
        tokens = _carry_tokens(position, last, tokens)
        position = position.push(last)
        seen[position.key()] += 1
    return _Replay(position, seen, tokens, last)


def _carry_tokens(position: Position, move: Move, tokens: dict[int, str]) -> dict[int, str]:
    """Token ids after ``move``: a piece keeps its id wherever it goes, promoted or not."""
    tokens = dict(tokens)
    kind = position.board[move.src].lower()
    if kind == "p" and move.dst == position.ep and not position.board[move.dst]:
        tokens.pop(move.dst - 8 if position.turn == "w" else move.dst + 8, None)
    if kind == "k" and abs(move.dst - move.src) == 2:
        rook_src, rook_dst = (
            (move.src + 3, move.src + 1) if move.dst > move.src else (move.src - 4, move.src - 1)
        )
        tokens[rook_dst] = tokens.pop(rook_src)
    tokens.pop(move.dst, None)
    tokens[move.dst] = tokens.pop(move.src)
    return tokens


def _sprite(piece: str) -> str:
    return f"chess.{'w' if piece.isupper() else 'b'}{piece.upper()}"


def _other(seat: str) -> str:
    return SEATS[1 - SEATS.index(seat)]


def _win(seat: str, termination: str) -> dict[str, Any]:
    return {"result": "1-0" if seat == "white" else "0-1", "termination": termination, "winner": seat}


def _draw(termination: str) -> dict[str, Any]:
    return {"result": "1/2-1/2", "termination": termination, "winner": None}


def _ending(after: Position, repetitions: int, mover: str) -> dict[str, Any] | None:
    if not after.legal_moves():
        return _win(mover, "checkmate") if after.in_check() else _draw("stalemate")
    if after.insufficient_material():
        return _draw("insufficient")
    if after.halfmove >= 100:
        return _draw("fifty")
    if repetitions >= 3:
        return _draw("repetition")
    return None


_DRAW_TEXT = {
    "stalemate": "Stalemate",
    "insufficient": "Insufficient material",
    "fifty": "Fifty moves without a capture or pawn move",
    "repetition": "Threefold repetition",
    "agreement": "By agreement",
}


def _status_text(
    state: dict[str, Any], position: Position, status: WidgetStatus, outcome: dict[str, Any] | None
) -> tuple[str, str]:
    if status == "aborted":
        return ABORT_TEXT.get((outcome or {}).get("reason", "aborted"), ABORT_TEXT["aborted"]), "muted"
    if status == "finished" and outcome:
        # The reason alone: clients show who won, with a cup.
        winner = outcome.get("winner")
        if outcome["termination"] == "checkmate":
            return "Checkmate", "info"
        if outcome["termination"] == "resign":
            return f"{_other(winner).capitalize()} resigned", "info"
        return _DRAW_TEXT.get(outcome["termination"], "Draw"), "info"
    mover = SEATS[len(state["moves"]) % 2].capitalize()
    if offer := state.get("draw_offer"):
        return f"{offer.capitalize()} offers a draw · {mover} to move", "neutral"
    if position.in_check():
        return f"Check · {mover} to move", "danger"
    return f"{mover} to move", "neutral"


class Chess:
    seats = SEATS
    private = False

    def init(self) -> dict[str, Any]:
        return {"moves": [], "san": [], "draw_offer": None}

    def turn(self, state: dict[str, Any]) -> str | None:
        return SEATS[len(state["moves"]) % 2]

    def act(self, state: dict[str, Any], seat: str, action: dict[str, Any]) -> Step:
        kind = action.get("type")
        args = action.get("args") or {}
        if not isinstance(args, dict):
            raise InvalidAction("args must be an object")
        moves: list[str] = state["moves"]
        offer = state.get("draw_offer")
        other = _other(seat)
        if kind == "move":
            if seat != self.turn(state):
                raise NotYourTurn("It's not your move")
            replay = _replay(moves)
            legal = replay.position.legal_moves()
            move = self._parse(replay.position, args, legal)
            after = replay.position.push(move)
            return self._after_move(state, seat, move, replay.position.san(move, legal), after, replay.seen)
        if kind == "resign":
            return Step(state, "finished", _win(other, "resign"))
        if kind == "offer_draw":
            if offer == other:
                return Step({**state, "draw_offer": None}, "finished", _draw("agreement"))
            if offer == seat:
                raise InvalidAction("You already offered a draw")
            return Step({**state, "draw_offer": seat})
        if kind in ("accept_draw", "decline_draw"):
            if offer != other:
                raise InvalidAction("There is no draw offer to answer")
            if kind == "accept_draw":
                return Step({**state, "draw_offer": None}, "finished", _draw("agreement"))
            return Step({**state, "draw_offer": None})
        if kind == "abort":
            if len(moves) >= 2:
                raise InvalidAction("The game is underway: resign instead")
            return Step(state, "aborted", {"reason": "aborted", "by": seat})
        raise InvalidAction(f"Unknown action {kind!r}")

    @staticmethod
    def _parse(position: Position, args: dict[str, Any], legal: list[Move]) -> Move:
        """``{from, to, choice}`` from the board, or ``{move}`` as SAN or UCI."""
        if "from" in args or "to" in args:
            parts = [args.get("from"), args.get("to"), args.get("choice") or ""]
        else:
            parts = [args.get("move")]
        if not all(isinstance(p, str) and (p == "" or _ARG.fullmatch(p)) for p in parts):
            raise InvalidAction("Malformed move")
        try:
            return position.parse_move("".join(parts), legal)
        except IllegalMove as e:
            options = ", ".join(sorted(position.san(m, legal) for m in legal))
            raise InvalidAction(f"{e}. Legal moves: {options}") from e

    @staticmethod
    def _after_move(
        state: dict[str, Any], seat: str, move: Move, san: str, after: Position, seen: Counter[str]
    ) -> Step:
        offer = state.get("draw_offer")
        next_state = {
            "moves": [*state["moves"], move.uci()],
            "san": [*state["san"], san],
            # A move answers the opponent's offer with a no; the mover's own offer stands.
            "draw_offer": offer if offer == seat else None,
        }
        outcome = _ending(after, seen[after.key()] + 1, seat)
        return Step(next_state, "finished" if outcome else "active", outcome)

    def scene(
        self,
        state: dict[str, Any],
        status: WidgetStatus,
        outcome: dict[str, Any] | None,
        seat: str | None = None,
    ) -> dict[str, Any]:
        replay = _replay(state["moves"])
        position = replay.position
        active = status == "active"
        marks: list[dict[str, str]] = []
        if replay.last is not None:
            marks += [
                {"at": square_name(replay.last.src), "tone": "last"},
                {"at": square_name(replay.last.dst), "tone": "last"},
            ]
        if (active or (outcome or {}).get("termination") == "checkmate") and position.in_check():
            marks.append({"at": square_name(position.king(position.turn)), "tone": "danger"})
        text, tone = _status_text(state, position, status, outcome)
        turn = self.turn(state) if active else None
        return {
            "v": 1,
            "title": "Chess",
            "board": {"cols": list(FILES), "rows": _RANKS, "pattern": "checker", "show_labels": True},
            "tokens": [
                {"id": token, "sprite": _sprite(position.board[sq]), "at": square_name(sq)}
                for sq, token in sorted(replay.tokens.items(), key=lambda item: item[1])
            ],
            "marks": marks,
            "turn": turn,
            "flip_for": "black",
            "input": {turn: self._input(position)} if turn else {},
            "actions": {seat: self._actions(state, seat) for seat in SEATS} if active else {},
            "status": {"text": text, "tone": tone},
            "log": [f"{i // 2 + 1}. {san}" if i % 2 == 0 else san for i, san in enumerate(state["san"])],
        }

    @staticmethod
    def _input(position: Position) -> dict[str, Any]:
        pick: dict[str, list[str]] = {}
        choose: dict[str, list[dict[str, str]]] = {}
        for move in position.legal_moves():
            src, dst = square_name(move.src), square_name(move.dst)
            targets = pick.setdefault(src, [])
            if dst not in targets:
                targets.append(dst)
            if move.promotion:
                piece = move.promotion.upper() if position.turn == "w" else move.promotion
                choose.setdefault(src + dst, []).append({"value": move.promotion, "sprite": _sprite(piece)})
        return {"action": "move", "pick": pick, "choose": choose}

    @staticmethod
    def _actions(state: dict[str, Any], seat: str) -> list[dict[str, Any]]:
        """Every seat can always offer or answer a draw and resign; abort only before both have moved."""
        offer = state.get("draw_offer")
        if offer == _other(seat):
            actions = [
                {"type": "accept_draw", "label": "Accept draw", "tone": "primary"},
                {"type": "decline_draw", "label": "Decline"},
            ]
        elif offer == seat:
            actions = [{"type": "offer_draw", "label": "Draw offered", "disabled": True}]
        else:
            actions = [{"type": "offer_draw", "label": "Offer draw"}]
        actions.append({"type": "resign", "label": "Resign", "tone": "danger", "confirm": "Resign this game?"})
        if len(state["moves"]) < 2:
            actions.append({"type": "abort", "label": "Abort", "confirm": "Abort this game?"})
        return actions


CHESS = Chess()
