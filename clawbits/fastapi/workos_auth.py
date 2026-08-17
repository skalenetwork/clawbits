"""WorkOS-backed human authentication.

All human auth flows live here: passwordless email (Magic Auth) and social
OAuth via Google / GitHub. The session is an ``httpOnly`` cookie containing
a Fernet-sealed payload — the browser never touches the WorkOS access token.

There is no abstraction layer over the WorkOS SDK in production code. We
talk to ``client.user_management``, ``client.organizations``, and
``client.audit_logs`` directly; tests install a :class:`FakeWorkOSClient`
of identical shape at ``app.state.workos`` (see ``tests/fastapi/_fakes.py``).
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import secrets
import threading
import time
import urllib.parse
from typing import Any, Literal

from cryptography.fernet import Fernet
from fastapi import APIRouter, Cookie, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from pydantic import BaseModel, EmailStr, Field
from sqlmodel import Session
from workos import WorkOSClient
from workos._errors import (
    AuthenticationError,
    EmailVerificationRequiredError,
    OrganizationSelectionRequiredError,
    WorkOSError,
)
from workos.session import seal_session_from_auth_response
from workos.user_management import RoleSingle

from clawbits import audit
from clawbits.avatars.payloads import avatar_ref_for_user
from clawbits.datastructures.avatar_models import AvatarRef
from clawbits.datastructures.org_models import OrgResponse
from clawbits.db.table_read import TableRead
from clawbits.db.table_write import TableWrite
from clawbits.fastapi.session_cookie import (
    DEV_SESSION_COOKIE,
    OAUTH_PENDING_COOKIE,
    OAUTH_PENDING_COOKIE_MAX_AGE,
    OAUTH_STATE_COOKIE,
    SESSION_COOKIE,
    auth_log,
    cookie_kwargs,
    session_fingerprint,
    stage_session_clear,
    stage_session_set,
)
from clawbits.realtime import (
    fire_and_forget,
    get_bus,
    publish_org_added,
)


def cookie_password() -> str:
    """Fernet key used to seal session cookies. Required when
    ``WORKOS_API_KEY`` is set; tests get an ephemeral key.
    """
    return _cookie_password


def make_workos_client() -> Any:
    """Construct the production WorkOS client, or ``None`` for tests
    (which install a fake at ``app.state.workos``). Refuses to boot on
    placeholder / malformed config so misconfigurations fail loud at
    startup rather than as opaque WorkOS errors at first OAuth click.
    """
    api_key = os.environ.get("WORKOS_API_KEY")
    client_id = os.environ.get("WORKOS_CLIENT_ID")
    if not api_key:
        return None
    if not client_id:
        raise RuntimeError("WORKOS_API_KEY is set but WORKOS_CLIENT_ID is missing.")
    if not client_id.startswith("client_"):
        raise RuntimeError(
            f"WORKOS_CLIENT_ID={client_id!r} is not a real client ID "
            "(real values start with 'client_'). Check for an unreplaced placeholder.",
        )
    if os.environ.get("WORKOS_COOKIE_PASSWORD") is None:
        raise RuntimeError(
            "WORKOS_API_KEY is set but WORKOS_COOKIE_PASSWORD is missing — "
            "generate one with: python -c "
            "'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())'",
        )
    return WorkOSClient(api_key=api_key, client_id=client_id)


_env_cookie_password = os.environ.get("WORKOS_COOKIE_PASSWORD") or Fernet.generate_key().decode()
_cookie_password: str = _env_cookie_password


def _client(request: Request) -> Any:
    return request.app.state.workos


def _db(request: Request) -> Session:
    return Session(request.app._engine)


def _existing_workos_personal_org_id(client: Any, *, workos_user_id: str) -> str | None:
    """Adopt the user's most-recent existing WorkOS org instead of minting a
    duplicate. Prevents ``OrganizationSelectionRequiredError`` after a local
    DB wipe."""
    try:
        page = client.user_management.list_organization_memberships(
            user_id=workos_user_id, order="desc", limit=10,
        )
    except Exception as e:
        logging.warning(f"WorkOS list_organization_memberships failed: {e}")
        return None
    members = list(getattr(page, "data", []) or [])
    return members[0].organization_id if members else None


async def _provision_new_user(
    request: Request,
    *,
    workos_user_id: str,
    email: str,
    first_name: str | None,
    last_name: str | None,
) -> dict:
    """Create the local human-user row + personal org on first login.
    Adopts an existing WorkOS org if one is present (e.g. local DB was wiped)
    instead of minting a duplicate."""
    client = _client(request)
    local_part = email.split("@")[0].lower() or "user"
    display_name = _display_name(first_name, last_name) or local_part

    adopted = _existing_workos_personal_org_id(client, workos_user_id=workos_user_id)
    workos_org_id = adopted or create_workos_organization(client, name=local_part)

    with _db(request) as db:
        new_id = TableWrite.create_human_user(
            db, email=email, workos_user_id=workos_user_id, display_name=display_name,
        )
        TableWrite.create_personal_org(
            db, human_id=new_id, email=email, workos_org_id=workos_org_id,
        )
        db.commit()
        user = TableRead.get_human_user_by_id(db, new_id)

    # Await the glass-style avatar upload after commit so the URL the
    # next /api/human/me read returns points at bytes that exist by
    # the time the browser fetches them. fire-and-forget would silently
    # skip here because the surrounding route runs in an anyio worker
    # thread without a running event loop.
    from clawbits.fastapi.avatar_hooks import await_user_avatar
    await await_user_avatar(user_id=new_id)

    if adopted is None:
        register_membership(
            client, workos_user_id=workos_user_id, workos_org_id=workos_org_id, role="owner",
        )
        audit.organization_created(
            request, actor_user=user, workos_org_id=workos_org_id,
            org_name=local_part, is_personal=True,
        )

    audit.user_signed_up(request, user=user, workos_org_id=workos_org_id)
    return user


def _resolve_agent_claims(request: Request, *, user: dict, workos_org_id: str) -> None:
    """Link any pending :class:`AgentClaim` rows for ``user``'s email to their
    personal org. Idempotent."""
    with _db(request) as db:
        org_id = TableRead.get_personal_org_id(db, user["id"])
        if org_id is None:
            return
        agent_ids = TableWrite.delete_agent_claims_for_email(db, user["email"])
        for agent_id in agent_ids:
            TableWrite.set_agent_org_and_operator(
                db, agent_id=agent_id, org_id=org_id, operator_id=user["id"]
            )
            TableWrite.approve_pending_signup_requests_for_agent(
                db, agent_id=agent_id, reviewer_human_id=user["id"]
            )
        db.commit()

    for agent_id in agent_ids:
        audit.agent_signup_approved(
            request,
            workos_org_id=workos_org_id,
            agent_id=agent_id,
            reason="email_claim",
        )


async def _ensure_user(
    request: Request,
    *,
    workos_user_id: str,
    email: str,
    first_name: str | None,
    last_name: str | None,
) -> dict:
    """Resolve the local user by ``workos_user_id``, falling back to email
    (with late-bind of the new id) before provisioning fresh.

    Always finishes by reconciling the user's WorkOS org memberships into
    our local ``org_members`` table — see :func:`_reconcile_workos_memberships`
    for the contract. Dashboard-side membership adds show up at the user's
    next login without a webhook.
    """
    with _db(request) as db:
        existing = TableRead.get_human_user_by_workos_id(db, workos_user_id)
        if existing is None:
            by_email = TableRead.get_human_user_by_email(db, email)
            if by_email is not None:
                TableWrite.rebind_human_workos_id(db, by_email["id"], workos_user_id)
                db.commit()
                existing = TableRead.get_human_user_by_id(db, by_email["id"])
    if existing is not None:
        user = _backfill_display_name(request, existing, first_name, last_name)
    else:
        user = await _provision_new_user(
            request, workos_user_id=workos_user_id, email=email,
            first_name=first_name, last_name=last_name,
        )
    workos_org_id = _personal_org_workos_id(request, user["id"])
    _resolve_agent_claims(request, user=user, workos_org_id=workos_org_id)
    _reconcile_workos_memberships(
        request, workos_user_id=workos_user_id, local_user_id=int(user["id"]),
    )
    return user


def _reconcile_workos_memberships(
    request: Request, *, workos_user_id: str, local_user_id: int,
) -> None:
    """Mirror the user's WorkOS org memberships into local ``org_members``.

    Additive only: inserts missing rows and updates roles. Does **not**
    delete memberships present locally but absent from WorkOS — a transient
    WorkOS error would otherwise nuke valid local state. Deletions belong
    to a future webhook handler that can act on explicit ``.deleted`` events.

    WorkOS memberships pointing at orgs without a local counterpart are
    skipped. Those would be orgs created entirely outside the app (directly
    in the WorkOS dashboard with no in-app twin) and we have no policy yet
    for what to call them, who owns them, or which channels they imply.

    All failures are swallowed — flaky WorkOS connectivity must never break
    login. Each branch logs a structured ``auth.reconcile.*`` line so the
    sync state is greppable.
    """
    client = _client(request)
    try:
        page = client.user_management.list_organization_memberships(
            user_id=workos_user_id, limit=100,
        )
    except Exception as exc:  # noqa: BLE001 — we never want this to break login
        auth_log.warning(
            "auth.reconcile.list_failed user_id=%s reason=%s",
            local_user_id, type(exc).__name__,
        )
        return

    wo_memberships = list(getattr(page, "data", []) or [])
    if not wo_memberships:
        return

    added_payloads: list[dict[str, Any]] = []
    try:
        with _db(request) as db:
            local_orgs = TableRead.get_orgs_for_human(db, local_user_id)
            local_role_by_workos_org: dict[str, str] = {
                o["workos_org_id"]: o["my_role"]
                for o in local_orgs
                if o.get("workos_org_id")
            }
            changes = 0
            for m in wo_memberships:
                workos_org_id = getattr(m, "organization_id", None)
                if not workos_org_id:
                    continue
                new_role = _WORKOS_TO_LOCAL_ROLE.get(
                    getattr(m, "role", None) or "", "member",
                )
                local_org = TableRead.get_organization_by_workos_id(db, workos_org_id)
                if local_org is None:
                    auth_log.info(
                        "auth.reconcile.skip_unknown_org user_id=%s workos_org_id=%s",
                        local_user_id, workos_org_id,
                    )
                    continue
                existing_role = local_role_by_workos_org.get(workos_org_id)
                if existing_role is None:
                    TableWrite.add_org_member(
                        db, local_org["org_id"], local_user_id, new_role,
                    )
                    auth_log.info(
                        "auth.reconcile.add user_id=%s org_id=%s role=%s",
                        local_user_id, local_org["org_id"], new_role,
                    )
                    # Capture the payload for the post-commit SSE fan-out.
                    # ``last_visited_at`` / unread counters fall to model
                    # defaults — correct for a just-added membership.
                    added_payloads.append(
                        OrgResponse(**{**local_org, "my_role": new_role}).model_dump()
                    )
                    changes += 1
                elif existing_role != new_role:
                    TableWrite.update_org_member_role(
                        db, local_org["org_id"], local_user_id, new_role,
                    )
                    auth_log.info(
                        "auth.reconcile.role_update user_id=%s org_id=%s old=%s new=%s",
                        local_user_id, local_org["org_id"], existing_role, new_role,
                    )
                    changes += 1
            if changes:
                db.commit()
    except Exception as exc:  # noqa: BLE001 — same rationale as above
        auth_log.warning(
            "auth.reconcile.write_failed user_id=%s reason=%s",
            local_user_id, type(exc).__name__,
        )
        return

    # Tell any active tabs about the newly synced orgs so the switcher
    # shows them without a manual refresh. Fired after the DB context
    # exits so subscribers don't race ahead of the committed write.
    if added_payloads:
        bus = get_bus()
        for payload in added_payloads:
            fire_and_forget(publish_org_added(bus, local_user_id, payload))


def _backfill_display_name(
    request: Request,
    user: dict,
    first_name: str | None,
    last_name: str | None,
) -> dict:
    """Update display_name if it's still the email local-part and WorkOS now
    has a real first/last name."""
    fresh = _display_name(first_name, last_name)
    if not fresh:
        return user
    current = user.get("display_name") or ""
    local_part = (user.get("email") or "").split("@")[0].lower()
    if current and current != local_part:
        return user
    with _db(request) as db:
        TableWrite.update_human_display_name(db, user["id"], fresh)
        db.commit()
        return TableRead.get_human_user_by_id(db, user["id"]) or user


def get_current_human_user(
    request: Request,
    # ``alias=`` reads the env-suffixed cookie name; without it FastAPI
    # would look for the literal parameter name.
    session_cookie: str | None = Cookie(default=None, alias=SESSION_COOKIE),
    dev_session_cookie: str | None = Cookie(default=None, alias=DEV_SESSION_COOKIE),
) -> dict:
    """FastAPI dependency: resolve the current human user, refreshing the
    session cookie if its access token has expired. 401s on any failure.

    The cookie itself is never cleared on failure — that would log the user
    out on transient races during parallel-request refresh storms.
    """
    from clawbits.fastapi.dev_auth import resolve_dev_session_user
    from clawbits.fastapi.human_token_endpoints import PAT_PREFIX, resolve_pat_user

    dev_user = resolve_dev_session_user(request, dev_session_cookie)
    if dev_user is not None:
        return dev_user

    sealed = _resolve_sealed(request, session_cookie)
    if not sealed:
        raise HTTPException(status_code=401, detail="Not authenticated")

    # Personal access tokens (``cbp_…``) — header-only credentials, checked
    # before WorkOS. Unlike the dev resolver's silent fall-through, a bearer
    # carrying the PAT prefix is *committed* to this path: it can't be a
    # sealed session, so on a miss we 401 here rather than hand a known-bad
    # string to WorkOS validation.
    if sealed.startswith(PAT_PREFIX):
        pat_user = resolve_pat_user(request, sealed)
        if pat_user is not None:
            return pat_user
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    claims = _authenticate_or_refresh(request, sealed)
    if claims is None:
        raise HTTPException(status_code=401, detail="Session expired")

    workos_user_id = claims.get("workos_user_id") or ""
    with _db(request) as db:
        user = TableRead.get_human_user_by_workos_id(db, workos_user_id)
    if user is None:
        auth_log.warning(
            "auth.local_user_missing session=%s workos_user_id=%s",
            session_fingerprint(sealed), workos_user_id,
        )
        raise HTTPException(status_code=401, detail="User not found")
    return user


def _resolve_sealed(request: Request, cookie_value: str | None) -> str | None:
    """Pick the sealed session from ``Authorization: Bearer`` (tests) or
    cookie (browsers). Bearer wins so tests can override per-request."""
    auth = request.headers.get("authorization")
    if auth and auth.lower().startswith("bearer "):
        bearer = auth.split(" ", 1)[1].strip()
        if bearer:
            return bearer
    return cookie_value or None


def _authenticate_or_refresh(request: Request, sealed: str) -> dict | None:
    """Validate ``sealed``; rotate on expiry. ``None`` if unrecoverable."""
    claims, fresh = _validate(sealed, _client(request))
    if claims is not None:
        return claims
    return _refresh(request, sealed, fresh_reason=fresh)


def _validate(sealed: str, client: Any) -> tuple[dict | None, str]:
    """Validate the AT in ``sealed`` without rotating.

    Returns ``(claims, "")`` on success or ``(None, reason)`` on failure
    so the refresh path can log why validation failed.
    """
    session = client.user_management.load_sealed_session(
        session_data=sealed, cookie_password=_cookie_password,
    )
    result = session.authenticate()
    if not getattr(result, "authenticated", False):
        return None, getattr(result, "reason", "auth_failed")
    user = result.user or {}
    return {"workos_user_id": user.get("id"), "email": user.get("email")}, ""


def _refresh(request: Request, sealed: str, *, fresh_reason: str) -> dict | None:
    """Rotate the refresh token, stage the new cookie, return claims.

    Cookie is *staged* on ``request.state`` (not written directly) so it
    lands on whichever response Starlette emits — see :mod:`session_cookie`.

    Failures of the WorkOS call itself are logged inside
    :func:`_do_workos_refresh` with a precise ``reason=`` field; this
    function only logs the start and the happy path.
    """
    fp = session_fingerprint(sealed)
    auth_log.info("auth.refresh.start session=%s reason=%s", fp, fresh_reason)
    new_sealed = _refresh_single_flight(_client(request), sealed)
    if new_sealed is None:
        return None  # failure already logged inside _do_workos_refresh
    claims, fail_reason = _validate(new_sealed, _client(request))
    if claims is None:
        auth_log.warning(
            "auth.refresh.post_validate_fail session=%s rotated_to=%s reason=%s",
            fp, session_fingerprint(new_sealed), fail_reason,
        )
        return None
    auth_log.info(
        "auth.refresh.ok session=%s rotated_to=%s",
        fp, session_fingerprint(new_sealed),
    )
    stage_session_set(request, new_sealed)
    return claims


# Single-flight refresh: WorkOS rotates the RT on every ``session.refresh()``
# and rejects re-uses, so we serialise concurrent refreshers via a Redis
# SETNX lock + short-TTL result cache. Falls back to a per-process lock
# when Redis is unreachable (fine for tests; not safe with ``--workers > 1``).

_REFRESH_RESULT_TTL_SEC = 60       # how long siblings can reuse a result
_REFRESH_LOCK_TTL_SEC = 10         # > worst-case WorkOS refresh latency
_REFRESH_WAIT_TIMEOUT_SEC = 5      # sibling max wait; must be < lock TTL
_REFRESH_POLL_INTERVAL_SEC = 0.05
_REFRESH_FAIL_SENTINEL = "__FAIL__"

_LOCAL_REFRESH_LOCK = threading.Lock()
_LOCAL_REFRESH_CACHE: dict[str, tuple[float, str]] = {}

_redis_client: Any | None = None
_redis_init_lock = threading.Lock()
_redis_disabled = False


def _redis() -> Any | None:
    """Return a sync Redis client, or ``None`` if unavailable. Latched —
    once a process fails to reach Redis it stops trying for its lifetime."""
    global _redis_client, _redis_disabled
    if _redis_disabled:
        return None
    if _redis_client is not None:
        return _redis_client
    url = os.environ.get("CLAWBITS_REDIS_URL")
    if not url:
        _redis_disabled = True
        return None
    with _redis_init_lock:
        if _redis_client is not None:
            return _redis_client
        if _redis_disabled:
            return None
        try:
            import redis as _redis_pkg

            client = _redis_pkg.Redis.from_url(
                url,
                socket_timeout=2,
                socket_connect_timeout=2,
                decode_responses=True,
            )
            client.ping()
            _redis_client = client
            return _redis_client
        except Exception as exc:
            logging.info(
                "Refresh single-flight: Redis unavailable (%s) — using "
                "per-process fallback for the lifetime of this worker.",
                exc,
            )
            _redis_disabled = True
            return None


def auth_preflight() -> None:
    """Run every auth-related boot check. Called once from the lifespan.

    Refuses to boot on a misconfigured dev-auth gate (raises). Logs a
    banner so operators can grep ``auth.`` to confirm wiring, and warns
    loudly if cross-worker single-flight isn't backed by reachable Redis.
    """
    from clawbits.fastapi.dev_auth import assert_safe_at_startup

    assert_safe_at_startup()
    auth_log.info("auth.logger.ready — grep 'auth\\.' to follow session lifecycle")
    _assert_refresh_singleflight_ready()


def _assert_refresh_singleflight_ready() -> None:
    """Probe Redis and emit a structured ready/degraded banner."""
    workers_env = os.environ.get("CLAWBITS_WEB_CONCURRENCY")
    workers = int(workers_env) if (workers_env or "").isdigit() else 1
    url = os.environ.get("CLAWBITS_REDIS_URL")

    if _redis() is not None:
        auth_log.info(
            "auth.singleflight.ready backend=redis url=%s workers=%s",
            _redact_redis_url(url), workers,
        )
        return

    if not url:
        auth_log.info(
            "auth.singleflight.ready backend=local workers=%s — "
            "CLAWBITS_REDIS_URL unset (fine for dev / tests; do NOT use "
            "with --workers > 1)",
            workers,
        )
        if workers > 1:
            auth_log.warning(
                "auth.singleflight.degraded reason=no_redis_url workers=%s — "
                "concurrent AT-expiry refreshes WILL race across workers and "
                "users WILL get logged out. Wire CLAWBITS_REDIS_URL.",
                workers,
            )
        return

    # URL set but unreachable. The most dangerous state — operator
    # *thought* they configured Redis but the app degraded silently.
    auth_log.warning(
        "auth.singleflight.degraded reason=redis_unreachable url=%s "
        "workers=%s — single-flight is now per-process; concurrent "
        "AT-expiry refreshes WILL race across workers. Check that the "
        "redis service is up and reachable from the app container.",
        _redact_redis_url(url), workers,
    )


def _redact_redis_url(url: str | None) -> str:
    """Strip any password from a Redis URL before logging it."""
    if not url:
        return "<unset>"
    # ``redis://[user:pass@]host:port/db`` — we only want to redact the
    # ``pass`` if present.
    if "@" not in url:
        return url
    scheme, rest = url.split("://", 1)
    creds, host = rest.rsplit("@", 1)
    if ":" in creds:
        user, _ = creds.split(":", 1)
        return f"{scheme}://{user}:***@{host}"
    return f"{scheme}://***@{host}"


def _refresh_keys(sealed: str) -> tuple[str, str]:
    # Hash the sealed cookie so we don't put a multi-kB Fernet token in a
    # Redis key (visible in ``KEYS`` / ``MONITOR`` / slowlog).
    digest = hashlib.sha256(sealed.encode()).hexdigest()
    return (
        f"workos:refresh:lock:{digest}",
        f"workos:refresh:result:{digest}",
    )


def _refresh_single_flight(client: Any, sealed: str) -> str | None:
    """Refresh ``sealed`` exactly once across concurrent workers.

    Returns the new sealed session string, or ``None`` if refresh failed.
    """
    r = _redis()
    if r is None:
        return _refresh_single_flight_local(client, sealed)
    try:
        return _refresh_single_flight_redis(r, client, sealed)
    except Exception as exc:
        logging.warning(
            "Refresh single-flight: Redis call failed (%s) — falling back "
            "to per-process path for this request only.",
            exc,
        )
        return _refresh_single_flight_local(client, sealed)


def _refresh_single_flight_redis(
    r: Any, client: Any, sealed: str
) -> str | None:
    lock_key, result_key = _refresh_keys(sealed)

    cached = r.get(result_key)
    if cached is not None:
        return None if cached == _REFRESH_FAIL_SENTINEL else cached

    lock_token = secrets.token_hex(16)
    if r.set(lock_key, lock_token, nx=True, ex=_REFRESH_LOCK_TTL_SEC):
        try:
            new_sealed = _do_workos_refresh(client, sealed)
            r.set(
                result_key,
                new_sealed if new_sealed is not None else _REFRESH_FAIL_SENTINEL,
                ex=_REFRESH_RESULT_TTL_SEC,
            )
            return new_sealed
        finally:
            # Compare-and-delete: only release a lock we still own. Prevents
            # a slow leader (took longer than the lock TTL) from deleting
            # the next leader's freshly-acquired lock.
            r.eval(
                "if redis.call('get', KEYS[1]) == ARGV[1] then "
                "return redis.call('del', KEYS[1]) else return 0 end",
                1,
                lock_key,
                lock_token,
            )

    deadline = time.monotonic() + _REFRESH_WAIT_TIMEOUT_SEC
    while time.monotonic() < deadline:
        time.sleep(_REFRESH_POLL_INTERVAL_SEC)
        cached = r.get(result_key)
        if cached is not None:
            return None if cached == _REFRESH_FAIL_SENTINEL else cached
    # Leader didn't publish in time. Don't retry the WorkOS call ourselves —
    # we'd race with whoever still holds the lock and blow the refresh token.
    return None


def _refresh_single_flight_local(client: Any, sealed: str) -> str | None:
    """Per-process fallback. Coordinates threads inside one worker only."""
    cached = _local_cache_get(sealed)
    if cached is not None:
        return None if cached == _REFRESH_FAIL_SENTINEL else cached
    with _LOCAL_REFRESH_LOCK:
        cached = _local_cache_get(sealed)
        if cached is not None:
            return None if cached == _REFRESH_FAIL_SENTINEL else cached
        new_sealed = _do_workos_refresh(client, sealed)
        _local_cache_put(
            sealed,
            new_sealed if new_sealed is not None else _REFRESH_FAIL_SENTINEL,
        )
        return new_sealed


def _do_workos_refresh(client: Any, sealed: str) -> str | None:
    """Rotate the WorkOS refresh token, return a freshly Fernet-sealed cookie.

    Bypasses the SDK's ``session.refresh()`` because that path passes
    ``session: {seal_session: true}`` in the request body and reads
    ``sealed_session`` back — a server-side-sealing mode that not every
    WorkOS environment honours. When WorkOS returns 200 without the
    ``sealed_session`` field, the SDK crashes with ``KeyError`` and
    silently degrades the failure to a generic error.

    Instead we call the same ``/user_management/authenticate`` endpoint
    directly with ``grant_type=refresh_token`` (no server-side sealing)
    and seal the response ourselves with ``seal_session_from_auth_response``
    — the same helper :func:`_seal` uses for the initial OAuth login.
    Same crypto, same cookie format, no SDK ambiguity.
    """
    from workos.session import unseal_data

    fp = session_fingerprint(sealed)
    try:
        decoded = unseal_data(sealed, _cookie_password)
    except Exception as exc:  # noqa: BLE001
        auth_log.warning(
            "auth.refresh.fail session=%s reason=unseal_failed exc=%s",
            fp, type(exc).__name__,
        )
        return None
    refresh_token = decoded.get("refresh_token")
    user = decoded.get("user")
    if not refresh_token or not user:
        auth_log.warning("auth.refresh.fail session=%s reason=missing_rt_or_user", fp)
        return None

    try:
        resp = client._client.request(
            "POST",
            f"{client._resolve_base_url(None)}/user_management/authenticate",
            json={
                "grant_type": "refresh_token",
                "client_id": client.client_id,
                "client_secret": client._api_key,
                "refresh_token": refresh_token,
            },
            headers=client._build_headers("POST", None, None),
            timeout=client._resolve_timeout(None),
        )
    except Exception as exc:  # noqa: BLE001
        auth_log.warning(
            "auth.refresh.fail session=%s reason=network exc=%s msg=%s",
            fp, type(exc).__name__, str(exc).replace("\n", " ")[:200],
        )
        return None

    if resp.status_code != 200:
        body_preview = resp.text[:200].replace("\n", " ")
        auth_log.warning(
            "auth.refresh.fail session=%s reason=workos_%d body=%s",
            fp, resp.status_code, body_preview,
        )
        return None

    payload = resp.json()
    new_access = payload.get("access_token")
    new_refresh = payload.get("refresh_token")
    if not new_access or not new_refresh:
        auth_log.warning(
            "auth.refresh.fail session=%s reason=missing_tokens_in_response",
            fp,
        )
        return None
    return seal_session_from_auth_response(
        access_token=new_access,
        refresh_token=new_refresh,
        user=payload.get("user") or user,
        cookie_password=_cookie_password,
    )


def _local_cache_get(sealed: str) -> str | None:
    entry = _LOCAL_REFRESH_CACHE.get(sealed)
    if entry is None:
        return None
    expires_at, value = entry
    if time.time() >= expires_at:
        _LOCAL_REFRESH_CACHE.pop(sealed, None)
        return None
    return value


def _local_cache_put(old: str, new: str) -> None:
    now = time.time()
    _LOCAL_REFRESH_CACHE[old] = (now + _REFRESH_RESULT_TTL_SEC, new)
    if len(_LOCAL_REFRESH_CACHE) > 256:
        for k, (exp, _) in list(_LOCAL_REFRESH_CACHE.items()):
            if exp < now:
                _LOCAL_REFRESH_CACHE.pop(k, None)


workos_router = APIRouter(prefix="/api/auth", tags=["Human"])


def _resolve_org_selection(
    request: Request,
    err: OrganizationSelectionRequiredError,
) -> Any:
    """Pick the first offered org when WorkOS demands selection.

    Fires when a user belongs to 2+ orgs and the initial auth call didn't
    specify which one. Picking the first (oldest) handles both legitimate
    multi-tenant users and any pre-fix duplicates left by ``_provision_new_user``.
    """
    orgs = err.organizations or []
    token = err.pending_authentication_token
    if not orgs or not token:
        raise HTTPException(
            status_code=400,
            detail="WorkOS requires organization selection but none were offered.",
        )
    chosen = orgs[0]["id"]
    logging.info(
        f"WorkOS org selection required for user "
        f"{(err.user or {}).get('email')!r}: {len(orgs)} orgs offered, "
        f"picking {chosen!r} (oldest first in the list)."
    )
    return _client(request).user_management.authenticate_with_organization_selection(
        pending_authentication_token=token,
        organization_id=chosen,
        ip_address=_client_ip(request),
        user_agent=request.headers.get("user-agent"),
    )


class SendMagicRequest(BaseModel):
    email: EmailStr


class VerifyMagicRequest(BaseModel):
    email: EmailStr
    code: str = Field(pattern=r"^\d{6}$")


class MeResponse(BaseModel):
    id: int
    email: str
    display_name: str | None
    # Account meta — surfaced on the settings/profile page. Both come
    # from the human_users row; ``created_at`` is the immutable
    # signup moment, ``last_seen_at`` ticks on every presence
    # heartbeat (Redis-backed, 5-min throttle).
    created_at: str | None = None
    last_seen_at: str | None = None
    # Generated avatar reference — same shape as the embedded
    # ``avatar`` field on user / agent / channel mm responses.
    avatar: AvatarRef | None = None
    # Optional sealed WorkOS session. Auth-success endpoints (magic verify,
    # social verify-email) populate it so Tauri clients can store and resend
    # via Authorization: Bearer (cookies don't survive cross-origin from
    # tauri://). GET /me omits it.
    token: str | None = None


@workos_router.post("/magic/send", status_code=204)
def send_magic_code(body: SendMagicRequest, request: Request):
    """Send a one-time email code. First-time users are auto-created on verify."""
    _client(request).user_management.create_magic_auth(email=body.email)


@workos_router.post("/magic/verify", response_model=MeResponse)
async def verify_magic_code(body: VerifyMagicRequest, request: Request):
    client = _client(request)
    try:
        auth_resp = client.user_management.authenticate_with_magic_auth(
            code=body.code,
            email=body.email,
            ip_address=_client_ip(request),
            user_agent=request.headers.get("user-agent"),
        )
    except OrganizationSelectionRequiredError as e:
        auth_resp = _resolve_org_selection(request, e)
    sealed = _seal(auth_resp)

    user = await _ensure_user(
        request,
        workos_user_id=auth_resp.user.id,
        email=auth_resp.user.email,
        first_name=getattr(auth_resp.user, "first_name", None),
        last_name=getattr(auth_resp.user, "last_name", None),
    )
    stage_session_set(request, sealed)
    auth_log.info(
        "auth.login.magic user_id=%s email=%s session=%s",
        user.get("id"), user.get("email"), session_fingerprint(sealed),
    )

    audit.user_signed_in(
        request,
        user=user,
        workos_org_id=_personal_org_workos_id(request, user["id"]),
        method="magic_auth",
    )
    return MeResponse(
        id=user["id"],
        email=user["email"],
        display_name=user["display_name"],
        token=sealed,
    )


_SOCIAL_PROVIDERS: dict[str, str] = {
    "google": "GoogleOAuth",
    "github": "GitHubOAuth",
}


@workos_router.get("/social/{provider}/start")
def social_start(
    provider: Literal["google", "github"],
    request: Request,
    desktop: int = 0,
    bridge: str = "",
):
    """Redirect the browser to the provider via WorkOS.

    Two non-cookie bridge modes are supported for native clients that
    can't share cookies with the system browser:

    * ``?desktop=1`` — Tauri desktop client. The callback returns an
      HTML page that fires ``<env-suffixed-scheme>://oauth-callback?token=…``
      so dev / staging / prod desktop binaries can be installed
      side-by-side without one stealing another's OAuth tail.
    * ``?bridge=deeplink`` — mobile (Expo) client. Same HTML-bridge
      callback path, but always hands back the fixed ``clawbits://``
      scheme that ``apps/mobile/app.json`` registers. Mobile builds
      ship one scheme per binary; the env split lives in the API base
      URL, not the deep-link target.

    The two flags share the same callback path; the state prefix tells
    :func:`social_callback` which scheme to emit (``desktop.`` for the
    env-suffixed desktop scheme, ``mobile.`` for the fixed mobile one).
    """
    client = _client(request)
    state_token = secrets.token_urlsafe(24)
    if bridge == "deeplink":
        state = f"mobile.{state_token}"
    elif desktop:
        state = f"desktop.{state_token}"
    else:
        state = state_token
    auth_url = client.user_management.get_authorization_url(
        provider=_SOCIAL_PROVIDERS[provider],
        redirect_uri=_social_redirect_uri(),
        state=state,
    )
    response = RedirectResponse(auth_url, status_code=302)
    # OAuth state is flow-internal; we set it directly on the redirect
    # because the endpoint owns the response shape end to end.
    response.set_cookie(
        key=OAUTH_STATE_COOKIE, value=state, max_age=600, **cookie_kwargs()
    )
    return response


@workos_router.get("/social/callback")
async def social_callback(
    request: Request,
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
    # Read the env-suffixed cookie set by ``/social/{provider}/start``.
    # Without ``alias=`` FastAPI would read the literal parameter name
    # ``fc_oauth_state``, which doesn't match ``fc_oauth_state_staging``
    # / ``fc_oauth_state_dev`` in non-prod environments — breaking OAuth.
    oauth_state_cookie: str | None = Cookie(default=None, alias=OAUTH_STATE_COOKIE),
):
    """OAuth callback. Validates state, exchanges code, sets session cookie."""
    frontend_root = _frontend_root()

    if error:
        return RedirectResponse(
            f"{frontend_root}/login?error={urllib.parse.quote(error)}",
            status_code=302,
        )
    if not code or not state or state != oauth_state_cookie:
        return RedirectResponse(
            f"{frontend_root}/login?error=oauth_state_mismatch", status_code=302
        )

    client = _client(request)
    try:
        auth_resp = client.user_management.authenticate_with_code(
            code=code,
            ip_address=_client_ip(request),
            user_agent=request.headers.get("user-agent"),
        )
    except OrganizationSelectionRequiredError as e:
        auth_resp = _resolve_org_selection(request, e)
    except EmailVerificationRequiredError as e:
        # WorkOS already emailed a 6-digit code to the user. Stash the
        # pending-auth token in a short-lived httpOnly cookie and bounce
        # the browser to the verification page; the user types the code
        # there, and ``/social/verify-email`` finishes the flow.
        auth_log.info(
            "auth.login.social.email_verification_required email=%s", e.email,
        )
        return _redirect_to_email_verification(
            frontend_root=frontend_root,
            email=e.email,
            pending_authentication_token=e.pending_authentication_token,
        )

    # Connector link flow (Settings → Connectors) uses a dedicated GitHub
    # OAuth App at ``/api/auth/connectors/github/callback`` — not this
    # WorkOS social callback. Login and link stay separate on purpose.

    sealed = _seal(auth_resp)

    user = await _ensure_user(
        request,
        workos_user_id=auth_resp.user.id,
        email=auth_resp.user.email,
        first_name=getattr(auth_resp.user, "first_name", None),
        last_name=getattr(auth_resp.user, "last_name", None),
    )

    # Best-effort: if this WorkOS user has a GitHub identity, persist the
    # connector profile (metadata only). Never blocks login.
    try:
        from clawbits.fastapi.connectors_endpoints import sync_github_from_workos

        await sync_github_from_workos(
            request,
            human_id=int(user["id"]),
            workos_user_id=str(auth_resp.user.id),
        )
    except Exception:  # noqa: BLE001
        auth_log.warning(
            "auth.login.social.connector_sync_failed user_id=%s",
            user.get("id"),
            exc_info=True,
        )

    stage_session_set(request, sealed)
    auth_log.info(
        "auth.login.social user_id=%s email=%s session=%s",
        user.get("id"), user.get("email"), session_fingerprint(sealed),
    )

    # Native-client flow (desktop / mobile): bounce back into the app via
    # a custom URL scheme with the sealed token in the query string. The
    # OS hands the URL to the running Clawbits app, whose deep-link
    # handler stores the token and routes to /home. The cookie set above
    # is still emitted to the system browser but is harmless there.
    #
    # We return an HTML page (not a 302) so we can attempt to ``close()``
    # the browser tab after firing the deep link. window.close() is honored
    # by Chrome on protocol-handler tabs; Safari is hit-or-miss, hence the
    # visible "you can close this tab" fallback.
    deep_link_scheme: str | None = None
    if state.startswith("desktop."):
        # The desktop binary registers a channel-specific URL scheme so
        # prod, staging, and dev installs can coexist without colliding
        # on `xdg-mime` / Launch Services routing. Pick the scheme this
        # backend should hand back based on ``CLAWBITS_ENV``; the desktop
        # build for the matching channel is the only thing that can open
        # this URL.
        deep_link_scheme = _desktop_url_scheme()
    elif state.startswith("mobile."):
        # Mobile bundles ship one scheme per binary (``clawbits`` only).
        # Env separation comes from the API base URL the client points
        # at, not from the scheme — so we always hand back the bare
        # ``clawbits://`` here regardless of ``CLAWBITS_ENV``.
        deep_link_scheme = "clawbits"

    if deep_link_scheme is not None:
        deep_link = (
            f"{deep_link_scheme}://oauth-callback?"
            + urllib.parse.urlencode({"token": sealed})
        )
        html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Clawbits — sign-in complete</title>
<style>
  html, body {{ margin: 0; height: 100%; }}
  body {{
    display: flex; align-items: center; justify-content: center;
    font: 15px/1.5 -apple-system, system-ui, "Segoe UI", sans-serif;
    color: #1c1c1e; background: #f5f5f7;
  }}
  .card {{ text-align: center; max-width: 360px; padding: 32px; }}
  h1 {{ font-size: 20px; margin: 0 0 6px; font-weight: 600; }}
  p {{ margin: 0; color: #6e6e73; }}
  @media (prefers-color-scheme: dark) {{
    body {{ color: #f5f5f7; background: #1c1c1e; }}
    p {{ color: #98989d; }}
  }}
</style>
</head>
<body>
<div class="card">
  <h1>You're signed in</h1>
  <p>Returning to Clawbits — you can close this tab.</p>
</div>
<script>
  // Fire the deep link, then attempt to close the tab. Most modern browsers
  // allow window.close() on OAuth callback tabs; if not, the user closes it.
  window.location.replace({json.dumps(deep_link)});
  setTimeout(function() {{ try {{ window.close(); }} catch (e) {{}} }}, 400);
</script>
</body>
</html>"""
        response = HTMLResponse(content=html, status_code=200)
    else:
        response = RedirectResponse(f"{frontend_root}/home", status_code=302)
    response.delete_cookie(OAUTH_STATE_COOKIE, path="/")

    audit.user_signed_in(
        request,
        user=user,
        workos_org_id=_personal_org_workos_id(request, user["id"]),
        method="social_oauth",
    )
    return response


