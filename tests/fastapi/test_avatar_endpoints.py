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

from tests.fastapi._auth_helpers import login_human


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
    monkeypatch.setattr(_ep, "upload_user_avatar_to_r2", _noop_upload)
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
