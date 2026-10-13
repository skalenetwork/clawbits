"""The three Clawbits chat game tools agent runtimes register, in MCP tool shape (``name``,
``description``, ``inputSchema``, ``annotations``).

One definition for every adapter: OpenClaw's and Hermes's native tools are thin pass-throughs to the
agentic widget routes, and their tests diff against ``tool_spec.json``, this module's export (a test
here keeps the two equal). Regenerate it with ``.venv/bin/python -m clawbits.widgets.tool_spec``.
Descriptions say "Clawbits chat game": OpenClaw has a "widget" of its own. They name no kind, so a
new kind needs a server deploy only.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from clawbits.datastructures.widget_models import WIDGET_ACTION_ARGS_MAX_CHARS

SPEC_PATH = Path(__file__).with_name("tool_spec.json")

_WIDGET_ID = {
    "type": "string",
    "description": "The Clawbits chat game's id. Omit for the active game in the current chat.",
}

TOOLS: list[dict[str, Any]] = [
    {
        "name": "clawbits_widget_act",
        "description": (
            "Take your move in a Clawbits chat game: one action from the game view's legal list. "
            "Returns a one-line result, and the fresh view while it is still your move. Never post "
            "chat text about the game; finish with NO_REPLY."
        ),
        "inputSchema": {
            "type": "object",
            "required": ["type"],
            "additionalProperties": False,
            "properties": {
                "widget_id": _WIDGET_ID,
                "type": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 32,
                    "description": "The action's type, from legal: move, fire, call, raise, bet, ...",
                },
                "args": {
                    "type": "object",
                    "description": (
                        "The action's args, from legal: e.g. {\"move\":\"e4\"} {\"at\":\"B7\"} "
                        "{\"to\":120} (poker: the TOTAL your bet on this street comes to) "
                        f"{{\"amount\":50}}. At most {WIDGET_ACTION_ARGS_MAX_CHARS} characters as JSON."
                    ),
                },
                "rev": {
                    "type": "integer",
                    "minimum": 0,
                    "description": "The rev you decided on; the move is refused if the game changed since.",
                },
            },
        },
        "annotations": {
            "title": "Act in a Clawbits chat game",
            "readOnlyHint": False,
            "destructiveHint": False,
            "idempotentHint": False,
            "openWorldHint": False,
        },
    },
    {
        "name": "clawbits_widget_get",
        "description": (
            "Read a Clawbits chat game you play: the board as text, whose move it is, your legal "
            "actions and how to take them."
        ),
        "inputSchema": {
            "type": "object",
            "additionalProperties": False,
            "properties": {"widget_id": _WIDGET_ID},
        },
        "annotations": {
            "title": "Read a Clawbits chat game",
            "readOnlyHint": True,
            "openWorldHint": False,
        },
    },
    {
        "name": "clawbits_widget_list",
        "description": "List the active Clawbits chat games you have a seat in.",
        "inputSchema": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "waiting": {
                    "type": "boolean",
                    "description": "Only the games waiting on your move.",
                },
            },
        },
        "annotations": {
            "title": "List your Clawbits chat games",
            "readOnlyHint": True,
            "openWorldHint": False,
        },
    },
]


def render() -> str:
    """``tool_spec.json``'s exact text: an MCP ``tools/list`` result."""
    return json.dumps({"tools": TOOLS}, indent=2, ensure_ascii=False) + "\n"


if __name__ == "__main__":
    SPEC_PATH.write_text(render())
