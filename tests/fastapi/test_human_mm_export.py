"""Tests for conversation export — ``GET /channels/{id}/export``.

One JSON archive per conversation, covering both shapes the UI offers it
for: a group/public channel and a DM. The interesting properties are the
ones an archive has and a normal read doesn't — oldest-first ordering, an
attachment Content-Disposition, attachment metadata without presigned URLs,
and an explicit ``truncated`` flag instead of a silent cut.
"""
from __future__ import annotations

from starlette.testclient import TestClient

from tests.fastapi._auth_helpers import auth_headers, personal_org_id, register_human

# ---------------------------------------------------------------------------
# Local helpers
# ---------------------------------------------------------------------------


def _make_channel(tc: TestClient, token: str, name: str) -> str:
    r = tc.post(
        "/api/human/mm/channels",
        json={
            "org_id": personal_org_id(tc, token),
            "name": name,
            "channel_type": "public",
        },
        headers=auth_headers(token),
    )
    assert r.status_code == 200, r.text
    return r.json()["channel_id"]


def _post(tc: TestClient, token: str, channel_id: str, message: str) -> dict:
    r = tc.post(
        f"/api/human/mm/channels/{channel_id}/posts",
        json={"message": message},
        headers=auth_headers(token),
    )
    assert r.status_code == 200, r.text
    return r.json()


def _export(tc: TestClient, token: str, channel_id: str):
    return tc.get(
        f"/api/human/mm/channels/{channel_id}/export", headers=auth_headers(token)
    )


# ---------------------------------------------------------------------------
# Channel export
# ---------------------------------------------------------------------------


def test_export_channel_returns_full_history_oldest_first(test_client):
    """A channel export carries every post, oldest-first, plus its metadata."""
    h1 = register_human(test_client, "exporter@test.com", display_name="Exporter")
    ch_id = _make_channel(test_client, h1["access_token"], "export-me")
    for msg in ("first", "second", "third"):
        _post(test_client, h1["access_token"], ch_id, msg)

    r = _export(test_client, h1["access_token"], ch_id)
    assert r.status_code == 200, r.text
    body = r.json()

    # Oldest-first — the reverse of every other read endpoint.
    assert [p["message"] for p in body["posts"]] == ["first", "second", "third"]
    assert body["post_count"] == 3
    assert body["truncated"] is False
    assert body["export_version"] == 1
    assert body["exported_by_human_id"] == h1["user"]["id"]
    assert body["channel"]["channel_id"] == ch_id
    assert body["channel"]["name"] == "export-me"
    assert [m["human_id"] for m in body["members"]] == [h1["user"]["id"]]


def test_export_served_as_named_attachment(test_client):
    """The response downloads as a file rather than rendering in a tab."""
    h1 = register_human(test_client, "attach@test.com")
    ch_id = _make_channel(test_client, h1["access_token"], "disposition")
    _post(test_client, h1["access_token"], ch_id, "hi")

    r = _export(test_client, h1["access_token"], ch_id)
    disposition = r.headers["content-disposition"]
    assert disposition.startswith("attachment; filename=")
    assert "disposition" in disposition
    assert disposition.endswith('.json"')


def test_export_includes_direct_message_history(test_client):
    """DMs export through the same endpoint as channels."""
    h1 = register_human(test_client, "dm-export-1@test.com", display_name="One")
    h2 = register_human(test_client, "dm-export-2@test.com", display_name="Two")
    org_id = personal_org_id(test_client, h1["access_token"])
    test_client.post(
        f"/api/human/orgs/{org_id}/members",
        json={"email": "dm-export-2@test.com", "role": "member"},
        headers=auth_headers(h1["access_token"]),
    )
    r = test_client.post(
        "/api/human/mm/direct",
        json={
            "org_id": org_id,
            "target_id": str(h2["user"]["id"]),
            "target_type": "human",
        },
        headers=auth_headers(h1["access_token"]),
    )
    assert r.status_code == 200, r.text
    dm_id = r.json()["channel_id"]

    _post(test_client, h1["access_token"], dm_id, "ping")
    _post(test_client, h2["access_token"], dm_id, "pong")

    # Both sides get the same conversation.
    for human in (h1, h2):
        body = _export(test_client, human["access_token"], dm_id).json()
        assert body["channel"]["channel_type"] == "direct"
        assert [p["message"] for p in body["posts"]] == ["ping", "pong"]
        assert sorted(m["human_id"] for m in body["members"]) == sorted(
            [h1["user"]["id"], h2["user"]["id"]]
        )


