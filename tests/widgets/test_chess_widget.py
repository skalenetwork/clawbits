"""The chess widget kind: turns, endings, draw offers and the scene clients draw."""

import pytest

from clawbits.widgets import KINDS, InvalidAction, NotYourTurn, Step

CHESS = KINDS["chess"]
SEATS = ("white", "black")


def play(*moves: str, state: dict | None = None) -> Step:
    """Play SAN/UCI ``moves`` alternately from ``state`` (a new game by default)."""
    step = Step(state or CHESS.init())
    for move in moves:
        seat = CHESS.turn(step.state)
        step = CHESS.act(step.state, seat, {"type": "move", "args": {"move": move}})
    return step


def test_scholars_mate_finishes_with_white_winning():
    step = play("e4", "e5", "Bc4", "Nc6", "Qh5", "Nf6", "Qxf7#")
    assert step.status == "finished"
    assert step.outcome == {"result": "1-0", "termination": "checkmate", "winner": "white"}
    scene = CHESS.scene(step.state, step.status, step.outcome)
    assert scene["status"]["text"] == "Checkmate"
    assert {"at": "e8", "tone": "danger"} in scene["marks"]
    assert scene["turn"] is None and scene["input"] == {} and scene["actions"] == {}
    assert scene["log"] == ["1. e4", "e5", "2. Bc4", "Nc6", "3. Qh5", "Nf6", "4. Qxf7#"]


def test_only_the_seat_to_move_may_move():
    with pytest.raises(NotYourTurn):
        CHESS.act(CHESS.init(), "black", {"type": "move", "args": {"move": "e5"}})


def test_an_illegal_move_lists_the_legal_ones():
    with pytest.raises(InvalidAction, match="Legal moves: .*Nf3"):
        CHESS.act(CHESS.init(), "white", {"type": "move", "args": {"from": "e2", "to": "e5"}})
    with pytest.raises(InvalidAction, match="Malformed"):
        CHESS.act(CHESS.init(), "white", {"type": "move", "args": {"move": 42}})


def test_threefold_repetition_draws():
    step = play("Nf3", "Nf6", "Ng1", "Ng8", "Nf3", "Nf6", "Ng1")
    assert step.status == "active"
    step = play("Ng8", state=step.state)
    assert step.status == "finished"
    assert step.outcome == {"result": "1/2-1/2", "termination": "repetition", "winner": None}


def test_resign_awards_the_other_seat():
    step = CHESS.act(play("e4", "e5").state, "black", {"type": "resign"})
    assert step.outcome == {"result": "1-0", "termination": "resign", "winner": "white"}
    assert CHESS.scene(step.state, step.status, step.outcome)["status"]["text"] == (
        "Black resigned"
    )


def test_abort_only_before_both_sides_moved():
    step = CHESS.act(play("e4").state, "black", {"type": "abort"})
    assert step.status == "aborted" and step.outcome == {"reason": "aborted", "by": "black"}
    with pytest.raises(InvalidAction, match="resign instead"):
        CHESS.act(play("e4", "e5").state, "white", {"type": "abort"})


def test_draw_offer_accept_decline_and_lapse():
    started = play("e4", "e5").state
    offered = CHESS.act(started, "white", {"type": "offer_draw"}).state
    assert offered["draw_offer"] == "white"
    with pytest.raises(InvalidAction):
        CHESS.act(offered, "white", {"type": "accept_draw"})
    assert CHESS.act(offered, "black", {"type": "accept_draw"}).outcome == {
        "result": "1/2-1/2", "termination": "agreement", "winner": None,
    }
    assert CHESS.act(offered, "black", {"type": "decline_draw"}).state["draw_offer"] is None
    # The mover's own offer stands through their move; the opponent's move turns it down.
    after_white = play("Nf3", state=offered).state
    assert after_white["draw_offer"] == "white"
    assert play("Nf6", state=after_white).state["draw_offer"] is None
    # Offering back is accepting.
    assert CHESS.act(offered, "black", {"type": "offer_draw"}).outcome["termination"] == "agreement"
    actions = CHESS.scene(offered, "active", None)["actions"]
    assert [a["type"] for a in actions["black"]] == ["accept_draw", "decline_draw", "resign"]
    assert actions["white"][0] == {"type": "offer_draw", "label": "Draw offered", "disabled": True}
    assert [a["type"] for a in actions["white"]] == ["offer_draw", "resign"]


def test_resign_and_draw_are_there_from_the_first_move():
    actions = CHESS.scene(CHESS.init(), "active", None)["actions"]["white"]
    assert [a["type"] for a in actions] == ["offer_draw", "resign", "abort"]
    offered = CHESS.act(CHESS.init(), "white", {"type": "offer_draw"}).state
    assert offered["draw_offer"] == "white"
    assert CHESS.act(offered, "black", {"type": "accept_draw"}).outcome["termination"] == "agreement"
    assert CHESS.act(CHESS.init(), "black", {"type": "resign"}).outcome["winner"] == "white"


def test_scene_keeps_piece_ids_through_castling_and_promotion():
    step = play("e4", "d5", "exd5", "c6", "dxc6", "Nf6", "cxb7", "e6", "Nf3", "Be7", "Be2", "O-O")
    scene = CHESS.scene(step.state, step.status, step.outcome)
    tokens = {t["id"]: t for t in scene["tokens"]}
    assert tokens["Pe2"] == {"id": "Pe2", "sprite": "chess.wP", "at": "b7"}
    assert tokens["ke8"]["at"] == "g8" and tokens["rh8"]["at"] == "f8"
    choices = scene["input"]["white"]["choose"]["b7a8"]
    assert [c["value"] for c in choices] == ["q", "r", "b", "n"]
    promoted = CHESS.act(
        step.state, "white", {"type": "move", "args": {"from": "b7", "to": "a8", "choice": "q"}}
    )
    tokens = {t["id"]: t for t in CHESS.scene(promoted.state, "active", None)["tokens"]}
    assert tokens["Pe2"] == {"id": "Pe2", "sprite": "chess.wQ", "at": "a8"}
    assert "ra8" not in tokens


def test_scene_offers_the_seat_to_move_its_legal_targets():
    scene = CHESS.scene(CHESS.init(), "active", None)
    assert scene["turn"] == "white" and list(scene["input"]) == ["white"]
    pick = scene["input"]["white"]["pick"]
    assert sorted(pick["e2"]) == ["e3", "e4"] and sorted(pick["g1"]) == ["f3", "h3"]
    assert sum(len(targets) for targets in pick.values()) == 20
    assert scene["board"]["cols"] == list("abcdefgh") and scene["flip_for"] == "black"


def test_aborted_scene_explains_why():
    scene = CHESS.scene(CHESS.init(), "aborted", {"reason": "idle"})
    assert scene["status"] == {"text": "2 days without a move", "tone": "muted"}