def _redirect_to_email_verification(
    *,
    frontend_root: str,
    email: str | None,
    pending_authentication_token: str | None,
) -> RedirectResponse:
    """Send the browser to ``/verify-email`` with the pending token in a
    cookie and the email surfaced in the query string for display."""
    if not pending_authentication_token:
        # Defensive: WorkOS shouldn't raise email_verification_required
        # without a token, but if it does we can't recover the flow.
        return RedirectResponse(
            f"{frontend_root}/login?error=email_verification_unavailable",
            status_code=302,
        )
    qs = urllib.parse.urlencode({"email": email or ""})
    response = RedirectResponse(
        f"{frontend_root}/verify-email?{qs}", status_code=302,
    )
    response.set_cookie(
        key=OAUTH_PENDING_COOKIE,
        value=pending_authentication_token,
        max_age=OAUTH_PENDING_COOKIE_MAX_AGE,
        **cookie_kwargs(),
    )
    response.delete_cookie(OAUTH_STATE_COOKIE, path="/")
    return response


class VerifySocialEmailRequest(BaseModel):
    code: str = Field(pattern=r"^\d{6}$")


@workos_router.post("/social/verify-email", response_model=MeResponse)
async def verify_social_email(
    body: VerifySocialEmailRequest,
    request: Request,
    pending_token: str | None = Cookie(default=None, alias=OAUTH_PENDING_COOKIE),
):
    """Complete a social sign-in that WorkOS gated behind email verification.

    The pending-auth token was set by ``social_callback`` when WorkOS raised
    :class:`EmailVerificationRequiredError`. We exchange ``(token, code)`` for
    a real session, mirroring the post-auth bookkeeping the callback would
    have done if no verification had been required.
    """
    if not pending_token:
        raise HTTPException(status_code=400, detail="No pending email verification")

    client = _client(request)
    try:
        auth_resp = client.user_management.authenticate_with_email_verification(
            code=body.code,
            pending_authentication_token=pending_token,
            ip_address=_client_ip(request),
            user_agent=request.headers.get("user-agent"),
        )
    except OrganizationSelectionRequiredError as e:
        auth_resp = _resolve_org_selection(request, e)
    except AuthenticationError as e:
        # 401 from WorkOS — wrong code, expired code, expired pending token,
        # rate-limited. Surface a clean 401 instead of letting it propagate
        # as a 500. The pending cookie is left intact so the user can retry
        # (and WorkOS itself enforces the per-token attempt cap).
        auth_log.info(
            "auth.login.social.email_verification_rejected code=%s message=%s",
            getattr(e, "code", None), getattr(e, "message", str(e)),
        )
        raise HTTPException(
            status_code=401,
            detail=getattr(e, "message", None) or "Invalid or expired code",
        ) from e
    except WorkOSError as e:
        # Anything else from WorkOS (5xx, network) — log and 502.
        auth_log.exception("auth.login.social.email_verification_failed")
        raise HTTPException(
            status_code=502, detail="Verification service unavailable",
        ) from e

    sealed = _seal(auth_resp)
    user = await _ensure_user(
        request,
        workos_user_id=auth_resp.user.id,
        email=auth_resp.user.email,
        first_name=getattr(auth_resp.user, "first_name", None),
        last_name=getattr(auth_resp.user, "last_name", None),
    )

    stage_session_set(request, sealed)
    auth_log.info(
        "auth.login.social.email_verified user_id=%s email=%s session=%s",
        user.get("id"), user.get("email"), session_fingerprint(sealed),
    )

    audit.user_signed_in(
        request,
        user=user,
        workos_org_id=_personal_org_workos_id(request, user["id"]),
        method="social_oauth_email_verified",
    )

    response = JSONResponse(
        MeResponse(
            id=user["id"],
            email=user["email"],
            display_name=user["display_name"],
        ).model_dump()
    )
    response.delete_cookie(OAUTH_PENDING_COOKIE, path="/")
    return response


