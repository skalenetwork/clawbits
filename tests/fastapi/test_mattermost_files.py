"""Tests for agent chat-attachment endpoints (mm_files, agent surface).

Mirrors :mod:`tests.fastapi.test_human_mm_files` but exercises the agent
routes under ``/api/agentic/mm/...``. Covers the upload protocol
(request URL → confirm), download URL issuance, soft delete, and how
``file_ids`` flow through agent post create / list. Uses the
``FakeR2Presigner`` injected by the session fixture — generated URLs
are deterministic but otherwise opaque to the tests.
"""
from __future__ import annotations

from starlette.testclient import TestClient

from tests.fastapi.test_mattermost import (
    _auth,
    _create_owned_agent,
    _write_headers,
)

# ---------------------------------------------------------------------------
# Local helpers
# ---------------------------------------------------------------------------


def _default_channel_id(tc: TestClient, agent: dict) -> str:
    r = tc.get(
        f"/api/agentic/mm/teams/{agent['agent_id']}/default-channel",
        headers=_auth(agent["api_key"]),
    )
    assert r.status_code == 200, r.text
    return r.json()["channel_id"]


def _request_upload(
    tc: TestClient,
    agent: dict,
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
    if has_thumbnail:
        body["thumbnail_size_bytes"] = thumbnail_size_bytes or 256
    elif thumbnail_size_bytes is not None:
        body["thumbnail_size_bytes"] = thumbnail_size_bytes
    r = tc.post(
        f"/api/agentic/mm/channels/{channel_id}/files",
        json=body,
        headers=_auth(agent["api_key"]),
    )
    assert r.status_code == 200, r.text
    return r.json()


def _confirm_upload(
    tc: TestClient,
    agent: dict,
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
        f"/api/agentic/mm/files/{file_id}/confirm",
        json=body,
        headers=_auth(agent["api_key"]),
    )
    assert r.status_code == 200, r.text
    return r.json()


# ---------------------------------------------------------------------------
# Upload URL issuance
# ---------------------------------------------------------------------------


def test_request_upload_url_happy_path(test_client):
    agent = _create_owned_agent(test_client)
    cid = _default_channel_id(test_client, agent)
    out = _request_upload(test_client, agent, cid)

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
    agent = _create_owned_agent(test_client)
    cid = _default_channel_id(test_client, agent)
    out = _request_upload(
        test_client, agent, cid, has_thumbnail=True, thumbnail_size_bytes=512,
    )
    assert out["thumbnail_upload_url"] is not None
    assert "thumb-1024.jpg" in out["thumbnail_upload_url"]
    assert out["thumbnail_upload_headers"]["Content-Type"] == "image/jpeg"
    assert out["thumbnail_object_key"] is not None


def test_request_upload_url_oversize_rejected(test_client):
    agent = _create_owned_agent(test_client)
    cid = _default_channel_id(test_client, agent)
    r = test_client.post(
        f"/api/agentic/mm/channels/{cid}/files",
        json={
            "filename": "big.bin",
            "content_type": "application/zip",
            "size_bytes": 100 * 1024 * 1024,  # 100 MB > 15 MB default cap
            "has_thumbnail": False,
        },
        headers=_auth(agent["api_key"]),
    )
    assert r.status_code == 413, r.text


def test_request_upload_url_disallowed_mime(test_client):
    agent = _create_owned_agent(test_client)
    cid = _default_channel_id(test_client, agent)
    r = test_client.post(
        f"/api/agentic/mm/channels/{cid}/files",
        json={
            "filename": "bad.exe",
            "content_type": "application/x-msdownload",
            "size_bytes": 1024,
            "has_thumbnail": False,
        },
        headers=_auth(agent["api_key"]),
    )
    assert r.status_code == 415, r.text


def test_request_upload_non_member_forbidden(test_client):
    """An agent that isn't a channel member can't request an upload URL."""
    owner = _create_owned_agent(test_client)
    intruder = _create_owned_agent(test_client)
    # The owner's default channel doesn't include the intruder.
    cid = _default_channel_id(test_client, owner)
    r = test_client.post(
        f"/api/agentic/mm/channels/{cid}/files",
        json={
            "filename": "x.png",
            "content_type": "image/png",
            "size_bytes": 100,
            "has_thumbnail": False,
        },
        headers=_auth(intruder["api_key"]),
    )
    assert r.status_code == 403, r.text


# ---------------------------------------------------------------------------
# Confirm
# ---------------------------------------------------------------------------


def test_confirm_upload_marks_uploaded_and_returns_metadata(test_client):
    agent = _create_owned_agent(test_client)
    cid = _default_channel_id(test_client, agent)
    out = _request_upload(test_client, agent, cid)
    confirmed = _confirm_upload(
        test_client, agent, out["file_id"], width=400, height=300,
    )
    assert confirmed["file_id"] == out["file_id"]
    assert confirmed["status"] == "uploaded"
    assert confirmed["width"] == 400
    assert confirmed["height"] == 300
    # The confirm response intentionally omits the inline download URL —
    # the client just uploaded the bytes; no need to round-trip back.
    assert confirmed.get("download_url") is None


def test_confirm_upload_other_agent_rejected(test_client):
    """A different agent can't confirm someone else's upload."""
    owner = _create_owned_agent(test_client)
    intruder = _create_owned_agent(test_client)
    cid = _default_channel_id(test_client, owner)
    out = _request_upload(test_client, owner, cid)
    r = test_client.post(
        f"/api/agentic/mm/files/{out['file_id']}/confirm",
        json={"thumbnail_uploaded": False},
        headers=_auth(intruder["api_key"]),
    )
    assert r.status_code == 400, r.text


# ---------------------------------------------------------------------------
# Download URL
# ---------------------------------------------------------------------------


def test_download_url_for_attached_file(test_client):
    agent = _create_owned_agent(test_client)
    cid = _default_channel_id(test_client, agent)
    out = _request_upload(test_client, agent, cid)
    _confirm_upload(test_client, agent, out["file_id"])

    # Attach the file to a post so authz passes (channel-scoped read).
    r = test_client.post(
        f"/api/agentic/mm/channels/{cid}/posts",
        json={"message": "with file", "file_ids": [out["file_id"]]},
        headers=_write_headers(test_client, agent["api_key"]),
    )
    assert r.status_code == 200, r.text

    r = test_client.get(
        f"/api/agentic/mm/files/{out['file_id']}/url",
        headers=_auth(agent["api_key"]),
    )
    assert r.status_code == 200, r.text
    payload = r.json()
    assert payload["url"].startswith("https://fake-r2.test.invalid/")
    assert "X-Amz-Method=GET" in payload["url"]
    assert payload["expires_in"] >= 60


def test_download_url_for_pending_file_409(test_client):
    """Trying to download a file that hasn't been confirmed yet returns 409."""
    agent = _create_owned_agent(test_client)
    cid = _default_channel_id(test_client, agent)
    out = _request_upload(test_client, agent, cid)
    # Skip confirm — file stays in `pending` state.
    r = test_client.get(
        f"/api/agentic/mm/files/{out['file_id']}/url",
        headers=_auth(agent["api_key"]),
    )
    assert r.status_code == 409, r.text


def test_download_url_non_member_forbidden(test_client):
    """A non-member of the channel can't get a download URL for its files."""
    owner = _create_owned_agent(test_client)
    intruder = _create_owned_agent(test_client)
    cid = _default_channel_id(test_client, owner)
    out = _request_upload(test_client, owner, cid)
    _confirm_upload(test_client, owner, out["file_id"])
    r = test_client.get(
        f"/api/agentic/mm/files/{out['file_id']}/url",
        headers=_auth(intruder["api_key"]),
    )
    assert r.status_code == 403, r.text


def test_download_url_missing_file_404(test_client):
    agent = _create_owned_agent(test_client)
    r = test_client.get(
        "/api/agentic/mm/files/no-such-file-id/url",
        headers=_auth(agent["api_key"]),
    )
    assert r.status_code == 404, r.text


# ---------------------------------------------------------------------------
# Soft delete
# ---------------------------------------------------------------------------


def test_soft_delete_owned_file(test_client):
    agent = _create_owned_agent(test_client)
    cid = _default_channel_id(test_client, agent)
    out = _request_upload(test_client, agent, cid)
    _confirm_upload(test_client, agent, out["file_id"])

    r = test_client.delete(
        f"/api/agentic/mm/files/{out['file_id']}",
        headers=_auth(agent["api_key"]),
    )
    assert r.status_code == 204, r.text

    # After delete: the file is treated as if it doesn't exist (404).
    r = test_client.get(
        f"/api/agentic/mm/files/{out['file_id']}/url",
        headers=_auth(agent["api_key"]),
    )
    assert r.status_code == 404, r.text


def test_soft_delete_other_agents_file_404(test_client):
    """Deleting a file owned by another agent returns 404 (not 403)."""
    owner = _create_owned_agent(test_client)
    intruder = _create_owned_agent(test_client)
    cid = _default_channel_id(test_client, owner)
    out = _request_upload(test_client, owner, cid)
    _confirm_upload(test_client, owner, out["file_id"])
    r = test_client.delete(
        f"/api/agentic/mm/files/{out['file_id']}",
        headers=_auth(intruder["api_key"]),
    )
    assert r.status_code == 404, r.text


# ---------------------------------------------------------------------------
# Posts with file_ids
# ---------------------------------------------------------------------------


def test_post_with_file_ids_attaches_and_inlines_image_url(test_client):
    agent = _create_owned_agent(test_client)
    cid = _default_channel_id(test_client, agent)
    out = _request_upload(test_client, agent, cid)
    _confirm_upload(test_client, agent, out["file_id"], width=10, height=10)

    r = test_client.post(
        f"/api/agentic/mm/channels/{cid}/posts",
        json={"message": "look", "file_ids": [out["file_id"]]},
        headers=_write_headers(test_client, agent["api_key"]),
    )
    assert r.status_code == 200, r.text
    post = r.json()
    assert len(post["files"]) == 1
    f = post["files"][0]
    assert f["file_id"] == out["file_id"]
    assert f["status"] == "uploaded"
    # Image content type → inline presigned download URL on create.
    assert f["download_url"] is not None
    assert "X-Amz-Method=GET" in f["download_url"]


def test_post_files_appear_in_list(test_client):
    agent = _create_owned_agent(test_client)
    cid = _default_channel_id(test_client, agent)
    out = _request_upload(test_client, agent, cid)
    _confirm_upload(test_client, agent, out["file_id"], width=10, height=10)
    test_client.post(
        f"/api/agentic/mm/channels/{cid}/posts",
        json={"message": "img", "file_ids": [out["file_id"]]},
        headers=_write_headers(test_client, agent["api_key"]),
    )

    r = test_client.get(
        f"/api/agentic/mm/channels/{cid}/posts",
        headers=_auth(agent["api_key"]),
    )
    assert r.status_code == 200, r.text
    posts = r.json()["posts"]
    with_files = [p for p in posts if p["files"]]
    assert len(with_files) == 1
    assert with_files[0]["files"][0]["file_id"] == out["file_id"]
    # Inline URL is enriched on the read path too (matches human surface).
    assert with_files[0]["files"][0]["download_url"] is not None


def test_parent_preview_counts_attachments(test_client):
    """An attachment-only parent carries ``attachment_count`` in the quote
    payload. A post with files needs no text, so without the count the
    client can't tell "attachment-only" from "genuinely blank" and used to
    render the quote-block as "(empty message)"."""
    agent = _create_owned_agent(test_client)
    cid = _default_channel_id(test_client, agent)
    f1 = _request_upload(test_client, agent, cid, filename="a.png")
    _confirm_upload(test_client, agent, f1["file_id"])
    f2 = _request_upload(test_client, agent, cid, filename="b.png")
    _confirm_upload(test_client, agent, f2["file_id"])

    parent = test_client.post(
        f"/api/agentic/mm/channels/{cid}/posts",
        json={"message": "", "file_ids": [f1["file_id"], f2["file_id"]]},
        headers=_write_headers(test_client, agent["api_key"]),
    )
    assert parent.status_code == 200, parent.text
    parent_id = parent.json()["post_id"]

    r = test_client.post(
        f"/api/agentic/mm/channels/{cid}/posts",
        json={"message": "nice shots", "parent_post_id": parent_id},
        headers=_write_headers(test_client, agent["api_key"]),
    )
    assert r.status_code == 200, r.text
    preview = r.json()["parent_preview"]
    assert preview["message_excerpt"] == ""
    assert preview["attachment_count"] == 2


def test_parent_preview_attachment_count_zero_for_text_post(test_client):
    """Text-only parents report a zero count, so the quote-block keeps
    rendering the excerpt and never shows an attachment label."""
    agent = _create_owned_agent(test_client)
    cid = _default_channel_id(test_client, agent)
    parent = test_client.post(
        f"/api/agentic/mm/channels/{cid}/posts",
        json={"message": "just words"},
        headers=_write_headers(test_client, agent["api_key"]),
    ).json()

    r = test_client.post(
        f"/api/agentic/mm/channels/{cid}/posts",
        json={"message": "reply", "parent_post_id": parent["post_id"]},
        headers=_write_headers(test_client, agent["api_key"]),
    )
    assert r.status_code == 200, r.text
    assert r.json()["parent_preview"]["attachment_count"] == 0


def test_post_with_too_many_files_rejected(test_client, monkeypatch):
    """Caps from MM_FILES_MAX_PER_POST are enforced at post-create time."""
    monkeypatch.setenv("MM_FILES_MAX_PER_POST", "1")
    agent = _create_owned_agent(test_client)
    cid = _default_channel_id(test_client, agent)
    f1 = _request_upload(test_client, agent, cid, filename="a.png")
    _confirm_upload(test_client, agent, f1["file_id"])
    f2 = _request_upload(test_client, agent, cid, filename="b.png")
    _confirm_upload(test_client, agent, f2["file_id"])

    r = test_client.post(
        f"/api/agentic/mm/channels/{cid}/posts",
        json={"message": "two", "file_ids": [f1["file_id"], f2["file_id"]]},
        headers=_write_headers(test_client, agent["api_key"]),
    )
    assert r.status_code == 400, r.text


def test_post_with_other_agents_file_rejected(test_client):
    """An agent can't attach a file uploaded by another agent."""
    owner = _create_owned_agent(test_client)
    other = _create_owned_agent(test_client)
    owner_cid = _default_channel_id(test_client, owner)
    other_cid = _default_channel_id(test_client, other)

    other_file = _request_upload(test_client, other, other_cid)
    _confirm_upload(test_client, other, other_file["file_id"])

    r = test_client.post(
        f"/api/agentic/mm/channels/{owner_cid}/posts",
        json={"message": "stolen", "file_ids": [other_file["file_id"]]},
        headers=_write_headers(test_client, owner["api_key"]),
    )
    assert r.status_code == 400, r.text


# ---------------------------------------------------------------------------
# Confirm-time dimension probe (parity with the human confirm route)
# ---------------------------------------------------------------------------


def test_confirm_probe_backfills_missing_dims(test_client, monkeypatch):
    """A dim-less image confirm gets width/height from the server probe."""

    async def _fake_probe(presigner, object_key):
        return (640, 480)

    monkeypatch.setattr(
        "clawbits.fastapi.clawbits_server.probe_image_dimensions", _fake_probe
    )
    agent = _create_owned_agent(test_client)
    cid = _default_channel_id(test_client, agent)
    out = _request_upload(test_client, agent, cid)
    confirmed = _confirm_upload(test_client, agent, out["file_id"])
    assert confirmed["width"] == 640
    assert confirmed["height"] == 480

    # The probed dims persist — the attached post carries them too.
    r = test_client.post(
        f"/api/agentic/mm/channels/{cid}/posts",
        json={"message": "probed", "file_ids": [out["file_id"]]},
        headers=_write_headers(test_client, agent["api_key"]),
    )
    assert r.status_code == 200, r.text
    assert r.json()["files"][0]["width"] == 640


def test_confirm_probe_failure_leaves_dims_null(test_client, monkeypatch):
    """A failed probe doesn't fail the confirm — dims just stay null."""

    async def _fake_probe(presigner, object_key):
        return None

    monkeypatch.setattr(
        "clawbits.fastapi.clawbits_server.probe_image_dimensions", _fake_probe
    )
    agent = _create_owned_agent(test_client)
    cid = _default_channel_id(test_client, agent)
    out = _request_upload(test_client, agent, cid)
    confirmed = _confirm_upload(test_client, agent, out["file_id"])
    assert confirmed["status"] == "uploaded"
    assert confirmed["width"] is None
    assert confirmed["height"] is None


def test_confirm_client_dims_skip_probe(test_client, monkeypatch):
    """Client-supplied dims are trusted — the probe must not fire."""

    async def _explode(presigner, object_key):  # pragma: no cover - must not run
        raise AssertionError("probe should not be called when dims are supplied")

    monkeypatch.setattr(
        "clawbits.fastapi.clawbits_server.probe_image_dimensions", _explode
    )
    agent = _create_owned_agent(test_client)
    cid = _default_channel_id(test_client, agent)
    out = _request_upload(test_client, agent, cid)
    confirmed = _confirm_upload(
        test_client, agent, out["file_id"], width=32, height=16,
    )
    assert confirmed["width"] == 32
    assert confirmed["height"] == 16


# ---------------------------------------------------------------------------
# Direct byte upload
# ---------------------------------------------------------------------------


def _png_bytes(width: int = 8, height: int = 8) -> bytes:
    """A real PNG, so the server-side Pillow decode succeeds."""
    import io

    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (width, height), (200, 30, 30)).save(buf, format="PNG")
    return buf.getvalue()


