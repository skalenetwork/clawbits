"""HTTP-level tests for the automations control plane.

Covers the operator CRUD surface, operator-only authz, spec validation, the
agent self-report / desired-fetch round-trip, and — critically — that the
telemetry-class agent routes (``/automations/state`` and ``/alive``) are exempt
from the CB_TOKENS write charge.
"""
from __future__ import annotations

from fastapi.testclient import TestClient
from sqlmodel import Session, select

from clawbits.db.models import Agent, Automation, AutomationRun
from tests.fastapi._auth_helpers import auth_headers, login_human, personal_org_id
from tests.fastapi.conftest import _create_agent

GOOD_SPEC = {
    "name": "Daily standup",
    "schedule": {"kind": "every", "everyMs": 86400000},
    "sessionTarget": "isolated",
    "wakeMode": "next-heartbeat",
    "payload": {"kind": "agentTurn", "message": "post the standup"},
}


def _setup(test_client: TestClient, email: str):
    data = _create_agent(test_client, owner_email=email)
    token, _ = login_human(test_client, email)
    org_id = personal_org_id(test_client, token)
    return data["agent_id"], data["api_key"], token, org_id


def _drain_tokens(engine, agent_id: str) -> None:
    with Session(engine) as db:
        agent = db.get(Agent, agent_id)
        agent.cb_tokens = 0
        db.add(agent)
        db.commit()


def test_operator_crud_and_agent_sync(test_client: TestClient, _test_engine):
    agent_id, api_key, token, org_id = _setup(test_client, "op-auto@clawbits.ai")
    base = f"/api/human/orgs/{org_id}/agents/{agent_id}/automations"
    agent_h = {"Authorization": f"Bearer {api_key}"}

    # operator creates an automation
    r = test_client.post(
        base, headers=auth_headers(token), json={"desired_spec": GOOD_SPEC}
    )
    assert r.status_code == 200, r.text
    auto = r.json()
    assert auto["sync_status"] == "requested"
    assert auto["desired_generation"] == 1
    assert auto["managed_by"] == "clawbits"
    assert auto["name"] == "Daily standup"
    aid = auto["automation_id"]

    # operator lists
    r = test_client.get(base, headers=auth_headers(token))
    assert r.status_code == 200
    assert len(r.json()["automations"]) == 1

    # invalid spec -> 400
    r = test_client.post(
        base, headers=auth_headers(token), json={"desired_spec": {"name": "x"}}
    )
    assert r.status_code == 400, r.text

    # a different human (not an org member) is rejected
    intruder, _ = login_human(test_client, "intruder-auto@clawbits.ai")
    r = test_client.get(base, headers=auth_headers(intruder))
    assert r.status_code == 403, r.text

    # agent fetches the desired set (GET, billing-exempt)
    r = test_client.get("/api/agentic/automations/desired", headers=agent_h)
    assert r.status_code == 200, r.text
    desired = r.json()
    assert desired["desired_generation"] == 1
    assert desired["automations"][0]["intent"] == "present"
    assert desired["automations"][0]["automation_id"] == aid
    assert desired["automations"][0]["desired_spec"]["name"] == "Daily standup"

    # self-report must be BILLING-EXEMPT: drain to 0 tokens, expect 200 not 402
    _drain_tokens(_test_engine, agent_id)
    report = {
        "openclaw_version": "2026.6.10",
        "plugin_version": "0.7.0",
        "managed": [
            {
                "automation_id": aid,
                "gateway_job_id": "cron_1",
                "observed_generation": 1,
                "status": "applied",
                "reported_spec": GOOD_SPEC,
                "reported_state": {"lastRunStatus": "ok", "nextRunAtMs": 123},
            }
        ],
        "runs": [
            {
                "automation_id": aid,
                "gateway_job_id": "cron_1",
                "gateway_run_id": "run_1",
                "status": "ok",
                "started_at_ms": 1700000000000,
                "finished_at_ms": 1700000001000,
                "summary": {"model": "claude"},
            }
        ],
    }
    r = test_client.post(
        "/api/agentic/automations/state", headers=agent_h, json=report
    )
    assert r.status_code == 200, r.text  # NOT 402 → exempt
    assert r.json()["desired_generation"] == 1
    assert r.json()["runs_ingested"] == 1

    # operator now sees applied + the reported mirror
    item = test_client.get(base, headers=auth_headers(token)).json()["automations"][0]
    assert item["sync_status"] == "applied"
    assert item["reported_state"]["lastRunStatus"] == "ok"
    assert item["gateway_job_id"] == "cron_1"
    assert item["openclaw_version"] == "2026.6.10"

    # runs surfaced to the operator
    runs = test_client.get(f"{base}/{aid}/runs", headers=auth_headers(token)).json()
    assert len(runs["runs"]) == 1
    assert runs["runs"][0]["gateway_run_id"] == "run_1"

    # delete → removing; desired now reports the job absent
    r = test_client.delete(f"{base}/{aid}", headers=auth_headers(token))
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "removing"
    desired = test_client.get(
        "/api/agentic/automations/desired", headers=agent_h
    ).json()
    assert desired["automations"][0]["intent"] == "absent"

    # the tombstone stays visible to the operator (honest "removing…" state)
    # until the agent confirms the removal
    listed = test_client.get(base, headers=auth_headers(token)).json()["automations"]
    assert len(listed) == 1
    assert listed[0]["sync_status"] == "removing"