@workos_router.get("/me", response_model=MeResponse)
def me(request: Request, user: dict = Depends(get_current_human_user)):
    # Pull the row fresh so account meta + avatar reflect any changes
    # since the session was issued (avatar resets, display-name edits,
    # last-seen ticks). The auth ``user`` dict comes from a sealed
    # WorkOS session and doesn't include these fields.
    from clawbits.db.models import HumanUser as _HumanUserRow
    with Session(request.app._engine) as db:
        row = db.get(_HumanUserRow, int(user["id"]))
    avatar = None
    if row is not None:
        avatar = avatar_ref_for_user(
            user_id=int(user["id"]),
            version=row.avatar_version,
            kind=row.avatar_kind,
        )
    return MeResponse(
        id=user["id"],
        email=user["email"],
        display_name=user["display_name"],
        created_at=row.created_at.isoformat() if row and row.created_at else None,
        last_seen_at=row.last_seen_at.isoformat() if row and row.last_seen_at else None,
        avatar=avatar,
    )


@workos_router.post("/logout", status_code=204)
def logout(
    request: Request,
    user: dict = Depends(get_current_human_user),
):
    auth_log.info(
        "auth.logout user_id=%s email=%s",
        user.get("id"), user.get("email"),
    )
    audit.user_signed_out(
        request,
        user=user,
        workos_org_id=_personal_org_workos_id(request, user["id"]),
    )
    stage_session_clear(request)


