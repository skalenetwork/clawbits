"""Tests for human chat attachments (mm_files) endpoints.

Covers the upload protocol (request URL → confirm), download URL issuance,
soft delete, and how ``file_ids`` flow through post create/read. Uses the
``FakeR2Presigner`` injected by the session fixture — generated URLs are
deterministic but otherwise opaque to the tests.
"""
from __future__ import annotations

from starlette.testclient import TestClient

from tests.fastapi._auth_helpers import (
    add_human_to_org,
    auth_headers,
    register_human,
)

# ---------------------------------------------------------------------------
# Local helpers
# ---------------------------------------------------------------------------


def _personal_org_id(tc: TestClient, token: str) -> str:
    r = tc.get("/api/human/orgs", headers=auth_headers(token))
    assert r.status_code == 200, r.text
    for org in r.json()["organizations"]:
        if org.get("is_personal"):
            return org["org_id"]
    raise AssertionError("no personal org")


def _make_channel(tc: TestClient, token: str, name: str = "general") -> str:
    org_id = _personal_org_id(tc, token)
    r = tc.post(
        "/api/human/mm/channels",
        json={"org_id": org_id, "name": name, "channel_type": "public"},
        headers=auth_headers(token),
    )
    assert r.status_code == 200, r.text
    return r.json()["channel_id"]


def _request_upload(
    tc: TestClient,
    token: str,
    channel_id: str,
    *,
    filename: str = "shot.png",
    content_type: str = "image/png",
    size_bytes: int = 1024,
    has_thumbnail: bool = False,
    thumbnail_size_bytes: int | None = None,
) -> dict:
    body: dict = {
        "filename": filename,
        "content_type": content_type,
        "size_bytes": size_bytes,
        "has_thumbnail": has_thumbnail,
    }
    # ``thumbnail_size_bytes`` is required when has_thumbnail=True. Default
    # to a sentinel value (256 B) so the bulk of the suite doesn't have to
    # spell it out when toggling has_thumbnail.
    if has_thumbnail:
        body["thumbnail_size_bytes"] = thumbnail_size_bytes or 256
    elif thumbnail_size_bytes is not None:
        body["thumbnail_size_bytes"] = thumbnail_size_bytes
    r = tc.post(
        f"/api/human/mm/channels/{channel_id}/files",
        json=body,
        headers=auth_headers(token),
    )
    assert r.status_code == 200, r.text
    return r.json()


def _confirm_upload(
    tc: TestClient,
    token: str,
    file_id: str,
    *,
    width: int | None = None,
    height: int | None = None,
    thumbnail_uploaded: bool = False,
) -> dict:
    body: dict = {"thumbnail_uploaded": thumbnail_uploaded}
    if width is not None:
        body["width"] = width
    if height is not None:
        body["height"] = height
    r = tc.post(
        f"/api/human/mm/files/{file_id}/confirm",
        json=body,
        headers=auth_headers(token),
    )
    assert r.status_code == 200, r.text
    return r.json()


# ---------------------------------------------------------------------------
# Upload URL issuance
# ---------------------------------------------------------------------------


def test_request_upload_url_happy_path(test_client):
    reg = register_human(test_client, "alice@test.com")
    cid = _make_channel(test_client, reg["access_token"], "files-1")
    out = _request_upload(test_client, reg["access_token"], cid)

    assert out["file_id"]
    assert out["upload_url"].startswith("https://fake-r2.test.invalid/")
    assert out["upload_headers"]["Content-Type"] == "image/png"
    assert out["upload_expires_in"] == 300
    # Object key embeds the file_id so a leaked partial key can't enumerate.
    assert out["file_id"] in out["object_key"]
    assert out["object_key"].startswith("mm/files/")
    assert out["object_key"].endswith("/original/shot.png")
    assert out["thumbnail_upload_url"] is None


