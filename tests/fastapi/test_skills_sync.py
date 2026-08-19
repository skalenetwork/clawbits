"""Tests for the skills sync plane: the agent self-report and the mirror."""
from __future__ import annotations

from fastapi.testclient import TestClient
from sqlmodel import Session, select

from clawbits.db.models import Agent, AgentSkillInstall, AgentSkillSyncState
from tests.fastapi._auth_helpers import login_human, personal_org_id
from tests.fastapi.conftest import _create_agent


def _setup(test_client: TestClient, email: str):
    data = _create_agent(test_client, owner_email=email)
    token, _ = login_human(test_client, email)
    org_id = personal_org_id(test_client, token)
    return data["agent_id"], data["api_key"], token, org_id


def _report(skills, **kw):
    return {
        "report_mode": "observe",
        "plugin_version": "0.16.0",
        "runtime": "openclaw",
        "runtime_version": "2026.6.11",
        "skills_root": "/home/node/.openclaw/workspace/skills",
        "scanned_roots": ["/home/node/.openclaw/workspace/skills", "/app/skills"],
        "apply_mode": "watch",
        "skills": skills,
        **kw,
    }


def test_report_mirrors_skills_and_surfaces_them(test_client: TestClient):
    agent_id, api_key, token, org_id = _setup(test_client, "sync-mirror@clawbits.ai")
    agent_h = {"Authorization": f"Bearer {api_key}"}
    human_h = {"Authorization": f"Bearer {token}"}

    r = test_client.post(
        "/api/agentic/skills/state",
        json=_report([
            {
                "slug": "clawbits-email",
                "source": "openclaw-extra",
                "root": "/app/skills",
                "path": "/app/skills/clawbits-email/SKILL.md",
                "manifest": {"name": "clawbits-email", "description": "How email works."},
                "state": {"eligible": True, "modelVisible": True},
            },
            {
                "slug": "weather",
                "source": "clawhub",
                "root": "/home/node/.openclaw/workspace/skills",
                "manifest": {"name": "weather", "description": "Get the weather."},
                "state": {"eligible": False, "missing": {"bins": ["jq"]}},
            },
        ], prompt_chars_observed=4820, prompt_budget_observed=30000),
        headers=agent_h,
    )
    assert r.status_code == 200, r.text
    assert r.json()["mirrored"] == 2
    assert r.json()["seen"] == 2

    r = test_client.get(
        f"/api/human/orgs/{org_id}/agents/{agent_id}/skills", headers=human_h
    )
    assert r.status_code == 200, r.text
    body = r.json()
    by_slug = {s["slug"]: s for s in body["skills"]}
    assert set(by_slug) == {"clawbits-email", "weather"}
    assert by_slug["weather"]["reported_source"] == "clawhub"
    assert by_slug["weather"]["eligible"] is False
    assert by_slug["weather"]["missing"] == {"bins": ["jq"]}
    assert by_slug["clawbits-email"]["managed_by"] == "external"
    assert body["sync"]["skills_root"] == "/home/node/.openclaw/workspace/skills"
    assert body["sync"]["prompt_budget_observed"] == 30000


def test_report_is_idempotent_and_drops_vanished_skills(test_client: TestClient):
    agent_id, api_key, token, org_id = _setup(test_client, "sync-idem@clawbits.ai")
    agent_h = {"Authorization": f"Bearer {api_key}"}
    human_h = {"Authorization": f"Bearer {token}"}
    two = [{"slug": "a", "manifest": {"name": "a", "description": "A"}},
           {"slug": "b", "manifest": {"name": "b", "description": "B"}}]

    test_client.post("/api/agentic/skills/state", json=_report(two), headers=agent_h)
    r = test_client.post("/api/agentic/skills/state", json=_report(two), headers=agent_h)
    # Re-reporting the same set creates nothing new.
    assert r.json()["mirrored"] == 0

    test_client.post("/api/agentic/skills/state", json=_report(two[:1]), headers=agent_h)
    listed = test_client.get(
        f"/api/human/orgs/{org_id}/agents/{agent_id}/skills", headers=human_h
    ).json()["skills"]
    assert [s["slug"] for s in listed] == ["a"]


