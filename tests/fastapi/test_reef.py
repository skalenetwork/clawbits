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
import json
import tomllib
from collections import OrderedDict
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from sqlmodel import Session

import clawbits.fastapi.human_endpoints as he
from clawbits import reef_repo
from clawbits.datastructures.known_answers import get_answer_for_question
from clawbits.db.models import Agent, Organization
from clawbits.reef_repo import NAME_RE, ReefRepo, ReefRepoError, fleet_name
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

    def __init__(self, repo: str, token: str):
        self.repo = repo
        self.token = token

    @classmethod
    def reset(cls) -> None:
        cls.files = {}
        cls.commits = []
        cls.calls = 0
        cls.unreachable = False

    def _check(self) -> None:
        FakeRepo.calls += 1
        if FakeRepo.unreachable:
            raise ReefRepoError("github unreachable: fake")

    async def probe(self) -> None:
        self._check()
        if self.token != "ghp-good":
            raise ReefRepoError(f"{self.repo} not found, or the token cannot see it")

    async def read(self, branch: str, path: str):
        self._check()
        found = FakeRepo.files.get((branch, path))
        return ("sha", found) if found is not None else None

    async def write(self, branch, path, content, message, author):
        self._check()
        FakeRepo.files[(branch, path)] = content
        FakeRepo.commits.append((message, author.name, author.email))

    async def delete(self, branch, path, message, author):
        self._check()
        if FakeRepo.files.pop((branch, path), None) is not None:
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
    he._reef_status_cache.clear()
    yield FakeRepo
    he._reef_status_cache.clear()


def _bare_org(test_client, slug: str, owner_email: str) -> tuple[str, dict]:
    owner = _register(test_client, owner_email)
    org_id = test_client.post(
        "/api/human/orgs", json={"name": slug}, headers=_auth(owner["access_token"])
    ).json()["org_id"]
    return org_id, owner


def _connect(test_client, org_id: str, user: dict, repo: str = "acme/agents", token: str = "ghp-good"):
    return test_client.put(
        f"/api/human/orgs/{org_id}/reef",
        json={"repo": repo, "token": token},
        headers=_auth(user["access_token"]),
    )


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
    r = _connect(test_client, org_id, owner)
    assert r.status_code == 200, r.text
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


def _undeclare(test_client, org_id: str, user: dict, host: str = "prod-eu", name: str = "ana-bot"):
    return test_client.delete(
        f"/api/human/orgs/{org_id}/reef/agents/{host}/{name}", headers=_auth(user["access_token"])
    )


def _delete_agent(test_client, org_id: str, user: dict, agent_id: str):
    return test_client.delete(
        f"/api/human/orgs/{org_id}/agents/{agent_id}", headers=_auth(user["access_token"])
    )


def test_connect_lifecycle(test_client, _test_engine):
    """Owner connects, everyone reads, owner disconnects. The token is sealed
    at rest and never leaves the server."""
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
    assert "ghp-good" not in r.text

    with Session(_test_engine) as db:
        stored = db.get(Organization, org_id)
        assert stored.reef_repo == "acme/agents"
        assert "ghp-good" not in stored.reef_repo_token

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
    carry the repository or its token."""
    org_id, owner, _ = _org(test_client, "reef-bit", "rbit-o@test.com")
    headers = _auth(owner["access_token"])

    def org_row():
        r = test_client.get("/api/human/orgs", headers=headers)
        assert r.status_code == 200, r.text
        return next(o for o in r.json()["organizations"] if o["org_id"] == org_id)

    row = org_row()
    assert row["reef_connected"] is True
    assert "reef_repo" not in row and "ghp-good" not in str(row)

    assert test_client.delete(f"/api/human/orgs/{org_id}/reef", headers=headers).status_code == 204
    assert org_row()["reef_connected"] is False


def test_connect_is_owner_only(test_client):
    org_id, _, member = _org(test_client, "reef-own", "ro-o@test.com", "ro-m@test.com")
    assert _connect(test_client, org_id, member, repo="acme/other").status_code == 403
    r = test_client.delete(f"/api/human/orgs/{org_id}/reef", headers=_auth(member["access_token"]))
    assert r.status_code == 403


def test_connect_rejects_a_repo_the_token_cannot_see(test_client):
    """Nothing is stored unless GitHub confirms the token first."""
    org_id, owner = _bare_org(test_client, "reef-bad", "rb-o@test.com")

    r = _connect(test_client, org_id, owner, token="ghp-wrong")
    assert r.status_code == 502, r.text
    assert _connect(test_client, org_id, owner, repo="not-a-repo").status_code == 422
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
    is cached per org, and declaring or removing an agent drops that cache."""
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
    r = _undeclare(test_client, org_id, owner)
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


