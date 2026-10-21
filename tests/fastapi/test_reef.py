"""Reef v2: git is the bus.

Every test runs against a fake repository standing in for GitHub's Contents
API, so the invariants under test are clawbits' own: who may connect a
repository, which roles are offered, what exactly lands in a fleet file, and
that the one-time token the file carries is the agent's identity all the way
through signup-commit.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import tomllib
from collections import OrderedDict
from datetime import UTC, datetime, timedelta
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from sqlmodel import Session

import clawbits.fastapi.human_endpoints as he
from clawbits import reef_repo
from clawbits.datastructures.known_answers import get_answer_for_question
from clawbits.db.models import Agent, Organization
from clawbits.db.table_write import TableWrite
from clawbits.reef_repo import (
    NAME_RE,
    ReefApp,
    ReefRepo,
    ReefRepoError,
    fleet_name,
    parse_role,
    purge_toml,
)
from tests.fastapi._auth_helpers import auth_headers as _auth
from tests.fastapi._auth_helpers import register_human as _register

ROLE = b"""
version = 1
name  = "clawbits-openclaw"
image = "ghcr.io/skalenetwork/clawbits-openclaw@sha256:abc"

[resources]
vcpus = 4
memory-mib = 6144

[env]
CLAWBITS_ENDPOINT = "http://localhost:8000"

[network]
egress = ["*"]

[secrets]
OPENROUTER_API_KEY = { ref = "reef://clawbits-openclaw/openrouter", host = "openrouter.ai" }
"""

ELSEWHERE = b"""
version = 1
name  = "somebody-elses"
image = "ghcr.io/acme/agent@sha256:def"

[env]
CLAWBITS_ENDPOINT = "https://app.clawbits.ai"

[network]
egress = []
"""

AGENT = {
    "name": "ana-bot",
    "role": "clawbits-openclaw",
    "role_digest": "0" * 64,
    "role_current": True,
    "image": "ghcr.io/skalenetwork/clawbits-openclaw@sha256:abc",
    "owner": "ana",
    "desired": "running",
    "state": "running",
    "vm": "running",
    "synced": True,
    "ports": {},
}

EVENTS = [
    {"id": 1, "agent": "ana-bot", "at": 1757000000, "kind": "create", "detail": "sandbox"},
    {"id": 2, "agent": "ana-bot", "at": 1757000000, "kind": "start", "detail": "running"},
]

FLEET_FILE = ("fleet", "fleet/prod-eu/ana-bot.toml")


def _status(host: str = "prod-eu", minutes_ago: int = 0, **fields) -> bytes:
    """A status file as reconcile.sh writes it, its heartbeat ``minutes_ago``."""
    at = datetime.now(UTC) - timedelta(minutes=minutes_ago)
    return json.dumps(
        {
            "host": host,
            "reef": "0.11.0",
            "at": at.strftime("%Y-%m-%dT%H:%M:00Z"),
            "applied": {"main": "m1", "fleet": "f1"},
            "result": "ok",
            "error": None,
            "roles": [],
            "agents": [AGENT],
            "events": EVENTS,
            **fields,
        }
    ).encode()


class FakeRepo:
    """One in-memory repository shared by every instance in a test: the same
    files whichever token opened it, which is what a real repo behaves like."""

    files: dict[tuple[str, str], bytes] = {}
    commits: list[tuple[str, str, str]] = []
    calls = 0
    unreachable = False
    installations: dict[str, int] = {}
    app_owner = "acme"

    def __init__(self, repo: str, app: ReefApp, installation: int):
        self.repo = repo
        self.app = app
        self.installation = installation

    @classmethod
    def reset(cls) -> None:
        cls.files = {}
        cls.commits = []
        cls.calls = 0
        cls.unreachable = False
        cls.installations = {"acme/agents": 7}
        cls.app_owner = "acme"

    @staticmethod
    async def is_organization(owner: str) -> bool:
        return True

    @staticmethod
    async def create_app(code: str) -> tuple[ReefApp, str]:
        return ReefApp(id=5, slug="clawbits-acme", key="PEM"), FakeRepo.app_owner

    @staticmethod
    async def installation_for(app: ReefApp, repo: str) -> int | None:
        return FakeRepo.installations.get(repo)

    def _check(self) -> None:
        FakeRepo.calls += 1
        if FakeRepo.unreachable:
            raise ReefRepoError("github unreachable: fake")

    async def probe(self) -> None:
        self._check()

    async def read(self, branch: str, path: str):
        self._check()
        found = FakeRepo.files.get((branch, path))
        return ("sha", found) if found is not None else None

    async def write(self, branch, path, content, message, author, sha=None):
        self._check()
        FakeRepo.files[(branch, path)] = content
        FakeRepo.commits.append((message, author.name, author.email))

    async def list(self, branch: str, directory: str) -> list[str]:
        self._check()
        prefix = f"{directory}/"
        return [
            path.removeprefix(prefix)
            for (b, path) in FakeRepo.files
            if b == branch and path.startswith(prefix) and "/" not in path.removeprefix(prefix)
        ]


@pytest.fixture(autouse=True)
def fake_repo(monkeypatch):
    FakeRepo.reset()
    monkeypatch.setattr(he, "ReefRepo", FakeRepo)
    monkeypatch.setattr(he, "is_organization", FakeRepo.is_organization)
    monkeypatch.setattr(he, "create_app", FakeRepo.create_app)
    monkeypatch.setattr(he, "installation_for", FakeRepo.installation_for)
    he._reef_status_cache.clear()
    yield FakeRepo
    he._reef_status_cache.clear()


def _bare_org(test_client, slug: str, owner_email: str) -> tuple[str, dict]:
    owner = _register(test_client, owner_email)
    org_id = test_client.post(
        "/api/human/orgs", json={"name": slug}, headers=_auth(owner["access_token"])
    ).json()["org_id"]
    return org_id, owner


def _start(test_client, org_id: str, user: dict, repo: str = "acme/agents"):
    return test_client.post(
        f"/api/human/orgs/{org_id}/reef/connect",
        json={"repo": repo},
        headers=_auth(user["access_token"]),
    )


def _return(test_client, user: dict, step: str, **params: str):
    """GitHub sending the browser back to ``created`` or ``installed``."""
    return test_client.get(
        f"/api/auth/reef/github/{step}",
        params=params,
        headers=_auth(user["access_token"]),
        follow_redirects=False,
    )


def _state(r) -> str:
    return parse_qs(urlsplit(r.json()["url"]).query)["state"][0]


def _connect(test_client, org_id: str, user: dict, repo: str = "acme/agents"):
    """Connect through every GitHub round trip: the last redirect, or the
    start's error when it never got that far."""
    r = _start(test_client, org_id, user, repo)
    if r.status_code != 200:
        return r
    state = _state(r)
    if r.json()["manifest"]:
        created = _return(test_client, user, "created", code="made", state=state)
        if urlsplit(created.headers["location"]).netloc != "github.com":
            return created
    return _return(test_client, user, "installed", state=state, installation_id="999")


