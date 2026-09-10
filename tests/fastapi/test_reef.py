"""Reef v2: git is the bus.

Every test runs against a fake repository standing in for GitHub's Contents
API, so the invariants under test are clawbits' own: who may connect a
repository, which roles are offered, what exactly lands in a fleet file, and
that the one-time token the file carries is the agent's identity all the way
through signup-commit.
"""
from __future__ import annotations

import asyncio
import tomllib
from datetime import UTC, datetime, timedelta

import pytest
from sqlmodel import Session

import clawbits.fastapi.human_endpoints as he
from clawbits.db.models import Agent
from clawbits.reef_repo import ReefRepo, ReefRepoError
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

STATUS = b'{"host": "prod-eu", "reef": "0.11.0", "roles": [], "agents": [{"name": "ana-bot"}], "events": []}'


class FakeRepo:
    """One in-memory repository shared by every instance in a test: the same
    files whichever token opened it, which is what a real repo behaves like."""

    files: dict[tuple[str, str], bytes] = {}
    commits: list[tuple[str, str, str]] = []
    unreachable = False
    committed_at = "2026-09-09T12:00:00Z"

    def __init__(self, repo: str, token: str):
        self.repo = repo
        self.token = token

    @classmethod
    def reset(cls) -> None:
        cls.files = {}
        cls.commits = []
        cls.unreachable = False

    def _check(self) -> None:
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

    async def last_commit(self, branch: str, path: str) -> str | None:
        self._check()
        return FakeRepo.committed_at if (branch, path) in FakeRepo.files else None

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


def _org(test_client, slug: str, owner_email: str, member_email: str | None = None):
    """``(org_id, owner, member)`` with the repository connected, one role in
    the catalog and one host reporting: what every test below starts from."""
    owner = _register(test_client, owner_email)
    org_id = test_client.post(
        "/api/human/orgs", json={"name": slug}, headers=_auth(owner["access_token"])
    ).json()["org_id"]
    member = None
    if member_email:
        member = _register(test_client, member_email)
        test_client.post(
            f"/api/human/orgs/{org_id}/members",
            json={"email": member_email, "role": "member"},
            headers=_auth(owner["access_token"]),
        )
    r = test_client.put(
        f"/api/human/orgs/{org_id}/reef",
        json={"repo": "acme/agents", "token": "ghp-good"},
        headers=_auth(owner["access_token"]),
    )
    assert r.status_code == 200, r.text
    FakeRepo.files[("main", "roles/clawbits-openclaw.toml")] = ROLE
    FakeRepo.files[("status", "status/prod-eu.json")] = STATUS
    return org_id, owner, member


# ── Connecting the repository ────────────────────────────────────────────────

def test_connect_lifecycle(test_client, _test_engine):
    """Owner connects, everyone reads, owner disconnects. The token is sealed
    at rest and never leaves the server."""
    org_id, owner, member = _org(test_client, "reef-life", "rl-o@test.com", "rl-m@test.com")
    outsider = _register(test_client, "rl-x@test.com")

    r = test_client.get(f"/api/human/orgs/{org_id}/reef", headers=_auth(member["access_token"]))
    assert r.status_code == 200, r.text
    assert r.json() == {
        "repo": "acme/agents",
        "connected": True,
        "hosts": [
            {
                "host": "prod-eu",
                "reef": "0.11.0",
                "agents": 1,
                "last_seen": "2026-09-09T12:00:00Z",
            }
        ],
    }
    assert "ghp-good" not in r.text

    from clawbits.db.models import Organization

    with Session(_test_engine) as db:
        stored = db.get(Organization, org_id)
        assert stored.reef_repo == "acme/agents"
        assert "ghp-good" not in stored.reef_repo_token

    r = test_client.get(f"/api/human/orgs/{org_id}/reef", headers=_auth(outsider["access_token"]))
    assert r.status_code == 403

    r = test_client.delete(f"/api/human/orgs/{org_id}/reef", headers=_auth(owner["access_token"]))
    assert r.status_code == 204
    r = test_client.get(f"/api/human/orgs/{org_id}/reef", headers=_auth(owner["access_token"]))
    assert r.json() == {"repo": None, "connected": False, "hosts": []}


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
    headers = _auth(member["access_token"])
    assert (
        test_client.put(
            f"/api/human/orgs/{org_id}/reef",
            json={"repo": "acme/other", "token": "ghp-good"},
            headers=headers,
        ).status_code
        == 403
    )
    assert test_client.delete(f"/api/human/orgs/{org_id}/reef", headers=headers).status_code == 403


