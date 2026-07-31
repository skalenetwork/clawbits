"""Human connectors — universal identity links (GitHub first)."""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

from sqlmodel import Session
from starlette.testclient import TestClient

from clawbits.connectors.types import ConnectorProfile
from clawbits.db.table_read import TableRead
from clawbits.db.table_write import TableWrite
from clawbits.fastapi.session_cookie import CONNECTOR_OAUTH_STATE_COOKIE
from tests.fastapi._auth_helpers import auth_headers, login_human


def _fake_github_profile(
    *,
    external_id: str = "424242",
    handle: str = "octocat",
) -> ConnectorProfile:
    return ConnectorProfile(
        provider="github",
        external_id=external_id,
        handle=handle,
        display_name="The Octocat",
        avatar_url="https://github.com/images/error/octocat_happy.gif",
        metadata={"idp_id": external_id, "source": "oauth_app"},
    )


def test_list_connectors_shows_registry(test_client: TestClient):
    token, _user = login_human(test_client, "connectors-list@clawbits.ai")
    r = test_client.get("/api/human/connectors", headers=auth_headers(token))
    assert r.status_code == 200, r.text
    body = r.json()
    by_id = {c["provider"]: c for c in body["connectors"]}
    assert by_id["github"]["status"] == "available"
    assert by_id["github"]["label"] == "GitHub"
    assert by_id["notion"]["status"] == "coming_soon"
    assert by_id["gmail"]["status"] == "coming_soon"


def test_connect_github_syncs_from_workos_identities(test_client: TestClient):
    token, user = login_human(test_client, "connectors-sync@clawbits.ai")
    workos = test_client.app.state.workos
    workos.inject_github_identity(email="connectors-sync@clawbits.ai", github_user_id="99")

    with patch(
        "clawbits.fastapi.connectors_endpoints.profile_from_workos_identities",
        new=AsyncMock(return_value=_fake_github_profile(external_id="99", handle="syncuser")),
    ):
        r = test_client.post(
            "/api/human/connectors/github/connect",
            headers=auth_headers(token),
        )
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "connected"
    assert r.json()["connector"]["handle"] == "syncuser"

    with Session(test_client.app._engine) as db:
        row = TableRead.get_human_connector(db, int(user["id"]), "github")
        assert row is not None
        assert row["handle"] == "syncuser"


def test_connect_github_redirects_to_oauth_app_when_no_identity(
    test_client: TestClient, monkeypatch,
):
    monkeypatch.setenv("GITHUB_CONNECTOR_CLIENT_ID", "cid")
    monkeypatch.setenv("GITHUB_CONNECTOR_CLIENT_SECRET", "csec")
    token, _user = login_human(test_client, "connectors-redir@clawbits.ai")
    with patch(
        "clawbits.fastapi.connectors_endpoints.profile_from_workos_identities",
        new=AsyncMock(return_value=None),
    ):
        r = test_client.post(
            "/api/human/connectors/github/connect",
            headers=auth_headers(token),
        )
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "redirect"
    assert r.json()["url"] == "/api/auth/connectors/github/link/start"


def test_connect_github_503_when_oauth_app_not_configured(
    test_client: TestClient, monkeypatch,
):
    monkeypatch.delenv("GITHUB_CONNECTOR_CLIENT_ID", raising=False)
    monkeypatch.delenv("GITHUB_CONNECTOR_CLIENT_SECRET", raising=False)
    token, _ = login_human(test_client, "connectors-noconfig@clawbits.ai")
    with patch(
        "clawbits.fastapi.connectors_endpoints.profile_from_workos_identities",
        new=AsyncMock(return_value=None),
    ):
        r = test_client.post(
            "/api/human/connectors/github/connect",
            headers=auth_headers(token),
        )
    assert r.status_code == 503


def test_github_link_start_redirects_to_github(
    test_client: TestClient, monkeypatch,
):
    monkeypatch.setenv("GITHUB_CONNECTOR_CLIENT_ID", "cid123")
    monkeypatch.setenv("GITHUB_CONNECTOR_CLIENT_SECRET", "csec")
    monkeypatch.setenv("CLAWBITS_BASE_URL", "http://localhost:5173")
    token, user = login_human(test_client, "connectors-linkstart@clawbits.ai")
    r = test_client.get(
        "/api/auth/connectors/github/link/start",
        headers=auth_headers(token),
        follow_redirects=False,
    )
    assert r.status_code == 302
    loc = r.headers["location"]
    assert loc.startswith("https://github.com/login/oauth/authorize?")
    assert "client_id=cid123" in loc
    assert "read%3Auser" in loc or "scope=read%3Auser" in loc
    set_cookies = ";".join(r.headers.get_list("set-cookie"))
    assert f"ghlink.{user['id']}." in set_cookies
    assert "fc_connector_oauth_state" in set_cookies


