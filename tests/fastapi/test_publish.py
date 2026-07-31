import os
from unittest.mock import patch

from fastapi.testclient import TestClient

from clawbits.datastructures.known_answers import get_answer_for_question
from clawbits.fastapi.clawbits_server import ClawBitsServer
from tests.fastapi._db_helpers import ephemeral_database


def _solve_challenge(test_client, api_key: str) -> dict:
    resp = test_client.get(
        "/api/agentic/auth/challenge",
        headers={"Authorization": f"Bearer {api_key}"},
    )
    data = resp.json()
    answer = get_answer_for_question(data["challenge"])
    return {"session_token": data["session_token"], "answer": answer}


def test_publish_file_success(test_client, api_key):
    filename = "test.pdf"
    file_content = b"%PDF-1.4 mock content"

    resp = test_client.put(
        f"/api/agentic/shared_content/{filename}",
        content=file_content,
        headers={
            "Authorization": f"Bearer {api_key}",
            **_solve_challenge(test_client, api_key),
        },
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["name"] == filename
    assert data["status"] == "uploaded"
    assert "url" in data
    assert data["agent_id"] == test_client.agent_id

    # Verify file is published using client API (GET)
    get_resp = test_client.get(
        f"/api/agentic/shared_content/{filename}",
        headers={
            "Authorization": f"Bearer {api_key}",
            **_solve_challenge(test_client, api_key),
        },
    )
    assert get_resp.status_code == 200
    # Optionally, check content if API returns file content
    if hasattr(get_resp, 'content'):
        assert get_resp.content == file_content
    # Or check metadata if API returns JSON
    if get_resp.headers.get('content-type', '').startswith('application/json'):
        meta = get_resp.json()
        assert meta["name"] == filename
        assert meta["status"] == "uploaded"
        assert meta["agent_id"] == test_client.agent_id


def test_overwrite_file_success(test_client, api_key):
    """Test that PUT overwrites an existing file (idempotent upload)."""
    filename = "test.pdf"
    file_content = b"updated content"

    resp = test_client.put(
        f"/api/agentic/shared_content/{filename}",
        content=file_content,
        headers={
            "Authorization": f"Bearer {api_key}",
            **_solve_challenge(test_client, api_key),
        },
    )

    assert resp.status_code == 200
    data = resp.json()
    assert data["name"] == filename
    assert data["status"] == "uploaded"
    assert "url" in data
    assert data["agent_id"] == test_client.agent_id

    # Now delete the file
    del_resp = test_client.delete(
        f"/api/agentic/shared_content/{filename}",
        headers={
            "Authorization": f"Bearer {api_key}",
            **_solve_challenge(test_client, api_key),
        },
    )
    assert del_resp.status_code == 200
    del_data = del_resp.json()
    assert del_data["status"] == "deleted"
    assert del_data["agent_id"] == test_client.agent_id

    # Verify file has been deleted using API (should return 404)
    get_resp = test_client.get(
        f"/api/agentic/shared_content/{filename}",
        headers={
            "Authorization": f"Bearer {api_key}",
            **_solve_challenge(test_client, api_key),
        },
    )
    assert get_resp.status_code == 404


def test_delete_file_success(test_client, api_key):
    filename = "test.pdf"
    file_content = b"file to delete"

    # First upload a real file
    upload_resp = test_client.put(
        f"/api/agentic/shared_content/{filename}",
        content=file_content,
        headers={
            "Authorization": f"Bearer {api_key}",
            **_solve_challenge(test_client, api_key),
        },
    )
    assert upload_resp.status_code == 200

    # Now delete it
    resp = test_client.delete(
        f"/api/agentic/shared_content/{filename}",
        headers={
            "Authorization": f"Bearer {api_key}",
            **_solve_challenge(test_client, api_key),
        },
    )

    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "deleted"
    assert data["agent_id"] == test_client.agent_id

    # Verify file has been deleted using API (should return 404)
    get_resp = test_client.get(
        f"/api/agentic/shared_content/{filename}",
        headers={
            "Authorization": f"Bearer {api_key}",
            **_solve_challenge(test_client, api_key),
        },
    )
    assert get_resp.status_code == 404


def test_multiple_publish_delete_cycles(test_client, api_key):
    filename = "repeat.txt"

    # Cycle 1: Upload then Delete
    resp = test_client.put(
        f"/api/agentic/shared_content/{filename}",
        content=b"content 1",
        headers={
            "Authorization": f"Bearer {api_key}",
            **_solve_challenge(test_client, api_key),
        },
    )
    assert resp.status_code == 200
    assert resp.json()["status"] == "uploaded"

    resp = test_client.delete(
        f"/api/agentic/shared_content/{filename}",
        headers={
            "Authorization": f"Bearer {api_key}",
            **_solve_challenge(test_client, api_key),
        },
    )
    assert resp.status_code == 200
    assert resp.json()["status"] == "deleted"

    # Cycle 2: Upload then Delete
    resp = test_client.put(
        f"/api/agentic/shared_content/{filename}",
        content=b"content 2",
        headers={
            "Authorization": f"Bearer {api_key}",
            **_solve_challenge(test_client, api_key),
        },
    )
    assert resp.status_code == 200
    assert resp.json()["status"] == "uploaded"

    resp = test_client.delete(
        f"/api/agentic/shared_content/{filename}",
        headers={
            "Authorization": f"Bearer {api_key}",
            **_solve_challenge(test_client, api_key),
        },
    )
    assert resp.status_code == 200
    assert resp.json()["status"] == "deleted"

    # Verify file has been deleted using API (should return 404)
    get_resp = test_client.get(
        f"/api/agentic/shared_content/{filename}",
        headers={
            "Authorization": f"Bearer {api_key}",
            **_solve_challenge(test_client, api_key),
        },
    )
    assert get_resp.status_code == 404



def test_publish_file_unauthorized(test_client, api_key):
    resp = test_client.put(
        "/api/agentic/shared_content/test.pdf",
        content=b"some content",
        headers={"Authorization": "Bearer invalid_key"},
    )
    assert resp.status_code == 401


def test_publish_file_config_missing():
    # Test that publishing fails when Cloudflare R2 is not configured.
    with patch.dict(os.environ, {}, clear=True), \
         patch("dotenv.load_dotenv", return_value=None):
        with ephemeral_database() as test_url:
            test_app_no_config = ClawBitsServer(database_url=test_url)
            from clawbits.fastapi.human_endpoints import human_router
            from clawbits.fastapi.workos_auth import cookie_password, workos_router
            from tests.fastapi._fakes import FakeWorkOSClient

            test_app_no_config.include_router(workos_router)
            test_app_no_config.include_router(human_router)
            # Env was cleared above, so make_workos_client() returned None.
            # Wire the in-memory fake so the auth + provisioning paths work.
            test_app_no_config.state.workos = FakeWorkOSClient(
                cookie_password=cookie_password()
            )
            # Bring the schema up — production runs alembic from the
            # Dockerfile entrypoint before uvicorn forks; this test
            # bypasses that by constructing the app directly, so we run
            # the upgrade ourselves before connecting.
            from clawbits.db.engine import run_alembic_upgrade_head
            run_alembic_upgrade_head()
            # No lifespan on this app — connect the DB explicitly.
            test_app_no_config._connect_db()
            try:
                with TestClient(test_app_no_config) as client_no_config:
                    from tests.fastapi._auth_helpers import signup_agent_via_email
                    submit_resp = signup_agent_via_email(client_no_config, "stan@clawbits.ai")
                    challenge = submit_resp.json()
                    answer = get_answer_for_question(challenge["challenge"])
                    commit_resp = client_no_config.post(
                        "/api/agentic/signup-commit",
                        json={
                            "session_token": challenge["session_token"],
                            "challenge_response": answer,
                        },
                    )
                    assert commit_resp.status_code == 200, commit_resp.text
                    data = commit_resp.json()
                    new_api_key = data["api_key"]

                    # Auto-approve signup request
                    from tests.fastapi.approve_helper import _approve_signup
                    _approve_signup(client_no_config, data)

                    mint_headers = _solve_challenge(client_no_config, new_api_key)
                    mint_resp = client_no_config.post(
                        "/api/agentic/auth/challenge_response",
                        headers={
                            "Authorization": f"Bearer {new_api_key}",
                        },
                        json={
                            "session_token": mint_headers["session_token"],
                            "challenge_response": mint_headers["answer"],
                        },
                    )
                    assert mint_resp.status_code == 200, mint_resp.text

                    challenge_headers = _solve_challenge(client_no_config, new_api_key)
                    resp = client_no_config.put(
                        "/api/agentic/shared_content/test.pdf",
                        content=b"some content",
                        headers={
                            "Authorization": f"Bearer {new_api_key}",
                            **challenge_headers,
                        },
                    )
                    assert resp.status_code == 503
                    assert "File storage service unavailable" in resp.json()["detail"]
            finally:
                test_app_no_config.shutdown()
