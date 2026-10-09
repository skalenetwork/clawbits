"""The ``battleship`` widget, played the notebook way.

Two 10×10 grids, A–J across and 1–10 down. Each fleet is ten straight ships (one of four cells, two
of three, three of two, four single cells) that never touch, not even at a corner. A hit earns
another shot, and a sunk ship rings itself with misses, as a pencil would. Fleets are secret, so
the kind is ``private``: a seat sees its own fleet, and anyone else only what both sides know.

Fleets start random. Until it is ready, a seat may shuffle its fleet or move a ship: ``move`` takes
the ship's first cell (its top or left end) and where that cell goes; moving it onto itself turns
the ship, about its middle where there is room, else about the cell nearest that which has it.
Either way the notebook rules hold.

State: ``{"phase": "setup" | "battle", "fleets": {seat: [[cell]]}, "ready": [seat],
"shots": {seat: [cell]}, "turn": seat, "last": {"by": seat, "at": cell} | None}``, where a seat's
shots are the ones it fired and each ship lists its cells from its first.
"""
from __future__ import annotations

import random
import re
from typing import Any

from clawbits.widgets.base import (
    ABORT_TEXT,
    InvalidAction,
    NotYourTurn,
    Step,
    WidgetStatus,
)

SEATS = ("red", "blue")
COLS = list("ABCDEFGHIJ")
ROWS = [str(n) for n in range(1, 11)]
FLEET = (4, 3, 3, 2, 2, 2, 1, 1, 1, 1)
_CELL = re.compile(r"([A-J])(10|[1-9])")
_rng = random.SystemRandom()
_ABORT = {"type": "abort", "label": "Abort", "confirm": "Abort this game?"}
_RESIGN = {"type": "resign", "label": "Resign", "confirm": "Resign this game?"}

type Cell = tuple[int, int]  # (column, row); row 0 is "1", at the top


def _name(cell: Cell) -> str:
    return COLS[cell[0]] + ROWS[cell[1]]


def _cell(name: str) -> Cell:
    match = _CELL.fullmatch(name)
    if match is None:
        raise ValueError(f"invalid cell {name!r}")
    return COLS.index(match[1]), int(match[2]) - 1


def _halo(cells: set[Cell]) -> set[Cell]:
    """Every cell on the grid touching ``cells``, corners included, that isn't one of them."""
    return {
        (x + dx, y + dy)
        for x, y in cells
        for dx in (-1, 0, 1)
        for dy in (-1, 0, 1)
        if 0 <= x + dx < 10 and 0 <= y + dy < 10
    } - cells


def random_fleet() -> list[list[str]]:
    """Ten ships placed at random by the notebook rules; starts over on the rare dead end."""
    while True:
        blocked: set[Cell] = set()
        ships: list[list[Cell]] = []
        for size in FLEET:
            options = [
                ship
                for x in range(10)
                for y in range(10)
                for ship in ([(x + i, y) for i in range(size)], [(x, y + i) for i in range(size)])
                if all(cx < 10 and cy < 10 and (cx, cy) not in blocked for cx, cy in ship)
            ]
            if not options:
                break
            ship = _rng.choice(options)
            ships.append(ship)
            blocked |= set(ship) | _halo(set(ship))
        else:
            return [[_name(cell) for cell in ship] for ship in ships]


def valid_fleet(fleet: list[list[str]]) -> bool:
    """The notebook rules: the right ships, each one straight and unbroken, none touching another."""
    try:
        ships = [[_cell(name) for name in ship] for ship in fleet]
    except (TypeError, ValueError):
        return False
    if sorted(len(ship) for ship in ships) != sorted(FLEET):
        return False
    blocked: set[Cell] = set()
    for ship in ships:
        xs, ys = sorted(x for x, _ in ship), sorted(y for _, y in ship)
        line = list(range(len(ship)))
        straight = (len(set(xs)) == 1 and [y - ys[0] for y in ys] == line) or (
            len(set(ys)) == 1 and [x - xs[0] for x in xs] == line
        )
        if not straight or set(ship) & blocked:
            return False
        blocked |= set(ship) | _halo(set(ship))
    return True