def test_run_now_flow(test_client: TestClient, _test_engine):
    """Operator run-now bumps a run generation the plugin observes, runs once,
    and reports back — independent of the desired-state generation."""
    agent_id, api_key, token, org_id = _setup(test_client, "runnow@clawbits.ai")
    base = f"/api/human/orgs/{org_id}/agents/{agent_id}/automations"
    agent_h = {"Authorization": f"Bearer {api_key}"}

    aid = test_client.post(
        base, headers=auth_headers(token), json={"desired_spec": GOOD_SPEC}
    ).json()["automation_id"]
    # apply it so a gateway job exists (run-now targets an applied job)
    test_client.post(
        "/api/agentic/automations/state",
        headers=agent_h,
        json={
            "managed": [
                {
                    "automation_id": aid,
                    "gateway_job_id": "cron_1",
                    "observed_generation": 1,
                    "status": "applied",
                }
            ]
        },
    )

    # not run-pending yet
    item = test_client.get(base, headers=auth_headers(token)).json()["automations"][0]
    assert item["run_pending"] is False
    assert item["run_requested_generation"] == 0

    # operator requests a run
    r = test_client.post(f"{base}/{aid}/run", headers=auth_headers(token))
    assert r.status_code == 200, r.text
    assert r.json()["run_pending"] is True
    assert r.json()["run_requested_generation"] == 1

    # the plugin sees the pending run in the desired set
    desired = test_client.get(
        "/api/agentic/automations/desired", headers=agent_h
    ).json()["automations"][0]
    assert desired["run_requested_generation"] == 1
    assert desired["run_observed_generation"] == 0

    # the plugin runs it and reports the observed run generation back
    test_client.post(
        "/api/agentic/automations/state",
        headers=agent_h,
        json={
            "managed": [
                {
                    "automation_id": aid,
                    "gateway_job_id": "cron_1",
                    "observed_generation": 1,
                    "run_observed_generation": 1,
                    "status": "applied",
                }
            ]
        },
    )
    item = test_client.get(base, headers=auth_headers(token)).json()["automations"][0]
    assert item["run_pending"] is False
    assert item["run_observed_generation"] == 1

    # a second request bumps past the observed value (monotonic)
    r = test_client.post(f"{base}/{aid}/run", headers=auth_headers(token))
    assert r.json()["run_requested_generation"] == 2
    assert r.json()["run_pending"] is True

    # authz: a non-operator cannot trigger a run
    intruder, _ = login_human(test_client, "runnow-intruder@clawbits.ai")
    r = test_client.post(f"{base}/{aid}/run", headers=auth_headers(intruder))
    assert r.status_code == 403, r.text

    # missing automation -> 404
    r = test_client.post(f"{base}/does-not-exist/run", headers=auth_headers(token))
    assert r.status_code == 404, r.text