def test_connect_rejects_a_repo_the_token_cannot_see(test_client):
    """Nothing is stored unless GitHub confirms the token first."""
    owner = _register(test_client, "rb-o@test.com")
    org_id = test_client.post(
        "/api/human/orgs", json={"name": "reef-bad"}, headers=_auth(owner["access_token"])
    ).json()["org_id"]

    r = test_client.put(
        f"/api/human/orgs/{org_id}/reef",
        json={"repo": "acme/agents", "token": "ghp-wrong"},
        headers=_auth(owner["access_token"]),
    )
    assert r.status_code == 502, r.text

    r = test_client.put(
        f"/api/human/orgs/{org_id}/reef",
        json={"repo": "not-a-repo", "token": "ghp-good"},
        headers=_auth(owner["access_token"]),
    )
    assert r.status_code == 422

    r = test_client.get(f"/api/human/orgs/{org_id}/reef", headers=_auth(owner["access_token"]))
    assert r.json()["connected"] is False


def test_endpoints_409_without_a_repository(test_client):
    owner = _register(test_client, "rn-o@test.com")
    org_id = test_client.post(
        "/api/human/orgs", json={"name": "reef-none"}, headers=_auth(owner["access_token"])
    ).json()["org_id"]
    headers = _auth(owner["access_token"])
    assert test_client.get(f"/api/human/orgs/{org_id}/reef/roles", headers=headers).status_code == 409
    assert test_client.get(f"/api/human/orgs/{org_id}/reef/status", headers=headers).status_code == 409


# ── The catalog and the status branch ────────────────────────────────────────

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


