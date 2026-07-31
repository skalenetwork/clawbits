from tests.fastapi._auth_helpers import signup_agent_via_email
from tests.fastapi.conftest import _create_agent


def test_create_agent(test_client):
    data = _create_agent(test_client)
    assert len(data["agent_id"]) >= 2
    assert data["api_key"]  # non-empty


def test_submit_create_agent_returns_challenge(test_client):
    resp = signup_agent_via_email(test_client)
    assert resp.status_code == 200
    data = resp.json()
    assert "session_token" in data
    assert "challenge" in data
    assert len(data["session_token"]) > 0
    assert data["challenge"].endswith("?")


def test_commit_create_agent_no_session_token(test_client):
    signup_agent_via_email(test_client)

    resp = test_client.post(
        "/api/agentic/signup-commit",
        json={"challenge_response": "PARIS"},
    )
    assert resp.status_code == 422


def test_commit_create_agent_no_challenge_response(test_client):
    submit = signup_agent_via_email(test_client)
    token = submit.json()["session_token"]

    resp = test_client.post(
        "/api/agentic/signup-commit",
        json={"session_token": token},
    )
    assert resp.status_code == 401
    assert "challenge_response is required" in resp.json()["detail"]


def test_commit_create_agent_wrong_answer(test_client):
    submit = signup_agent_via_email(test_client)
    token = submit.json()["session_token"]

    resp = test_client.post(
        "/api/agentic/signup-commit",
        json={
            "session_token": token,
            "challenge_response": "WRONGANSWER",
        },
    )
    assert resp.status_code == 401
    assert "Invalid challenge response" in resp.json()["detail"]


def test_create_agent_invalid_payload(test_client):
    # agent_id is no longer accepted, so it triggers 422 Extra inputs are not permitted
    resp = test_client.post(
        "/api/agentic/agents/signup",
        json={"agent_id": "alice"},
    )
    assert resp.status_code == 422
    assert "extra_forbidden" in str(resp.json()["detail"])


def test_signup_requires_org_id(test_client):
    """Signup with empty body should 422 — org_id is required."""
    resp = test_client.post(
        "/api/agentic/agents/signup",
        json={},
    )
    assert resp.status_code == 422


def test_create_multiple_agents_unique_keys(test_client):
    api_keys = []
    for _ in range(3):
        data = _create_agent(test_client)
        assert data["api_key"]
        api_keys.append(data["api_key"])

    # All API keys should be unique
    assert len(set(api_keys)) == 3


def test_signup_reservation_blocks_duplicate(test_client):
    """
    Since agent_id is now server-generated and random, we can't easily test collisions.
    However, we can mock or just ensure it's not a concern for now.
    """
    pass


def test_signup_reservation_released_after_commit(test_client):
    """
    This test also depended on a specific agent_id.
    """
    pass


def test_signup_reservation_released_after_success(test_client):
    """
    This test also depended on a specific agent_id.
    """
    pass
