"""HTTP-level tests for agent AI-usage tracking.

Covers the billing exemption of the agent report lane, event dedup +
daily-rollup math (idempotent accumulation), the ingest time window (both
directions — retention horizon and future skew), owner/member RBAC on the
org dashboard, the roster join ("not reporting yet" agents stay visible),
and agent deletion with usage rows present (FK cleanup).
See ``docs/protocol/AGENT_USAGE_TRACKING_PLAN.md``.
"""
from __future__ import annotations

import time

from fastapi.testclient import TestClient
from sqlmodel import Session, select

from clawbits.db.models import Agent, AgentUsageDaily, AgentUsageEvent
from clawbits.db.table_write import TableWrite
from tests.fastapi._auth_helpers import auth_headers, login_human, personal_org_id
from tests.fastapi.conftest import _create_agent

NOW_MS = lambda: int(time.time() * 1000)  # noqa: E731


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


def _event(event_id: str, **overrides) -> dict:
    base = {
        "event_id": event_id,
        "occurred_at_ms": NOW_MS(),
        "model": "claude-opus-4-8",
        "provider": "anthropic",
        "input_tokens": 100,
        "output_tokens": 10,
        "cache_read_tokens": 1000,
        "cache_write_tokens": 0,
    }
    base.update(overrides)
    return base


def _report(test_client: TestClient, api_key: str, events: list[dict], **kw):
    body = {"plugin_version": "0.13.0", "openclaw_version": "2026.6.11",
            "source": "hook", "events": events}
    body.update(kw)
    return test_client.post(
        "/api/agentic/usage/report",
        headers={"Authorization": f"Bearer {api_key}"},
        json=body,
    )


