"""Tests for the skills sync plane: the agent self-report and the mirror."""
from __future__ import annotations

import datetime as dt
import hashlib
from typing import NamedTuple

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from clawbits.db.models import Agent, AgentSkillInstall, AgentSkillSyncState
from clawbits.fastapi import human_endpoints
from tests.fastapi._auth_helpers import add_human_to_org, login_human, personal_org_id
from tests.fastapi.conftest import _create_agent

WRITE_ROOT = "/home/node/.openclaw/workspace/skills"


class _Agent(NamedTuple):
    agent_id: str
    org_id: str
    token: str
    agent_h: dict[str, str]
    h: dict[str, str]

    @property
    def base(self) -> str:
        return f"/api/human/orgs/{self.org_id}/agents/{self.agent_id}/skills"


def _setup(test_client: TestClient, email: str) -> _Agent:
    data = _create_agent(test_client, owner_email=email)
    token, _ = login_human(test_client, email)
    return _Agent(
        data["agent_id"],
        personal_org_id(test_client, token),
        token,
        {"Authorization": f"Bearer {data['api_key']}"},
        {"Authorization": f"Bearer {token}"},
    )


def _report(skills, **kw):
    return {
        "report_mode": "observe",
        "plugin_version": "0.16.0",
        "runtime": "openclaw",
        "runtime_version": "2026.6.11",
        "skills_root": WRITE_ROOT,
        "scanned_roots": [WRITE_ROOT, "/app/skills"],
        "apply_mode": "watch",
        "skills": skills,
        **kw,
    }


def _state(test_client, a: _Agent, skills, **kw) -> dict:
    r = test_client.post("/api/agentic/skills/state", json=_report(skills, **kw), headers=a.agent_h)
    assert r.status_code == 200, r.text
    return r.json()


def _scan(slug, skill_md=None, *, root=WRITE_ROOT):
    """One scan item as the plugin sends it: hash always, body only when new."""
    text = skill_md or f"---\nname: {slug}\ndescription: D.\n---\n\nBody\n"
    return {
        "slug": slug,
        "root": root,
        "path": f"{root}/{slug}/SKILL.md",
        "manifest": {"name": slug, "description": "D."},
        "content_hash": "sha256:" + hashlib.sha256(text.encode()).hexdigest(),
        "skill_md": text,
    }


def _applied(item) -> dict:
    """The outcome the plugin reports after writing ``item`` to disk."""
    return {
        "install_id": item["install_id"],
        "slug": item["slug"],
        "observed_generation": item["desired_generation"],
        "status": "applied",
        "content_hash": item["content_hash"],
    }


def _removed(item) -> dict:
    """The outcome the plugin reports after deleting ``item``'s directory."""
    obs = item["desired_generation"]
    return {"slug": item["slug"], "status": "removed", "observed_generation": obs}


def _skills(test_client, a: _Agent) -> dict:
    return test_client.get(a.base, headers=a.h).json()


def _content(test_client, a: _Agent, install_id) -> dict:
    return test_client.get(f"{a.base}/{install_id}/content", headers=a.h).json()


def _desired(test_client, a: _Agent) -> dict[str, dict]:
    skills = test_client.get("/api/agentic/skills/desired", headers=a.agent_h).json()["skills"]
    return {s["slug"]: s for s in skills}


def _create_skill(test_client, a: _Agent, slug="house-style"):
    return test_client.post(
        f"/api/human/orgs/{a.org_id}/skills",
        json={
            "slug": slug,
            "display_name": slug,
            "manifest": {"name": slug, "description": "House style."},
            "body_md": "# House style\n\nWrite plainly.\n",
        },
        headers=a.h,
    ).json()


def _install(test_client, a: _Agent, skill) -> str:
    r = test_client.post(a.base, json={"skill_id": skill["skill_id"]}, headers=a.h)
    assert r.status_code == 200, r.text
    return next(s["install_id"] for s in r.json()["skills"] if s["slug"] == skill["slug"])


def _record_syncs(monkeypatch) -> list[str]:
    sent: list[str] = []
    monkeypatch.setattr(human_endpoints, "_nudge_skills", sent.extend)
    return sent


