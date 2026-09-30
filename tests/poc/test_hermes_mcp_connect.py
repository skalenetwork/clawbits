"""MCP sign-in glue: the ``clawbits_mcp_connect`` tool, the guard on Hermes's own sign-ins, the
``mcp.oauth.code`` event and its agent-CLI verbs. The OAuth grant itself runs against real Hermes
and the MCP SDK in tests/hermes_runtime/test_mcp_connect.py."""

from __future__ import annotations

import asyncio
import json
import sys
import types
from typing import Any

import pytest

from tests.poc.hermes_stubs import (
    _drain,
    _FakeClawbitsApi,
    _FakePlatformConfig,
    _load_hermes_module,
)
from tests.poc.intake_fakes import FakeClawbits

SIGN_IN_URL = "https://auth.example.com/authorize?client_id=c1&state=s0"
CALLBACK = "https://app.example.com/oauth/mcp/callback"
LINK = "https://app.example.com/connect/abc"
ARGS = {"server": "linear", "url": "https://mcp.linear.app/mcp"}


@pytest.fixture
def api():
    server = _FakeClawbitsApi()
    server.respond("GET", "/api/agentic/mcp-oauth/redirect", 200, {"url": CALLBACK})
    server.respond("POST", "/api/agentic/mcp-oauth/links", 200, {"url": LINK})
    yield server
    server.close()


def _session(monkeypatch, platform: str = "clawbits", chat: str = "dm") -> None:
    """The turn's session vars, as Hermes's gateway binds them."""
    env = {"HERMES_SESSION_PLATFORM": platform, "HERMES_SESSION_CHAT_ID": chat}
    module = types.SimpleNamespace(get_session_env=lambda name, default="": env.get(name, default))
    monkeypatch.setitem(sys.modules, "gateway.session_context", module)


def _bind(mod, api: _FakeClawbitsApi) -> None:
    home = mod.account._active_home()
    mod.account.bind_account(
        mod.ClawbitsAccount(hermes_home=home, base_url=api.base_url, agent_id="agent", api_key="k")
    )


def _starts(monkeypatch, mc, result: Any) -> list[tuple[Any, ...]]:
    calls: list[tuple[Any, ...]] = []

    async def start(*args: Any) -> Any:
        calls.append(args)
        if isinstance(result, Exception):
            raise result
        return result

    monkeypatch.setattr(mc, "start_sign_in", start)
    return calls


def test_the_tool_posts_a_connect_card_for_the_sign_in(api, monkeypatch) -> None:
    mod = _load_hermes_module()
    mc = mod.mcp_connect
    _bind(mod, api)
    _session(monkeypatch)
    starts = _starts(monkeypatch, mc, SIGN_IN_URL)

    result = mc.mcp_connect_tool({"server": "linear", "url": " https://mcp.linear.app/mcp ", "scope": "read"})

    assert json.loads(result) == {"status": "card_posted"}
    assert starts == [("linear", "https://mcp.linear.app/mcp", "read", CALLBACK)]
    link, post = [r for r in api.writes() if r["method"] == "POST"]
    assert (link["path"], link["body"]) == (
        "/api/agentic/mcp-oauth/links",
        {"server": "linear", "url": SIGN_IN_URL, "channel_id": "dm"},
    )
    assert (post["path"], post["body"]["message"]) == ("/api/agentic/mm/channels/dm/posts", LINK)


def test_the_tool_reports_signed_in_when_nothing_needs_signing_in(api, monkeypatch) -> None:
    mod = _load_hermes_module()
    mc = mod.mcp_connect
    _bind(mod, api)
    _session(monkeypatch)
    _starts(monkeypatch, mc, None)
    monkeypatch.setattr(mc, "connect_server", lambda server, wait=0.0: "its tools join your tool list.")

    assert json.loads(mc.mcp_connect_tool(ARGS)) == {"status": "signed_in", "detail": "its tools join your tool list."}
    assert [r["path"] for r in api.writes()] == ["/api/agentic/mcp-oauth/redirect"], "no card"


