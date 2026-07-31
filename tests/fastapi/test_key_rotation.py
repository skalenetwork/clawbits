from fastapi.testclient import TestClient

from clawbits.datastructures.agent_id import AgentId
from clawbits.datastructures.api_key import ApiKey


def test_rotate_api_key_two_step_success(test_client: TestClient, create_agent_and_key: tuple[AgentId, ApiKey]):
    """Test successful two-step API key rotation."""
    agent_id, old_api_key = create_agent_and_key

    # Step 1: Request rotation — generates new key, old key still works
    response = test_client.post(
        "/api/agentic/auth/rotate-key",
        headers={
            "Authorization": f"Bearer {old_api_key.value}",
        },
    )
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["agent_id"] == agent_id.value
    new_api_key = ApiKey(data["new_api_key"])
    assert new_api_key.value != old_api_key.value

    # Old key should STILL work (not committed yet)
    resp = test_client.get(
        "/api/agentic/auth/challenge",
        headers={"Authorization": f"Bearer {old_api_key.value}"},
    )
    assert resp.status_code == 200, "Old key should still work before commit"

    # Step 2: Commit rotation — send new key in body
    response = test_client.post(
        "/api/agentic/auth/rotate-key/commit",
        json={"new_api_key": new_api_key.value},
        headers={"Authorization": f"Bearer {old_api_key.value}"},
    )
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["agent_id"] == agent_id.value
    assert data["new_api_key"] == new_api_key.value

    # Old key should now be invalid
    resp = test_client.get(
        "/api/agentic/auth/challenge",
        headers={"Authorization": f"Bearer {old_api_key.value}"},
    )
    assert resp.status_code == 401, "Old key should be invalid after commit"

    # New key should work
    resp = test_client.get(
        "/api/agentic/auth/challenge",
        headers={"Authorization": f"Bearer {new_api_key.value}"},
    )
    assert resp.status_code == 200, "New key should work after commit"


def test_rotate_api_key_commit_wrong_key(test_client: TestClient, create_agent_and_key: tuple[AgentId, ApiKey]):
    """Test that committing with the wrong new key fails."""
    agent_id, old_api_key = create_agent_and_key

    # Step 1: Request rotation
    response = test_client.post(
        "/api/agentic/auth/rotate-key",
        headers={
            "Authorization": f"Bearer {old_api_key.value}",
        },
    )
    assert response.status_code == 200

    # Step 2: Commit with wrong key in body
    wrong_key = ApiKey.generate().value
    response = test_client.post(
        "/api/agentic/auth/rotate-key/commit",
        json={"new_api_key": wrong_key},
        headers={"Authorization": f"Bearer {old_api_key.value}"},
    )
    assert response.status_code == 401, response.text
    assert "does not match" in response.json()["detail"]

    # Old key should still work (commit failed)
    resp = test_client.get(
        "/api/agentic/auth/challenge",
        headers={"Authorization": f"Bearer {old_api_key.value}"},
    )
    assert resp.status_code == 200, "Old key should still work after failed commit"


def test_rotate_api_key_commit_without_request(test_client: TestClient, create_agent_and_key: tuple[AgentId, ApiKey]):
    """Test that committing without a prior request fails."""
    agent_id, old_api_key = create_agent_and_key

    response = test_client.post(
        "/api/agentic/auth/rotate-key/commit",
        json={"new_api_key": ApiKey.generate().value},
        headers={"Authorization": f"Bearer {old_api_key.value}"},
    )
    assert response.status_code == 404, response.text
    assert "No pending" in response.json()["detail"]


def test_rotate_api_key_invalid_key(test_client: TestClient):
    """Test API key rotation with an invalid key."""
    invalid_key = "fc_invalidkey12345"
    response = test_client.post(
        "/api/agentic/auth/rotate-key",
        headers={
            "Authorization": f"Bearer {invalid_key}",
        },
    )
    assert response.status_code in (401, 404), response.text

    non_existent_key = ApiKey.generate()
    response = test_client.post(
        "/api/agentic/auth/rotate-key",
        headers={
            "Authorization": f"Bearer {non_existent_key.value}",
        },
    )
    assert response.status_code in (401, 404), response.text