def _seal(auth_resp: Any) -> str:
    user = auth_resp.user
    return seal_session_from_auth_response(
        access_token=auth_resp.access_token,
        refresh_token=auth_resp.refresh_token,
        user=user.to_dict() if hasattr(user, "to_dict") else dict(user),
        cookie_password=_cookie_password,
    )


def create_workos_organization(client: Any, *, name: str) -> str:
    """Create a WorkOS organization with a random suffix to dodge name collisions."""
    suffix = secrets.token_hex(3)
    org = client.organizations.create_organization(name=f"{name}-{suffix}")
    return org.id


# Map our local ``owner``/``member`` role slugs to WorkOS's default ``admin``/``member``.
_LOCAL_TO_WORKOS_ROLE = {"owner": "admin", "member": "member"}
# Inverse map for the on-login reconcile. Unknown slugs degrade to ``member``
# so a custom WorkOS role can't accidentally grant owner powers.
_WORKOS_TO_LOCAL_ROLE = {"admin": "owner", "member": "member"}


def register_membership(
    client: Any, *, workos_user_id: str, workos_org_id: str, role: str,
) -> None:
    """Mirror a local org membership in WorkOS. Falls back to the workspace
    default role if the typed-role slug isn't configured."""
    if not workos_user_id or not workos_org_id:
        return
    workos_role = _LOCAL_TO_WORKOS_ROLE.get(role, "member")
    try:
        client.user_management.create_organization_membership(
            user_id=workos_user_id,
            organization_id=workos_org_id,
            role=RoleSingle(role_slug=workos_role),
        )
        return
    except Exception:
        logging.exception(
            f"WorkOS membership creation with role={workos_role!r} failed for "
            f"user={workos_user_id} org={workos_org_id}; retrying without role."
        )

    try:
        client.user_management.create_organization_membership(
            user_id=workos_user_id,
            organization_id=workos_org_id,
        )
    except Exception:
        logging.exception(
            f"WorkOS membership creation (default role) also failed for "
            f"user={workos_user_id} org={workos_org_id}. The user will not "
            f"appear as a member of this org in the WorkOS dashboard."
        )