def test_report_mirrors_skills_and_surfaces_them(test_client: TestClient):
    a = _setup(test_client, "sync-mirror@clawbits.ai")
    ack = _state(test_client, a, [
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
            "root": WRITE_ROOT,
            "manifest": {"name": "weather", "description": "Get the weather."},
            "state": {"eligible": False, "missing": {"bins": ["jq"]}},
        },
    ])
    assert (ack["seen"], ack["mirrored"]) == (2, 2)

    by_slug = {s["slug"]: s for s in _skills(test_client, a)["skills"]}
    assert set(by_slug) == {"clawbits-email", "weather"}
    assert by_slug["weather"]["reported_source"] == "clawhub"
    assert by_slug["weather"]["eligible"] is False
    assert by_slug["weather"]["missing"] == {"bins": ["jq"]}
    assert by_slug["clawbits-email"]["managed_by"] == "external"


def test_report_is_idempotent_and_drops_vanished_skills(test_client: TestClient):
    a = _setup(test_client, "sync-idem@clawbits.ai")
    two = [{"slug": "a", "manifest": {"name": "a", "description": "A"}},
           {"slug": "b", "manifest": {"name": "b", "description": "B"}}]

    _state(test_client, a, two)
    # Re-reporting the same set creates nothing new.
    assert _state(test_client, a, two)["mirrored"] == 0

    _state(test_client, a, two[:1])
    assert [s["slug"] for s in _skills(test_client, a)["skills"]] == ["a"]


def test_report_is_billing_exempt(test_client: TestClient, _test_engine):
    """It fires on a timer, so charging it would tax an agent for existing."""
    a = _setup(test_client, "sync-billing@clawbits.ai")
    with Session(_test_engine) as db:
        agent = db.get(Agent, a.agent_id)
        agent.cb_tokens = 0
        db.add(agent)
        db.commit()

    _state(test_client, a, [{"slug": "a", "manifest": {"name": "a", "description": "A"}}])


def test_report_requires_agent_key_and_ignores_body_agent_id(test_client: TestClient):
    a = _setup(test_client, "sync-auth@clawbits.ai")
    other = _setup(test_client, "sync-auth-other@clawbits.ai")

    assert test_client.post("/api/agentic/skills/state", json=_report([])).status_code == 401

    item = {"slug": "a", "manifest": {"name": "a", "description": "A"}}
    assert _state(test_client, a, [item], agent_id=other.agent_id)["mirrored"] == 1
    assert _skills(test_client, other)["skills"] == []


def test_install_appears_in_desired_and_uninstall_needs_confirmation(test_client: TestClient):
    a = _setup(test_client, "m3-install@clawbits.ai")
    skill = _create_skill(test_client, a)
    install_id = _install(test_client, a, skill)

    desired = test_client.get("/api/agentic/skills/desired", headers=a.agent_h).json()
    assert desired["paused"] is False
    [item] = desired["skills"]
    assert (item["slug"], item["intent"]) == ("house-style", "present")
    assert item["content_hash"] == skill["content_hash"]

    # The version's files, with SKILL.md rendered for the runtime.
    files = test_client.get(
        f"/api/agentic/skills/versions/{item['version_id']}", headers=a.agent_h
    ).json()["files"]
    assert files[0]["path"] == "SKILL.md"
    assert 'name: "house-style"' in files[0]["content"]

    # Uninstalled, it stays desired 'absent' until the agent confirms the
    # directory is deleted.
    test_client.delete(f"{a.base}/{install_id}", headers=a.h)
    item = _desired(test_client, a)["house-style"]
    assert item["intent"] == "absent"

    _state(test_client, a, [_removed(item)], report_mode="apply")
    assert _desired(test_client, a) == {}