def _fits(cells: list[Cell], others: list[Cell]) -> bool:
    """``cells`` lie on the grid and clear of ``others`` and every cell touching them."""
    blocked = set(others) | _halo(set(others))
    return all(0 <= x < 10 and 0 <= y < 10 and (x, y) not in blocked for x, y in cells)


def _laid(start: Cell, size: int, across: bool) -> list[Cell]:
    x, y = start
    return [(x + k, y) if across else (x, y + k) for k in range(size)]


def _turned(cells: list[Cell], others: list[Cell]) -> list[Cell] | None:
    """``cells`` (a ship, from its first cell) turned about its middle cell where there is room, else
    about each cell out from there, reaching either way from it; None when it can't turn at all."""
    size = len(cells)
    if size == 1:
        return None
    across = len({y for _, y in cells}) == 1
    middle = (size - 1) / 2
    for pivot in sorted(range(size), key=lambda i: (abs(i - middle), i)):
        x, y = cells[pivot]
        for back in (pivot, size - 1 - pivot):
            laid = _laid((x, y - back) if across else (x - back, y), size, not across)
            if _fits(laid, others):
                return laid
    return None


def placements(fleet: list[list[str]]) -> dict[str, list[str]]:
    """Where each ship may go, by its first cell: the first cells it may move to, keeping its way, and
    its own first cell when it has room to turn."""
    ships = [[_cell(name) for name in ship] for ship in fleet]
    out: dict[str, list[str]] = {}
    for i, cells in enumerate(ships):
        start = min(cells)
        across = len({y for _, y in cells}) == 1
        others = [c for k, ship in enumerate(ships) if k != i for c in ship]
        targets = [
            (x, y)
            for y in range(10)
            for x in range(10)
            if (x, y) != start and _fits(_laid((x, y), len(cells), across), others)
        ]
        if _turned(sorted(cells), others):
            targets.append(start)
        out[_name(start)] = [_name(t) for t in targets]
    return out


def _moved(fleet: list[list[str]], frm: object, to: object) -> list[list[str]]:
    """``fleet`` with the ship that starts at ``frm`` moved to start at ``to``, or turned (``_turned``)
    when ``to`` is ``frm``."""
    if not (isinstance(frm, str) and isinstance(to, str) and _CELL.fullmatch(frm) and _CELL.fullmatch(to)):
        raise InvalidAction("Move a ship by its first cell to a cell from A1 to J10")
    ships = [[_cell(name) for name in ship] for ship in fleet]
    i = next((k for k, cells in enumerate(ships) if min(cells) == _cell(frm)), None)
    if i is None:
        raise InvalidAction(f"No ship starts at {frm}")
    cells = sorted(ships[i])
    others = [c for k, ship in enumerate(ships) if k != i for c in ship]
    if to == frm:
        if len(cells) == 1:
            raise InvalidAction("A one-cell ship has no way to turn")
        turned = _turned(cells, others)
        if turned is None:
            raise InvalidAction("No room to turn it: ships keep a cell apart")
        return [[_name(c) for c in turned] if k == i else ship for k, ship in enumerate(fleet)]
    laid = _laid(_cell(to), len(cells), len({y for _, y in cells}) == 1)
    if not _fits(laid, others):
        raise InvalidAction("No room there: ships keep a cell apart")
    return [[_name(c) for c in laid] if k == i else ship for k, ship in enumerate(fleet)]


def _other(seat: str) -> str:
    return SEATS[1 - SEATS.index(seat)]


