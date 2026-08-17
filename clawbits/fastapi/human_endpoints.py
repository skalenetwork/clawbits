# clawbits/fastapi/human_endpoints.py
"""Human-facing data endpoints.

Authentication itself (magic auth + social OAuth) lives in
:mod:`clawbits.fastapi.workos_auth`; this module imports the
:func:`get_current_human_user` dependency from there directly.
"""

import asyncio
import logging
import time
import uuid as _uuid
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.concurrency import run_in_threadpool
from imapclient.exceptions import LoginError
from pydantic import BaseModel, ConfigDict, Field
from sqlmodel import Session

from clawbits import audit
from clawbits.automations import SpecValidationError, validate_spec
from clawbits.avatars.payloads import avatar_ref_for_agent, avatar_ref_for_user
from clawbits.datastructures.action_models import (
    ActionListItem,
    ActionListResponse,
    ActionResponse,
    AgentActionsResponse,
)
from clawbits.datastructures.agent_id import AgentId  # noqa: F401  (used elsewhere)
from clawbits.datastructures.avatar_models import AvatarRef
from clawbits.datastructures.challenge_question_response import ChallengeQuestionResponse
from clawbits.datastructures.email_models import (
    EmailCountResponse,
    EmailDetailResponse,
    EmailListResponse,
    EmailSetReadRequest,
    EmailSummaryResponse,
)
from clawbits.datastructures.known_answers import get_random_question_answer
from clawbits.datastructures.mm_models import (
    GlobalUserStatus,
    PrivacyModeRequest,
    PrivacyModeResponse,
    PrivacySettingsRequest,
    PrivacySettingsResponse,
)
from clawbits.datastructures.org_models import (
    AddOrgMemberRequest,
    CreateOrgRequest,
    OrgAttentionResponse,
    OrgListResponse,
    OrgLobstertalkChannelResponse,
    OrgLobstertalkHealthResponse,
    OrgLobstertalkResponse,
    OrgMemberResponse,
    OrgMembersListResponse,
    OrgResponse,
    ReefConnectionResponse,
    SetOrgAttentionRequest,
    SetOrgLobstertalkChannelRequest,
    SetOrgLobstertalkRequest,
    SetReefConnectionRequest,
    UpdateOrgMemberRoleRequest,
)
from clawbits.db.models import DISPLAY_NAME_MAX_LENGTH
from clawbits.db.table_read import TableRead
from clawbits.db.table_write import TableWrite, UserDeletionBlocked
from clawbits.email.imap_client import (
    STALWART_SVC_PASSWORD,
    agent_email_address,
    delete_email,
    get_email,
    get_email_counts,
    list_emails,
    set_email_read,
)
from clawbits.fastapi.session_cookie import stage_session_clear
from clawbits.fastapi.workos_auth import get_current_human_user
from clawbits.lobstertalk.attention.crypto import (
    EphemeralSecretsKeyError,
    decrypt_secret,
    encrypt_secret,
)
from clawbits.lobstertalk.attention.gate import (
    cooldown_seconds as attention_cooldown_default,
)
from clawbits.lobstertalk.attention.triage import (
    LlmTriageConfig,
    check_endpoint_allowed,
    probe_llm_endpoint,
)
from clawbits.realtime import (
    fire_and_forget,
    get_bus,
    publish_automation_sync,
    publish_org_added,
    publish_org_updated,
)
from clawbits.ssrf import HostResolutionError, PrivateAddressError, arun_guarded

# ---------------------------------------------------------------------------
# Response models still used by data endpoints
# ---------------------------------------------------------------------------


class HumanUserResponse(BaseModel):
    id: int
    email: str
    display_name: str | None
    avatar: AvatarRef | None = None


class UpdateProfileRequest(BaseModel):
    display_name: str | None = Field(default=None, max_length=DISPLAY_NAME_MAX_LENGTH)


# ---------------------------------------------------------------------------
# Tiny request-scoped helper — exported for human_mm_endpoints to share.
# ---------------------------------------------------------------------------


def _get_db(request: Request) -> Session:
    return Session(request.app._engine)


# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------

logger = logging.getLogger(__name__)

# How long a save waits on resolving an org-supplied LLM host before giving up
# and letting the (authoritative) call-time check decide. The resolver thread
# can't be cancelled, so this bounds the *request*, not the lookup.
ENDPOINT_CHECK_TIMEOUT_SECONDS = 5.0

# --- Lightweight in-process rate limiting -----------------------------------
# The LobsterTalk save/healthcheck endpoints are owner-only but self-service: a
# save resolves a caller-chosen DNS name (a slow nameserver ties up a resolver
# slot) and a healthcheck spends a metered LLM call. Neither should be free to
# hammer. This is a per-process sliding window keyed by org — with ``--workers
# N`` the real ceiling is N× these numbers, which is fine for what it guards
# (one owner looping an endpoint) and costs no Redis round-trip on the hot path.
_RATE_BUCKETS: dict[str, list[float]] = {}
_LOBSTERTALK_SAVE_LIMIT = 20
_LOBSTERTALK_HEALTH_LIMIT = 6  # spends a metered LLM call — tighter than saves
_LOBSTERTALK_RATE_WINDOW_S = 60.0


def _rate_limit(key: str, *, limit: int, window_s: float = _LOBSTERTALK_RATE_WINDOW_S) -> None:
    """Raise 429 when ``key`` has already been hit ``limit`` times in the last
    ``window_s`` seconds; otherwise record this hit and return. Buckets that
    fall empty are dropped so the map can't grow without bound across orgs."""
    now = time.monotonic()
    cutoff = now - window_s
    hits = [t for t in _RATE_BUCKETS.get(key, ()) if t >= cutoff]
    if len(hits) >= limit:
        # The retry hint rides in the detail, not a Retry-After header: the
        # app's global HTTPException handler rebuilds the response and drops
        # exc.headers, so a header here would never reach the client.
        retry = max(1, int(window_s - (now - hits[0])))
        raise HTTPException(status_code=429, detail=f"Too many requests; retry in ~{retry}s")
    hits.append(now)
    _RATE_BUCKETS[key] = hits


human_router = APIRouter(tags=["Human"])


def _settings_response(row) -> PrivacySettingsResponse:
    return PrivacySettingsResponse(
        last_seen_visible=row.last_seen_visible,
        online_status_visible=row.online_status_visible,
        read_receipts_enabled=row.read_receipts_enabled,
        typing_indicators_enabled=row.typing_indicators_enabled,
    )


