"""Tidemarks: each first-time achievement, its exclusions, and the profile block."""

import datetime as _dt
from typing import get_args
from unittest.mock import patch

from sqlmodel import Session, select
from starlette.testclient import TestClient

from clawbits.agent_marks import (
    BANDS,
    DRAFT_TIERS,
    LADDER,
    MARK_KINDS,
    Mark,
    MarkKind,
    tidemarks,
)
from clawbits.db.models import Agent, AgentDay, AgentMark, HumanUser, MmFile
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


def _room(tc: TestClient, human: dict, org_id: str, name: str, *agents: dict) -> str:
    r = tc.post(
        "/api/human/mm/channels",
        json={
            "org_id": org_id,
            "name": name,
            "display_name": name.replace("-", " ").capitalize(),
            "channel_type": "public",
        },
        headers=human,
    )
    assert r.status_code == 200, r.text
    channel_id = r.json()["channel_id"]
    for agent in agents:
        r = tc.post(
            f"/api/human/mm/channels/{channel_id}/members",
            json={"member_id": agent["agent_id"], "member_type": "agent"},
            headers=human,
        )
        assert r.status_code == 200, r.text
    return channel_id


def test_fresh_agent_is_shore_and_ironclaw_has_no_automation(test_client, _test_engine):
    agent = _create_agent(test_client, owner_email=OWNER)
    human, org_id = _login(test_client)
    block = _profile(test_client, human, org_id, agent)["tidemarks"]
    assert (block["tier"], block["marks"], block["full_set"]) == ("shore", [], False)
    assert block["tiers"] == [
        {"id": "shore", "marks": 0},
        {"id": "swell", "marks": 1},
        {"id": "tide", "marks": 3},
        {"id": "reef", "marks": 5},
        {"id": "nacre", "marks": 8},
        {"id": "twilight", "marks": 11},
        {"id": "abyss", "marks": 14},
        {"id": "hadal", "marks": 17},
    ]
    assert block["bands"] == [{"id": band, "kinds": list(kinds)} for band, kinds in BANDS.items()]

    with Session(_test_engine) as db:
        row = db.get(Agent, agent["agent_id"])
        row.agent_type = "ironclaw"
        db.add(row)
        db.commit()
    bands = _profile(test_client, human, org_id, agent)["tidemarks"]["bands"]
    assert [kind for band in bands for kind in band["kinds"]] == [
        kind
        for kinds in BANDS.values()
        for kind in kinds
        if kind not in ("automation", "run", "clockwork")
    ]


def test_the_ladder_is_reachable_and_the_draft_finishes_are_off_it():
    assert {tier for tier, _ in LADDER}.isdisjoint(DRAFT_TIERS)
    assert [at for _, at in LADDER] == sorted(at for _, at in LADDER)
    assert LADDER[-1][1] < len(MARK_KINDS)
    assert set(MARK_KINDS) == set(get_args(MarkKind)) and len(MARK_KINDS) == len(set(MARK_KINDS))


def test_tier_climbs_the_ladder_and_full_set_follows_the_runtime():
    def earned(*kinds: str) -> list[Mark]:
        return [{"kind": kind, "earned_at": None, "detail": None} for kind in kinds]

    everything = earned(*(kind for kinds in BANDS.values() for kind in kinds))
    assert tidemarks(earned("mail", "channel"), "openclaw")["tier"] == "swell"
    assert tidemarks(everything[:5], "openclaw")["tier"] == "reef"
    assert tidemarks(everything[:11], "openclaw")["tier"] == "twilight"

    ironclaw = tidemarks(
        [m for m in everything if m["kind"] not in ("automation", "run", "clockwork")], "ironclaw"
    )
    assert (ironclaw["tier"], ironclaw["full_set"]) == ("hadal", True)
    assert tidemarks(everything[:-1], "openclaw")["full_set"] is False
    full = tidemarks([*everything, *earned("retired")], None)
    assert (full["tier"], full["full_set"], len(full["marks"])) == ("hadal", True, 21)


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