def _direct_upload(
    tc: TestClient,
    agent: dict,
    channel_id: str,
    data: bytes,
    *,
    filename: str = "gen.png",
    content_type: str = "image/png",
):
    return tc.post(
        f"/api/agentic/mm/channels/{channel_id}/files/direct",
        params={"filename": filename},
        content=data,
        headers={**_auth(agent["api_key"]), "Content-Type": content_type},
    )


def test_direct_upload_happy_path(test_client):
    agent = _create_owned_agent(test_client)
    cid = _default_channel_id(test_client, agent)
    data = _png_bytes(8, 8)
    r = _direct_upload(test_client, agent, cid, data)
    assert r.status_code == 200, r.text
    f = r.json()
    assert f["status"] == "uploaded"
    assert f["width"] == 8
    assert f["height"] == 8
    assert f["size_bytes"] == len(data)
    assert f["uploader_agent_id"] == agent["agent_id"]
    # Bytes actually landed in (fake) R2 under the returned row's key.
    stored = test_client.app._mm_r2._store
    stored_keys = [k for k in stored if f["file_id"] in k and "/original/" in k]
    assert len(stored_keys) == 1
    assert stored[stored_keys[0]][0] == data
    # An 8px image is below the 1024px thumbnail threshold — no thumb key.
    assert not any("thumb" in k for k in stored)


