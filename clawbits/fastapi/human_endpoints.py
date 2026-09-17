"""Human-facing data endpoints. Authentication lives in :mod:`clawbits.fastapi.workos_auth`."""

import asyncio
import logging
import os
import time
import uuid
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request
from imapclient.exceptions import LoginError
from packaging.version import InvalidVersion, Version
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from sqlmodel import Session

from clawbits import audit
from clawbits.agent_marks import tidemarks
from clawbits.automations import AUTOMATION_INCAPABLE_RUNTIMES, SpecValidationError, validate_spec
from clawbits.avatars.payloads import avatar_ref_for_agent, avatar_ref_for_user
from clawbits.datastructures.action_models import (
    ActionListItem,
    ActionListResponse,
    ActionResponse,
    AgentActionsResponse,
)
from clawbits.datastructures.agent_id import AgentId
from clawbits.datastructures.challenge_question_response import ChallengeQuestionResponse
from clawbits.datastructures.email_models import (
    EmailCountResponse,
    EmailDetailResponse,
    EmailListResponse,
    EmailSetReadRequest,
)
from clawbits.datastructures.mm_models import (
    AgentModelsResponse,
    MmChannelEventResponse,
    ModelChoice,
    ModelOption,
    PrivacyModeRequest,
    PrivacyModeResponse,
    PrivacySettingsRequest,
    PrivacySettingsResponse,
    SetAgentModelRequest,
)
from clawbits.datastructures.org_models import (
    AddOrgMemberRequest,
    CreateOrgRequest,
    CreateReefAgentRequest,
    CreateReefAgentResponse,
    OrgAttentionResponse,
    OrgListResponse,
    OrgLobstertalkChannelResponse,
    OrgLobstertalkHealthResponse,
    OrgLobstertalkResponse,
    OrgMemberResponse,
    OrgMembersListResponse,
    OrgResponse,
    ReefAgentResponse,
    ReefHostResponse,
    ReefResponse,
    ReefRoleResponse,
    ReefSecretResponse,
    SetOrgAttentionRequest,
    SetOrgLobstertalkChannelRequest,
    SetOrgLobstertalkRequest,
    SetReefRepoRequest,
    UpdateOrgMemberRoleRequest,
    UpdateOrgRequest,
)
from clawbits.db.models import (
    AGENT_USAGE_SCHEMA_VERSION,
    DISPLAY_NAME_MAX_LENGTH,
    Agent,
    AgentModelCatalog,
    AgentPost,
    AgentProfile,
    AgentSkillInstall,
    HumanUser,
)
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
from clawbits.email.stalwart_provision import deprovision_mailbox
from clawbits.fastapi.agent_signup import AgentSignup, HumanSession
from clawbits.fastapi.session_cookie import stage_session_clear
from clawbits.fastapi.workos_auth import (
    MeResponse,
    create_workos_organization,
    delete_workos_organization,
    delete_workos_user,
    get_current_human_user,
    register_membership,
    unregister_membership,
    update_membership_role,
)
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
    publish_channel_event,
    publish_channel_removed,
    publish_member_removed,
    publish_model_selection,
    publish_org_added,
    publish_org_updated,
    publish_user_status,
)
from clawbits.reef_repo import (
    NAME_RE,
    OWNER_RE,
    Author,
    ReefRepo,
    ReefRepoError,
    Role,
    fleet_name,
    fleet_toml,
    parse_role,
    parse_status,
)
from clawbits.skills.render import SKILL_RUNTIMES, render_skill, resolve_runtime
from clawbits.skills.spec import (
    SkillValidationError,
    normalize_files,
    normalize_manifest,
    validate_bundle,
    validate_manifest,
    validate_slug,
)
from clawbits.ssrf import HostResolutionError, PrivateAddressError, arun_guarded

logger = logging.getLogger(__name__)
human_router = APIRouter(tags=["Human"])

# The resolver thread can't be cancelled, so this bounds the save request, not the lookup.
ENDPOINT_CHECK_TIMEOUT_SECONDS = 5.0

# Per-process sliding windows, so with N workers the real ceiling is N times these.
_RATE_BUCKETS: dict[str, list[float]] = {}
_LOBSTERTALK_SAVE_LIMIT = 20
_LOBSTERTALK_HEALTH_LIMIT = 6
_LOBSTERTALK_RATE_WINDOW_S = 60.0


def _get_db(request: Request) -> Session:
    return Session(request.app._engine)


def _in_db[T](request: Request, fn: Callable[[Session], T]) -> Awaitable[T]:
    """Run ``fn`` against its own session on a worker thread, off the event loop."""

    def run() -> T:
        with _get_db(request) as db:
            return fn(db)

    return asyncio.to_thread(run)


def _rate_limit(key: str, *, limit: int, window_s: float = _LOBSTERTALK_RATE_WINDOW_S) -> None:
    """429 once ``key`` has been hit ``limit`` times in the last ``window_s`` seconds."""
    now = time.monotonic()
    hits = [t for t in _RATE_BUCKETS.get(key, ()) if t >= now - window_s]
    if len(hits) >= limit:
        # The hint rides in the detail: the global HTTPException handler drops exc.headers.
        retry = max(1, int(window_s - (now - hits[0])))
        raise HTTPException(status_code=429, detail=f"Too many requests; retry in ~{retry}s")
    hits.append(now)
    _RATE_BUCKETS[key] = hits


class UpdateProfileRequest(BaseModel):
    display_name: str | None = Field(default=None, max_length=DISPLAY_NAME_MAX_LENGTH)


def _settings_response(row: HumanUser) -> PrivacySettingsResponse:
    return PrivacySettingsResponse(
        last_seen_visible=row.last_seen_visible,
        online_status_visible=row.online_status_visible,
        read_receipts_enabled=row.read_receipts_enabled,
        typing_indicators_enabled=row.typing_indicators_enabled,
    )


async def _rebroadcast_presence(
    human_id: int, fresh: dict | None, channel_ids: list[str], fellow_ids: list[int]
) -> tuple[str, str | None]:
    """Publish the user's presence as peers may now see it; returns the status and last-seen sent."""
    from clawbits.fastapi.human_mm_endpoints import _resolve_presence_view

    bus = get_bus()
    status, last_seen, label = _resolve_presence_view(fresh, await bus.user_presence_get(human_id))
    fire_and_forget(
        publish_user_status(
            bus, human_id, status, last_seen, channel_ids, fellow_ids, last_seen_label=label
        )
    )
    return status, last_seen