def test_report_is_billing_exempt(test_client: TestClient, _test_engine):
    """It fires on a timer, so charging it would tax an agent for existing."""
    agent_id, api_key, _, _ = _setup(test_client, "sync-billing@clawbits.ai")
    with Session(_test_engine) as db:
        agent = db.get(Agent, agent_id)
        agent.cb_tokens = 0
        db.add(agent)
        db.commit()

    r = test_client.post(
        "/api/agentic/skills/state",
        json=_report([{"slug": "a", "manifest": {"name": "a", "description": "A"}}]),
        headers={"Authorization": f"Bearer {api_key}"},
    )
    assert r.status_code == 200, r.text


def test_report_requires_agent_key_and_ignores_body_agent_id(test_client: TestClient):
    _, api_key, _, _ = _setup(test_client, "sync-auth@clawbits.ai")
    other_id, _, _, _ = _setup(test_client, "sync-auth-other@clawbits.ai")

    assert test_client.post("/api/agentic/skills/state", json=_report([])).status_code == 401

    r = test_client.post(
        "/api/agentic/skills/state",
        json=_report([{"slug": "a", "manifest": {"name": "a", "description": "A"}}],
                     agent_id=other_id),
        headers={"Authorization": f"Bearer {api_key}"},
    )
    assert r.status_code == 200
    assert r.json()["mirrored"] == 1


def test_agent_skills_route_is_org_isolated(test_client: TestClient):
    agent_id, api_key, _, _ = _setup(test_client, "sync-iso-a@clawbits.ai")
    token_b, org_b = login_human(test_client, "sync-iso-b@clawbits.ai")[0], None
    org_b = personal_org_id(test_client, token_b)
    test_client.post(
        "/api/agentic/skills/state",
        json=_report([{"slug": "a", "manifest": {"name": "a", "description": "A"}}]),
        headers={"Authorization": f"Bearer {api_key}"},
    )
    r = test_client.get(
        f"/api/human/orgs/{org_b}/agents/{agent_id}/skills",
        headers={"Authorization": f"Bearer {token_b}"},
    )
    assert r.status_code == 404


def _create_skill(test_client, token, org_id, slug="house-style"):
    return test_client.post(
        f"/api/human/orgs/{org_id}/skills",
        json={
            "slug": slug,
            "display_name": slug,
            "manifest": {"name": slug, "description": "House style."},
            "body_md": "# House style\n\nWrite plainly.\n",
        },
        headers={"Authorization": f"Bearer {token}"},
    ).json()


def test_install_appears_in_desired_and_uninstall_needs_confirmation(test_client: TestClient):
    agent_id, api_key, token, org_id = _setup(test_client, "m3-install@clawbits.ai")
    h = {"Authorization": f"Bearer {token}"}
    agent_h = {"Authorization": f"Bearer {api_key}"}
    skill = _create_skill(test_client, token, org_id)

    r = test_client.post(
        f"/api/human/orgs/{org_id}/agents/{agent_id}/skills",
        json={"skill_id": skill["skill_id"]},
        headers=h,
    )
    assert r.status_code == 200, r.text

    desired = test_client.get("/api/agentic/skills/desired", headers=agent_h).json()
    assert len(desired["skills"]) == 1
    item = desired["skills"][0]
    assert item["slug"] == "house-style"
    assert item["intent"] == "present"
    assert item["content_hash"] == skill["content_hash"]
    assert desired["paused"] is False

    # The version's files, with SKILL.md rendered for the runtime.
    content = test_client.get(
        f"/api/agentic/skills/versions/{item['version_id']}", headers=agent_h
    ).json()
    assert content["files"][0]["path"] == "SKILL.md"
    assert 'name: "house-style"' in content["files"][0]["content"]

    install_id = next(
        s["install_id"]
        for s in test_client.get(
            f"/api/human/orgs/{org_id}/agents/{agent_id}/skills", headers=h
        ).json()["skills"]
    )
    test_client.delete(
        f"/api/human/orgs/{org_id}/agents/{agent_id}/skills/{install_id}", headers=h
    )

    # Still present as a tombstone with intent 'absent' — it is gone only once
    # the agent confirms the directory is deleted.
    desired = test_client.get("/api/agentic/skills/desired", headers=agent_h).json()
    assert [s["intent"] for s in desired["skills"]] == ["absent"]

    test_client.post(
        "/api/agentic/skills/state",
        json=_report([{"slug": "house-style", "status": "removed", "observed_generation": 99}],
                     report_mode="apply"),
        headers=agent_h,
    )
    assert test_client.get("/api/agentic/skills/desired", headers=agent_h).json()["skills"] == []