def test_request_upload_url_with_thumbnail(test_client):
    reg = register_human(test_client, "bob@test.com")
    cid = _make_channel(test_client, reg["access_token"], "files-2")
    out = _request_upload(
        test_client, reg["access_token"], cid, has_thumbnail=True
    )
    assert out["thumbnail_upload_url"] is not None
    assert out["thumbnail_upload_headers"]["Content-Type"] == "image/jpeg"
    assert out["thumbnail_object_key"].endswith("/thumb-1024.jpg")


def test_request_upload_url_too_large(test_client):
    reg = register_human(test_client, "carol@test.com")
    cid = _make_channel(test_client, reg["access_token"], "files-3")
    r = test_client.post(
        f"/api/human/mm/channels/{cid}/files",
        json={
            "filename": "huge.bin",
            "content_type": "application/octet-stream",
            "size_bytes": 99 * 1024 * 1024,  # 99 MB, default cap is 15 MB
        },
        headers=auth_headers(reg["access_token"]),
    )
    assert r.status_code == 413, r.text


def test_request_upload_url_bad_mime(test_client):
    reg = register_human(test_client, "dave@test.com")
    cid = _make_channel(test_client, reg["access_token"], "files-4")
    r = test_client.post(
        f"/api/human/mm/channels/{cid}/files",
        json={
            "filename": "evil.exe",
            "content_type": "application/x-msdownload",
            "size_bytes": 1024,
        },
        headers=auth_headers(reg["access_token"]),
    )
    assert r.status_code == 415, r.text


def test_request_upload_resolves_type_from_extension(test_client):
    # Pickers hand back ``application/octet-stream`` for anything but media;
    # the server names the file from its extension instead of rejecting it.
    reg = register_human(test_client, "doc@test.com")
    cid = _make_channel(test_client, reg["access_token"], "files-4b")
    for filename, expected in (
        ("report.docx", "application/vnd.openxmlformats-officedocument"
                        ".wordprocessingml.document"),
        ("legacy.doc", "application/msword"),
        ("sheet.xlsx", "application/vnd.openxmlformats-officedocument"
                       ".spreadsheetml.sheet"),
        ("app.tsx", "text/plain"),
        ("bundle.tar.gz", "application/gzip"),
    ):
        out = _request_upload(
            test_client,
            reg["access_token"],
            cid,
            filename=filename,
            content_type="application/octet-stream",
        )
        assert out["upload_headers"]["Content-Type"] == expected, filename


def test_request_upload_url_not_member(test_client):
    # Alice creates the channel; Eve (not a member) tries to upload.
    alice = register_human(test_client, "alice2@test.com")
    eve = register_human(test_client, "eve@test.com")
    cid = _make_channel(test_client, alice["access_token"], "files-5")
    r = test_client.post(
        f"/api/human/mm/channels/{cid}/files",
        json={
            "filename": "hi.png",
            "content_type": "image/png",
            "size_bytes": 1024,
        },
        headers=auth_headers(eve["access_token"]),
    )
    assert r.status_code == 403


# ---------------------------------------------------------------------------
# Confirm upload
# ---------------------------------------------------------------------------


def test_confirm_file_success(test_client):
    reg = register_human(test_client, "alice3@test.com")
    cid = _make_channel(test_client, reg["access_token"], "files-conf-1")
    up = _request_upload(test_client, reg["access_token"], cid)
    out = _confirm_upload(
        test_client, reg["access_token"], up["file_id"], width=800, height=600
    )
    assert out["status"] == "uploaded"
    assert out["uploaded_at"]
    assert out["width"] == 800
    assert out["height"] == 600


def test_confirm_file_wrong_owner(test_client):
    alice = register_human(test_client, "alice4@test.com")
    bob = register_human(test_client, "bob4@test.com")
    cid = _make_channel(test_client, alice["access_token"], "files-conf-2")
    up = _request_upload(test_client, alice["access_token"], cid)
    r = test_client.post(
        f"/api/human/mm/files/{up['file_id']}/confirm",
        json={},
        headers=auth_headers(bob["access_token"]),
    )
    assert r.status_code == 400, r.text