def _sea(fleet: list[list[str]], shots: list[str]) -> tuple[set[str], set[str], list[int], set[str]]:
    """What ``shots`` revealed of ``fleet``: hits, misses, the sunk ships' indexes, and the cells
    their sinking proved empty."""
    fired = set(shots)
    hits = {cell for ship in fleet for cell in ship if cell in fired}
    sunk = [i for i, ship in enumerate(fleet) if all(cell in fired for cell in ship)]
    near = {_name(c) for i in sunk for c in _halo({_cell(n) for n in fleet[i]})} - fired
    return hits, fired - hits, sunk, near


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
            return (f"{loser} resigned" if resigned else f"{loser}'s fleet is sunk"), "info"
        if resigned:
            return ("Opponent resigned" if winner == seat else "You resigned"), "info"
        return ("The enemy fleet is sunk" if winner == seat else "Your fleet is sunk"), "info"
    if state["phase"] == "setup":
        if seat is None:
            return "Fleets are being placed", "neutral"
        if seat in state["ready"]:
            return "Waiting for the other fleet", "neutral"
        return "Place your fleet: move, turn or shuffle your ships, then Ready", "neutral"
    turn, last = state["turn"], state.get("last")
    if seat is None:
        return f"{turn.capitalize()} to shoot", "neutral"
    # The shooter keeps the turn only after a hit.
    if turn == seat:
        if last and last["by"] == seat:
            fleet = state["fleets"][_other(seat)]
            ship = next(ship for ship in fleet if last["at"] in ship)
            sunk = all(cell in state["shots"][seat] for cell in ship)
            return ("Sunk! Shoot again" if sunk else "Hit! Shoot again"), "info"
        return "Your shot", "neutral"
    if last and last["by"] == turn:
        return "You're hit · the opponent shoots again", "danger"
    return "Opponent's shot", "neutral"