def test_report_billing_exempt_dedup_and_rollup(test_client: TestClient, _test_engine):
    agent_id, api_key, token, org_id = _setup(test_client, "usage@clawbits.ai")

    # billing-exempt: drained to 0 CB_TOKENS the report must still be a 200
    _drain_tokens(_test_engine, agent_id)
    r = _report(test_client, api_key, [_event("run1:c1"), _event("run1:c2")])
    assert r.status_code == 200, r.text  # NOT 402 → exempt
    assert r.json()["ingested"] == 2
    assert r.json()["duplicates"] == 0
    assert r.json()["rejected"] == 0

    # exact re-report (at-least-once retry) dedups, rollup unchanged
    r = _report(test_client, api_key, [_event("run1:c1"), _event("run1:c2")])
    assert r.json()["ingested"] == 0
    assert r.json()["duplicates"] == 2

    # in-batch duplicate: same idempotency key twice in one report
    r = _report(test_client, api_key, [_event("run1:c3"), _event("run1:c3")])
    assert r.json()["ingested"] == 1
    assert r.json()["duplicates"] == 1

    # rollup math: 3 unique events x (100 in / 10 out / 1000 cache-read)
    r = test_client.get(
        f"/api/human/orgs/{org_id}/usage", headers=auth_headers(token)
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["role"] == "owner"
    assert data["org_total"]["input_tokens"] == 300
    assert data["org_total"]["output_tokens"] == 30
    assert data["org_total"]["cache_read_tokens"] == 3000
    assert data["org_total"]["call_count"] == 3
    assert data["org_total"]["cost_usd"] is None  # no costed events yet

    # owner sees the per-agent breakdown; the agent is marked reporting
    (row,) = [a for a in data["per_agent"] if a["agent_id"] == agent_id]
    assert row["reporting"] is True
    assert row["input_tokens"] == 300
    assert row["top_models"] == ["claude-opus-4-8"]

    # a costed event starts the $ accumulation from 0 (NULL-safe fold)
    r = _report(
        test_client, api_key, [_event("run1:c4", cost_usd=0.25, input_tokens=1)]
    )
    assert r.json()["ingested"] == 1
    total = test_client.get(
        f"/api/human/orgs/{org_id}/usage", headers=auth_headers(token)
    ).json()["org_total"]
    assert total["cost_usd"] == 0.25
    assert total["input_tokens"] == 301

    # a zero-token cost-only event (the plugin's per-call + turnUsd merge)
    # folds its $ WITHOUT counting a phantom model call
    calls_before = total["call_count"]
    r = _report(
        test_client,
        api_key,
        [_event("turn:r9", cost_usd=0.10, input_tokens=0, output_tokens=0,
                cache_read_tokens=0, cache_write_tokens=0)],
    )
    assert r.json()["ingested"] == 1
    total = test_client.get(
        f"/api/human/orgs/{org_id}/usage", headers=auth_headers(token)
    ).json()["org_total"]
    assert total["cost_usd"] == 0.35
    assert total["call_count"] == calls_before

    # group_by=model surfaces the per-model view
    data = test_client.get(
        f"/api/human/orgs/{org_id}/usage?group_by=model",
        headers=auth_headers(token),
    ).json()
    (m,) = data["per_model"]
    assert m["model"] == "claude-opus-4-8"
    assert m["provider"] == "anthropic"
    assert m["call_count"] == 4

    # daily series: today's bucket carries the totals and (for owners) the
    # per-agent split that drives the stacked trend chart
    (day,) = data["daily"]
    assert day["input_tokens"] == 301
    assert day["by_agent"][agent_id] == 301 + 40  # headline = in + out


def test_window_rejection_and_provider_derivation(
    test_client: TestClient, _test_engine
):
    agent_id, api_key, token, org_id = _setup(test_client, "usage-win@clawbits.ai")

    day_ms = 24 * 3600 * 1000
    r = _report(
        test_client,
        api_key,
        [
            # older than the 45-day retention horizon → rejected
            _event("old", occurred_at_ms=NOW_MS() - 46 * day_ms),
            # future beyond the 10-min skew bound → rejected (client clocks
            # must not write into future buckets of the permanent rollup)
            _event("future", occurred_at_ms=NOW_MS() + 3600 * 1000),
            # missing model → rejected, not a 422 (defensive ingest)
            {"event_id": "nomodel", "occurred_at_ms": NOW_MS(), "model": " "},
            # provider omitted → derived from the model prefix
            _event("ok", model="gpt-5.4", provider=None, input_tokens=7),
        ],
    )
    assert r.status_code == 200, r.text
    assert r.json()["ingested"] == 1
    assert r.json()["rejected"] == 3

    data = test_client.get(
        f"/api/human/orgs/{org_id}/usage?group_by=model",
        headers=auth_headers(token),
    ).json()
    assert data["org_total"]["input_tokens"] == 7
    (m,) = data["per_model"]
    assert m["provider"] == "openai"

    # the raw ledger holds exactly the accepted event
    with Session(_test_engine) as db:
        events = db.exec(
            select(AgentUsageEvent).where(AgentUsageEvent.agent_id == agent_id)
        ).all()
    assert [e.event_id for e in events] == ["ok"]
    assert events[0].provider == "openai"
    assert events[0].source == "hook"


def test_rbac_owner_member_and_stranger(test_client: TestClient, _test_engine):
    agent_id, api_key, owner_token, org_id = _setup(
        test_client, "usage-owner@clawbits.ai"
    )
    _report(test_client, api_key, [_event("r:1")])

    # a second human joins the org as a plain member
    member_token, member = login_human(test_client, "usage-member@clawbits.ai")
    with Session(_test_engine) as db:
        TableWrite.add_org_member(db, org_id, member["id"], "member")
        db.commit()

    # owner → full per-agent breakdown
    data = test_client.get(
        f"/api/human/orgs/{org_id}/usage", headers=auth_headers(owner_token)
    ).json()
    assert data["role"] == "owner"
    assert any(a["agent_id"] == agent_id for a in data["per_agent"])

    # member → org totals only; the per-agent breakdown is omitted entirely
    data = test_client.get(
        f"/api/human/orgs/{org_id}/usage", headers=auth_headers(member_token)
    ).json()
    assert data["role"] == "member"
    assert data["org_total"]["input_tokens"] == 100
    assert "per_agent" not in data
    # members get day totals but never the per-agent split
    assert len(data["daily"]) == 1
    assert "by_agent" not in data["daily"][0]

    # member may still ask for the per-model view (no agent attribution)
    data = test_client.get(
        f"/api/human/orgs/{org_id}/usage?group_by=model",
        headers=auth_headers(member_token),
    ).json()
    assert len(data["per_model"]) == 1

    # per-agent endpoint: owner yes; non-operator member no
    r = test_client.get(
        f"/api/human/orgs/{org_id}/agents/{agent_id}/usage",
        headers=auth_headers(owner_token),
    )
    assert r.status_code == 200, r.text
    assert r.json()["total"]["input_tokens"] == 100
    assert r.json()["reporting"] is True
    r = test_client.get(
        f"/api/human/orgs/{org_id}/agents/{agent_id}/usage",
        headers=auth_headers(member_token),
    )
    assert r.status_code == 403, r.text

    # a non-member sees nothing at all
    stranger_token, _ = login_human(test_client, "usage-stranger@clawbits.ai")
    r = test_client.get(
        f"/api/human/orgs/{org_id}/usage", headers=auth_headers(stranger_token)
    )
    assert r.status_code == 403, r.text

    # bad params are 400s, not silent defaults
    r = test_client.get(
        f"/api/human/orgs/{org_id}/usage?range=fortnight",
        headers=auth_headers(owner_token),
    )
    assert r.status_code == 400
    r = test_client.get(
        f"/api/human/orgs/{org_id}/usage?group_by=galaxy",
        headers=auth_headers(owner_token),
    )
    assert r.status_code == 400


def test_non_reporting_agent_stays_on_roster(test_client: TestClient, _test_engine):
    """An org agent that never reported renders as "no data" — the roster
    join must not silently drop it."""
    agent_id, api_key, token, org_id = _setup(test_client, "usage-roster@clawbits.ai")
    silent = _create_agent(test_client, owner_email="usage-roster@clawbits.ai")

    _report(test_client, api_key, [_event("r:1")])
    data = test_client.get(
        f"/api/human/orgs/{org_id}/usage", headers=auth_headers(token)
    ).json()
    rows = {a["agent_id"]: a for a in data["per_agent"]}
    assert rows[agent_id]["reporting"] is True
    assert rows[silent["agent_id"]]["reporting"] is False
    assert rows[silent["agent_id"]]["input_tokens"] == 0
    assert rows[silent["agent_id"]]["top_models"] == []
    # reporting agents sort ahead of silent ones
    assert data["per_agent"][0]["agent_id"] == agent_id


def test_delete_agent_with_usage_rows(test_client: TestClient, _test_engine):
    """Usage tables FK ``agents`` with no cascade — the agent delete must
    clear them or it 500s (same class of regression as automations)."""
    agent_id, api_key, token, org_id = _setup(test_client, "usage-del@clawbits.ai")
    r = _report(test_client, api_key, [_event("r:1"), _event("r:2")])
    assert r.json()["ingested"] == 2

    r = test_client.delete(
        f"/api/human/orgs/{org_id}/agents/{agent_id}",
        headers=auth_headers(token),
    )
    assert r.status_code == 200, r.text
    assert r.json()["deleted"] is True

    with Session(_test_engine) as db:
        assert db.get(Agent, agent_id) is None
        assert (
            db.exec(
                select(AgentUsageEvent).where(
                    AgentUsageEvent.agent_id == agent_id
                )
            ).first()
            is None
        )
        assert (
            db.exec(
                select(AgentUsageDaily).where(
                    AgentUsageDaily.agent_id == agent_id
                )
            ).first()
            is None
        )