def test_disable_converges_once_the_agent_confirms_removal(test_client: TestClient):
    """A disable is an 'absent' intent, not a delete: the row survives so it can
    be re-enabled. It must still SETTLE - the removed-report used to be discarded
    for any row without ``deleted_at``, leaving the install stuck at 'requested'
    with observed_generation behind desired forever."""
    a = _setup(test_client, "m3-disable-conv@clawbits.ai")
    install_id = _install(test_client, a, _create_skill(test_client, a))

    test_client.patch(f"{a.base}/{install_id}", json={"enabled": False}, headers=a.h)
    item = _desired(test_client, a)["house-style"]
    assert item["intent"] == "absent"

    _state(test_client, a, [_removed(item)], report_mode="apply")
    [row] = _skills(test_client, a)["skills"]
    assert row["enabled"] is False
    assert row["sync_status"] == "applied", "a disabled install must converge, not spin"
    assert row["sync_error"] is None

    # And it is still re-enablable: a disable is not a delete.
    test_client.patch(f"{a.base}/{install_id}", json={"enabled": True}, headers=a.h)
    assert _desired(test_client, a)["house-style"]["intent"] == "present"


def test_deleting_a_library_skill_uninstalls_it_from_agents(test_client: TestClient):
    """Deleting from the library must REMOVE the skill from every agent. The soft
    delete leaves latest_version_id intact, so without the fan-out the feed kept
    saying 'present' forever - the org sees it gone while agents keep running it."""
    a = _setup(test_client, "m3-delete-fanout@clawbits.ai")
    skill = _create_skill(test_client, a)
    _install(test_client, a, skill)
    assert _desired(test_client, a)["house-style"]["intent"] == "present"

    r = test_client.delete(f"/api/human/orgs/{a.org_id}/skills/{skill['skill_id']}", headers=a.h)
    assert r.status_code == 200, r.text
    assert test_client.get(f"/api/human/orgs/{a.org_id}/skills", headers=a.h).json() == {
        "skills": []
    }

    # Gone from the library, and actively being removed from the agent.
    item = _desired(test_client, a)["house-style"]
    assert item["intent"] == "absent"
    assert _skills(test_client, a)["skills"][0]["sync_status"] == "removing"

    _state(test_client, a, [_removed(item)], report_mode="apply")
    assert _desired(test_client, a) == {}


def test_agent_cannot_fetch_a_version_it_has_no_install_for(test_client: TestClient):
    a = _setup(test_client, "m3-entitle@clawbits.ai")
    skill = _create_skill(test_client, a)
    r = test_client.get(
        f"/api/agentic/skills/versions/{skill['latest_version_id']}", headers=a.agent_h
    )
    assert r.status_code == 404


def test_cannot_install_another_orgs_skill(test_client: TestClient):
    a = _setup(test_client, "m3-iso-a@clawbits.ai")
    victim = _create_skill(test_client, _setup(test_client, "m3-iso-b@clawbits.ai"), "secret")
    r = test_client.post(a.base, json={"skill_id": victim["skill_id"]}, headers=a.h)
    assert r.status_code == 404


@pytest.mark.parametrize("keep_content", [False, True])
def test_delete_agent_with_skill_rows(test_client: TestClient, _test_engine, keep_content):
    """Deleting an agent that reported skills must not FK-error.

    ``agent_skill_installs.agent_id`` and ``agent_skill_sync_state.agent_id``
    both FK ``agents`` with no ON DELETE cascade, so the delete has to clear
    them or the whole thing 500s. The sync-state row is written by *every*
    self-report, so without this every agent whose plugin ever reported is
    undeletable. The keep-content path drops the same rows: skills are the
    agent's own control-plane state, not authored content to re-home.
    """
    a = _setup(test_client, f"skill-del-{keep_content}@clawbits.ai")
    _state(test_client, a, [_scan("doomed")])

    r = test_client.delete(
        f"/api/human/orgs/{a.org_id}/agents/{a.agent_id}",
        params={"keep_content": keep_content},
        headers=a.h,
    )
    assert r.status_code == 200, r.text
    assert r.json()["deleted"] is True

    with Session(_test_engine) as db:
        assert db.get(Agent, a.agent_id) is None
        assert db.get(AgentSkillSyncState, a.agent_id) is None
        assert db.exec(
            select(AgentSkillInstall).where(AgentSkillInstall.agent_id == a.agent_id)
        ).all() == []


