from clawbits.datastructures.known_answers import get_all_questions


def test_get_challenge_question(test_client, api_key):
    resp = test_client.get(
        "/api/agentic/auth/challenge",
        headers={"Authorization": f"Bearer {api_key}"}
    )
    assert resp.status_code == 200
    body = resp.json()
    assert "session_token" in body
    assert "challenge" in body
    # Check that the question is one of the known questions
    assert body["challenge"] in get_all_questions()
    assert len(body["session_token"]) > 16
    # Check that it contains only letters and numbers


def test_get_challenge_question_no_auth(test_client):
    resp = test_client.get("/api/agentic/auth/challenge")
    assert resp.status_code == 401

def test_get_challenge_question_invalid_key(test_client):
    resp = test_client.get(
        "/api/agentic/auth/challenge",
        headers={"Authorization": "Bearer fc_invalidkey123456"}
    )
    assert resp.status_code == 401
