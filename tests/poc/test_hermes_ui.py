"""The ``clawbits_ui`` tool for Hermes (extensions/hermes/ui.py): the server's tool spec verbatim, the
surface posted through the agent CLI to the chat the turn answers in, and the server's errors handed
back to the model."""

from __future__ import annotations

import json
import sys
import types
from pathlib import Path
from typing import Any

import pytest

from tests.poc.hermes_stubs import _FakeClawbitsApi, _load_hermes_module

REPO = Path(__file__).resolve().parents[2]
POSTS = "/api/agentic/mm/channels/dm/posts"
COMPONENTS = [
    {"id": "root", "component": "Card", "child": "stats"},
    {"id": "stats", "component": "Stats", "items": [{"label": "Succeeded", "value": "9", "unit": "of 10"}]},
]


@pytest.fixture
def api():
    server = _FakeClawbitsApi()
    yield server
    server.close()


def _session(monkeypatch, chat: str | None = "dm", platform: str = "clawbits") -> None:
    env = {"HERMES_SESSION_PLATFORM": platform, "HERMES_SESSION_CHAT_ID": chat or ""}
    module = types.SimpleNamespace(get_session_env=lambda name, default="": env.get(name, default))
    monkeypatch.setitem(sys.modules, "gateway.session_context", module)


def _bind(mod, api: _FakeClawbitsApi) -> None:
    home = mod.account._active_home()
    mod.account.bind_account(mod.ClawbitsAccount(hermes_home=home, base_url=api.base_url, agent_id="agent", api_key="k"))


def test_the_tool_is_the_servers_spec_verbatim() -> None:
    mod = _load_hermes_module()
    shipped = (REPO / "extensions" / "hermes" / "ui_tool_spec.json").read_bytes()
    assert shipped == (REPO / "clawbits" / "a2ui" / "tool_spec.json").read_bytes()
    tools: dict[str, dict[str, Any]] = {}

    class Ctx:
        def register_tool(self, **kwargs: Any) -> None:
            tools[kwargs["name"]] = kwargs

        def register_hook(self, *_: Any) -> None:
            pass

        def register_cli_command(self, **_: Any) -> None:
            pass

        def register_platform(self, **_: Any) -> None:
            pass

    mod.register(Ctx())
    [spec] = json.loads(shipped)["tools"]
    tool = tools["clawbits_ui"]
    assert tool["schema"] == {"name": spec["name"], "description": spec["description"], "parameters": spec["inputSchema"]}
    assert (tool["toolset"], tool["handler"], tool["check_fn"]) == ("clawbits", mod.ui.ui_tool, mod.widgets.available)


def test_the_surface_is_posted_in_this_chat(api, monkeypatch) -> None:
    mod = _load_hermes_module()
    _bind(mod, api)
    _session(monkeypatch)
    api.respond("POST", POSTS, 200, {"post_id": 812, "channel_id": "dm", "message": "Succeeded: 9 of 10"})

    surface = {"components": COMPONENTS, "dataModel": {"target": []}, "once": False}
    assert json.loads(mod.ui.ui_tool(surface)) == {"post_id": "812"}
    [post] = api.writes()
    assert post["body"] == {"message": "", "status": "published", "file_ids": [], "surface": surface}
    assert post["headers"]["authorization"] == "Bearer k"


def test_a_refused_surface_returns_the_servers_errors(api, monkeypatch) -> None:
    mod = _load_hermes_module()
    _bind(mod, api)
    _session(monkeypatch)
    errors = [{"code": "VALIDATION_FAILED", "path": "/components/1", "message": "Unknown component Image"}]
    api.respond("POST", POSTS, 422, {"detail": errors})
    assert json.loads(mod.ui.ui_tool({"components": COMPONENTS})) == {"errors": errors}

    api.respond("POST", POSTS, 403, {"detail": "You cannot post here"})
    assert json.loads(mod.ui.ui_tool({"components": COMPONENTS})) == {
        "error": "Clawbits could not post the UI block", "code": "forbidden",
    }


def test_the_tool_refuses_outside_a_clawbits_chat(api, monkeypatch) -> None:
    mod = _load_hermes_module()
    _session(monkeypatch)
    assert json.loads(mod.ui.ui_tool({"components": COMPONENTS}))["code"] == "clawbits_unavailable"
    _bind(mod, api)
    _session(monkeypatch, platform="telegram")
    assert json.loads(mod.ui.ui_tool({"components": COMPONENTS}))["code"] == "not_in_clawbits_chat"
    _session(monkeypatch, chat=None)
    assert json.loads(mod.ui.ui_tool({"components": COMPONENTS}))["code"] == "not_in_clawbits_chat"
    assert api.writes() == []