def test_reported_skill_md_is_kept_per_hash(test_client: TestClient):
    a = _setup(test_client, "content-retain@clawbits.ai")

    def report(*items):
        _state(test_client, a, list(items))
        return {s["slug"]: s for s in _skills(test_client, a)["skills"]}

    # A UTF-16 SKILL.md reads as UTF-8 full of NULs, which a Postgres text
    # column refuses; storing it would fail every report from that agent.
    first = _scan("notes")
    rows = report(first, _scan("utf16", "��-\x00-\x00-\x00"))
    assert (rows["notes"]["has_content"], rows["utf16"]["has_content"]) == (True, False)
    install_id = rows["notes"]["install_id"]
    assert _content(test_client, a, install_id) == {
        "skill_md": first["skill_md"],
        "omitted_reason": None,
    }

    # Same hash, no body: the plugin already sent it, so the server keeps it.
    assert report({**first, "skill_md": None})["notes"]["has_content"] is True

    # A new hash without a body clears the stale one.
    assert report({**_scan("notes", "v2"), "skill_md": None})["notes"]["has_content"] is False
    assert _content(test_client, a, install_id) == {
        "skill_md": None,
        "omitted_reason": "not_reported",
    }

    report({**_scan("notes", "v3"), "skill_md": None, "skill_md_omitted": "too_large"})
    assert _content(test_client, a, install_id)["omitted_reason"] == "too_large"


def test_bundled_and_reporter_status(test_client: TestClient, _test_engine):
    a = _setup(test_client, "content-bundled@clawbits.ai")

    sync = _skills(test_client, a)["sync"]
    assert (sync["reporter"], sync["bundled"]) == ("never_reported", None)

    bundled = [{"slug": "github", "description": "Use gh."}, {"slug": "weather"}, {"nope": 1}]
    _state(test_client, a, [], bundled=bundled)
    sync = _skills(test_client, a)["sync"]
    assert sync["reporter"] == "ok"
    assert sync["bundled"] == [
        {"slug": "github", "description": "Use gh."},
        {"slug": "weather", "description": None},
    ]

    # Absent means unchanged.
    _state(test_client, a, [])
    assert len(_skills(test_client, a)["sync"]["bundled"]) == 2

    with Session(_test_engine) as db:
        state = db.get(AgentSkillSyncState, a.agent_id)
        state.last_reported_at = dt.datetime.now(dt.UTC) - dt.timedelta(seconds=901)
        db.add(state)
        db.commit()
    assert _skills(test_client, a)["sync"]["reporter"] == "stale"


def test_apply_outcome_settles_without_clobbering_the_mirror(test_client: TestClient):
    """The plugin reports a scan item and an outcome for the same slug in one
    pass. The outcome used to overwrite the mirror, blanking the manifest; now
    it would also have dropped the stored SKILL.md."""
    a = _setup(test_client, "content-outcome@clawbits.ai")
    skill = _create_skill(test_client, a)
    install_id = _install(test_client, a, skill)
    item = _desired(test_client, a)["house-style"]
    assert item["takeover"] is False

    rendered = test_client.get(
        f"/api/agentic/skills/versions/{item['version_id']}", headers=a.agent_h
    ).json()["files"][0]["content"]
    _state(test_client, a, [_scan("house-style", rendered), _applied(item)], report_mode="apply")

    [row] = _skills(test_client, a)["skills"]
    assert row["sync_status"] == "applied"
    assert row["description"] == "D."
    assert row["has_content"] is True
    # A managed install shows the library's rendering, the bytes on the agent's disk.
    assert _content(test_client, a, install_id)["skill_md"] == rendered

    [agent] = test_client.get(
        f"/api/human/orgs/{a.org_id}/skills/{skill['skill_id']}", headers=a.h
    ).json()["agents"]
    assert agent == {
        "agent_id": a.agent_id,
        "nickname": agent["nickname"],
        "install_id": install_id,
        "sync_status": "applied",
        "channel": "latest",
        "pinned_version_id": None,
        "installed_version": "1.0.0",
        "sync_error": None,
    }