def update_membership_role(
    client: Any, *, workos_user_id: str, workos_org_id: str, role: str,
) -> None:
    """Mirror a local role change onto the WorkOS-side membership.

    Best-effort, but not cosmetic: :func:`_reconcile_workos_memberships`
    copies WorkOS roles back into ``org_members`` on every login, so a
    local promotion that never reaches WorkOS is silently undone the next
    time that user signs in.
    """
    if not workos_user_id or not workos_org_id:
        return
    workos_role = _LOCAL_TO_WORKOS_ROLE.get(role, "member")
    try:
        page = client.user_management.list_organization_memberships(
            user_id=workos_user_id, organization_id=workos_org_id
        )
        memberships = getattr(page, "data", []) or []
    except Exception as e:
        logging.warning(
            f"WorkOS membership lookup failed for user={workos_user_id} "
            f"org={workos_org_id}: {e}. Local role is now {role!r} but WorkOS "
            f"still holds the old one; the next login will revert it."
        )
        return

    for m in memberships:
        try:
            client.user_management.update_organization_membership(
                m.id, role=RoleSingle(role_slug=workos_role),
            )
        except Exception:
            logging.exception(
                f"WorkOS membership role update to {workos_role!r} failed for "
                f"user={workos_user_id} org={workos_org_id}. Local role is now "
                f"{role!r}; the next login will revert it."
            )


