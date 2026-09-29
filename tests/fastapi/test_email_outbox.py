"""Keyed POST /email/send: the durable outbox state machine, billing and crash points.

SMTP and mailbox provisioning are patched out, so only Postgres is needed.
"""
import contextlib
import threading
from datetime import timedelta
from unittest.mock import patch

import pytest
from sqlmodel import Session, select, update

from clawbits.datastructures.email_models import EmailSendRequest
from clawbits.db.models import Agent, EmailDelivery
from clawbits.db.table_write import TableWrite
from clawbits.email.smtp_client import SmtpDeliveryError
from clawbits.fastapi.clawbits_server import ClawBitsServer
from clawbits.fastapi.email_endpoints import _payload_hash
from tests.fastapi._auth_helpers import auth_headers, login_human, personal_org_id
from tests.fastapi.conftest import _create_agent

EP = "clawbits.fastapi.email_endpoints"
WRITE_COST = ClawBitsServer.AGENTIC_WRITE_CB_TOKENS_COST
OWNER = "stan@clawbits.ai"
BODY = {"subject": "Report", "message": "Done"}
LEASE = timedelta(minutes=10)


@pytest.fixture
def agent(test_client):
    return _create_agent(test_client, owner_email=OWNER)


@pytest.fixture
def smtp():
    with (
        patch(f"{EP}.provision_mailbox", return_value=True),
        patch(f"{EP}.smtp_send_email") as send,
    ):
        yield send


def _send(tc, agent: dict, key: str | None = None, body: dict = BODY):
    headers = {"Authorization": f"Bearer {agent['api_key']}"}
    if key is not None:
        headers["Idempotency-Key"] = key
    return tc.post(f"/api/agentic/agents/{agent['agent_id']}/email/send", json=body, headers=headers)


def _delivery(tc, agent: dict, key: str):
    return tc.get(
        f"/api/agentic/agents/{agent['agent_id']}/email/deliveries/{key}",
        headers={"Authorization": f"Bearer {agent['api_key']}"},
    )


def _tokens(engine, agent_id: str) -> int:
    with Session(engine) as db:
        return db.get(Agent, agent_id).cb_tokens


def _set_tokens(engine, agent_id: str, amount: int) -> None:
    with Session(engine) as db:
        row = db.get(Agent, agent_id)
        row.cb_tokens = amount
        db.add(row)
        db.commit()


def _rows(engine, agent_id: str) -> list[EmailDelivery]:
    with Session(engine) as db:
        return list(db.exec(select(EmailDelivery).where(EmailDelivery.agent_id == agent_id)))


def _create(engine, agent_id: str, key: str, *, to_addr: str = OWNER, claim: timedelta | None = None) -> int:
    """A delivery for BODY, as a crashed earlier request would have left it; optionally claimed."""
    with Session(engine) as db:
        row = TableWrite.create_email_delivery(
            db,
            agent_id=agent_id,
            idempotency_key=key,
            payload_hash=_payload_hash(EmailSendRequest(**BODY)),
            from_addr=f"{agent_id}@mail.test",
            to_addr=to_addr,
            subject=BODY["subject"],
            message_id=f"<{key}@mail.test>",
        )
        delivery_id = row.id
        db.commit()
        if claim is not None:
            assert TableWrite.claim_email_delivery(db, delivery_id, claim) == 1
            db.commit()
    return delivery_id


def _force(engine, delivery_id: int, **values) -> None:
    with Session(engine) as db:
        db.exec(update(EmailDelivery).where(EmailDelivery.id == delivery_id).values(**values))
        db.commit()


def test_legacy_send_unchanged(test_client, _test_engine, agent, smtp):
    before = _tokens(_test_engine, agent["agent_id"])
    r = _send(test_client, agent)
    assert r.status_code == 200, r.text
    assert set(r.json()) == {"status", "from_addr", "to_addr", "subject"}
    assert r.json()["status"] == "sent"
    assert _tokens(_test_engine, agent["agent_id"]) == before - WRITE_COST
    assert smtp.call_args.kwargs["message_id"] is None
    assert _rows(_test_engine, agent["agent_id"]) == []


