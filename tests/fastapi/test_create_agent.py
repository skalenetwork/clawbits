from sqlmodel import Session

from clawbits.datastructures.agent_id import AgentId
from clawbits.datastructures.nickname import NickName
from clawbits.db.models import Agent
from clawbits.db.table_read import TableRead
from clawbits.db.table_write import TableWrite
from tests.fastapi._auth_helpers import (
    auth_headers,
    login_human,
    personal_org_id,
    signup_agent_via_email,
)
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


def _mint(test_client, token: str) -> dict:
    r = test_client.post(
        "/api/human/agent_signup",
        json={"org_id": personal_org_id(test_client, token)},
        headers=auth_headers(token),
    )
    assert r.status_code == 200, r.text
    return r.json()


def _commit(test_client, minted: dict):
    return test_client.post(
        "/api/agentic/signup-commit",
        json={"session_token": minted["session_token"], "challenge_response": ""},
    )


def test_human_signup_picks_the_id_at_mint(test_client, _test_engine):
    """The id and nickname are known before the agent exists; commit takes them."""
    token, _ = login_human(test_client)
    minted = _mint(test_client, token)
    r = _commit(test_client, minted)
    assert r.status_code == 200, r.text
    assert r.json()["agent_id"] == minted["agent_id"]
    with Session(_test_engine) as db:
        assert db.get(Agent, minted["agent_id"]).nickname == minted["nickname"]


def test_an_unspent_session_holds_its_id(test_client, monkeypatch):
    """One name in the pool still yields distinct ids: a picked id is held
    until its session is spent or dies."""
    monkeypatch.setattr(test_client.app, "_bot_names", {"Ana": "Ana"})
    token, _ = login_human(test_client)
    first, second = _mint(test_client, token), _mint(test_client, token)
    assert first["agent_id"] == "Ana"
    assert second["agent_id"] != "Ana" and second["agent_id"].startswith("Ana")


def test_a_mint_that_loses_the_race_for_its_id_draws_again(test_client, monkeypatch):
    """The check can miss a concurrent mint of the same id; the unique index
    refuses the second session, which draws again."""
    monkeypatch.setattr(test_client.app, "_bot_names", {"Race": "Race"})
    token, _ = login_human(test_client)
    first = _mint(test_client, token)
    taken, missed = TableRead.is_agent_id_taken, []

    def racing(db, agent_id: str) -> bool:
        if missed:
            return taken(db, agent_id)
        missed.append(agent_id)
        return False

    monkeypatch.setattr(TableRead, "is_agent_id_taken", racing)
    second = _mint(test_client, token)
    assert missed == ["Race"]
    assert second["agent_id"] not in {"Race", first["agent_id"]}


def test_commit_redraws_an_id_an_agent_took_meanwhile(test_client, _test_engine):
    token, _ = login_human(test_client)
    minted = _mint(test_client, token)
    with Session(_test_engine) as db:
        TableWrite.create_agent(db, AgentId(minted["agent_id"]), NickName(minted["nickname"]))
        db.commit()
    r = _commit(test_client, minted)
    assert r.status_code == 200, r.text
    assert r.json()["agent_id"] != minted["agent_id"]
