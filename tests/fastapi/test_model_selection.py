"""Model selection: the agent's catalog report, the operator's choices, and where they surface."""
from __future__ import annotations

from dataclasses import dataclass

import pytest
from httpx import Response
from sqlmodel import Session
from starlette.testclient import TestClient

import clawbits.fastapi.human_endpoints as human_endpoints
from clawbits.db.models import Agent, AgentModelCatalog
from clawbits.db.table_write import TableWrite
from clawbits.realtime import agent_topic
from tests.fastapi._auth_helpers import add_human_to_org, auth_headers, login_human, personal_org_id
from tests.fastapi.conftest import _create_agent

AUTO = "openrouter/auto"
OPUS = "anthropic/claude-opus-5"
GPT = "openai/gpt-5.6"
MODELS = [
    {"ref": AUTO, "provider": "openrouter", "name": "Auto", "levels": ["off"], "default_level": "off"},
    {
        "ref": OPUS,
        "provider": "anthropic",
        "name": "Claude Opus 5",
        "levels": ["off", "low", "medium", "high", "xhigh", "adaptive", "max"],
        "default_level": "high",
    },
    {
        "ref": GPT,
        "provider": "openai",
        "name": "GPT-5.6",
        "levels": ["off", "low", "medium", "high"],
        "default_level": "medium",
    },
]
REPORT = {"models": MODELS, "default_model": AUTO, "default_thinking": "off"}
UNSET = {"model": None, "thinking": None}


@dataclass(frozen=True)
class Operated:
    agent_id: str
    agent: dict[str, str]
    token: str
    human_id: int
    org_id: str

    @property
    def human(self) -> dict[str, str]:
        return auth_headers(self.token)

    @property
    def models_url(self) -> str:
        return f"/api/human/orgs/{self.org_id}/agents/{self.agent_id}/models"


def _setup(tc: TestClient, email: str, report: dict | None = REPORT) -> Operated:
    data = _create_agent(tc, owner_email=email)
    token, user = login_human(tc, email)
    s = Operated(
        data["agent_id"], auth_headers(data["api_key"]), token, user["id"], personal_org_id(tc, token)
    )
    if report is not None:
        _report(tc, s, report)
    return s


def _report(tc: TestClient, s: Operated, report: dict) -> bool:
    r = tc.post("/api/agentic/models/state", json=report, headers=s.agent)
    assert r.status_code == 200, r.text
    return r.json()["changed"]


def _put(tc: TestClient, s: Operated, headers: dict[str, str] | None = None, **body) -> Response:
    return tc.put(s.models_url, json=body, headers=headers or s.human)


def _get(tc: TestClient, s: Operated) -> dict:
    r = tc.get(s.models_url, headers=s.human)
    assert r.status_code == 200, r.text
    return r.json()


def _room(tc: TestClient, s: Operated, name: str, *, with_agent: bool = True) -> str:
    r = tc.post(
        "/api/human/mm/channels", json={"org_id": s.org_id, "name": name}, headers=s.human
    )
    assert r.status_code == 200, r.text
    channel_id = r.json()["channel_id"]
    if with_agent:
        r = tc.post(
            f"/api/human/mm/channels/{channel_id}/members",
            json={"member_id": s.agent_id, "member_type": "agent"},
            headers=s.human,
        )
        assert r.status_code == 200, r.text
    return channel_id


def test_report_is_stored_deduped_and_never_touches_choices(test_client: TestClient):
    s = _setup(test_client, "models-report@clawbits.ai", report=None)
    assert _report(test_client, s, REPORT) is True
    assert _report(test_client, s, {**REPORT, "plugin_version": "1.2.3"}) is False
    assert _put(test_client, s, model=OPUS, thinking="high").status_code == 200

    assert _report(test_client, s, {"models": MODELS[1:], "default_model": OPUS}) is True
    body = _get(test_client, s)
    assert body.pop("reported_at") is not None
    assert body == {
        "models": MODELS[1:],
        "runtime_default": {"model": OPUS, "thinking": None},
        "default": {"model": OPUS, "thinking": "high"},
    }