@human_router.get(
    "/api/human/privacy-settings", response_model=PrivacySettingsResponse
)
def get_privacy_settings(
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Return the calling human's four per-signal privacy flags."""
    from clawbits.db.models import HumanUser as _HumanUserRow
    with _get_db(request) as db:
        row = db.get(_HumanUserRow, int(user["id"]))
        if row is None:
            raise HTTPException(status_code=404, detail="User not found")
        return _settings_response(row)


@human_router.patch(
    "/api/human/privacy-settings", response_model=PrivacySettingsResponse
)
async def update_privacy_settings(
    body: PrivacySettingsRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Apply a partial update to the four per-signal privacy flags.

    Only fields present in the request body are written; absent keys
    leave the existing value untouched. When the change affects
    ``online_status_visible`` or ``last_seen_visible`` we re-broadcast
    the user's current presence on the SSE bus so peers see the new
    visibility immediately (no need to wait for the next heartbeat).
    """
    human_id = int(user["id"])
    with _get_db(request) as db:
        row = TableWrite.set_human_privacy_settings(
            db,
            human_id,
            last_seen_visible=body.last_seen_visible,
            online_status_visible=body.online_status_visible,
            read_receipts_enabled=body.read_receipts_enabled,
            typing_indicators_enabled=body.typing_indicators_enabled,
        )
        db.commit()
        response = _settings_response(row)
        channel_ids = TableRead.get_mm_channel_ids_for_human(db, human_id)
        fellow_ids = TableRead.get_fellow_human_ids(db, human_id)
        fresh = TableRead.get_human_user_by_id(db, human_id)

    # Re-broadcast the user's current presence so peers see the new
    # visibility immediately. We only need to do this when the change
    # affects what *peers* see — read receipts / typing indicators
    # take effect on the next event without a re-broadcast.
    if (
        body.online_status_visible is not None
        or body.last_seen_visible is not None
    ) and fresh is not None:
        from clawbits.fastapi.human_mm_endpoints import _resolve_presence_view
        from clawbits.realtime import publish_user_status

        bus = get_bus()
        raw_status: GlobalUserStatus = await bus.user_presence_get(human_id)
        out_status, out_last_seen, out_label = _resolve_presence_view(fresh, raw_status)
        fire_and_forget(
            publish_user_status(
                bus,
                human_id,
                out_status,
                out_last_seen,
                channel_ids,
                fellow_ids,
                last_seen_label=out_label,
            )
        )
    return response


@human_router.post("/api/human/privacy-mode", response_model=PrivacyModeResponse)
async def set_privacy_mode(
    body: PrivacyModeRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Enable or disable DB-backed privacy mode for current human.

    Enable: force-broadcast ``idle`` so peers immediately mask the user's
    real status, and return ``idle`` in the response so the caller's UI
    flips in lockstep.

    Disable: don't lie. The bus has been pinned to ``idle`` for the
    duration of privacy, so it can't tell us the user's true current
    state — the next ``/presence`` heartbeat (which the active tab
    emits within seconds) will publish the truthful transition. We
    broadcast based on the bus's current value so peers see the same
    status the caller does, and respond with that value rather than a
    hardcoded ``idle``. If the bus had already TTL'd to ``offline``
    (silent disconnect), peers see ``offline``; otherwise they keep
    seeing ``idle`` for the few seconds until the next heartbeat.
    """
    human_id = int(user["id"])
    with _get_db(request) as db:
        TableWrite.set_human_privacy_mode(db, human_id, body.enabled)
        db.commit()
        channel_ids = TableRead.get_mm_channel_ids_for_human(db, human_id)
        fellow_ids = TableRead.get_fellow_human_ids(db, human_id)
        fresh = TableRead.get_human_user_by_id(db, human_id)

    from clawbits.fastapi.human_mm_endpoints import _resolve_presence_view
    from clawbits.realtime import fire_and_forget, get_bus, publish_user_status

    bus = get_bus()
    # ``user_presence_get`` resolves missing keys to ``offline`` so we
    # always have a real ``GlobalUserStatus`` to feed the resolver.
    raw_status: GlobalUserStatus = await bus.user_presence_get(human_id)
    out_status, out_last_seen, out_label = _resolve_presence_view(fresh, raw_status)

    fire_and_forget(
        publish_user_status(
            bus,
            human_id,
            out_status,
            out_last_seen,
            channel_ids,
            fellow_ids,
            last_seen_label=out_label,
        )
    )
    return PrivacyModeResponse(
        human_id=human_id,
        enabled=body.enabled,
        status=out_status,
        last_seen_at=out_last_seen,
    )


@human_router.patch("/api/human/me", response_model=HumanUserResponse)
async def update_me(
    body: UpdateProfileRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Update the current user's profile (display name)."""
    with _get_db(request) as db:
        new_display_name = body.display_name.strip() if body.display_name is not None else None
        if new_display_name == "":
            new_display_name = None
        TableWrite.update_human_display_name(db, user["id"], new_display_name)
        updated = TableRead.get_human_user_by_id(db, user["id"])
        db.commit()
        return HumanUserResponse(
            id=updated["id"],
            email=updated["email"],
            display_name=updated["display_name"],
            avatar=avatar_ref_for_user(
                user_id=updated["id"],
                version=updated["avatar_version"],
                kind=updated["avatar_kind"],
            ),
        )


# ---------------------------------------------------------------------------
# Data endpoints for the human dashboard
# ---------------------------------------------------------------------------

def _verify_org_membership(db, org_id: str, user: dict) -> None:
    """Verify the caller is a member of the given organization."""
    if not TableRead.is_org_member(db, org_id, user["id"]):
        raise HTTPException(status_code=403, detail="Not a member of this organization")


def _verify_agent_in_org(db, org_id: str, agent_id: str) -> None:
    """Verify the agent is associated with the given organization."""
    if not TableRead.is_agent_in_org(db, agent_id, org_id):
        raise HTTPException(status_code=404, detail="Agent not found in this organization")


def _require_agent_operator(db, agent_id: str, user: dict) -> None:
    """Verify the caller operates the agent — stricter than org membership.

    Mail an agent receives is sensitive, so the inbox is operator-only: org
    membership alone is not enough (same gate as the agent-settings PATCH)."""
    if not TableRead.is_agent_operator(db, agent_id, user["id"]):
        raise HTTPException(
            status_code=403,
            detail="Only the agent's operator can access its inbox",
        )


def _operator_payload(db, operator_id: int | None) -> dict | None:
    """Owner (operator) display payload — id + name + avatar — for agent cards
    and the agent profile. ``None`` when the agent is unbound or the human row
    is missing."""
    if operator_id is None:
        return None
    human = TableRead.get_human_user_by_id(db, operator_id)
    if human is None:
        return None
    return {
        "human_id": human["id"],
        "display_name": human["display_name"],
        "avatar": avatar_ref_for_user(
            user_id=human["id"],
            version=human["avatar_version"],
            kind=human["avatar_kind"],
        ).model_dump(),
    }


@human_router.get("/api/human/orgs/{org_id}/agents")
async def list_agents(
    org_id: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """List agents owned by an organization. Caller must be an org member."""
    from clawbits.db.models import Agent as _AgentRow
    from clawbits.db.models import AgentProfile as _ProfileRow

    with _get_db(request) as db:
        _verify_org_membership(db, org_id, user)
        agent_ids = TableRead.get_agents_owned_by_org(db, org_id)
        agents = []
        for aid in agent_ids:
            # Pull the avatar fields straight off the row — cheaper than
            # going through the granular ``TableRead.get_agent_*`` getters
            # for kind/version, and one ``session.get`` is dedup'd in the
            # SQLAlchemy identity map anyway.
            row = db.get(_AgentRow, aid)
            prof = db.get(_ProfileRow, aid)
            avatar = (
                avatar_ref_for_agent(
                    agent_id=aid, version=row.avatar_version, kind=row.avatar_kind
                ).model_dump()
                if row is not None
                else None
            )
            # Resolve the operator (owner) for display: name + avatar so the
            # card can show "Owned by …". ``identity map`` dedups the get.
            operator = _operator_payload(db, row.operator_id if row is not None else None)
            agents.append({
                "agent_id": aid,
                "nickname": TableRead.get_agent_nickname(db, AgentId(aid)),
                "display_name": TableRead.get_agent_profile_display_name(db, aid),
                "creation_time": TableRead.get_agent_creation_time(db, AgentId(aid)),
                # Last heartbeat → the client derives available/offline/setup and
                # ticks the dot locally past the 40-min window.
                "last_alive_at": TableRead.get_agent_last_alive(db, AgentId(aid)),
                "file_count": TableRead.get_agent_file_count(db, AgentId(aid)),
                "description": prof.description if prof else None,
                "description_source": prof.description_source if prof else None,
                "description_regen_pending": (
                    bool(prof.description_regen_requested_at) if prof else False
                ),
                "inter_agent_mode_enabled": (
                    bool(row.inter_agent_mode_enabled) if row is not None else False
                ),
                "snoozed": bool(row.snoozed) if row is not None else False,
                "inter_agent_message_limit": (
                    int(row.inter_agent_message_limit) if row is not None else 10
                ),
                "is_operator": TableRead.is_agent_operator(db, aid, user["id"]),
                # Contact is closed by default — surface the viewer's grants so
                # the UI can disable "New DM"/tagging it can't perform anyway.
                "can_dm": TableRead.can_dm_agent(db, aid, human_id=user["id"]),
                "can_tag": TableRead.can_tag_agent(db, aid, human_id=user["id"]),
                "can_manage_contacts": TableRead.can_manage_agent_contacts(
                    db, aid, user["id"]
                ),
                "operator": operator,
                "avatar": avatar,
                # If provisioned via "Run on Reef", the reef VM it runs in (the
                # reef base URL is the org's ``reef_api_url``). NULL otherwise.
                "reef_sandbox_id": row.reef_sandbox_id if row is not None else None,
                # Self-reported by the plugin on its liveness ping — runtime kind
                # + Clawbits plugin version, for the card's "spec" stickers. NULL
                # until the first modern ping.
                "agent_type": row.agent_type if row is not None else None,
                "plugin_version": row.plugin_version if row is not None else None,
            })
        return {"agents": agents, "total": len(agents)}


# ---------------------------------------------------------------------------
# Agent AI-usage dashboard (self-reported telemetry)
# ---------------------------------------------------------------------------

_USAGE_RANGE_KEYS = ("day", "week", "month", "all")


def _usage_zero_totals() -> dict:
    return {
        "input_tokens": 0,
        "output_tokens": 0,
        "cache_read_tokens": 0,
        "cache_write_tokens": 0,
        # NULL until a costed event exists — the UI shows tokens always and
        # ``$`` only when non-null (OAuth/subscription agents report no cost).
        "cost_usd": None,
        "call_count": 0,
    }


def _fold_usage(total: dict, row: dict) -> None:
    for key in (
        "input_tokens",
        "output_tokens",
        "cache_read_tokens",
        "cache_write_tokens",
        "call_count",
    ):
        total[key] += row[key]
    if row["cost_usd"] is not None:
        total["cost_usd"] = (total["cost_usd"] or 0.0) + row["cost_usd"]


def _usage_per_model(rows: list[dict]) -> list[dict]:
    """Collapse (agent, model, provider) sums into a per-model view,
    biggest token totals first."""
    by_model: dict[tuple, dict] = {}
    for r in rows:
        agg = by_model.setdefault(
            (r["model"], r["provider"]),
            {"model": r["model"], "provider": r["provider"], **_usage_zero_totals()},
        )
        _fold_usage(agg, r)
    return sorted(
        by_model.values(),
        key=lambda m: m["input_tokens"] + m["output_tokens"],
        reverse=True,
    )


def _usage_range_or_400(range_key: str):
    if range_key not in _USAGE_RANGE_KEYS:
        raise HTTPException(
            status_code=400, detail="range must be one of day|week|month|all"
        )
    return TableRead.usage_range_start(range_key)


@human_router.get("/api/human/orgs/{org_id}/usage")
async def get_org_usage(
    org_id: str,
    request: Request,
    range_key: str = Query("week", alias="range"),
    group_by: str = Query("agent"),
    user: dict = Depends(get_current_human_user),
):
    """Org-wide AI token usage — agent-self-reported, advisory telemetry.

    RBAC is enforced here, never client-side: org **owners** get the full
    per-agent breakdown (BYO-key agents included); **members** get org totals
    (plus the per-model view when asked) only. The numbers are whatever each
    agent's plugin reported over its outbound lane — observability, not
    metering; never a billing input. Non-reporting agents stay on the roster
    as "no data" so totals are never silently short. See
    ``docs/protocol/AGENT_USAGE_TRACKING_PLAN.md``.
    """
    from clawbits.db.models import AGENT_USAGE_SCHEMA_VERSION

    since = _usage_range_or_400(range_key)
    if group_by not in ("agent", "model"):
        raise HTTPException(status_code=400, detail="group_by must be agent or model")

    with _get_db(request) as db:
        _verify_org_membership(db, org_id, user)
        is_owner = TableRead.get_org_member_role(db, org_id, user["id"]) == "owner"
        rows = TableRead.get_org_usage_rows(db, org_id, since)

        org_total = _usage_zero_totals()
        for r in rows:
            _fold_usage(org_total, r)

        # Daily series for the trend chart. Members see org-level day totals;
        # owners additionally get the per-agent split (headline tokens) that
        # drives the stacked bars + per-agent sparklines.
        daily_rows = TableRead.get_org_usage_daily_rows(db, org_id, since)
        by_day: dict[str, dict] = {}
        for r in daily_rows:
            day = by_day.setdefault(
                r["date"], {"date": r["date"], **_usage_zero_totals(), "by_agent": {}}
            )
            _fold_usage(day, r)
            day["by_agent"][r["agent_id"]] = (
                day["by_agent"].get(r["agent_id"], 0)
                + r["input_tokens"]
                + r["output_tokens"]
            )
        daily = sorted(by_day.values(), key=lambda d: d["date"])
        if not is_owner:
            for day in daily:
                day.pop("by_agent", None)

        payload: dict = {
            "schema_version": AGENT_USAGE_SCHEMA_VERSION,
            "range": range_key,
            "role": "owner" if is_owner else "member",
            "org_total": org_total,
            "daily": daily,
        }
        if group_by == "model":
            payload["per_model"] = _usage_per_model(rows)
        if not is_owner:
            return payload

        # Owner view: the full roster joined with the window's sums, so
        # agents that never reported render as "no data" instead of
        # disappearing.
        by_agent: dict[str, dict] = {}
        models_by_agent: dict[str, dict[str, int]] = {}
        for r in rows:
            agg = by_agent.setdefault(r["agent_id"], _usage_zero_totals())
            _fold_usage(agg, r)
            per_model = models_by_agent.setdefault(r["agent_id"], {})
            per_model[r["model"]] = (
                per_model.get(r["model"], 0)
                + r["input_tokens"]
                + r["output_tokens"]
            )
        reporting_ids = TableRead.get_reporting_agent_ids(db, org_id)
        per_agent = []
        for aid in TableRead.get_agents_owned_by_org(db, org_id):
            totals = by_agent.get(aid, _usage_zero_totals())
            top_models = sorted(
                models_by_agent.get(aid, {}).items(),
                key=lambda kv: kv[1],
                reverse=True,
            )
            per_agent.append(
                {
                    "agent_id": aid,
                    "nickname": TableRead.get_agent_nickname(db, AgentId(aid)),
                    "display_name": TableRead.get_agent_profile_display_name(
                        db, aid
                    ),
                    "reporting": aid in reporting_ids,
                    **totals,
                    "top_models": [m for m, _ in top_models[:3]],
                }
            )
        per_agent.sort(
            key=lambda a: a["input_tokens"] + a["output_tokens"], reverse=True
        )
        payload["per_agent"] = per_agent
        return payload


@human_router.get("/api/human/orgs/{org_id}/agents/{agent_id}/usage")
async def get_agent_usage(
    org_id: str,
    agent_id: str,
    request: Request,
    range_key: str = Query("week", alias="range"),
    user: dict = Depends(get_current_human_user),
):
    """One agent's AI usage — org owners or the agent's operator only.

    Same advisory-telemetry caveats as the org endpoint; a plain org member
    who doesn't operate this agent gets a 403 (members see org totals only).
    """
    from clawbits.db.models import AGENT_USAGE_SCHEMA_VERSION

    since = _usage_range_or_400(range_key)
    with _get_db(request) as db:
        _verify_org_membership(db, org_id, user)
        _verify_agent_in_org(db, org_id, agent_id)
        is_owner = TableRead.get_org_member_role(db, org_id, user["id"]) == "owner"
        if not is_owner and not TableRead.is_agent_operator(db, agent_id, user["id"]):
            raise HTTPException(
                status_code=403,
                detail="Only org admins or the agent's operator can view its usage",
            )
        rows = TableRead.get_agent_usage_rows(db, agent_id, since)
        total = _usage_zero_totals()
        for r in rows:
            _fold_usage(total, r)
        reporting = bool(rows) or bool(
            TableRead.get_agent_usage_rows(db, agent_id, None)
        )
        return {
            "schema_version": AGENT_USAGE_SCHEMA_VERSION,
            "range": range_key,
            "agent_id": agent_id,
            "reporting": reporting,
            "total": total,
            "per_model": _usage_per_model(rows),
        }


@human_router.delete("/api/human/orgs/{org_id}/agents/{agent_id}")
async def remove_agent_from_org(
    org_id: str,
    agent_id: str,
    request: Request,
    keep_content: bool = False,
    user: dict = Depends(get_current_human_user),
):
    """Hard-delete an agent. Caller must be a member of the org the agent
    belongs to. The operator and any other org member can trigger this —
    org members who aren't the operator have *only* this power over the
    agent.

    When ``keep_content=true`` the agent's authored content (messages, posts,
    files, reactions, comments, likes) is reattributed to a shared
    "Deleted agent" placeholder instead of being deleted, so conversation
    history survives for other channel members. The default deletes
    everything the agent created."""
    with _get_db(request) as db:
        _verify_org_membership(db, org_id, user)
        _verify_agent_in_org(db, org_id, agent_id)
        TableWrite.delete_agent(db, agent_id, keep_content=keep_content)
        db.commit()
    # Best-effort mailbox cleanup after the DB delete commits; never block the
    # delete on the mail server being reachable.
    try:
        from clawbits.email.stalwart_provision import deprovision_mailbox

        deprovision_mailbox(agent_id)
    except Exception:
        logger.exception("Failed to deprovision Stalwart mailbox for %s", agent_id)
    return {"agent_id": agent_id, "org_id": org_id, "deleted": True}


@human_router.delete("/api/human/account", status_code=204)
async def delete_my_account(
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Permanently delete the authenticated user's account and all of their
    data. Self-service only — there is no admin-deletes-others path.

    Refuses with 409 while the user still operates agents or is the sole
    owner of an organization that has other members; the error message says
    what to resolve first. On success the session cookies are cleared so the
    client is logged out immediately.
    """
    with _get_db(request) as db:
        try:
            deleted_workos_org_ids = TableWrite.delete_human_user(db, user["id"])
        except UserDeletionBlocked as e:
            raise HTTPException(status_code=409, detail=str(e)) from e
        db.commit()

    # WorkOS-side cleanup, best-effort and only after the local delete
    # committed. Deleting the user also drops its memberships WorkOS-side;
    # the orgs the user solely occupied are torn down too so they don't
    # linger empty (and can't be re-adopted on a future login).
    from clawbits.fastapi.workos_auth import (
        delete_workos_organization,
        delete_workos_user,
    )

    client = request.app.state.workos
    delete_workos_user(client, workos_user_id=user.get("workos_user_id") or "")
    for workos_org_id in deleted_workos_org_ids:
        delete_workos_organization(client, workos_org_id=workos_org_id)

    stage_session_clear(request)


@human_router.get("/api/human/orgs/{org_id}/agents/{agent_id}")
async def get_agent_profile(
    org_id: str,
    agent_id: str,
    request: Request,
    limit: int = 50,
    offset: int = 0,
    user: dict = Depends(get_current_human_user),
):
    """Get an agent's profile. Caller must be a member of the owning organization."""
    from clawbits.db.models import Agent as _AgentRow
    from clawbits.email.imap_client import agent_email_address

    with _get_db(request) as db:
        _verify_org_membership(db, org_id, user)
        _verify_agent_in_org(db, org_id, agent_id)
        agent = TableRead.get_agent_by_agentid(db, AgentId(agent_id))
        if agent is None:
            raise HTTPException(status_code=404, detail="Agent not found")
        creation_time = TableRead.get_agent_creation_time(db, AgentId(agent_id))
        files = TableRead.get_agent_files(db, AgentId(agent_id), limit=limit, offset=offset)
        file_count = TableRead.get_agent_file_count(db, AgentId(agent_id))
        posts = TableRead.get_agent_posts(db, AgentId(agent_id), limit=20, offset=0)
        profile = TableRead.get_agent_profile(db, agent_id) or {}
        action_count = TableRead.count_agent_actions_for_agent(db, agent_id)
        agent_row = db.get(_AgentRow, agent_id)
        inter_agent_mode = bool(
            agent_row.inter_agent_mode_enabled if agent_row else False
        )
        snoozed = bool(agent_row.snoozed if agent_row else False)
        inter_agent_message_limit = int(
            agent_row.inter_agent_message_limit if agent_row else 10
        )
        avatar = (
            avatar_ref_for_agent(
                agent_id=agent_id,
                version=agent_row.avatar_version,
                kind=agent_row.avatar_kind,
            ).model_dump()
            if agent_row is not None
            else None
        )
        return {
            "agent_id": agent_id,
            "email_address": agent_email_address(agent_id),
            "nickname": TableRead.get_agent_nickname(db, AgentId(agent_id)),
            "display_name": profile.get("display_name"),
            "bio": profile.get("bio"),
            "location": profile.get("location"),
            "website": profile.get("website"),
            "avatar_url": profile.get("avatar_url"),
            "header_url": profile.get("header_url"),
            "description": profile.get("description"),
            "description_generated_at": profile.get("description_generated_at"),
            "description_source": profile.get("description_source"),
            "description_regen_pending": bool(
                profile.get("description_regen_requested_at")
            ),
            "creation_time": creation_time,
            # Availability + owner, mirroring the agents-list payload so the
            # profile hero can show a status dot and "Owned by …".
            "last_alive_at": TableRead.get_agent_last_alive(db, AgentId(agent_id)),
            "operator": _operator_payload(
                db, agent_row.operator_id if agent_row else None
            ),
            "files": files,
            "file_count": file_count,
            "posts": posts,
            "action_count": action_count,
            "inter_agent_mode_enabled": inter_agent_mode,
            "snoozed": snoozed,
            "inter_agent_message_limit": inter_agent_message_limit,
            # LobsterTalk sidecar settings, mirroring the PATCH echo so the Manage
            # page can read current state (and hydrate its form).
            "lobstertalk_enabled": bool(
                agent_row.lobstertalk_enabled if agent_row else False
            ),
            "lobstertalk_ollama_host": (
                agent_row.lobstertalk_ollama_host if agent_row else None
            ),
            "lobstertalk_ollama_model": (
                agent_row.lobstertalk_ollama_model if agent_row else None
            ),
            "lobstertalk_interval_seconds": int(
                agent_row.lobstertalk_interval_seconds if agent_row else 60
            ),
            "lobstertalk_message_limit": int(
                agent_row.lobstertalk_message_limit if agent_row else 100
            ),
            "is_operator": TableRead.is_agent_operator(db, agent_id, user["id"]),
            # Contact is closed by default — see AgentContactPermission. These
            # let the profile disable the DM button / show the contacts panel.
            "can_dm": TableRead.can_dm_agent(db, agent_id, human_id=user["id"]),
            "can_tag": TableRead.can_tag_agent(db, agent_id, human_id=user["id"]),
            "can_manage_contacts": TableRead.can_manage_agent_contacts(
                db, agent_id, user["id"]
            ),
            "avatar": avatar,
            # Reef VM this agent runs in, if provisioned via "Run on Reef".
            "reef_sandbox_id": agent_row.reef_sandbox_id if agent_row else None,
            # Self-reported by the plugin on its liveness ping — runtime kind +
            # Clawbits plugin version, for the card's "spec" stickers.
            "agent_type": agent_row.agent_type if agent_row else None,
            "plugin_version": agent_row.plugin_version if agent_row else None,
        }


# ---------------------------------------------------------------------------
# Agent email inbox — operator-only. Lets the human who operates an agent read
# and delete the mail it receives at ``<agent_id>@<mail-domain>``.
#
# The IMAP client (clawbits.email.imap_client) is SYNCHRONOUS + blocking, but
# these handlers are ``async def`` — so every call is wrapped in
# ``run_in_threadpool`` to keep the event loop free. An agent can exist without
# a provisioned mailbox (signup provisioning is best-effort), in which case IMAP
# login raises ``LoginError``; the read endpoints catch that and degrade to a
# clean empty/zero payload rather than surfacing a 500.
# ---------------------------------------------------------------------------


@human_router.get(
    "/api/human/orgs/{org_id}/agents/{agent_id}/email/count",
    response_model=EmailCountResponse,
)
async def get_agent_email_count(
    org_id: str,
    agent_id: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
) -> EmailCountResponse:
    """Total + unread counts for the agent's mailbox. Operator-only.

    Returns zeroes (never 500) when email isn't configured or the mailbox
    hasn't been provisioned yet, so the UI shows a clean empty state."""
    with _get_db(request) as db:
        _verify_org_membership(db, org_id, user)
        _verify_agent_in_org(db, org_id, agent_id)
        _require_agent_operator(db, agent_id, user)
    empty = EmailCountResponse(
        total=0, unread=0, email_address=agent_email_address(agent_id)
    )
    if not STALWART_SVC_PASSWORD:
        return empty
    try:
        counts = await run_in_threadpool(get_email_counts, agent_id)
    except LoginError:
        return empty  # mailbox not provisioned yet
    except Exception:
        logger.exception("email count failed for %s", agent_id)
        raise HTTPException(status_code=500, detail="Failed to read mailbox")
    return EmailCountResponse(**counts)


@human_router.get(
    "/api/human/orgs/{org_id}/agents/{agent_id}/email/inbox",
    response_model=EmailListResponse,
)
async def get_agent_email_inbox(
    org_id: str,
    agent_id: str,
    request: Request,
    limit: int = 50,
    offset: int = 0,
    unread_only: bool = False,
    user: dict = Depends(get_current_human_user),
) -> EmailListResponse:
    """List the agent's inbox, newest first. Operator-only.

    With ``unread_only`` the listing (and ``total``) covers UNSEEN messages
    only. ``limit`` is clamped to 200 — each listing is a live IMAP fetch.
    Degrades to an empty list (never 500) when email isn't configured or the
    mailbox hasn't been provisioned yet."""
    with _get_db(request) as db:
        _verify_org_membership(db, org_id, user)
        _verify_agent_in_org(db, org_id, agent_id)
        _require_agent_operator(db, agent_id, user)
    limit = min(max(limit, 1), 200)
    empty = EmailListResponse(
        emails=[], total=0, unread_count=0, limit=limit, offset=offset
    )
    if not STALWART_SVC_PASSWORD:
        return empty
    try:
        result = await run_in_threadpool(list_emails, agent_id, limit, offset, unread_only)
    except LoginError:
        return empty  # mailbox not provisioned yet
    except Exception:
        logger.exception("email inbox failed for %s", agent_id)
        raise HTTPException(status_code=500, detail="Failed to read mailbox")
    return EmailListResponse(
        emails=[EmailSummaryResponse(**e) for e in result["emails"]],
        total=result["total"],
        unread_count=result["unread_count"],
        limit=result["limit"],
        offset=result["offset"],
    )


@human_router.get(
    "/api/human/orgs/{org_id}/agents/{agent_id}/email/{message_uid}",
    response_model=EmailDetailResponse,
)
async def get_agent_email_detail(
    org_id: str,
    agent_id: str,
    message_uid: int,
    request: Request,
    user: dict = Depends(get_current_human_user),
) -> EmailDetailResponse:
    """Fetch one message (body + attachments + headers). Marks it read.
    Operator-only."""
    with _get_db(request) as db:
        _verify_org_membership(db, org_id, user)
        _verify_agent_in_org(db, org_id, agent_id)
        _require_agent_operator(db, agent_id, user)
    if not STALWART_SVC_PASSWORD:
        raise HTTPException(status_code=503, detail="Email service not configured")
    try:
        result = await run_in_threadpool(get_email, agent_id, message_uid)
    except LoginError:
        raise HTTPException(
            status_code=404, detail=f"Email with UID {message_uid} not found"
        )
    except Exception:
        logger.exception("email detail failed for %s uid=%s", agent_id, message_uid)
        raise HTTPException(status_code=500, detail="Failed to read mailbox")
    if result is None:
        raise HTTPException(
            status_code=404, detail=f"Email with UID {message_uid} not found"
        )
    return EmailDetailResponse(**result)


@human_router.patch(
    "/api/human/orgs/{org_id}/agents/{agent_id}/email/{message_uid}",
)
async def set_agent_email_read(
    org_id: str,
    agent_id: str,
    message_uid: int,
    body: EmailSetReadRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
) -> dict:
    """Set or clear a message's read state (``\\Seen`` flag). Operator-only.

    Explicit counterpart to the read-on-open side effect of the detail
    endpoint — powers mark-unread and mark-read-without-opening."""
    with _get_db(request) as db:
        _verify_org_membership(db, org_id, user)
        _verify_agent_in_org(db, org_id, agent_id)
        _require_agent_operator(db, agent_id, user)
    if not STALWART_SVC_PASSWORD:
        raise HTTPException(status_code=503, detail="Email service not configured")
    try:
        updated = await run_in_threadpool(set_email_read, agent_id, message_uid, body.is_read)
    except LoginError:
        raise HTTPException(
            status_code=404, detail=f"Email with UID {message_uid} not found"
        )
    except Exception:
        logger.exception("email mark-read failed for %s uid=%s", agent_id, message_uid)
        raise HTTPException(status_code=500, detail="Failed to update message")
    if not updated:
        raise HTTPException(
            status_code=404, detail=f"Email with UID {message_uid} not found"
        )
    return {
        "status": "updated",
        "agent_id": agent_id,
        "message_uid": message_uid,
        "is_read": body.is_read,
    }


@human_router.delete(
    "/api/human/orgs/{org_id}/agents/{agent_id}/email/{message_uid}",
)
async def delete_agent_email(
    org_id: str,
    agent_id: str,
    message_uid: int,
    request: Request,
    user: dict = Depends(get_current_human_user),
) -> dict:
    """Delete one message by UID. Operator-only."""
    with _get_db(request) as db:
        _verify_org_membership(db, org_id, user)
        _verify_agent_in_org(db, org_id, agent_id)
        _require_agent_operator(db, agent_id, user)
    if not STALWART_SVC_PASSWORD:
        raise HTTPException(status_code=503, detail="Email service not configured")
    try:
        deleted = await run_in_threadpool(delete_email, agent_id, message_uid)
    except LoginError:
        raise HTTPException(
            status_code=404, detail=f"Email with UID {message_uid} not found"
        )
    except Exception:
        logger.exception("email delete failed for %s uid=%s", agent_id, message_uid)
        raise HTTPException(status_code=500, detail="Failed to delete message")
    if not deleted:
        raise HTTPException(
            status_code=404, detail=f"Email with UID {message_uid} not found"
        )
    return {"status": "deleted", "agent_id": agent_id, "message_uid": message_uid}


class UpdateAgentSettingsRequest(BaseModel):
    inter_agent_mode_enabled: bool | None = None
    snoozed: bool | None = None
    inter_agent_message_limit: int | None = Field(default=None, ge=1, le=50)
    lobstertalk_enabled: bool | None = None
    lobstertalk_ollama_host: str | None = Field(default=None, max_length=200)
    lobstertalk_ollama_model: str | None = Field(default=None, max_length=100)
    lobstertalk_interval_seconds: int | None = Field(default=None, ge=15, le=3600)
    lobstertalk_message_limit: int | None = Field(default=None, ge=10, le=200)


def _normalize_ollama_host(raw: str) -> str | None:
    """Canonicalize an operator-supplied Ollama base URL to scheme://host:port.

    Accepts ``host``, ``host:port``, or ``http(s)://host[:port]`` (default
    scheme http, default port 11434). Empty input means "clear the setting".
    Rejects paths, queries, and credentials.
    """
    value = raw.strip().rstrip("/")
    if not value:
        return None
    if "://" not in value:
        value = f"http://{value}"
    invalid = HTTPException(
        status_code=422,
        detail="lobstertalk_ollama_host must be host[:port] or http(s)://host[:port]",
    )
    try:
        parts = urlsplit(value)  # ValueError on e.g. an unclosed IPv6 bracket
        port = parts.port  # ValueError on a non-numeric or out-of-range port
    except ValueError:
        raise invalid from None
    if (
        parts.scheme not in ("http", "https")
        or not parts.hostname
        or parts.path
        or parts.query
        or parts.fragment
        or parts.username
        or parts.password
    ):
        raise invalid
    return f"{parts.scheme}://{parts.hostname}:{port if port is not None else 11434}"


class RenameAgentRequest(BaseModel):
    nickname: str = Field(min_length=1, max_length=DISPLAY_NAME_MAX_LENGTH)


class SetAgentDescriptionRequest(BaseModel):
    description: str = Field(min_length=1, max_length=280)


@human_router.patch("/api/human/orgs/{org_id}/agents/{agent_id}/settings")
async def update_agent_settings(
    org_id: str,
    agent_id: str,
    body: UpdateAgentSettingsRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Update an agent's operator-controlled settings. Caller must be the
    agent's operator (org membership alone is not enough)."""
    with _get_db(request) as db:
        _verify_org_membership(db, org_id, user)
        _verify_agent_in_org(db, org_id, agent_id)
        if not TableRead.is_agent_operator(db, agent_id, user["id"]):
            raise HTTPException(
                status_code=403, detail="Only the agent's operator can change these settings"
            )
        # Nullable LobsterTalk host/model use explicit null (or empty string) to
        # clear, so "field present" matters, not just "value is not None".
        clearable = {"lobstertalk_ollama_host", "lobstertalk_ollama_model"}
        has_value = any(
            getattr(body, name) is not None for name in type(body).model_fields
        )
        has_clear = bool(clearable & body.model_fields_set)
        if not has_value and not has_clear:
            raise HTTPException(status_code=400, detail="No settings provided")
        ollama_host = (
            _normalize_ollama_host(body.lobstertalk_ollama_host)
            if body.lobstertalk_ollama_host is not None
            else None
        )
        ollama_model = (
            body.lobstertalk_ollama_model.strip() or None
            if body.lobstertalk_ollama_model is not None
            else None
        )
        updated = TableWrite.update_agent_settings(
            db,
            agent_id,
            inter_agent_mode_enabled=body.inter_agent_mode_enabled,
            snoozed=body.snoozed,
            inter_agent_message_limit=body.inter_agent_message_limit,
            lobstertalk_enabled=body.lobstertalk_enabled,
            lobstertalk_ollama_host=ollama_host,
            clear_lobstertalk_ollama_host=(
                "lobstertalk_ollama_host" in body.model_fields_set and ollama_host is None
            ),
            lobstertalk_ollama_model=ollama_model,
            clear_lobstertalk_ollama_model=(
                "lobstertalk_ollama_model" in body.model_fields_set and ollama_model is None
            ),
            lobstertalk_interval_seconds=body.lobstertalk_interval_seconds,
            lobstertalk_message_limit=body.lobstertalk_message_limit,
        )
        if updated is None:
            raise HTTPException(status_code=404, detail="Agent not found")
        db.commit()
        return {
            "agent_id": agent_id,
            "inter_agent_mode_enabled": updated.inter_agent_mode_enabled,
            "snoozed": updated.snoozed,
            "inter_agent_message_limit": updated.inter_agent_message_limit,
            "lobstertalk_enabled": updated.lobstertalk_enabled,
            "lobstertalk_ollama_host": updated.lobstertalk_ollama_host,
            "lobstertalk_ollama_model": updated.lobstertalk_ollama_model,
            "lobstertalk_interval_seconds": updated.lobstertalk_interval_seconds,
            "lobstertalk_message_limit": updated.lobstertalk_message_limit,
        }


@human_router.patch("/api/human/orgs/{org_id}/agents/{agent_id}/name")
async def rename_agent(
    org_id: str,
    agent_id: str,
    body: RenameAgentRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Rename an agent — replaces the generated nickname. Caller must be the
    agent's operator. Clears any agent-set profile display_name so the new
    name is what every surface resolves to (resolution prefers display_name
    over nickname). ``agent_id`` is immutable; only the display changes."""
    with _get_db(request) as db:
        _verify_org_membership(db, org_id, user)
        _verify_agent_in_org(db, org_id, agent_id)
        if not TableRead.is_agent_operator(db, agent_id, user["id"]):
            raise HTTPException(
                status_code=403, detail="Only the agent's operator can rename it"
            )
        nickname = body.nickname.strip()
        if not nickname:
            raise HTTPException(status_code=400, detail="Name cannot be empty")
        updated = TableWrite.rename_agent(db, agent_id, nickname)
        if updated is None:
            raise HTTPException(status_code=404, detail="Agent not found")
        db.commit()
        return {"agent_id": agent_id, "nickname": updated.nickname}


# ---------------------------------------------------------------------------
# Automations (operator control plane over OpenClaw cron)
#
# Operators set DESIRED automations here; Clawbits stores them and nudges the
# agent's plugin to reconcile its local gateway cron (Clawbits never connects to
# the gateway). Reads + writes are operator-gated like agent settings. See
# docs/protocol/OPENCLAW_AUTOMATIONS_INTEGRATION_STRATEGY.md.
# ---------------------------------------------------------------------------


class CreateAutomationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    # A normalized OpenClaw cron create payload: name, schedule, sessionTarget,
    # wakeMode, payload (+ optional delivery/failureAlert/enabled). Validated
    # server-side; unknown keys are dropped on store.
    desired_spec: dict


class UpdateAutomationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    desired_spec: dict


def _validate_delivery_target(db, agent_id: str, desired_spec: dict) -> None:
    """Reject an automation whose delivery channel the agent is not a member of.

    The picker only offers real memberships, so this guards against a stale or
    forged ``delivery.to`` — and is the security boundary: the plugin has no
    application-level membership gate on explicit delivery (only Mattermost's
    per-post 403 downstream). Absent ``delivery`` → owner DM, nothing to check."""
    delivery = desired_spec.get("delivery")
    if not isinstance(delivery, dict):
        return
    to = delivery.get("to")
    if to and not TableRead.is_mm_channel_member(db, to, agent_id):
        raise HTTPException(
            status_code=400,
            detail="Agent is not a member of the chosen delivery channel",
        )


def _require_automation_operator(db, agent_id: str, user: dict) -> None:
    """Operator-gate for automations — org membership alone is not enough."""
    if not TableRead.is_agent_operator(db, agent_id, user["id"]):
        raise HTTPException(
            status_code=403,
            detail="Only the agent's operator can manage its automations",
        )


# Runtimes whose in-VM plugin has NO Clawbits cron reconciler. Only the
# OpenClaw plugin reconciles desired-state automations today — a Hermes or
# IronClaw agent would store the row and leave it stuck on "requested"
# forever, so mutating calls are rejected up front instead of pretending.
# None/unknown passes: ``agent_type`` is self-reported on the first alive
# ping and the back-compat default is openclaw.
_AUTOMATION_INCAPABLE_RUNTIMES = frozenset({"hermes", "ironclaw"})


def _require_automation_capable_runtime(db, agent_id: str) -> None:
    """422 when the agent's runtime can't apply Clawbits-managed automations.

    Gates create/update/run-now only — list and delete stay open so any
    pre-existing rows remain visible and removable."""
    from clawbits.db.models import Agent as _AgentRow

    row = db.get(_AgentRow, agent_id)
    agent_type = row.agent_type if row is not None else None
    if agent_type in _AUTOMATION_INCAPABLE_RUNTIMES:
        raise HTTPException(
            status_code=422,
            detail=(
                "Automations require an OpenClaw runtime; "
                f"this agent runs {agent_type}"
            ),
        )


def _authorize_automation_operator(
    db, org_id: str, agent_id: str, user: dict
) -> None:
    """The standard gate for an agent-scoped automation request: the caller is
    an org member, the agent belongs to the org, and the caller operates it."""
    _verify_org_membership(db, org_id, user)
    _verify_agent_in_org(db, org_id, agent_id)
    _require_automation_operator(db, agent_id, user)


@human_router.get("/api/human/orgs/{org_id}/automations")
async def list_org_automations(
    org_id: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Every automation across the org's agents the caller operates.

    The org-wide AutomationsPage list — one call instead of fanning out per
    agent. Scoped to operated agents, matching the per-agent operator gate."""
    with _get_db(request) as db:
        _verify_org_membership(db, org_id, user)
        automations = TableRead.list_org_automations_for_operator(
            db, org_id, user["id"]
        )
    return {"automations": automations}


@human_router.get("/api/human/orgs/{org_id}/agents/{agent_id}/automations")
async def list_agent_automations(
    org_id: str,
    agent_id: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """List an agent's automations (operator-only)."""
    with _get_db(request) as db:
        _authorize_automation_operator(db, org_id, agent_id, user)
        automations = TableRead.list_agent_automations(db, agent_id)
    return {"automations": automations}


@human_router.post("/api/human/orgs/{org_id}/agents/{agent_id}/automations")
async def create_agent_automation(
    org_id: str,
    agent_id: str,
    body: CreateAutomationRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Create a Clawbits-managed automation and nudge the agent to reconcile."""
    with _get_db(request) as db:
        _authorize_automation_operator(db, org_id, agent_id, user)
        _require_automation_capable_runtime(db, agent_id)
        try:
            validate_spec(body.desired_spec)
        except SpecValidationError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        _validate_delivery_target(db, agent_id, body.desired_spec)
        row = TableWrite.create_automation(
            db,
            agent_id=agent_id,
            org_id=org_id,
            desired_spec=body.desired_spec,
            created_by=user["id"],
        )
        result = TableRead._automation_to_dict(row)
        generation = TableRead.agent_desired_generation(db, agent_id)
        db.commit()
    await publish_automation_sync(get_bus(), agent_id, generation)
    return result


@human_router.patch(
    "/api/human/orgs/{org_id}/agents/{agent_id}/automations/{automation_id}"
)
async def update_agent_automation(
    org_id: str,
    agent_id: str,
    automation_id: str,
    body: UpdateAutomationRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Replace a managed automation's desired spec and nudge the agent."""
    with _get_db(request) as db:
        _authorize_automation_operator(db, org_id, agent_id, user)
        _require_automation_capable_runtime(db, agent_id)
        existing = TableRead.get_automation_for_agent(db, automation_id, agent_id)
        if existing is None:
            raise HTTPException(status_code=404, detail="Automation not found")
        if existing.managed_by != "clawbits":
            raise HTTPException(
                status_code=409, detail="External automations are read-only"
            )
        try:
            validate_spec(body.desired_spec)
        except SpecValidationError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        _validate_delivery_target(db, agent_id, body.desired_spec)
        row = TableWrite.update_automation_desired(
            db, automation_id, desired_spec=body.desired_spec
        )
        if row is None:
            raise HTTPException(status_code=404, detail="Automation not found")
        result = TableRead._automation_to_dict(row)
        generation = TableRead.agent_desired_generation(db, agent_id)
        db.commit()
    await publish_automation_sync(get_bus(), agent_id, generation)
    return result


@human_router.delete(
    "/api/human/orgs/{org_id}/agents/{agent_id}/automations/{automation_id}"
)
async def delete_agent_automation(
    org_id: str,
    agent_id: str,
    automation_id: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Mark a managed automation for removal and nudge the agent.

    The agent removes the gateway job on next reconcile; the row is finalized
    once the agent confirms removal."""
    with _get_db(request) as db:
        _authorize_automation_operator(db, org_id, agent_id, user)
        existing = TableRead.get_automation_for_agent(db, automation_id, agent_id)
        if existing is None:
            raise HTTPException(status_code=404, detail="Automation not found")
        if existing.managed_by != "clawbits":
            raise HTTPException(
                status_code=409, detail="External automations are read-only"
            )
        TableWrite.delete_automation(db, automation_id)
        generation = TableRead.agent_desired_generation(db, agent_id)
        db.commit()
    await publish_automation_sync(get_bus(), agent_id, generation)
    return {"automation_id": automation_id, "status": "removing"}


@human_router.get(
    "/api/human/orgs/{org_id}/agents/{agent_id}/automations/{automation_id}/runs"
)
async def list_agent_automation_runs(
    org_id: str,
    agent_id: str,
    automation_id: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Recent runs for an automation (operator-only)."""
    with _get_db(request) as db:
        _authorize_automation_operator(db, org_id, agent_id, user)
        if TableRead.get_automation_for_agent(db, automation_id, agent_id) is None:
            raise HTTPException(status_code=404, detail="Automation not found")
        runs = TableRead.list_automation_runs(db, automation_id)
    return {"runs": runs}


@human_router.post(
    "/api/human/orgs/{org_id}/agents/{agent_id}/automations/{automation_id}/run"
)
async def run_agent_automation_now(
    org_id: str,
    agent_id: str,
    automation_id: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Request an immediate one-off run of a managed automation, then nudge the
    agent. Best-effort: the plugin runs the gateway job on its next reconcile
    (within seconds via the nudge); if the agent is offline it runs once on
    reconnect. Operator-only."""
    with _get_db(request) as db:
        _authorize_automation_operator(db, org_id, agent_id, user)
        _require_automation_capable_runtime(db, agent_id)
        existing = TableRead.get_automation_for_agent(db, automation_id, agent_id)
        if existing is None:
            raise HTTPException(status_code=404, detail="Automation not found")
        if existing.managed_by != "clawbits":
            raise HTTPException(
                status_code=409, detail="External automations cannot be run"
            )
        row = TableWrite.request_automation_run(db, automation_id)
        if row is None:
            raise HTTPException(status_code=404, detail="Automation not found")
        result = TableRead._automation_to_dict(row)
        generation = TableRead.agent_desired_generation(db, agent_id)
        db.commit()
    await publish_automation_sync(get_bus(), agent_id, generation)
    return result


@human_router.get("/api/human/orgs/{org_id}/agents/{agent_id}/channels")
async def list_agent_delivery_channels(
    org_id: str,
    agent_id: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Channels and DMs the agent is a member of — the pickable delivery targets
    for an automation. Operator-only (same gate as the automations routes)."""
    with _get_db(request) as db:
        _authorize_automation_operator(db, org_id, agent_id, user)
        channels = TableRead.get_mm_channels_for_agent(db, agent_id)
    return {
        "channels": [
            {
                "channel_id": c["channel_id"],
                "name": c["name"],
                "display_name": c.get("display_name"),
                "channel_type": c["channel_type"],
            }
            for c in channels
        ]
    }


@human_router.post("/api/human/orgs/{org_id}/agents/{agent_id}/description/regenerate")
async def regenerate_agent_description(
    org_id: str,
    agent_id: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Ask the agent to regenerate its description. Operator-only.

    Generation happens agent-side: this only sets a flag the agent picks up on
    its next check-in (``GET /info``). The agent then pushes a fresh
    description via ``PUT /description``, which clears the flag.
    """
    with _get_db(request) as db:
        _verify_org_membership(db, org_id, user)
        _verify_agent_in_org(db, org_id, agent_id)
        # The agent's operator OR an owner of the org may trigger a refresh.
        is_operator = TableRead.is_agent_operator(db, agent_id, user["id"])
        is_org_owner = TableRead.get_org_member_role(db, org_id, user["id"]) == "owner"
        if not (is_operator or is_org_owner):
            raise HTTPException(
                status_code=403,
                detail="Only the agent's operator or an org admin can regenerate its description",
            )
        TableWrite.request_agent_description_regen(db, agent_id)
        db.commit()
        return {"agent_id": agent_id, "description_regen_pending": True}


@human_router.patch("/api/human/orgs/{org_id}/agents/{agent_id}/description")
async def set_agent_description_manual(
    org_id: str,
    agent_id: str,
    body: SetAgentDescriptionRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Manually set the agent's public description (same gate as regenerate:
    the agent's operator or an org owner). Stored with ``source="manual"`` and
    clears any pending regenerate request - the human's text supersedes it.
    The agent can still overwrite it later via ``PUT /description``."""
    with _get_db(request) as db:
        _verify_org_membership(db, org_id, user)
        _verify_agent_in_org(db, org_id, agent_id)
        is_operator = TableRead.is_agent_operator(db, agent_id, user["id"])
        is_org_owner = TableRead.get_org_member_role(db, org_id, user["id"]) == "owner"
        if not (is_operator or is_org_owner):
            raise HTTPException(
                status_code=403,
                detail="Only the agent's operator or an org admin can set its description",
            )
        text = body.description.strip()
        if not text:
            raise HTTPException(status_code=400, detail="Description can't be empty")
        TableWrite.set_agent_description(db, agent_id, text, source="manual")
        db.commit()
        return {
            "agent_id": agent_id,
            "description": text[:280],
            "description_source": "manual",
        }


@human_router.get("/api/human/shared_content")
async def list_shared_content(
    request: Request,
    limit: int = 50,
    offset: int = 0,
    user: dict = Depends(get_current_human_user),
):
    """List recent shared files for the dashboard feed."""
    with _get_db(request) as db:
        files = TableRead.get_recent_shared_content(db, limit=limit, offset=offset)
        return {"files": files, "total": len(files), "limit": limit, "offset": offset}


@human_router.get("/api/human/posts")
async def list_all_agent_posts(
    request: Request,
    limit: int = 50,
    offset: int = 0,
    user: dict = Depends(get_current_human_user),
):
    """List recent posts from all agents for the dashboard feed."""
    with _get_db(request) as db:
        posts = TableRead.get_all_agent_posts(db, limit=limit, offset=offset, current_human_id=user["id"])
        return {"posts": posts, "total": len(posts), "limit": limit, "offset": offset}


@human_router.get("/api/human/orgs/{org_id}/agents/{agent_id}/posts")
async def get_agent_posts_for_human(
    org_id: str,
    agent_id: str,
    request: Request,
    limit: int = 50,
    offset: int = 0,
    user: dict = Depends(get_current_human_user),
):
    """Get posts from a specific agent. Caller must be a member of the owning organization."""
    with _get_db(request) as db:
        _verify_org_membership(db, org_id, user)
        _verify_agent_in_org(db, org_id, agent_id)
        agent = TableRead.get_agent_by_agentid(db, AgentId(agent_id))
        if agent is None:
            raise HTTPException(status_code=404, detail="Agent not found")
        posts = TableRead.get_agent_posts(db, AgentId(agent_id), limit=limit, offset=offset, current_human_id=user["id"])
        return {"posts": posts, "total": len(posts), "limit": limit, "offset": offset}

class PostCommentRequest(BaseModel):
    message: str = Field(min_length=1, max_length=280)

@human_router.post("/api/human/posts/{post_id}/like")
async def like_post(
    post_id: int,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Like a post."""
    from clawbits.db.models import AgentPost

    with _get_db(request) as db:
        if db.get(AgentPost, post_id) is None:
            raise HTTPException(status_code=404, detail="Post not found")
        TableWrite.create_post_like(db, post_id, human_id=user["id"])
        db.commit()
    return {"status": "ok"}

@human_router.delete("/api/human/posts/{post_id}/like")
async def unlike_post(
    post_id: int,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Remove like from a post."""
    with _get_db(request) as db:
        TableWrite.delete_post_like(db, post_id, human_id=user["id"])
        db.commit()
    return {"status": "ok"}

@human_router.get("/api/human/posts/{post_id}/comments")
async def get_post_comments(
    post_id: int,
    request: Request,
    limit: int = 50,
    offset: int = 0,
    user: dict = Depends(get_current_human_user),
):
    """Get comments for a post."""
    from clawbits.db.models import AgentPost

    with _get_db(request) as db:
        if db.get(AgentPost, post_id) is None:
            raise HTTPException(status_code=404, detail="Post not found")
        comments = TableRead.get_post_comments(db, post_id, limit, offset)
    return {"comments": comments}

@human_router.post("/api/human/posts/{post_id}/comments")
async def add_post_comment(
    post_id: int,
    payload: PostCommentRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Add a comment to a post."""
    from clawbits.db.models import AgentPost

    with _get_db(request) as db:
        if db.get(AgentPost, post_id) is None:
            raise HTTPException(status_code=404, detail="Post not found")
        comment_id = TableWrite.create_post_comment(
            db, post_id, message=payload.message, human_id=user["id"]
        )
        db.commit()
    return {"status": "ok", "comment_id": comment_id}


# ---------------------------------------------------------------------------
# Organization endpoints
# ---------------------------------------------------------------------------


@human_router.post("/api/human/orgs", response_model=OrgResponse)
async def create_org(
    body: CreateOrgRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Create a new organization. The caller becomes the owner."""
    from clawbits.fastapi.workos_auth import (
        create_workos_organization,
        register_membership,
    )

    client = request.app.state.workos
    with _get_db(request) as db:
        existing = TableRead.get_org_by_name(db, body.name)
        if existing is not None:
            raise HTTPException(status_code=409, detail=f"Organization name '{body.name}' is already taken")
        org_id = f"org-{_uuid.uuid4()}"
        workos_org_id = create_workos_organization(client, name=body.name)
        TableWrite.create_organization(
            db, org_id, workos_org_id, body.name, body.display_name, False, user["id"]
        )
        TableWrite.add_org_member(db, org_id, user["id"], "owner")
        # The creator has "visited" by definition — bump now so the
        # switcher doesn't flash a "New" pill on the org they just made.
        TableWrite.touch_org_member_visit(db, org_id, user["id"])
        db.commit()
        org = TableRead.get_organization(db, org_id, viewer_human_id=user["id"])

    register_membership(
        client,
        workos_user_id=user["workos_user_id"],
        workos_org_id=workos_org_id,
        role="owner",
    )
    audit.organization_created(
        request,
        actor_user=user,
        workos_org_id=workos_org_id,
        org_name=body.name,
        is_personal=False,
    )
    response = OrgResponse(**org)
    # Cross-tab consistency — the requesting tab already has the org via
    # the mutation response, but any other tabs the user has open need
    # an event to splice it into their switcher cache.
    fire_and_forget(
        publish_org_added(get_bus(), user["id"], response.model_dump())
    )
    return response


@human_router.get("/api/human/orgs", response_model=OrgListResponse)
async def list_orgs(
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """List organizations the current user belongs to."""
    with _get_db(request) as db:
        orgs = TableRead.get_orgs_for_human(db, user["id"])
        return OrgListResponse(
            organizations=[OrgResponse(**o) for o in orgs],
            total=len(orgs),
        )


@human_router.get("/api/human/orgs/{org_id}", response_model=OrgResponse)
async def get_org(
    org_id: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Get organization details. Caller must be a member."""
    with _get_db(request) as db:
        if not TableRead.is_org_member(db, org_id, user["id"]):
            raise HTTPException(status_code=403, detail="Not a member of this organization")
        org = TableRead.get_organization(db, org_id, viewer_human_id=user["id"])
        if org is None:
            raise HTTPException(status_code=404, detail="Organization not found")
        return OrgResponse(**org)


@human_router.post("/api/human/orgs/{org_id}/visit", status_code=204)
async def mark_org_visited(
    org_id: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Mark this org as visited by the caller, bumping ``last_visited_at``
    to now. Idempotent — the org switcher calls this whenever the user
    activates an org so the "New" pill clears the moment they enter."""
    with _get_db(request) as db:
        updated = TableWrite.touch_org_member_visit(db, org_id, user["id"])
        if not updated:
            raise HTTPException(status_code=404, detail="Not a member of this organization")
        db.commit()
    return None


# ── Reef connection ──────────────────────────────────────────────────────────
# An org connects ONE self-hosted Reef by URL. clawbits stores only that URL and
# never connects to Reef — the operator's browser talks to Reef directly over the
# owner's tunnel, presenting an admin token entered per session (never persisted
# here). So these endpoints only read/write the stored URL.


@human_router.get("/api/human/orgs/{org_id}/reef-connection", response_model=ReefConnectionResponse)
async def get_reef_connection(
    org_id: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """The org's connected Reef API URL (or null). Any member can read it."""
    with _get_db(request) as db:
        if not TableRead.is_org_member(db, org_id, user["id"]):
            raise HTTPException(status_code=403, detail="Not a member of this organization")
        return ReefConnectionResponse(api_url=TableRead.get_org_reef_api_url(db, org_id))


@human_router.put("/api/human/orgs/{org_id}/reef-connection", response_model=ReefConnectionResponse)
async def set_reef_connection(
    org_id: str,
    body: SetReefConnectionRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Connect (or re-point) the org's self-hosted Reef. Owner only. Stores ONLY
    the URL — no token or per-agent secret ever reaches clawbits."""
    with _get_db(request) as db:
        if TableRead.get_org_member_role(db, org_id, user["id"]) != "owner":
            raise HTTPException(
                status_code=403, detail="Only organization admins can change the Reef connection"
            )
        if not TableWrite.set_org_reef_api_url(db, org_id, body.api_url):
            raise HTTPException(status_code=404, detail="Organization not found")
        db.commit()
        return ReefConnectionResponse(api_url=body.api_url)


@human_router.delete("/api/human/orgs/{org_id}/reef-connection", status_code=204)
async def delete_reef_connection(
    org_id: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Disconnect the org's Reef (clears the stored URL). Owner only."""
    with _get_db(request) as db:
        if TableRead.get_org_member_role(db, org_id, user["id"]) != "owner":
            raise HTTPException(
                status_code=403, detail="Only organization admins can change the Reef connection"
            )
        if not TableWrite.set_org_reef_api_url(db, org_id, None):
            raise HTTPException(status_code=404, detail="Organization not found")
        db.commit()
    return None


# The LobsterTalk attention gate is an org-level opt-in (it replaced the server-wide
# CLAWBITS_ATTENTION_ENABLED env flag). Any member can read the current state; only
# an owner can flip it. The gate additionally requires the server's `router` extra
# and each agent's own `lobstertalk_enabled` toggle — this switch just arms the org.


@human_router.get("/api/human/orgs/{org_id}/attention", response_model=OrgAttentionResponse)
async def get_org_attention(
    org_id: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Whether the org has armed the LobsterTalk attention gate. Any member can read."""
    with _get_db(request) as db:
        if not TableRead.is_org_member(db, org_id, user["id"]):
            raise HTTPException(status_code=403, detail="Not a member of this organization")
        return OrgAttentionResponse(enabled=TableRead.get_org_attention_enabled(db, org_id))


@human_router.put("/api/human/orgs/{org_id}/attention", response_model=OrgAttentionResponse)
async def set_org_attention(
    org_id: str,
    body: SetOrgAttentionRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Arm/disarm the org's LobsterTalk attention gate. Owner only."""
    with _get_db(request) as db:
        if TableRead.get_org_member_role(db, org_id, user["id"]) != "owner":
            raise HTTPException(
                status_code=403, detail="Only organization admins can change LobsterTalk attention"
            )
        if not TableWrite.set_org_attention_enabled(db, org_id, body.enabled):
            raise HTTPException(status_code=404, detail="Organization not found")
        db.commit()
        return OrgAttentionResponse(enabled=body.enabled)


# The "LobsterTalk" settings tab reads/writes the full attention config in one
# shape: the org toggle plus the cascade-mode LLM endpoint. Supersedes the
# /attention pair above for the frontend (kept for compatibility). The stored
# API key is write-only — responses carry only ``api_key_set``.


def _lobstertalk_response(cfg: dict) -> OrgLobstertalkResponse:
    # ``api_key_set`` reports a *usable* key, not merely a stored one. A
    # ciphertext left behind by a rotated secrets key can't be decrypted, so
    # cascade would silently run without it — reporting "set" would tell the
    # owner everything is fine while asking them to fix nothing.
    token = cfg["api_key_encrypted"]
    return OrgLobstertalkResponse(
        enabled=cfg["enabled"],
        mode=cfg["mode"],
        base_url=cfg["base_url"],
        model=cfg["model"],
        api_key_set=bool(token) and decrypt_secret(token) is not None,
        cooldown_seconds=cfg["cooldown_seconds"],
        default_cooldown_seconds=attention_cooldown_default(),
    )


@human_router.get("/api/human/orgs/{org_id}/lobstertalk", response_model=OrgLobstertalkResponse)
async def get_org_lobstertalk(
    org_id: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """The org's LobsterTalk attention config (key redacted to ``api_key_set``).
    Any member can read."""
    with _get_db(request) as db:
        if not TableRead.is_org_member(db, org_id, user["id"]):
            raise HTTPException(status_code=403, detail="Not a member of this organization")
        cfg = TableRead.get_org_lobstertalk_config(db, org_id)
        if cfg is None:
            raise HTTPException(status_code=404, detail="Organization not found")
        return _lobstertalk_response(cfg)


@human_router.put("/api/human/orgs/{org_id}/lobstertalk", response_model=OrgLobstertalkResponse)
async def set_org_lobstertalk(
    org_id: str,
    body: SetOrgLobstertalkRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Write the org's LobsterTalk attention config. Owner only.

    The LLM modes (cascade, llm_only) require ``base_url`` and ``model``
    atomically in the same request (the settings form submits its whole
    state). The stored API key changes only when ``api_key`` is sent
    (encrypted at rest) or ``clear_api_key`` is set; omitting both keeps it.

    A request that arms an LLM mode has its base URL checked here for
    immediate feedback, and again before every triage call — this one
    constrains what an owner can save, not where the name resolves later.
    Requests that don't arm one (turning LobsterTalk off, switching back to
    embedding) skip the check so a host that has since gone bad can't strand
    the org."""
    with _get_db(request) as db:
        if TableRead.get_org_member_role(db, org_id, user["id"]) != "owner":
            raise HTTPException(
                status_code=403, detail="Only organization admins can change LobsterTalk settings"
            )
    # Owner-only, but self-service: cap how fast one org can drive the DNS
    # resolution below (a caller-chosen, possibly-slow nameserver).
    _rate_limit(f"lt-save:{org_id}", limit=_LOBSTERTALK_SAVE_LIMIT)
    # Outside the session on purpose: resolution is a network round trip with
    # no timeout of its own, against a name the caller chose. Doing it while
    # holding a pooled connection (and an open transaction) would let anyone
    # tie up the pool by pointing base_url at a deliberately slow nameserver.
    # It runs on the dedicated SSRF resolver pool (arun_guarded), so a stuck
    # getaddrinfo can't starve the default executor DB/Redis work shares.
    # Only when this request actually arms an LLM mode — otherwise a config
    # whose host has since gone bad would make the org unable to turn
    # LobsterTalk *off*, which is exactly when you most want to.
    if body.enabled and body.mode in ("cascade", "llm_only") and body.base_url:
        try:
            await asyncio.wait_for(
                arun_guarded(check_endpoint_allowed, body.base_url),
                timeout=ENDPOINT_CHECK_TIMEOUT_SECONDS,
            )
        except PrivateAddressError as e:
            raise HTTPException(status_code=422, detail=str(e)) from e
        except (HostResolutionError, TimeoutError):
            # Don't block a save on a name this host can't resolve yet, or
            # can't resolve quickly (split-horizon DNS, an endpoint not up
            # yet). The call-time check still refuses to dial anything unsafe.
            pass
    with _get_db(request) as db:
        # Re-check ownership in the *write* transaction. The check above ran in
        # an earlier session and the DNS resolution between them is a network
        # round trip — long enough for the caller to be demoted. Without this a
        # just-removed owner could still land the write (a classic TOCTOU).
        if TableRead.get_org_member_role(db, org_id, user["id"]) != "owner":
            raise HTTPException(
                status_code=403, detail="Only organization admins can change LobsterTalk settings"
            )
        update_api_key = body.api_key is not None or body.clear_api_key
        try:
            api_key_encrypted = encrypt_secret(body.api_key) if body.api_key is not None else None
        except EphemeralSecretsKeyError as e:
            raise HTTPException(
                status_code=503,
                detail=(
                    "This server has no durable secrets key configured, so an API key "
                    "cannot be stored. Set CLAWBITS_ATTENTION_SECRETS_KEY, or use an "
                    "endpoint that needs no key."
                ),
            ) from e
        if not TableWrite.set_org_lobstertalk_config(
            db,
            org_id,
            enabled=body.enabled,
            mode=body.mode,
            base_url=body.base_url,
            model=body.model,
            api_key_encrypted=api_key_encrypted,
            update_api_key=update_api_key,
            cooldown_seconds=body.cooldown_seconds,
        ):
            raise HTTPException(status_code=404, detail="Organization not found")
        org_row = TableRead.get_organization(db, org_id)
        db.commit()
        response = _lobstertalk_response(TableRead.get_org_lobstertalk_config(db, org_id))
    # After commit, outside the session: record who changed the config that
    # governs whether channel transcripts (private channels included) get
    # shipped to an org-controlled endpoint. Best-effort; never blocks the save.
    audit.lobstertalk_config_updated(
        request,
        actor_user=user,
        workos_org_id=(org_row or {}).get("workos_org_id", ""),
        enabled=body.enabled,
        mode=body.mode,
        base_url=body.base_url,
        api_key_changed=update_api_key,
        cooldown_seconds=body.cooldown_seconds,
    )
    return response


@human_router.post(
    "/api/human/orgs/{org_id}/lobstertalk/healthcheck",
    response_model=OrgLobstertalkHealthResponse,
)
async def lobstertalk_healthcheck(
    org_id: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Run one live triage-shaped call against the org's *stored* LLM config
    and report which stage failed, if any. Owner only — it spends a metered
    call on the org's key. Probes the stored config (not a draft) so the key
    never travels back through the API; the frontend fires this right after a
    successful save, when stored == what the owner just typed.

    Config problems the probe can't even attempt (embedding mode, missing
    endpoint fields) are 422s; problems the probe *finds* (bad key, wrong
    URL, unusable model) are 200s with ``ok=false`` — the check worked, the
    endpoint didn't."""
    with _get_db(request) as db:
        if TableRead.get_org_member_role(db, org_id, user["id"]) != "owner":
            raise HTTPException(
                status_code=403, detail="Only organization admins can test LobsterTalk settings"
            )
        cfg = TableRead.get_org_lobstertalk_config(db, org_id)
    # Each probe spends a metered LLM call against the org's key — cap the rate
    # so this can't be looped into a spend amplifier. (After the owner check so
    # a rejected non-owner never fills the bucket.)
    _rate_limit(f"lt-health:{org_id}", limit=_LOBSTERTALK_HEALTH_LIMIT)
    # Session released before the probe: it's a network call against a
    # caller-chosen host under a 30s deadline — same reason the PUT resolves
    # DNS outside the session.
    if cfg is None:
        raise HTTPException(status_code=404, detail="Organization not found")
    if cfg["mode"] not in ("cascade", "llm_only"):
        raise HTTPException(
            status_code=422,
            detail=f"No LLM endpoint to check: the org is in {cfg['mode']} mode",
        )
    if not cfg["base_url"] or not cfg["model"]:
        raise HTTPException(
            status_code=422, detail="No LLM endpoint to check: base URL and model are not set"
        )
    token = cfg["api_key_encrypted"]
    api_key = decrypt_secret(token) if token else None
    if token and api_key is None:
        return OrgLobstertalkHealthResponse(
            ok=False,
            detail="stored API key cannot be decrypted (secrets key rotated?) — re-enter it",
        )
    started = time.monotonic()
    ok, detail = await probe_llm_endpoint(
        LlmTriageConfig(base_url=cfg["base_url"], model=cfg["model"], api_key=api_key)
    )
    return OrgLobstertalkHealthResponse(
        ok=ok, detail=detail, latency_ms=int((time.monotonic() - started) * 1000)
    )


@human_router.put(
    "/api/human/orgs/{org_id}/lobstertalk/channels/{channel_id}",
    response_model=OrgLobstertalkChannelResponse,
)
async def set_org_lobstertalk_channel(
    org_id: str,
    channel_id: str,
    body: SetOrgLobstertalkChannelRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Approve or revoke one public channel on the org's LobsterTalk
    allowlist. Owner only. Closed by default: a channel no owner has approved
    never gets an attention pass, regardless of the org and agent toggles.

    Unlike the config PUT there is no network round trip between the owner
    check and the write, so a single transaction covers both — no TOCTOU
    re-check needed. Unknown channels and channels of *other* orgs are the
    same 404 (channel ids must not be probeable across orgs); non-public
    channels are 422 in both directions — the attention gate hard-requires
    public first, so approval on them would be a dead flag."""
    with _get_db(request) as db:
        if TableRead.get_org_member_role(db, org_id, user["id"]) != "owner":
            raise HTTPException(
                status_code=403, detail="Only organization admins can change LobsterTalk settings"
            )
        channel = TableRead.get_mm_channel(db, channel_id)
        if channel is None or channel.get("org_id") != org_id:
            raise HTTPException(status_code=404, detail="Channel not found")
        if channel.get("channel_type") != "public":
            raise HTTPException(
                status_code=422, detail="Only public channels can be approved for LobsterTalk"
            )
        TableWrite.set_mm_channel_lobstertalk_approved(db, channel_id, body.approved)
        org_row = TableRead.get_organization(db, org_id)
        db.commit()
    # After commit, outside the session: approval is what admits this
    # channel's transcript to the org-configured LLM endpoint, so it gets the
    # same best-effort audit trail as the config itself.
    audit.lobstertalk_channel_updated(
        request,
        actor_user=user,
        workos_org_id=(org_row or {}).get("workos_org_id", ""),
        channel_id=channel_id,
        channel_name=channel.get("name") or channel_id,
        approved=body.approved,
    )
    return OrgLobstertalkChannelResponse(
        channel_id=channel_id, lobstertalk_approved=body.approved
    )


class LinkReefVmRequest(BaseModel):
    """Stamp a pending signup session with the reef VM it provisioned."""

    session_token: str = Field(min_length=1, max_length=256)
    sandbox_id: str = Field(min_length=1, max_length=200)


@human_router.post("/api/human/agents/link-reef-vm", status_code=204)
async def link_reef_vm(
    body: LinkReefVmRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Link a reef VM to the agent that a pending signup session will create.

    The "Add agent → Run on Reef" flow mints a signup token, hands it to reef,
    and gets back a sandbox id. This records that id on the signup session so
    that when the VM enrolls (signup-commit) the resulting agent is linked to
    its reef sandbox. Best-effort and idempotent; only the human who opened the
    session may stamp it. The sandbox id is not a secret."""
    with _get_db(request) as db:
        sess = TableRead.get_challenge_session(db, body.session_token)
        if sess is None:
            raise HTTPException(status_code=404, detail="Signup session not found")
        if sess.get("human_id") != user["id"]:
            raise HTTPException(status_code=403, detail="Not your signup session")
        if not TableWrite.set_challenge_reef_sandbox(db, body.session_token, body.sandbox_id):
            raise HTTPException(status_code=404, detail="Signup session not found")
        db.commit()
    return None


@human_router.get("/api/human/orgs/{org_id}/members", response_model=OrgMembersListResponse)
async def list_org_members(
    org_id: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """List members of an organization. Any member can read — this powers
    both the owner-only admin page (which self-gates off ``my_role``) and
    the directory pickers used to add people to channels, start DMs, etc.
    Privileged actions (add/remove member, role changes) remain owner-only
    on their own endpoints."""
    with _get_db(request) as db:
        if not TableRead.is_org_member(db, org_id, user["id"]):
            raise HTTPException(
                status_code=403,
                detail="Not a member of this organization",
            )
        members = TableRead.get_org_members(db, org_id)
        return OrgMembersListResponse(
            members=[OrgMemberResponse(**m) for m in members],
            total=len(members),
        )


@human_router.post("/api/human/orgs/{org_id}/members", response_model=OrgMembersListResponse)
async def add_org_member(
    org_id: str,
    body: AddOrgMemberRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Add a member to an organization. Caller must be an owner."""
    with _get_db(request) as db:
        role = TableRead.get_org_member_role(db, org_id, user["id"])
        if role != "owner":
            raise HTTPException(status_code=403, detail="Only organization admins can add members")
        # Look up target user by email
        target = TableRead.get_human_user_by_email(db, body.email)
        if target is None:
            raise HTTPException(status_code=404, detail=f"User '{body.email}' not found")
        TableWrite.add_org_member(db, org_id, target["id"], body.role)
        # Contact is closed by default: a newly-added org member is NOT dropped
        # into an agent's channel unless they're permitted to contact that agent
        # (its operator, or someone the operator/owner granted). Otherwise a new
        # hire would land in a channel with an agent they can't even message.
        for owned_agent_id in TableRead.get_agents_owned_by_org(db, org_id):
            if not (
                TableRead.can_dm_agent(db, owned_agent_id, human_id=target["id"])
                or TableRead.can_tag_agent(db, owned_agent_id, human_id=target["id"])
            ):
                continue
            channel = TableWrite.ensure_agent_default_mm_channel(db, owned_agent_id)
            if channel.get("channel_type") != "private":
                TableWrite.add_mm_channel_member_human(db, channel["channel_id"], target["id"])
        # Build the SSE payload from the new member's perspective so
        # ``my_role`` lands correctly. ``last_visited_at`` and the unread
        # counters fall back to their model defaults — fine, since a
        # just-added member can't have visited the org yet.
        org = TableRead.get_organization(db, org_id, viewer_human_id=target["id"])
        members = TableRead.get_org_members(db, org_id)
        db.commit()

    if org is not None:
        from clawbits.fastapi.workos_auth import register_membership

        register_membership(
            request.app.state.workos,
            workos_user_id=target["workos_user_id"],
            workos_org_id=org["workos_org_id"],
            role=body.role,
        )
        audit.organization_member_added(
            request,
            actor_user=user,
            target_user=target,
            workos_org_id=org["workos_org_id"],
            role=body.role,
        )
        # Drop the org into the new member's switcher in real time. Any
        # tab they have open will splice it in with a "New" pill (since
        # ``last_visited_at`` is null) without needing a manual reload.
        fire_and_forget(
            publish_org_added(
                get_bus(),
                target["id"],
                OrgResponse(**org).model_dump(),
            )
        )
    return OrgMembersListResponse(
        members=[OrgMemberResponse(**m) for m in members],
        total=len(members),
    )


@human_router.patch(
    "/api/human/orgs/{org_id}/members/{member_id}", response_model=OrgMembersListResponse
)
async def update_org_member_role(
    org_id: str,
    member_id: int,
    body: UpdateOrgMemberRoleRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Promote a member to owner, or demote an owner to member. Caller must be
    an owner. Cannot demote the last owner — the same floor
    :func:`remove_org_member` enforces, so an org can never end up with
    nobody able to manage it."""
    with _get_db(request) as db:
        caller_role = TableRead.get_org_member_role(db, org_id, user["id"])
        if caller_role != "owner":
            raise HTTPException(
                status_code=403, detail="Only organization admins can change roles"
            )
        old_role = TableRead.get_org_member_role(db, org_id, member_id)
        if old_role is None:
            raise HTTPException(
                status_code=404, detail="Member not found in this organization"
            )
        if old_role == body.role:
            # No-op: return the current list rather than burning a WorkOS
            # round-trip and an audit event on a double-click.
            members = TableRead.get_org_members(db, org_id)
            return OrgMembersListResponse(members=[OrgMemberResponse(**m) for m in members], total=len(members))
        if old_role == "owner":
            members = TableRead.get_org_members(db, org_id)
            owner_count = sum(1 for m in members if m["role"] == "owner")
            if owner_count <= 1:
                raise HTTPException(
                    status_code=400,
                    detail="Cannot demote the last admin of an organization",
                )
        target = TableRead.get_human_user_by_id(db, member_id)
        TableWrite.update_org_member_role(db, org_id, member_id, body.role)
        org = TableRead.get_organization(db, org_id)
        # Rendered from the target's perspective so the ``my_role`` in the
        # SSE payload is theirs, not the acting owner's.
        target_org = TableRead.get_organization(db, org_id, viewer_human_id=member_id)
        members = TableRead.get_org_members(db, org_id)
        db.commit()

    if org is not None and target is not None:
        from clawbits.fastapi.workos_auth import update_membership_role

        update_membership_role(
            request.app.state.workos,
            workos_user_id=target["workos_user_id"],
            workos_org_id=org["workos_org_id"],
            role=body.role,
        )
        audit.organization_member_role_updated(
            request,
            actor_user=user,
            target_user=target,
            workos_org_id=org["workos_org_id"],
            old_role=old_role,
            new_role=body.role,
        )
        # Flip the target's own admin surfaces live — including the acting
        # owner's other tabs when they demoted themselves.
        if target_org is not None:
            fire_and_forget(
                publish_org_updated(
                    get_bus(),
                    member_id,
                    OrgResponse(**target_org).model_dump(),
                )
            )
    return OrgMembersListResponse(members=[OrgMemberResponse(**m) for m in members], total=len(members))


@human_router.delete("/api/human/orgs/{org_id}/members/{member_id}", response_model=OrgMembersListResponse)
async def remove_org_member(
    org_id: str,
    member_id: int,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Remove a member from an organization. Caller must be an owner. Cannot remove the last owner."""
    with _get_db(request) as db:
        caller_role = TableRead.get_org_member_role(db, org_id, user["id"])
        if caller_role != "owner":
            raise HTTPException(status_code=403, detail="Only organization admins can remove members")
        # Prevent removing the last owner
        target_role = TableRead.get_org_member_role(db, org_id, member_id)
        if target_role is None:
            raise HTTPException(status_code=404, detail="Member not found in this organization")
        if target_role == "owner":
            # Count remaining owners
            members = TableRead.get_org_members(db, org_id)
            owner_count = sum(1 for m in members if m["role"] == "owner")
            if owner_count <= 1:
                raise HTTPException(status_code=400, detail="Cannot remove the last admin of an organization")
        target = TableRead.get_human_user_by_id(db, member_id)
        TableWrite.remove_org_member(db, org_id, member_id)
        org = TableRead.get_organization(db, org_id)
        members = TableRead.get_org_members(db, org_id)
        db.commit()

    if org is not None and target is not None:
        from clawbits.fastapi.workos_auth import unregister_membership

        unregister_membership(
            request.app.state.workos,
            workos_user_id=target["workos_user_id"],
            workos_org_id=org["workos_org_id"],
        )
        audit.organization_member_removed(
            request,
            actor_user=user,
            target_user=target,
            workos_org_id=org["workos_org_id"],
        )
    return OrgMembersListResponse(
        members=[OrgMemberResponse(**m) for m in members],
        total=len(members),
    )


# ---------------------------------------------------------------------------
# Agent Action Registry (human-facing)
# ---------------------------------------------------------------------------


@human_router.get("/api/human/orgs/{org_id}/agents/{agent_id}/actions", response_model=AgentActionsResponse)
async def get_agent_actions(
    org_id: str,
    agent_id: str,
    request: Request,
    limit: int = 100,
    offset: int = 0,
    user: dict = Depends(get_current_human_user),
):
    """Get all action documents for a specific agent. Caller must be an org member."""
    with _get_db(request) as db:
        _verify_org_membership(db, org_id, user)
        _verify_agent_in_org(db, org_id, agent_id)
        items = TableRead.get_agent_actions(db, agent_id, limit=limit, offset=offset)
        total = TableRead.count_agent_actions_for_agent(db, agent_id)
        return AgentActionsResponse(
            agent_id=agent_id,
            actions=[ActionListItem(**i) for i in items],
            total=total,
        )


@human_router.get("/api/human/orgs/{org_id}/agents/{agent_id}/actions/{action_id}", response_model=ActionResponse)
async def get_agent_action(
    org_id: str,
    agent_id: str,
    action_id: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Get a specific action document for an agent. Caller must be an org member."""
    with _get_db(request) as db:
        _verify_org_membership(db, org_id, user)
        _verify_agent_in_org(db, org_id, agent_id)
        row = TableRead.get_agent_action(db, agent_id, action_id)
        if row is None:
            raise HTTPException(status_code=404, detail="No action document found for this agent with this ID")
        return ActionResponse(**row)


@human_router.get("/api/human/actions", response_model=ActionListResponse)
async def list_agent_actions(
    request: Request,
    limit: int = 100,
    offset: int = 0,
    user: dict = Depends(get_current_human_user),
):
    """List all action documents across all agents (metadata only)."""
    with _get_db(request) as db:
        items = TableRead.list_agent_actions(db, limit=limit, offset=offset)
        total = TableRead.count_agent_actions(db)
        return ActionListResponse(
            actions=[ActionListItem(**i) for i in items],
            total=total,
        )


# ---------------------------------------------------------------------------
# Agent Signup Request approval
# ---------------------------------------------------------------------------

@human_router.get("/api/human/orgs/{org_id}/signup-requests")
async def list_signup_requests(
    org_id: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """List pending agent signup requests for an organization. Any org member can view."""
    with _get_db(request) as db:
        _verify_org_membership(db, org_id, user)
        requests_list = TableRead.get_pending_signup_requests_for_org(db, org_id)
        return {"requests": requests_list}


@human_router.post("/api/human/orgs/{org_id}/signup-requests/{request_id}/approve")
async def approve_signup_request(
    org_id: str,
    request_id: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Approve a pending agent signup request. Any member of the organization can approve."""
    from clawbits.fastapi.agent_signup import AgentSignup

    with _get_db(request) as db:
        _verify_org_membership(db, org_id, user)

        # Verify the request belongs to this org
        signup_req = TableRead.get_signup_request(db, request_id)
        if signup_req is None:
            raise HTTPException(status_code=404, detail="Signup request not found")
        if signup_req["org_id"] != org_id:
            raise HTTPException(status_code=404, detail="Signup request not found in this organization")

        result = AgentSignup.approve_signup_request(request.app, request_id, user["id"], db=db)
        db.commit()

        return result


@human_router.post("/api/human/orgs/{org_id}/signup-requests/{request_id}/reject")
async def reject_signup_request(
    org_id: str,
    request_id: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Reject a pending agent signup request. Any member of the organization can reject."""
    with _get_db(request) as db:
        _verify_org_membership(db, org_id, user)

        signup_req = TableRead.get_signup_request(db, request_id)
        if signup_req is None:
            raise HTTPException(status_code=404, detail="Signup request not found")
        if signup_req["org_id"] != org_id:
            raise HTTPException(status_code=404, detail="Signup request not found in this organization")
        if signup_req["status"] != "pending_approval":
            raise HTTPException(status_code=409, detail=f"Signup request already {signup_req['status']}")

        TableWrite.reject_signup_request(db, request_id, user["id"])
        db.commit()

        return TableRead.get_signup_request(db, request_id)


# ---------------------------------------------------------------------------
# Human-initiated agent signup
# ---------------------------------------------------------------------------

class HumanAgentSignupRequest(BaseModel):
    org_id: str = Field(description="Organization ID the human is a member of")


@human_router.post(
    "/api/human/agent_signup",
    response_model=ChallengeQuestionResponse,
    tags=["Agents"],
    summary="Human-initiated agent signup",
)
def human_agents_signup(
    body: HumanAgentSignupRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Start agent creation for an org the authenticated human belongs to.

    Returns a challenge question with a session token prefixed with ``human-``.
    The commit step uses the same ``POST /api/agentic/signup-commit`` endpoint.
    """
    import secrets
    from datetime import UTC, datetime, timedelta

    with _get_db(request) as db:
        if not TableRead.is_org_member(db, body.org_id, user["id"]):
            raise HTTPException(status_code=403, detail="You are not a member of this organization")

        question, answer = get_random_question_answer()
        session_token = "human-" + secrets.token_urlsafe(32)

        expires_at = datetime.now(UTC) + timedelta(minutes=10)
        # Store the initiating human alongside the org so commit can record
        # the operator without a second auth roundtrip.
        TableWrite.create_challenge_session(
            db,
            session_token=session_token,
            question=question,
            answer=answer,
            expires_at=expires_at,
            org_id=body.org_id,
            human_id=user["id"],
        )
        db.commit()

        return ChallengeQuestionResponse(
            session_token=session_token,
            challenge_question=question,
        )



# ---------------------------------------------------------------------------
# Skills library (org catalog)
#
# An org authors versioned skills here; installing them onto agents is a
# separate plane that lands later. Catalog routes are gated on org MEMBERSHIP
# (not agent operatorship): an org owner who operates no agents must still see
# the shared library. See docs/protocol/SKILLS_LIBRARY_PLAN.md.
# ---------------------------------------------------------------------------

# The human lane has no CB_TOKENS backstop.
_SKILL_WRITE_LIMIT = 30


class CreateSkillRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    slug: str
    display_name: str
    manifest: dict
    body_md: str
    files: list[dict] | None = None


class PublishSkillRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    manifest: dict
    body_md: str
    files: list[dict] | None = None
    changelog: str | None = None


class UpdateSkillMetaRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    display_name: str | None = None


class ForkSkillRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    slug: str | None = None
    display_name: str | None = None


def _skill_or_404(db, org_id: str, skill_id: str):
    """Fetch a skill, re-deriving its org from the row itself."""
    row = TableRead.get_skill_for_org(db, skill_id, org_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Skill not found")
    return row


def _prepare_skill_content(
    *, slug: str, manifest: dict, body_md: str, files: list[dict] | None
) -> tuple[dict, list[dict]]:
    """Validate then normalize authored content, mapping errors to 400.

    Validation runs before normalization so a missing field is named in the 400
    rather than silently dropped.
    """
    from clawbits.skills.spec import (
        SkillValidationError,
        normalize_files,
        normalize_manifest,
        validate_bundle,
        validate_manifest,
    )

    try:
        validate_manifest(manifest, slug=slug)
        normalized = normalize_manifest(manifest)
        normalized_files = normalize_files(files)
        validate_bundle(body_md, normalized_files)
    except SkillValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return normalized, normalized_files


@human_router.get("/api/human/orgs/{org_id}/skills")
async def list_org_skills(
    org_id: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """The org's skill library."""
    with _get_db(request) as db:
        _verify_org_membership(db, org_id, user)
        skills = TableRead.list_org_skills(db, org_id)
    return {"skills": skills}


@human_router.post("/api/human/orgs/{org_id}/skills")
async def create_org_skill(
    org_id: str,
    body: CreateSkillRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Create a skill and publish its first version."""
    from clawbits.skills.spec import SkillValidationError, validate_slug

    _rate_limit(f"skill-write:{org_id}", limit=_SKILL_WRITE_LIMIT)
    slug = (body.slug or "").strip().lower()
    try:
        validate_slug(slug)
    except SkillValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    manifest, files = _prepare_skill_content(
        slug=slug, manifest=body.manifest, body_md=body.body_md, files=body.files
    )
    with _get_db(request) as db:
        _verify_org_membership(db, org_id, user)
        if slug in TableRead.get_org_skill_slugs(db, org_id):
            raise HTTPException(
                status_code=409, detail=f"A skill named '{slug}' already exists"
            )
        row = TableWrite.create_skill(
            db,
            org_id=org_id,
            slug=slug,
            display_name=(body.display_name or slug).strip(),
            manifest=manifest,
            body_md=body.body_md,
            files=files,
            created_by=user["id"],
        )
        result = TableRead.get_skill_detail(db, row.skill_id, org_id)
        db.commit()
    return result


@human_router.get("/api/human/orgs/{org_id}/skills/{skill_id}")
async def get_org_skill(
    org_id: str,
    skill_id: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """One skill with its current version content."""
    with _get_db(request) as db:
        _verify_org_membership(db, org_id, user)
        result = TableRead.get_skill_detail(db, skill_id, org_id)
        if result is None:
            raise HTTPException(status_code=404, detail="Skill not found")
    return result


@human_router.patch("/api/human/orgs/{org_id}/skills/{skill_id}")
async def update_org_skill(
    org_id: str,
    skill_id: str,
    body: UpdateSkillMetaRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Edit catalog metadata. Content edits go through publish."""
    with _get_db(request) as db:
        _verify_org_membership(db, org_id, user)
        skill = _skill_or_404(db, org_id, skill_id)
        TableWrite.update_skill_meta(
            db,
            skill=skill,
            display_name=(body.display_name.strip() if body.display_name else None),
        )
        result = TableRead.get_skill_detail(db, skill_id, org_id)
        db.commit()
    return result


@human_router.post("/api/human/orgs/{org_id}/skills/{skill_id}/versions")
async def publish_org_skill_version(
    org_id: str,
    skill_id: str,
    body: PublishSkillRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Publish an edit as a new immutable version (implicit patch bump)."""
    _rate_limit(f"skill-write:{org_id}", limit=_SKILL_WRITE_LIMIT)
    with _get_db(request) as db:
        _verify_org_membership(db, org_id, user)
        skill = _skill_or_404(db, org_id, skill_id)
        manifest, files = _prepare_skill_content(
            slug=skill.slug,
            manifest=body.manifest,
            body_md=body.body_md,
            files=body.files,
        )
        version = TableWrite.publish_skill_version(
            db,
            skill=skill,
            manifest=manifest,
            body_md=body.body_md,
            files=files,
            changelog=(body.changelog.strip() if body.changelog else None),
            published_by=user["id"],
        )
        result = TableRead._skill_version_to_dict(version, include_content=True)
        db.commit()
    return result


@human_router.get("/api/human/orgs/{org_id}/skills/{skill_id}/versions")
async def list_org_skill_versions(
    org_id: str,
    skill_id: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """The version timeline for one skill."""
    with _get_db(request) as db:
        _verify_org_membership(db, org_id, user)
        _skill_or_404(db, org_id, skill_id)
        versions = TableRead.list_skill_versions(db, skill_id)
    return {"versions": versions}


@human_router.get(
    "/api/human/orgs/{org_id}/skills/{skill_id}/versions/{version_id}/render"
)
async def render_org_skill_version(
    org_id: str,
    skill_id: str,
    version_id: str,
    request: Request,
    runtime: str = "openclaw",
    user: dict = Depends(get_current_human_user),
):
    """The exact ``SKILL.md`` bytes that would land on disk for ``runtime``."""
    from clawbits.skills.render import SKILL_RUNTIMES, render_skill

    if runtime not in SKILL_RUNTIMES:
        raise HTTPException(status_code=400, detail=f"Unknown runtime: {runtime}")
    with _get_db(request) as db:
        _verify_org_membership(db, org_id, user)
        skill = _skill_or_404(db, org_id, skill_id)
        version = TableRead.get_skill_version(db, version_id, skill_id)
        if version is None:
            raise HTTPException(status_code=404, detail="Version not found")
        content = render_skill(version.manifest, version.body_md, runtime=runtime)
        path = f"{skill.slug}/SKILL.md"
        content_hash = version.content_hash
    return {
        "runtime": runtime,
        "path": path,
        "content": content,
        "content_hash": content_hash,
    }


@human_router.post("/api/human/orgs/{org_id}/skills/{skill_id}/fork")
async def fork_org_skill(
    org_id: str,
    skill_id: str,
    body: ForkSkillRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Fork a skill into this org, recording lineage. ``org_id`` is the forking org."""
    from clawbits.skills.spec import SkillValidationError, validate_slug

    _rate_limit(f"skill-write:{org_id}", limit=_SKILL_WRITE_LIMIT)
    with _get_db(request) as db:
        _verify_org_membership(db, org_id, user)
        source = _skill_or_404(db, org_id, skill_id)
        if source.latest_version_id is None:
            raise HTTPException(
                status_code=409, detail="Cannot fork a skill with no published version"
            )
        source_version = TableRead.get_skill_version(
            db, source.latest_version_id, source.skill_id
        )
        if source_version is None:
            raise HTTPException(status_code=404, detail="Source version not found")

        taken = TableRead.get_org_skill_slugs(db, org_id)
        slug = (body.slug or "").strip().lower()
        if not slug:
            # Same-org forks always collide, so derive a free slug.
            slug = f"{source.slug}-fork"
            suffix = 2
            while slug in taken:
                slug = f"{source.slug}-fork-{suffix}"
                suffix += 1
        try:
            validate_slug(slug)
        except SkillValidationError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if slug in taken:
            raise HTTPException(
                status_code=409, detail=f"A skill named '{slug}' already exists"
            )

        fork = TableWrite.fork_skill(
            db,
            source=source,
            source_version=source_version,
            target_org_id=org_id,
            slug=slug,
            display_name=(body.display_name or f"{source.display_name} (fork)").strip(),
            created_by=user["id"],
        )
        result = TableRead.get_skill_detail(db, fork.skill_id, org_id)
        db.commit()
    return result


@human_router.delete("/api/human/orgs/{org_id}/skills/{skill_id}")
async def delete_org_skill(
    org_id: str,
    skill_id: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Soft-delete a skill from the library."""
    with _get_db(request) as db:
        _verify_org_membership(db, org_id, user)
        skill = _skill_or_404(db, org_id, skill_id)
        TableWrite.delete_skill(db, skill=skill)
        db.commit()
    return {"skill_id": skill_id, "deleted": True}


@human_router.get("/api/human/orgs/{org_id}/agents/{agent_id}/skills")
async def list_agent_skills(
    org_id: str,
    agent_id: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Skills actually present on the agent, as it last reported them."""
    with _get_db(request) as db:
        _verify_org_membership(db, org_id, user)
        _verify_agent_in_org(db, org_id, agent_id)
        if not TableRead.can_manage_agent_contacts(db, agent_id, user["id"]):
            raise HTTPException(
                status_code=403, detail="Only the agent's operator or an org admin can view its skills"
            )
        return TableRead.list_agent_skills(db, agent_id)


class InstallSkillRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    skill_id: str


class UpdateInstallRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool


def _authorize_agent_skills(db, org_id: str, agent_id: str, user: dict) -> None:
    _verify_org_membership(db, org_id, user)
    _verify_agent_in_org(db, org_id, agent_id)
    if not TableRead.can_manage_agent_contacts(db, agent_id, user["id"]):
        raise HTTPException(
            status_code=403,
            detail="Only the agent's operator or an org admin can manage its skills",
        )


def _install_or_404(db, agent_id: str, install_id: str):
    from clawbits.db.models import AgentSkillInstall

    row = db.get(AgentSkillInstall, install_id)
    if row is None or row.agent_id != agent_id:
        raise HTTPException(status_code=404, detail="Skill install not found")
    return row


@human_router.post("/api/human/orgs/{org_id}/agents/{agent_id}/skills")
async def install_agent_skill(
    org_id: str,
    agent_id: str,
    body: InstallSkillRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Install an org skill onto an agent."""
    from clawbits.db.models import Agent as _AgentRow
    from clawbits.skills.render import resolve_runtime

    with _get_db(request) as db:
        _authorize_agent_skills(db, org_id, agent_id, user)

        agent = db.get(_AgentRow, agent_id)
        runtime = resolve_runtime(agent.agent_type if agent else None)
        if not runtime.can_receive:
            raise HTTPException(
                status_code=422,
                detail=f"Skills require an OpenClaw runtime; this agent runs {runtime.name}",
            )

        # Cross-org attach is forbidden — fork first. One rule closes both the
        # by-id read of another org's private skill and the supply chain where
        # an upstream edit reaches an agent that never opted in.
        skill = _skill_or_404(db, org_id, body.skill_id)
        if skill.latest_version_id is None:
            raise HTTPException(
                status_code=409, detail="This skill has no published version yet"
            )
        if runtime.name not in (skill.runtimes or ["openclaw"]):
            raise HTTPException(
                status_code=422,
                detail=f"'{skill.slug}' does not declare support for {runtime.name}",
            )

        TableWrite.install_skill(
            db, agent_id=agent_id, org_id=org_id, skill=skill, installed_by=user["id"]
        )
        result = TableRead.list_agent_skills(db, agent_id)
        db.commit()
    return result


@human_router.patch("/api/human/orgs/{org_id}/agents/{agent_id}/skills/{install_id}")
async def update_agent_skill_install(
    org_id: str,
    agent_id: str,
    install_id: str,
    body: UpdateInstallRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Enable or disable an installed skill."""
    with _get_db(request) as db:
        _authorize_agent_skills(db, org_id, agent_id, user)
        row = _install_or_404(db, agent_id, install_id)
        if row.managed_by != "clawbits":
            raise HTTPException(
                status_code=409, detail="Clawbits doesn't manage this skill"
            )
        TableWrite.set_skill_install_enabled(db, row=row, enabled=body.enabled)
        result = TableRead.list_agent_skills(db, agent_id)
        db.commit()
    return result


@human_router.delete("/api/human/orgs/{org_id}/agents/{agent_id}/skills/{install_id}")
async def uninstall_agent_skill(
    org_id: str,
    agent_id: str,
    install_id: str,
    request: Request,
    force: bool = False,
    user: dict = Depends(get_current_human_user),
):
    """Uninstall a skill. The row survives as a tombstone until the agent
    confirms the directory is gone; ``force`` drops it without waiting, for an
    agent that will never report again."""
    with _get_db(request) as db:
        _authorize_agent_skills(db, org_id, agent_id, user)
        row = _install_or_404(db, agent_id, install_id)
        if row.managed_by != "clawbits":
            raise HTTPException(
                status_code=409, detail="Clawbits doesn't manage this skill"
            )
        if force:
            TableWrite.forget_skill_install(db, row=row)
        else:
            TableWrite.uninstall_skill(db, row=row)
        result = TableRead.list_agent_skills(db, agent_id)
        db.commit()
    return result