def test_keyed_send_accepted_once_and_billed_once(test_client, _test_engine, agent, smtp):
    before = _tokens(_test_engine, agent["agent_id"])
    first = _send(test_client, agent, "reply-1")
    second = _send(test_client, agent, "reply-1")
    assert first.status_code == second.status_code == 200, first.text
    record = first.json()
    assert second.json()["delivery_id"] == record["delivery_id"]
    assert (record["state"], record["status"], record["attempts"]) == ("accepted", "sent", 1)
    assert record["to_addr"] == OWNER and record["idempotency_key"] == "reply-1"
    assert "error" not in record and "next_attempt_at" not in record
    smtp.assert_called_once()
    assert smtp.call_args.kwargs["message_id"] == record["message_id"]
    assert _tokens(_test_engine, agent["agent_id"]) == before - WRITE_COST
    assert _delivery(test_client, agent, "reply-1").json() == record


def test_keyed_send_changed_payload_409(test_client, _test_engine, agent, smtp):
    assert _send(test_client, agent, "k").status_code == 200
    before = _tokens(_test_engine, agent["agent_id"])
    r = _send(test_client, agent, "k", {**BODY, "message": "Different"})
    assert r.status_code == 409
    assert r.json()["detail"] == {"code": "idempotency_key_reused"}
    smtp.assert_called_once()
    assert _tokens(_test_engine, agent["agent_id"]) == before


@pytest.mark.parametrize("key", ["a/b", "x" * 129, ""])
def test_keyed_send_invalid_key_400_free(test_client, _test_engine, agent, smtp, key):
    before = _tokens(_test_engine, agent["agent_id"])
    r = _send(test_client, agent, key)
    assert r.status_code == 400
    assert r.json()["detail"] == {"code": "invalid_idempotency_key"}
    smtp.assert_not_called()
    assert _rows(_test_engine, agent["agent_id"]) == []
    assert _tokens(_test_engine, agent["agent_id"]) == before


def test_keyed_send_insufficient_balance_creates_no_record(test_client, _test_engine, agent, smtp):
    _set_tokens(_test_engine, agent["agent_id"], 0)
    assert _send(test_client, agent, "k").status_code == 402
    smtp.assert_not_called()
    missing = _delivery(test_client, agent, "k")
    assert missing.status_code == 404
    assert missing.json()["detail"] == {"code": "delivery_not_found"}

    _set_tokens(_test_engine, agent["agent_id"], 5 * WRITE_COST)
    r = _send(test_client, agent, "k")
    assert r.status_code == 200 and r.json()["state"] == "accepted"
    smtp.assert_called_once()
    assert _tokens(_test_engine, agent["agent_id"]) == 4 * WRITE_COST


def test_keyed_send_resumes_queued_record(test_client, _test_engine, agent, smtp):
    _create(_test_engine, agent["agent_id"], "k")
    before = _tokens(_test_engine, agent["agent_id"])
    r = _send(test_client, agent, "k")
    assert r.status_code == 200 and r.json()["state"] == "accepted"
    smtp.assert_called_once()
    assert smtp.call_args.kwargs["message_id"] == "<k@mail.test>"
    assert _tokens(_test_engine, agent["agent_id"]) == before


def test_expired_attempt_is_unknown_not_resent(test_client, _test_engine, agent, smtp):
    _create(_test_engine, agent["agent_id"], "k", claim=timedelta(seconds=-1))
    r = _send(test_client, agent, "k")
    assert r.status_code == 200
    assert (r.json()["state"], r.json()["status"], r.json()["error"]) == ("unknown", "unknown", "lease_expired")
    smtp.assert_not_called()
    assert _delivery(test_client, agent, "k").json()["state"] == "unknown"