def test_direct_upload_large_image_gets_thumbnail(test_client):
    agent = _create_owned_agent(test_client)
    cid = _default_channel_id(test_client, agent)
    r = _direct_upload(test_client, agent, cid, _png_bytes(1600, 900))
    assert r.status_code == 200, r.text
    f = r.json()
    assert f["width"] == 1600
    assert f["height"] == 900
    stored = test_client.app._mm_r2._store
    thumb_keys = [k for k in stored if f["file_id"] in k and "thumb-1024.jpg" in k]
    assert len(thumb_keys) == 1
    thumb_bytes, thumb_ct = stored[thumb_keys[0]]
    assert thumb_ct == "image/jpeg"
    assert 0 < len(thumb_bytes) < len(_png_bytes(1600, 900)) * 2


def test_direct_upload_oversize_rejected(test_client, monkeypatch):
    monkeypatch.setenv("MM_FILES_MAX_BYTES", "10")
    agent = _create_owned_agent(test_client)
    cid = _default_channel_id(test_client, agent)
    r = _direct_upload(test_client, agent, cid, b"x" * 100)
    assert r.status_code == 413, r.text


def test_direct_upload_chunked_oversize_capped_midstream(test_client, monkeypatch):
    """A chunked body (no Content-Length) is capped while streaming.

    Passing a generator makes httpx use ``Transfer-Encoding: chunked``, so
    the declared-length pre-check is skipped and the server must abort on
    the accumulated byte count instead of buffering the whole payload. The
    early abort fires before any row is created or R2 object written.
    """
    monkeypatch.setenv("MM_FILES_MAX_BYTES", "10")
    agent = _create_owned_agent(test_client)
    cid = _default_channel_id(test_client, agent)
    # The R2 store is a session-scoped fixture shared across the module, so
    # snapshot its keys rather than asserting global emptiness.
    keys_before = set(test_client.app._mm_r2._store)

    def _chunks():
        for _ in range(50):
            yield b"x" * 8  # 400 bytes total, well over the 10-byte cap

    r = test_client.post(
        f"/api/agentic/mm/channels/{cid}/files/direct",
        params={"filename": "big.png"},
        content=_chunks(),
        headers={**_auth(agent["api_key"]), "Content-Type": "image/png"},
    )
    assert r.status_code == 413, r.text

    from sqlmodel import Session, select

    from clawbits.db.models import MmFile

    with Session(test_client.app._engine) as db:
        rows = db.exec(select(MmFile).where(MmFile.channel_id == cid)).all()
        assert rows == [], "no row may be created when the body is capped mid-stream"
    assert set(test_client.app._mm_r2._store) == keys_before, (
        "nothing may be written to R2 when the body is capped mid-stream"
    )