def test_publish_propagates_without_touching_install_rows(test_client: TestClient):
    """A new version changes the desired hash with no fan-out write."""
    agent_id, api_key, token, org_id = _setup(test_client, "m3-propagate@clawbits.ai")
    h = {"Authorization": f"Bearer {token}"}
    agent_h = {"Authorization": f"Bearer {api_key}"}
    skill = _create_skill(test_client, token, org_id)
    test_client.post(
        f"/api/human/orgs/{org_id}/agents/{agent_id}/skills",
        json={"skill_id": skill["skill_id"]},
        headers=h,
    )
    before = test_client.get("/api/agentic/skills/desired", headers=agent_h).json()["skills"][0]

    test_client.post(
        f"/api/human/orgs/{org_id}/skills/{skill['skill_id']}/versions",
        json={
            "manifest": {"name": "house-style", "description": "House style, v2."},
            "body_md": "# v2\n",
        },
        headers=h,
    )
    after = test_client.get("/api/agentic/skills/desired", headers=agent_h).json()["skills"][0]
    assert after["content_hash"] != before["content_hash"]
    assert after["version"] == "1.0.1"


def test_disable_makes_intent_absent(test_client: TestClient):
    agent_id, api_key, token, org_id = _setup(test_client, "m3-disable@clawbits.ai")
    h = {"Authorization": f"Bearer {token}"}
    agent_h = {"Authorization": f"Bearer {api_key}"}
    skill = _create_skill(test_client, token, org_id)
    body = test_client.post(
        f"/api/human/orgs/{org_id}/agents/{agent_id}/skills",
        json={"skill_id": skill["skill_id"]},
        headers=h,
    ).json()
    install_id = body["skills"][0]["install_id"]

    test_client.patch(
        f"/api/human/orgs/{org_id}/agents/{agent_id}/skills/{install_id}",
        json={"enabled": False},
        headers=h,
    )
    desired = test_client.get("/api/agentic/skills/desired", headers=agent_h).json()
    assert [s["intent"] for s in desired["skills"]] == ["absent"]


def test_disable_converges_once_the_agent_confirms_removal(test_client: TestClient):
    """A disable is an 'absent' intent, not a delete: the row survives so it can
    be re-enabled. It must still SETTLE - the removed-report used to be discarded
    for any row without ``deleted_at``, leaving the install stuck at 'requested'
    with observed_generation behind desired forever."""
    agent_id, api_key, token, org_id = _setup(test_client, "m3-disable-conv@clawbits.ai")
    h = {"Authorization": f"Bearer {token}"}
    agent_h = {"Authorization": f"Bearer {api_key}"}
    skill = _create_skill(test_client, token, org_id)
    install_id = test_client.post(
        f"/api/human/orgs/{org_id}/agents/{agent_id}/skills",
        json={"skill_id": skill["skill_id"]},
        headers=h,
    ).json()["skills"][0]["install_id"]

    test_client.patch(
        f"/api/human/orgs/{org_id}/agents/{agent_id}/skills/{install_id}",
        json={"enabled": False},
        headers=h,
    )
    item = test_client.get("/api/agentic/skills/desired", headers=agent_h).json()["skills"][0]
    assert item["intent"] == "absent"

    test_client.post(
        "/api/agentic/skills/state",
        json=_report(
            [{
                "slug": "house-style",
                "status": "removed",
                "observed_generation": item["desired_generation"],
            }],
            report_mode="apply",
        ),
        headers=agent_h,
    )

    row = test_client.get(
        f"/api/human/orgs/{org_id}/agents/{agent_id}/skills", headers=h
    ).json()["skills"][0]
    assert row["enabled"] is False
    assert row["sync_status"] == "applied", "a disabled install must converge, not spin"
    assert row["sync_error"] is None

    # And it is still re-enablable: a disable is not a delete.
    test_client.patch(
        f"/api/human/orgs/{org_id}/agents/{agent_id}/skills/{install_id}",
        json={"enabled": True},
        headers=h,
    )
    back = test_client.get("/api/agentic/skills/desired", headers=agent_h).json()["skills"][0]
    assert back["intent"] == "present"


