"""Tidemarks: each first-time achievement, its exclusions, and the profile block."""

from unittest.mock import patch

from sqlmodel import Session, select
from starlette.testclient import TestClient

from clawbits.agent_marks import Mark, tidemarks
from clawbits.db.models import Agent, AgentMark
from clawbits.db.table_write import TableWrite
from tests.fastapi._auth_helpers import auth_headers, login_human, personal_org_id
from tests.fastapi.conftest import _create_agent

OWNER = "tides@clawbits.ai"
SPEC = {
    "name": "Daily standup",
    "schedule": {"kind": "every", "everyMs": 86400000},
    "sessionTarget": "isolated",
    "wakeMode": "next-heartbeat",
    "payload": {"kind": "agentTurn", "message": "post the standup"},
}


def _login(tc: TestClient) -> tuple[dict, str]:
    token, _ = login_human(tc, OWNER)
    return auth_headers(token), personal_org_id(tc, token)


def _bearer(agent: dict) -> dict:
    return {"Authorization": f"Bearer {agent['api_key']}"}


def _profile(tc: TestClient, human: dict, org_id: str, agent: dict) -> dict:
    r = tc.get(f"/api/human/orgs/{org_id}/agents/{agent['agent_id']}", headers=human)
    assert r.status_code == 200, r.text
    return r.json()


def _marks(tc: TestClient, human: dict, org_id: str, agent: dict) -> dict[str, str | None]:
    block = _profile(tc, human, org_id, agent)["tidemarks"]
    return {mark["kind"]: mark["detail"] for mark in block["marks"]}


def _post(
    tc: TestClient, side: str, headers: dict, channel_id: str, message: str, **fields
) -> dict:
    r = tc.post(
        f"/api/{side}/mm/channels/{channel_id}/posts",
        json={"message": message, **fields},
        headers=headers,
    )
    assert r.status_code == 200, r.text
    return r.json()


def test_fresh_agent_is_shore_and_ironclaw_has_no_automation(test_client, _test_engine):
    agent = _create_agent(test_client, owner_email=OWNER)
    human, org_id = _login(test_client)
    assert _profile(test_client, human, org_id, agent)["tidemarks"] == {
        "tier": "shore",
        "tiers": [
            {"id": tier, "marks": needed}
            for needed, tier in enumerate(("shore", "swell", "tide", "nacre", "abyss", "hadal"))
        ],
        "kinds": ["conversation", "channel", "lobstertalk", "automation", "mail", "teamwork"],
        "marks": [],
        "full_set": False,
    }
    with Session(_test_engine) as db:
        row = db.get(Agent, agent["agent_id"])
        row.agent_type = "ironclaw"
        db.add(row)
        db.commit()
    kinds = _profile(test_client, human, org_id, agent)["tidemarks"]["kinds"]
    assert kinds == ["conversation", "channel", "lobstertalk", "mail", "teamwork"]


def test_tier_climbs_one_per_mark_and_full_set_follows_the_runtime():
    def earned(*kinds: str) -> list[Mark]:
        return [{"kind": kind, "earned_at": None, "detail": None} for kind in kinds]

    five = earned("conversation", "channel", "lobstertalk", "mail", "teamwork")
    assert tidemarks(earned("mail", "channel"), "openclaw")["tier"] == "tide"
    ironclaw = tidemarks(five, "ironclaw")
    assert (ironclaw["tier"], ironclaw["full_set"]) == ("hadal", True)
    assert tidemarks(five, "openclaw")["full_set"] is False
    full = tidemarks([*five, *earned("automation", "retired")], None)
    assert (full["tier"], full["full_set"], len(full["marks"])) == ("hadal", True, 6)