def test_delivery_target_channel(test_client: TestClient, _test_engine):
    """Operator can target a channel the agent is in; a non-member channel is
    rejected; webhook delivery is neutralized to announce."""
    from uuid import uuid4

    from clawbits.db.models import MmChannel, MmChannelMember

    agent_id, api_key, token, org_id = _setup(test_client, "deliv@clawbits.ai")
    base = f"/api/human/orgs/{org_id}/agents/{agent_id}/automations"
    agent_h = {"Authorization": f"Bearer {api_key}"}

    member_cid = uuid4().hex
    other_cid = uuid4().hex
    with Session(_test_engine) as db:
        db.add(MmChannel(channel_id=member_cid, org_id=org_id, name="general",
                         display_name="General", channel_type="public"))
        db.add(MmChannelMember(channel_id=member_cid, agent_id=agent_id))
        db.add(MmChannel(channel_id=other_cid, org_id=org_id, name="secret",
                         display_name="Secret", channel_type="private"))
        db.commit()

    # the channels endpoint lists the membership, not the non-member channel
    r = test_client.get(
        f"/api/human/orgs/{org_id}/agents/{agent_id}/channels",
        headers=auth_headers(token),
    )
    assert r.status_code == 200, r.text
    ids = {c["channel_id"] for c in r.json()["channels"]}
    assert member_cid in ids
    assert other_cid not in ids

    # default (no delivery) -> stored spec has no delivery key
    r = test_client.post(base, headers=auth_headers(token), json={"desired_spec": GOOD_SPEC})
    assert r.status_code == 200, r.text
    assert "delivery" not in r.json()["desired_spec"]

    # a valid target is stored verbatim and reaches the agent's desired set
    spec = {**GOOD_SPEC, "delivery": {"mode": "announce", "to": member_cid}}
    auto = test_client.post(
        base, headers=auth_headers(token), json={"desired_spec": spec}
    ).json()
    assert auto["desired_spec"]["delivery"] == {"mode": "announce", "to": member_cid}
    desired = test_client.get(
        "/api/agentic/automations/desired", headers=agent_h
    ).json()["automations"]
    item = next(a for a in desired if a["automation_id"] == auto["automation_id"])
    assert item["desired_spec"]["delivery"]["to"] == member_cid

    # targeting a channel the agent is NOT in -> 400
    bad = {**GOOD_SPEC, "delivery": {"mode": "announce", "to": other_cid}}
    r = test_client.post(base, headers=auth_headers(token), json={"desired_spec": bad})
    assert r.status_code == 400, r.text

    # webhook delivery to a member channel is neutralized to announce (no
    # exfiltration route survives normalization)
    sneaky = {**GOOD_SPEC, "delivery": {"mode": "webhook", "to": member_cid}}
    auto2 = test_client.post(
        base, headers=auth_headers(token), json={"desired_spec": sneaky}
    ).json()
    assert auto2["desired_spec"]["delivery"] == {"mode": "announce", "to": member_cid}


def test_alive_is_billing_exempt(test_client: TestClient, _test_engine):
    """The liveness heartbeat must not burn CB_TOKENS (latent-bug fix)."""
    data = _create_agent(test_client, owner_email="alive-auto@clawbits.ai")
    agent_h = {"Authorization": f"Bearer {data['api_key']}"}
    _drain_tokens(_test_engine, data["agent_id"])
    r = test_client.post("/api/agentic/alive", headers=agent_h)
    assert r.status_code == 200, r.text


def test_agent_cannot_touch_other_agents_automations(
    test_client: TestClient, _test_engine
):
    """An agent's desired fetch is scoped to itself by its api_key."""
    a1, key1, token1, org1 = _setup(test_client, "iso-a@clawbits.ai")
    base1 = f"/api/human/orgs/{org1}/agents/{a1}/automations"
    test_client.post(
        base1, headers=auth_headers(token1), json={"desired_spec": GOOD_SPEC}
    )
    # a second, unrelated agent sees an empty desired set (not a1's)
    other = _create_agent(test_client, owner_email="iso-b@clawbits.ai")
    other_h = {"Authorization": f"Bearer {other['api_key']}"}
    desired = test_client.get(
        "/api/agentic/automations/desired", headers=other_h
    ).json()
    assert desired["automations"] == []
    assert desired["desired_generation"] == 0


