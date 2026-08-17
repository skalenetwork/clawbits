"""In-memory ``WorkOSClient`` substitute used by the test suite.

Mirrors the shape of :class:`workos.WorkOSClient` for the methods that
``clawbits.fastapi.workos_auth`` actually calls. Conftest installs an
instance at ``app.state.workos`` before each test, so production code path
is unchanged.

Surface coverage:
* ``client.user_management.create_magic_auth(email)``
* ``client.user_management.authenticate_with_magic_auth(email, code, ...)``
* ``client.user_management.authenticate_with_code(code, ...)``
* ``client.user_management.get_authorization_url(provider, redirect_uri, state)``
* ``client.user_management.get_user_identities(id)``
* ``client.user_management.load_sealed_session(session_data, cookie_password)``
* ``client.organizations.create_organization(name)``
* ``client.audit_logs.create_event(organization_id, event)``
"""
from __future__ import annotations

import hashlib
import json
import secrets
import urllib.parse
from dataclasses import dataclass, field
from typing import Any

from cryptography.fernet import Fernet
from fastapi import HTTPException
from workos._errors import (
    AuthenticationError,
    EmailVerificationRequiredError,
    OrganizationSelectionRequiredError,
)

DEV_MAGIC_CODE = "123456"
_FAKE_SOCIAL_PREFIX = "fakecode_"


@dataclass
class FakeUser:
    id: str
    email: str
    first_name: str | None = None
    last_name: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "email": self.email,
            "first_name": self.first_name,
            "last_name": self.last_name,
        }


@dataclass
class FakeIdentity:
    """Stand-in for WorkOS ``UserIdentitiesGetItem`` (GitHub / Google / …)."""

    idp_id: str
    provider: str = "GitHubOAuth"
    type: str = "OAuth"


@dataclass
class _FakeAuthResponse:
    user: FakeUser
    access_token: str
    refresh_token: str
    organization_id: str | None = None


@dataclass
class _FakeSessionAuthResult:
    authenticated: bool
    user: dict[str, Any] | None = None


@dataclass
class _FakeSessionRefreshResult:
    authenticated: bool
    sealed_session: str = ""
    user: dict[str, Any] | None = None


class _FakeSession:
    """Stand-in for :class:`workos.session.Session` that skips JWT validation.

    Real ``Session.authenticate()`` calls a JWKS endpoint over HTTP — we
    short-circuit and just return the unsealed claims.
    """

    def __init__(self, *, session_data: str, cookie_password: str) -> None:
        self._session_data = session_data
        self._cookie_password = cookie_password

    def authenticate(self) -> _FakeSessionAuthResult:
        try:
            decoded = json.loads(
                Fernet(self._cookie_password).decrypt(self._session_data.encode())
            )
        except Exception:
            return _FakeSessionAuthResult(authenticated=False)
        return _FakeSessionAuthResult(authenticated=True, user=decoded.get("user"))

    def refresh(self) -> _FakeSessionRefreshResult:
        try:
            decoded = json.loads(
                Fernet(self._cookie_password).decrypt(self._session_data.encode())
            )
        except Exception:
            return _FakeSessionRefreshResult(authenticated=False)
        # Reseal with a rotated token; user identity unchanged.
        decoded["access_token"] = secrets.token_hex(16)
        new_sealed = (
            Fernet(self._cookie_password)
            .encrypt(json.dumps(decoded).encode())
            .decode()
        )
        return _FakeSessionRefreshResult(
            authenticated=True, sealed_session=new_sealed, user=decoded.get("user")
        )