def test_oversize_report_is_rejected_not_truncated(test_client: TestClient, _test_engine):
    s = _setup(test_client, "models-oversize@clawbits.ai", report=None)
    models = [{**MODELS[2], "ref": f"openai/m{i}"} for i in range(2001)]
    r = test_client.post("/api/agentic/models/state", json={"models": models}, headers=s.agent)
    assert r.status_code == 422
    with Session(_test_engine) as db:
        assert db.get(AgentModelCatalog, s.agent_id) is None


def test_report_is_billing_exempt(test_client: TestClient, _test_engine):
    s = _setup(test_client, "models-billing@clawbits.ai", report=None)
    with Session(_test_engine) as db:
        agent = db.get_one(Agent, s.agent_id)
        agent.cb_tokens = 0
        db.add(agent)
        db.commit()
    assert _report(test_client, s, REPORT) is True


def test_no_report_hides_pickers_and_refuses_choices(test_client: TestClient):
    s = _setup(test_client, "models-unreported@clawbits.ai", report=None)
    assert _get(test_client, s) == {
        "models": None,
        "runtime_default": None,
        "default": UNSET,
        "reported_at": None,
    }
    assert _put(test_client, s, model=OPUS).status_code == 422


def test_choices_validate_against_the_effective_model(test_client: TestClient):
    s = _setup(test_client, "models-validate@clawbits.ai")
    room = _room(test_client, s, "models-validate")
    for body in (
        {"model": "anthropic/unlisted"},
        {"model": GPT, "thinking": "max"},
        {"thinking": "high"},
        {"channel_id": room, "thinking": "high"},
        {"model": OPUS, "effort": "high"},
    ):
        assert _put(test_client, s, **body).status_code == 422, body

    assert _put(test_client, s, model=OPUS).status_code == 200
    assert _put(test_client, s, channel_id=room, thinking="max").status_code == 200
    assert _put(test_client, s, thinking="max").status_code == 422

    _report(test_client, s, {**REPORT, "default_model": None})
    assert _put(test_client, s, thinking="off").status_code == 422


def test_only_the_operator_chooses_in_channels_both_share(test_client: TestClient):
    s = _setup(test_client, "models-authz@clawbits.ai")
    member_email = "models-authz-member@clawbits.ai"
    member_token, _ = login_human(test_client, member_email)
    add_human_to_org(test_client, s.token, s.org_id, member_email)
    member = auth_headers(member_token)
    assert test_client.get(s.models_url, headers=member).status_code == 403
    assert _put(test_client, s, headers=member, model=OPUS).status_code == 403

    r = test_client.post(
        "/api/human/mm/channels",
        json={"org_id": s.org_id, "name": "models-authz-theirs"},
        headers=member,
    )
    assert r.status_code == 200, r.text
    without_operator = r.json()["channel_id"]
    with Session(test_client.app._engine) as db:
        TableWrite.add_mm_channel_member(db, without_operator, s.agent_id)
        db.commit()
    without_agent = _room(test_client, s, "models-authz-mine", with_agent=False)
    for channel_id in (without_operator, without_agent, "missing"):
        assert _put(test_client, s, channel_id=channel_id, model=OPUS).status_code == 404