def test_remove_deletes_the_fleet_file(test_client):
    org_id, owner, _ = _org(test_client, "reef-rm", "rm-o@test.com")
    _declare(test_client, org_id, owner)

    r = _undeclare(test_client, org_id, owner)
    assert r.status_code == 204, r.text
    assert FLEET_FILE not in FakeRepo.files
    assert FakeRepo.commits[-1] == ("remove ana-bot from prod-eu", "rm-o", "rm-o@test.com")


def test_declared_survives_an_unsealable_token(test_client, monkeypatch):
    """A rotated secrets key disconnects the repository, not the agents already
    declared on it."""
    org_id, owner, _ = _org(test_client, "reef-sealed", "rs-o@test.com")
    _declare(test_client, org_id, owner)
    monkeypatch.setattr(he, "decrypt_secret", lambda _: None)

    r = _reef(test_client, org_id, owner)
    assert r.json()["connected"] is False
    assert [(d["host"], d["name"]) for d in r.json()["declared"]] == [("prod-eu", "ana-bot")]


def test_remove_before_enrolment_burns_the_token(test_client):
    """The file leaves the branch head but its token stays in git history, so
    removing an agent that has not enrolled revokes that token too."""
    org_id, owner, _ = _org(test_client, "reef-burn", "rbu-o@test.com")
    token = _declare(test_client, org_id, owner)

    r = _undeclare(test_client, org_id, owner)
    assert r.status_code == 204, r.text
    assert _reef(test_client, org_id, owner).json()["declared"] == []
    r = _commit(test_client, token)
    assert r.status_code == 401, r.text


def test_remove_is_open_to_whoever_declared_it(test_client):
    """Before it enrols an agent has no operator; the member who declared it is
    the one it will get, so they may take it back."""
    org_id, _, member = _org(test_client, "reef-rmd", "rmd-o@test.com", "rmd-m@test.com")
    _declare(test_client, org_id, member)

    r = _undeclare(test_client, org_id, member)
    assert r.status_code == 204, r.text
    assert FLEET_FILE not in FakeRepo.files


def test_remove_is_operator_declarer_or_owner_only(test_client):
    """A member who neither owns the org nor declared or operates the agent
    cannot pull it out from under its operator."""
    org_id, owner, member = _org(test_client, "reef-rmx", "rx-o@test.com", "rx-m@test.com")
    _declare(test_client, org_id, owner)

    r = _undeclare(test_client, org_id, member)
    assert r.status_code == 403, r.text
    assert FLEET_FILE in FakeRepo.files


def test_a_removed_agent_comes_back_under_its_name(test_client, monkeypatch):
    """Its volumes outlive the fleet file, so declaring the name again brings
    back the agent that enrolled under it, and a picked name never lands on it."""
    org_id, owner, _ = _org(test_client, "reef-back", "rbk-o@test.com")
    monkeypatch.setattr(test_client.app, "_bot_names", {"Wren": "Wren"})
    enrolled = _enrol(test_client, org_id, owner, "quill")
    assert _undeclare(test_client, org_id, owner, name="quill").status_code == 204

    monkeypatch.setattr(test_client.app, "_bot_names", {"Quill": "Quill"})
    assert _create(test_client, org_id, owner).json()["name"] != "quill"
    back = _create(test_client, org_id, owner, name="quill").json()
    assert (back["agent_id"], back["nickname"]) == (enrolled, "Wren")


def test_remove_rejects_names_reef_would(test_client):
    org_id, owner, _ = _org(test_client, "reef-rmn", "rmn-o@test.com")
    for host, name in (("Prod-EU", "ana-bot"), ("prod-eu", "ana_bot"), ("prod-eu", "bot-")):
        r = _undeclare(test_client, org_id, owner, host, name)
        assert r.status_code == 422, f"{host}/{name} was accepted"


