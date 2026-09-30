"""MCP sign-in through a Connect card, against Hermes's own OAuth storage and MCP client.

The plugin runs the authorization-code grant itself (extensions/hermes/mcp_connect.py); what it
stores must be what Hermes's MCP client sends and refreshes with no browser step, at both pinned
revisions. An OAuth-protected MCP server and its authorization server answer through an httpx2
MockTransport.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import sys
from typing import Any
from urllib.parse import parse_qs, urlsplit

import httpx2
import pytest
import yaml
from fake_clawbits import MCP_CALLBACK, OPERATOR_DM, OPERATOR_ID, tool

SERVER = "linear"
MCP_URL = "https://mcp.example.com/mcp"
ISSUER = "https://auth.example.com"
PRM_URL = "https://mcp.example.com/.well-known/oauth-protected-resource/mcp"


class FakeProvider:
    """An OAuth-protected MCP server and its authorization server (RFC 9728, 8414, 7591, 7636)."""

    def __init__(self) -> None:
        self.registrations: list[dict[str, Any]] = []
        self.token_requests: list[dict[str, str]] = []
        self.bearers: list[str] = []
        self.challenge: str | None = None
        self.transport = httpx2.MockTransport(self.handle)

    def approve(self, sign_in_url: str) -> None:
        """The user approved this sign-in URL: its PKCE challenge is what the code is bound to."""
        self.challenge = parse_qs(urlsplit(sign_in_url).query)["code_challenge"][0]

    def handle(self, request: httpx2.Request) -> httpx2.Response:
        url = str(request.url)
        if url == MCP_URL:
            scheme, _, token = request.headers.get("authorization", "").partition(" ")
            if scheme == "Bearer" and token in ("at-1", "at-2"):
                self.bearers.append(token)
                return httpx2.Response(200, json={"jsonrpc": "2.0", "id": 1, "result": {}})
            return httpx2.Response(401, headers={"WWW-Authenticate": f'Bearer resource_metadata="{PRM_URL}"'})
        if url == PRM_URL:
            return httpx2.Response(
                200, json={"resource": MCP_URL, "authorization_servers": [ISSUER], "scopes_supported": ["read"]}
            )
        if url == f"{ISSUER}/.well-known/oauth-authorization-server":
            return httpx2.Response(200, json={
                "issuer": ISSUER,
                "authorization_endpoint": f"{ISSUER}/authorize",
                "token_endpoint": f"{ISSUER}/oauth2/token",
                "registration_endpoint": f"{ISSUER}/register",
                "code_challenge_methods_supported": ["S256"],
                "authorization_response_iss_parameter_supported": True,
            })
        if url == f"{ISSUER}/register":
            body = json.loads(request.content)
            self.registrations.append(body)
            return httpx2.Response(201, json={**body, "client_id": "client-1"})
        if url == f"{ISSUER}/oauth2/token":
            form = {k: v[0] for k, v in parse_qs(request.content.decode()).items()}
            self.token_requests.append(form)
            if form.get("grant_type") == "refresh_token":
                if form.get("refresh_token") != "rt-1" or form.get("client_id") != "client-1":
                    return httpx2.Response(400, json={"error": "invalid_grant"})
                return httpx2.Response(
                    200, json={"access_token": "at-2", "token_type": "bearer", "expires_in": 3600}
                )
            digest = hashlib.sha256(form.get("code_verifier", "").encode()).digest()
            if form.get("code") != "code-1" or base64.urlsafe_b64encode(digest).decode().rstrip("=") != self.challenge:
                return httpx2.Response(400, json={"error": "invalid_grant"})
            return httpx2.Response(200, json={
                "access_token": "at-1", "token_type": "bearer", "expires_in": 3600,
                "refresh_token": "rt-1", "scope": "read",
            })
        return httpx2.Response(404)


def _plugin(gateway) -> Any:
    return gateway.load_plugin().mcp_connect


async def _call_through_hermes(provider: FakeProvider) -> httpx2.Response:
    """One MCP request authenticated by Hermes's own OAuth provider, with interactive sign-in off."""
    from tools.mcp_oauth import suppress_interactive_oauth
    from tools.mcp_oauth_manager import get_manager

    with suppress_interactive_oauth():
        get_manager().evict(SERVER)
        auth = get_manager().get_or_build_provider(SERVER, MCP_URL, {})
        async with httpx2.AsyncClient(auth=auth, transport=provider.transport) as client:
            return await client.post(MCP_URL, json={"jsonrpc": "2.0", "id": 2, "method": "tools/list"})