@human_router.get("/api/human/privacy-settings", response_model=PrivacySettingsResponse)
def get_privacy_settings(
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Return the calling human's four per-signal privacy flags."""
    with _get_db(request) as db:
        row = db.get(HumanUser, int(user["id"]))
        if row is None:
            raise HTTPException(status_code=404, detail="User not found")
        return _settings_response(row)


@human_router.patch("/api/human/privacy-settings", response_model=PrivacySettingsResponse)
def update_privacy_settings(
    body: PrivacySettingsRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Apply a partial update to the four per-signal privacy flags; absent keys
    keep their value. A change to what peers see re-broadcasts presence at once
    instead of waiting for the next heartbeat."""
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
    peers_affected = body.online_status_visible is not None or body.last_seen_visible is not None
    if peers_affected and fresh is not None:
        fire_and_forget(_rebroadcast_presence(human_id, fresh, channel_ids, fellow_ids))
    return response


@human_router.post("/api/human/privacy-mode", response_model=PrivacyModeResponse)
async def set_privacy_mode(
    body: PrivacyModeRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Enable or disable privacy mode for the current human.

    Broadcasts and returns the presence the bus now resolves to, so peers and
    the caller's UI flip together. Disabling does not guess the true state: the
    next ``/presence`` heartbeat publishes it."""
    human_id = int(user["id"])

    def write(db: Session) -> tuple[list[str], list[int], dict | None]:
        TableWrite.set_human_privacy_mode(db, human_id, body.enabled)
        db.commit()
        return (
            TableRead.get_mm_channel_ids_for_human(db, human_id),
            TableRead.get_fellow_human_ids(db, human_id),
            TableRead.get_human_user_by_id(db, human_id),
        )

    channel_ids, fellow_ids, fresh = await _in_db(request, write)
    status, last_seen = await _rebroadcast_presence(human_id, fresh, channel_ids, fellow_ids)
    return PrivacyModeResponse(
        human_id=human_id, enabled=body.enabled, status=status, last_seen_at=last_seen
    )


@human_router.patch("/api/human/me", response_model=MeResponse)
def update_me(
    body: UpdateProfileRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Update the current user's display name. Answers with the full
    ``GET /api/auth/me`` shape so the client can swap its user in place."""
    with _get_db(request) as db:
        display_name = (body.display_name or "").strip() or None
        TableWrite.update_human_display_name(db, user["id"], display_name)
        updated = TableRead.get_human_user_by_id(db, user["id"])
        db.commit()
    return MeResponse(
        id=updated["id"],
        email=updated["email"],
        display_name=updated["display_name"],
        created_at=updated["created_at"],
        last_seen_at=updated["last_seen_at"],
        avatar=avatar_ref_for_user(
            user_id=updated["id"], version=updated["avatar_version"], kind=updated["avatar_kind"]
        ),
    )


def _verify_org_membership(db, org_id: str, user: dict) -> None:
    if not TableRead.is_org_member(db, org_id, user["id"]):
        raise HTTPException(status_code=403, detail="Not a member of this organization")


def _require_org_owner(db, org_id: str, user: dict, action: str = "change this setting") -> None:
    """The stored role is ``owner``; the wire word is admin."""
    if TableRead.get_org_member_role(db, org_id, user["id"]) != "owner":
        raise HTTPException(status_code=403, detail=f"Only organization admins can {action}")


def _verify_agent_in_org(db, org_id: str, agent_id: str, user: dict) -> None:
    """The caller is a member of ``org_id`` and the agent belongs to it, so its row exists."""
    _verify_org_membership(db, org_id, user)
    if not TableRead.is_agent_in_org(db, agent_id, org_id):
        raise HTTPException(status_code=404, detail="Agent not found in this organization")


def _require_agent_operator(db, org_id: str, agent_id: str, user: dict, action: str) -> None:
    _verify_agent_in_org(db, org_id, agent_id, user)
    if not TableRead.is_agent_operator(db, agent_id, user["id"]):
        raise HTTPException(status_code=403, detail=f"Only the agent's operator can {action}")


def _require_operator_or_admin(db, org_id: str, agent_id: str, user: dict, action: str) -> None:
    _verify_agent_in_org(db, org_id, agent_id, user)
    if not TableRead.can_manage_agent_contacts(db, agent_id, user["id"]):
        raise HTTPException(
            status_code=403, detail=f"Only the agent's operator or an org admin can {action}"
        )


def _require_visible_post(db, post_id: int, user: dict) -> None:
    """404 unless ``post_id`` belongs to an agent in one of the caller's orgs.

    Post ids are a bare serial, so 404 rather than 403: a 403 would confirm the
    id exists in somebody else's organization. An agent with no org (unapproved,
    or the shared ``deleted-agent`` placeholder) is visible to nobody."""
    post = db.get(AgentPost, post_id)
    if post is None:
        raise HTTPException(status_code=404, detail="Post not found")
    org_id = TableRead.get_agent_org_id(db, post.agent_id)
    if org_id is None or not TableRead.is_org_member(db, org_id, user["id"]):
        raise HTTPException(status_code=404, detail="Post not found")


def _operator_payload(db, operator_id: int | None) -> dict | None:
    if operator_id is None:
        return None
    human = TableRead.get_human_user_by_id(db, operator_id)
    if human is None:
        return None
    return {
        "human_id": human["id"],
        "display_name": human["display_name"],
        "avatar": avatar_ref_for_user(
            user_id=human["id"], version=human["avatar_version"], kind=human["avatar_kind"]
        ).model_dump(),
    }


def _agent_payload(db, row: Agent, user: dict) -> dict:
    """What the agents list and the agent profile share."""
    agent_id = AgentId(row.agent_id)
    return {
        "agent_id": row.agent_id,
        "nickname": row.nickname,
        "creation_time": TableRead.get_agent_creation_time(db, agent_id),
        "last_alive_at": TableRead.get_agent_last_alive(db, agent_id),
        "file_count": TableRead.get_agent_file_count(db, agent_id),
        "inter_agent_mode_enabled": row.inter_agent_mode_enabled,
        "snoozed": row.snoozed,
        "inter_agent_message_limit": row.inter_agent_message_limit,
        "is_operator": TableRead.is_agent_operator(db, row.agent_id, user["id"]),
        "can_dm": TableRead.can_dm_agent(db, row.agent_id, human_id=user["id"]),
        "can_tag": TableRead.can_tag_agent(db, row.agent_id, human_id=user["id"]),
        "can_manage_contacts": TableRead.can_manage_agent_contacts(db, row.agent_id, user["id"]),
        "operator": _operator_payload(db, row.operator_id),
        "avatar": avatar_ref_for_agent(
            agent_id=row.agent_id, version=row.avatar_version, kind=row.avatar_kind
        ).model_dump(),
        "reef_host": row.reef_host,
        "reef_name": row.reef_name,
        "agent_type": row.agent_type,
        "plugin_version": row.plugin_version,
    }


@human_router.get("/api/human/orgs/{org_id}/agents")
def list_agents(
    org_id: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """List agents owned by an organization. Caller must be an org member."""
    with _get_db(request) as db:
        _verify_org_membership(db, org_id, user)
        agents = []
        for agent_id in TableRead.get_agents_owned_by_org(db, org_id):
            profile = db.get(AgentProfile, agent_id)
            agents.append({
                **_agent_payload(db, db.get(Agent, agent_id), user),
                "display_name": profile.display_name if profile else None,
                "description": profile.description if profile else None,
                "description_source": profile.description_source if profile else None,
                "description_regen_pending": bool(profile and profile.description_regen_requested_at),
            })
        return {"agents": agents, "total": len(agents)}


_USAGE_RANGE_KEYS = ("day", "week", "month", "all")
_USAGE_COUNTERS = ("input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "call_count")


def _usage_zero_totals() -> dict:
    """``cost_usd`` stays null until a costed event lands: subscription agents report no cost."""
    return {
        "input_tokens": 0,
        "output_tokens": 0,
        "cache_read_tokens": 0,
        "cache_write_tokens": 0,
        "cost_usd": None,
        "call_count": 0,
    }


def _fold_usage(total: dict, row: dict) -> None:
    for key in _USAGE_COUNTERS:
        total[key] += row[key]
    if row["cost_usd"] is not None:
        total["cost_usd"] = (total["cost_usd"] or 0.0) + row["cost_usd"]


def _headline_tokens(row: dict) -> int:
    return row["input_tokens"] + row["output_tokens"]


def _usage_per_model(rows: list[dict]) -> list[dict]:
    by_model: dict[tuple, dict] = {}
    for r in rows:
        blank = {"model": r["model"], "provider": r["provider"], **_usage_zero_totals()}
        _fold_usage(by_model.setdefault((r["model"], r["provider"]), blank), r)
    return sorted(by_model.values(), key=_headline_tokens, reverse=True)


def _usage_range_or_400(range_key: str):
    if range_key not in _USAGE_RANGE_KEYS:
        raise HTTPException(status_code=400, detail="range must be one of day|week|month|all")
    return TableRead.usage_range_start(range_key)


@human_router.get("/api/human/orgs/{org_id}/usage")
def get_org_usage(
    org_id: str,
    request: Request,
    range_key: str = Query("week", alias="range"),
    group_by: str = Query("agent"),
    user: dict = Depends(get_current_human_user),
):
    """Org-wide AI token usage: advisory, agent-self-reported telemetry, never a billing input.

    RBAC is enforced here: org owners get the per-agent breakdown, members get
    org totals (plus the per-model view when asked) only. Agents that never
    reported stay on the roster as "no data", so totals are never silently
    short. See ``docs/protocol/AGENT_USAGE_TRACKING_PLAN.md``.
    """
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

        by_day: dict[str, dict] = {}
        for r in TableRead.get_org_usage_daily_rows(db, org_id, since):
            day = by_day.setdefault(r["date"], {"date": r["date"], **_usage_zero_totals(), "by_agent": {}})
            _fold_usage(day, r)
            day["by_agent"][r["agent_id"]] = day["by_agent"].get(r["agent_id"], 0) + _headline_tokens(r)
        daily = sorted(by_day.values(), key=lambda d: d["date"])
        if not is_owner:
            for day in daily:
                del day["by_agent"]

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

        by_agent: dict[str, dict] = {}
        models_by_agent: dict[str, dict[str, int]] = {}
        for r in rows:
            _fold_usage(by_agent.setdefault(r["agent_id"], _usage_zero_totals()), r)
            models = models_by_agent.setdefault(r["agent_id"], {})
            models[r["model"]] = models.get(r["model"], 0) + _headline_tokens(r)
        reporting_ids = TableRead.get_reporting_agent_ids(db, org_id)
        per_agent = []
        for aid in TableRead.get_agents_owned_by_org(db, org_id):
            models = models_by_agent.get(aid, {})
            per_agent.append({
                "agent_id": aid,
                "nickname": TableRead.get_agent_nickname(db, AgentId(aid)),
                "display_name": TableRead.get_agent_profile_display_name(db, aid),
                "reporting": aid in reporting_ids,
                **by_agent.get(aid, _usage_zero_totals()),
                "top_models": sorted(models, key=models.__getitem__, reverse=True)[:3],
            })
        payload["per_agent"] = sorted(per_agent, key=_headline_tokens, reverse=True)
        return payload


@human_router.get("/api/human/orgs/{org_id}/agents/{agent_id}/usage")
def get_agent_usage(
    org_id: str,
    agent_id: str,
    request: Request,
    range_key: str = Query("week", alias="range"),
    user: dict = Depends(get_current_human_user),
):
    """One agent's AI usage, for org owners or the agent's operator; a plain
    member sees org totals only. Same advisory caveats as the org endpoint."""
    since = _usage_range_or_400(range_key)
    with _get_db(request) as db:
        _verify_agent_in_org(db, org_id, agent_id, user)
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
        return {
            "schema_version": AGENT_USAGE_SCHEMA_VERSION,
            "range": range_key,
            "agent_id": agent_id,
            "reporting": bool(rows or TableRead.get_agent_usage_rows(db, agent_id, None)),
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
    """Hard-delete an agent. Any member of the org the agent belongs to can,
    and for members who don't operate it this is their only power over it.

    With ``keep_content=true`` the agent's authored content is reattributed to a
    shared "Deleted agent" placeholder instead of being deleted. Every group
    channel it left gets a "left the channel" timeline event, fanned out so open
    tabs render it without a refetch.

    A reef-hosted agent loses its fleet file too, so the next reconcile prunes
    the VM instead of leaving it running under a name nothing owns, and its
    signup token dies with the row. Mailbox and fleet cleanup are best-effort
    and run after the delete commits."""

    def delete(db: Session) -> tuple[tuple[str, str] | None, list[dict]]:
        _verify_agent_in_org(db, org_id, agent_id, user)
        placement = TableRead.get_reef_placement(db, org_id, agent_id)
        if placement:
            # Revoked with the row, not beside the file removal: the token must die even when GitHub is down.
            TableWrite.revoke_reef_signup(db, org_id, *placement)
        departures = TableWrite.delete_agent(
            db, agent_id, keep_content=keep_content, actor_human_id=user["id"]
        )
        db.commit()
        return placement, departures

    placement, departures = await _in_db(request, delete)
    for departure in departures:
        fire_and_forget(
            publish_channel_event(
                get_bus(),
                departure["channel_id"],
                MmChannelEventResponse(**departure["event"]).model_dump(),
                member_human_ids=departure["member_human_ids"],
            )
        )
    try:
        await asyncio.to_thread(deprovision_mailbox, agent_id)
    except Exception:
        logger.exception("Failed to deprovision Stalwart mailbox for %s", agent_id)
    if placement:
        host, name = placement
        try:
            repo = await _in_db(request, lambda db: _reef_repo(db, org_id, user))
            await _undeclare(repo, org_id, host, name, user)
        except HTTPException:
            logger.info("No Reef repository for %s, left %s/%s behind", org_id, host, name)
        except Exception:
            logger.exception("Failed to remove fleet file %s/%s for %s", host, name, agent_id)
    return {"agent_id": agent_id, "org_id": org_id, "deleted": True}


@human_router.delete("/api/human/account", status_code=204)
def delete_my_account(
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Permanently delete the authenticated user's account and all of their
    data. Self-service only.

    Refuses with 409 while the user still operates agents or is the sole owner
    of an organization that has other members; the detail says what to resolve
    first. On success the session cookies are cleared, logging the client out.
    WorkOS cleanup is best-effort and runs only after the local delete commits;
    orgs the user solely occupied are torn down there so a later login cannot
    re-adopt them."""
    with _get_db(request) as db:
        try:
            deleted_workos_org_ids = TableWrite.delete_human_user(db, user["id"])
        except UserDeletionBlocked as e:
            raise HTTPException(status_code=409, detail=str(e)) from e
        db.commit()

    client = request.app.state.workos
    delete_workos_user(client, workos_user_id=user.get("workos_user_id") or "")
    for workos_org_id in deleted_workos_org_ids:
        delete_workos_organization(client, workos_org_id=workos_org_id)
    stage_session_clear(request)


class UpdateAgentSettingsRequest(BaseModel):
    inter_agent_mode_enabled: bool | None = None
    snoozed: bool | None = None
    inter_agent_message_limit: int | None = Field(default=None, ge=1, le=50)
    lobstertalk_enabled: bool | None = None
    lobstertalk_ollama_host: str | None = Field(default=None, max_length=200)
    lobstertalk_ollama_model: str | None = Field(default=None, max_length=100)
    lobstertalk_interval_seconds: int | None = Field(default=None, ge=15, le=3600)
    lobstertalk_message_limit: int | None = Field(default=None, ge=10, le=200)


def _agent_settings(row: Agent) -> dict:
    return {name: getattr(row, name) for name in UpdateAgentSettingsRequest.model_fields}


_PROFILE_FIELDS = (
    "display_name",
    "bio",
    "location",
    "website",
    "avatar_url",
    "header_url",
    "description",
    "description_generated_at",
    "description_source",
)


@human_router.get("/api/human/orgs/{org_id}/agents/{agent_id}")
def get_agent_profile(
    org_id: str,
    agent_id: str,
    request: Request,
    limit: int = 50,
    offset: int = 0,
    user: dict = Depends(get_current_human_user),
):
    """Get an agent's profile. Caller must be a member of the owning organization."""
    with _get_db(request) as db:
        _verify_agent_in_org(db, org_id, agent_id, user)
        row = db.get(Agent, agent_id)
        profile = TableRead.get_agent_profile(db, agent_id) or {}
        return {
            **_agent_payload(db, row, user),
            **_agent_settings(row),
            **{field: profile.get(field) for field in _PROFILE_FIELDS},
            "email_address": agent_email_address(agent_id),
            "description_regen_pending": bool(profile.get("description_regen_requested_at")),
            "files": TableRead.get_agent_files(db, AgentId(agent_id), limit=limit, offset=offset),
            "posts": TableRead.get_agent_posts(db, AgentId(agent_id), limit=20, offset=0),
            "action_count": TableRead.count_agent_actions_for_agent(db, agent_id),
            "tidemarks": tidemarks(TableRead.get_agent_marks(db, agent_id), row.agent_type),
        }


def _require_inbox_operator(request: Request, org_id: str, agent_id: str, user: dict) -> None:
    """An agent's mail is sensitive: its inbox is operator-only, not open to the whole org."""
    with _get_db(request) as db:
        _require_agent_operator(db, org_id, agent_id, user, "access its inbox")


def _read_mailbox[T](read: Callable[..., T], agent_id: str, *args) -> T | None:
    """``None`` when mail is unconfigured or the mailbox was never provisioned
    (signup provisions it best-effort, so IMAP login raises ``LoginError``):
    the read degrades to empty instead of a 500."""
    if not STALWART_SVC_PASSWORD:
        return None
    try:
        return read(agent_id, *args)
    except LoginError:
        return None
    except Exception:
        logger.exception("mailbox read failed for %s", agent_id)
        raise HTTPException(status_code=500, detail="Failed to read mailbox") from None


def _mailbox_message[T](call: Callable[..., T], agent_id: str, message_uid: int, *args, failure: str) -> T:
    """One per-message IMAP call: 503 when mail is unconfigured, 404 for a missing mailbox or message."""
    if not STALWART_SVC_PASSWORD:
        raise HTTPException(status_code=503, detail="Email service not configured")
    missing = HTTPException(status_code=404, detail=f"Email with UID {message_uid} not found")
    try:
        result = call(agent_id, message_uid, *args)
    except LoginError:
        raise missing from None
    except Exception:
        logger.exception("email %s failed for %s uid=%s", failure, agent_id, message_uid)
        raise HTTPException(status_code=500, detail=f"Failed to {failure}") from None
    if not result:
        raise missing
    return result


@human_router.get(
    "/api/human/orgs/{org_id}/agents/{agent_id}/email/count",
    response_model=EmailCountResponse,
)
def get_agent_email_count(
    org_id: str,
    agent_id: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
) -> EmailCountResponse:
    """Total and unread counts for the agent's mailbox. Operator-only; zeroes
    when email isn't configured or the mailbox isn't provisioned yet."""
    _require_inbox_operator(request, org_id, agent_id, user)
    counts = _read_mailbox(get_email_counts, agent_id)
    if counts is None:
        return EmailCountResponse(total=0, unread=0, email_address=agent_email_address(agent_id))
    if counts["total"]:
        with _get_db(request) as db:
            TableWrite.award_mark(db, agent_id, "mail")
            db.commit()
    return EmailCountResponse.model_validate(counts)


@human_router.get(
    "/api/human/orgs/{org_id}/agents/{agent_id}/email/inbox",
    response_model=EmailListResponse,
)
def get_agent_email_inbox(
    org_id: str,
    agent_id: str,
    request: Request,
    limit: int = 50,
    offset: int = 0,
    unread_only: bool = False,
    user: dict = Depends(get_current_human_user),
) -> EmailListResponse:
    """List the agent's inbox, newest first. Operator-only.

    ``unread_only`` narrows the listing and ``total`` to UNSEEN messages.
    ``limit`` is clamped to 200, as each listing is a live IMAP fetch. Empty
    when email isn't configured or the mailbox isn't provisioned yet."""
    _require_inbox_operator(request, org_id, agent_id, user)
    limit = min(max(limit, 1), 200)
    result = _read_mailbox(list_emails, agent_id, limit, offset, unread_only)
    if result is None:
        return EmailListResponse(emails=[], total=0, unread_count=0, limit=limit, offset=offset)
    return EmailListResponse.model_validate(result)


@human_router.get(
    "/api/human/orgs/{org_id}/agents/{agent_id}/email/{message_uid}",
    response_model=EmailDetailResponse,
)
def get_agent_email_detail(
    org_id: str,
    agent_id: str,
    message_uid: int,
    request: Request,
    user: dict = Depends(get_current_human_user),
) -> EmailDetailResponse:
    """Fetch one message (body, attachments, headers) and mark it read. Operator-only."""
    _require_inbox_operator(request, org_id, agent_id, user)
    return EmailDetailResponse(
        **_mailbox_message(get_email, agent_id, message_uid, failure="read mailbox")
    )


@human_router.patch(
    "/api/human/orgs/{org_id}/agents/{agent_id}/email/{message_uid}",
)
def set_agent_email_read(
    org_id: str,
    agent_id: str,
    message_uid: int,
    body: EmailSetReadRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
) -> dict:
    """Set or clear a message's read state (``\\Seen`` flag) without opening it. Operator-only."""
    _require_inbox_operator(request, org_id, agent_id, user)
    _mailbox_message(set_email_read, agent_id, message_uid, body.is_read, failure="update message")
    return {
        "status": "updated",
        "agent_id": agent_id,
        "message_uid": message_uid,
        "is_read": body.is_read,
    }


@human_router.delete(
    "/api/human/orgs/{org_id}/agents/{agent_id}/email/{message_uid}",
)
def delete_agent_email(
    org_id: str,
    agent_id: str,
    message_uid: int,
    request: Request,
    user: dict = Depends(get_current_human_user),
) -> dict:
    """Delete one message by UID. Operator-only."""
    _require_inbox_operator(request, org_id, agent_id, user)
    _mailbox_message(delete_email, agent_id, message_uid, failure="delete message")
    return {"status": "deleted", "agent_id": agent_id, "message_uid": message_uid}


def _normalize_ollama_host(raw: str) -> str | None:
    """Canonicalize an operator-supplied Ollama base URL to scheme://host:port.

    Accepts ``host``, ``host:port`` or ``http(s)://host[:port]`` (default scheme
    http, default port 11434). Empty input clears the setting. Rejects paths,
    queries and credentials.
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
        parts = urlsplit(value)
        port = parts.port
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
def update_agent_settings(
    org_id: str,
    agent_id: str,
    body: UpdateAgentSettingsRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Update an agent's operator-controlled settings. Operator-only. The Ollama
    host and model clear on an explicit null or empty string, so a field's
    presence in the body matters, not only a non-null value."""
    with _get_db(request) as db:
        _require_agent_operator(db, org_id, agent_id, user, "change these settings")
        clears = {"lobstertalk_ollama_host", "lobstertalk_ollama_model"} & body.model_fields_set
        if not clears and not body.model_dump(exclude_none=True):
            raise HTTPException(status_code=400, detail="No settings provided")
        host = body.lobstertalk_ollama_host
        ollama_host = _normalize_ollama_host(host) if host is not None else None
        ollama_model = (body.lobstertalk_ollama_model or "").strip() or None
        updated = TableWrite.update_agent_settings(
            db,
            agent_id,
            inter_agent_mode_enabled=body.inter_agent_mode_enabled,
            snoozed=body.snoozed,
            inter_agent_message_limit=body.inter_agent_message_limit,
            lobstertalk_enabled=body.lobstertalk_enabled,
            lobstertalk_ollama_host=ollama_host,
            clear_lobstertalk_ollama_host="lobstertalk_ollama_host" in clears and ollama_host is None,
            lobstertalk_ollama_model=ollama_model,
            clear_lobstertalk_ollama_model="lobstertalk_ollama_model" in clears and ollama_model is None,
            lobstertalk_interval_seconds=body.lobstertalk_interval_seconds,
            lobstertalk_message_limit=body.lobstertalk_message_limit,
        )
        if updated is None:
            raise HTTPException(status_code=404, detail="Agent not found")
        db.commit()
        return {"agent_id": agent_id, **_agent_settings(updated)}


@human_router.patch("/api/human/orgs/{org_id}/agents/{agent_id}/name")
def rename_agent(
    org_id: str,
    agent_id: str,
    body: RenameAgentRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Rename an agent, replacing its generated nickname. Operator-only. Clears
    any agent-set profile display_name, which resolution prefers, so the new
    name is what every surface shows. ``agent_id`` never changes."""
    with _get_db(request) as db:
        _require_agent_operator(db, org_id, agent_id, user, "rename it")
        nickname = body.nickname.strip()
        if not nickname:
            raise HTTPException(status_code=400, detail="Name cannot be empty")
        updated = TableWrite.rename_agent(db, agent_id, nickname)
        if updated is None:
            raise HTTPException(status_code=404, detail="Agent not found")
        db.commit()
        return {"agent_id": agent_id, "nickname": updated.nickname}


@human_router.get(
    "/api/human/orgs/{org_id}/agents/{agent_id}/models", response_model=AgentModelsResponse
)
def get_agent_models(
    org_id: str,
    agent_id: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
) -> AgentModelsResponse:
    """The models the agent reported, its runtime default and the operator's agent default.
    ``models`` is null until the agent reports. Operator-only."""
    with _get_db(request) as db:
        _require_agent_operator(db, org_id, agent_id, user, "choose its model")
        agent = db.get_one(Agent, agent_id)
        catalog = db.get(AgentModelCatalog, agent_id)
        default = ModelChoice(model=agent.model, thinking=agent.thinking)
        if catalog is None:
            return AgentModelsResponse(
                models=None, runtime_default=None, default=default, reported_at=None
            )
        return AgentModelsResponse(
            models=[ModelOption.model_validate(m) for m in catalog.models],
            runtime_default=ModelChoice(
                model=catalog.default_model, thinking=catalog.default_thinking
            ),
            default=default,
            reported_at=catalog.reported_at,
        )


@human_router.put(
    "/api/human/orgs/{org_id}/agents/{agent_id}/models", response_model=ModelChoice
)
async def set_agent_model(
    org_id: str,
    agent_id: str,
    body: SetAgentModelRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
) -> ModelChoice:
    """Set the agent default (``channel_id`` null) or one conversation's choice, null
    inheriting per field. Operator-only. ``thinking`` must be a level of the effective model:
    ``model``, else for a conversation the agent default, else the runtime default. The agent
    is told before this returns."""

    def write(db: Session) -> None:
        _require_agent_operator(db, org_id, agent_id, user, "choose its model")
        if body.channel_id is not None and not (
            TableRead.is_mm_channel_member_human(db, body.channel_id, user["id"])
            and TableRead.is_mm_channel_member(db, body.channel_id, agent_id)
        ):
            raise HTTPException(status_code=404, detail="Channel not found")
        catalog = db.get(AgentModelCatalog, agent_id)
        if catalog is None:
            raise HTTPException(status_code=422, detail="The agent has not reported its models")
        levels = {
            option.ref: option.levels for option in map(ModelOption.model_validate, catalog.models)
        }
        if body.model is not None and body.model not in levels:
            raise HTTPException(status_code=422, detail="The agent does not offer this model")
        agent_default = db.get_one(Agent, agent_id).model if body.channel_id is not None else None
        effective = body.model or agent_default or catalog.default_model
        if body.thinking is not None and (
            effective is None or body.thinking not in levels.get(effective, [])
        ):
            raise HTTPException(
                status_code=422, detail="The model does not support this thinking level"
            )
        TableWrite.set_model_choice(db, agent_id, body)
        db.commit()

    await _in_db(request, write)
    await publish_model_selection(get_bus(), agent_id, body)
    return ModelChoice(model=body.model, thinking=body.thinking)


class CreateAutomationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    desired_spec: dict


class UpdateAutomationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    desired_spec: dict


# Fixed rather than min_plugin_version(), which tightens on every unrelated plugin bump.
_HERMES_AUTOMATIONS_MIN_VERSION = Version("0.7.0")


def _require_automation_capable_runtime(db, agent_id: str) -> None:
    """422 when the agent's runtime can't apply clawbits-managed automations.
    An older Hermes plugin would leave the row on "requested" forever, which the
    UI renders as an invisible "Applying". A Hermes agent with no parseable
    version passes, like an unknown runtime. Gates create, update and run: list
    and delete stay open so existing rows remain visible and removable."""
    row = db.get(Agent, agent_id)
    if row.agent_type in AUTOMATION_INCAPABLE_RUNTIMES:
        raise HTTPException(
            status_code=422,
            detail=(
                "Automations are not supported by this agent runtime; "
                f"this agent runs {row.agent_type}"
            ),
        )
    if row.agent_type != "hermes" or not row.plugin_version:
        return
    try:
        reported = Version(row.plugin_version)
    except InvalidVersion:
        return
    if reported < _HERMES_AUTOMATIONS_MIN_VERSION:
        raise HTTPException(
            status_code=422,
            detail=(
                "Automations need Clawbits Hermes plugin "
                f"{_HERMES_AUTOMATIONS_MIN_VERSION} or newer; this agent reports "
                f"{row.plugin_version}. Redeploy the agent to upgrade its plugin."
            ),
        )


def _validate_automation(db, agent_id: str, spec: dict) -> None:
    """400 for an invalid spec, or for a ``delivery.to`` channel the agent is
    not in. That check is the security boundary: the plugin does not gate
    explicit delivery on membership. No ``delivery`` means the owner DM."""
    try:
        validate_spec(spec)
    except SpecValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    delivery = spec.get("delivery")
    to = delivery.get("to") if isinstance(delivery, dict) else None
    if to and not TableRead.is_mm_channel_member(db, to, agent_id):
        raise HTTPException(
            status_code=400, detail="Agent is not a member of the chosen delivery channel"
        )


def _require_managed_automation(db, automation_id: str, agent_id: str, refusal: str) -> None:
    existing = TableRead.get_automation_for_agent(db, automation_id, agent_id)
    if existing is None:
        raise HTTPException(status_code=404, detail="Automation not found")
    if existing.managed_by != "clawbits":
        raise HTTPException(status_code=409, detail=refusal)


def _commit_and_nudge(db, agent_id: str) -> None:
    """Commit a change to the desired set and nudge the agent's plugin to
    reconcile its own gateway cron. See
    docs/protocol/OPENCLAW_AUTOMATIONS_INTEGRATION_STRATEGY.md."""
    generation = TableRead.agent_desired_generation(db, agent_id)
    db.commit()
    fire_and_forget(publish_automation_sync(get_bus(), agent_id, generation))


@human_router.get("/api/human/orgs/{org_id}/automations")
def list_org_automations(
    org_id: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Every automation across the org's agents the caller operates, in one call."""
    with _get_db(request) as db:
        _verify_org_membership(db, org_id, user)
        return {"automations": TableRead.list_org_automations_for_operator(db, org_id, user["id"])}


@human_router.get("/api/human/orgs/{org_id}/agents/{agent_id}/automations")
def list_agent_automations(
    org_id: str,
    agent_id: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """List an agent's automations (operator-only)."""
    with _get_db(request) as db:
        _require_agent_operator(db, org_id, agent_id, user, "manage its automations")
        return {"automations": TableRead.list_agent_automations(db, agent_id)}


@human_router.post("/api/human/orgs/{org_id}/agents/{agent_id}/automations")
def create_agent_automation(
    org_id: str,
    agent_id: str,
    body: CreateAutomationRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Create a Clawbits-managed automation and nudge the agent to reconcile."""
    with _get_db(request) as db:
        _require_agent_operator(db, org_id, agent_id, user, "manage its automations")
        _require_automation_capable_runtime(db, agent_id)
        _validate_automation(db, agent_id, body.desired_spec)
        row = TableWrite.create_automation(
            db,
            agent_id=agent_id,
            org_id=org_id,
            desired_spec=body.desired_spec,
            created_by=user["id"],
        )
        result = TableRead._automation_to_dict(row)
        _commit_and_nudge(db, agent_id)
    return result


@human_router.patch(
    "/api/human/orgs/{org_id}/agents/{agent_id}/automations/{automation_id}"
)
def update_agent_automation(
    org_id: str,
    agent_id: str,
    automation_id: str,
    body: UpdateAutomationRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Replace a managed automation's desired spec and nudge the agent."""
    with _get_db(request) as db:
        _require_agent_operator(db, org_id, agent_id, user, "manage its automations")
        _require_automation_capable_runtime(db, agent_id)
        _require_managed_automation(db, automation_id, agent_id, "External automations are read-only")
        _validate_automation(db, agent_id, body.desired_spec)
        row = TableWrite.update_automation_desired(db, automation_id, desired_spec=body.desired_spec)
        if row is None:
            raise HTTPException(status_code=404, detail="Automation not found")
        result = TableRead._automation_to_dict(row)
        _commit_and_nudge(db, agent_id)
    return result


@human_router.delete(
    "/api/human/orgs/{org_id}/agents/{agent_id}/automations/{automation_id}"
)
def delete_agent_automation(
    org_id: str,
    agent_id: str,
    automation_id: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Mark a managed automation for removal and nudge the agent. The row is
    finalized once the agent confirms it removed the gateway job."""
    with _get_db(request) as db:
        _require_agent_operator(db, org_id, agent_id, user, "manage its automations")
        _require_managed_automation(db, automation_id, agent_id, "External automations are read-only")
        TableWrite.delete_automation(db, automation_id)
        _commit_and_nudge(db, agent_id)
    return {"automation_id": automation_id, "status": "removing"}


@human_router.get(
    "/api/human/orgs/{org_id}/agents/{agent_id}/automations/{automation_id}/runs"
)
def list_agent_automation_runs(
    org_id: str,
    agent_id: str,
    automation_id: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Recent runs for an automation (operator-only)."""
    with _get_db(request) as db:
        _require_agent_operator(db, org_id, agent_id, user, "manage its automations")
        if TableRead.get_automation_for_agent(db, automation_id, agent_id) is None:
            raise HTTPException(status_code=404, detail="Automation not found")
        return {"runs": TableRead.list_automation_runs(db, automation_id)}


@human_router.post(
    "/api/human/orgs/{org_id}/agents/{agent_id}/automations/{automation_id}/run"
)
def run_agent_automation_now(
    org_id: str,
    agent_id: str,
    automation_id: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Request an immediate one-off run of a managed automation, then nudge the
    agent. Best-effort: the plugin runs the job on its next reconcile, within
    seconds via the nudge, or once on reconnect. Operator-only."""
    with _get_db(request) as db:
        _require_agent_operator(db, org_id, agent_id, user, "manage its automations")
        _require_automation_capable_runtime(db, agent_id)
        _require_managed_automation(db, automation_id, agent_id, "External automations cannot be run")
        row = TableWrite.request_automation_run(db, automation_id)
        if row is None:
            raise HTTPException(status_code=404, detail="Automation not found")
        result = TableRead._automation_to_dict(row)
        _commit_and_nudge(db, agent_id)
    return result


@human_router.get("/api/human/orgs/{org_id}/agents/{agent_id}/channels")
def list_agent_delivery_channels(
    org_id: str,
    agent_id: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Channels and DMs the agent is a member of: the pickable delivery targets
    for an automation. Operator-only, like the automation routes."""
    with _get_db(request) as db:
        _require_agent_operator(db, org_id, agent_id, user, "manage its automations")
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
def regenerate_agent_description(
    org_id: str,
    agent_id: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Ask the agent to regenerate its description. Operator or org owner.

    Generation happens agent-side: this sets a flag the agent picks up on its
    next ``GET /info``, and its ``PUT /description`` clears it."""
    with _get_db(request) as db:
        _require_operator_or_admin(db, org_id, agent_id, user, "regenerate its description")
        TableWrite.request_agent_description_regen(db, agent_id)
        db.commit()
    return {"agent_id": agent_id, "description_regen_pending": True}


@human_router.patch("/api/human/orgs/{org_id}/agents/{agent_id}/description")
def set_agent_description_manual(
    org_id: str,
    agent_id: str,
    body: SetAgentDescriptionRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Manually set the agent's public description. Operator or org owner.
    Stored with ``source="manual"``, superseding any pending regenerate request;
    the agent can still overwrite it later via ``PUT /description``."""
    with _get_db(request) as db:
        _require_operator_or_admin(db, org_id, agent_id, user, "set its description")
        text = body.description.strip()
        if not text:
            raise HTTPException(status_code=400, detail="Description can't be empty")
        TableWrite.set_agent_description(db, agent_id, text, source="manual")
        db.commit()
    return {"agent_id": agent_id, "description": text[:280], "description_source": "manual"}


@human_router.get("/api/human/shared_content")
def list_shared_content(
    request: Request,
    limit: int = 50,
    offset: int = 0,
    user: dict = Depends(get_current_human_user),
):
    """List recent shared files across the caller's organizations."""
    with _get_db(request) as db:
        org_ids = TableRead.get_org_ids_for_human(db, user["id"])
        files = TableRead.get_recent_shared_content(db, org_ids, limit=limit, offset=offset)
        return {"files": files, "total": len(files), "limit": limit, "offset": offset}


@human_router.get("/api/human/posts")
def list_all_agent_posts(
    request: Request,
    limit: int = 50,
    offset: int = 0,
    user: dict = Depends(get_current_human_user),
):
    """List recent agent posts across the caller's organizations."""
    with _get_db(request) as db:
        org_ids = TableRead.get_org_ids_for_human(db, user["id"])
        posts = TableRead.get_all_agent_posts(
            db, org_ids, limit=limit, offset=offset, current_human_id=user["id"]
        )
        return {"posts": posts, "total": len(posts), "limit": limit, "offset": offset}


@human_router.get("/api/human/orgs/{org_id}/agents/{agent_id}/posts")
def get_agent_posts_for_human(
    org_id: str,
    agent_id: str,
    request: Request,
    limit: int = 50,
    offset: int = 0,
    user: dict = Depends(get_current_human_user),
):
    """Get posts from a specific agent. Caller must be a member of the owning organization."""
    with _get_db(request) as db:
        _verify_agent_in_org(db, org_id, agent_id, user)
        posts = TableRead.get_agent_posts(
            db, AgentId(agent_id), limit=limit, offset=offset, current_human_id=user["id"]
        )
        return {"posts": posts, "total": len(posts), "limit": limit, "offset": offset}


class PostCommentRequest(BaseModel):
    message: str = Field(min_length=1, max_length=280)


@human_router.post("/api/human/posts/{post_id}/like")
def like_post(
    post_id: int,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Like a post in one of the caller's organizations."""
    with _get_db(request) as db:
        _require_visible_post(db, post_id, user)
        TableWrite.create_post_like(db, post_id, human_id=user["id"])
        db.commit()
    return {"status": "ok"}


@human_router.delete("/api/human/posts/{post_id}/like")
def unlike_post(
    post_id: int,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Remove like from a post in one of the caller's organizations."""
    with _get_db(request) as db:
        _require_visible_post(db, post_id, user)
        TableWrite.delete_post_like(db, post_id, human_id=user["id"])
        db.commit()
    return {"status": "ok"}


@human_router.get("/api/human/posts/{post_id}/comments")
def get_post_comments(
    post_id: int,
    request: Request,
    limit: int = 50,
    offset: int = 0,
    user: dict = Depends(get_current_human_user),
):
    """Get comments for a post in one of the caller's organizations. The rows
    carry each commenter's name and email, so the scoping guards personal data."""
    with _get_db(request) as db:
        _require_visible_post(db, post_id, user)
        return {"comments": TableRead.get_post_comments(db, post_id, limit, offset)}


@human_router.post("/api/human/posts/{post_id}/comments")
def add_post_comment(
    post_id: int,
    payload: PostCommentRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Add a comment to a post in one of the caller's organizations."""
    with _get_db(request) as db:
        _require_visible_post(db, post_id, user)
        comment_id = TableWrite.create_post_comment(
            db, post_id, message=payload.message, human_id=user["id"]
        )
        db.commit()
    return {"status": "ok", "comment_id": comment_id}


@human_router.post("/api/human/orgs", response_model=OrgResponse)
def create_org(
    body: CreateOrgRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Create a new organization. The caller becomes the owner."""
    client = request.app.state.workos
    with _get_db(request) as db:
        if TableRead.get_org_by_name(db, body.name) is not None:
            raise HTTPException(status_code=409, detail=f"Organization name '{body.name}' is already taken")
        org_id = f"org-{uuid.uuid4()}"
        workos_org_id = create_workos_organization(client, name=body.name)
        TableWrite.create_organization(
            db, org_id, workos_org_id, body.name, body.display_name, False, user["id"]
        )
        TableWrite.add_org_member(db, org_id, user["id"], "owner")
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
    fire_and_forget(publish_org_added(get_bus(), user["id"], response.model_dump()))
    return response


@human_router.get("/api/human/orgs", response_model=OrgListResponse)
def list_orgs(
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """List organizations the current user belongs to."""
    with _get_db(request) as db:
        orgs = TableRead.get_orgs_for_human(db, user["id"])
        return OrgListResponse(organizations=[OrgResponse(**o) for o in orgs], total=len(orgs))


@human_router.get("/api/human/orgs/{org_id}", response_model=OrgResponse)
def get_org(
    org_id: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Get organization details. Caller must be a member."""
    with _get_db(request) as db:
        _verify_org_membership(db, org_id, user)
        org = TableRead.get_organization(db, org_id, viewer_human_id=user["id"])
        if org is None:
            raise HTTPException(status_code=404, detail="Organization not found")
        return OrgResponse(**org)


@human_router.patch("/api/human/orgs/{org_id}", response_model=OrgResponse)
def update_org(
    org_id: str,
    body: UpdateOrgRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Rename the organization's public display name. Admin only."""
    with _get_db(request) as db:
        _require_org_owner(db, org_id, user, "rename the organization")
        TableWrite.update_org_display_name(db, org_id, body.display_name)
        db.commit()
        org = TableRead.get_organization(db, org_id, viewer_human_id=user["id"])
        if org is None:
            raise HTTPException(status_code=404, detail="Organization not found")
        return OrgResponse(**org)


@human_router.post("/api/human/orgs/{org_id}/visit", status_code=204)
def mark_org_visited(
    org_id: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Bump the caller's ``last_visited_at`` on this org to now, clearing the
    switcher's "New" pill. Idempotent."""
    with _get_db(request) as db:
        if not TableWrite.touch_org_member_visit(db, org_id, user["id"]):
            raise HTTPException(status_code=404, detail="Not a member of this organization")
        db.commit()


# Reads are conditional and a 304 is free, so the window stays short enough for the setup wizard to see a new agent.
_REEF_STATUS_TTL = 5.0
_reef_status_cache: dict[str, tuple[float, list[ReefHostResponse]]] = {}


def _reef_repo(db, org_id: str, user: dict) -> ReefRepo:
    """The org's repository with its token unsealed, for a member only: no route
    reaches the token without the check. 409 when none is connected, or when a
    rotated secrets key left the token unreadable; reconnecting fixes both."""
    _verify_org_membership(db, org_id, user)
    stored = TableRead.get_org_reef(db, org_id)
    token = decrypt_secret(stored[1]) if stored else None
    if token is None:
        raise HTTPException(status_code=409, detail="No Reef repository connected")
    return ReefRepo(repo=stored[0], token=token)


async def _reef_hosts(org_id: str, repo: ReefRepo) -> list[ReefHostResponse]:
    """Every host that has pushed, by name. A host exists exactly when its status file does."""
    cached = _reef_status_cache.get(org_id)
    now = time.monotonic()
    if cached is not None and cached[0] > now:
        return cached[1]
    names = sorted(
        n.removesuffix(".json") for n in await repo.list("status", "status") if n.endswith(".json")
    )
    files = await asyncio.gather(*(repo.read("status", f"status/{n}.json") for n in names))
    at = datetime.now(UTC)
    hosts = [
        host
        for name, found in zip(names, files, strict=True)
        if found and (host := _reef_host(name, found[1], at))
    ]
    _reef_status_cache[org_id] = (now + _REEF_STATUS_TTL, hosts)
    return hosts


def _reef_host(name: str, raw: bytes, now: datetime) -> ReefHostResponse | None:
    """One host from its status file, or ``None`` when it wrote nonsense."""
    status = parse_status(raw, now)
    if status is None:
        return None
    try:
        host = ReefHostResponse.model_validate(status | {"host": name})
    except ValidationError:
        return None
    host.events.reverse()
    return host


async def _reef_roles(repo: ReefRepo) -> list[Role]:
    """The catalog from ``main:roles/``, by name, without roles pointing their
    agents at a different clawbits: those would boot and enrol somewhere else."""
    names = [n for n in await repo.list("main", "roles") if n.endswith(".toml")]
    files = await asyncio.gather(*(repo.read("main", f"roles/{n}") for n in names))
    endpoint = os.environ.get("CLAWBITS_BASE_URL", "http://localhost:8000")
    roles = [
        parse_role(name.removesuffix(".toml"), found[1], endpoint)
        for name, found in zip(names, files, strict=True)
        if found
    ]
    return sorted(filter(None, roles), key=lambda r: r.name)


def _reef_author(user: dict) -> Author:
    """Fleet commits carry the person who clicked, so `git log` on the fleet branch is the audit trail."""
    return Author(name=user.get("display_name") or user["email"], email=user["email"])


async def _undeclare(repo: ReefRepo, org_id: str, host: str, name: str, user: dict) -> None:
    """Take the agent's fleet file off the branch: the next reconcile prunes
    its VM. Its volumes survive, so the name can be declared again."""
    message = f"remove {name} from {host}"
    await repo.delete("fleet", f"fleet/{host}/{name}.toml", message, _reef_author(user))
    _reef_status_cache.pop(org_id, None)


def _set_org_reef(db, org_id: str, user: dict, repo: str | None, sealed: str | None) -> None:
    _require_org_owner(db, org_id, user)
    if not TableWrite.set_org_reef(db, org_id, repo, sealed):
        raise HTTPException(status_code=404, detail="Organization not found")
    db.commit()


@human_router.get("/api/human/orgs/{org_id}/reef", response_model=ReefResponse)
async def get_reef(
    org_id: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """The org's reef repository, what every host last pushed, and the agents
    declared but not yet enrolled: an unspent signup token is exactly that
    state. Any member."""

    def load(db: Session) -> tuple[tuple[str, str] | None, list[dict]]:
        _verify_org_membership(db, org_id, user)
        return (
            TableRead.get_org_reef(db, org_id),
            TableRead.list_declared_reef_agents(db, org_id, datetime.now(UTC)),
        )

    stored, rows = await _in_db(request, load)
    declared = [ReefAgentResponse(**row) for row in rows]
    token = decrypt_secret(stored[1]) if stored else None
    if token is None:
        return ReefResponse(repo=stored[0] if stored else None, connected=False, declared=declared)
    return ReefResponse(
        repo=stored[0],
        connected=True,
        hosts=await _reef_hosts(org_id, ReefRepo(repo=stored[0], token=token)),
        declared=declared,
    )


@human_router.put("/api/human/orgs/{org_id}/reef", response_model=ReefResponse)
async def set_reef(
    org_id: str,
    body: SetReefRepoRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Connect the org's reef repository. Owner only. The token is proven
    against GitHub before anything is stored, and sealed at rest."""
    await _in_db(request, lambda db: _require_org_owner(db, org_id, user))
    await ReefRepo(repo=body.repo, token=body.token).probe()
    try:
        sealed = encrypt_secret(body.token)
    except EphemeralSecretsKeyError:
        raise HTTPException(
            status_code=503,
            detail="This server has no durable secrets key configured, so a Reef "
            "token cannot be stored. Set CLAWBITS_ATTENTION_SECRETS_KEY.",
        )
    await _in_db(request, lambda db: _set_org_reef(db, org_id, user, body.repo, sealed))
    _reef_status_cache.pop(org_id, None)
    return ReefResponse(repo=body.repo, connected=True)


@human_router.delete("/api/human/orgs/{org_id}/reef", status_code=204)
def delete_reef(
    org_id: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Disconnect the repository. Owner only. Agents already declared keep
    running: their fleet files are still on the branch, untouched."""
    with _get_db(request) as db:
        _set_org_reef(db, org_id, user, None, None)
    _reef_status_cache.pop(org_id, None)


@human_router.get(
    "/api/human/orgs/{org_id}/reef/roles", response_model=list[ReefRoleResponse]
)
async def list_reef_roles(
    org_id: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """The role catalog, :func:`_reef_roles`. Any member."""
    repo = await _in_db(request, lambda db: _reef_repo(db, org_id, user))
    return [
        ReefRoleResponse(
            name=role.name,
            image=role.image,
            egress=role.egress,
            secrets=[ReefSecretResponse(env=s.env, host=s.host) for s in role.secrets],
            resources=role.resources,
        )
        for role in await _reef_roles(repo)
    ]


@human_router.post(
    "/api/human/orgs/{org_id}/reef/agents", response_model=CreateReefAgentResponse
)
async def create_reef_agent(
    org_id: str,
    body: CreateReefAgentRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Declare an agent on a reef host. Any member.

    The signup token is minted first and the fleet file carries it: it is the
    agent's whole identity until it enrols and keeps its own key. The agent's
    id and nickname are picked with it; without a name the file is named after
    that id, redrawn until nothing on the host has the name. Re-declaring the
    name of an agent that enrolled on the host brings it back, since its
    volumes kept its key. A failed write takes the session down with it, so a
    declared agent always has a file and a file always has a live token."""
    repo = await _in_db(request, lambda db: _reef_repo(db, org_id, user))
    owner = body.owner or user["email"].split("@")[0]
    if not OWNER_RE.match(owner):
        raise HTTPException(status_code=422, detail="owner is required for this account")
    host = next((h for h in await _reef_hosts(org_id, repo) if h.host == body.host), None)
    if host is None:
        raise HTTPException(status_code=422, detail=f"No Reef host named '{body.host}'")
    if body.role not in {r.name for r in await _reef_roles(repo)}:
        raise HTTPException(
            status_code=422, detail=f"No role named '{body.role}' points at this server"
        )
    declared = {n.removesuffix(".toml") for n in await repo.list("fleet", f"fleet/{body.host}")}
    if body.name in declared:
        raise HTTPException(
            status_code=409, detail=f"'{body.name}' is already declared on {body.host}"
        )
    taken = declared | {a.name for a in host.agents}

    def mint(db: Session) -> HumanSession:
        known = TableRead.get_org_reef_agents(db, org_id, body.host)
        minted = AgentSignup.mint_human_session(
            db,
            request.app,
            org_id,
            user["id"],
            reef=(body.host, body.name),
            taken=taken | known.keys(),
            returning=known.get(body.name) if body.name else None,
        )
        db.commit()
        return minted

    def revoke(db: Session) -> None:
        TableWrite.delete_challenge_session(db, minted.token)
        db.commit()

    minted = await _in_db(request, mint)
    name = body.name or fleet_name(minted.agent_id)
    env = {"CLAWBITS_ORG_ID": org_id, "CLAWBITS_SIGNUP_TOKEN": minted.token}
    if body.public_host:
        env["OPENCLAW_PUBLIC_HOST"] = body.public_host
    path, content = f"fleet/{body.host}/{name}.toml", fleet_toml(name, body.role, owner, env)
    try:
        await repo.write("fleet", path, content, f"declare {name} on {body.host}", _reef_author(user))
    except ReefRepoError:
        await _in_db(request, revoke)
        raise
    _reef_status_cache.pop(org_id, None)
    return CreateReefAgentResponse(
        host=body.host,
        name=name,
        expires_at=minted.expires_at,
        agent_id=minted.agent_id,
        nickname=minted.nickname,
    )


@human_router.delete(
    "/api/human/orgs/{org_id}/reef/agents/{host}/{name}", status_code=204
)
async def delete_reef_agent(
    org_id: str,
    request: Request,
    host: str = Path(pattern=NAME_RE.pattern),
    name: str = Path(pattern=NAME_RE.pattern),
    user: dict = Depends(get_current_human_user),
):
    """Remove the fleet file, then revoke the agent's signup token if it has
    not enrolled: the file leaves HEAD but its token stays in git history. The
    agent's operator, whoever declared it, or an org owner.

    The next reconcile prunes the VM; its volumes and its clawbits agent row
    survive, so re-declaring the same name brings the same agent back."""

    def authorize(db: Session) -> ReefRepo:
        repo = _reef_repo(db, org_id, user)
        if (
            user["id"] not in TableRead.get_org_reef_agent_operators(db, org_id, host, name)
            and TableRead.get_org_member_role(db, org_id, user["id"]) != "owner"
        ):
            raise HTTPException(
                status_code=403,
                detail="Only whoever declared or operates the agent, or an organization "
                "admin, can remove it",
            )
        return repo

    def revoke(db: Session) -> None:
        TableWrite.revoke_reef_signup(db, org_id, host, name)
        db.commit()

    await _undeclare(await _in_db(request, authorize), org_id, host, name, user)
    await _in_db(request, revoke)


@human_router.get("/api/human/orgs/{org_id}/attention", response_model=OrgAttentionResponse)
def get_org_attention(
    org_id: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Whether the org has armed the LobsterTalk attention gate. Any member can read."""
    with _get_db(request) as db:
        _verify_org_membership(db, org_id, user)
        return OrgAttentionResponse(enabled=TableRead.get_org_attention_enabled(db, org_id))


@human_router.put("/api/human/orgs/{org_id}/attention", response_model=OrgAttentionResponse)
def set_org_attention(
    org_id: str,
    body: SetOrgAttentionRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Arm or disarm the org's LobsterTalk attention gate. Owner only. The gate
    also needs the server's ``router`` extra and each agent's own toggle."""
    with _get_db(request) as db:
        _require_org_owner(db, org_id, user, "change LobsterTalk attention")
        if not TableWrite.set_org_attention_enabled(db, org_id, body.enabled):
            raise HTTPException(status_code=404, detail="Organization not found")
        db.commit()
    return OrgAttentionResponse(enabled=body.enabled)


def _lobstertalk_response(cfg: dict) -> OrgLobstertalkResponse:
    # A usable key, not merely a stored one: ciphertext from a rotated secrets key can't be decrypted.
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
def get_org_lobstertalk(
    org_id: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """The org's LobsterTalk attention config, the org toggle plus the LLM
    endpoint, with the key redacted to ``api_key_set``. Any member can read."""
    with _get_db(request) as db:
        _verify_org_membership(db, org_id, user)
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

    The LLM modes (cascade, llm_only) require ``base_url`` and ``model`` in the
    same request. The stored API key changes only when ``api_key`` is sent
    (encrypted at rest) or ``clear_api_key`` is set.

    A request that arms an LLM mode has its base URL checked here for immediate
    feedback, and again before every triage call. Requests that don't arm one
    skip the check, so a host that has since gone bad can't stop an org from
    turning LobsterTalk off."""
    await _in_db(request, lambda db: _require_org_owner(db, org_id, user, "change LobsterTalk settings"))
    _rate_limit(f"lt-save:{org_id}", limit=_LOBSTERTALK_SAVE_LIMIT)
    if body.enabled and body.mode in ("cascade", "llm_only") and body.base_url:
        # No session held: a caller-chosen nameserver could otherwise tie up the pool.
        try:
            await asyncio.wait_for(
                arun_guarded(check_endpoint_allowed, body.base_url),
                timeout=ENDPOINT_CHECK_TIMEOUT_SECONDS,
            )
        except PrivateAddressError as e:
            raise HTTPException(status_code=422, detail=str(e)) from e
        except (HostResolutionError, TimeoutError):
            pass

    update_api_key = body.api_key is not None or body.clear_api_key

    def save() -> OrgLobstertalkResponse:
        with _get_db(request) as db:
            # Re-checked in the write transaction: the caller may have been demoted during the DNS round trip.
            _require_org_owner(db, org_id, user, "change LobsterTalk settings")
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

    return await asyncio.to_thread(save)


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
    and report which stage failed, if any. Owner only, as it spends a metered
    call on the org's key. The stored config, not a draft, so the key never
    travels back through the API; the frontend fires this right after a save.

    Config the probe can't even attempt (embedding mode, missing endpoint
    fields) is a 422; problems the probe finds (bad key, wrong URL, unusable
    model) are a 200 with ``ok=false``."""

    def load(db: Session) -> dict | None:
        _require_org_owner(db, org_id, user, "test LobsterTalk settings")
        return TableRead.get_org_lobstertalk_config(db, org_id)

    cfg = await _in_db(request, load)
    _rate_limit(f"lt-health:{org_id}", limit=_LOBSTERTALK_HEALTH_LIMIT)
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
def set_org_lobstertalk_channel(
    org_id: str,
    channel_id: str,
    body: SetOrgLobstertalkChannelRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Approve or revoke one public channel on the org's LobsterTalk allowlist.
    Owner only. Closed by default: an unapproved channel never gets an attention
    pass, whatever the org and agent toggles say.

    Unknown channels and other orgs' channels are the same 404, so ids can't be
    probed across orgs; non-public channels are 422 either way, since the gate
    requires public first. Approval admits the transcript to the org's LLM
    endpoint, so it gets the same best-effort audit trail as the config."""
    with _get_db(request) as db:
        _require_org_owner(db, org_id, user, "change LobsterTalk settings")
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
    audit.lobstertalk_channel_updated(
        request,
        actor_user=user,
        workos_org_id=(org_row or {}).get("workos_org_id", ""),
        channel_id=channel_id,
        channel_name=channel.get("name") or channel_id,
        approved=body.approved,
    )
    return OrgLobstertalkChannelResponse(channel_id=channel_id, lobstertalk_approved=body.approved)


def _members_response(members: list[dict]) -> OrgMembersListResponse:
    return OrgMembersListResponse(members=[OrgMemberResponse(**m) for m in members], total=len(members))


def _require_another_owner(db, org_id: str, verb: str) -> None:
    """Every org keeps an owner, so nobody is left able to manage it."""
    if sum(m["role"] == "owner" for m in TableRead.get_org_members(db, org_id)) <= 1:
        raise HTTPException(status_code=400, detail=f"Cannot {verb} the last admin of an organization")


@human_router.get("/api/human/orgs/{org_id}/members", response_model=OrgMembersListResponse)
def list_org_members(
    org_id: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """List members of an organization. Any member can read: this powers the
    admin page (which gates itself off ``my_role``) and the people pickers.
    Adding, removing and role changes stay owner-only."""
    with _get_db(request) as db:
        _verify_org_membership(db, org_id, user)
        return _members_response(TableRead.get_org_members(db, org_id))


@human_router.post("/api/human/orgs/{org_id}/members", response_model=OrgMembersListResponse)
def add_org_member(
    org_id: str,
    body: AddOrgMemberRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Add a member to an organization. Caller must be an owner.

    Contact is closed by default, so the new member only joins the default
    channel of agents they may DM or tag."""
    with _get_db(request) as db:
        _require_org_owner(db, org_id, user, "add members")
        target = TableRead.get_human_user_by_email(db, body.email)
        if target is None:
            raise HTTPException(status_code=404, detail=f"User '{body.email}' not found")
        TableWrite.add_org_member(db, org_id, target["id"], body.role)
        for owned_agent_id in TableRead.get_agents_owned_by_org(db, org_id):
            if not (
                TableRead.can_dm_agent(db, owned_agent_id, human_id=target["id"])
                or TableRead.can_tag_agent(db, owned_agent_id, human_id=target["id"])
            ):
                continue
            channel = TableWrite.ensure_agent_default_mm_channel(db, owned_agent_id)
            if channel.get("channel_type") != "private":
                TableWrite.add_mm_channel_member_human(db, channel["channel_id"], target["id"])
        org = TableRead.get_organization(db, org_id, viewer_human_id=target["id"])
        members = TableRead.get_org_members(db, org_id)
        db.commit()

    if org is not None:
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
        fire_and_forget(publish_org_added(get_bus(), target["id"], OrgResponse(**org).model_dump()))
    return _members_response(members)


@human_router.patch(
    "/api/human/orgs/{org_id}/members/{member_id}", response_model=OrgMembersListResponse
)
def update_org_member_role(
    org_id: str,
    member_id: int,
    body: UpdateOrgMemberRoleRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Promote a member to owner, or demote an owner to member. Caller must be
    an owner, and the last owner can't be demoted. Setting the current role is a
    no-op with no WorkOS write or audit event. The target's ``org.updated``
    frame carries ``my_role`` from their own perspective."""
    with _get_db(request) as db:
        _require_org_owner(db, org_id, user, "change roles")
        old_role = TableRead.get_org_member_role(db, org_id, member_id)
        if old_role is None:
            raise HTTPException(status_code=404, detail="Member not found in this organization")
        if old_role == body.role:
            return _members_response(TableRead.get_org_members(db, org_id))
        if old_role == "owner":
            _require_another_owner(db, org_id, "demote")
        target = TableRead.get_human_user_by_id(db, member_id)
        TableWrite.update_org_member_role(db, org_id, member_id, body.role)
        org = TableRead.get_organization(db, org_id)
        target_org = TableRead.get_organization(db, org_id, viewer_human_id=member_id)
        members = TableRead.get_org_members(db, org_id)
        db.commit()

    if org is not None and target is not None:
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
        if target_org is not None:
            fire_and_forget(
                publish_org_updated(get_bus(), member_id, OrgResponse(**target_org).model_dump())
            )
    return _members_response(members)


@human_router.delete("/api/human/orgs/{org_id}/members/{member_id}", response_model=OrgMembersListResponse)
def remove_org_member(
    org_id: str,
    member_id: int,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Remove a member from an organization. Caller must be an owner. Cannot
    remove the last owner. Also drops their membership of the org's channels,
    which is what the per-channel gates check."""
    with _get_db(request) as db:
        _require_org_owner(db, org_id, user, "remove members")
        target_role = TableRead.get_org_member_role(db, org_id, member_id)
        if target_role is None:
            raise HTTPException(status_code=404, detail="Member not found in this organization")
        if target_role == "owner":
            _require_another_owner(db, org_id, "remove")
        target = TableRead.get_human_user_by_id(db, member_id)
        revoked_channel_ids = TableWrite.remove_org_member(db, org_id, member_id)
        org = TableRead.get_organization(db, org_id)
        members = TableRead.get_org_members(db, org_id)
        db.commit()

    bus = get_bus()
    for channel_id in revoked_channel_ids:
        fire_and_forget(publish_member_removed(bus, channel_id, human_id=member_id))
        fire_and_forget(publish_channel_removed(bus, member_id, channel_id))

    if org is not None and target is not None:
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
    return _members_response(members)


@human_router.get("/api/human/orgs/{org_id}/agents/{agent_id}/actions", response_model=AgentActionsResponse)
def get_agent_actions(
    org_id: str,
    agent_id: str,
    request: Request,
    limit: int = 100,
    offset: int = 0,
    user: dict = Depends(get_current_human_user),
):
    """Get all action documents for a specific agent. Caller must be an org member."""
    with _get_db(request) as db:
        _verify_agent_in_org(db, org_id, agent_id, user)
        items = TableRead.get_agent_actions(db, agent_id, limit=limit, offset=offset)
        return AgentActionsResponse(
            agent_id=agent_id,
            actions=[ActionListItem(**i) for i in items],
            total=TableRead.count_agent_actions_for_agent(db, agent_id),
        )


@human_router.get("/api/human/orgs/{org_id}/agents/{agent_id}/actions/{action_id}", response_model=ActionResponse)
def get_agent_action(
    org_id: str,
    agent_id: str,
    action_id: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Get a specific action document for an agent. Caller must be an org member."""
    with _get_db(request) as db:
        _verify_agent_in_org(db, org_id, agent_id, user)
        row = TableRead.get_agent_action(db, agent_id, action_id)
        if row is None:
            raise HTTPException(status_code=404, detail="No action document found for this agent with this ID")
        return ActionResponse(**row)


@human_router.get("/api/human/actions", response_model=ActionListResponse)
def list_agent_actions(
    request: Request,
    limit: int = 100,
    offset: int = 0,
    user: dict = Depends(get_current_human_user),
):
    """List action documents for agents in the caller's organizations (metadata only)."""
    with _get_db(request) as db:
        org_ids = TableRead.get_org_ids_for_human(db, user["id"])
        items = TableRead.list_agent_actions(db, org_ids, limit=limit, offset=offset)
        return ActionListResponse(
            actions=[ActionListItem(**i) for i in items],
            total=TableRead.count_agent_actions(db, org_ids),
        )


def _signup_request_in_org(db, org_id: str, request_id: str, user: dict) -> dict:
    _verify_org_membership(db, org_id, user)
    signup_req = TableRead.get_signup_request(db, request_id)
    if signup_req is None:
        raise HTTPException(status_code=404, detail="Signup request not found")
    if signup_req["org_id"] != org_id:
        raise HTTPException(status_code=404, detail="Signup request not found in this organization")
    return signup_req


@human_router.get("/api/human/orgs/{org_id}/signup-requests")
def list_signup_requests(
    org_id: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """List pending agent signup requests for an organization. Any org member can view."""
    with _get_db(request) as db:
        _verify_org_membership(db, org_id, user)
        return {"requests": TableRead.get_pending_signup_requests_for_org(db, org_id)}


# async on purpose: approval fires the DM avatar hook, which needs the running event loop.
@human_router.post("/api/human/orgs/{org_id}/signup-requests/{request_id}/approve")
async def approve_signup_request(
    org_id: str,
    request_id: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Approve a pending agent signup request. Any member of the organization can approve."""
    with _get_db(request) as db:
        _signup_request_in_org(db, org_id, request_id, user)
        result = AgentSignup.approve_signup_request(request.app, request_id, user["id"], db=db)
        db.commit()
        return result


@human_router.post("/api/human/orgs/{org_id}/signup-requests/{request_id}/reject")
def reject_signup_request(
    org_id: str,
    request_id: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Reject a pending agent signup request. Any member of the organization can reject."""
    with _get_db(request) as db:
        signup_req = _signup_request_in_org(db, org_id, request_id, user)
        if signup_req["status"] != "pending_approval":
            raise HTTPException(status_code=409, detail=f"Signup request already {signup_req['status']}")
        TableWrite.reject_signup_request(db, request_id, user["id"])
        db.commit()
        return TableRead.get_signup_request(db, request_id)


class HumanAgentSignupRequest(BaseModel):
    org_id: str = Field(description="Organization ID the human is a member of")


class HumanAgentSignupResponse(ChallengeQuestionResponse):
    agent_id: str = Field(description="The agent's id, picked now and taken at commit")
    nickname: str = Field(description="The agent's nickname, picked with its id")


@human_router.post(
    "/api/human/agent_signup",
    response_model=HumanAgentSignupResponse,
    tags=["Agents"],
    summary="Human-initiated agent signup",
)
def human_agents_signup(
    body: HumanAgentSignupRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Start agent creation for an org the authenticated human belongs to.

    Returns a challenge question with a session token prefixed with ``human-``,
    and the id and nickname the agent will commit under. The commit step uses
    the same ``POST /api/agentic/signup-commit`` endpoint.
    """
    with _get_db(request) as db:
        if not TableRead.is_org_member(db, body.org_id, user["id"]):
            raise HTTPException(status_code=403, detail="You are not a member of this organization")
        minted = AgentSignup.mint_human_session(db, request.app, body.org_id, user["id"])
        db.commit()
    return HumanAgentSignupResponse(
        session_token=minted.token,
        challenge_question=minted.challenge,
        agent_id=minted.agent_id,
        nickname=minted.nickname,
    )


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


class InstallSkillRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    skill_id: str


class UpdateInstallRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool


def _skill_or_404(db, org_id: str, skill_id: str):
    row = TableRead.get_skill_for_org(db, skill_id, org_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Skill not found")
    return row


def _checked_slug(slug: str) -> str:
    try:
        validate_slug(slug)
    except SkillValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return slug


def _prepare_skill_content(
    *, slug: str, manifest: dict, body_md: str, files: list[dict] | None
) -> tuple[dict, list[dict]]:
    """Validate, then normalize, authored content as a 400 on failure. Validation
    comes first so a missing field is named rather than silently dropped."""
    try:
        validate_manifest(manifest, slug=slug)
        normalized = normalize_manifest(manifest)
        normalized_files = normalize_files(files)
        validate_bundle(body_md, normalized_files)
    except SkillValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return normalized, normalized_files


def _managed_install(db, agent_id: str, install_id: str) -> AgentSkillInstall:
    row = db.get(AgentSkillInstall, install_id)
    if row is None or row.agent_id != agent_id:
        raise HTTPException(status_code=404, detail="Skill install not found")
    if row.managed_by != "clawbits":
        raise HTTPException(status_code=409, detail="Clawbits doesn't manage this skill")
    return row


@human_router.get("/api/human/orgs/{org_id}/skills")
def list_org_skills(
    org_id: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """The org's skill library. Membership-gated, not operator-gated: an owner
    who operates no agents still sees it. See docs/protocol/SKILLS_LIBRARY_PLAN.md."""
    with _get_db(request) as db:
        _verify_org_membership(db, org_id, user)
        return {"skills": TableRead.list_org_skills(db, org_id)}


@human_router.post("/api/human/orgs/{org_id}/skills")
def create_org_skill(
    org_id: str,
    body: CreateSkillRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Create a skill and publish its first version."""
    _rate_limit(f"skill-write:{org_id}", limit=_SKILL_WRITE_LIMIT)
    slug = _checked_slug(body.slug.strip().lower())
    manifest, files = _prepare_skill_content(
        slug=slug, manifest=body.manifest, body_md=body.body_md, files=body.files
    )
    with _get_db(request) as db:
        _verify_org_membership(db, org_id, user)
        if slug in TableRead.get_org_skill_slugs(db, org_id):
            raise HTTPException(status_code=409, detail=f"A skill named '{slug}' already exists")
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
def get_org_skill(
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
def update_org_skill(
    org_id: str,
    skill_id: str,
    body: UpdateSkillMetaRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Edit catalog metadata. Content edits go through publish."""
    with _get_db(request) as db:
        _verify_org_membership(db, org_id, user)
        TableWrite.update_skill_meta(
            db,
            skill=_skill_or_404(db, org_id, skill_id),
            display_name=body.display_name.strip() if body.display_name else None,
        )
        result = TableRead.get_skill_detail(db, skill_id, org_id)
        db.commit()
    return result


@human_router.post("/api/human/orgs/{org_id}/skills/{skill_id}/versions")
def publish_org_skill_version(
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
            slug=skill.slug, manifest=body.manifest, body_md=body.body_md, files=body.files
        )
        version = TableWrite.publish_skill_version(
            db,
            skill=skill,
            manifest=manifest,
            body_md=body.body_md,
            files=files,
            changelog=body.changelog.strip() if body.changelog else None,
            published_by=user["id"],
        )
        result = TableRead._skill_version_to_dict(version, include_content=True)
        db.commit()
    return result


@human_router.get("/api/human/orgs/{org_id}/skills/{skill_id}/versions")
def list_org_skill_versions(
    org_id: str,
    skill_id: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """The version timeline for one skill."""
    with _get_db(request) as db:
        _verify_org_membership(db, org_id, user)
        _skill_or_404(db, org_id, skill_id)
        return {"versions": TableRead.list_skill_versions(db, skill_id)}


@human_router.get(
    "/api/human/orgs/{org_id}/skills/{skill_id}/versions/{version_id}/render"
)
def render_org_skill_version(
    org_id: str,
    skill_id: str,
    version_id: str,
    request: Request,
    runtime: str = "openclaw",
    user: dict = Depends(get_current_human_user),
):
    """The exact ``SKILL.md`` bytes that would land on disk for ``runtime``."""
    if runtime not in SKILL_RUNTIMES:
        raise HTTPException(status_code=400, detail=f"Unknown runtime: {runtime}")
    with _get_db(request) as db:
        _verify_org_membership(db, org_id, user)
        skill = _skill_or_404(db, org_id, skill_id)
        version = TableRead.get_skill_version(db, version_id, skill_id)
        if version is None:
            raise HTTPException(status_code=404, detail="Version not found")
        return {
            "runtime": runtime,
            "path": f"{skill.slug}/SKILL.md",
            "content": render_skill(version.manifest, version.body_md, runtime=runtime),
            "content_hash": version.content_hash,
        }


@human_router.post("/api/human/orgs/{org_id}/skills/{skill_id}/fork")
def fork_org_skill(
    org_id: str,
    skill_id: str,
    body: ForkSkillRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Fork a skill into this org, recording lineage. ``org_id`` is the forking
    org. Without a slug, a free ``<slug>-fork[-N]`` is derived."""
    _rate_limit(f"skill-write:{org_id}", limit=_SKILL_WRITE_LIMIT)
    with _get_db(request) as db:
        _verify_org_membership(db, org_id, user)
        source = _skill_or_404(db, org_id, skill_id)
        if source.latest_version_id is None:
            raise HTTPException(
                status_code=409, detail="Cannot fork a skill with no published version"
            )
        source_version = TableRead.get_skill_version(db, source.latest_version_id, source.skill_id)
        if source_version is None:
            raise HTTPException(status_code=404, detail="Source version not found")

        taken = TableRead.get_org_skill_slugs(db, org_id)
        slug = (body.slug or "").strip().lower()
        if not slug:
            slug = f"{source.slug}-fork"
            suffix = 2
            while slug in taken:
                slug = f"{source.slug}-fork-{suffix}"
                suffix += 1
        if _checked_slug(slug) in taken:
            raise HTTPException(status_code=409, detail=f"A skill named '{slug}' already exists")

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
def delete_org_skill(
    org_id: str,
    skill_id: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Soft-delete a skill from the library."""
    with _get_db(request) as db:
        _verify_org_membership(db, org_id, user)
        TableWrite.delete_skill(db, skill=_skill_or_404(db, org_id, skill_id))
        db.commit()
    return {"skill_id": skill_id, "deleted": True}


@human_router.get("/api/human/orgs/{org_id}/agents/{agent_id}/skills")
def list_agent_skills(
    org_id: str,
    agent_id: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Skills actually present on the agent, as it last reported them."""
    with _get_db(request) as db:
        _require_operator_or_admin(db, org_id, agent_id, user, "view its skills")
        return TableRead.list_agent_skills(db, agent_id)


@human_router.post("/api/human/orgs/{org_id}/agents/{agent_id}/skills")
def install_agent_skill(
    org_id: str,
    agent_id: str,
    body: InstallSkillRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Install an org skill onto an agent. Cross-org attach is refused (fork
    first): that closes both reading another org's private skill by id and an
    upstream edit reaching an agent that never opted in."""
    with _get_db(request) as db:
        _require_operator_or_admin(db, org_id, agent_id, user, "manage its skills")
        runtime = resolve_runtime(db.get(Agent, agent_id).agent_type)
        if not runtime.can_receive:
            raise HTTPException(
                status_code=422,
                detail=f"Skills require an OpenClaw runtime; this agent runs {runtime.name}",
            )
        skill = _skill_or_404(db, org_id, body.skill_id)
        if skill.latest_version_id is None:
            raise HTTPException(status_code=409, detail="This skill has no published version yet")
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
def update_agent_skill_install(
    org_id: str,
    agent_id: str,
    install_id: str,
    body: UpdateInstallRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    """Enable or disable an installed skill."""
    with _get_db(request) as db:
        _require_operator_or_admin(db, org_id, agent_id, user, "manage its skills")
        row = _managed_install(db, agent_id, install_id)
        TableWrite.set_skill_install_enabled(db, row=row, enabled=body.enabled)
        result = TableRead.list_agent_skills(db, agent_id)
        db.commit()
    return result


@human_router.delete("/api/human/orgs/{org_id}/agents/{agent_id}/skills/{install_id}")
def uninstall_agent_skill(
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
        _require_operator_or_admin(db, org_id, agent_id, user, "manage its skills")
        row = _managed_install(db, agent_id, install_id)
        if force:
            TableWrite.forget_skill_install(db, row=row)
        else:
            TableWrite.uninstall_skill(db, row=row)
        result = TableRead.list_agent_skills(db, agent_id)
        db.commit()
    return result