def test_export_requires_membership(test_client):
    """A non-member can't export a channel they can't read."""
    h1 = register_human(test_client, "owner-export@test.com")
    outsider = register_human(test_client, "outsider-export@test.com")
    ch_id = _make_channel(test_client, h1["access_token"], "private-ish")
    _post(test_client, h1["access_token"], ch_id, "members only")

    r = _export(test_client, outsider["access_token"], ch_id)
    assert r.status_code == 403, r.text


# ---------------------------------------------------------------------------
# Attachments + privacy shape
# ---------------------------------------------------------------------------


def test_export_attachment_metadata_carries_no_presigned_urls(test_client):
    """Files are described, not linked — presigned URLs expire within the hour."""
    h1 = register_human(test_client, "files-export@test.com")
    ch_id = _make_channel(test_client, h1["access_token"], "with-files")

    up = test_client.post(
        f"/api/human/mm/channels/{ch_id}/files",
        json={
            "filename": "shot.png",
            "content_type": "image/png",
            "size_bytes": 1024,
            "has_thumbnail": False,
        },
        headers=auth_headers(h1["access_token"]),
    )
    assert up.status_code == 200, up.text
    file_id = up.json()["file_id"]
    confirm = test_client.post(
        f"/api/human/mm/files/{file_id}/confirm",
        json={"thumbnail_uploaded": False},
        headers=auth_headers(h1["access_token"]),
    )
    assert confirm.status_code == 200, confirm.text
    attached = test_client.post(
        f"/api/human/mm/channels/{ch_id}/posts",
        json={"message": "see attached", "file_ids": [file_id]},
        headers=auth_headers(h1["access_token"]),
    )
    assert attached.status_code == 200, attached.text

    body = _export(test_client, h1["access_token"], ch_id).json()
    files = body["posts"][0]["files"]
    assert len(files) == 1
    meta = files[0]
    # Described...
    assert meta["filename"] == "shot.png"
    assert meta["content_type"] == "image/png"
    assert meta["size_bytes"] == 1024
    # ...but not linked.
    assert meta["download_url"] is None
    assert meta["thumbnail_url"] is None


def test_export_members_omit_presence_and_read_pointers(test_client):
    """Member rows are identity only — no privacy-gated signals baked in."""
    h1 = register_human(test_client, "privacy-export@test.com", display_name="P")
    ch_id = _make_channel(test_client, h1["access_token"], "identity-only")
    _post(test_client, h1["access_token"], ch_id, "hello")

    member = _export(test_client, h1["access_token"], ch_id).json()["members"][0]
    assert set(member) == {"agent_id", "human_id", "display_name", "joined_at"}


# ---------------------------------------------------------------------------
# Truncation
# ---------------------------------------------------------------------------


def test_export_flags_truncation_instead_of_cutting_silently(test_client, monkeypatch):
    """Past the cap the newest slice comes back with ``truncated`` set."""
    from clawbits.fastapi import human_mm_endpoints as mod

    h1 = register_human(test_client, "truncate-export@test.com")
    ch_id = _make_channel(test_client, h1["access_token"], "long-history")
    for i in range(5):
        _post(test_client, h1["access_token"], ch_id, f"msg-{i}")

    monkeypatch.setattr(mod, "MAX_EXPORT_POSTS", 3)
    monkeypatch.setattr(mod, "_EXPORT_PAGE", 2)
    body = _export(test_client, h1["access_token"], ch_id).json()

    assert body["truncated"] is True
    assert body["post_count"] == 3
    # The newest three, still oldest-first within the slice.
    assert [p["message"] for p in body["posts"]] == ["msg-2", "msg-3", "msg-4"]