def test_a_sign_in_that_cannot_start_posts_no_card(api, monkeypatch) -> None:
    mod = _load_hermes_module()
    mc = mod.mcp_connect
    _bind(mod, api)
    _session(monkeypatch)
    _starts(monkeypatch, mc, mc.SignInError("the server names no OAuth authorization server"))

    assert json.loads(mc.mcp_connect_tool(ARGS)) == {
        "error": "Could not start the sign-in to linear: the server names no OAuth authorization server",
        "code": "sign_in_failed",
    }
    assert [r["path"] for r in api.writes()] == ["/api/agentic/mcp-oauth/redirect"]


def test_the_tool_works_only_in_a_clawbits_chat_of_a_running_gateway(api, monkeypatch) -> None:
    mod = _load_hermes_module()
    mc = mod.mcp_connect
    starts = _starts(monkeypatch, mc, SIGN_IN_URL)
    _session(monkeypatch)
    assert json.loads(mc.mcp_connect_tool(ARGS))["code"] == "clawbits_unavailable"
    assert mc.available() is False

    _bind(mod, api)
    _session(monkeypatch, platform="telegram")
    assert json.loads(mc.mcp_connect_tool(ARGS))["code"] == "not_in_clawbits_chat"
    _session(monkeypatch)
    assert json.loads(mc.mcp_connect_tool({**ARGS, "server": "two words"}))["code"] == "invalid_server"
    assert json.loads(mc.mcp_connect_tool({"server": "linear"}))["code"] == "invalid_url"
    assert starts == [] and api.writes() == []


@pytest.mark.parametrize(
    "command",
    [
        "hermes mcp login linear",
        "cd /tmp && hermes  mcp reauth --all",
        "hermes mcp add linear --url https://mcp.linear.app/mcp --auth oauth",
        "hermes mcp add linear --auth=oauth",
    ],
)
def test_hermes_own_sign_ins_are_blocked_in_a_clawbits_chat(monkeypatch, command: str) -> None:
    mc = _load_hermes_module().mcp_connect
    _session(monkeypatch)
    verdict = mc.guard_sign_in(tool_name="terminal", args={"command": command})
    assert verdict is not None and verdict["action"] == "block"
    assert mc.TOOL_NAME in verdict["message"]


def test_the_guard_lets_everything_else_through(monkeypatch) -> None:
    mc = _load_hermes_module().mcp_connect
    _session(monkeypatch)
    for tool_name, args in [
        ("terminal", {"command": "hermes mcp list"}),
        ("terminal", {"command": "hermes mcp add notes --auth header"}),
        ("manage_connections", {"action": "status"}),
        ("web_search", {"query": "hermes mcp login"}),
    ]:
        assert mc.guard_sign_in(tool_name=tool_name, args=args) is None, (tool_name, args)
    authorize = {"action": "authorize", "connectors": [{"name": "linear", "mcp": True}]}
    assert mc.guard_sign_in(tool_name="manage_connections", args=authorize)["action"] == "block"

    _session(monkeypatch, platform="telegram")
    assert mc.guard_sign_in(tool_name="terminal", args={"command": "hermes mcp login linear"}) is None
    monkeypatch.delitem(sys.modules, "gateway.session_context")
    assert mc.guard_sign_in(tool_name="terminal", args={"command": "hermes mcp login linear"}) is None


def test_relayed_codes_are_read_strictly() -> None:
    mc = _load_hermes_module().mcp_connect
    data = {"state": "s1", "code": "c1", "server": "linear", "channel_id": "dm", "human_id": 7}
    assert mc.relayed_code(data) == mc.RelayedCode("linear", "c1", "s1", "dm", 7)
    for bad in ({**data, "code": ""}, {**data, "human_id": True}, {**data, "server": "a b"}, {**data, "state": None}, "x"):
        assert mc.relayed_code(bad) is None, bad


class _Results:
    def __init__(self) -> None:
        self.results: list[tuple[str, bool]] = []

    def mcp_oauth_result(self, state: str, connected: bool) -> None:
        self.results.append((state, connected))


