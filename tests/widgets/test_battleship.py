"""The battleship widget, notebook rules: placement, shots, the sunk-ship ring, and secret fleets."""

import pytest

from clawbits.widgets import KINDS, InvalidAction, NotYourTurn, Step
from clawbits.widgets.battleship import placements, random_fleet, valid_fleet

BS = KINDS["battleship"]
FLEET = [
    ["A1", "B1", "C1", "D1"], ["F1", "G1", "H1"], ["A3", "B3", "C3"],
    ["E3", "F3"], ["H3", "I3"], ["A5", "A6"],
    ["D5"], ["F5"], ["H5"], ["J5"],
]


def battle() -> dict:
    """Both fleets set to ``FLEET`` and ready; Red shoots first."""
    return BS.init() | {"phase": "battle", "ready": ["red", "blue"], "fleets": {"red": FLEET, "blue": FLEET}}


def fire(state: dict, seat: str, at: str) -> Step:
    return BS.act(state, seat, {"type": "fire", "args": {"at": at}})


def test_random_fleets_follow_the_notebook_rules():
    assert valid_fleet(FLEET)
    for _ in range(200):
        assert valid_fleet(random_fleet())


@pytest.mark.parametrize(
    "fleet",
    [
        [*FLEET[:6], ["E2"], *FLEET[7:]],  # touches D1 at a corner
        [["A8", "B8", "B9", "C9"], *FLEET[1:]],  # bent
        FLEET[:-1],  # a ship short
        [["A1", "A1"], *FLEET[1:]],  # not a ship at all
        [["K1"], *FLEET[1:]],  # off the grid
    ],
)
def test_bad_fleets_are_rejected(fleet):
    assert not valid_fleet(fleet)


def test_setup_lets_each_seat_shuffle_until_ready():
    state = BS.init()
    assert BS.turn(state) is None
    shuffled = BS.act(state, "red", {"type": "shuffle"}).state
    assert shuffled["fleets"]["blue"] == state["fleets"]["blue"]
    assert valid_fleet(shuffled["fleets"]["red"])
    red_ready = BS.act(state, "red", {"type": "ready"}).state
    with pytest.raises(InvalidAction):
        BS.act(red_ready, "red", {"type": "shuffle"})
    with pytest.raises(InvalidAction, match="both fleets"):
        fire(red_ready, "red", "A1")
    both = BS.act(red_ready, "blue", {"type": "ready"}).state
    assert both["phase"] == "battle" and BS.turn(both) == "red"
    with pytest.raises(InvalidAction, match="resign instead"):
        BS.act(both, "blue", {"type": "abort"})


def test_a_miss_passes_the_turn_and_a_hit_keeps_it():
    step = fire(battle(), "red", "J10")
    assert step.state["turn"] == "blue"
    with pytest.raises(NotYourTurn):
        fire(step.state, "red", "A1")
    step = fire(step.state, "blue", "A1")
    assert step.state["turn"] == "blue"
    with pytest.raises(InvalidAction, match="already marked"):
        fire(step.state, "blue", "A1")
    with pytest.raises(InvalidAction, match="A1 to J10"):
        fire(step.state, "blue", "K11")


def test_a_sunk_ship_rings_itself_and_the_last_one_wins():
    step = fire(battle(), "red", "D5")
    assert step.state["turn"] == "red"
    with pytest.raises(InvalidAction, match="already marked"):
        fire(step.state, "red", "E6")
    scene = BS.scene(step.state, step.status, step.outcome, "red")
    assert scene["status"]["text"] == "Sunk! Shoot again"
    enemy = scene["boards"][1]
    assert enemy["tokens"] == [{"id": "blue-6", "sprite": "notebook.sunk", "at": "D5", "span": [1, 1]}]
    assert {m["at"] for m in enemy["marks"] if m["tone"] == "near"} == {
        "C4", "D4", "E4", "C5", "E5", "C6", "D6", "E6",
    }
    assert "E6" not in scene["input"]["red"]["tap"] and "J10" in scene["input"]["red"]["tap"]

    state = battle()
    for cell in (cell for ship in FLEET for cell in ship):
        step = fire(state, "red", cell)
        state = step.state
    assert step.status == "finished" and step.outcome == {"termination": "sunk", "winner": "red"}
    assert BS.scene(state, "finished", step.outcome, "blue")["status"]["text"] == "Your fleet is sunk"
    # The reason alone, as each viewer reads it: clients show who won.
    assert BS.scene(state, "finished", step.outcome, "red")["status"]["text"] == "The enemy fleet is sunk"
    assert BS.scene(state, "finished", step.outcome)["status"]["text"] == "Blue's fleet is sunk"