class Battleship:
    seats = SEATS
    private = True

    def init(self) -> dict[str, Any]:
        return {
            "phase": "setup",
            "fleets": {seat: random_fleet() for seat in SEATS},
            "ready": [],
            "shots": {seat: [] for seat in SEATS},
            "turn": SEATS[0],
            "last": None,
        }

    def turn(self, state: dict[str, Any]) -> str | None:
        return state["turn"] if state["phase"] == "battle" else None

    def act(self, state: dict[str, Any], seat: str, action: dict[str, Any]) -> Step:
        kind = action.get("type")
        args = action.get("args") or {}
        if not isinstance(args, dict):
            raise InvalidAction("args must be an object")
        other = _other(seat)
        setup = state["phase"] == "setup"
        if kind in ("shuffle", "ready", "move"):
            if not setup:
                raise InvalidAction("The battle has started")
            if seat in state["ready"]:
                raise InvalidAction("Your fleet is already set")
            if kind == "shuffle":
                return Step({**state, "fleets": {**state["fleets"], seat: random_fleet()}})
            if kind == "move":
                fleet = _moved(state["fleets"][seat], args.get("from"), args.get("to"))
                return Step({**state, "fleets": {**state["fleets"], seat: fleet}})
            ready = [*state["ready"], seat]
            phase = "battle" if len(ready) == len(SEATS) else "setup"
            return Step({**state, "ready": ready, "phase": phase})
        if kind == "abort":
            if not setup:
                raise InvalidAction("The battle is on: resign instead")
            return Step(state, "aborted", {"reason": "aborted", "by": seat})
        if kind == "resign":
            if setup:
                raise InvalidAction("Abort instead: the battle hasn't started")
            return Step(state, "finished", {"termination": "resign", "winner": other})
        if kind == "fire":
            return self._fire(state, seat, args.get("at"))
        raise InvalidAction(f"Unknown action {kind!r}")

    @staticmethod
    def _fire(state: dict[str, Any], seat: str, at: object) -> Step:
        if state["phase"] != "battle":
            raise InvalidAction("Wait until both fleets are ready")
        if seat != state["turn"]:
            raise NotYourTurn("It's not your shot")
        if not isinstance(at, str) or not _CELL.fullmatch(at):
            raise InvalidAction("Fire at a cell from A1 to J10")
        other = _other(seat)
        fleet, shots = state["fleets"][other], state["shots"][seat]
        if at in shots or at in _sea(fleet, shots)[3]:
            raise InvalidAction(f"{at} is already marked")
        hit = any(at in ship for ship in fleet)
        fired = [*shots, at]
        next_state = {
            **state,
            "shots": {**state["shots"], seat: fired},
            "turn": seat if hit else other,
            "last": {"by": seat, "at": at},
        }
        if hit and all(cell in fired for ship in fleet for cell in ship):
            return Step(next_state, "finished", {"termination": "sunk", "winner": seat})
        return Step(next_state)

    def scene(
        self,
        state: dict[str, Any],
        status: WidgetStatus,
        outcome: dict[str, Any] | None,
        seat: str | None = None,
    ) -> dict[str, Any]:
        active = status == "active"
        owners = (seat, _other(seat)) if seat else SEATS
        my_shot = active and seat is not None and self.turn(state) == seat
        placing = active and seat is not None and state["phase"] == "setup" and seat not in state["ready"]
        text, tone = _status(state, status, outcome, seat)
        if my_shot:
            given = {seat: {"action": "fire", "board": _other(seat), "tap": self._targets(state, seat)}}
        elif placing:
            given = {seat: {"action": "move", "board": seat, "pick": placements(state["fleets"][seat])}}
        else:
            given = {}
        return {
            "v": 1,
            "title": "Battleship",
            "boards": [self._board(state, owner, seat, active) for owner in owners],
            "turn": self.turn(state) if active else None,
            "input": given,
            "actions": {seat: self._actions(state, seat)} if active and seat else {},
            "status": {"text": text, "tone": tone},
        }

    @staticmethod
    def _board(state: dict[str, Any], owner: str, viewer: str | None, active: bool) -> dict[str, Any]:
        fleet = state["fleets"][owner]
        hits, misses, sunk, near = _sea(fleet, state["shots"][_other(owner)])
        # A fleet stays hidden from everyone but its owner until its ships sink or the game ends.
        shown = range(len(fleet)) if viewer == owner or not active else sunk
        tokens = []
        for i in shown:
            cells = [_cell(name) for name in fleet[i]]
            xs, ys = [x for x, _ in cells], [y for _, y in cells]
            tokens.append({
                "id": f"{owner}-{i}",
                "sprite": "notebook.sunk" if i in sunk else "notebook.ship",
                "at": _name((min(xs), min(ys))),
                "span": [max(xs) - min(xs) + 1, max(ys) - min(ys) + 1],
            })
        last = state.get("last")
        marks = [{"at": last["at"], "tone": "last"}] if last and last["by"] != owner else []
        marks += [{"at": cell, "tone": "hit"} for cell in sorted(hits)]
        marks += [{"at": cell, "tone": "miss"} for cell in sorted(misses)]
        marks += [{"at": cell, "tone": "near"} for cell in sorted(near)]
        whose = "Your fleet" if viewer == owner else "Enemy waters" if viewer else f"{owner.capitalize()} fleet"
        return {
            "id": owner,
            # Whose fleet it is: their avatar shows beneath it, so it needs no title.
            "seat": owner,
            # Named for screen readers only: the ships and the shots say whose board it is.
            "label": f"{whose}, {len(fleet) - len(sunk)} afloat",
            "cols": COLS,
            "rows": ROWS,
            "style": "notebook",
            "origin": "top",
            "show_labels": True,
            "tokens": tokens,
            "marks": marks,
        }

    @staticmethod
    def _targets(state: dict[str, Any], seat: str) -> list[str]:
        shots = state["shots"][seat]
        known = set(shots) | _sea(state["fleets"][_other(seat)], shots)[3]
        return [col + row for row in ROWS for col in COLS if col + row not in known]

    @staticmethod
    def _actions(state: dict[str, Any], seat: str) -> list[dict[str, str]]:
        if state["phase"] == "battle":
            return [_RESIGN]
        if seat in state["ready"]:
            return [_ABORT]
        return [{"type": "shuffle", "label": "Shuffle"}, {"type": "ready", "label": "Ready"}, _ABORT]


BATTLESHIP = Battleship()
