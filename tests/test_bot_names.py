"""Integrity checks for clawbits/data/bot_names.json — the agent name pool.

Signup derives both the agent_id (with digit suffixes on collision) and the
default nickname from these entries, and the server keys ``_bot_names`` by
``long_name``, so duplicates silently shrink the pool and odd characters
would leak into agent ids.
"""
import json
import re
from pathlib import Path

POOL_PATH = Path(__file__).resolve().parents[1] / "clawbits" / "data" / "bot_names.json"

# agent_id allows alphanumerics + underscores and is capped at 32 chars;
# leave headroom for the collision suffix digits appended at signup.
NICKNAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9]*$")
NICKNAME_MAX = 24
# long_name is only a display string / dict key, never an id — hyphens OK
# (a handful of legacy "X-Ray…" entries use them).
LONG_NAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9-]*$")


def _load() -> list[dict]:
    with open(POOL_PATH) as f:
        return json.load(f)["agent_names"]


def test_pool_is_large_enough():
    assert len(_load()) >= 700


def test_entries_have_unique_names():
    names = _load()
    nicknames = [e["nickname"] for e in names]
    long_names = [e["long_name"] for e in names]
    assert len(set(nicknames)) == len(nicknames), "duplicate nicknames"
    assert len(set(long_names)) == len(long_names), "duplicate long_names"


def test_entries_are_well_formed():
    for e in _load():
        nick, long_name = e["nickname"], e["long_name"]
        assert NICKNAME_RE.fullmatch(nick), f"bad nickname charset: {nick!r}"
        assert len(nick) <= NICKNAME_MAX, f"nickname too long: {nick!r}"
        assert LONG_NAME_RE.fullmatch(long_name), f"bad long_name charset: {long_name!r}"
        assert len(long_name) <= 64, f"long_name too long: {long_name!r}"


def test_server_resolves_a_non_empty_pool():
    """The path the *server* computes must find the pool.

    The checks above resolve the JSON themselves, so they pass even if
    ``ClawBitsServer`` looks in the wrong place — and that failure is silent:
    the load is try/except-with-a-warning, so the app boots clean and only
    breaks later at ``agent_signup.py``'s ``random.choice`` on an empty dict,
    surfacing as a 500 on signup. This asserts the real path.
    """
    from clawbits.fastapi import clawbits_server

    resolved = Path(clawbits_server.__file__).resolve().parents[1] / "data" / "bot_names.json"
    assert resolved.is_file(), f"server would look in {resolved}"
    assert len(json.loads(resolved.read_text())["agent_names"]) > 0