class _FakeUserManagement:
    def __init__(self, parent: FakeWorkOSClient) -> None:
        self._p = parent

    def create_magic_auth(self, *, email: str, **_: Any) -> Any:
        self._p.pending_magic[email] = DEV_MAGIC_CODE
        return None

    def authenticate_with_magic_auth(
        self, *, email: str, code: str, **_: Any
    ) -> _FakeAuthResponse:
        if self._p.pending_magic.get(email) != code:
            raise HTTPException(status_code=401, detail="Invalid or expired code")
        del self._p.pending_magic[email]
        self._p._raise_if_org_selection_required(email)
        return self._p._auth_response_for_email(email)

    def authenticate_with_code(self, *, code: str, **_: Any) -> _FakeAuthResponse:
        email = self._p.pending_social.pop(code, None)
        if email is None:
            raise HTTPException(status_code=401, detail="Invalid authorization code")
        self._p._raise_if_email_verification_required(email)
        self._p._raise_if_org_selection_required(email)
        return self._p._auth_response_for_email(email)

    def authenticate_with_email_verification(
        self,
        *,
        code: str,
        pending_authentication_token: str,
        **_: Any,
    ) -> _FakeAuthResponse:
        """Resolve a pending email-verification auth (mirrors the real SDK)."""
        email = self._p.pending_email_verification.pop(
            pending_authentication_token, None,
        )
        if email is None:
            # WorkOS returns 401 with code=invalid_pending_authentication_token.
            raise AuthenticationError(
                "Invalid pending authentication token.",
                code="invalid_pending_authentication_token",
            )
        expected = self._p.email_verification_codes.pop(email, None)
        if expected is None or code != expected:
            # Re-stash the pending mapping so the user can retry — matches
            # WorkOS behaviour where a wrong code doesn't burn the token.
            self._p.pending_email_verification[pending_authentication_token] = email
            if expected is not None:
                self._p.email_verification_codes[email] = expected
            raise AuthenticationError(
                "The verification code is invalid or has expired.",
                code="email_verification_code_invalid",
            )
        # Mark the email as verified so subsequent auths skip the gate.
        self._p.email_verification_required.discard(email)
        self._p._raise_if_org_selection_required(email)
        return self._p._auth_response_for_email(email)

    def authenticate_with_organization_selection(
        self,
        *,
        pending_authentication_token: str,
        organization_id: str,
        **_: Any,
    ) -> _FakeAuthResponse:
        """Resolve a pending org-selection auth (mirrors the real SDK)."""
        email = self._p.pending_org_selection.pop(pending_authentication_token, None)
        if email is None:
            raise HTTPException(
                status_code=401,
                detail="Invalid pending_authentication_token",
            )
        # The chosen org must be one the user actually belongs to — same
        # check the real WorkOS endpoint enforces.
        member_orgs = {
            m.organization_id
            for m in self._p.memberships
            if m.user_id == self._p.users_by_email[email].id
        }
        if organization_id not in member_orgs:
            raise HTTPException(status_code=403, detail="not a member of organization")
        self._p.org_selection_resolved.append((email, organization_id))
        return self._p._auth_response_for_email(email)

    def get_authorization_url(
        self, *, provider: str, redirect_uri: str, state: str, **_: Any
    ) -> str:
        params = urllib.parse.urlencode(
            {"provider": provider, "redirect_uri": redirect_uri, "state": state}
        )
        return f"https://workos.fake/authorize?{params}"

    def get_user_identities(self, id: str, **_: Any) -> list[FakeIdentity]:
        """Mirror WorkOS ``get_user_identities(id=...)``."""
        return list(self._p.identities_by_user_id.get(id, []))

    def load_sealed_session(
        self, *, session_data: str, cookie_password: str
    ) -> _FakeSession:
        return _FakeSession(session_data=session_data, cookie_password=cookie_password)

    # ---- organization memberships (mirrored to WorkOS) -----------------

    def create_organization_membership(
        self, *, user_id: str, organization_id: str, role: Any = None, **_: Any
    ) -> Any:
        # Production passes ``role=RoleSingle(role_slug=...)``; tolerate that
        # plus a plain string fallback so the fake mirrors SDK behaviour.
        slug = getattr(role, "role_slug", None) or (role if isinstance(role, str) else None)
        membership = _FakeMembership(
            id=f"om_{secrets.token_hex(8)}",
            user_id=user_id,
            organization_id=organization_id,
            role=slug or "member",
        )
        self._p.memberships.append(membership)
        return membership

    def list_organization_memberships(
        self,
        *,
        user_id: str | None = None,
        organization_id: str | None = None,
        **_: Any,
    ) -> Any:
        matches = [
            m
            for m in self._p.memberships
            if (user_id is None or m.user_id == user_id)
            and (organization_id is None or m.organization_id == organization_id)
        ]
        return _FakePage(data=matches)

    def update_organization_membership(
        self, id: str, *, role: Any = None, **_: Any
    ) -> Any:
        """Mirror WorkOS ``update_organization_membership(id, role=...)``.

        Positional ``id``, keyword-only ``role`` — matches the v6 SDK, so a
        call-site that drifts from that signature fails here instead of being
        swallowed by the best-effort ``except`` in ``update_membership_role``.
        """
        slug = getattr(role, "role_slug", None) or (role if isinstance(role, str) else None)
        for m in self._p.memberships:
            if m.id == id:
                if slug is not None:
                    m.role = slug
                return m
        return None

    def delete_organization_membership(self, id: str, **_: Any) -> None:
        self._p.memberships = [m for m in self._p.memberships if m.id != id]

    def delete_user(self, user_id: str, **_: Any) -> None:
        # Mirror WorkOS: deleting a user also drops its memberships.
        email = next(
            (e for e, u in self._p.users_by_email.items() if u.id == user_id),
            None,
        )
        if email is not None:
            del self._p.users_by_email[email]
        self._p.memberships = [
            m for m in self._p.memberships if m.user_id != user_id
        ]
        self._p.deleted_user_ids.append(user_id)