def test_delete_agent_with_automations(test_client: TestClient, _test_engine):
    """Deleting an agent that owns automations (and recorded runs) must not
    FK-error. ``automations`` and ``automation_runs`` both carry NOT NULL
    ``agent_id`` FKs with no ON DELETE cascade, so the delete has to clear them
    — runs before their parent automation — or the whole delete 500s. This is
    the regression for the Manage page "Delete agent" Internal Server Error.
    """
    agent_id, _api_key, token, org_id = _setup(test_client, "del-auto@clawbits.ai")
    base = f"/api/human/orgs/{org_id}/agents/{agent_id}/automations"

    # operator creates a managed automation via the real endpoint
    r = test_client.post(
        base, headers=auth_headers(token), json={"desired_spec": GOOD_SPEC}
    )
    assert r.status_code == 200, r.text
    automation_id = r.json()["automation_id"]

    # a recorded run pins the child FK (automation_runs.automation_id ->
    # automations), so the delete has to drop runs before their parent.
    with Session(_test_engine) as db:
        db.add(
            AutomationRun(
                automation_id=automation_id,
                agent_id=agent_id,
                gateway_run_id="run-1",
                status="ok",
            )
        )
        db.commit()

    # the exact surface the user hit: HTTP DELETE from the Manage page
    r = test_client.delete(
        f"/api/human/orgs/{org_id}/agents/{agent_id}",
        headers=auth_headers(token),
    )
    assert r.status_code == 200, r.text
    assert r.json()["deleted"] is True

    # the agent and both automation rows are gone
    with Session(_test_engine) as db:
        assert db.get(Agent, agent_id) is None
        assert (
            db.exec(select(Automation).where(Automation.agent_id == agent_id)).first()
            is None
        )
        assert (
            db.exec(
                select(AutomationRun).where(
                    AutomationRun.automation_id == automation_id
                )
            ).first()
            is None
        )


def _set_agent_type(engine, agent_id: str, agent_type: str | None) -> None:
    """Simulate the runtime self-report that normally lands on the alive ping."""
    with Session(engine) as db:
        agent = db.get(Agent, agent_id)
        agent.agent_type = agent_type
        db.add(agent)
        db.commit()


def test_automations_gated_for_runtimes_without_reconciler(
    test_client: TestClient, _test_engine
):
    """Only the OpenClaw plugin reconciles Clawbits-managed cron. For a hermes
    (or ironclaw) agent the rows would sit on "requested" forever, so the
    mutating routes reject up front with an honest 422 — while list and delete
    stay open so pre-existing rows remain visible and removable."""
    agent_id, _api_key, token, org_id = _setup(test_client, "op-hermes@clawbits.ai")
    base = f"/api/human/orgs/{org_id}/agents/{agent_id}/automations"

    # Pre-first-ping the runtime is unknown → create works (back-compat
    # default is openclaw). This also plants the row for the cleanup checks.
    r = test_client.post(
        base, headers=auth_headers(token), json={"desired_spec": GOOD_SPEC}
    )
    assert r.status_code == 200, r.text
    aid = r.json()["automation_id"]

    # The agent turns out to run hermes.
    _set_agent_type(_test_engine, agent_id, "hermes")

    # create / update / run-now are rejected with the runtime named…
    r = test_client.post(
        base, headers=auth_headers(token), json={"desired_spec": GOOD_SPEC}
    )
    assert r.status_code == 422, r.text
    assert "OpenClaw runtime" in r.json()["detail"]
    assert "hermes" in r.json()["detail"]
    r = test_client.patch(
        f"{base}/{aid}", headers=auth_headers(token), json={"desired_spec": GOOD_SPEC}
    )
    assert r.status_code == 422, r.text
    r = test_client.post(f"{base}/{aid}/run", headers=auth_headers(token))
    assert r.status_code == 422, r.text

    # …but the stuck row stays listable and deletable.
    r = test_client.get(base, headers=auth_headers(token))
    assert r.status_code == 200
    assert len(r.json()["automations"]) == 1
    r = test_client.delete(f"{base}/{aid}", headers=auth_headers(token))
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "removing"

    # ironclaw is equally reconciler-less; an openclaw self-report passes.
    _set_agent_type(_test_engine, agent_id, "ironclaw")
    r = test_client.post(
        base, headers=auth_headers(token), json={"desired_spec": GOOD_SPEC}
    )
    assert r.status_code == 422, r.text
    _set_agent_type(_test_engine, agent_id, "openclaw")
    r = test_client.post(
        base, headers=auth_headers(token), json={"desired_spec": GOOD_SPEC}
    )
    assert r.status_code == 200, r.text