def unregister_membership(
    client: Any, *, workos_user_id: str, workos_org_id: str
) -> None:
    """Delete the WorkOS-side membership matching ``(user, org)``. Best-effort."""
    if not workos_user_id or not workos_org_id:
        return
    try:
        page = client.user_management.list_organization_memberships(
            user_id=workos_user_id, organization_id=workos_org_id
        )
        for m in getattr(page, "data", []) or []:
            client.user_management.delete_organization_membership(m.id)
    except Exception as e:
        logging.warning(
            f"WorkOS membership unsync failed for user={workos_user_id} "
            f"org={workos_org_id}: {e}"
        )


def delete_workos_user(client: Any, *, workos_user_id: str) -> None:
    """Delete the WorkOS-side user account. Best-effort.

    Called when a human deletes their clawbits account so the WorkOS user
    doesn't linger. Deleting the user also drops its organization
    memberships on the WorkOS side, so this both removes the dashboard entry
    and stops :func:`_provision_new_user` from *adopting* the ghost org if
    the same person logs in again later.
    """
    if not workos_user_id:
        return
    try:
        client.user_management.delete_user(workos_user_id)
    except Exception as e:
        logging.warning(
            f"WorkOS user deletion failed for user={workos_user_id}: {e}"
        )


def delete_workos_organization(client: Any, *, workos_org_id: str) -> None:
    """Delete a WorkOS-side organization. Best-effort.

    Used to tear down the orgs a departing user solely occupied (their
    personal org and any other solo org) so they don't linger empty in the
    WorkOS dashboard after the local rows are gone.
    """
    if not workos_org_id:
        return
    try:
        client.organizations.delete_organization(workos_org_id)
    except Exception as e:
        logging.warning(
            f"WorkOS organization deletion failed for org={workos_org_id}: {e}"
        )