def test_a_relayed_code_leaves_hermes_a_grant_it_sends_and_refreshes(gateway, monkeypatch) -> None:
    mc = _plugin(gateway)
    provider = FakeProvider()
    monkeypatch.setattr(mc, "transport", provider.transport)
    from tools.mcp_oauth import HermesTokenStorage, _get_token_dir

    url = asyncio.run(mc.start_sign_in(SERVER, MCP_URL, None, MCP_CALLBACK))
    params = {k: v[0] for k, v in parse_qs(urlsplit(url).query).items()}
    assert url.startswith(f"{ISSUER}/authorize?")
    assert params["client_id"] == "client-1" and params["redirect_uri"] == MCP_CALLBACK
    assert (params["code_challenge_method"], params["resource"], params["scope"]) == ("S256", MCP_URL, "read")
    assert params["state"], "Clawbits swaps its own state into this parameter"
    [registration] = provider.registrations
    assert registration["redirect_uris"] == [MCP_CALLBACK] and registration["application_type"] == "web"
    assert not HermesTokenStorage(SERVER).has_cached_tokens(), "nothing reaches Hermes before the code"
    pending = gateway.home / "plugin-data" / "clawbits-platform" / mc.PENDING_FILE
    assert pending.stat().st_mode & 0o077 == 0, "the PKCE verifier stays private"
    provider.approve(url)

    with pytest.raises(mc.SignInError):
        asyncio.run(mc.finish_sign_in(SERVER, "stale"))
    assert not HermesTokenStorage(SERVER).has_cached_tokens()
    # The session outlived the failure; a server advertising RFC 9207 iss still signs in without it.
    asyncio.run(mc.finish_sign_in(SERVER, "code-1"))

    exchange = provider.token_requests[-1]
    assert (exchange["redirect_uri"], exchange["resource"], exchange["client_id"]) == (MCP_CALLBACK, MCP_URL, "client-1")
    config = yaml.safe_load((gateway.home / "config.yaml").read_text(encoding="utf-8"))
    assert config["mcp_servers"][SERVER] == {"url": MCP_URL, "auth": "oauth"}
    assert json.loads(pending.read_text(encoding="utf-8")) == {}
    tokens = _get_token_dir() / f"{SERVER}.json"
    assert json.loads(tokens.read_text(encoding="utf-8"))["hermes_issuer"] == ISSUER
    assert tokens.stat().st_mode & 0o077 == 0

    assert asyncio.run(_call_through_hermes(provider)).status_code == 200
    assert provider.bearers[-1] == "at-1", "Hermes sends the plugin's token"

    stored = json.loads(tokens.read_text(encoding="utf-8"))
    tokens.write_text(json.dumps({**stored, "expires_at": 0}), encoding="utf-8")
    assert asyncio.run(_call_through_hermes(provider)).status_code == 200
    refresh = provider.token_requests[-1]
    assert (refresh["grant_type"], refresh["client_id"]) == ("refresh_token", "client-1")
    assert provider.bearers[-1] == "at-2", "Hermes refreshed at the stored token endpoint"

    assert asyncio.run(mc.start_sign_in(SERVER, MCP_URL, None, MCP_CALLBACK)) is None, "already signed in"
    tokens.unlink()
    assert asyncio.run(mc.start_sign_in(SERVER, MCP_URL, None, MCP_CALLBACK)).startswith(ISSUER)
    assert len(provider.registrations) == 1, "a sign-in again reuses the client registered for Clawbits"


def test_a_connect_card_signs_the_agent_in_from_the_chat(gateway, monkeypatch) -> None:
    provider = FakeProvider()

    async def scenario(gw) -> None:
        mc = sys.modules[type(gw.adapter).__module__.rpartition(".")[0] + ".mcp_connect"]
        monkeypatch.setattr(mc, "transport", provider.transport)
        # Hermes's own reconnect would dial mcp.example.com for real; the grant is covered above.
        monkeypatch.setattr(mc, "connect_server", lambda server, wait=0.0: "its tools join your tool list.")
        # Plugin tools are deferred behind Hermes's tool search: the model calls them through tool_call.
        call = {"name": "clawbits_mcp_connect", "arguments": {"server": SERVER, "url": MCP_URL}}
        gw.fake.script(tool("tool_call", calls=[call]), "Card posted.")
        start = len(gw.fake.posts)
        post = gw.fake.post("connect linear")
        await gw.settled(post, 30)

        [result] = gw.tool_results("tool_call")
        assert "card_posted" in result, result
        [link] = gw.fake.mcp_links
        assert (link["server"], link["channel_id"]) == (SERVER, OPERATOR_DM)
        assert "https://app.example.com/connect/link-1" in gw.replies(start, OPERATOR_DM), gw.dump()

        provider.approve(link["url"])
        gw.fake.script("Linear is ready.")
        state = "clawbits-state-0000001"
        await gw.push_ws({"type": "mcp.oauth.code", "data": {
            "state": state, "code": "code-1", "server": SERVER,
            "channel_id": OPERATOR_DM, "human_id": OPERATOR_ID,
        }})
        await gw.wait_for(lambda: "Linear is ready." in gw.replies(start, OPERATOR_DM), 30)
        assert gw.fake.mcp_results == [{"state": state, "connected": True}]
        [wake] = [e for e in gw.events if (e.text or "").startswith("[Clawbits]")]
        assert wake.text == '[Clawbits] Signed in to MCP server "linear"; its tools join your tool list.'
        assert (wake.source.chat_id, wake.source.user_id) == (OPERATOR_DM, str(OPERATOR_ID))
        assert wake.allow_gateway_control is False

    gateway(scenario)


def test_hermes_own_mcp_login_is_blocked_in_a_clawbits_chat(gateway) -> None:
    async def scenario(gw) -> None:
        gw.fake.script(tool("terminal", command=f"hermes mcp login {SERVER}"), "ok")
        post = gw.fake.post("log in to linear")
        await gw.settled(post, 30)
        [result] = gw.tool_results("terminal")
        assert "clawbits_mcp_connect" in result, result

    gateway(scenario)
