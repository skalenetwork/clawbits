"""HTTP tests for the user-avatar upload + reset endpoints.

The happy-path tests stub out the R2 upload + DiceBear regenerate so
the suite stays hermetic — CI has no ``CLOUDFLARE_*`` credentials,
and we don't want unit tests reaching ``api.dicebear.com``. The stubs
replace the two outbound calls the endpoint makes at the module
level; the rest of the endpoint logic (auth, validation, version
bump, response shape) runs unchanged.
"""
from __future__ import annotations

from io import BytesIO

import pytest
from PIL import Image
from starlette.testclient import TestClient

from tests.fastapi._auth_helpers import add_human_to_org, auth_headers, login_human


@pytest.fixture(autouse=True)
def _stub_r2(monkeypatch):
    """Replace the two R2/DiceBear-touching calls with async no-ops.

    Patching at the endpoint-module level (rather than at
    ``clawbits.avatars.upload``) means the import the route handler
    actually resolved at boot is the one we override. Without this
    fixture, the upload endpoint constructs a real
    :class:`R2S3Client` and crashes on missing
    ``CLOUDFLARE_ACCOUNT_ID`` in CI.
    """

    async def _noop_upload(**_kwargs):
        return None

    async def _noop_ensure(_r2, **_kwargs):
        return ""

    import clawbits.fastapi.avatar_endpoints as _ep
    monkeypatch.setattr(_ep, "upload_avatar_to_r2", _noop_upload)
    monkeypatch.setattr(_ep, "ensure_user_avatar", _noop_ensure)
    # The reset endpoint also builds a fresh R2 client to pass to
    # ``ensure_user_avatar``. Construction touches Cloudflare env;
    # short-circuit it to a sentinel so the no-op above doesn't care.
    monkeypatch.setattr(_ep, "make_avatars_r2_client", lambda: None)


def _png_bytes(*, size: tuple[int, int] = (300, 300)) -> bytes:
    """Synthesise a small PNG body for the multipart upload."""
    img = Image.new("RGB", size, (180, 50, 80))
    buf = BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def test_upload_my_avatar_happy_path(test_client: TestClient):
    _, _user = login_human(test_client, "upload@avatar-test.com")

    resp = test_client.post(
        "/api/human/avatars/users/me/upload",
        files={"file": ("me.png", _png_bytes(), "image/png")},
    )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["kind"] == "uploaded"
    # Custom avatars land at .webp regardless of upload format.
    assert body["url"].endswith(".webp")
    # Version is bumped above the current generation so a stale cached
    # generated URL is invalidated.
    assert isinstance(body["version"], int)
    assert body["version"] >= 2


def test_upload_then_reset_round_trip(test_client: TestClient):
    _, _user = login_human(test_client, "reset@avatar-test.com")

    up = test_client.post(
        "/api/human/avatars/users/me/upload",
        files={"file": ("me.png", _png_bytes(), "image/png")},
    )
    assert up.status_code == 200, up.text
    uploaded = up.json()

    reset = test_client.delete("/api/human/avatars/users/me")
    assert reset.status_code == 200, reset.text
    body = reset.json()

    # Back to generated, version bumped past the upload version so the
    # CDN-cached uploaded URL doesn't resolve again.
    assert body["kind"] == "generated"
    assert body["version"] > uploaded["version"]
    assert body["url"].endswith(".svg")


def test_upload_rejects_unsupported_content_type(test_client: TestClient):
    _, _user = login_human(test_client, "bad-ctype@avatar-test.com")

    resp = test_client.post(
        "/api/human/avatars/users/me/upload",
        files={"file": ("evil.svg", b"<svg/>", "image/svg+xml")},
    )
    assert resp.status_code == 415, resp.text


def test_upload_rejects_oversize_file(test_client: TestClient):
    _, _user = login_human(test_client, "huge@avatar-test.com")

    # 6MB of zeroes — well above the 5MB cap. Content-type is permitted
    # so we know the 413 comes from the size check, not the type check.
    payload = b"\x00" * (6 * 1024 * 1024)
    resp = test_client.post(
        "/api/human/avatars/users/me/upload",
        files={"file": ("huge.png", payload, "image/png")},
    )
    assert resp.status_code == 413, resp.text


