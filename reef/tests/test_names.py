"""``random_name``: Docker-style ``adjective-noun``, unique against taken names."""

import re

from reef.names import _ADJECTIVES, _NOUNS, random_name

_SHAPE = re.compile(r"^[a-z]+-[a-z]+$")


def test_random_name_shape_and_membership():
    for _ in range(200):
        name = random_name()
        assert _SHAPE.match(name), name
        adj, noun = name.split("-")
        assert adj in _ADJECTIVES
        assert noun in _NOUNS


def test_random_name_avoids_taken():
    taken: set[str] = set()
    for _ in range(50):
        name = random_name(taken)
        assert name not in taken
        taken.add(name)


def test_random_name_falls_back_to_suffix_when_exhausted(monkeypatch):
    # Collapse the lists to a single combo and mark it taken → must disambiguate
    # with a hex suffix rather than loop forever.
    monkeypatch.setattr("reef.names._ADJECTIVES", ("solo",))
    monkeypatch.setattr("reef.names._NOUNS", ("yak",))
    name = random_name({"solo-yak"}, attempts=5)
    assert name.startswith("solo-yak-") and name != "solo-yak"