def test_draft_and_adopt_take_over_the_agents_copy(test_client: TestClient, monkeypatch):
    a = _setup(test_client, "content-adopt@clawbits.ai")
    own = "---\nname: field-notes\ndescription: Keep field notes.\n---\n\n# Notes\n"
    _state(test_client, a, [
        _scan("field-notes", own),
        _scan("elsewhere", root="/home/node/.agents/skills"),
        {**_scan("bodiless"), "skill_md": None},
    ])
    ids = {s["slug"]: s["install_id"] for s in _skills(test_client, a)["skills"]}

    def adopt(slug, skill_id):
        return test_client.post(
            f"{a.base}/{ids[slug]}/adopt", json={"skill_id": skill_id}, headers=a.h
        )

    assert test_client.get(f"{a.base}/{ids['bodiless']}/draft", headers=a.h).status_code == 409
    draft = test_client.get(f"{a.base}/{ids['field-notes']}/draft", headers=a.h).json()
    assert draft["source"] == {"kind": "agent"}
    assert draft["slug"] == "field-notes"
    assert draft["body_md"] == "# Notes\n"
    assert draft["manifest"]["description"] == "Keep field notes."

    skill = test_client.post(
        f"/api/human/orgs/{a.org_id}/skills",
        json={k: draft[k] for k in ("slug", "display_name", "manifest", "body_md", "files")},
        headers=a.h,
    ).json()
    other = _create_skill(test_client, a, "elsewhere")

    # A plain install would collide with the agent's own copy in its write root.
    r = test_client.post(a.base, json={"skill_id": skill["skill_id"]}, headers=a.h)
    assert r.status_code == 422
    assert "adopt" in r.json()["detail"]
    assert adopt("field-notes", other["skill_id"]).status_code == 409, "names must match"

    sent = _record_syncs(monkeypatch)
    for slug, library in (("field-notes", skill), ("elsewhere", other)):
        r = adopt(slug, library["skill_id"])
        assert r.status_code == 200, r.text
        assert (r.json()["install_id"], r.json()["managed_by"]) == (ids[slug], "clawbits")
    assert sent == [a.agent_id, a.agent_id]
    assert adopt("field-notes", skill["skill_id"]).status_code == 409, "already managed"

    # Only the copy in the write root needs replacing; the other is shadowed.
    desired = _desired(test_client, a)
    assert desired["field-notes"]["takeover"] is True
    assert desired["elsewhere"]["takeover"] is False

    _state(test_client, a, [_applied(desired["field-notes"])], report_mode="apply")
    assert _desired(test_client, a)["field-notes"]["takeover"] is False, "one-shot"


def test_install_on_agents_checks_each_agent(test_client: TestClient, _test_engine, monkeypatch):
    email = "bulk-owner@clawbits.ai"
    a = _setup(test_client, email)
    fresh = a.agent_id
    installed = _create_agent(test_client, owner_email=email)["agent_id"]
    hermes = _create_agent(test_client, owner_email=email)["agent_id"]
    holder = _create_agent(test_client, owner_email=email)
    outsider = _setup(test_client, "bulk-outsider@clawbits.ai").agent_id
    with Session(_test_engine) as db:
        row = db.get(Agent, hermes)
        row.agent_type = "hermes"
        db.add(row)
        db.commit()

    skill = _create_skill(test_client, a, "bulk-style")
    _install(test_client, a._replace(agent_id=installed), skill)
    holder_h = {"Authorization": f"Bearer {holder['api_key']}"}
    _state(test_client, a._replace(agent_h=holder_h), [_scan("bulk-style")])

    sent = _record_syncs(monkeypatch)
    url = f"/api/human/orgs/{a.org_id}/skills/{skill['skill_id']}/installs"
    agent_ids = [fresh, installed, hermes, holder["agent_id"], outsider, fresh]
    r = test_client.post(url, json={"agent_ids": agent_ids}, headers=a.h)
    assert r.status_code == 200, r.text
    assert len(r.json()["results"]) == 5
    results = {x["agent_id"]: x for x in r.json()["results"]}
    assert results[fresh]["status"] == "requested" and results[fresh]["install_id"]
    assert results[installed]["status"] == "already_installed"
    assert results[hermes]["status"] == "refused"
    assert "OpenClaw" in results[hermes]["detail"]
    assert results[holder["agent_id"]]["status"] == "refused"
    assert "adopt" in results[holder["agent_id"]]["detail"]
    assert results[outsider] == {
        "agent_id": outsider,
        "status": "refused",
        "detail": "Agent not found in this organization",
    }
    assert sent == [fresh]

    member_token, _ = login_human(test_client, "bulk-member@clawbits.ai")
    add_human_to_org(test_client, a.token, a.org_id, "bulk-member@clawbits.ai")
    r = test_client.post(
        url, json={"agent_ids": [fresh]}, headers={"Authorization": f"Bearer {member_token}"}
    )
    assert r.json()["results"][0]["status"] == "refused"
    assert "operator" in r.json()["results"][0]["detail"]