def _landed(r) -> dict[str, list[str]]:
    """Where the callback sent the browser: the setup page, and its query."""
    target = urlsplit(r.headers["location"])
    assert r.status_code == 302 and target.path == "/setup/reef", r.headers
    return parse_qs(target.query)


def _org(test_client, slug: str, owner_email: str, member_email: str | None = None):
    """``(org_id, owner, member)`` with the repository connected, one role in
    the catalog and one host reporting: what every test below starts from. The
    role's file is not named after the role, as nothing requires it to be."""
    org_id, owner = _bare_org(test_client, slug, owner_email)
    member = None
    if member_email:
        member = _register(test_client, member_email)
        test_client.post(
            f"/api/human/orgs/{org_id}/members",
            json={"email": member_email, "role": "member"},
            headers=_auth(owner["access_token"]),
        )
    assert _landed(_connect(test_client, org_id, owner)) == {}
    FakeRepo.files[("main", "roles/openclaw.toml")] = ROLE
    FakeRepo.files[("status", "status/prod-eu.json")] = _status()
    return org_id, owner, member


def _reef(test_client, org_id: str, user: dict):
    return test_client.get(f"/api/human/orgs/{org_id}/reef", headers=_auth(user["access_token"]))


def _create(test_client, org_id: str, user: dict, **fields):
    return test_client.post(
        f"/api/human/orgs/{org_id}/reef/agents",
        json={"host": "prod-eu", "role": "clawbits-openclaw", **fields},
        headers=_auth(user["access_token"]),
    )


def _declare(test_client, org_id: str, user: dict, name: str = "ana-bot") -> str:
    """Declare ``name`` on prod-eu: the signup token its fleet file carries."""
    r = _create(test_client, org_id, user, name=name)
    assert r.status_code == 200, r.text
    raw = FakeRepo.files[("fleet", f"fleet/prod-eu/{name}.toml")]
    return tomllib.loads(raw.decode())["agents"][name]["env"]["CLAWBITS_SIGNUP_TOKEN"]


def _commit(test_client, token: str):
    return test_client.post(
        "/api/agentic/signup-commit", json={"session_token": token, "challenge_response": ""}
    )


def _enrol(test_client, org_id: str, user: dict, name: str = "ana-bot") -> str:
    """Declare ``name`` and spend its token: the agent id it enrolled under."""
    r = _commit(test_client, _declare(test_client, org_id, user, name))
    assert r.status_code == 200, r.text
    return r.json()["agent_id"]


def _purge(test_client, org_id: str, user: dict, host: str = "prod-eu", name: str = "ana-bot"):
    return test_client.delete(
        f"/api/human/orgs/{org_id}/reef/agents/{host}/{name}", headers=_auth(user["access_token"])
    )


def _purged(name: str = "ana-bot") -> bool:
    return FakeRepo.files.get(("fleet", f"fleet/prod-eu/{name}.toml")) == purge_toml(name)


def _delete_agent(test_client, org_id: str, user: dict, agent_id: str):
    return test_client.delete(
        f"/api/human/orgs/{org_id}/agents/{agent_id}", headers=_auth(user["access_token"])
    )


def test_connect_lifecycle(test_client, _test_engine):
    """Owner connects, everyone reads, owner disconnects. The org keeps the
    repository and the App installation covering it, never a token."""
    org_id, owner, member = _org(test_client, "reef-life", "rl-o@test.com", "rl-m@test.com")
    outsider = _register(test_client, "rl-x@test.com")

    r = _reef(test_client, org_id, member)
    assert r.status_code == 200, r.text
    at = json.loads(FakeRepo.files[("status", "status/prod-eu.json")])["at"]
    assert r.json() == {
        "repo": "acme/agents",
        "connected": True,
        "hosts": [
            {
                "host": "prod-eu",
                "reef": "0.11.0",
                "last_seen": at,
                "health": "live",
                "applied": {"main": "m1", "fleet": "f1"},
                "error": None,
                "agents": [
                    {
                        "name": "ana-bot",
                        "role": "clawbits-openclaw",
                        "image": "ghcr.io/skalenetwork/clawbits-openclaw@sha256:abc",
                        "desired": "running",
                        "state": "running",
                        "vm": "running",
                        "synced": True,
                        "role_current": True,
                    }
                ],
                "events": [
                    {"agent": "ana-bot", "at": "2025-09-04T15:33:20Z", "kind": "start", "detail": "running"},
                    {"agent": "ana-bot", "at": "2025-09-04T15:33:20Z", "kind": "create", "detail": "sandbox"},
                ],
            }
        ],
        "declared": [],
    }

    with Session(_test_engine) as db:
        stored = db.get(Organization, org_id)
        placed = (stored.reef_repo, stored.reef_app_id, stored.reef_installation_id)
        assert placed == ("acme/agents", 5, 7)

    assert _reef(test_client, org_id, outsider).status_code == 403

    r = test_client.delete(f"/api/human/orgs/{org_id}/reef", headers=_auth(owner["access_token"]))
    assert r.status_code == 204
    assert _reef(test_client, org_id, owner).json() == {
        "repo": None,
        "connected": False,
        "hosts": [],
        "declared": [],
    }