def test_live_attempt_not_duplicated(test_client, _test_engine, agent, smtp):
    _create(_test_engine, agent["agent_id"], "k", claim=LEASE)
    r = _send(test_client, agent, "k")
    assert r.status_code == 200 and r.json()["state"] == "attempting"
    smtp.assert_not_called()


def test_ambiguous_smtp_outcome_stays_unknown(test_client, agent, smtp):
    smtp.side_effect = SmtpDeliveryError("unknown", "submission_interrupted")
    first = _send(test_client, agent, "k").json()
    assert (first["state"], first["error"]) == ("unknown", "submission_interrupted")
    again = _send(test_client, agent, "k").json()
    assert (again["state"], again["error"]) == ("unknown", "submission_interrupted")
    smtp.assert_called_once()


def test_retry_wait_backoff_limit_and_stable_message_id(test_client, _test_engine, agent, smtp):
    smtp.side_effect = SmtpDeliveryError("retry_wait", "smtp_451")
    first = _send(test_client, agent, "k").json()
    assert (first["state"], first["status"], first["error"]) == ("retry_wait", "retry_wait", "smtp_451")
    assert first["next_attempt_at"] is not None
    assert _send(test_client, agent, "k").json()["attempts"] == 1
    smtp.assert_called_once()

    for attempt in range(2, 6):
        _force(_test_engine, first["delivery_id"], next_attempt_at=EmailDelivery.created_at - timedelta(seconds=1))
        record = _send(test_client, agent, "k").json()
        assert record["attempts"] == attempt
    assert (record["state"], record["error"]) == ("failed", "smtp_451")
    assert "next_attempt_at" not in record
    assert {c.kwargs["message_id"] for c in smtp.call_args_list} == {first["message_id"]}
    assert smtp.call_count == 5


def test_permanent_failure_visible_and_final(test_client, agent, smtp):
    smtp.side_effect = SmtpDeliveryError("failed", "smtp_550")
    assert (_send(test_client, agent, "k").json()["state"], smtp.call_count) == ("failed", 1)
    again = _send(test_client, agent, "k").json()
    assert (again["state"], again["error"]) == ("failed", "smtp_550")
    smtp.assert_called_once()


def test_recipient_changed_fails_without_send(test_client, _test_engine, agent, smtp):
    delivery_id = _create(_test_engine, agent["agent_id"], "k", to_addr="old-owner@example.com")
    _force(_test_engine, delivery_id, state="retry_wait", next_attempt_at=EmailDelivery.created_at)
    r = _send(test_client, agent, "k").json()
    assert (r["state"], r["error"], r["to_addr"]) == ("failed", "recipient_changed", "old-owner@example.com")
    smtp.assert_not_called()


def test_unexpected_error_leaves_attempt_until_lease(test_client, _test_engine, agent, smtp):
    smtp.side_effect = RuntimeError("boom")
    assert _send(test_client, agent, "k").status_code == 500
    [row] = _rows(_test_engine, agent["agent_id"])
    assert row.state == "attempting"
    assert _delivery(test_client, agent, "k").json()["state"] == "attempting"

    _force(_test_engine, row.id, lease_expires_at=EmailDelivery.created_at)
    record = _delivery(test_client, agent, "k").json()
    assert (record["state"], record["error"]) == ("unknown", "lease_expired")
    assert _send(test_client, agent, "k").json()["state"] == "unknown"
    smtp.assert_called_once()


