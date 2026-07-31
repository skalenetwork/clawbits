#!/usr/bin/env python3
"""Regenerate ``extensions/hermes/known_answers.json`` from the Python source.

The single source of truth for the Proof-of-Cognition answer table is
``clawbits/datastructures/known_answers.py`` (``KNOWN_QUESTIONS_ANSWERS``) — the
same list the OpenClaw plugin's ``knownAnswers.ts`` is generated from. The JSON
shipped beside the Hermes plugin is a generated MIRROR the adapter loads at
mint time (``_load_known_answers``). Run this after editing the table, then
commit the JSON.

The output is byte-for-byte stable so a no-op run leaves ``git diff`` clean:
2-space indent, ``ensure_ascii=False`` (the ``_comment`` header carries an
em-dash that the committed file stores raw), and NO trailing newline. CI's
``tests/poc/test_known_answers_sync.py`` fails if the JSON and the source drift.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
JSON_PATH = REPO_ROOT / "extensions" / "hermes" / "known_answers.json"

# Used only when regenerating from scratch (the committed file always carries
# this line already, and _existing_comment() reuses it verbatim to stay
# byte-stable).
_DEFAULT_COMMENT = (
    "Auto-generated from clawbits/datastructures/known_answers.py "
    "— do not edit by hand."
)


def _load_pairs() -> list[tuple[str, str]]:
    if str(REPO_ROOT) not in sys.path:
        sys.path.insert(0, str(REPO_ROOT))
    # Import the list directly so the answers are never re-transcribed here.
    from clawbits.datastructures.known_answers import KNOWN_QUESTIONS_ANSWERS

    return list(KNOWN_QUESTIONS_ANSWERS)


def _existing_comment() -> str:
    """Reuse the committed ``_comment`` verbatim so output stays byte-stable."""
    try:
        data = json.loads(JSON_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return _DEFAULT_COMMENT
    comment = data.get("_comment")
    return comment if isinstance(comment, str) else _DEFAULT_COMMENT


def build_json() -> str:
    payload: dict[str, str] = {"_comment": _existing_comment()}
    for question, answer in _load_pairs():
        payload[question] = answer
    # Match the committed file exactly (see module docstring): 2-space indent,
    # raw UTF-8, no trailing newline.
    return json.dumps(payload, indent=2, ensure_ascii=False)


def main() -> int:
    content = build_json()
    JSON_PATH.write_text(content, encoding="utf-8")
    print(f"wrote {JSON_PATH.relative_to(REPO_ROOT)} ({len(content.encode('utf-8'))} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