def test_redeem_reports_the_outcome_and_says_what_happened(monkeypatch) -> None:
    mc = _load_hermes_module().mcp_connect
    relayed = mc.RelayedCode("linear", "c1", "s1", "dm", 7)
    finished: list[tuple[Any, ...]] = []

    async def finish(*args: Any) -> None:
        finished.append(args)

    monkeypatch.setattr(mc, "finish_sign_in", finish)
    monkeypatch.setattr(mc, "connect_server", lambda server, wait=0.0: "its tools are in your tool list from your next turn.")
    client = _Results()
    note = asyncio.run(mc.redeem(client, relayed))
    assert finished == [("linear", "c1")] and client.results == [("s1", True)]
    assert note == '[Clawbits] Signed in to MCP server "linear"; its tools are in your tool list from your next turn.'

    async def refused(*_: Any) -> None:
        raise mc.SignInError("the authorization server refused the code (HTTP 400, invalid_grant)")

    monkeypatch.setattr(mc, "finish_sign_in", refused)
    note = asyncio.run(mc.redeem(client, relayed))
    assert client.results[-1] == ("s1", False)
    assert note == (
        '[Clawbits] Sign-in to MCP server "linear" did not finish: the authorization server refused '
        "the code (HTTP 400, invalid_grant). Its Connect card is open again for another try."
    )

    async def broken(*_: Any) -> None:
        raise RuntimeError("token=secret")

    monkeypatch.setattr(mc, "finish_sign_in", broken)
    note = asyncio.run(mc.redeem(client, relayed))
    assert client.results[-1] == ("s1", False)
    assert "secret" not in note and "it could not be completed" in note


def test_a_relayed_code_wakes_the_agent_in_its_chat_as_the_human(monkeypatch) -> None:
    mod = _load_hermes_module()
    adapter = mod.ClawbitsAdapter(_FakePlatformConfig(extra={"api_key": "k", "agent_id": "agent"}))
    adapter.client = FakeClawbits()
    adapter._channels = {"dm": mod._Channel("dm", "direct", "DM")}
    redeemed: list[Any] = []

    async def redeem(client: Any, relayed: Any) -> str:
        redeemed.append(relayed)
        return "[Clawbits] Signed in."

    monkeypatch.setattr(mod.adapter, "redeem", redeem)
    event = {"type": "mcp.oauth.code", "data": {"state": "s1", "code": "c1", "server": "linear", "channel_id": "dm", "human_id": 7}}

    class FakeSocket:
        async def __aenter__(self) -> FakeSocket:
            return self

        async def __aexit__(self, *exc: Any) -> None:
            return None

        def __aiter__(self):
            return self._messages()

        async def _messages(self):
            yield json.dumps({"type": "mcp.oauth.code", "data": {"server": "linear"}})  # malformed: ignored
            yield json.dumps(event)
            await asyncio.gather(*list(adapter._handoffs))
            adapter._running = False

    monkeypatch.setitem(sys.modules, "websockets", types.SimpleNamespace(connect=lambda *a, **k: FakeSocket()))

    async def run() -> None:
        adapter._running = True
        await adapter._lobstertalk_ws_loop()
        await _drain(adapter)

    asyncio.run(run())

    assert [r.code for r in redeemed] == ["c1"]
    [wake] = adapter.events
    assert wake.text == "[Clawbits] Signed in."
    assert (wake.source.chat_id, wake.source.user_id, wake.source.chat_type) == ("dm", "7", "dm")
    assert wake.message_id == "mcp-oauth-s1" and wake.allow_gateway_control is False


def test_the_cli_verbs_reach_the_sign_in_endpoints(api) -> None:
    mod = _load_hermes_module()
    client = mod._ClawbitsCli(mod._default_cli_path(), api.base_url, "k")

    assert client.mcp_oauth_redirect() == CALLBACK
    assert client.mcp_oauth_link("linear", SIGN_IN_URL, "dm") == LINK
    client.mcp_oauth_result("s1", True)

    redirect, link, result = api.writes()
    assert (redirect["method"], redirect["path"]) == ("GET", "/api/agentic/mcp-oauth/redirect")
    assert (link["method"], link["body"]) == ("POST", {"server": "linear", "url": SIGN_IN_URL, "channel_id": "dm"})
    assert (result["path"], result["body"]) == ("/api/agentic/mcp-oauth/result", {"state": "s1", "connected": True})
    assert all(r["headers"]["authorization"] == "Bearer k" for r in (redirect, link, result))