def test_post_marks_reach_team_rooms_not_only_dms(test_client):
    first, second = (_create_agent(test_client, owner_email=OWNER) for _ in range(2))
    human, org_id = _login(test_client)
    room = _room(test_client, human, org_id, "reef-room", first, second)
    r = test_client.put(
        f"/api/human/agents/{second['agent_id']}/contact-permissions",
        json={"principal_type": "agent", "principal_id": first["agent_id"], "can_tag": True},
        headers=human,
    )
    assert r.status_code == 200, r.text

    _post(test_client, "human", human, room, f"@{first['agent_id']} who can take the standup?")
    _post(test_client, "agentic", _bearer(first), room, f"@{second['agent_id']} can you?")
    _post(test_client, "agentic", _bearer(second), room, "on it")

    assert _marks(test_client, human, org_id, first) == {
        "channel": "Reef room",
        "conversation": _profile(test_client, human, org_id, first)["operator"]["display_name"],
        "teamwork": _profile(test_client, human, org_id, second)["nickname"],
    }
    assert _marks(test_client, human, org_id, second) == {
        "channel": "Reef room",
        "teamwork": _profile(test_client, human, org_id, first)["nickname"],
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
    assert block["tier"] == "swell"
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


def test_open_water_marks_come_off_one_post_each(test_client, _test_engine):
    first, second, third = (_create_agent(test_client, owner_email=OWNER) for _ in range(3))
    human, org_id = _login(test_client)
    room = _room(test_client, human, org_id, "reef-room", first, second, third)

    parent = _post(test_client, "human", human, room, "morning all")
    reply = _post(
        test_client, "agentic", _bearer(first), room, "morning", parent_post_id=parent["post_id"]
    )
    marks = _marks(test_client, human, org_id, first)
    assert {"thread", "crew", "conversation", "channel"} <= set(marks)
    assert marks["crew"] == "Reef room"
    assert "night" not in marks

    r = test_client.post(f"/api/human/mm/posts/{reply['post_id']}/pin", headers=human)
    assert r.status_code == 200, r.text
    assert "pinned" in _marks(test_client, human, org_id, first)


def test_night_shift_needs_an_operator_who_has_been_away(test_client, _test_engine):
    agent = _create_agent(test_client, owner_email=OWNER)
    human, org_id = _login(test_client)
    room = _room(test_client, human, org_id, "night-room", agent)
    _post(test_client, "human", human, room, "anyone about?")
    with Session(_test_engine) as db:
        operator_id = db.get(Agent, agent["agent_id"]).operator_id
        operator = db.get(HumanUser, operator_id)
        operator.last_seen_at = _dt.datetime.now(_dt.UTC) - _dt.timedelta(hours=9)
        db.add(operator)
        db.commit()
    _post(test_client, "agentic", _bearer(agent), room, "still here")
    assert "night" in _marks(test_client, human, org_id, agent)


def test_handoff_needs_a_second_peer(test_client):
    first, second, third = (_create_agent(test_client, owner_email=OWNER) for _ in range(3))
    human, org_id = _login(test_client)
    room = _room(test_client, human, org_id, "crew-room", first, second, third)

    _post(test_client, "agentic", _bearer(second), room, "taking the standup")
    _post(test_client, "agentic", _bearer(first), room, "thanks")
    assert "handoff" not in _marks(test_client, human, org_id, first)

    _post(test_client, "agentic", _bearer(third), room, "and the release?")
    _post(test_client, "agentic", _bearer(first), room, "mine")
    marks = _marks(test_client, human, org_id, first)
    assert marks["teamwork"] == _profile(test_client, human, org_id, second)["nickname"]
    assert marks["handoff"] == _profile(test_client, human, org_id, third)["nickname"]


def test_a_reply_logs_a_talking_day_and_completes_the_streak_behind_it(test_client, _test_engine):
    agent = _create_agent(test_client, owner_email=OWNER)
    human, org_id = _login(test_client)
    room = _room(test_client, human, org_id, "tide-room", agent)
    today = _dt.datetime.now(_dt.UTC).date()
    with Session(_test_engine) as db:
        for back in (1, 2):
            db.add(AgentDay(agent_id=agent["agent_id"], track="talk", day=today - _dt.timedelta(back)))
        db.commit()

    _post(test_client, "human", human, room, "morning")
    _post(test_client, "agentic", _bearer(agent), room, "morning")
    marks = _marks(test_client, human, org_id, agent)
    assert "streak3" in marks and "streak7" not in marks


def test_day_marks_count_runs_and_totals_and_a_gap_starts_over(test_client, _test_engine):
    agent_id = _create_agent(test_client, owner_email=OWNER)["agent_id"]
    today = _dt.datetime.now(_dt.UTC).date()

    def log(*backs: int) -> set[str]:
        """Walk the given days oldest first, as the real path does, and roll the tally back."""
        earned: set[str] = set()
        with Session(_test_engine) as db:
            for back in sorted(backs, reverse=True):
                TableWrite.award_day_marks(db, agent_id, "talk", today - _dt.timedelta(back), earned)
            db.rollback()
        return earned

    assert log(*range(3)) == {"streak3"}
    assert log(*range(7)) == {"streak3", "streak7"}
    # A missing day resets the run: seven days spanning a gap earn nothing.
    assert log(*range(4), *range(5, 9)) == {"streak3"}
    # Every other day for a hundred days: the total lands, no run ever reaches three.
    assert log(*range(0, 200, 2)) == {"tides"}


def test_tenure_marks_land_on_the_profile_read_dated_to_the_day_they_came_due(
    test_client, _test_engine
):
    agent = _create_agent(test_client, owner_email=OWNER)
    human, org_id = _login(test_client)
    assert _marks(test_client, human, org_id, agent) == {}

    born = _dt.datetime.now(_dt.UTC) - _dt.timedelta(days=100)
    with Session(_test_engine) as db:
        row = db.get(Agent, agent["agent_id"])
        row.creation_time = born
        db.add(row)
        db.commit()
    block = _profile(test_client, human, org_id, agent)["tidemarks"]
    weathered = next(m for m in block["marks"] if m["kind"] == "weathered")
    assert weathered["earned_at"].startswith(str((born + _dt.timedelta(days=90)).date()))
    assert "year" not in {m["kind"] for m in block["marks"]}


def test_skill_install_and_automation_runs_earn_their_marks(test_client):
    agent = _create_agent(test_client, owner_email=OWNER)
    human, org_id = _login(test_client)
    r = test_client.post(
        f"/api/human/orgs/{org_id}/skills",
        json={
            "slug": "weather",
            "display_name": "Weather",
            "manifest": {"name": "weather", "description": "Read the sky before promising a date."},
            "body_md": "# Weather\n\nRead the sky.\n",
        },
        headers=human,
    )
    assert r.status_code == 200, r.text
    skill_id = r.json()["skill_id"]
    r = test_client.post(
        f"/api/human/orgs/{org_id}/agents/{agent['agent_id']}/skills",
        json={"skill_id": skill_id},
        headers=human,
    )
    assert r.status_code == 200, r.text
    assert _marks(test_client, human, org_id, agent)["skill"] == "Weather"

    r = test_client.post(
        f"/api/human/orgs/{org_id}/agents/{agent['agent_id']}/automations",
        json={"desired_spec": SPEC},
        headers=human,
    )
    assert r.status_code == 200, r.text
    automation_id = r.json()["automation_id"]
    day = _dt.datetime.now(_dt.UTC) - _dt.timedelta(days=6)
    r = test_client.post(
        "/api/agentic/automations/state",
        json={
            "managed": [],
            "external": [],
            "runs": [
                {
                    "automation_id": automation_id,
                    "gateway_run_id": f"run-{back}",
                    "status": "ok",
                    "finished_at_ms": int(
                        (day + _dt.timedelta(days=back)).timestamp() * 1000
                    ),
                }
                for back in range(7)
            ],
        },
        headers=_bearer(agent),
    )
    assert r.status_code == 200, r.text
    assert {"run", "clockwork"} <= set(_marks(test_client, human, org_id, agent))


def test_a_file_in_a_channel_marks_every_agent_in_it(test_client, _test_engine):
    first, second = (_create_agent(test_client, owner_email=OWNER) for _ in range(2))
    human, org_id = _login(test_client)
    room = _room(test_client, human, org_id, "drop-room", first, second)
    r = test_client.post(
        f"/api/human/mm/channels/{room}/files",
        json={"filename": "notes.txt", "content_type": "text/plain", "size_bytes": 12},
        headers=human,
    )
    assert r.status_code == 200, r.text
    file_id = r.json()["file_id"]
    with Session(_test_engine) as db:
        row = db.get(MmFile, file_id)
        row.status = "uploaded"
        db.add(row)
        db.commit()
    _post(test_client, "human", human, room, "here you go", file_ids=[file_id])
    for agent in (first, second):
        assert "file" in _marks(test_client, human, org_id, agent)
