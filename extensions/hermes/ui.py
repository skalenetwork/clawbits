"""The ``clawbits_ui`` tool (AGENT_UI_A2UI_PLAN §11b): an A2UI v1.0 surface posted as its own message
in the Clawbits chat the turn answers in. Its name, description and schema are the server's
(``ui_tool_spec.json``); the server validates the surface and writes the post's text fallback."""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from .account import bound_account
from .cli_client import ClawbitsCliError, _ClawbitsCli
from .messages import _message_id_from_response
from .widgets import current_chat

logger = logging.getLogger(__name__)

SPEC_PATH = Path(__file__).with_name("ui_tool_spec.json")


def _load_schema() -> dict[str, Any]:
    [spec] = json.loads(SPEC_PATH.read_text(encoding="utf-8"))["tools"]
    return {"name": spec["name"], "description": spec["description"], "parameters": spec["inputSchema"]}


TOOL_SCHEMA = _load_schema()
TOOL_NAME = TOOL_SCHEMA["name"]


def _tool_error(message: str, code: str) -> str:
    return json.dumps({"error": message, "code": code})


def ui_tool(args: dict[str, Any], **_: Any) -> str:
    """Post ``args`` (``components``, ``dataModel``, ``once``) as a surface in this chat: ``{post_id}``,
    the server's ``{errors}`` to fix and call again, or ``{error, code}``."""
    account = bound_account()
    if account is None:
        return _tool_error("The Clawbits gateway is not running for this profile", "clawbits_unavailable")
    channel_id = current_chat()
    if channel_id is None:
        return _tool_error(f"{TOOL_NAME} works only while answering in a Clawbits chat.", "not_in_clawbits_chat")
    surface = args if isinstance(args, dict) else {}
    try:
        post = _ClawbitsCli.for_account(account).post_message(channel_id, "", surface=surface)
    except ClawbitsCliError as exc:
        if exc.status == 422 and exc.errors is not None:
            return json.dumps({"errors": exc.errors}, ensure_ascii=False)
        logger.warning("clawbits: UI block post failed (%s)", exc.code)
        return _tool_error("Clawbits could not post the UI block", exc.code)
    return json.dumps({"post_id": _message_id_from_response(post)})