def test_org_payload_carries_the_connected_bit(test_client):
    """The home tile gates on this, so it must ride the org payload and never
    carry the repository."""
    org_id, owner, _ = _org(test_client, "reef-bit", "rbit-o@test.com")
    headers = _auth(owner["access_token"])

    def org_row():
        r = test_client.get("/api/human/orgs", headers=headers)
        assert r.status_code == 200, r.text
        return next(o for o in r.json()["organizations"] if o["org_id"] == org_id)

    row = org_row()
    assert row["reef_connected"] is True
    assert "reef_repo" not in row and "reef_installation_id" not in row

    assert test_client.delete(f"/api/human/orgs/{org_id}/reef", headers=headers).status_code == 204
    assert org_row()["reef_connected"] is False


def test_connect_is_owner_only(test_client):
    org_id, _, member = _org(test_client, "reef-own", "ro-o@test.com", "ro-m@test.com")
    assert _connect(test_client, org_id, member, repo="acme/other").status_code == 403
    r = test_client.delete(f"/api/human/orgs/{org_id}/reef", headers=_auth(member["access_token"]))
    assert r.status_code == 403


def test_connect_creates_the_orgs_own_app_then_installs_it(test_client, _test_engine):
    """The org's App is private to the repository's account, reads and writes
    contents and nothing else, has no webhook, and its key is kept sealed."""
    org_id, owner = _bare_org(test_client, "reef-app", "rap-o@test.com")
    start = _start(test_client, org_id, owner)
    url = urlsplit(start.json()["url"])
    assert (url.netloc, url.path) == ("github.com", "/organizations/acme/settings/apps/new")
    form = json.loads(start.json()["manifest"])
    assert form["public"] is False and form["hook_attributes"]["active"] is False
    assert form["default_permissions"] == {"contents": "write", "metadata": "read"}
    assert form["redirect_url"].endswith("/api/auth/reef/github/created")
    assert form["setup_url"].endswith("/api/auth/reef/github/installed")

    created = _return(test_client, owner, "created", code="made", state=_state(start))
    install = urlsplit(created.headers["location"])
    assert (install.netloc, install.path) == ("github.com", "/apps/clawbits-acme/installations/new")
    assert _landed(_return(test_client, owner, "installed", state=_state(start))) == {}
    with Session(_test_engine) as db:
        row = db.get(Organization, org_id)
        assert (row.reef_app_slug, row.reef_installation_id) == ("clawbits-acme", 7)
        assert "PEM" not in row.reef_app_key
    assert _start(test_client, org_id, owner, repo="not-a-repo").status_code == 422


def test_reconnecting_reinstalls_the_app_the_org_already_has(test_client):
    org_id, owner, _ = _org(test_client, "reef-again", "rag-o@test.com")
    again = _start(test_client, org_id, owner).json()
    assert again["manifest"] is None
    assert urlsplit(again["url"]).path == "/apps/clawbits-acme/installations/new"
    assert _start(test_client, org_id, owner, repo="other/agents").json()["manifest"] is not None


def test_an_app_owned_by_another_account_is_refused(test_client):
    """A private App installs only on its own account, so one created anywhere
    but the repository's account could never reach it."""
    org_id, owner = _bare_org(test_client, "reef-mal", "rml-o@test.com")
    FakeRepo.app_owner = "mallory"
    assert _landed(_connect(test_client, org_id, owner))["error"] == [
        "That app belongs to mallory, not acme. Delete it on GitHub and start again."
    ]
    assert _reef(test_client, org_id, owner).json()["connected"] is False


def test_installing_needs_the_app_on_the_repository(test_client):
    org_id, owner = _bare_org(test_client, "reef-inst", "ri-o@test.com")
    FakeRepo.installations = {}
    assert _landed(_connect(test_client, org_id, owner))["error"] == [
        "The app is not installed on acme/agents."
    ]


def test_the_returns_trust_only_the_connect_this_browser_started(test_client):
    """GitHub's redirects are forgeable, so the org, the repository and the
    person come from the cookie connect set, and a mismatched state ends it."""
    org_id, owner = _bare_org(test_client, "reef-csrf", "rc-o@test.com")
    other = _register(test_client, "rc-x@test.com")

    assert "error" in _landed(_return(test_client, owner, "created", code="made"))
    _start(test_client, org_id, owner)
    assert "error" in _landed(_return(test_client, owner, "created", code="made", state="forged"))
    state = _state(_start(test_client, org_id, owner))
    assert "error" in _landed(_return(test_client, other, "created", code="made", state=state))
    assert "error" in _landed(_return(test_client, owner, "installed"))
    assert _reef(test_client, org_id, owner).json()["connected"] is False


def test_endpoints_409_without_a_repository(test_client):
    org_id, owner = _bare_org(test_client, "reef-none", "rn-o@test.com")
    r = test_client.get(f"/api/human/orgs/{org_id}/reef/roles", headers=_auth(owner["access_token"]))
    assert r.status_code == 409