def test_upload_rejects_empty_file(test_client: TestClient):
    _, _user = login_human(test_client, "empty@avatar-test.com")

    resp = test_client.post(
        "/api/human/avatars/users/me/upload",
        files={"file": ("empty.png", b"", "image/png")},
    )
    assert resp.status_code == 400, resp.text


def test_upload_rejects_malformed_image(test_client: TestClient):
    _, _user = login_human(test_client, "garbage@avatar-test.com")

    resp = test_client.post(
        "/api/human/avatars/users/me/upload",
        files={"file": ("bad.png", b"not actually a png", "image/png")},
    )
    assert resp.status_code == 400, resp.text


def test_upload_requires_authentication(test_client: TestClient):
    # No cookie / no Bearer → 401.
    test_client.cookies.clear()
    resp = test_client.post(
        "/api/human/avatars/users/me/upload",
        files={"file": ("me.png", _png_bytes(), "image/png")},
    )
    assert resp.status_code == 401, resp.text


def test_reset_requires_authentication(test_client: TestClient):
    test_client.cookies.clear()
    resp = test_client.delete("/api/human/avatars/users/me")
    assert resp.status_code == 401, resp.text


def _team_org(tc: TestClient, token: str, name: str) -> str:
    resp = tc.post("/api/human/orgs", json={"name": name}, headers=auth_headers(token))
    assert resp.status_code == 200, resp.text
    return resp.json()["org_id"]


def test_org_avatar_upload_then_remove(test_client: TestClient):
    token, _ = login_human(test_client, "org-owner@avatar-test.com")
    org_id = _team_org(test_client, token, "avatar-team")
    headers = auth_headers(token)

    up = test_client.post(
        f"/api/human/avatars/orgs/{org_id}/upload",
        files={"file": ("org.png", _png_bytes(), "image/png")},
        headers=headers,
    )
    assert up.status_code == 200, up.text
    assert up.json()["url"].endswith(f"/avatars/orgs/{org_id}/v1.webp")
    assert test_client.get(f"/api/human/orgs/{org_id}", headers=headers).json()["avatar"] == up.json()

    removed = test_client.delete(f"/api/human/avatars/orgs/{org_id}", headers=headers)
    assert removed.status_code == 204, removed.text
    assert test_client.get(f"/api/human/orgs/{org_id}", headers=headers).json()["avatar"] is None


def test_org_avatar_and_rename_are_admin_only(test_client: TestClient):
    owner_token, _ = login_human(test_client, "org-admin@avatar-test.com")
    org_id = _team_org(test_client, owner_token, "avatar-admins")
    member_token, _ = login_human(test_client, "org-member@avatar-test.com")
    add_human_to_org(test_client, owner_token, org_id, "org-member@avatar-test.com")
    headers = auth_headers(member_token)

    upload = test_client.post(
        f"/api/human/avatars/orgs/{org_id}/upload",
        files={"file": ("org.png", _png_bytes(), "image/png")},
        headers=headers,
    )
    assert upload.status_code == 403, upload.text
    assert test_client.delete(f"/api/human/avatars/orgs/{org_id}", headers=headers).status_code == 403
    rename = test_client.patch(f"/api/human/orgs/{org_id}", json={"display_name": "Nope"}, headers=headers)
    assert rename.status_code == 403, rename.text


def test_org_rename(test_client: TestClient):
    token, _ = login_human(test_client, "org-rename@avatar-test.com")
    org_id = _team_org(test_client, token, "rename-team")
    headers = auth_headers(token)

    resp = test_client.patch(f"/api/human/orgs/{org_id}", json={"display_name": "  Acme Inc.  "}, headers=headers)
    assert resp.status_code == 200, resp.text
    assert resp.json()["display_name"] == "Acme Inc."

    blank = test_client.patch(f"/api/human/orgs/{org_id}", json={"display_name": "   "}, headers=headers)
    assert blank.status_code == 422, blank.text