def _race(engine, n: int, fn) -> list:
    barrier, results = threading.Barrier(n), []

    def worker():
        with Session(engine) as db:
            barrier.wait()
            results.append(fn(db))
            db.commit()

    threads = [threading.Thread(target=worker) for _ in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    return results


def _parallel_sends(tc, agent: dict, keys: list[str]) -> list:
    """POST keyed sends from parallel threads; each pauses after its insert for the others (0.5 s at most)."""
    barrier, create = threading.Barrier(len(keys), timeout=0.5), TableWrite.create_email_delivery
    responses = [None] * len(keys)

    def create_then_meet(db, **fields):
        row = create(db, **fields)
        with contextlib.suppress(threading.BrokenBarrierError):
            barrier.wait()
        return row

    def post(i: int):
        responses[i] = _send(tc, agent, keys[i])

    with patch.object(TableWrite, "create_email_delivery", create_then_meet):
        threads = [threading.Thread(target=post, args=(i,)) for i in range(len(keys))]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
    return responses


def test_parallel_sends_with_different_keys_both_succeed(test_client, _test_engine, agent, smtp):
    before = _tokens(_test_engine, agent["agent_id"])
    responses = _parallel_sends(test_client, agent, ["k1", "k2"])
    assert [r.status_code for r in responses] == [200, 200], [r.text for r in responses]
    assert [r.json()["state"] for r in responses] == ["accepted", "accepted"]
    assert smtp.call_count == 2
    assert _tokens(_test_engine, agent["agent_id"]) == before - 2 * WRITE_COST


def test_parallel_sends_with_one_key_send_once(test_client, _test_engine, agent, smtp):
    before = _tokens(_test_engine, agent["agent_id"])
    responses = _parallel_sends(test_client, agent, ["k", "k"])
    assert [r.status_code for r in responses] == [200, 200], [r.text for r in responses]
    assert len({r.json()["delivery_id"] for r in responses}) == 1
    smtp.assert_called_once()
    assert _delivery(test_client, agent, "k").json()["state"] == "accepted"
    assert _tokens(_test_engine, agent["agent_id"]) == before - WRITE_COST


def test_concurrent_create_and_claim_single_winner(_test_engine, agent):
    agent_id = agent["agent_id"]
    fields = dict(
        agent_id=agent_id, idempotency_key="race", payload_hash="h", from_addr="a", to_addr="o",
        subject="s", message_id="<m>",
    )
    created = _race(_test_engine, 8, lambda db: TableWrite.create_email_delivery(db, **fields) is not None)
    assert created.count(True) == 1
    [row] = _rows(_test_engine, agent_id)
    claims = _race(_test_engine, 8, lambda db: TableWrite.claim_email_delivery(db, row.id, LEASE))
    assert sorted(claims, key=str) == [1] + [None] * 7


def test_finish_attempt_semantics(_test_engine, agent):
    agent_id = agent["agent_id"]
    delivery_id = _create(_test_engine, agent_id, "k", claim=timedelta(seconds=-1))
    with Session(_test_engine) as db:
        TableWrite.finish_email_delivery(db, delivery_id, 2, "failed", "stale", None)
        db.commit()
        assert TableWrite.refresh_email_delivery(db, agent_id, "k").state == "unknown"
        db.commit()
        assert TableWrite.claim_email_delivery(db, delivery_id, LEASE) is None
        TableWrite.finish_email_delivery(db, delivery_id, 1, "accepted", None, None)
        db.commit()
        row = TableWrite.refresh_email_delivery(db, agent_id, "k")
        assert (row.state, row.last_error, row.attempts) == ("accepted", None, 1)
        assert row.accepted_at is not None and row.lease_expires_at is None


@pytest.mark.parametrize("keep_content", [False, True])
def test_delete_agent_with_email_deliveries(test_client, _test_engine, agent, keep_content):
    _create(_test_engine, agent["agent_id"], "k1")
    _create(_test_engine, agent["agent_id"], "k2", claim=LEASE)
    token, _ = login_human(test_client, OWNER)
    r = test_client.delete(
        f"/api/human/orgs/{personal_org_id(test_client, token)}/agents/{agent['agent_id']}",
        params={"keep_content": keep_content},
        headers=auth_headers(token),
    )
    assert r.status_code == 200, r.text
    with Session(_test_engine) as db:
        assert db.get(Agent, agent["agent_id"]) is None
    assert _rows(_test_engine, agent["agent_id"]) == []