def test_roles_only_lists_roles_pointing_here(test_client):
    """A role whose CLAWBITS_ENDPOINT names another server is left out: an
    agent created from it would enrol somewhere else."""
    org_id, owner, _ = _org(test_client, "reef-roles", "rr-o@test.com")
    FakeRepo.files[("main", "roles/somebody-elses.toml")] = ELSEWHERE
    FakeRepo.files[("main", "roles/README.md")] = b"not a role"

    r = test_client.get(
        f"/api/human/orgs/{org_id}/reef/roles", headers=_auth(owner["access_token"])
    )
    assert r.status_code == 200, r.text
    assert r.json() == [
        {
            "name": "clawbits-openclaw",
            "image": "ghcr.io/skalenetwork/clawbits-openclaw@sha256:abc",
            "egress": ["*"],
            "secrets": [{"env": "OPENROUTER_API_KEY", "host": "openrouter.ai"}],
            "resources": {"vcpus": 4, "memory-mib": 6144},
        }
    ]


def _set_access(test_client, org_id: str, user: dict, mode: str, *members: int):
    return test_client.put(
        f"/api/human/orgs/{org_id}/reef/roles/clawbits-openclaw/access",
        json={"mode": mode, "members": list(members)},
        headers=_auth(user["access_token"]),
    ).status_code


def _roles(test_client, org_id: str, user: dict, path: str = "") -> list[dict]:
    r = test_client.get(
        f"/api/human/orgs/{org_id}/reef/roles{path}", headers=_auth(user["access_token"])
    )
    assert r.status_code == 200, r.text
    return r.json()


def test_role_access_gates_listing_and_declaring_for_everyone(test_client):
    """Open to everyone until narrowed: selected admits the listed members,
    off admits no one, owners included. Create reads the list's rule."""
    org_id, owner, member = _org(test_client, "reef-access", "ra-o@test.com", "ra-m@test.com")
    owner_id = owner["user"]["id"]
    assert len(_roles(test_client, org_id, member)) == 1

    assert _set_access(test_client, org_id, owner, "selected", owner_id) == 204
    assert _roles(test_client, org_id, member) == []
    assert _create(test_client, org_id, member, name="mia-bot").status_code == 422
    assert _create(test_client, org_id, owner, name="ana-bot").status_code == 200

    assert _set_access(test_client, org_id, owner, "off", owner_id) == 204
    assert _roles(test_client, org_id, owner) == []
    assert _create(test_client, org_id, owner, name="bob-bot").status_code == 422
    [setting] = _roles(test_client, org_id, owner, "/access")
    assert setting["access"] == {"mode": "off", "members": [owner_id]}


def test_role_access_is_owner_only(test_client):
    org_id, _, member = _org(test_client, "reef-acc-own", "rao-o@test.com", "rao-m@test.com")
    r = test_client.get(
        f"/api/human/orgs/{org_id}/reef/roles/access", headers=_auth(member["access_token"])
    )
    assert r.status_code == 403
    assert _set_access(test_client, org_id, member, "off") == 403


def test_role_access_holds_org_members_only(test_client):
    """An outsider cannot be granted a role; a member who leaves takes their grant along."""
    org_id, owner, member = _org(test_client, "reef-acc-mem", "ram-o@test.com", "ram-m@test.com")
    outsider = _register(test_client, "ram-x@test.com")
    member_id = member["user"]["id"]

    assert _set_access(test_client, org_id, owner, "selected", outsider["user"]["id"]) == 422
    assert _set_access(test_client, org_id, owner, "selected", member_id) == 204
    r = test_client.delete(
        f"/api/human/orgs/{org_id}/members/{member_id}", headers=_auth(owner["access_token"])
    )
    assert r.status_code == 200, r.text
    [setting] = _roles(test_client, org_id, owner, "/access")
    assert setting["access"] == {"mode": "selected", "members": []}


def test_health_reads_the_heartbeat_and_the_last_apply(test_client):
    """Hosts come back by name. A heartbeat inside 25 minutes is live and an
    older one stale; a failed apply is failing whatever the heartbeat says; a
    file from a reconciler that predates the heartbeat has no last_seen and
    reads stale; nonsense is left out."""
    org_id, owner, _ = _org(test_client, "reef-health", "rh-o@test.com")
    FakeRepo.files[("status", "status/stale.json")] = _status("stale", minutes_ago=30)
    FakeRepo.files[("status", "status/failing.json")] = _status(
        "failing", result="failed", error="no such role: x"
    )
    FakeRepo.files[("status", "status/old.json")] = (
        b'{"host": "old", "reef": "0.10.0", "roles": [], "agents": [], "events": []}'
    )
    FakeRepo.files[("status", "status/garbage.json")] = b"{not json"

    r = _reef(test_client, org_id, owner)
    assert r.status_code == 200, r.text
    hosts = r.json()["hosts"]
    assert [(h["host"], h["health"]) for h in hosts] == [
        ("failing", "failing"),
        ("old", "stale"),
        ("prod-eu", "live"),
        ("stale", "stale"),
    ]
    assert hosts[0]["error"] == "no such role: x"
    assert (hosts[1]["last_seen"], hosts[1]["applied"]) == (None, None)


def test_a_host_on_an_older_reef_keeps_reporting(test_client):
    """``agent list --json`` grew ``image``; a host whose reef predates it must
    lose that one field, not drop off the page with every agent on it."""
    org_id, owner, _ = _org(test_client, "reef-older", "rol-o@test.com")
    FakeRepo.files[("status", "status/prod-eu.json")] = _status(
        agents=[{k: v for k, v in AGENT.items() if k != "image"}]
    )

    r = _reef(test_client, org_id, owner)
    assert r.status_code == 200, r.text
    hosts = r.json()["hosts"]
    assert [h["host"] for h in hosts] == ["prod-eu"]
    assert hosts[0]["agents"][0]["image"] == ""