def _social_redirect_uri() -> str:
    base = os.environ.get("CLAWBITS_BASE_URL", "http://localhost:8000").rstrip("/")
    return f"{base}/api/auth/social/callback"


def _frontend_root() -> str:
    return os.environ.get("CLAWBITS_FRONTEND_URL", "http://localhost:5173").rstrip("/")


def _desktop_url_scheme() -> str:
    """URL scheme the channel-matched desktop build registers.

    Prod, staging, and dev binaries each register a distinct scheme so
    they can be installed side-by-side without one stealing OAuth
    redirects meant for another. The mapping mirrors the channel set in
    ``desktop/src-tauri/tauri.<channel>.conf.json``.

    Unrecognized envs fall back to the dev scheme — that's the safe
    default for a developer running the backend locally against a Dev
    build of the desktop app.
    """
    env = (os.environ.get("CLAWBITS_ENV") or "").lower()
    if env == "production":
        return "clawbits"
    if env == "staging":
        return "clawbits-staging"
    return "clawbits-dev"


def _display_name(first: str | None, last: str | None) -> str | None:
    parts = [p for p in (first, last) if p]
    return " ".join(parts) if parts else None


def _personal_org_workos_id(request: Request, human_id: int) -> str:
    """Look up the user's personal-org ``workos_org_id`` for audit scoping."""
    with _db(request) as db:
        org_id = TableRead.get_personal_org_id(db, human_id)
        if org_id is None:
            return ""
        org = TableRead.get_organization(db, org_id)
        return (org or {}).get("workos_org_id", "") or ""


def _client_ip(request: Request) -> str | None:
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else None