def test_choices_reach_the_agent_and_null_clears(test_client: TestClient):
    s = _setup(test_client, "models-listing@clawbits.ai")
    room = _room(test_client, s, "models-listing")
    assert _put(test_client, s, model=OPUS, thinking="high").json() == {
        "model": OPUS,
        "thinking": "high",
    }
    assert _put(test_client, s, channel_id=room, model=GPT, thinking="low").json() == {
        "model": GPT,
        "thinking": "low",
    }

    def views() -> list[dict]:
        r = test_client.get("/api/agentic/mm/channels", headers=s.agent)
        assert r.status_code == 200, r.text
        api_key = s.agent["Authorization"].removeprefix("Bearer ")
        with test_client.websocket_connect(f"/api/agentic/mm/events/ws?api_key={api_key}") as ws:
            snapshot = ws.receive_json()
            ws.close()
        assert snapshot["type"] == "snapshot"
        return [r.json(), snapshot["data"]]

    for view in views():
        assert (view["default_model"], view["default_thinking"]) == (OPUS, "high")
        choices = {c["channel_id"]: (c["model"], c["thinking"]) for c in view["channels"]}
        assert choices.pop(room) == (GPT, "low")
        assert set(choices.values()) <= {(None, None)}

    assert _put(test_client, s, channel_id=room).json() == UNSET
    assert _put(test_client, s).json() == UNSET
    assert _get(test_client, s)["default"] == UNSET
    for view in views():
        assert (view["default_model"], view["default_thinking"]) == (None, None)
        assert {(c["model"], c["thinking"]) for c in view["channels"]} == {(None, None)}


def test_choice_is_published_to_the_agent(test_client: TestClient, monkeypatch):
    s = _setup(test_client, "models-publish@clawbits.ai")
    room = _room(test_client, s, "models-publish")
    published: list[tuple[str, dict]] = []

    class Bus:
        async def publish(self, topic: str, event: dict) -> None:
            published.append((topic, event))

    monkeypatch.setattr(human_endpoints, "get_bus", Bus)
    assert _put(test_client, s, channel_id=room, model=OPUS, thinking="max").status_code == 200
    assert _put(test_client, s).status_code == 200
    topic = agent_topic(s.agent_id)
    assert published == [
        (
            topic,
            {
                "type": "model.selection",
                "data": {"channel_id": room, "model": OPUS, "thinking": "max"},
            },
        ),
        (topic, {"type": "model.selection", "data": {"channel_id": None, **UNSET}}),
    ]


def test_members_show_the_model_choice_only_to_the_operator(test_client: TestClient):
    s = _setup(test_client, "models-members@clawbits.ai")
    member_email = "models-members-other@clawbits.ai"
    member_token, member_user = login_human(test_client, member_email)
    add_human_to_org(test_client, s.token, s.org_id, member_email)
    room = _room(test_client, s, "models-members")
    r = test_client.post(
        f"/api/human/mm/channels/{room}/members",
        json={"member_id": str(member_user["id"]), "member_type": "human"},
        headers=s.human,
    )
    assert r.status_code == 200, r.text
    assert _put(test_client, s, channel_id=room, model=GPT).status_code == 200

    def rows(headers: dict[str, str]) -> dict[str | int, tuple[bool, dict | None]]:
        r = test_client.get(f"/api/human/mm/channels/{room}/members", headers=headers)
        assert r.status_code == 200, r.text
        return {
            m["agent_id"] or m["human_id"]: (m["is_operator"], m["model_choice"])
            for m in r.json()["members"]
        }

    others = {s.human_id: (False, None), member_user["id"]: (False, None)}
    assert rows(s.human) == {
        **others,
        s.agent_id: (True, {"model": GPT, "thinking": None}),
    }
    assert rows(auth_headers(member_token)) == {**others, s.agent_id: (False, None)}


@pytest.mark.parametrize("keep_content", [False, True])
def test_delete_agent_with_a_catalog_and_choices(
    test_client: TestClient, _test_engine, keep_content: bool
):
    s = _setup(test_client, "models-delete@clawbits.ai")
    room = _room(test_client, s, "models-delete")
    assert _put(test_client, s, model=OPUS).status_code == 200
    assert _put(test_client, s, channel_id=room, model=GPT).status_code == 200

    r = test_client.delete(
        f"/api/human/orgs/{s.org_id}/agents/{s.agent_id}",
        params={"keep_content": keep_content},
        headers=s.human,
    )
    assert r.status_code == 200, r.text
    with Session(_test_engine) as db:
        assert db.get(Agent, s.agent_id) is None
        assert db.get(AgentModelCatalog, s.agent_id) is None