def test_each_seat_sees_only_its_own_fleet():
    state = BS.init()
    red = BS.scene(state, "active", None, "red")
    own, enemy = red["boards"]
    assert (own["id"], enemy["id"]) == ("red", "blue")
    assert (own["seat"], enemy["seat"]) == ("red", "blue")
    assert len(own["tokens"]) == 10 and enemy["tokens"] == []
    assert (red["input"]["red"]["action"], red["input"]["red"]["board"]) == ("move", "red")
    assert list(red["actions"]) == ["red"]
    assert "title" not in own and own["label"] == "Your fleet, 10 afloat"
    assert [a["type"] for a in red["actions"]["red"]] == ["shuffle", "ready", "abort"]
    public = BS.scene(state, "active", None)
    assert [b["tokens"] for b in public["boards"]] == [[], []] and public["actions"] == {}
    finished = BS.scene(state, "finished", {"termination": "resign", "winner": "blue"})
    assert all(len(b["tokens"]) == 10 for b in finished["boards"])


def test_ships_span_their_cells_and_the_shooter_gets_targets():
    red = BS.scene(battle(), "active", None, "red")
    spans = {t["at"]: t["span"] for t in red["boards"][0]["tokens"]}
    assert spans["A1"] == [4, 1] and spans["A5"] == [1, 2] and spans["D5"] == [1, 1]
    assert red["input"]["red"]["board"] == "blue" and len(red["input"]["red"]["tap"]) == 100
    assert BS.scene(battle(), "active", None, "blue")["input"] == {}


def test_ships_move_by_their_first_cell_and_turn_where_they_fit():
    state = BS.init() | {"fleets": {"red": FLEET, "blue": FLEET}}
    picks = BS.scene(state, "active", None, "red")["input"]["red"]["pick"]
    assert set(picks) == {ship[0] for ship in FLEET}
    assert "E8" in picks["E3"] and "A7" not in picks["A1"]  # A7 would touch the ship at A6
    state = BS.act(state, "red", {"type": "move", "args": {"from": "E3", "to": "E8"}}).state
    assert state["fleets"]["red"][3] == ["E8", "F8"] and state["fleets"]["blue"] == FLEET
    assert "E8" in placements(state["fleets"]["red"])["E8"]  # room to turn there
    state = BS.act(state, "red", {"type": "move", "args": {"from": "E8", "to": "E8"}}).state
    assert state["fleets"]["red"][3] == ["E8", "E9"] and valid_fleet(state["fleets"]["red"])
    with pytest.raises(InvalidAction, match="No room"):
        BS.act(state, "red", {"type": "move", "args": {"from": "E8", "to": "A7"}})
    with pytest.raises(InvalidAction, match="No ship starts"):
        BS.act(state, "red", {"type": "move", "args": {"from": "J10", "to": "J9"}})
    with pytest.raises(InvalidAction, match="no way to turn"):
        BS.act(state, "red", {"type": "move", "args": {"from": "D5", "to": "D5"}})
    ready = BS.act(state, "red", {"type": "ready"}).state
    with pytest.raises(InvalidAction, match="already set"):
        BS.act(ready, "red", {"type": "move", "args": {"from": "E8", "to": "G8"}})
    assert BS.scene(ready, "active", None, "red")["input"] == {}


def test_a_ship_turns_about_its_middle_and_else_about_a_cell_with_room():
    # A five-cell line keeps clear of the others' halo; three cells turn about the middle one.
    fleet = [["C3", "D3", "E3"], ["J10"]]
    state = BS.init() | {"fleets": {"red": fleet, "blue": FLEET}}
    turned = BS.act(state, "red", {"type": "move", "args": {"from": "C3", "to": "C3"}}).state
    assert turned["fleets"]["red"][0] == ["D2", "D3", "D4"]
    back = BS.act(turned, "red", {"type": "move", "args": {"from": "D2", "to": "D2"}}).state
    assert back["fleets"]["red"][0] == ["C3", "D3", "E3"]
    # At the top edge there is no room about the middle: it turns about its first cell instead.
    edge = BS.init() | {"fleets": {"red": [["A1", "B1", "C1", "D1"], ["J10"]], "blue": FLEET}}
    assert "A1" in placements(edge["fleets"]["red"])["A1"]
    down = BS.act(edge, "red", {"type": "move", "args": {"from": "A1", "to": "A1"}}).state
    assert down["fleets"]["red"][0] == ["A1", "A2", "A3", "A4"]
    # Hemmed in on every side, it can't turn, and isn't offered the turn.
    boxed = [["E5", "F5"], ["E3"], ["E7"], ["C5"], ["H5"], ["C3"], ["H3"], ["C7"], ["H7"]]
    assert "E5" not in placements(boxed)["E5"]
    with pytest.raises(InvalidAction, match="No room to turn"):
        BS.act(BS.init() | {"fleets": {"red": boxed, "blue": FLEET}}, "red", {"type": "move", "args": {"from": "E5", "to": "E5"}})


def test_every_offered_place_is_a_legal_fleet():
    fleet = random_fleet()
    for start, targets in placements(fleet).items():
        for to in targets:
            moved = BS.act(BS.init() | {"fleets": {"red": fleet, "blue": FLEET}}, "red", {"type": "move", "args": {"from": start, "to": to}})
            assert valid_fleet(moved.state["fleets"]["red"])