def test_deleting_a_library_skill_uninstalls_it_from_agents(test_client: TestClient):
    """Deleting from the library must REMOVE the skill from every agent. The soft
    delete leaves latest_version_id intact, so without the fan-out the feed kept
    saying 'present' forever - the org sees it gone while agents keep running it."""
    agent_id, api_key, token, org_id = _setup(test_client, "m3-delete-fanout@clawbits.ai")
    h = {"Authorization": f"Bearer {token}"}
    agent_h = {"Authorization": f"Bearer {api_key}"}
    skill = _create_skill(test_client, token, org_id)
    test_client.post(
        f"/api/human/orgs/{org_id}/agents/{agent_id}/skills",
        json={"skill_id": skill["skill_id"]},
        headers=h,
    )
    assert [
        s["intent"]
        for s in test_client.get("/api/agentic/skills/desired", headers=agent_h).json()["skills"]
    ] == ["present"]

    r = test_client.delete(
        f"/api/human/orgs/{org_id}/skills/{skill['skill_id']}", headers=h
    )
    assert r.status_code in (200, 204), r.text

    # Gone from the library...
    listed = test_client.get(f"/api/human/orgs/{org_id}/skills", headers=h).json()["skills"]
    assert [s["skill_id"] for s in listed] == []

    # ...and actively being removed from the agent, not silently left behind.
    item = test_client.get("/api/agentic/skills/desired", headers=agent_h).json()["skills"][0]
    assert item["intent"] == "absent"
    row = test_client.get(
        f"/api/human/orgs/{org_id}/agents/{agent_id}/skills", headers=h
    ).json()["skills"][0]
    assert row["sync_status"] == "removing"

    test_client.post(
        "/api/agentic/skills/state",
        json=_report(
            [{
                "slug": "house-style",
                "status": "removed",
                "observed_generation": item["desired_generation"],
            }],
            report_mode="apply",
        ),
        headers=agent_h,
    )
    assert test_client.get("/api/agentic/skills/desired", headers=agent_h).json()["skills"] == []


def test_agent_cannot_fetch_a_version_it_has_no_install_for(test_client: TestClient):
    _, api_key, token, org_id = _setup(test_client, "m3-entitle@clawbits.ai")
    skill = _create_skill(test_client, token, org_id)
    r = test_client.get(
        f"/api/agentic/skills/versions/{skill['latest_version_id']}",
        headers={"Authorization": f"Bearer {api_key}"},
    )
    assert r.status_code == 404


def test_cannot_install_another_orgs_skill(test_client: TestClient):
    agent_id, _, token_a, org_a = _setup(test_client, "m3-iso-a@clawbits.ai")
    token_b, _ = login_human(test_client, "m3-iso-b@clawbits.ai")
    org_b = personal_org_id(test_client, token_b)
    victim = _create_skill(test_client, token_b, org_b, slug="secret-style")

    r = test_client.post(
        f"/api/human/orgs/{org_a}/agents/{agent_id}/skills",
        json={"skill_id": victim["skill_id"]},
        headers={"Authorization": f"Bearer {token_a}"},
    )
    assert r.status_code == 404