@dataclass
class _FakeOrg:
    id: str
    name: str


@dataclass
class _FakeMembership:
    id: str
    user_id: str
    organization_id: str
    role: str


@dataclass
class _FakePage:
    data: list[Any]


class _FakeOrganizations:
    def __init__(self, parent: FakeWorkOSClient) -> None:
        self._p = parent

    def create_organization(self, *, name: str, **_: Any) -> _FakeOrg:
        oid = f"org_{secrets.token_hex(8)}"
        org = _FakeOrg(id=oid, name=name)
        self._p.orgs[oid] = org
        return org

    def delete_organization(self, organization_id: str, **_: Any) -> None:
        self._p.orgs.pop(organization_id, None)
        self._p.deleted_org_ids.append(organization_id)


class _FakeAuditLogs:
    def __init__(self, parent: FakeWorkOSClient) -> None:
        self._p = parent

    def create_event(self, *, organization_id: str, event: Any, **_: Any) -> None:
        self._p.audit_events.append(
            {"organization_id": organization_id, "event": event}
        )


@dataclass
class FakeWorkOSClient:
    """Process-local stand-in for :class:`workos.WorkOSClient`.

    Magic codes are deterministic (``"123456"``). Social codes are minted
    with :meth:`inject_social_code`. Audit events are appended to
    ``audit_events`` for assertions.
    """

    cookie_password: str = ""
    users_by_email: dict[str, FakeUser] = field(default_factory=dict)
    orgs: dict[str, _FakeOrg] = field(default_factory=dict)
    memberships: list[_FakeMembership] = field(default_factory=list)
    pending_magic: dict[str, str] = field(default_factory=dict)
    pending_social: dict[str, str] = field(default_factory=dict)
    # Pending org-selection flows (token -> email). Populated when the
    # user has 2+ memberships and we raise OrganizationSelectionRequiredError;
    # consumed by ``authenticate_with_organization_selection``.
    pending_org_selection: dict[str, str] = field(default_factory=dict)
    org_selection_resolved: list[tuple[str, str]] = field(default_factory=list)
    # Emails that should trigger ``EmailVerificationRequiredError`` on the
    # next ``authenticate_with_code``. Populated by
    # :meth:`require_email_verification`; cleared when the email is verified.
    email_verification_required: set[str] = field(default_factory=set)
    # token -> email, awaiting ``authenticate_with_email_verification``.
    pending_email_verification: dict[str, str] = field(default_factory=dict)
    # email -> 6-digit code WorkOS would have emailed. ``"123456"`` by default.
    email_verification_codes: dict[str, str] = field(default_factory=dict)
    audit_events: list[dict[str, Any]] = field(default_factory=list)
    # workos_user_id -> linked IdP identities (GitHubOAuth, …)
    identities_by_user_id: dict[str, list[FakeIdentity]] = field(default_factory=dict)
    # WorkOS-side deletions, recorded for assertions.
    deleted_user_ids: list[str] = field(default_factory=list)
    deleted_org_ids: list[str] = field(default_factory=list)

    user_management: _FakeUserManagement = field(init=False)
    organizations: _FakeOrganizations = field(init=False)
    audit_logs: _FakeAuditLogs = field(init=False)

    def __post_init__(self) -> None:
        self.user_management = _FakeUserManagement(self)
        self.organizations = _FakeOrganizations(self)
        self.audit_logs = _FakeAuditLogs(self)

    # ----- test helpers --------------------------------------------------

    def inject_social_code(self, *, email: str) -> str:
        """Mint a fake social-callback code resolving to ``email``."""
        if email not in self.users_by_email:
            self._make_user(email)
        code = f"{_FAKE_SOCIAL_PREFIX}{secrets.token_hex(8)}"
        self.pending_social[code] = email
        return code

    def inject_github_identity(
        self, *, email: str, github_user_id: str = "424242",
    ) -> FakeIdentity:
        """Attach a GitHubOAuth identity to the WorkOS user for ``email``."""
        user = self.users_by_email.get(email) or self._make_user(email)
        identity = FakeIdentity(idp_id=str(github_user_id), provider="GitHubOAuth")
        self.identities_by_user_id.setdefault(user.id, []).append(identity)
        return identity

    def require_email_verification(self, *, email: str, code: str = "654321") -> None:
        """Mark ``email`` as needing verification on its next social-code
        exchange. The fake will then raise
        :class:`EmailVerificationRequiredError`, and tests can submit ``code``
        to :meth:`authenticate_with_email_verification` to complete the flow.
        """
        self.email_verification_required.add(email)
        self.email_verification_codes[email] = code

    # ----- internals -----------------------------------------------------

    def _make_user(self, email: str) -> FakeUser:
        uid = f"user_{hashlib.sha1(email.encode()).hexdigest()[:24]}"
        u = FakeUser(id=uid, email=email)
        self.users_by_email[email] = u
        return u

    def _auth_response_for_email(self, email: str) -> _FakeAuthResponse:
        user = self.users_by_email.get(email) or self._make_user(email)
        return _FakeAuthResponse(
            user=user,
            access_token=secrets.token_hex(16),
            refresh_token=secrets.token_hex(16),
        )

    def _raise_if_email_verification_required(self, email: str) -> None:
        """Mirror real WorkOS: when the email is gated behind verification,
        raise :class:`EmailVerificationRequiredError` with a fresh pending
        token. The token resolves back to ``email`` in
        :meth:`_FakeUserManagement.authenticate_with_email_verification`.
        """
        if email not in self.email_verification_required:
            return
        token = f"pending_ev_{secrets.token_hex(8)}"
        self.pending_email_verification[token] = email
        raise EmailVerificationRequiredError(
            "Email ownership must be verified before authentication.",
            pending_authentication_token=token,
            email_verification_id=f"email_verification_{secrets.token_hex(12)}",
            email=email,
        )

    def _raise_if_org_selection_required(self, email: str) -> None:
        """Mirror the real WorkOS behaviour: when a user has 2+ org
        memberships and the auth call didn't pin one, raise
        :class:`OrganizationSelectionRequiredError`. Tests can simulate
        the duplicate-personal-org bug by directly attaching memberships.
        """
        user = self.users_by_email.get(email)
        if user is None:
            return
        member_orgs = [m for m in self.memberships if m.user_id == user.id]
        if len(member_orgs) < 2:
            return
        token = f"pending_{secrets.token_hex(8)}"
        self.pending_org_selection[token] = email
        raise OrganizationSelectionRequiredError(
            "The user must choose an organization to finish their authentication.",
            pending_authentication_token=token,
            user={"id": user.id, "email": email},
            organizations=[
                {"id": m.organization_id, "name": self.orgs[m.organization_id].name}
                for m in member_orgs
                if m.organization_id in self.orgs
            ],
        )


