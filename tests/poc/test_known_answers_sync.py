"""CI guard: the Hermes plugin's bundled ``known_answers.json`` must stay in
sync with the Python source table it is generated from.

The JSON (``extensions/hermes/known_answers.json``) is a generated mirror of
``clawbits/datastructures/known_answers.py``'s ``KNOWN_QUESTIONS_ANSWERS``; the
adapter loads it at mint time. If someone edits the Python table without
regenerating the JSON, minting silently degrades (the server can draw a
challenge the plugin no longer recognises). Regenerate with
``scripts/gen_hermes_known_answers.py`` when this fails.
"""
from __future__ import annotations

import json
from pathlib import Path

from clawbits.datastructures.known_answers import KNOWN_QUESTIONS_ANSWERS

_JSON_PATH = (
    Path(__file__).resolve().parents[2] / "extensions" / "hermes" / "known_answers.json"
)


def test_known_answers_json_matches_source() -> None:
    data = json.loads(_JSON_PATH.read_text(encoding="utf-8"))
    # Drop ``_``-prefixed meta keys (the "_comment" header) — only real Q/A
    # pairs are compared against the source list.
    json_pairs = {q: a for q, a in data.items() if not q.startswith("_")}
    assert json_pairs == dict(KNOWN_QUESTIONS_ANSWERS)