def test_library_reports_confirmed_installs_separately_from_pending(test_client: TestClient):
    """The library dot must mean "the agent has it", not "we asked"."""
    agent_id, api_key, token, org_id = _setup(test_client, "m3-counts@clawbits.ai")
    h = {"Authorization": f"Bearer {token}"}
    agent_h = {"Authorization": f"Bearer {api_key}"}
    skill = _create_skill(test_client, token, org_id, slug="counted-style")

    def library_row():
        rows = test_client.get(f"/api/human/orgs/{org_id}/skills", headers=h).json()["skills"]
        return next(s for s in rows if s["skill_id"] == skill["skill_id"])

    row = library_row()
    assert (row["installed_agent_count"], row["pending_agent_count"]) == (0, 0)

    test_client.post(
        f"/api/human/orgs/{org_id}/agents/{agent_id}/skills",
        json={"skill_id": skill["skill_id"]},
        headers=h,
    )
    # Requested, not confirmed: pending, and NOT counted as installed.
    row = library_row()
    assert (row["installed_agent_count"], row["pending_agent_count"]) == (0, 1)

    test_client.post(
        "/api/agentic/skills/state",
        json=_report(
            [{
                "slug": "counted-style",
                "root": "/home/node/.openclaw/workspace/skills",
                "manifest": {"name": "counted-style", "description": "House style."},
                "content_hash": skill["content_hash"],
                "status": "applied",
                "observed_generation": 1,
            }],
            report_mode="apply",
        ),
        headers=agent_h,
    )
    row = library_row()
    assert (row["installed_agent_count"], row["pending_agent_count"]) == (1, 0)

    # The detail projection carries the same numbers — the inspector reads it.
    detail = test_client.get(
        f"/api/human/orgs/{org_id}/skills/{skill['skill_id']}", headers=h
    ).json()
    assert detail["installed_agent_count"] == 1

    # A removal is in flight until the agent confirms it, so it leaves the
    # confirmed count and shows up as pending rather than vanishing.
    install_id = test_client.get(
        f"/api/human/orgs/{org_id}/agents/{agent_id}/skills", headers=h
    ).json()["skills"][0]["install_id"]
    test_client.delete(
        f"/api/human/orgs/{org_id}/agents/{agent_id}/skills/{install_id}", headers=h
    )
    row = library_row()
    assert (row["installed_agent_count"], row["pending_agent_count"]) == (0, 1)


def test_delete_agent_with_skill_rows(test_client: TestClient, _test_engine):
    """Deleting an agent that reported skills must not FK-error.

    ``agent_skill_installs.agent_id`` and ``agent_skill_sync_state.agent_id``
    both FK ``agents`` with no ON DELETE cascade, so the delete has to clear
    them or the whole thing 500s. The sync-state row is written by *every*
    self-report, so without this every agent whose plugin ever reported is
    undeletable. Same class of regression as automations and usage.
    """
    agent_id, api_key, token, org_id = _setup(test_client, "skill-del@clawbits.ai")

    r = test_client.post(
        "/api/agentic/skills/state",
        json=_report([
            {
                "slug": "doomed",
                "root": "/home/node/.openclaw/workspace/skills",
                "manifest": {"name": "doomed", "description": "Goes with the agent."},
            }
        ]),
        headers={"Authorization": f"Bearer {api_key}"},
    )
    assert r.status_code == 200, r.text

    r = test_client.delete(
        f"/api/human/orgs/{org_id}/agents/{agent_id}",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["deleted"] is True

    with Session(_test_engine) as db:
        assert db.get(Agent, agent_id) is None
        assert db.get(AgentSkillSyncState, agent_id) is None
        assert db.exec(
            select(AgentSkillInstall).where(AgentSkillInstall.agent_id == agent_id)
        ).all() == []


def test_delete_agent_keep_content_with_skill_rows(
    test_client: TestClient, _test_engine
):
    """The keep-content path drops the same rows: skills are the agent's own
    control-plane state, not authored content to re-home onto the placeholder.
    """
    agent_id, api_key, token, org_id = _setup(test_client, "skill-del-keep@clawbits.ai")
    test_client.post(
        "/api/agentic/skills/state",
        json=_report([
            {
                "slug": "doomed-too",
                "root": "/home/node/.openclaw/workspace/skills",
                "manifest": {"name": "doomed-too", "description": "Also goes."},
            }
        ]),
        headers={"Authorization": f"Bearer {api_key}"},
    )

    r = test_client.delete(
        f"/api/human/orgs/{org_id}/agents/{agent_id}?keep_content=true",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 200, r.text

    with Session(_test_engine) as db:
        assert db.get(Agent, agent_id) is None
        assert db.get(AgentSkillSyncState, agent_id) is None
        assert db.exec(
            select(AgentSkillInstall).where(AgentSkillInstall.agent_id == agent_id)
        ).all() == []