# ---------------------------------------------------------------------------
# Cloudflare R2 fake — keeps tests hermetic, no real network calls.
# Mirrors the surface of :class:`clawbits.cloudflare.r2_s3_client.R2S3Client`
# that ``ClawBitsServer`` actually invokes (upload/download/list/delete).
# ---------------------------------------------------------------------------


class FakeR2Client:
    """In-memory R2. Keys → bytes; mimics return shapes of the real client."""

    def __init__(self, bucket: str = "fake-bucket") -> None:
        self.bucket = bucket
        self._store: dict[str, tuple[bytes, str]] = {}  # key -> (content, content_type)

    def _public_url(self, key: str) -> str:
        return f"https://share.test.invalid/{key}"

    async def upload_file(
        self, object_key: str, content: bytes, content_type: str = "application/octet-stream"
    ) -> dict[str, Any]:
        self._store[object_key] = (content, content_type)
        return {
            "success": True,
            "object_key": object_key,
            "url": self._public_url(object_key),
            "size": len(content),
            "content_type": content_type,
            "hash": hashlib.sha256(content).hexdigest(),
            "bucket": self.bucket,
        }

    async def download_file(self, object_key: str) -> tuple[bool, bytes | str]:
        if object_key in self._store:
            return True, self._store[object_key][0]
        return False, "File not found"

    async def list_files(self, prefix: str = "") -> dict[str, Any]:
        files = [
            {
                "key": key,
                "size": len(content),
                "content_type": ctype,
                "url": self._public_url(key),
            }
            for key, (content, ctype) in self._store.items()
            if key.startswith(prefix)
        ]
        return {"success": True, "files": files, "count": len(files)}

    async def delete_file(self, object_key: str) -> dict[str, Any]:
        if object_key not in self._store:
            return {"success": False, "error": "File not found", "object_key": object_key}
        del self._store[object_key]
        return {"success": True, "object_key": object_key, "message": "File deleted successfully"}