def test_confirm_file_idempotent(test_client):
    reg = register_human(test_client, "alice5@test.com")
    cid = _make_channel(test_client, reg["access_token"], "files-conf-3")
    up = _request_upload(test_client, reg["access_token"], cid)
    first = _confirm_upload(test_client, reg["access_token"], up["file_id"])
    second = _confirm_upload(test_client, reg["access_token"], up["file_id"])
    assert first["status"] == "uploaded"
    assert second["status"] == "uploaded"
    assert first["uploaded_at"] == second["uploaded_at"]


# ---------------------------------------------------------------------------
# Download URL
# ---------------------------------------------------------------------------


def test_download_url_success(test_client):
    reg = register_human(test_client, "alice6@test.com")
    cid = _make_channel(test_client, reg["access_token"], "files-dl-1")
    up = _request_upload(test_client, reg["access_token"], cid)
    _confirm_upload(test_client, reg["access_token"], up["file_id"])
    r = test_client.get(
        f"/api/human/mm/files/{up['file_id']}/url",
        headers=auth_headers(reg["access_token"]),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["url"].startswith("https://fake-r2.test.invalid/")
    assert "X-Amz-Method=GET" in body["url"]
    assert body["expires_in"] == 3600


def test_download_url_non_member_forbidden(test_client):
    alice = register_human(test_client, "alice7@test.com")
    eve = register_human(test_client, "eve7@test.com")
    cid = _make_channel(test_client, alice["access_token"], "files-dl-2")
    up = _request_upload(test_client, alice["access_token"], cid)
    _confirm_upload(test_client, alice["access_token"], up["file_id"])
    r = test_client.get(
        f"/api/human/mm/files/{up['file_id']}/url",
        headers=auth_headers(eve["access_token"]),
    )
    assert r.status_code == 403


def test_download_url_pending_returns_409(test_client):
    reg = register_human(test_client, "alice8@test.com")
    cid = _make_channel(test_client, reg["access_token"], "files-dl-3")
    up = _request_upload(test_client, reg["access_token"], cid)
    # Skip confirm — file is still pending.
    r = test_client.get(
        f"/api/human/mm/files/{up['file_id']}/url",
        headers=auth_headers(reg["access_token"]),
    )
    assert r.status_code == 409


def test_download_url_deleted_returns_404(test_client):
    reg = register_human(test_client, "alice9@test.com")
    cid = _make_channel(test_client, reg["access_token"], "files-dl-4")
    up = _request_upload(test_client, reg["access_token"], cid)
    _confirm_upload(test_client, reg["access_token"], up["file_id"])
    r = test_client.delete(
        f"/api/human/mm/files/{up['file_id']}",
        headers=auth_headers(reg["access_token"]),
    )
    assert r.status_code == 204
    r = test_client.get(
        f"/api/human/mm/files/{up['file_id']}/url",
        headers=auth_headers(reg["access_token"]),
    )
    assert r.status_code == 404


# ---------------------------------------------------------------------------
# Delete
# ---------------------------------------------------------------------------


def test_delete_file_owner(test_client):
    reg = register_human(test_client, "alice10@test.com")
    cid = _make_channel(test_client, reg["access_token"], "files-del-1")
    up = _request_upload(test_client, reg["access_token"], cid)
    r = test_client.delete(
        f"/api/human/mm/files/{up['file_id']}",
        headers=auth_headers(reg["access_token"]),
    )
    assert r.status_code == 204


def test_delete_file_other_user_returns_404(test_client):
    alice = register_human(test_client, "alice11@test.com")
    bob = register_human(test_client, "bob11@test.com")
    cid = _make_channel(test_client, alice["access_token"], "files-del-2")
    up = _request_upload(test_client, alice["access_token"], cid)
    r = test_client.delete(
        f"/api/human/mm/files/{up['file_id']}",
        headers=auth_headers(bob["access_token"]),
    )
    assert r.status_code == 404


# ---------------------------------------------------------------------------
# Attach files to posts
# ---------------------------------------------------------------------------


def test_post_create_with_files_attaches(test_client):
    reg = register_human(test_client, "alice12@test.com")
    cid = _make_channel(test_client, reg["access_token"], "files-post-1")
    up = _request_upload(
        test_client, reg["access_token"], cid,
        filename="pic.png", content_type="image/png",
    )
    _confirm_upload(
        test_client, reg["access_token"], up["file_id"], width=800, height=600
    )

    r = test_client.post(
        f"/api/human/mm/channels/{cid}/posts",
        json={"message": "look at this", "file_ids": [up["file_id"]]},
        headers=auth_headers(reg["access_token"]),
    )
    assert r.status_code == 200, r.text
    post = r.json()
    assert len(post["files"]) == 1
    f = post["files"][0]
    assert f["file_id"] == up["file_id"]
    assert f["filename"] == "pic.png"
    assert f["width"] == 800
    # Image files get an inline download URL so <img src> works without
    # a second round trip.
    assert f["download_url"] is not None
    assert "X-Amz-Method=GET" in f["download_url"]


def test_post_create_with_non_image_file_no_inline_url(test_client):
    reg = register_human(test_client, "alice13@test.com")
    cid = _make_channel(test_client, reg["access_token"], "files-post-2")
    up = _request_upload(
        test_client, reg["access_token"], cid,
        filename="doc.pdf", content_type="application/pdf",
    )
    _confirm_upload(test_client, reg["access_token"], up["file_id"])
    r = test_client.post(
        f"/api/human/mm/channels/{cid}/posts",
        json={"message": "doc", "file_ids": [up["file_id"]]},
        headers=auth_headers(reg["access_token"]),
    )
    assert r.status_code == 200, r.text
    post = r.json()
    f = post["files"][0]
    assert f["content_type"] == "application/pdf"
    # Non-image files don't get an inline URL — the client requests one
    # on demand via /files/{id}/url.
    assert f["download_url"] is None


def test_post_create_files_only_no_message(test_client):
    """A post with files but no message is valid (file-only post)."""
    reg = register_human(test_client, "alice14@test.com")
    cid = _make_channel(test_client, reg["access_token"], "files-post-3")
    up = _request_upload(test_client, reg["access_token"], cid)
    _confirm_upload(test_client, reg["access_token"], up["file_id"])
    r = test_client.post(
        f"/api/human/mm/channels/{cid}/posts",
        json={"file_ids": [up["file_id"]]},
        headers=auth_headers(reg["access_token"]),
    )
    assert r.status_code == 200, r.text
    assert r.json()["message"] == ""


def test_post_create_rejects_unowned_files(test_client):
    alice = register_human(test_client, "alice15@test.com")
    bob = register_human(test_client, "bob15@test.com")
    cid = _make_channel(test_client, alice["access_token"], "files-post-4")
    add_human_to_org(
        test_client,
        alice["access_token"],
        _personal_org_id(test_client, alice["access_token"]),
        "bob15@test.com",
    )
    # Add bob to alice's channel so he can post there.
    test_client.post(
        f"/api/human/mm/channels/{cid}/members",
        json={"member_id": str(bob["user"]["id"]), "member_type": "human"},
        headers=auth_headers(alice["access_token"]),
    )
    up = _request_upload(test_client, alice["access_token"], cid)
    _confirm_upload(test_client, alice["access_token"], up["file_id"])
    # Bob tries to attach alice's file to his own post.
    r = test_client.post(
        f"/api/human/mm/channels/{cid}/posts",
        json={"message": "stolen", "file_ids": [up["file_id"]]},
        headers=auth_headers(bob["access_token"]),
    )
    assert r.status_code == 400


def test_post_create_rejects_pending_file(test_client):
    """File must be confirmed before it can be attached."""
    reg = register_human(test_client, "alice16@test.com")
    cid = _make_channel(test_client, reg["access_token"], "files-post-5")
    up = _request_upload(test_client, reg["access_token"], cid)
    # Skip confirm.
    r = test_client.post(
        f"/api/human/mm/channels/{cid}/posts",
        json={"message": "premature", "file_ids": [up["file_id"]]},
        headers=auth_headers(reg["access_token"]),
    )
    assert r.status_code == 400


def test_post_create_rejects_double_attach(test_client):
    reg = register_human(test_client, "alice17@test.com")
    cid = _make_channel(test_client, reg["access_token"], "files-post-6")
    up = _request_upload(test_client, reg["access_token"], cid)
    _confirm_upload(test_client, reg["access_token"], up["file_id"])
    r = test_client.post(
        f"/api/human/mm/channels/{cid}/posts",
        json={"message": "first", "file_ids": [up["file_id"]]},
        headers=auth_headers(reg["access_token"]),
    )
    assert r.status_code == 200
    # Same file_id again — already attached to the previous post.
    r = test_client.post(
        f"/api/human/mm/channels/{cid}/posts",
        json={"message": "second", "file_ids": [up["file_id"]]},
        headers=auth_headers(reg["access_token"]),
    )
    assert r.status_code == 400


def test_post_create_rejects_too_many_files(test_client):
    reg = register_human(test_client, "alice18@test.com")
    cid = _make_channel(test_client, reg["access_token"], "files-post-7")
    # Default cap is 5. Upload 6 files.
    file_ids = []
    for i in range(6):
        up = _request_upload(
            test_client, reg["access_token"], cid,
            filename=f"f{i}.png",
        )
        _confirm_upload(test_client, reg["access_token"], up["file_id"])
        file_ids.append(up["file_id"])
    r = test_client.post(
        f"/api/human/mm/channels/{cid}/posts",
        json={"message": "many", "file_ids": file_ids},
        headers=auth_headers(reg["access_token"]),
    )
    assert r.status_code == 400


def test_post_create_rejects_file_from_other_channel(test_client):
    reg = register_human(test_client, "alice19@test.com")
    cid_a = _make_channel(test_client, reg["access_token"], "files-cross-a")
    cid_b = _make_channel(test_client, reg["access_token"], "files-cross-b")
    up = _request_upload(test_client, reg["access_token"], cid_a)
    _confirm_upload(test_client, reg["access_token"], up["file_id"])
    # Try to attach a file uploaded to channel A inside a post in channel B.
    r = test_client.post(
        f"/api/human/mm/channels/{cid_b}/posts",
        json={"message": "wrong channel", "file_ids": [up["file_id"]]},
        headers=auth_headers(reg["access_token"]),
    )
    assert r.status_code == 400


# ---------------------------------------------------------------------------
# Read path — files appear in list
# ---------------------------------------------------------------------------


def test_post_list_includes_files(test_client):
    reg = register_human(test_client, "alice20@test.com")
    cid = _make_channel(test_client, reg["access_token"], "files-list-1")
    up = _request_upload(test_client, reg["access_token"], cid)
    _confirm_upload(test_client, reg["access_token"], up["file_id"])
    test_client.post(
        f"/api/human/mm/channels/{cid}/posts",
        json={"message": "hi", "file_ids": [up["file_id"]]},
        headers=auth_headers(reg["access_token"]),
    )
    r = test_client.get(
        f"/api/human/mm/channels/{cid}/posts",
        headers=auth_headers(reg["access_token"]),
    )
    assert r.status_code == 200, r.text
    posts = r.json()["posts"]
    assert len(posts) == 1
    assert len(posts[0]["files"]) == 1
    assert posts[0]["files"][0]["download_url"] is not None


# ---------------------------------------------------------------------------
# Channel attachments listing (the Attachments sidebar / Media-Files tabs)
# ---------------------------------------------------------------------------


def test_channel_attachments_listing_surfaces_uploader_and_post(test_client):
    """The /attachments history listing returns the file with its uploader
    and source post_id — the fields the web Attachments sidebar relies on to
    show attribution and (later) jump back to the message."""
    reg = register_human(test_client, "alice21@test.com")
    token = reg["access_token"]
    cid = _make_channel(test_client, token, "attach-list-1")
    up = _request_upload(test_client, token, cid)
    _confirm_upload(test_client, token, up["file_id"])
    post = test_client.post(
        f"/api/human/mm/channels/{cid}/posts",
        json={"message": "with image", "file_ids": [up["file_id"]]},
        headers=auth_headers(token),
    ).json()

    r = test_client.get(
        f"/api/human/mm/channels/{cid}/attachments?kind=image",
        headers=auth_headers(token),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["has_more"] is False
    assert len(body["files"]) == 1
    f = body["files"][0]
    assert f["file_id"] == up["file_id"]
    # Images are eagerly presigned in the listing response.
    assert f["download_url"] is not None
    # New attribution fields.
    assert f["post_id"] == post["post_id"]
    assert f["uploader_human_id"] is not None
    assert f["uploader_agent_id"] is None


def test_channel_attachments_kind_filter_excludes_non_matching(test_client):
    """``kind=file`` returns non-media uploads only; an image posted to the
    same channel must not leak into the Files tab."""
    reg = register_human(test_client, "alice22@test.com")
    token = reg["access_token"]
    cid = _make_channel(test_client, token, "attach-list-2")

    img = _request_upload(test_client, token, cid, filename="pic.png", content_type="image/png")
    _confirm_upload(test_client, token, img["file_id"])
    pdf = _request_upload(
        test_client, token, cid, filename="doc.pdf", content_type="application/pdf"
    )
    _confirm_upload(test_client, token, pdf["file_id"])
    test_client.post(
        f"/api/human/mm/channels/{cid}/posts",
        json={"message": "two files", "file_ids": [img["file_id"], pdf["file_id"]]},
        headers=auth_headers(token),
    )

    r = test_client.get(
        f"/api/human/mm/channels/{cid}/attachments?kind=file",
        headers=auth_headers(token),
    )
    assert r.status_code == 200, r.text
    files = r.json()["files"]
    assert [f["file_id"] for f in files] == [pdf["file_id"]]
    # Non-image listing rows carry no eager download_url (fetched on demand).
    assert files[0]["download_url"] is None


def test_confirm_probe_preserves_thumbnail_key(test_client, monkeypatch):
    """The probe's metadata write-back must not clobber a confirmed thumbnail.

    Regression (same as the agent-route twin in test_mattermost_files):
    the write-back used to call ``confirm_mm_file`` with the old
    ``thumbnail_uploaded=False`` default, nulling the just-confirmed key.
    """

    async def _fake_probe(presigner, object_key):
        return (512, 384)

    monkeypatch.setattr(
        "clawbits.fastapi.human_mm_endpoints.probe_image_dimensions", _fake_probe
    )
    reg = register_human(test_client, "thumbkeeper@test.com")
    token = reg["access_token"]
    cid = _make_channel(test_client, token, "thumb-probe")
    out = _request_upload(test_client, token, cid, has_thumbnail=True)
    confirmed = _confirm_upload(
        test_client, token, out["file_id"], thumbnail_uploaded=True
    )
    assert confirmed["width"] == 512
    assert confirmed["height"] == 384

    from sqlmodel import Session

    from clawbits.db.models import MmFile

    with Session(test_client.app._engine) as db:
        row = db.get(MmFile, out["file_id"])
        assert row is not None
        assert row.status == "uploaded"
        assert row.thumbnail_object_key is not None
        assert row.thumbnail_object_key.endswith("thumb-1024.jpg")
