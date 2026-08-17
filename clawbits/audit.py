"""Typed audit-log helpers.

Each event the app emits is a small named function. Call sites stay short
and uniform; the WorkOS event vocabulary lives only here.

All emit calls are best-effort — failures are swallowed by the underlying
``client.audit_logs.create_event`` wrapper, so a flaky audit pipeline never
breaks a user-facing request.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Any

from fastapi import Request
from workos.audit_logs.models.audit_log_event import AuditLogEvent
from workos.audit_logs.models.audit_log_event_actor import AuditLogEventActor
from workos.audit_logs.models.audit_log_event_context import AuditLogEventContext
from workos.audit_logs.models.audit_log_event_target import AuditLogEventTarget

from clawbits.ssrf import redact_url

# ---------------------------------------------------------------------------
# Action vocabulary — keep this list authoritative.
# ---------------------------------------------------------------------------

USER_SIGNED_UP = "user.signed_up"
USER_SIGNED_IN = "user.signed_in"
USER_SIGNED_OUT = "user.signed_out"

ORGANIZATION_CREATED = "organization.created"
ORGANIZATION_MEMBER_ADDED = "organization.member_added"
ORGANIZATION_MEMBER_REMOVED = "organization.member_removed"
ORGANIZATION_MEMBER_ROLE_UPDATED = "organization.member_role_updated"
ORGANIZATION_LOBSTERTALK_UPDATED = "organization.lobstertalk_updated"
ORGANIZATION_LOBSTERTALK_CHANNEL_UPDATED = "organization.lobstertalk_channel_updated"

AGENT_CREATED = "agent.created"
AGENT_DELETED = "agent.deleted"
AGENT_SIGNUP_APPROVED = "agent.signup_request.approved"
AGENT_SIGNUP_REJECTED = "agent.signup_request.rejected"
AGENT_API_KEY_ROTATED = "agent.api_key_rotated"


# ---------------------------------------------------------------------------
# Per-event helpers — call from endpoint code.
# ---------------------------------------------------------------------------


def user_signed_up(request: Request, *, user: dict, workos_org_id: str) -> None:
    _emit(
        request,
        action=USER_SIGNED_UP,
        organization_id=workos_org_id,
        actor=_user_actor(user),
        target=_user_target(user),
    )


def user_signed_in(
    request: Request, *, user: dict, workos_org_id: str, method: str
) -> None:
    _emit(
        request,
        action=USER_SIGNED_IN,
        organization_id=workos_org_id,
        actor=_user_actor(user),
        target=_user_target(user),
        metadata={"method": method},
    )


def user_signed_out(request: Request, *, user: dict, workos_org_id: str) -> None:
    _emit(
        request,
        action=USER_SIGNED_OUT,
        organization_id=workos_org_id,
        actor=_user_actor(user),
        target=_user_target(user),
    )


def organization_created(
    request: Request,
    *,
    actor_user: dict,
    workos_org_id: str,
    org_name: str,
    is_personal: bool,
) -> None:
    _emit(
        request,
        action=ORGANIZATION_CREATED,
        organization_id=workos_org_id,
        actor=_user_actor(actor_user),
        target=AuditLogEventTarget(
            id=workos_org_id, name=org_name, type="organization"
        ),
        metadata={"is_personal": "true" if is_personal else "false"},
    )


def organization_member_added(
    request: Request,
    *,
    actor_user: dict,
    target_user: dict,
    workos_org_id: str,
    role: str,
) -> None:
    _emit(
        request,
        action=ORGANIZATION_MEMBER_ADDED,
        organization_id=workos_org_id,
        actor=_user_actor(actor_user),
        target=_user_target(target_user),
        metadata={"role": role},
    )


def organization_member_role_updated(
    request: Request,
    *,
    actor_user: dict,
    target_user: dict,
    workos_org_id: str,
    old_role: str,
    new_role: str,
) -> None:
    """A member was promoted to owner or demoted to member. Privilege changes
    are the kind of thing an auditor asks about, so this carries both the
    before and after slug rather than just the result."""
    _emit(
        request,
        action=ORGANIZATION_MEMBER_ROLE_UPDATED,
        organization_id=workos_org_id,
        actor=_user_actor(actor_user),
        target=_user_target(target_user),
        metadata={"old_role": old_role, "new_role": new_role},
    )


def organization_member_removed(
    request: Request,
    *,
    actor_user: dict,
    target_user: dict,
    workos_org_id: str,
) -> None:
    _emit(
        request,
        action=ORGANIZATION_MEMBER_REMOVED,
        organization_id=workos_org_id,
        actor=_user_actor(actor_user),
        target=_user_target(target_user),
    )


def lobstertalk_config_updated(
    request: Request,
    *,
    actor_user: dict,
    workos_org_id: str,
    enabled: bool,
    mode: str,
    base_url: str | None,
    api_key_changed: bool,
    cooldown_seconds: int | None,
) -> None:
    """The org's LobsterTalk attention config was written. This is the setting
    that governs whether channel transcripts — private channels included — are
    shipped to an org-controlled LLM endpoint, so who changed it, to what, and
    when belongs in the audit log. The endpoint is recorded host/path only
    (:func:`redact_url` drops any userinfo/query/fragment); the API key value is
    never recorded, only whether this request changed it."""
    _emit(
        request,
        action=ORGANIZATION_LOBSTERTALK_UPDATED,
        organization_id=workos_org_id,
        actor=_user_actor(actor_user),
        target=AuditLogEventTarget(
            id=workos_org_id, name="lobstertalk", type="organization_setting"
        ),
        metadata={
            "enabled": "true" if enabled else "false",
            "mode": mode,
            "endpoint": redact_url(base_url) if base_url else "",
            "api_key_changed": "true" if api_key_changed else "false",
            "cooldown_seconds": "" if cooldown_seconds is None else str(cooldown_seconds),
        },
    )


def lobstertalk_channel_updated(
    request: Request,
    *,
    actor_user: dict,
    workos_org_id: str,
    channel_id: str,
    channel_name: str,
    approved: bool,
) -> None:
    """One channel was added to / removed from the org's LobsterTalk
    allowlist. Approval is what admits that channel's transcript to the
    org-configured LLM endpoint (cascade/llm_only), so it gets the same audit
    treatment as the config itself."""
    _emit(
        request,
        action=ORGANIZATION_LOBSTERTALK_CHANNEL_UPDATED,
        organization_id=workos_org_id,
        actor=_user_actor(actor_user),
        target=AuditLogEventTarget(id=channel_id, name=channel_name, type="mm_channel"),
        metadata={"approved": "true" if approved else "false"},
    )


def agent_signup_approved(
    request: Request, *, workos_org_id: str, agent_id: str, reason: str
) -> None:
    _emit(
        request,
        action=AGENT_SIGNUP_APPROVED,
        organization_id=workos_org_id,
        actor=AuditLogEventActor(id="system", name="claim_resolver", type="system"),
        target=AuditLogEventTarget(id=agent_id, name=agent_id, type="agent"),
        metadata={"reason": reason},
    )


# ---------------------------------------------------------------------------
# Private machinery
# ---------------------------------------------------------------------------


def _emit(
    request: Request,
    *,
    action: str,
    organization_id: str,
    actor: AuditLogEventActor,
    target: AuditLogEventTarget,
    metadata: dict[str, Any] | None = None,
) -> None:
    if not organization_id:
        return  # without an org we can't scope; drop silently.
    event = AuditLogEvent(
        action=action,
        occurred_at=datetime.now(UTC),
        actor=actor,
        targets=[target],
        context=AuditLogEventContext(
            location=_client_ip(request) or "unknown",
            user_agent=request.headers.get("user-agent"),
        ),
        metadata=metadata or None,
    )
    try:
        request.app.state.workos.audit_logs.create_event(
            organization_id=organization_id, event=event
        )
    except Exception as e:  # never break the request flow on audit failure
        # ``invalid_audit_log`` means the event type isn't configured in
        # the WorkOS dashboard for this environment. That's a one-time
        # operator setup task, not a per-request failure — log once at
        # DEBUG so we don't spam the request log on every login. All
        # other audit failures (network, 5xx, etc.) still warn.
        msg = str(e)
        if "invalid_audit_log" in msg or "has not been configured" in msg:
            logging.debug(
                "Audit event %r not configured in WorkOS env — skipping. "
                "Configure under Audit Logs → Schema in the dashboard if "
                "you want this event captured.",
                action,
            )
            return
        logging.warning(f"Audit log failed for action={action}: {e}")


def _user_actor(user: dict) -> AuditLogEventActor:
    return AuditLogEventActor(
        id=user["workos_user_id"], name=user["email"], type="user"
    )


def _user_target(user: dict) -> AuditLogEventTarget:
    return AuditLogEventTarget(
        id=user["workos_user_id"], name=user["email"], type="user"
    )


def _client_ip(request: Request) -> str | None:
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else None