# ---------------------------------------------------------------------------
# R2 presigner fake — used by the chat-attachments endpoints. Generates
# deterministic URLs that encode the inputs, so tests can assert on URL
# shape without needing real SigV4. Mirrors the surface of
# :class:`clawbits.cloudflare.r2_presign.R2Presigner`.
# ---------------------------------------------------------------------------


class FakeR2Presigner:
    """In-memory presigner. URLs are deterministic and unsigned."""

    def __init__(self, endpoint: str = "https://fake-r2.test.invalid") -> None:
        self.endpoint = endpoint

    def presign_put(
        self,
        object_key: str,
        content_type: str,
        *,
        content_length: int,
        expires: int = 300,
    ) -> dict[str, Any]:
        return {
            "url": (
                f"{self.endpoint}/{object_key}"
                f"?X-Amz-Method=PUT&size={content_length}&expires={expires}"
            ),
            "method": "PUT",
            "headers": {"Content-Type": content_type},
            "expires_in": expires,
        }

    def presign_get(
        self,
        object_key: str,
        *,
        expires: int = 3600,
        download_filename: str | None = None,
    ) -> dict[str, Any]:
        suffix = (
            f"&filename={download_filename}" if download_filename else ""
        )
        return {
            "url": f"{self.endpoint}/{object_key}?X-Amz-Method=GET&expires={expires}{suffix}",
            "expires_in": expires,
        }