def test_a_refresh_is_one_listing_plus_a_read_per_host(test_client):
    """The heartbeat rides in the file, so no commit is looked up. The result
    is cached per org, and declaring or purging an agent drops that cache."""
    org_id, owner, _ = _org(test_client, "reef-calls", "rca-o@test.com")
    FakeRepo.files[("status", "status/prod-us.json")] = _status("prod-us")

    FakeRepo.calls = 0
    assert _reef(test_client, org_id, owner).status_code == 200
    assert FakeRepo.calls == 3
    _reef(test_client, org_id, owner)
    assert FakeRepo.calls == 3

    _declare(test_client, org_id, owner)
    assert org_id not in he._reef_status_cache
    _reef(test_client, org_id, owner)
    r = _purge(test_client, org_id, owner)
    assert r.status_code == 204, r.text
    assert org_id not in he._reef_status_cache


def test_create_writes_the_fleet_file(test_client):
    """The file is the whole handoff: role, owner, org and a live one-time
    token, authored by the person who clicked."""
    org_id, owner, _ = _org(test_client, "reef-create", "rc-o@test.com")

    r = _create(test_client, org_id, owner, name="ana-bot", public_host="ana-bot.example.com")
    assert r.status_code == 200, r.text
    body = r.json()
    assert (body["host"], body["name"]) == ("prod-eu", "ana-bot")
    assert body["nickname"] and body["agent_id"].startswith(body["nickname"])
    expires_in = datetime.fromisoformat(body["expires_at"]) - datetime.now(UTC)
    assert timedelta(days=6, hours=23) < expires_in <= timedelta(days=7)

    entry = tomllib.loads(FakeRepo.files[FLEET_FILE].decode())
    assert entry["version"] == 1
    agent = entry["agents"]["ana-bot"]
    assert agent["role"] == "clawbits-openclaw"
    assert agent["owner"] == "rc-o"
    assert agent["env"]["CLAWBITS_ORG_ID"] == org_id
    assert agent["env"]["CLAWBITS_SIGNUP_TOKEN"].startswith("human-")
    assert agent["env"]["OPENCLAW_PUBLIC_HOST"] == "ana-bot.example.com"
    assert FakeRepo.commits == [("declare ana-bot on prod-eu", "rc-o", "rc-o@test.com")]


