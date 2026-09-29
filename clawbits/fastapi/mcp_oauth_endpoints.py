"""Hosted MCP sign-in: the agent registers the authorization URL its login printed and posts the connect
link it gets back; a manager's click mints a fresh state, the provider's code is relayed to the agent's
plugin under a short "connecting" lock, and the plugin's report is what marks the link connected. Native
clients' states carry their URL scheme so the callback page can hand the code back to the app."""

import asyncio
import re
import secrets
from datetime import timedelta
from urllib.parse import parse_qs, urlsplit

from fastapi import APIRouter, Depends, HTTPException, Request, Response, Security
from fastapi.security import APIKeyHeader

from clawbits.datastructures.mcp_oauth_models import (
    McpSignInClaim,
    McpSignInClaimRequest,
    McpSignInLink,
    McpSignInLinkRequest,
    McpSignInLinkView,
    McpSignInRequest,
    McpSignInResponse,
    McpSignInResult,
    McpSignInStatus,
    McpSignInUrl,
)
from clawbits.db.table_read import TableRead
from clawbits.fastapi.agent_auth import extract_agent
from clawbits.fastapi.human_endpoints import _get_db
from clawbits.fastapi.workos_auth import _desktop_url_scheme, _frontend_root, get_current_human_user
from clawbits.realtime import agent_topic, get_bus

mcp_oauth_router = APIRouter(tags=["MCP sign-in"])
api_key_header = APIKeyHeader(name="Authorization", auto_error=False)

LINK_LIFETIME = timedelta(minutes=30)
CONNECTED_LIFETIME = timedelta(days=30)
CONNECTING_LIFETIME = timedelta(seconds=90)


def mcp_oauth_redirect_url() -> str:
    return f"{_frontend_root()}/oauth/mcp/callback"


def _key(*parts: str) -> str:
    return ":".join(("mcp_oauth", *parts))


def _agent_name(request: Request, agent_id: str, manager: int | None = None) -> str:
    """The agent's display name; with ``manager``, only if that human operates it or admins its org."""
    with _get_db(request) as db:
        if manager is not None and not TableRead.can_manage_agent_contacts(db, agent_id, manager):
            raise HTTPException(
                status_code=403, detail="Only the agent's operator or an org admin can connect it"
            )
        return TableRead.resolve_agent_display(db, agent_id)


async def _link(link_id: str) -> McpSignInLink:
    held = await (await get_bus().redis_client()).get(_key("link", link_id))
    if held is None:
        raise HTTPException(
            status_code=404, detail="This link is no longer active. Ask the agent for a new one."
        )
    return McpSignInLink.model_validate_json(held)


async def _status(link_id: str, link: McpSignInLink) -> McpSignInStatus:
    if link.connected:
        return "connected"
    connecting = await (await get_bus().redis_client()).exists(_key("connecting", link_id))
    return "connecting" if connecting else "open"


@mcp_oauth_router.get("/api/agentic/mcp-oauth/redirect", response_model=McpSignInUrl)
async def mcp_oauth_redirect(
    request: Request, api_key: str = Security(api_key_header)
) -> McpSignInUrl:
    """Where MCP servers send the browser back after sign-in."""
    await asyncio.to_thread(extract_agent, request.app._engine, api_key)
    return McpSignInUrl(url=mcp_oauth_redirect_url())


@mcp_oauth_router.post("/api/agentic/mcp-oauth/links", response_model=McpSignInUrl)
async def register_mcp_sign_in_link(
    body: McpSignInLinkRequest,
    request: Request,
    api_key: str = Security(api_key_header),
) -> McpSignInUrl:
    """Register an authorization URL the agent's MCP login printed; it replaces the agent's previous link
    for that server, whose login it superseded. Returns the connect link. The card names the URL's host, so it
    must be the one a browser opens: no userinfo or backslash for URL parsers to disagree on, no Unicode lookalikes."""
    agent = await asyncio.to_thread(extract_agent, request.app._engine, api_key)
    url = urlsplit(body.url)
    plain = (
        url.hostname and url.hostname.isascii() and url.username is None and "\\" not in body.url
    )
    if (
        not plain
        or url.scheme != "https"
        or parse_qs(url.query).get("redirect_uri") != [mcp_oauth_redirect_url()]
    ):
        raise HTTPException(
            status_code=400, detail="The link must be a plain https URL that returns to Clawbits"
        )
    link_id = secrets.token_hex(16)
    link = McpSignInLink(agent_id=agent.agent_id.value, **body.model_dump())
    redis = await get_bus().redis_client()
    await redis.set(_key("link", link_id), link.model_dump_json(), ex=LINK_LIFETIME)
    replaced = await redis.set(
        _key("latest", link.agent_id, link.server), link_id, ex=CONNECTED_LIFETIME, get=True
    )
    if replaced:
        await redis.delete(_key("link", replaced))
    return McpSignInUrl(url=f"{_frontend_root()}/connect/{link_id}")