def test_direct_upload_disallowed_mime(test_client):
    agent = _create_owned_agent(test_client)
    cid = _default_channel_id(test_client, agent)
    r = _direct_upload(
        test_client, agent, cid, b"MZ...",
        filename="bad.exe", content_type="application/x-msdownload",
    )
    assert r.status_code == 415, r.text


def test_direct_upload_non_member_forbidden(test_client):
    owner = _create_owned_agent(test_client)
    intruder = _create_owned_agent(test_client)
    cid = _default_channel_id(test_client, owner)
    r = _direct_upload(test_client, intruder, cid, _png_bytes())
    assert r.status_code == 403, r.text


def test_direct_upload_unavailable_without_r2(test_client, monkeypatch):
    monkeypatch.setattr(test_client.app, "_mm_r2", None)
    agent = _create_owned_agent(test_client)
    cid = _default_channel_id(test_client, agent)
    r = _direct_upload(test_client, agent, cid, _png_bytes())
    assert r.status_code == 503, r.text


def test_direct_upload_non_image_passthrough(test_client):
    """Non-image types skip the decode/thumbnail path but still upload."""
    agent = _create_owned_agent(test_client)
    cid = _default_channel_id(test_client, agent)
    r = _direct_upload(
        test_client, agent, cid, b"hello world",
        filename="notes.txt", content_type="text/plain",
    )
    assert r.status_code == 200, r.text
    f = r.json()
    assert f["status"] == "uploaded"
    assert f["width"] is None


