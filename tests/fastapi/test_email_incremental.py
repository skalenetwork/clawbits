"""Endpoint wiring for the incremental mailbox API: /email/changes, flag-neutral detail, epoch checks.

The IMAP layer is patched out (see tests/email for its own tests), so only Postgres is needed.
"""
from unittest.mock import patch

import pytest

from clawbits.email.imap_client import MailboxEpochChanged
from tests.fastapi.conftest import _create_agent

EP = "clawbits.fastapi.email_endpoints"

PAGE = {
    "uidvalidity": 7,
    "through_uid": 3,
    "emails": [
        {
            "uid": 3,
            "from_addr": "owner@example.com",
            "to_addr": "agent@mail.test",
            "subject": "hi",
            "date": "",
            "is_read": False,
            "size": 10,
        }
    ],
    "next_after_uid": 3,
    "has_more": False,
}

DETAIL = {
    "uid": 3,
    "from_addr": "owner@example.com",
    "to_addr": "agent@mail.test",
    "subject": "hi",
    "date": "",
    "is_read": False,
    "size": 10,
    "body_text": "body",
    "attachments": [{"filename": "a.bin", "content_type": "application/octet-stream", "size": 4}],
    "headers": {"From": "owner@example.com"},
    "sender_auth": {"verdict": "pass", "address": "owner@example.com", "domain": "example.com", "reason": "dmarc_pass"},
}


@pytest.fixture
def agent(test_client):
    with patch(f"{EP}.STALWART_SVC_PASSWORD", "secret"):
        yield _create_agent(test_client)


def _auth(agent: dict) -> dict:
    return {"Authorization": f"Bearer {agent['api_key']}"}


def _base(agent: dict) -> str:
    return f"/api/agentic/agents/{agent['agent_id']}/email"


def test_changes_route_precedes_uid_route(test_client, agent):
    with patch(f"{EP}.list_changes", return_value=PAGE) as changes:
        r = test_client.get(
            f"{_base(agent)}/changes",
            params={"after_uid": 2, "uidvalidity": 7, "through_uid": 9, "limit": 10},
            headers=_auth(agent),
        )
    assert r.status_code == 200, r.text
    assert r.json() == {**PAGE, "emails": [{**PAGE["emails"][0], "snippet": None, "has_attachments": None}]}
    changes.assert_called_once_with(agent["agent_id"], 2, uidvalidity=7, through_uid=9, limit=10)


def test_changes_limit_clamped_not_rejected(test_client, agent):
    with patch(f"{EP}.list_changes", return_value=PAGE) as changes:
        assert test_client.get(f"{_base(agent)}/changes?limit=1000", headers=_auth(agent)).status_code == 200
        assert test_client.get(f"{_base(agent)}/changes?limit=0", headers=_auth(agent)).status_code == 200
    assert [c.kwargs["limit"] for c in changes.call_args_list] == [200, 1]
    assert changes.call_args_list[0].args == (agent["agent_id"], 0)
    assert changes.call_args_list[0].kwargs["uidvalidity"] is None


def test_changes_epoch_conflict_409_shape(test_client, agent):
    with patch(f"{EP}.list_changes", side_effect=MailboxEpochChanged(42)):
        r = test_client.get(f"{_base(agent)}/changes?uidvalidity=41", headers=_auth(agent))
    assert r.status_code == 409
    body = r.json()
    assert body["error"] is True and body["status_code"] == 409
    assert body["detail"] == {"code": "mailbox_epoch_changed", "uidvalidity": 42}


def test_changes_and_delivery_other_agent_forbidden(test_client, agent):
    other = _create_agent(test_client)
    with patch(f"{EP}.list_changes", return_value=PAGE) as changes:
        r = test_client.get(f"/api/agentic/agents/{other['agent_id']}/email/changes", headers=_auth(agent))
    assert r.status_code in (401, 403)
    changes.assert_not_called()
    r = test_client.get(f"/api/agentic/agents/{other['agent_id']}/email/deliveries/k", headers=_auth(agent))
    assert r.status_code in (401, 403)


def test_detail_and_delete_params(test_client, agent):
    with patch(f"{EP}.get_email", return_value=DETAIL) as get:
        r = test_client.get(f"{_base(agent)}/3", headers=_auth(agent))
        assert r.status_code == 200, r.text
        get.assert_called_once_with(
            agent["agent_id"], 3, uidvalidity=None, mark_read=True, attachment_content=True
        )
        assert r.json()["sender_auth"] == DETAIL["sender_auth"]
        assert r.json()["attachments"][0]["content_b64"] is None

        get.reset_mock()
        r = test_client.get(
            f"{_base(agent)}/3?mark_read=false&uidvalidity=7&attachment_content=false", headers=_auth(agent)
        )
        assert r.status_code == 200, r.text
        get.assert_called_once_with(
            agent["agent_id"], 3, uidvalidity=7, mark_read=False, attachment_content=False
        )

    with patch(f"{EP}.get_email", side_effect=MailboxEpochChanged(8)):
        r = test_client.get(f"{_base(agent)}/3?uidvalidity=7", headers=_auth(agent))
    assert r.status_code == 409
    assert r.json()["detail"] == {"code": "mailbox_epoch_changed", "uidvalidity": 8}

    with patch(f"{EP}.delete_email", return_value=True) as delete:
        assert test_client.delete(f"{_base(agent)}/3", headers=_auth(agent)).status_code == 200
        delete.assert_called_once_with(agent["agent_id"], 3, uidvalidity=None)
    with patch(f"{EP}.delete_email", side_effect=MailboxEpochChanged(8)) as delete:
        r = test_client.delete(f"{_base(agent)}/3?uidvalidity=7", headers=_auth(agent))
    assert r.status_code == 409
    assert r.json()["detail"] == {"code": "mailbox_epoch_changed", "uidvalidity": 8}
    delete.assert_called_once_with(agent["agent_id"], 3, uidvalidity=7)


def test_detail_without_sender_auth_defaults_to_unknown(test_client, agent):
    legacy = {k: v for k, v in DETAIL.items() if k != "sender_auth"}
    with patch(f"{EP}.get_email", return_value=legacy):
        r = test_client.get(f"{_base(agent)}/3", headers=_auth(agent))
    assert r.status_code == 200, r.text
    assert r.json()["sender_auth"] == {"verdict": "unknown", "address": None, "domain": None, "reason": "not_evaluated"}
