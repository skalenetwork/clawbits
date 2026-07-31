import hashlib
from datetime import UTC, datetime

from sqlmodel import Session
from starlette.testclient import TestClient

from clawbits.db.models import HumanUser, MmChannel, MmChannelMember
from clawbits.db.table_write import TableWrite
from tests.fastapi._auth_helpers import auth_headers, login_human, personal_org_id


def test_privacy_mode_legacy_endpoint_flips_all_four_flags(test_client: TestClient):
    """``POST /api/human/privacy-mode`` is the legacy single-toggle shim.
    Enabling it must flip all four granular flags to FALSE (everything
    hidden); disabling restores them to TRUE.
    """
    token, user = login_human(test_client, "stan@clawbits.ai")

    r = test_client.post(
        "/api/human/privacy-mode",
        json={"enabled": True},
        headers=auth_headers(token),
    )
    assert r.status_code == 200, r.text

    # Online status hidden → broadcast "offline" (not "idle"); last-seen
    # hidden → no raw timestamp in the response.
    assert r.json()["status"] == "offline"
    assert r.json()["last_seen_at"] is None

    with Session(test_client.app._engine) as db:
        row = db.get(HumanUser, user["id"])
        assert row.privacy_mode_enabled is True
        assert row.last_seen_visible is False
        assert row.online_status_visible is False
        assert row.read_receipts_enabled is False
        assert row.typing_indicators_enabled is False

    r = test_client.post(
        "/api/human/privacy-mode",
        json={"enabled": False},
        headers=auth_headers(token),
    )
    assert r.status_code == 200, r.text

    with Session(test_client.app._engine) as db:
        row = db.get(HumanUser, user["id"])
        assert row.privacy_mode_enabled is False
        assert row.last_seen_visible is True
        assert row.online_status_visible is True
        assert row.read_receipts_enabled is True
        assert row.typing_indicators_enabled is True