def test_rotate_commit_lands_on_second_worker(
    test_client: TestClient,
    create_agent_and_key: tuple[AgentId, ApiKey],
    _test_engine,
):
    """Regression: the pending rotation must survive crossing worker processes.

    Production runs several uvicorn workers, so the rotate and commit requests
    usually land on different ones. Simulate that with a second, freshly
    constructed server instance sharing the same database — with the old
    in-memory ``_pending_rotations`` dict this commit 404'd."""
    import hashlib

    from sqlalchemy import text

    from clawbits.fastapi.clawbits_server import ClawBitsServer
    from tests.fastapi._db_helpers import TEST_DATABASE_URL

    agent_id, old_api_key = create_agent_and_key

    # Step 1: rotate on "worker A" (the shared session app).
    resp = test_client.post(
        "/api/agentic/auth/rotate-key",
        headers={"Authorization": f"Bearer {old_api_key.value}"},
    )
    assert resp.status_code == 200, resp.text
    new_api_key = resp.json()["new_api_key"]

    # The pending candidate is persisted on the agent row — hashed, never
    # in plaintext.
    with _test_engine.begin() as conn:
        row = conn.execute(
            text(
                "SELECT pending_api_key_hash, pending_key_expires_at "
                "FROM agents WHERE agent_id = :aid"
            ),
            {"aid": agent_id.value},
        ).one()
    assert row.pending_api_key_hash == hashlib.sha256(new_api_key.encode()).hexdigest()
    assert row.pending_key_expires_at is not None

    # Step 2: commit on "worker B" — a separate app instance, separate RAM.
    worker_b = ClawBitsServer(database_url=TEST_DATABASE_URL)
    worker_b._connect_db()
    try:
        with TestClient(worker_b) as client_b:
            resp = client_b.post(
                "/api/agentic/auth/rotate-key/commit",
                json={"new_api_key": new_api_key},
                headers={"Authorization": f"Bearer {old_api_key.value}"},
            )
            assert resp.status_code == 200, resp.text
    finally:
        worker_b._engine.dispose()

    # The swap is visible from worker A: new key live, old key dead,
    # pending state cleared.
    resp = test_client.get(
        "/api/agentic/auth/challenge",
        headers={"Authorization": f"Bearer {new_api_key}"},
    )
    assert resp.status_code == 200
    resp = test_client.get(
        "/api/agentic/auth/challenge",
        headers={"Authorization": f"Bearer {old_api_key.value}"},
    )
    assert resp.status_code == 401
    with _test_engine.begin() as conn:
        row = conn.execute(
            text("SELECT pending_api_key_hash FROM agents WHERE agent_id = :aid"),
            {"aid": agent_id.value},
        ).one()
    assert row.pending_api_key_hash is None


def test_rotate_commit_expired_pending(
    test_client: TestClient,
    create_agent_and_key: tuple[AgentId, ApiKey],
    _test_engine,
):
    """A pending rotation past its TTL is rejected with 410 and cleared;
    the old key keeps working."""
    from datetime import UTC, datetime, timedelta

    from sqlalchemy import text

    agent_id, old_api_key = create_agent_and_key

    resp = test_client.post(
        "/api/agentic/auth/rotate-key",
        headers={"Authorization": f"Bearer {old_api_key.value}"},
    )
    assert resp.status_code == 200, resp.text
    new_api_key = resp.json()["new_api_key"]

    # Age the pending rotation past its TTL directly in the DB.
    with _test_engine.begin() as conn:
        conn.execute(
            text(
                "UPDATE agents SET pending_key_expires_at = :past WHERE agent_id = :aid"
            ),
            {"past": datetime.now(UTC) - timedelta(minutes=1), "aid": agent_id.value},
        )

    resp = test_client.post(
        "/api/agentic/auth/rotate-key/commit",
        json={"new_api_key": new_api_key},
        headers={"Authorization": f"Bearer {old_api_key.value}"},
    )
    assert resp.status_code == 410, resp.text

    # The expired pending was cleared — a retry now 404s instead of 410ing.
    resp = test_client.post(
        "/api/agentic/auth/rotate-key/commit",
        json={"new_api_key": new_api_key},
        headers={"Authorization": f"Bearer {old_api_key.value}"},
    )
    assert resp.status_code == 404, resp.text

    # The old key never stopped working.
    resp = test_client.get(
        "/api/agentic/auth/challenge",
        headers={"Authorization": f"Bearer {old_api_key.value}"},
    )
    assert resp.status_code == 200


def test_rotate_full_cycle_then_rotate_again(test_client: TestClient, create_agent_and_key: tuple[AgentId, ApiKey]):
    """Test a full rotation cycle followed by another rotation with the new key."""
    agent_id, old_api_key = create_agent_and_key

    # First rotation
    resp = test_client.post(
        "/api/agentic/auth/rotate-key",
        headers={
            "Authorization": f"Bearer {old_api_key.value}",
        },
    )
    assert resp.status_code == 200
    new_key_1 = resp.json()["new_api_key"]

    resp = test_client.post(
        "/api/agentic/auth/rotate-key/commit",
        json={"new_api_key": new_key_1},
        headers={"Authorization": f"Bearer {old_api_key.value}"},
    )
    assert resp.status_code == 200

    # Second rotation with the new key
    resp = test_client.post(
        "/api/agentic/auth/rotate-key",
        headers={
            "Authorization": f"Bearer {new_key_1}",
        },
    )
    assert resp.status_code == 200
    new_key_2 = resp.json()["new_api_key"]
    assert new_key_2 != new_key_1

    resp = test_client.post(
        "/api/agentic/auth/rotate-key/commit",
        json={"new_api_key": new_key_2},
        headers={"Authorization": f"Bearer {new_key_1}"},
    )
    assert resp.status_code == 200

    # Only the latest key should work
    resp = test_client.get(
        "/api/agentic/auth/challenge",
        headers={"Authorization": f"Bearer {new_key_2}"},
    )
    assert resp.status_code == 200