@mcp_oauth_router.get("/api/human/mcp-oauth/links/{link_id}", response_model=McpSignInLinkView)
async def view_mcp_sign_in_link(
    link_id: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
) -> McpSignInLinkView:
    """What a connect card shows, all of it from the registering agent and its link."""
    link = await _link(link_id)
    return McpSignInLinkView(
        agent_name=await asyncio.to_thread(_agent_name, request, link.agent_id),
        server=link.server,
        host=urlsplit(link.url).hostname or "",
        status=await _status(link_id, link),
    )


@mcp_oauth_router.post("/api/human/mcp-oauth/links/{link_id}/claim", response_model=McpSignInUrl)
async def claim_mcp_sign_in(
    link_id: str,
    body: McpSignInClaimRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
) -> McpSignInUrl:
    """The provider page to open, with a state only this click holds; the click restarts the link's clock."""
    link = await _link(link_id)
    if (status := await _status(link_id, link)) != "open":
        raise HTTPException(status_code=409, detail=f"This link is already {status}")
    await asyncio.to_thread(_agent_name, request, link.agent_id, user["id"])
    scheme = {"web": "", "desktop": f"{_desktop_url_scheme()}.", "mobile": "clawbits."}[body.client]
    state = scheme + secrets.token_urlsafe(32)
    claim = McpSignInClaim(human_id=user["id"], link_id=link_id)
    redis = await get_bus().redis_client()
    await redis.set(_key("claim", state), claim.model_dump_json(), ex=LINK_LIFETIME)
    await redis.expire(_key("link", link_id), LINK_LIFETIME)
    return McpSignInUrl(url=re.sub(r"(?<=[?&])state=[^&#]*", f"state={state}", link.url))


@mcp_oauth_router.post("/api/human/mcp-oauth/callback", response_model=McpSignInResponse)
async def complete_mcp_sign_in(
    body: McpSignInRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
) -> McpSignInResponse:
    """Hand the code to the agent; its report, not this request, marks the link connected."""
    bus = get_bus()
    redis = await bus.redis_client()
    held = await redis.get(_key("claim", body.state))
    claim = McpSignInClaim.model_validate_json(held) if held else None
    if (
        claim is None
        or claim.human_id != user["id"]
        or not await redis.delete(_key("claim", body.state))
    ):
        raise HTTPException(
            status_code=409, detail="Start this sign-in from the Connect card in the chat"
        )
    link = await _link(claim.link_id)
    if link.connected:
        raise HTTPException(status_code=409, detail="This link is already connected")
    agent_name = await asyncio.to_thread(_agent_name, request, link.agent_id, user["id"])
    connecting = _key("connecting", claim.link_id)
    if not await redis.set(connecting, body.state, nx=True, ex=CONNECTING_LIFETIME):
        raise HTTPException(status_code=409, detail="This link is already connecting")
    pending = _key("pending", link.agent_id, body.state)
    await redis.set(pending, claim.link_id, ex=LINK_LIFETIME)
    data = {
        **body.model_dump(),
        "server": link.server,
        "channel_id": link.channel_id,
        "human_id": user["id"],
    }
    if not await bus.publish(agent_topic(link.agent_id), {"type": "mcp.oauth.code", "data": data}):
        await redis.delete(pending, connecting)
        raise HTTPException(
            status_code=409, detail=f"{agent_name} is offline. Try again once it is back."
        )
    return McpSignInResponse(channel_id=link.channel_id)


@mcp_oauth_router.post("/api/agentic/mcp-oauth/result", status_code=204, response_class=Response)
async def report_mcp_sign_in(
    body: McpSignInResult,
    request: Request,
    api_key: str = Security(api_key_header),
) -> Response:
    """The plugin's verdict on a code it was handed, accepted only from the agent the code went to. Success
    marks the link connected even after its lock lapsed; either way the lock this sign-in holds is released."""
    agent = await asyncio.to_thread(extract_agent, request.app._engine, api_key)
    redis = await get_bus().redis_client()
    link_id = await redis.getdel(_key("pending", agent.agent_id.value, body.state))
    if link_id is None:
        return Response(status_code=204)
    held = await redis.get(_key("link", link_id))
    if held and body.connected:
        link = McpSignInLink.model_validate_json(held).model_copy(update={"connected": True})
        await redis.set(
            _key("link", link_id), link.model_dump_json(), ex=CONNECTED_LIFETIME, xx=True
        )
    if await redis.get(_key("connecting", link_id)) == body.state:
        await redis.delete(_key("connecting", link_id))
    return Response(status_code=204)