def test_deleting_the_agent_takes_its_fleet_file(test_client):
    """The agent row and the VM go together: a file left behind keeps the VM
    running under a name nothing owns."""
    org_id, owner, _ = _org(test_client, "reef-del", "rdl-o@test.com")
    agent_id = _enrol(test_client, org_id, owner)

    r = _delete_agent(test_client, org_id, owner, agent_id)
    assert r.status_code == 200, r.text
    assert FLEET_FILE not in FakeRepo.files
    assert FakeRepo.commits[-1] == ("remove ana-bot from prod-eu", "rdl-o", "rdl-o@test.com")


def test_deleting_the_agent_survives_an_unreachable_repo(test_client):
    """Reef cleanup is best-effort and runs after the delete commits, so
    GitHub being down never keeps an agent alive in clawbits."""
    org_id, owner, _ = _org(test_client, "reef-del-down", "rdd-o@test.com")
    agent_id = _enrol(test_client, org_id, owner)
    FakeRepo.unreachable = True

    r = _delete_agent(test_client, org_id, owner, agent_id)
    assert r.status_code == 200, r.text
    assert FLEET_FILE in FakeRepo.files

    FakeRepo.unreachable = False
    listed = test_client.get(
        f"/api/human/orgs/{org_id}/agents", headers=_auth(owner["access_token"])
    ).json()
    assert [a for a in listed["agents"] if a["agent_id"] == agent_id] == []


def test_deleting_the_agent_burns_the_token_its_file_carried(test_client):
    """Re-declaring an enrolled agent's name mints that same agent a fresh
    token, so a live one outlives nothing here: deleting the agent revokes it,
    whether or not the file removal lands."""
    org_id, owner, _ = _org(test_client, "reef-del-token", "rdt-o@test.com")
    agent_id = _enrol(test_client, org_id, owner)
    r = _undeclare(test_client, org_id, owner)
    assert r.status_code == 204, r.text
    token = _declare(test_client, org_id, owner)
    FakeRepo.unreachable = True

    r = _delete_agent(test_client, org_id, owner, agent_id)
    assert r.status_code == 200, r.text
    r = _commit(test_client, token)
    assert r.status_code == 401, r.text


@pytest.mark.parametrize(("deleted", "survives"), [("older", True), ("newest", False)])
def test_only_the_newest_placement_takes_the_fleet_file(test_client, deleted, survives):
    """``(reef_host, reef_name)`` is not unique: undeclaring keeps the VM's
    volumes, so declaring the name again enrols a second agent against the same
    file. Deleting the superseded row must leave the live agent's VM alone, and
    the superseded row must not keep that file alive once the live agent goes."""
    org_id, owner, _ = _org(test_client, f"reef-del-{deleted}", f"rd-{deleted}@test.com")
    older = _enrol(test_client, org_id, owner)
    r = _undeclare(test_client, org_id, owner)
    assert r.status_code == 204, r.text
    newest = _enrol(test_client, org_id, owner)
    assert newest != older

    r = _delete_agent(test_client, org_id, owner, {"older": older, "newest": newest}[deleted])
    assert r.status_code == 200, r.text
    assert (FLEET_FILE in FakeRepo.files) is survives


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

    transport = httpx.MockTransport(respond)
    monkeypatch.setattr(reef_repo, "_client", httpx.AsyncClient(transport=transport))
    monkeypatch.setattr(reef_repo, "_etags", OrderedDict())
    return sent


async def _read_all(*paths: str) -> list[tuple[str, bytes] | None]:
    repo = ReefRepo(repo="acme/store", token="ghp-good")
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
    """The connect form makes exactly one call, so probe carries every check
    that has to happen before a token is stored: the repo is visible, it is
    private, and all three branches exist. A missing branch answers 404 on the
    Contents API just as a missing file does, so a write would otherwise fail
    much later with nothing useful to say."""

    async def _send(self, method, url, **kw):
        if url.endswith(f"/repos/{self.repo}"):
            return {"private": private}
        tail = url.rsplit("/", 1)[-1]
        return {"name": tail} if tail in branches else None

    monkeypatch.setattr(ReefRepo, "_send", _send)
    repo = ReefRepo(repo="acme/store", token="ghp-good")

    if expected is None:
        asyncio.run(repo.probe())
        return
    with pytest.raises(ReefRepoError, match=expected):
        asyncio.run(repo.probe())