def test_status_carries_hosts_and_declared(test_client):
    org_id, owner, _ = _org(test_client, "reef-status", "rs-o@test.com")
    FakeRepo.files[("status", "status/garbage.json")] = b"{not json"

    test_client.post(
        f"/api/human/orgs/{org_id}/reef/agents",
        json={"host": "prod-eu", "role": "clawbits-openclaw", "name": "ana-bot"},
        headers=_auth(owner["access_token"]),
    )
    r = test_client.get(
        f"/api/human/orgs/{org_id}/reef/status", headers=_auth(owner["access_token"])
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert list(body["hosts"]) == ["prod-eu"]
    assert body["hosts"]["prod-eu"]["reef"] == "0.11.0"
    assert [(d["host"], d["name"]) for d in body["declared"]] == [("prod-eu", "ana-bot")]


# ── Declaring an agent ───────────────────────────────────────────────────────

def test_create_writes_the_fleet_file(test_client):
    """The file is the whole handoff: role, owner, org and a live one-time
    token, authored by the person who clicked."""
    org_id, owner, _ = _org(test_client, "reef-create", "rc-o@test.com")

    r = test_client.post(
        f"/api/human/orgs/{org_id}/reef/agents",
        json={
            "host": "prod-eu",
            "role": "clawbits-openclaw",
            "name": "ana-bot",
            "public_host": "ana-bot.example.com",
        },
        headers=_auth(owner["access_token"]),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert (body["host"], body["name"]) == ("prod-eu", "ana-bot")
    expires_in = datetime.fromisoformat(body["expires_at"]) - datetime.now(UTC)
    assert timedelta(days=6, hours=23) < expires_in <= timedelta(days=7)

    raw = FakeRepo.files[("fleet", "fleet/prod-eu/ana-bot.toml")]
    parsed = tomllib.loads(raw.decode())
    assert parsed["version"] == 1
    entry = parsed["agents"]["ana-bot"]
    assert entry["role"] == "clawbits-openclaw"
    assert entry["owner"] == "rc-o"
    assert entry["env"]["CLAWBITS_ORG_ID"] == org_id
    assert entry["env"]["CLAWBITS_SIGNUP_TOKEN"].startswith("human-")
    assert entry["env"]["OPENCLAW_PUBLIC_HOST"] == "ana-bot.example.com"
    assert FakeRepo.commits == [("declare ana-bot on prod-eu", "rc-o", "rc-o@test.com")]


def test_create_rejects_bad_input(test_client):
    """reef's own name rule, a host that has never reported, and a role that
    is not in the catalog all fail here rather than on the host."""
    org_id, owner, _ = _org(test_client, "reef-bad-in", "rbi-o@test.com")
    headers = _auth(owner["access_token"])
    good = {"host": "prod-eu", "role": "clawbits-openclaw", "name": "ana-bot"}

    for name in ("Ana-Bot", "1bot", "bot-", "", "a" * 41, "an/bot"):
        r = test_client.post(
            f"/api/human/orgs/{org_id}/reef/agents", json={**good, "name": name}, headers=headers
        )
        assert r.status_code == 422, f"{name!r} was accepted"

    r = test_client.post(
        f"/api/human/orgs/{org_id}/reef/agents", json={**good, "host": "prod-us"}, headers=headers
    )
    assert r.status_code == 422 and "prod-us" in r.json()["detail"]

    r = test_client.post(
        f"/api/human/orgs/{org_id}/reef/agents", json={**good, "role": "nope"}, headers=headers
    )
    assert r.status_code == 422 and "nope" in r.json()["detail"]

    assert not [k for k in FakeRepo.files if k[0] == "fleet"]


def test_create_refuses_a_name_already_declared(test_client):
    org_id, owner, _ = _org(test_client, "reef-dup", "rd-o@test.com")
    body = {"host": "prod-eu", "role": "clawbits-openclaw", "name": "ana-bot"}
    headers = _auth(owner["access_token"])
    assert (
        test_client.post(
            f"/api/human/orgs/{org_id}/reef/agents", json=body, headers=headers
        ).status_code
        == 200
    )
    r = test_client.post(f"/api/human/orgs/{org_id}/reef/agents", json=body, headers=headers)
    assert r.status_code == 409, r.text


def test_create_takes_the_session_down_with_a_failed_write(test_client):
    """A declared agent always has a file, and a file always has a live token:
    if the write fails the minted session goes with it."""
    org_id, owner, _ = _org(test_client, "reef-roll", "rrb-o@test.com")
    FakeRepo.unreachable = True

    r = test_client.post(
        f"/api/human/orgs/{org_id}/reef/agents",
        json={"host": "prod-eu", "role": "clawbits-openclaw", "name": "ana-bot"},
        headers=_auth(owner["access_token"]),
    )
    assert r.status_code == 502, r.text

    FakeRepo.unreachable = False
    r = test_client.get(
        f"/api/human/orgs/{org_id}/reef/status", headers=_auth(owner["access_token"])
    )
    assert r.json()["declared"] == []


# ── The token is the identity: signup-commit ─────────────────────────────────

def _declare(test_client, org_id: str, owner: dict, name: str = "ana-bot") -> str:
    r = test_client.post(
        f"/api/human/orgs/{org_id}/reef/agents",
        json={"host": "prod-eu", "role": "clawbits-openclaw", "name": name},
        headers=_auth(owner["access_token"]),
    )
    assert r.status_code == 200, r.text
    raw = FakeRepo.files[("fleet", f"fleet/prod-eu/{name}.toml")]
    return tomllib.loads(raw.decode())["agents"][name]["env"]["CLAWBITS_SIGNUP_TOKEN"]


def test_commit_copies_host_and_name_onto_the_agent(test_client, _test_engine):
    org_id, owner, _ = _org(test_client, "reef-commit", "rk-o@test.com")
    token = _declare(test_client, org_id, owner)

    r = test_client.post(
        "/api/agentic/signup-commit", json={"session_token": token, "challenge_response": ""}
    )
    assert r.status_code == 200, r.text
    agent_id = r.json()["agent_id"]

    with Session(_test_engine) as db:
        row = db.get(Agent, agent_id)
        assert (row.reef_host, row.reef_name) == ("prod-eu", "ana-bot")

    listed = test_client.get(
        f"/api/human/orgs/{org_id}/agents", headers=_auth(owner["access_token"])
    ).json()
    mine = next(a for a in listed["agents"] if a["agent_id"] == agent_id)
    assert (mine["reef_host"], mine["reef_name"]) == ("prod-eu", "ana-bot")

    profile = test_client.get(
        f"/api/human/orgs/{org_id}/agents/{agent_id}", headers=_auth(owner["access_token"])
    ).json()
    assert (profile["reef_host"], profile["reef_name"]) == ("prod-eu", "ana-bot")


def test_a_spent_token_cannot_mint_a_second_agent(test_client):
    """The token in the fleet file stays there forever; it is dead after the
    first boot spends it."""
    org_id, owner, _ = _org(test_client, "reef-spent", "rp-o@test.com")
    token = _declare(test_client, org_id, owner)

    first = test_client.post(
        "/api/agentic/signup-commit", json={"session_token": token, "challenge_response": ""}
    )
    assert first.status_code == 200, first.text
    second = test_client.post(
        "/api/agentic/signup-commit", json={"session_token": token, "challenge_response": ""}
    )
    assert second.status_code == 401, second.text


def test_declared_clears_once_the_agent_enrols(test_client):
    org_id, owner, _ = _org(test_client, "reef-enrol", "re-o@test.com")
    token = _declare(test_client, org_id, owner)
    headers = _auth(owner["access_token"])

    assert len(
        test_client.get(f"/api/human/orgs/{org_id}/reef/status", headers=headers).json()["declared"]
    ) == 1
    test_client.post(
        "/api/agentic/signup-commit", json={"session_token": token, "challenge_response": ""}
    )
    he._reef_status_cache.clear()
    assert (
        test_client.get(f"/api/human/orgs/{org_id}/reef/status", headers=headers).json()["declared"]
        == []
    )


# ── Removing an agent ────────────────────────────────────────────────────────

def test_remove_deletes_the_fleet_file(test_client):
    org_id, owner, _ = _org(test_client, "reef-rm", "rm-o@test.com")
    _declare(test_client, org_id, owner)

    r = test_client.delete(
        f"/api/human/orgs/{org_id}/reef/agents/prod-eu/ana-bot",
        headers=_auth(owner["access_token"]),
    )
    assert r.status_code == 204, r.text
    assert ("fleet", "fleet/prod-eu/ana-bot.toml") not in FakeRepo.files
    assert FakeRepo.commits[-1] == ("remove ana-bot from prod-eu", "rm-o", "rm-o@test.com")


def test_remove_is_operator_or_owner_only(test_client):
    """A member who neither owns the org nor operates the agent cannot pull it
    out from under its operator."""
    org_id, owner, member = _org(test_client, "reef-rmx", "rx-o@test.com", "rx-m@test.com")
    _declare(test_client, org_id, owner)

    r = test_client.delete(
        f"/api/human/orgs/{org_id}/reef/agents/prod-eu/ana-bot",
        headers=_auth(member["access_token"]),
    )
    assert r.status_code == 403, r.text
    assert ("fleet", "fleet/prod-eu/ana-bot.toml") in FakeRepo.files


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