def test_github_link_callback_upserts_without_email_match(
    test_client: TestClient, monkeypatch,
):
    """Dedicated App link must succeed even when GitHub ≠ Clawbits email."""
    monkeypatch.setenv("GITHUB_CONNECTOR_CLIENT_ID", "cid")
    monkeypatch.setenv("GITHUB_CONNECTOR_CLIENT_SECRET", "csec")
    monkeypatch.setenv("CLAWBITS_BASE_URL", "http://localhost:5173")
    monkeypatch.setenv("CLAWBITS_FRONTEND_URL", "http://localhost:5173")

    token, user = login_human(test_client, "connectors-cb@clawbits.ai")
    state = f"ghlink.{user['id']}.testcsrf"
    profile = _fake_github_profile(external_id="888", handle="othermail-gh")

    with patch(
        "clawbits.fastapi.connectors_endpoints.exchange_code_for_profile",
        new=AsyncMock(return_value=profile),
    ):
        r = test_client.get(
            "/api/auth/connectors/github/callback",
            params={"code": "abc", "state": state},
            headers=auth_headers(token),
            cookies={CONNECTOR_OAUTH_STATE_COOKIE: state},
            follow_redirects=False,
        )
    assert r.status_code == 302, r.text
    assert "connected=github" in r.headers["location"]

    with Session(test_client.app._engine) as db:
        row = TableRead.get_human_connector(db, int(user["id"]), "github")
        assert row is not None
        assert row["handle"] == "othermail-gh"
        assert row["external_id"] == "888"


def test_github_link_callback_rejects_state_mismatch(
    test_client: TestClient, monkeypatch,
):
    monkeypatch.setenv("GITHUB_CONNECTOR_CLIENT_ID", "cid")
    monkeypatch.setenv("GITHUB_CONNECTOR_CLIENT_SECRET", "csec")
    token, user = login_human(test_client, "connectors-badstate@clawbits.ai")
    state = f"ghlink.{user['id']}.good"
    r = test_client.get(
        "/api/auth/connectors/github/callback",
        params={"code": "abc", "state": state},
        headers=auth_headers(token),
        cookies={CONNECTOR_OAUTH_STATE_COOKIE: "ghlink.0.other"},
        follow_redirects=False,
    )
    assert r.status_code == 302
    assert "oauth_state_mismatch" in r.headers["location"]


def test_disconnect_github(test_client: TestClient):
    token, user = login_human(test_client, "connectors-disc@clawbits.ai")
    with Session(test_client.app._engine) as db:
        TableWrite.upsert_human_connector(
            db,
            human_id=int(user["id"]),
            provider="github",
            external_id="1",
            handle="bye",
        )
        db.commit()

    r = test_client.delete(
        "/api/human/connectors/github",
        headers=auth_headers(token),
    )
    assert r.status_code == 204, r.text

    with Session(test_client.app._engine) as db:
        assert TableRead.get_human_connector(db, int(user["id"]), "github") is None


def test_connector_external_id_collision(test_client: TestClient):
    token_a, user_a = login_human(test_client, "connectors-a@clawbits.ai")
    token_b, user_b = login_human(test_client, "connectors-b@clawbits.ai")

    with Session(test_client.app._engine) as db:
        TableWrite.upsert_human_connector(
            db,
            human_id=int(user_a["id"]),
            provider="github",
            external_id="777",
            handle="alicegh",
        )
        db.commit()

    with Session(test_client.app._engine) as db:
        try:
            TableWrite.upsert_human_connector(
                db,
                human_id=int(user_b["id"]),
                provider="github",
                external_id="777",
                handle="bobgh",
            )
            raise AssertionError("expected collision")
        except ValueError as exc:
            assert str(exc).startswith("connector_external_id_taken:")

    with patch(
        "clawbits.fastapi.connectors_endpoints.profile_from_workos_identities",
        new=AsyncMock(return_value=_fake_github_profile(external_id="777", handle="bobgh")),
    ):
        r = test_client.post(
            "/api/human/connectors/github/connect",
            headers=auth_headers(token_b),
        )
    assert r.status_code == 409, r.text

    with patch(
        "clawbits.fastapi.connectors_endpoints.profile_from_workos_identities",
        new=AsyncMock(return_value=_fake_github_profile(external_id="777", handle="alicegh")),
    ):
        r = test_client.post(
            "/api/human/connectors/github/connect",
            headers=auth_headers(token_a),
        )
    assert r.status_code == 200, r.text


def test_coming_soon_provider_rejects_connect(test_client: TestClient):
    token, _ = login_human(test_client, "connectors-soon@clawbits.ai")
    r = test_client.post(
        "/api/human/connectors/notion/connect",
        headers=auth_headers(token),
    )
    assert r.status_code == 400


def test_list_shows_connected_status(test_client: TestClient):
    token, user = login_human(test_client, "connectors-listed@clawbits.ai")
    with Session(test_client.app._engine) as db:
        TableWrite.upsert_human_connector(
            db,
            human_id=int(user["id"]),
            provider="github",
            external_id="55",
            handle="listed",
        )
        db.commit()

    r = test_client.get("/api/human/connectors", headers=auth_headers(token))
    assert r.status_code == 200, r.text
    github = next(c for c in r.json()["connectors"] if c["provider"] == "github")
    assert github["status"] == "connected"
    assert github["handle"] == "listed"
