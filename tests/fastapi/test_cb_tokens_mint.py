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

from datetime import UTC, datetime, timedelta

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


def _reset_mint_window(engine, agent_id: str) -> None:
    """Clear the rolling-window meter.

    Agent creation runs a full handshake, which spends a whole window budget.
    Tests that want to observe a *fresh* window have to say so explicitly —
    ``_set_balance`` only moves the balance, on purpose, because conflating the
    two would hide exactly the coupling these tests exist to check.
    """
    with Session(engine) as db:
        agent = db.get(Agent, agent_id)
        agent.cb_tokens_minted_window_start = None
        agent.cb_tokens_minted_in_window = 0
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
    """Minting still has to work — but only within the window budget.

    The fixture already spent one full ceiling of budget minting this agent at
    signup, so a same-window top-up after spending adds nothing. That is the
    point: it is what stops write -> handshake -> refill from looping.
    """
    agent_id = test_client.agent_id
    _set_balance(_test_engine, agent_id, 4_000)
    resp = _handshake(test_client, api_key)

    assert resp["minted"] == 0, "budget for this window was already spent at signup"
    assert resp["new_balance"] == 4_000
    assert _balance(_test_engine, agent_id) == 4_000


def test_spend_then_refill_loop_is_bounded(_test_engine, create_agent_and_key):
    """The attack the ceiling alone did not stop.

    With only a balance cap, an agent could spend, replay the free handshake,
    top back up, and repeat forever — bounding what it *holds* while leaving
    what it *spends* unbounded. Metering the mint is what closes it.
    """
    agent_id, _ = create_agent_and_key
    _set_balance(_test_engine, agent_id.value, 0)
    _reset_mint_window(_test_engine, agent_id.value)

    with Session(_test_engine) as db:
        _, first = TableWrite.mint_cb_tokens(db, agent_id, CEILING)
        db.commit()
    assert first == CEILING, "the first mint of the window fills the tank"

    # Now burn tokens and try to refill, repeatedly, inside the same window.
    total_refilled = 0
    for _ in range(5):
        _set_balance(_test_engine, agent_id.value, 0)
        with Session(_test_engine) as db:
            balance, minted = TableWrite.mint_cb_tokens(db, agent_id, CEILING)
            db.commit()
        total_refilled += minted
        assert minted == 0
        assert balance == 0, "drained agent stays drained until the window rolls"

    assert total_refilled == 0, "no tokens may be minted beyond the window budget"


def test_window_rolls_over(_test_engine, create_agent_and_key):
    """Once the window elapses the budget is fresh again — this is a rate
    limit, not a lifetime cap, so a legitimate long-lived agent recovers."""
    agent_id, _ = create_agent_and_key
    _set_balance(_test_engine, agent_id.value, 0)
    _reset_mint_window(_test_engine, agent_id.value)
    t0 = datetime(2026, 8, 19, 12, 0, tzinfo=UTC)

    with Session(_test_engine) as db:
        assert TableWrite.mint_cb_tokens(db, agent_id, CEILING, now=t0)[1] == CEILING
        db.commit()

    # Spend it all; still inside the window, so no refill.
    _set_balance(_test_engine, agent_id.value, 0)
    with Session(_test_engine) as db:
        assert TableWrite.mint_cb_tokens(
            db, agent_id, CEILING, now=t0 + timedelta(hours=23, minutes=59)
        )[1] == 0
        db.commit()

    # Just past the window: full budget again.
    with Session(_test_engine) as db:
        balance, minted = TableWrite.mint_cb_tokens(
            db, agent_id, CEILING, now=t0 + timedelta(hours=24, seconds=1)
        )
        db.commit()
    assert (balance, minted) == (CEILING, CEILING)


def test_partial_budget_is_respected(_test_engine, create_agent_and_key):
    """A top-up larger than the remaining budget is truncated, not refused."""
    agent_id, _ = create_agent_and_key
    _set_balance(_test_engine, agent_id.value, 0)
    _reset_mint_window(_test_engine, agent_id.value)
    t0 = datetime(2026, 8, 19, 12, 0, tzinfo=UTC)

    with Session(_test_engine) as db:
        TableWrite.mint_cb_tokens(db, agent_id, CEILING, window_budget=1_000, now=t0)
        db.commit()
    assert _balance(_test_engine, agent_id.value) == 1_000

    _set_balance(_test_engine, agent_id.value, 400)
    with Session(_test_engine) as db:
        balance, minted = TableWrite.mint_cb_tokens(
            db, agent_id, CEILING, window_budget=1_000, now=t0 + timedelta(minutes=1)
        )
        db.commit()
    assert (balance, minted) == (400, 0), "budget already spent this window"


def test_minted_is_the_delta_not_the_ceiling(_test_engine, create_agent_and_key):
    """``minted`` is computed under the row lock, inside mint_cb_tokens.

    It used to be derived by the caller from a balance read *before* the lock
    was taken, so two concurrent handshakes could both claim to have added the
    full amount when only one of them did.
    """
    agent_id, _ = create_agent_and_key
    _set_balance(_test_engine, agent_id.value, 0)
    _reset_mint_window(_test_engine, agent_id.value)
    with Session(_test_engine) as db:
        assert TableWrite.mint_cb_tokens(db, agent_id, CEILING) == (CEILING, CEILING)
        db.commit()
    # Second call adds nothing, and says so.
    with Session(_test_engine) as db:
        assert TableWrite.mint_cb_tokens(db, agent_id, CEILING) == (CEILING, 0)
        db.commit()
    # Partial top-up reports only what it added (fresh window, so there is
    # budget available to add it from).
    _set_balance(_test_engine, agent_id.value, CEILING - 250)
    _reset_mint_window(_test_engine, agent_id.value)
    with Session(_test_engine) as db:
        assert TableWrite.mint_cb_tokens(db, agent_id, CEILING) == (CEILING, 250)
        db.commit()


def test_mint_never_lowers_a_balance(_test_engine, create_agent_and_key):
    """A balance somehow above the ceiling is left alone rather than clawed back."""
    agent_id, _ = create_agent_and_key
    _set_balance(_test_engine, agent_id.value, CEILING * 2)
    with Session(_test_engine) as db:
        assert TableWrite.mint_cb_tokens(db, agent_id, CEILING) == (CEILING * 2, 0)
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