def test_desired_changes_publish_skills_sync(test_client: TestClient, monkeypatch):
    a = _setup(test_client, "content-sync@clawbits.ai")
    skill = _create_skill(test_client, a)
    skill_url = f"/api/human/orgs/{a.org_id}/skills/{skill['skill_id']}"
    sent = _record_syncs(monkeypatch)

    def publish(n):
        return test_client.post(
            f"{skill_url}/versions",
            json={"manifest": {"name": "house-style", "description": f"v{n}"}, "body_md": "#\n"},
            headers=a.h,
        ).json()

    def patch(body):
        return test_client.patch(f"{a.base}/{install_id}", json=body, headers=a.h)

    def desired_version():
        return _desired(test_client, a)["house-style"]["version"]

    install_id = _install(test_client, a, skill)
    second = publish(2)
    assert desired_version() == "1.0.1"
    assert patch({"pinned_version_id": second["version_id"]}).status_code == 200
    assert sent == [a.agent_id] * 3

    # A pinned install does not move, so a publish has nobody to wake.
    publish(3)
    assert sent == [a.agent_id] * 3
    assert desired_version() == "1.0.1"

    patch({"pinned_version_id": skill["latest_version_id"]})
    assert desired_version() == "1.0.0"
    assert patch({"pinned_version_id": "skillver-nope"}).status_code == 404
    patch({"channel": "latest"})
    assert desired_version() == "1.0.2"

    patch({"enabled": False})
    test_client.delete(f"{a.base}/{install_id}", headers=a.h)
    assert sent == [a.agent_id] * 7

    _install(test_client, a, skill)
    test_client.delete(skill_url, headers=a.h)
    assert sent == [a.agent_id] * 9


def test_content_routes_are_org_isolated(test_client: TestClient, _test_engine):
    """A reported body must never cross orgs, whichever route asks for it."""
    a = _setup(test_client, "content-iso-a@clawbits.ai")
    _state(test_client, a, [_scan("secret-notes")])
    with Session(_test_engine) as db:
        install_id = db.exec(
            select(AgentSkillInstall.install_id).where(AgentSkillInstall.agent_id == a.agent_id)
        ).one()
    b = _setup(test_client, "content-iso-b@clawbits.ai")
    skill_b = _create_skill(test_client, b, "secret-notes")

    # Not a member of the agent's org; the agent is not in the caller's org;
    # the caller's own agent does not own this install.
    probes = ((a.org_id, a.agent_id, 403), (b.org_id, a.agent_id, 404), (b.org_id, b.agent_id, 404))
    for suffix in ("content", "draft"):
        for org, agent, status in probes:
            url = f"/api/human/orgs/{org}/agents/{agent}/skills/{install_id}/{suffix}"
            assert test_client.get(url, headers=b.h).status_code == status, (suffix, org, agent)
    url = f"/api/human/orgs/{b.org_id}/agents/{a.agent_id}/skills"
    assert test_client.get(url, headers=b.h).status_code == 404
    r = test_client.post(
        f"{b.base}/{install_id}/adopt", json={"skill_id": skill_b["skill_id"]}, headers=b.h
    )
    assert r.status_code == 404