def test_create_without_a_name_names_the_file_after_the_agent(test_client, _test_engine):
    """The id and nickname are picked with the token, and the agent commits
    under them on the agentic path its fleet file drives."""
    org_id, owner, _ = _org(test_client, "reef-named", "rn-o@test.com")
    r = _create(test_client, org_id, owner)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["name"] == body["agent_id"].lower()
    raw = FakeRepo.files[("fleet", f"fleet/prod-eu/{body['name']}.toml")]
    token = tomllib.loads(raw.decode())["agents"][body["name"]]["env"]["CLAWBITS_SIGNUP_TOKEN"]

    challenge = test_client.post(
        "/api/agentic/agents/signup", json={"org_id": org_id, "signup_token": token}
    ).json()
    r = test_client.post(
        "/api/agentic/signup-commit",
        json={
            "session_token": challenge["session_token"],
            "challenge_response": get_answer_for_question(challenge["challenge"]),
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["agent_id"] == body["agent_id"]
    with Session(_test_engine) as db:
        row = db.get(Agent, body["agent_id"])
        assert (row.nickname, row.reef_name) == (body["nickname"], body["name"])


def test_a_picked_name_clashes_with_nothing_on_the_host(test_client, monkeypatch):
    """With one name in the pool the id is redrawn past an agent the host
    already runs, then past the fleet file the first declare wrote."""
    org_id, owner, _ = _org(test_client, "reef-clash", "rcl-o@test.com")
    monkeypatch.setattr(test_client.app, "_bot_names", {"Ana": "Ana"})
    FakeRepo.files[("status", "status/prod-eu.json")] = _status(agents=[AGENT | {"name": "ana"}])

    def declare() -> str:
        r = _create(test_client, org_id, owner)
        assert r.status_code == 200, r.text
        return r.json()["name"]

    first, second = declare(), declare()
    assert first.startswith("ana") and second.startswith("ana")
    assert len({"ana", first, second}) == 3


@pytest.mark.parametrize(
    ("agent_id", "name"),
    [("SilverPigeon3", "silverpigeon3"), ("ana_bot_", "ana-bot"), ("9lives", "a9lives")],
)
def test_fleet_name_fits_reefs_rule(agent_id, name):
    assert fleet_name(agent_id) == name
    assert NAME_RE.match(name)


def test_create_rejects_bad_input(test_client):
    """reef's own name rule, a host that has never reported, and a role that
    is not in the catalog all fail here rather than on the host. A role is
    known by its own name, never by its file's."""
    org_id, owner, _ = _org(test_client, "reef-bad-in", "rbi-o@test.com")

    for name in ("Ana-Bot", "1bot", "bot-", "", "a" * 41, "an/bot"):
        r = _create(test_client, org_id, owner, name=name)
        assert r.status_code == 422, f"{name!r} was accepted"

    r = _create(test_client, org_id, owner, name="ana-bot", host="prod-us")
    assert r.status_code == 422 and "prod-us" in r.json()["detail"]

    for role in ("nope", "openclaw"):
        r = _create(test_client, org_id, owner, name="ana-bot", role=role)
        assert r.status_code == 422 and role in r.json()["detail"]

    assert not [k for k in FakeRepo.files if k[0] == "fleet"]


def test_create_refuses_a_name_already_declared(test_client):
    org_id, owner, _ = _org(test_client, "reef-dup", "rd-o@test.com")
    assert _create(test_client, org_id, owner, name="ana-bot").status_code == 200
    r = _create(test_client, org_id, owner, name="ana-bot")
    assert r.status_code == 409, r.text


def test_create_takes_the_session_down_with_a_failed_write(test_client):
    """A declared agent always has a file, and a file always has a live token:
    if the write fails the minted session goes with it."""
    org_id, owner, _ = _org(test_client, "reef-roll", "rrb-o@test.com")
    FakeRepo.unreachable = True

    r = _create(test_client, org_id, owner, name="ana-bot")
    assert r.status_code == 502, r.text

    FakeRepo.unreachable = False
    assert _reef(test_client, org_id, owner).json()["declared"] == []


def test_commit_copies_host_and_name_onto_the_agent(test_client, _test_engine):
    org_id, owner, _ = _org(test_client, "reef-commit", "rk-o@test.com")
    headers = _auth(owner["access_token"])
    agent_id = _enrol(test_client, org_id, owner)

    with Session(_test_engine) as db:
        row = db.get(Agent, agent_id)
        assert (row.reef_host, row.reef_name) == ("prod-eu", "ana-bot")

    listed = test_client.get(f"/api/human/orgs/{org_id}/agents", headers=headers).json()
    mine = next(a for a in listed["agents"] if a["agent_id"] == agent_id)
    assert (mine["reef_host"], mine["reef_name"]) == ("prod-eu", "ana-bot")

    profile = test_client.get(f"/api/human/orgs/{org_id}/agents/{agent_id}", headers=headers).json()
    assert (profile["reef_host"], profile["reef_name"]) == ("prod-eu", "ana-bot")


def test_a_spent_token_cannot_mint_a_second_agent(test_client):
    """The token in the fleet file stays there forever; it is dead after the
    first boot spends it."""
    org_id, owner, _ = _org(test_client, "reef-spent", "rp-o@test.com")
    token = _declare(test_client, org_id, owner)

    first = _commit(test_client, token)
    assert first.status_code == 200, first.text
    second = _commit(test_client, token)
    assert second.status_code == 401, second.text


def test_declared_clears_once_the_agent_enrols(test_client):
    org_id, owner, _ = _org(test_client, "reef-enrol", "re-o@test.com")
    token = _declare(test_client, org_id, owner)

    assert len(_reef(test_client, org_id, owner).json()["declared"]) == 1
    _commit(test_client, token)
    assert _reef(test_client, org_id, owner).json()["declared"] == []


def test_purge_replaces_the_fleet_file_with_its_tombstone(test_client):
    org_id, owner, _ = _org(test_client, "reef-rm", "rm-o@test.com")
    _declare(test_client, org_id, owner)

    r = _purge(test_client, org_id, owner)
    assert r.status_code == 204, r.text
    assert tomllib.loads(FakeRepo.files[FLEET_FILE].decode()) == {
        "version": 1,
        "purge": ["ana-bot"],
    }
    assert FakeRepo.commits[-1] == ("purge ana-bot from prod-eu", "rm-o", "rm-o@test.com")


def test_purge_before_enrolment_burns_the_token(test_client):
    """The tombstone replaces the file but its token stays in git history, so
    purging an agent that has not enrolled revokes that token too."""
    org_id, owner, _ = _org(test_client, "reef-burn", "rbu-o@test.com")
    token = _declare(test_client, org_id, owner)

    r = _purge(test_client, org_id, owner)
    assert r.status_code == 204, r.text
    assert _reef(test_client, org_id, owner).json()["declared"] == []
    r = _commit(test_client, token)
    assert r.status_code == 401, r.text


def test_purge_is_open_to_whoever_declared_it(test_client):
    """Before it enrols an agent has no operator; the member who declared it is
    the one it will get, so they may take it back."""
    org_id, _, member = _org(test_client, "reef-rmd", "rmd-o@test.com", "rmd-m@test.com")
    _declare(test_client, org_id, member)

    r = _purge(test_client, org_id, member)
    assert r.status_code == 204, r.text
    assert _purged()


def test_purge_is_operator_declarer_or_owner_only(test_client):
    """A member who neither owns the org nor declared or operates the agent
    cannot pull it out from under its operator."""
    org_id, owner, member = _org(test_client, "reef-rmx", "rx-o@test.com", "rx-m@test.com")
    _declare(test_client, org_id, owner)

    r = _purge(test_client, org_id, member)
    assert r.status_code == 403, r.text
    assert not _purged()


def test_a_purged_name_stays_taken(test_client, monkeypatch):
    """A new agent under a purged name could mount volumes the host has not
    deleted yet, so the tombstone keeps the name for good."""
    org_id, owner, _ = _org(test_client, "reef-taken", "rtk-o@test.com")
    _enrol(test_client, org_id, owner, "quill")
    assert _purge(test_client, org_id, owner, name="quill").status_code == 204

    monkeypatch.setattr(test_client.app, "_bot_names", {"Quill": "Quill"})
    assert _create(test_client, org_id, owner).json()["name"] != "quill"
    assert _create(test_client, org_id, owner, name="quill").status_code == 409


def test_purge_rejects_names_reef_would(test_client):
    org_id, owner, _ = _org(test_client, "reef-rmn", "rmn-o@test.com")
    for host, name in (("Prod-EU", "ana-bot"), ("prod-eu", "ana_bot"), ("prod-eu", "bot-")):
        r = _purge(test_client, org_id, owner, host, name)
        assert r.status_code == 422, f"{host}/{name} was accepted"


def test_deleting_the_agent_purges_it(test_client):
    """The agent row, the VM and its volumes go together: nothing of a deleted
    agent stays on its host."""
    org_id, owner, _ = _org(test_client, "reef-del", "rdl-o@test.com")
    agent_id = _enrol(test_client, org_id, owner)

    r = _delete_agent(test_client, org_id, owner, agent_id)
    assert r.status_code == 200, r.text
    assert _purged()
    assert FakeRepo.commits[-1] == ("purge ana-bot from prod-eu", "rdl-o", "rdl-o@test.com")


def test_deleting_the_agent_fails_closed_on_an_unreachable_repo(test_client):
    """A delete that cannot purge changes nothing, so the agent is never gone
    from clawbits while its VM and data live on."""
    org_id, owner, _ = _org(test_client, "reef-del-down", "rdd-o@test.com")
    agent_id = _enrol(test_client, org_id, owner)
    FakeRepo.unreachable = True

    r = _delete_agent(test_client, org_id, owner, agent_id)
    assert r.status_code == 502, r.text

    FakeRepo.unreachable = False
    assert not _purged()
    listed = test_client.get(
        f"/api/human/orgs/{org_id}/agents", headers=_auth(owner["access_token"])
    ).json()
    assert [a["agent_id"] for a in listed["agents"]] == [agent_id]


@pytest.mark.parametrize(("deleted", "purged"), [("older", False), ("newest", True)])
def test_only_the_newest_placement_purges(test_client, _test_engine, deleted, purged):
    """Agents enrolled before purging existed can share a placement: deleting
    the superseded one must leave the live agent's VM and volumes alone."""
    org_id, owner, _ = _org(test_client, f"reef-del-{deleted}", f"rd-{deleted}@test.com")
    older = _enrol(test_client, org_id, owner, "old-bot")
    newest = _enrol(test_client, org_id, owner)
    with Session(_test_engine) as db:
        TableWrite.set_agent_reef(db, older, "prod-eu", "ana-bot")
        db.commit()

    r = _delete_agent(test_client, org_id, owner, {"older": older, "newest": newest}[deleted])
    assert r.status_code == 200, r.text
    assert _purged() is purged

def _move(test_client, org_id: str, user: dict, to: str, host: str = "prod-eu"):
    return test_client.post(
        f"/api/human/orgs/{org_id}/reef/agents/{host}/ana-bot/move",
        json={"host": to},
        headers=_auth(user["access_token"]),
    )


def _declared_env(host: str) -> dict[str, str]:
    raw = FakeRepo.files[("fleet", f"fleet/{host}/ana-bot.toml")]
    return tomllib.loads(raw.decode())["agents"]["ana-bot"]["env"]


def test_move_brings_the_same_agent_back_on_another_host(test_client, _test_engine):
    """The new host's file carries a token that hands the enrolled agent a new
    key: same id, same channel, and only the new key is valid."""
    org_id, owner, _ = _org(test_client, "reef-move", "rmv-o@test.com")
    FakeRepo.files[("status", "status/prod-us.json")] = _status("prod-us", agents=[])
    first = _commit(test_client, _declare(test_client, org_id, owner)).json()

    r = _move(test_client, org_id, owner, "prod-us")
    assert r.status_code == 200, r.text
    assert _purged()
    assert _reef(test_client, org_id, owner).json()["declared"] == []

    again = _commit(test_client, _declared_env("prod-us")["CLAWBITS_SIGNUP_TOKEN"]).json()
    assert (again["agent_id"], again["channel_id"]) == (first["agent_id"], first["channel_id"])
    with Session(_test_engine) as db:
        row = db.get(Agent, first["agent_id"])
        assert (row.reef_host, row.reef_name) == ("prod-us", "ana-bot")
        assert row.api_key_hash == hashlib.sha256(again["api_key"].encode()).hexdigest()


def test_move_to_its_own_host_redeclares_in_place(test_client):
    org_id, owner, _ = _org(test_client, "reef-redo", "rdo-o@test.com")
    spent = _declare(test_client, org_id, owner)
    _commit(test_client, spent)

    assert _move(test_client, org_id, owner, "prod-eu").status_code == 200
    assert _declared_env("prod-eu")["CLAWBITS_SIGNUP_TOKEN"] != spent
    assert FakeRepo.commits[-1][0] == "redeclare ana-bot on prod-eu"


def test_move_is_operator_or_owner_only(test_client):
    org_id, owner, member = _org(test_client, "reef-mvo", "mvo-o@test.com", "mvo-m@test.com")
    _enrol(test_client, org_id, owner)
    assert _move(test_client, org_id, member, "prod-eu").status_code == 403


def test_move_needs_an_enrolled_agent_a_known_host_and_a_free_name(test_client):
    org_id, owner, _ = _org(test_client, "reef-mvx", "mvx-o@test.com")
    token = _declare(test_client, org_id, owner)
    assert _move(test_client, org_id, owner, "prod-eu").status_code == 404
    _commit(test_client, token)
    assert _move(test_client, org_id, owner, "nowhere").status_code == 422

    FakeRepo.files[("status", "status/prod-us.json")] = _status("prod-us", agents=[])
    FakeRepo.files[("fleet", "fleet/prod-us/ana-bot.toml")] = purge_toml("ana-bot")
    he._reef_status_cache.clear()
    assert _move(test_client, org_id, owner, "prod-us").status_code == 409


def test_a_moved_agents_token_dies_with_the_agent(test_client):
    org_id, owner, _ = _org(test_client, "reef-mvd", "mvd-o@test.com")
    FakeRepo.files[("status", "status/prod-us.json")] = _status("prod-us", agents=[])
    agent_id = _enrol(test_client, org_id, owner)
    _move(test_client, org_id, owner, "prod-us")
    token = _declared_env("prod-us")["CLAWBITS_SIGNUP_TOKEN"]

    assert _delete_agent(test_client, org_id, owner, agent_id).status_code == 200
    assert _commit(test_client, token).status_code == 401


def test_tokens_reach_the_one_repository_or_none_is_handed_out(monkeypatch):
    """Reads get a read-only token and writes a write one, each reused until
    shortly before it expires, and none at all while the installation reaches
    more than the one repository: an org admin can widen it at any time."""
    minted: list[dict] = []
    reach = ["acme/store"]

    def respond(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/access_tokens"):
            minted.append(json.loads(request.content))
            expires = (datetime.now(UTC) + timedelta(hours=1)).isoformat()
            return httpx.Response(201, json={"token": f"t{len(minted)}", "expires_at": expires})
        return httpx.Response(200, json={"repositories": [{"full_name": n} for n in reach]})

    transport = httpx.MockTransport(respond)
    monkeypatch.setattr(reef_repo, "_client", httpx.AsyncClient(transport=transport))
    monkeypatch.setattr(reef_repo, "_tokens", {})
    monkeypatch.setattr(reef_repo, "_app_jwt", lambda app: "jwt")
    app = ReefApp(id=1, slug="s", key="k")

    async def mint(*writes: bool) -> list[str]:
        return [await reef_repo._installation_token(app, 7, "acme/store", w) for w in writes]

    assert asyncio.run(mint(False, False, True)) == ["t1", "t1", "t2"]
    assert [m["permissions"]["contents"] for m in minted] == ["read", "write"]

    reef_repo._tokens.clear()
    reach.append("acme/other")
    with pytest.raises(ReefRepoError, match="acme/store alone"):
        asyncio.run(mint(False))


@pytest.fixture
def github(monkeypatch) -> list[str | None]:
    """GitHub answering every GET with one ETagged file, and 304 to any
    conditional one; returns the ``If-None-Match`` each request sent."""
    sent: list[str | None] = []

    def respond(request: httpx.Request) -> httpx.Response:
        sent.append(request.headers.get("If-None-Match"))
        if sent[-1]:
            return httpx.Response(304)
        body = {"sha": "s1", "content": base64.b64encode(b"{}").decode()}
        return httpx.Response(200, json=body, headers={"ETag": '"v1"'})

    async def token(app: ReefApp, installation: int, repo: str, write: bool) -> str:
        return "t"

    transport = httpx.MockTransport(respond)
    monkeypatch.setattr(reef_repo, "_client", httpx.AsyncClient(transport=transport))
    monkeypatch.setattr(reef_repo, "_etags", OrderedDict())
    monkeypatch.setattr(reef_repo, "_installation_token", token)
    return sent


async def _read_all(*paths: str) -> list[tuple[str, bytes] | None]:
    repo = ReefRepo(repo="acme/store", app=ReefApp(id=1, slug="s", key="k"), installation=1)
    return [await repo.read("main", path) for path in paths]


def test_reads_are_conditional(github):
    """A GET sends the ETag its URL last answered with, and a 304, which
    GitHub does not count against the rate limit, reuses the cached body."""
    read = asyncio.run(_read_all("status/prod-eu.json", "status/prod-eu.json"))
    assert read == [("s1", b"{}")] * 2
    assert github == [None, '"v1"']


def test_the_etag_cache_skips_fleet_files_and_evicts_least_recent(github, monkeypatch):
    """Fleet files carry live signup tokens, so only status and role reads are
    cached, and the cache drops its least recently used entry past its bound."""
    monkeypatch.setattr(reef_repo, "ETAG_CACHE_SIZE", 2)
    fleet = "fleet/prod-eu/ana-bot.toml"
    asyncio.run(_read_all(fleet, "status/a.json", "roles/r.toml", "status/a.json", "status/b.json"))
    cached = [httpx.URL(k).path.removeprefix("/repos/acme/store/contents/") for k in reef_repo._etags]
    assert cached == ["status/a.json", "status/b.json"]


@pytest.mark.parametrize(
    ("private", "branches", "expected"),
    [
        (True, {"main", "fleet", "status"}, None),
        (False, {"main", "fleet", "status"}, "is public"),
        (True, {"main", "status"}, "missing the fleet branch"),
        (True, {"main"}, "missing the fleet, status branches"),
    ],
)
def test_probe_refuses_a_repo_the_bus_cannot_run_on(monkeypatch, private, branches, expected):
    """Connecting makes exactly one call, so probe carries every check that has
    to happen before the repository is stored: it is visible, it is private,
    and all three branches exist. A missing branch answers 404 on the
    Contents API just as a missing file does, so a write would otherwise fail
    much later with nothing useful to say."""

    async def _send(self, method, url, **kw):
        if url.endswith(f"/repos/{self.repo}"):
            return {"private": private}
        tail = url.rsplit("/", 1)[-1]
        return {"name": tail} if tail in branches else None

    monkeypatch.setattr(ReefRepo, "_send", _send)
    repo = ReefRepo(repo="acme/store", app=ReefApp(id=1, slug="s", key="k"), installation=1)

    if expected is None:
        asyncio.run(repo.probe())
        return
    with pytest.raises(ReefRepoError, match=expected):
        asyncio.run(repo.probe())


DEV_ROLE = (
    Path(__file__).resolve().parents[2] / "reef" / "roles" / "clawbits-openclaw-dev.toml"
)


def test_dev_openclaw_role_targets_the_host():
    raw = DEV_ROLE.read_bytes()
    data = tomllib.loads(raw.decode())
    assert data["name"] == "clawbits-openclaw-dev"
    assert data["env"]["CLAWBITS_ENDPOINT"] == "http://host.microsandbox.internal:8000"
    assert data["network"]["host"] == [8000]
    assert parse_role("clawbits-openclaw-dev", raw, "https://app.clawbits.ai") is None
    role = parse_role(
        "clawbits-openclaw-dev", raw, "http://host.microsandbox.internal:8000"
    )
    assert role is not None
    assert role.name == "clawbits-openclaw-dev"