def test_granular_privacy_settings_partial_patch(test_client: TestClient):
    """Each PATCH body key updates only that one flag; absent keys keep
    their existing value untouched. The cross-cutting
    ``privacy_mode_enabled`` boolean stays in sync as the "all four
    hidden" derivation.
    """
    token, user = login_human(test_client, "granular@clawbits.ai")

    r = test_client.get(
        "/api/human/privacy-settings", headers=auth_headers(token)
    )
    assert r.status_code == 200, r.text
    assert r.json() == {
        "last_seen_visible": True,
        "online_status_visible": True,
        "read_receipts_enabled": True,
        "typing_indicators_enabled": True,
    }

    # Flip only last_seen — the other three must stay TRUE.
    r = test_client.patch(
        "/api/human/privacy-settings",
        json={"last_seen_visible": False},
        headers=auth_headers(token),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["last_seen_visible"] is False
    assert body["online_status_visible"] is True
    assert body["read_receipts_enabled"] is True
    assert body["typing_indicators_enabled"] is True

    with Session(test_client.app._engine) as db:
        row = db.get(HumanUser, user["id"])
        # privacy_mode_enabled is TRUE only when all four are hidden.
        assert row.privacy_mode_enabled is False
        assert row.last_seen_visible is False

    # Hide the remaining three — privacy_mode_enabled flips to TRUE.
    r = test_client.patch(
        "/api/human/privacy-settings",
        json={
            "online_status_visible": False,
            "read_receipts_enabled": False,
            "typing_indicators_enabled": False,
        },
        headers=auth_headers(token),
    )
    assert r.status_code == 200, r.text

    with Session(test_client.app._engine) as db:
        row = db.get(HumanUser, user["id"])
        assert row.privacy_mode_enabled is True


def test_hidden_last_seen_returns_bucketed_label(test_client: TestClient):
    """A user with ``last_seen_visible=False`` exposes the bucketed
    "Last seen recently" string in place of the raw timestamp on the
    public presence endpoint.
    """
    token, user = login_human(test_client, "hide-last-seen@clawbits.ai")

    # Pin last_seen_at to a known recent value (yesterday).
    with Session(test_client.app._engine) as db:
        row = db.get(HumanUser, user["id"])
        row.last_seen_at = datetime.now(UTC)
        db.commit()

    r = test_client.patch(
        "/api/human/privacy-settings",
        json={"last_seen_visible": False},
        headers=auth_headers(token),
    )
    assert r.status_code == 200, r.text

    r = test_client.get(
        f"/api/human/users/{user['id']}/presence",
        headers=auth_headers(token),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["last_seen_at"] is None, (
        "precise timestamp must be hidden when last_seen_visible=False"
    )
    assert body["last_seen_label"] == "recently"


def test_hidden_online_status_forces_offline(test_client: TestClient):
    """A user with ``online_status_visible=False`` is reported as
    ``offline`` to peers regardless of their real Redis-backed
    status."""
    token, user = login_human(test_client, "hide-online@clawbits.ai")

    # Mark the user online in Redis.
    r = test_client.post(
        "/api/human/presence",
        json={"status": "online"},
        headers=auth_headers(token),
    )
    assert r.status_code == 200, r.text

    r = test_client.patch(
        "/api/human/privacy-settings",
        json={"online_status_visible": False},
        headers=auth_headers(token),
    )
    assert r.status_code == 200, r.text

    r = test_client.get(
        f"/api/human/users/{user['id']}/presence",
        headers=auth_headers(token),
    )
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "offline"


def test_read_receipts_disabled_strips_pointer_for_peers(
    test_client: TestClient,
):
    """When user A turns off read receipts: A's read pointer still
    advances in the DB (their own unread badge stays correct), but
    peer B never sees it via the member list — the field is stripped.
    """
    token_a, user_a = login_human(test_client, "no-receipts-a@clawbits.ai")
    token_b, user_b = login_human(test_client, "no-receipts-b@clawbits.ai")
    # ``login_human`` leaves a session cookie on the client. The auth
    # resolver picks bearer over cookie within WorkOS auth — but
    # dev-auth (which runs first) accepts either source, so a lingering
    # dev cookie from B's login can override an explicit Bearer for A.
    # Clear cookies and rely purely on the Bearer headers we pass.
    test_client.cookies.clear()
    assert user_a["id"] != user_b["id"], (user_a, user_b)
    org_id = personal_org_id(test_client, token_a)

    r = test_client.post(
        f"/api/human/orgs/{org_id}/members",
        json={"email": "no-receipts-b@clawbits.ai", "role": "member"},
        headers=auth_headers(token_a),
    )
    assert r.status_code == 200, r.text

    r = test_client.post(
        "/api/human/mm/direct",
        json={
            "org_id": org_id,
            "target_type": "human",
            "target_id": str(user_b["id"]),
        },
        headers=auth_headers(token_a),
    )
    assert r.status_code == 200, r.text
    channel_id = r.json()["channel_id"]

    r = test_client.post(
        f"/api/human/mm/channels/{channel_id}/posts",
        json={"message": "from b", "status": "published"},
        headers=auth_headers(token_b),
    )
    assert r.status_code == 200, r.text
    b_post_id = r.json()["post_id"]

    # A disables read receipts.
    r = test_client.patch(
        "/api/human/privacy-settings",
        json={"read_receipts_enabled": False},
        headers=auth_headers(token_a),
    )
    assert r.status_code == 200, r.text

    # A reads up to B's post. Pointer must advance in the DB for A's
    # own unread-badge math, but the peer-visible member list strips it.
    r = test_client.post(
        f"/api/human/mm/channels/{channel_id}/read",
        json={"post_id": b_post_id},
        headers=auth_headers(token_a),
    )
    assert r.status_code == 200, r.text
    assert r.json()["last_read_post_id"] == b_post_id

    r = test_client.get(
        f"/api/human/mm/channels/{channel_id}/members",
        headers=auth_headers(token_b),
    )
    assert r.status_code == 200, r.text
    member_a = next(
        m for m in r.json()["members"] if m.get("human_id") == user_a["id"]
    )
    assert member_a["last_read_post_id"] is None, (
        "peer must not see A's read pointer when A has receipts off"
    )


def test_typing_indicators_disabled_skips_broadcast(test_client: TestClient):
    """A user with ``typing_indicators_enabled=False`` who calls the
    typing endpoint still gets a 204, but no ``member.status`` event
    is broadcast — the call is silently a no-op. Asserting absence is
    awkward over SSE in unit tests, so this just exercises the early
    return path; the endpoint must not raise."""
    token_a, _ = login_human(test_client, "no-typing-a@clawbits.ai")
    token_b, user_b = login_human(test_client, "no-typing-b@clawbits.ai")
    test_client.cookies.clear()
    org_id = personal_org_id(test_client, token_a)

    test_client.post(
        f"/api/human/orgs/{org_id}/members",
        json={"email": "no-typing-b@clawbits.ai", "role": "member"},
        headers=auth_headers(token_a),
    )
    r = test_client.post(
        "/api/human/mm/direct",
        json={
            "org_id": org_id,
            "target_type": "human",
            "target_id": str(user_b["id"]),
        },
        headers=auth_headers(token_a),
    )
    channel_id = r.json()["channel_id"]

    # Disable typing indicators for A.
    test_client.patch(
        "/api/human/privacy-settings",
        json={"typing_indicators_enabled": False},
        headers=auth_headers(token_a),
    )

    # Typing endpoint must still return 204 — silent no-op, not 4xx.
    r = test_client.post(
        f"/api/human/mm/channels/{channel_id}/typing",
        headers=auth_headers(token_a),
    )
    assert r.status_code == 204


def test_touch_human_last_seen_always_advances(test_client: TestClient):
    """``touch_human_last_seen`` always advances the raw timestamp;
    privacy is enforced at the read boundary via bucketing, not by
    freezing the DB column.
    """
    token, user = login_human(test_client, "touch-always@clawbits.ai")
    human_id = user["id"]

    stale = datetime(2020, 1, 1, tzinfo=UTC)
    with Session(test_client.app._engine) as db:
        row = db.get(HumanUser, human_id)
        row.last_seen_at = stale
        row.last_seen_visible = False
        db.commit()

    with Session(test_client.app._engine) as db:
        TableWrite.touch_human_last_seen(db, human_id)
        db.commit()
        row = db.get(HumanUser, human_id)
        assert row.last_seen_at > stale, (
            "touch must advance the timestamp even when last-seen is hidden"
        )


def test_org_owner_cannot_see_private_channel_message_content(
    test_client: TestClient,
):
    """Privacy-leak regression for ``GET /orgs/{org}/channels``.

    An org owner enumerating every channel gets governance metadata (name,
    member count) for all of them, but the denormalised last-message
    *content* preview must be redacted for private channels they don't
    belong to. Public channels, and private channels the owner IS in, keep
    their preview. Mirrors Slack: admins can list private channels but
    can't read messages in ones they haven't joined.
    """
    owner_token, owner = login_human(test_client, "leakowner@clawbits.ai")
    _, bob = login_human(test_client, "leakbob@clawbits.ai")
    org = personal_org_id(test_client, owner_token)

    # Construct the channels directly so we can place the owner in/out of
    # each precisely - the create API would auto-join the owner.
    now = datetime.now(UTC)
    with Session(test_client.app._engine) as db:
        # Private, owner NOT a member -> content must be redacted.
        db.add(MmChannel(
            channel_id="leak_priv_out", org_id=org, name="leak-secret",
            channel_type="private", last_message_text="TOP SECRET",
            created_at=now,
        ))
        db.add(MmChannelMember(
            channel_id="leak_priv_out", human_id=bob["id"], joined_at=now,
        ))
        # Public, owner NOT a member -> preview stays (any member can read).
        db.add(MmChannel(
            channel_id="leak_pub", org_id=org, name="leak-public",
            channel_type="public", last_message_text="hello world",
            created_at=now,
        ))
        db.add(MmChannelMember(
            channel_id="leak_pub", human_id=bob["id"], joined_at=now,
        ))
        # Private, owner IS a member -> preview stays.
        db.add(MmChannel(
            channel_id="leak_priv_in", org_id=org, name="leak-mine",
            channel_type="private", last_message_text="my draft",
            created_at=now,
        ))
        db.add(MmChannelMember(
            channel_id="leak_priv_in", human_id=owner["id"], joined_at=now,
        ))
        # A second private channel the owner isn't in -> must get a
        # *distinct* opaque id from the first (so they stay tellable apart).
        db.add(MmChannel(
            channel_id="leak_priv_out2", org_id=org, name="leak-secret-2",
            channel_type="private", last_message_text="ALSO SECRET",
            created_at=now,
        ))
        db.add(MmChannelMember(
            channel_id="leak_priv_out2", human_id=bob["id"], joined_at=now,
        ))
        db.commit()

    r = test_client.get(
        f"/api/human/mm/orgs/{org}/channels",
        headers=auth_headers(owner_token),
    )
    assert r.status_code == 200, r.text
    by_id = {c["channel_id"]: c for c in r.json()["channels"]}

    def _opaque(channel_id: str) -> str:
        return "Private channel " + hashlib.sha256(
            channel_id.encode()
        ).hexdigest()[:6]

    # Private channel the owner isn't in: the real name + content are gone.
    # The name is a stable opaque id (hash of channel_id); display name and
    # avatar drop; only non-identifying metadata (member count) stays.
    secret = by_id["leak_priv_out"]
    assert secret["name"] == _opaque("leak_priv_out"), "name not opaque"
    assert "leak-secret" not in secret["name"], "real name leaked"
    assert secret["display_name"] is None
    assert secret["avatar"] is None
    assert secret["member_count"] == 1
    assert secret["last_message_text"] is None, "content leaked"

    # The opaque id is distinct per channel, so two hidden private channels
    # stay tellable apart (for moderation) without revealing their names.
    assert by_id["leak_priv_out2"]["name"] == _opaque("leak_priv_out2")
    assert secret["name"] != by_id["leak_priv_out2"]["name"]

    # Public channel: nothing sensitive - real name + preview intact.
    assert by_id["leak_pub"]["name"] == "leak-public"
    assert by_id["leak_pub"]["last_message_text"] == "hello world"
    # Owner's own private channel - real name + preview intact.
    assert by_id["leak_priv_in"]["name"] == "leak-mine"
    assert by_id["leak_priv_in"]["last_message_text"] == "my draft"