def test_export_flags_truncation_when_a_page_overshoots_the_cap(test_client, monkeypatch):
    """The last page can carry posts past the cap — dropping those still counts.

    Regression: probing only for posts older than the page cursor missed the
    ones trimmed from inside that final page, so an export that silently lost
    messages came back claiming to be complete.
    """
    from clawbits.fastapi import human_mm_endpoints as mod

    h1 = register_human(test_client, "overshoot-export@test.com")
    ch_id = _make_channel(test_client, h1["access_token"], "overshoot")
    for i in range(4):
        _post(test_client, h1["access_token"], ch_id, f"msg-{i}")

    # Pages of 2 over 4 posts with a cap of 3: the second page lands on
    # msg-0, which the trim then drops. Nothing older than msg-0 exists, so
    # the old probe answered "complete".
    monkeypatch.setattr(mod, "MAX_EXPORT_POSTS", 3)
    monkeypatch.setattr(mod, "_EXPORT_PAGE", 2)
    body = _export(test_client, h1["access_token"], ch_id).json()

    assert body["truncated"] is True
    assert [p["message"] for p in body["posts"]] == ["msg-1", "msg-2", "msg-3"]


def test_export_exactly_at_cap_is_not_marked_truncated(test_client, monkeypatch):
    """A conversation the same length as the cap is complete, not truncated."""
    from clawbits.fastapi import human_mm_endpoints as mod

    h1 = register_human(test_client, "at-cap-export@test.com")
    ch_id = _make_channel(test_client, h1["access_token"], "exact-cap")
    for i in range(3):
        _post(test_client, h1["access_token"], ch_id, f"msg-{i}")

    monkeypatch.setattr(mod, "MAX_EXPORT_POSTS", 3)
    body = _export(test_client, h1["access_token"], ch_id).json()

    assert body["truncated"] is False
    assert body["post_count"] == 3


# ---------------------------------------------------------------------------
# Cross-layer contract: the frontend locates an agent DM by this name
# ---------------------------------------------------------------------------


def test_agent_dm_channel_name_format_is_pinned():
    """The delete-agent dialog offers "Export chat" only when it can find the
    DM, and it finds it by matching this name against the cached channel list
    (calling POST /mm/direct instead would *create* a DM). Changing the format
    silently removes that button, so pin it here."""
    from clawbits.datastructures.mm_models import agent_dm_channel_name

    assert agent_dm_channel_name(7, "GoldenEagle7") == "dm-human-7-agent-GoldenEagle7"


def test_created_agent_dm_uses_the_pinned_name(test_client):
    """...and the DM the server actually creates carries it."""
    from clawbits.datastructures.mm_models import agent_dm_channel_name
    from tests.fastapi.test_human_mattermost import _create_agent

    agent = _create_agent(test_client)
    h1 = register_human(test_client, "stan@clawbits.ai", display_name="Stan")
    org_id = personal_org_id(test_client, h1["access_token"])
    r = test_client.post(
        "/api/human/mm/direct",
        json={
            "org_id": org_id,
            "target_id": agent["agent_id"],
            "target_type": "agent",
        },
        headers=auth_headers(h1["access_token"]),
    )
    assert r.status_code == 200, r.text
    assert r.json()["name"] == agent_dm_channel_name(
        h1["user"]["id"], agent["agent_id"]
    )


# ---------------------------------------------------------------------------
# Filename sanitisation (pure function — the channel name reaches a header)
# ---------------------------------------------------------------------------


def test_export_filename_strips_header_breaking_characters():
    from clawbits.fastapi.human_mm_endpoints import _export_filename

    name = _export_filename(
        {"channel_id": "ch_1", "display_name": 'evil"\r\nX-Injected: yes', "name": "n"}
    )
    assert '"' not in name
    assert "\r" not in name and "\n" not in name
    assert name.startswith("clawbits-evil-X-Injected-yes-")
    assert name.endswith(".json")


def test_export_filename_falls_back_to_channel_id():
    from clawbits.fastapi.human_mm_endpoints import _export_filename

    name = _export_filename({"channel_id": "ch_abc", "display_name": "///", "name": None})
    assert name.startswith("clawbits-ch_abc-")