def test_conversation_follows_a_human_post_and_ignores_cb_usage(test_client):
    agent = _create_agent(test_client, owner_email=OWNER)
    human, org_id = _login(test_client)
    r = test_client.patch("/api/human/me", json={"display_name": "Tess"}, headers=human)
    assert r.status_code == 200, r.text
    r = test_client.post(
        "/api/human/mm/direct",
        json={"org_id": org_id, "target_id": agent["agent_id"], "target_type": "agent"},
        headers=human,
    )
    assert r.status_code == 200, r.text
    dm = r.json()["channel_id"]

    _post(test_client, "agentic", _bearer(agent), dm, "anyone there?")
    _post(test_client, "human", human, dm, "/cb-usage")
    assert _marks(test_client, human, org_id, agent) == {}

    _post(test_client, "agentic", _bearer(agent), dm, "hi Tess")
    assert _marks(test_client, human, org_id, agent) == {"conversation": "Tess"}


def _agent_dm(tc: TestClient, human: dict, caller: dict, target: dict) -> str:
    r = tc.put(
        f"/api/human/agents/{target['agent_id']}/contact-permissions",
        json={"principal_type": "agent", "principal_id": caller["agent_id"], "can_dm": True},
        headers=human,
    )
    assert r.status_code == 200, r.text
    r = tc.post(
        "/api/agentic/mm/direct",
        json={"target_agent_id": target["agent_id"]},
        headers=_bearer(caller),
    )
    assert r.status_code == 200, r.text
    return r.json()["channel_id"]


def test_teamwork_awards_both_agents_once_both_have_posted(test_client, _test_engine):
    first, second, third = (_create_agent(test_client, owner_email=OWNER) for _ in range(3))
    human, org_id = _login(test_client)
    dm = _agent_dm(test_client, human, first, second)

    _post(test_client, "agentic", _bearer(first), dm, "ping")
    assert _marks(test_client, human, org_id, first) == {}

    stream = _post(test_client, "agentic", _bearer(second), dm, "", status="streaming")
    r = test_client.patch(
        f"/api/agentic/mm/channels/{dm}/posts/{stream['post_id']}",
        json={"replace": "pong", "done": True},
        headers=_bearer(second),
    )
    assert r.status_code == 200, r.text
    assert _marks(test_client, human, org_id, first) == {
        "teamwork": _profile(test_client, human, org_id, second)["nickname"]
    }
    assert _marks(test_client, human, org_id, second) == {
        "teamwork": _profile(test_client, human, org_id, first)["nickname"]
    }

    with Session(_test_engine) as db:
        TableWrite.award_mark(db, first["agent_id"], "conversation")
        db.commit()
    dm = _agent_dm(test_client, human, third, first)
    _post(test_client, "agentic", _bearer(third), dm, "hello")
    _post(test_client, "agentic", _bearer(first), dm, "welcome")
    assert _marks(test_client, human, org_id, third) == {
        "teamwork": _profile(test_client, human, org_id, first)["nickname"]
    }


def test_channel_mark_skips_direct_and_default_channels_and_never_drops(test_client):
    public_agent = _create_agent(test_client, owner_email=OWNER)
    private_agent = _create_agent(test_client, owner_email=OWNER)
    human, org_id = _login(test_client)
    r = test_client.get(
        f"/api/agentic/mm/teams/{public_agent['agent_id']}/default-channel",
        headers=_bearer(public_agent),
    )
    assert r.status_code == 200, r.text
    assert _marks(test_client, human, org_id, public_agent) == {}

    channels = {}
    for agent, name, channel_type in (
        (public_agent, "Reef room", "public"),
        (private_agent, "Vault", "private"),
    ):
        r = test_client.post(
            "/api/human/mm/channels",
            json={
                "org_id": org_id,
                "name": name.lower().replace(" ", "-"),
                "display_name": name,
                "channel_type": channel_type,
            },
            headers=human,
        )
        assert r.status_code == 200, r.text
        channels[channel_type] = r.json()["channel_id"]
        r = test_client.post(
            f"/api/human/mm/channels/{channels[channel_type]}/members",
            json={"member_id": agent["agent_id"], "member_type": "agent"},
            headers=human,
        )
        assert r.status_code == 200, r.text

    r = test_client.delete(
        f"/api/human/mm/channels/{channels['private']}/members/{private_agent['agent_id']}",
        headers=human,
    )
    assert r.status_code == 200, r.text
    assert _marks(test_client, human, org_id, public_agent) == {"channel": "Reef room"}
    assert _marks(test_client, human, org_id, private_agent) == {"channel": None}


