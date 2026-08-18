"""CB_TOKENS minting is a *ceiling*, not a faucet.

The proof-of-cognition handshake is repeatable and free on both legs — the
challenge is a GET (the billing middleware only charges writes) and
``challenge_response`` is billing-exempt — and the answers ship to clients in
``clawbits/datastructures/known_answers.py``. So the only thing keeping an
authenticated agent from minting its way out of the write charge is that
minting tops the balance *up to* a ceiling instead of adding to it. These
tests pin that.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session

from clawbits.datastructures.agent_id import AgentId
from clawbits.datastructures.known_answers import get_answer_for_question
from clawbits.db.models import Agent
from clawbits.db.table_write import TableWrite
from clawbits.fastapi.clawbits_server import ClawBitsServer
from tests.fastapi._auth_helpers import auth_headers

CEILING = ClawBitsServer.CB_TOKENS_BALANCE_CEILING


def _handshake(test_client: TestClient, api_key: str) -> dict:
    """One full challenge → response round trip. Returns the mint response."""
    challenge = test_client.get(
        "/api/agentic/auth/challenge", headers=auth_headers(api_key)
    )
    assert challenge.status_code == 200, challenge.text
    body = challenge.json()
    resp = test_client.post(
        "/api/agentic/auth/challenge_response",
        headers=auth_headers(api_key),
        json={
            "session_token": body["session_token"],
            "challenge_response": get_answer_for_question(body["challenge"]),
        },
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def _balance(engine, agent_id: str) -> int:
    with Session(engine) as db:
        return db.get(Agent, agent_id).cb_tokens


def _set_balance(engine, agent_id: str, value: int) -> None:
    with Session(engine) as db:
        agent = db.get(Agent, agent_id)
        agent.cb_tokens = value
        db.add(agent)
        db.commit()


def test_repeat_handshake_does_not_stack(test_client: TestClient, api_key, _test_engine):
    """The whole point: repeat handshakes converge, they do not accumulate.

    The ``api_key`` fixture already runs one handshake as part of agent
    creation, so the agent arrives here at the ceiling — which is precisely
    the state an attacker would be replaying from.
    """
    agent_id = test_client.agent_id
    assert _balance(_test_engine, agent_id) == CEILING

    resp = _handshake(test_client, api_key)
    assert resp["minted"] == 0, "a repeat handshake must add nothing"
    assert resp["new_balance"] == CEILING
    assert _balance(_test_engine, agent_id) == CEILING

    # ...and it stays flat no matter how many times it is replayed. Each pass
    # is a fresh challenge, so the per-session single-use guard never fires.
    for _ in range(3):
        assert _handshake(test_client, api_key)["minted"] == 0
    assert _balance(_test_engine, agent_id) == CEILING


def test_handshake_tops_up_a_drained_balance(test_client: TestClient, api_key, _test_engine):
    """Minting still has to work — it restores exactly to the ceiling."""
    agent_id = test_client.agent_id
    _set_balance(_test_engine, agent_id, 4_000)
    resp = _handshake(test_client, api_key)

    assert resp["minted"] == CEILING - 4_000
    assert resp["new_balance"] == CEILING
    assert _balance(_test_engine, agent_id) == CEILING


def test_mint_never_lowers_a_balance(_test_engine, create_agent_and_key):
    """A balance somehow above the ceiling is left alone rather than clawed back."""
    agent_id, _ = create_agent_and_key
    _set_balance(_test_engine, agent_id.value, CEILING * 2)
    with Session(_test_engine) as db:
        assert TableWrite.mint_cb_tokens(db, agent_id, CEILING) == CEILING * 2
        db.commit()
    assert _balance(_test_engine, agent_id.value) == CEILING * 2


@pytest.mark.parametrize("ceiling", [0, -1, -CEILING])
def test_mint_rejects_non_positive_ceiling(_test_engine, create_agent_and_key, ceiling):
    """``charge_cb_tokens`` has always validated its amount; ``mint`` did not."""
    agent_id, _ = create_agent_and_key
    with Session(_test_engine) as db:
        with pytest.raises(ValueError, match="positive"):
            TableWrite.mint_cb_tokens(db, agent_id, ceiling)


def test_mint_rejects_unknown_agent(_test_engine):
    with Session(_test_engine) as db:
        with pytest.raises(ValueError, match="not found"):
            TableWrite.mint_cb_tokens(db, AgentId("agent_does_not_exist"), CEILING)