def test_direct_upload_then_post_end_to_end(test_client):
    """Direct upload → post with file_ids → listing inlines the image URL."""
    agent = _create_owned_agent(test_client)
    cid = _default_channel_id(test_client, agent)
    up = _direct_upload(test_client, agent, cid, _png_bytes(32, 24))
    assert up.status_code == 200, up.text
    file_id = up.json()["file_id"]

    r = test_client.post(
        f"/api/agentic/mm/channels/{cid}/posts",
        json={"message": "generated for you", "file_ids": [file_id]},
        headers=_write_headers(test_client, agent["api_key"]),
    )
    assert r.status_code == 200, r.text
    post = r.json()
    assert post["files"][0]["file_id"] == file_id
    assert post["files"][0]["download_url"] is not None

    r = test_client.get(
        f"/api/agentic/mm/channels/{cid}/posts",
        headers=_auth(agent["api_key"]),
    )
    assert r.status_code == 200, r.text
    listed = [p for p in r.json()["posts"] if p["files"]]
    assert listed and listed[0]["files"][0]["width"] == 32


def test_confirm_probe_preserves_thumbnail_key(test_client, monkeypatch):
    """The probe's metadata write-back must not clobber a confirmed thumbnail.

    Regression: the write-back used to call ``confirm_mm_file`` with the
    old ``thumbnail_uploaded=False`` default, which nulled the key the
    client had just confirmed.
    """

    async def _fake_probe(presigner, object_key):
        return (512, 384)

    monkeypatch.setattr(
        "clawbits.fastapi.clawbits_server.probe_image_dimensions", _fake_probe
    )
    agent = _create_owned_agent(test_client)
    cid = _default_channel_id(test_client, agent)
    out = _request_upload(test_client, agent, cid, has_thumbnail=True)
    confirmed = _confirm_upload(
        test_client, agent, out["file_id"], thumbnail_uploaded=True
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


def test_direct_upload_failure_leaves_pending_row(test_client, monkeypatch):
    """A failed R2 PUT 502s but keeps the GC-visible ``pending`` row."""

    async def _fail_upload(object_key, content, content_type="application/octet-stream"):
        return {"success": False, "error": "boom"}

    monkeypatch.setattr(test_client.app._mm_r2, "upload_file", _fail_upload)
    agent = _create_owned_agent(test_client)
    cid = _default_channel_id(test_client, agent)
    r = _direct_upload(test_client, agent, cid, _png_bytes())
    assert r.status_code == 502, r.text

    from sqlmodel import Session, select

    from clawbits.db.models import MmFile

    with Session(test_client.app._engine) as db:
        rows = db.exec(select(MmFile).where(MmFile.channel_id == cid)).all()
        assert len(rows) == 1
        assert rows[0].status == "pending"
        assert rows[0].object_key  # the pending row references the key GC needs


def test_direct_upload_transparent_png_thumbnail_flattens_white(test_client):
    """Alpha thumbnails composite onto white, not JPEG-conversion black."""
    import io

    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGBA", (1600, 900), (255, 0, 0, 0)).save(buf, format="PNG")
    agent = _create_owned_agent(test_client)
    cid = _default_channel_id(test_client, agent)
    r = _direct_upload(test_client, agent, cid, buf.getvalue())
    assert r.status_code == 200, r.text
    f = r.json()
    stored = test_client.app._mm_r2._store
    thumb_keys = [k for k in stored if f["file_id"] in k and "thumb-1024.jpg" in k]
    assert len(thumb_keys) == 1
    with Image.open(io.BytesIO(stored[thumb_keys[0]][0])) as thumb:
        red, green, blue = thumb.convert("RGB").getpixel((0, 0))
    assert min(red, green, blue) > 240, (red, green, blue)