def test_marks_are_insert_only_and_delete_agent_clears_them(test_client, _test_engine):
    agent = _create_agent(test_client, owner_email=OWNER)
    human, org_id = _login(test_client)
    base = f"/api/human/orgs/{org_id}/agents/{agent['agent_id']}"
    r = test_client.patch(f"{base}/settings", json={"lobstertalk_enabled": True}, headers=human)
    assert r.status_code == 200, r.text
    earned_at = _profile(test_client, human, org_id, agent)["tidemarks"]["marks"][0]["earned_at"]

    for enabled in (False, True):
        r = test_client.patch(
            f"{base}/settings", json={"lobstertalk_enabled": enabled}, headers=human
        )
        assert r.status_code == 200, r.text
    r = test_client.post(f"{base}/automations", json={"desired_spec": SPEC}, headers=human)
    assert r.status_code == 200, r.text
    r = test_client.delete(f"{base}/automations/{r.json()['automation_id']}", headers=human)
    assert r.status_code == 200, r.text
    with Session(_test_engine) as db:
        TableWrite.award_mark(db, agent["agent_id"], "lobstertalk")
        db.commit()
        kinds = db.exec(select(AgentMark.kind).where(AgentMark.agent_id == agent["agent_id"])).all()
    assert sorted(kinds) == ["automation", "lobstertalk"]

    block = _profile(test_client, human, org_id, agent)["tidemarks"]
    assert block["tier"] == "tide"
    assert block["marks"][0] == {"kind": "lobstertalk", "earned_at": earned_at, "detail": None}

    r = test_client.delete(base, headers=human)
    assert r.status_code == 200, r.text
    with Session(_test_engine) as db:
        assert (
            db.exec(select(AgentMark).where(AgentMark.agent_id == agent["agent_id"])).first()
            is None
        )


def test_automation_mark_only_from_an_operator_create(test_client):
    agent = _create_agent(test_client, owner_email=OWNER)
    human, org_id = _login(test_client)
    r = test_client.post(
        "/api/agentic/automations/state",
        json={"external": [{"gateway_job_id": "cron_own", "reported_spec": SPEC}]},
        headers=_bearer(agent),
    )
    assert r.status_code == 200, r.text
    assert _marks(test_client, human, org_id, agent) == {}

    r = test_client.post(
        f"/api/human/orgs/{org_id}/agents/{agent['agent_id']}/automations",
        json={"desired_spec": SPEC},
        headers=human,
    )
    assert r.status_code == 200, r.text
    assert _marks(test_client, human, org_id, agent) == {"automation": None}


def test_mail_mark_lands_on_the_first_nonzero_count_read(test_client):
    agent_side = _create_agent(test_client, owner_email=OWNER)
    human_side = _create_agent(test_client, owner_email=OWNER)
    human, org_id = _login(test_client)

    def counts(total: int) -> dict:
        return {"total": total, "unread": total, "email_address": "mark@mail.clawbits.ai"}

    with patch("clawbits.fastapi.email_endpoints.STALWART_SVC_PASSWORD", "secret"):
        for total in (0, 2):
            with patch(
                "clawbits.fastapi.email_endpoints.get_email_counts", return_value=counts(total)
            ):
                r = test_client.get(
                    f"/api/agentic/agents/{agent_side['agent_id']}/email/count",
                    headers=_bearer(agent_side),
                )
            assert r.status_code == 200, r.text
            assert ("mail" in _marks(test_client, human, org_id, agent_side)) is bool(total)

    with (
        patch("clawbits.fastapi.human_endpoints.STALWART_SVC_PASSWORD", "secret"),
        patch("clawbits.fastapi.human_endpoints.get_email_counts", return_value=counts(1)),
    ):
        r = test_client.get(
            f"/api/human/orgs/{org_id}/agents/{human_side['agent_id']}/email/count",
            headers=human,
        )
    assert r.status_code == 200, r.text
    assert _marks(test_client, human, org_id, human_side) == {"mail": None}
