"""Hosted MCP sign-in: the provider returns to ``<app>/oauth/mcp/callback/<agent>/<server>``, a click
on the link the agent's plugin registered gets a fresh state bound to the clicking human, and the
callback relays the code over the agent's WebSocket and waits for the plugin's verdict."""

import asyncio
import re
import secrets
from datetime import timedelta
from urllib.parse import parse_qs, urlsplit

from fastapi import APIRouter, Depends, HTTPException, Request, Response, Security
from fastapi.security import APIKeyHeader
from sqlmodel import Session

from clawbits.datastructures.mcp_oauth_models import (
    MCP_SERVER,
    OAUTH_STATE,
    McpSignInClaim,
    McpSignInClaimRequest,
    McpSignInLink,
    McpSignInRequest,
    McpSignInResponse,
    McpSignInResult,
)
from clawbits.db.models import MmPost
from clawbits.db.table_read import TableRead
from clawbits.fastapi.agent_auth import extract_agent
from clawbits.fastapi.human_endpoints import _get_db
from clawbits.fastapi.workos_auth import _frontend_root, get_current_human_user
from clawbits.realtime import agent_topic, get_bus

mcp_oauth_router = APIRouter(tags=["MCP sign-in"])
api_key_header = APIKeyHeader(name="Authorization", auto_error=False)

LINK_LIFETIME = timedelta(minutes=30)
RESULT_TIMEOUT_SECONDS = 30


def mcp_oauth_redirect_url(agent_id: str) -> str:
    return f"{_frontend_root()}/oauth/mcp/callback/{agent_id}"


def _key(kind: str, agent_id: str, state: str) -> str:
    return f"mcp_oauth:{kind}:{agent_id}:{state}"


def _sign_in_link(url: str) -> tuple[str, str, str]:
    """The agent, server and state of an authorization URL that returns to our callback."""
    query = parse_qs(urlsplit(url).query)
    state = next(iter(query.get("state", [])), "")
    redirect = next(iter(query.get("redirect_uri", [])), "")
    route = re.fullmatch(rf"{re.escape(_frontend_root())}/oauth/mcp/callback/([^/]+)/({MCP_SERVER})", redirect)
    if not route or not re.fullmatch(OAUTH_STATE, state):
        raise HTTPException(status_code=400, detail="Not an agent sign-in link")
    return route[1], route[2], state


def _require_manager(db: Session, agent_id: str, human_id: int) -> None:
    if not TableRead.can_manage_agent_contacts(db, agent_id, human_id):
        raise HTTPException(status_code=403, detail="Only the agent's operator or an org admin can sign it in")


def _agent_name(request: Request, agent_id: str, human_id: int) -> str:
    with _get_db(request) as db:
        _require_manager(db, agent_id, human_id)
        return TableRead.resolve_agent_display(db, agent_id)


def _link_channel(request: Request, agent_id: str, state: str, post_id: int, human_id: int) -> str:
    """The channel of the agent's own message carrying the link, if the human may manage the agent."""
    with _get_db(request) as db:
        _require_manager(db, agent_id, human_id)
        post = db.get(MmPost, post_id)
        if post is None or post.agent_id != agent_id or f"state={state}" not in post.message:
            raise HTTPException(status_code=404, detail="Open the sign-in link from the agent's own message")
        return post.channel_id


@mcp_oauth_router.post("/api/agentic/mcp-oauth/links", status_code=204, response_class=Response)
async def register_mcp_sign_in_link(
    body: McpSignInLink,
    request: Request,
    api_key: str = Security(api_key_header),
) -> Response:
    """An authorization URL the agent's own MCP login printed."""
    agent = await asyncio.to_thread(extract_agent, request.app._engine, api_key)
    agent_id, _, state = _sign_in_link(body.url)
    if agent_id != agent.agent_id.value:
        raise HTTPException(status_code=403, detail="The link returns to another agent")
    redis = await get_bus().redis_client()
    await redis.set(_key("link", agent_id, state), body.url, ex=LINK_LIFETIME)
    return Response(status_code=204)


@mcp_oauth_router.post("/api/human/mcp-oauth/claim", response_model=McpSignInLink)
async def claim_mcp_sign_in(
    body: McpSignInClaimRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
) -> McpSignInLink:
    """The registered link behind a clicked one, with a state only this click holds."""
    agent_id, _, state = _sign_in_link(body.url)
    channel_id = await asyncio.to_thread(_link_channel, request, agent_id, state, body.post_id, user["id"])
    redis = await get_bus().redis_client()
    registered = await redis.get(_key("link", agent_id, state))
    if registered is None:
        raise HTTPException(status_code=404, detail="This sign-in link expired. Ask the agent for a new one.")
    fresh = secrets.token_urlsafe(32)
    claim = McpSignInClaim(human_id=user["id"], server=_sign_in_link(registered)[1], channel_id=channel_id)
    await redis.set(_key("claim", agent_id, fresh), claim.model_dump_json(), ex=LINK_LIFETIME)
    return McpSignInLink(url=re.sub(r"(?<=[?&])state=[^&#]*", f"state={fresh}", registered))


@mcp_oauth_router.post("/api/human/mcp-oauth/callback", response_model=McpSignInResponse)
async def complete_mcp_sign_in(
    body: McpSignInRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
) -> McpSignInResponse:
    """Relay the code to the agent and return its verdict."""
    agent_name = await asyncio.to_thread(_agent_name, request, body.agent_id, user["id"])
    bus = get_bus()
    redis = await bus.redis_client()
    claim_key = _key("claim", body.agent_id, body.state)
    held = await redis.getdel(claim_key)
    claim = McpSignInClaim.model_validate_json(held) if held else None
    if claim is None or claim.human_id != user["id"] or claim.server != body.server:
        raise HTTPException(status_code=409, detail="Start this sign-in from its link in the chat")
    data = {**body.model_dump(exclude={"agent_id"}), "channel_id": claim.channel_id, "human_id": user["id"]}
    if not await bus.publish(agent_topic(body.agent_id), {"type": "mcp.oauth.code", "data": data}):
        await redis.set(claim_key, held, ex=LINK_LIFETIME)
        raise HTTPException(status_code=409, detail=f"{agent_name} is not connected")
    reply = await redis.blpop([_key("result", body.agent_id, body.state)], timeout=RESULT_TIMEOUT_SECONDS)
    if reply is None:
        raise HTTPException(status_code=504, detail=f"{agent_name} did not confirm the sign-in")
    if not McpSignInResult.model_validate_json(reply[1]).connected:
        raise HTTPException(status_code=502, detail=f"{agent_name} could not finish the sign-in")
    return McpSignInResponse(agent_name=agent_name, channel_id=claim.channel_id)


@mcp_oauth_router.post("/api/agentic/mcp-oauth/result", status_code=204, response_class=Response)
async def report_mcp_sign_in(
    body: McpSignInResult,
    request: Request,
    api_key: str = Security(api_key_header),
) -> Response:
    """The plugin's verdict on a code it was handed, keyed by the reporting agent."""
    agent = await asyncio.to_thread(extract_agent, request.app._engine, api_key)
    redis = await get_bus().redis_client()
    key = _key("result", agent.agent_id.value, body.state)
    await redis.rpush(key, body.model_dump_json())
    await redis.expire(key, RESULT_TIMEOUT_SECONDS)
    return Response(status_code=204)
