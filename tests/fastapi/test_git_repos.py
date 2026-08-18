"""Tests for Git repository API endpoints."""
import os
import tempfile

import pytest
from starlette.testclient import TestClient

from clawbits.datastructures.known_answers import get_answer_for_question


@pytest.fixture(autouse=True)
def _git_base_path(test_client):
    """Point the shared app at an ephemeral git-repos directory for this test."""
    server = test_client.app
    with tempfile.TemporaryDirectory() as tmpdir:
        saved = getattr(server, "_git_repos_base_path", None)
        server._git_repos_base_path = tmpdir
        try:
            yield tmpdir
        finally:
            if saved is None:
                delattr(server, "_git_repos_base_path")
            else:
                server._git_repos_base_path = saved


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _create_agent(tc: TestClient) -> dict:
    from tests.fastapi._auth_helpers import signup_agent_via_email
    from tests.fastapi.approve_helper import _approve_signup

    r = signup_agent_via_email(tc, "stan@clawbits.ai")
    assert r.status_code == 200, r.text
    challenge = r.json()
    answer = get_answer_for_question(challenge["challenge"])
    r = tc.post("/api/agentic/signup-commit", json={
        "session_token": challenge["session_token"],
        "challenge_response": answer,
    })
    assert r.status_code == 200, r.text
    data = r.json()
    _approve_signup(tc, data)

    mint_challenge = tc.get(
        "/api/agentic/auth/challenge",
        headers={"Authorization": f"Bearer {data['api_key']}"},
    )
    assert mint_challenge.status_code == 200, mint_challenge.text
    mint_payload = mint_challenge.json()
    mint_answer = get_answer_for_question(mint_payload["challenge"])

    mint_resp = tc.post(
        "/api/agentic/auth/challenge_response",
        headers={
            "Authorization": f"Bearer {data['api_key']}",
        },
        json={
            "session_token": mint_payload["session_token"],
            "challenge_response": mint_answer,
        },
    )
    assert mint_resp.status_code == 200, mint_resp.text

    return data


def _auth(api_key: str) -> dict:
    return {"Authorization": f"Bearer {api_key}"}


def _write_headers(tc: TestClient, api_key: str) -> dict:
    r = tc.get("/api/agentic/auth/challenge", headers=_auth(api_key))
    assert r.status_code == 200, r.text
    ch = r.json()
    answer = get_answer_for_question(ch["challenge"])
    return _auth(api_key)


def _register_human(tc: TestClient, email: str) -> dict:
    from tests.fastapi._auth_helpers import register_human
    return register_human(tc, email, display_name=email.split("@")[0])


def _add_owner(tc: TestClient, agent: dict, email: str):
    """No-op shim: under the operator model an agent has exactly one org
    and one operator (set at signup approval). Multi-owner setup is gone;
    repo tests just exercise the agent's bound org."""
    del tc, agent, email
    return None


# ---------------------------------------------------------------------------
# Tests: Create repo
# ---------------------------------------------------------------------------

def test_create_repo(test_client):
    """Agent can create a repository in its owner org."""
    _register_human(test_client, "gituser@test.com")
    agent = _create_agent(test_client)
    _add_owner(test_client, agent, "gituser@test.com")

    r = test_client.post(
        f"/api/agentic/agents/{agent['agent_id']}/repos",
        json={"name": "my-repo", "description": "Test repository"},
        headers=_write_headers(test_client, agent["api_key"]),
    )
    assert r.status_code == 200, r.text
    repo = r.json()
    assert repo["name"] == "my-repo"
    assert repo["description"] == "Test repository"
    assert repo["created_by_agent"] == agent["agent_id"]
    assert repo["default_branch"] == "main"


def test_create_repo_duplicate_name_rejected(test_client):
    """Cannot create two repos with the same name in the same org."""
    _register_human(test_client, "dup@test.com")
    agent = _create_agent(test_client)
    _add_owner(test_client, agent, "dup@test.com")

    test_client.post(
        f"/api/agentic/agents/{agent['agent_id']}/repos",
        json={"name": "same-name"},
        headers=_write_headers(test_client, agent["api_key"]),
    )
    r = test_client.post(
        f"/api/agentic/agents/{agent['agent_id']}/repos",
        json={"name": "same-name"},
        headers=_write_headers(test_client, agent["api_key"]),
    )
    assert r.status_code == 409


def test_create_repo_with_default_owner(test_client):
    """Agent with creation-time owner (stan) can create a repo."""
    agent = _create_agent(test_client)
    r = test_client.post(
        f"/api/agentic/agents/{agent['agent_id']}/repos",
        json={"name": "default-owner-repo"},
        headers=_write_headers(test_client, agent["api_key"]),
    )
    assert r.status_code == 200


# ---------------------------------------------------------------------------
# Tests: List repos
# ---------------------------------------------------------------------------

def test_list_repos(test_client):
    """Agent can list repos accessible to it."""
    _register_human(test_client, "lister@test.com")
    agent = _create_agent(test_client)
    _add_owner(test_client, agent, "lister@test.com")

    test_client.post(
        f"/api/agentic/agents/{agent['agent_id']}/repos",
        json={"name": "repo-a"},
        headers=_write_headers(test_client, agent["api_key"]),
    )
    test_client.post(
        f"/api/agentic/agents/{agent['agent_id']}/repos",
        json={"name": "repo-b"},
        headers=_write_headers(test_client, agent["api_key"]),
    )

    r = test_client.get(
        f"/api/agentic/agents/{agent['agent_id']}/repos",
        headers=_auth(agent["api_key"]),
    )
    assert r.status_code == 200
    data = r.json()
    assert data["total"] == 2
    names = [r["name"] for r in data["repositories"]]
    assert "repo-a" in names
    assert "repo-b" in names


# ---------------------------------------------------------------------------
# Tests: Commits
# ---------------------------------------------------------------------------

def test_create_commit_and_list(test_client):
    """Agent can create a commit with files and list commits."""
    _register_human(test_client, "committer@test.com")
    agent = _create_agent(test_client)
    _add_owner(test_client, agent, "committer@test.com")

    # Create repo
    test_client.post(
        f"/api/agentic/agents/{agent['agent_id']}/repos",
        json={"name": "commit-repo"},
        headers=_write_headers(test_client, agent["api_key"]),
    )

    # Create commit
    r = test_client.post(
        f"/api/agentic/agents/{agent['agent_id']}/repos/commit-repo/commits",
        json={
            "message": "Add hello.txt",
            "files": [
                {"path": "hello.txt", "content": "Hello, World!", "action": "create"},
            ],
        },
        headers=_write_headers(test_client, agent["api_key"]),
    )
    assert r.status_code == 200, r.text
    commit = r.json()
    assert commit["message"] == "Add hello.txt"
    assert len(commit["sha"]) == 40  # full SHA

    # List commits (initial + our commit)
    r = test_client.get(
        f"/api/agentic/agents/{agent['agent_id']}/repos/commit-repo/commits",
        headers=_auth(agent["api_key"]),
    )
    assert r.status_code == 200
    data = r.json()
    assert data["total"] == 2  # initial commit + our commit
    assert data["commits"][0]["message"] == "Add hello.txt"


def test_create_commit_requires_auth(test_client):
    """Creating a commit without Authorization header fails."""
    r = test_client.post(
        "/api/agentic/agents/SomeAgent/repos/some-repo/commits",
        json={"message": "test", "files": [{"path": "x.txt", "content": "x", "action": "create"}]},
    )
    assert r.status_code in (401, 403)


# ---------------------------------------------------------------------------
# Tests: Tree and blob
# ---------------------------------------------------------------------------

def test_list_tree_and_read_blob(test_client):
    """Agent can browse the tree and read file contents."""
    _register_human(test_client, "tree@test.com")
    agent = _create_agent(test_client)
    _add_owner(test_client, agent, "tree@test.com")

    test_client.post(
        f"/api/agentic/agents/{agent['agent_id']}/repos",
        json={"name": "browse-repo"},
        headers=_write_headers(test_client, agent["api_key"]),
    )

    # Add a file
    test_client.post(
        f"/api/agentic/agents/{agent['agent_id']}/repos/browse-repo/commits",
        json={
            "message": "Add data file",
            "files": [{"path": "data/config.json", "content": '{"key": "value"}', "action": "create"}],
        },
        headers=_write_headers(test_client, agent["api_key"]),
    )

    # List root tree
    r = test_client.get(
        f"/api/agentic/agents/{agent['agent_id']}/repos/browse-repo/tree",
        headers=_auth(agent["api_key"]),
    )
    assert r.status_code == 200
    entries = r.json()["entries"]
    names = [e["name"] for e in entries]
    assert "README.md" in names
    assert "data" in names

    # Read blob
    r = test_client.get(
        f"/api/agentic/agents/{agent['agent_id']}/repos/browse-repo/blob/data/config.json",
        headers=_auth(agent["api_key"]),
    )
    assert r.status_code == 200
    blob = r.json()
    assert blob["path"] == "data/config.json"
    assert '"key": "value"' in blob["content"]


def test_read_blob_not_found(test_client):
    """Reading a non-existent file returns 404."""
    _register_human(test_client, "nofile@test.com")
    agent = _create_agent(test_client)
    _add_owner(test_client, agent, "nofile@test.com")

    test_client.post(
        f"/api/agentic/agents/{agent['agent_id']}/repos",
        json={"name": "empty-repo"},
        headers=_write_headers(test_client, agent["api_key"]),
    )

    r = test_client.get(
        f"/api/agentic/agents/{agent['agent_id']}/repos/empty-repo/blob/nonexistent.txt",
        headers=_auth(agent["api_key"]),
    )
    assert r.status_code == 404


# ---------------------------------------------------------------------------
# Tests: File delete via commit
# ---------------------------------------------------------------------------

def test_delete_file_via_commit(test_client):
    """Agent can delete a file via a commit."""
    _register_human(test_client, "deleter@test.com")
    agent = _create_agent(test_client)
    _add_owner(test_client, agent, "deleter@test.com")

    test_client.post(
        f"/api/agentic/agents/{agent['agent_id']}/repos",
        json={"name": "del-repo"},
        headers=_write_headers(test_client, agent["api_key"]),
    )

    # Create file
    test_client.post(
        f"/api/agentic/agents/{agent['agent_id']}/repos/del-repo/commits",
        json={"message": "Add file", "files": [{"path": "temp.txt", "content": "temp", "action": "create"}]},
        headers=_write_headers(test_client, agent["api_key"]),
    )

    # Delete file
    r = test_client.post(
        f"/api/agentic/agents/{agent['agent_id']}/repos/del-repo/commits",
        json={"message": "Delete file", "files": [{"path": "temp.txt", "action": "delete"}]},
        headers=_write_headers(test_client, agent["api_key"]),
    )
    assert r.status_code == 200

    # File should be gone
    r = test_client.get(
        f"/api/agentic/agents/{agent['agent_id']}/repos/del-repo/blob/temp.txt",
        headers=_auth(agent["api_key"]),
    )
    assert r.status_code == 404


# ---------------------------------------------------------------------------
# Tests: Auth enforcement
# ---------------------------------------------------------------------------

def test_wrong_agent_cannot_access_repo(test_client):
    """An agent cannot access repos in another agent's org."""
    _register_human(test_client, "owner1@test.com")
    a1 = _create_agent(test_client)
    a2 = _create_agent(test_client)
    _add_owner(test_client, a1, "owner1@test.com")

    test_client.post(
        f"/api/agentic/agents/{a1['agent_id']}/repos",
        json={"name": "private-repo"},
        headers=_write_headers(test_client, a1["api_key"]),
    )

    # a2 tries to list a1's repos
    r = test_client.get(
        f"/api/agentic/agents/{a1['agent_id']}/repos",
        headers=_auth(a2["api_key"]),
    )
    assert r.status_code in (401, 403)


def test_no_auth_rejected(test_client):
    """Requests without auth are rejected."""
    agent = _create_agent(test_client)
    r = test_client.get(f"/api/agentic/agents/{agent['agent_id']}/repos")
    assert r.status_code == 401


# ---------------------------------------------------------------------------
# Tests: Repo not found
# ---------------------------------------------------------------------------

def test_repo_not_found(test_client):
    """Accessing a non-existent repo returns 404."""
    _register_human(test_client, "norepo@test.com")
    agent = _create_agent(test_client)
    _add_owner(test_client, agent, "norepo@test.com")

    r = test_client.get(
        f"/api/agentic/agents/{agent['agent_id']}/repos/nonexistent/commits",
        headers=_auth(agent["api_key"]),
    )
    assert r.status_code == 404


# ---------------------------------------------------------------------------
# Tests: Commit path containment
# ---------------------------------------------------------------------------

def test_commit_traversal_paths_rejected(test_client, _git_base_path):
    """Traversal, absolute, and dot-segment paths are rejected before any write."""
    _register_human(test_client, "traversal@test.com")
    agent = _create_agent(test_client)
    _add_owner(test_client, agent, "traversal@test.com")

    test_client.post(
        f"/api/agentic/agents/{agent['agent_id']}/repos",
        json={"name": "safe-repo"},
        headers=_write_headers(test_client, agent["api_key"]),
    )

    bad_paths = [
        "../../evil.txt",       # traversal out of the repo
        "/etc/cron.d/evil",     # absolute: os.path.join would discard the base
        "a/../../../b.txt",     # traversal mid-path
        "./x.txt",              # '.' segment
        "a//b.txt",             # empty segment
        "a\\..\\b.txt",         # backslash separators
        "evil .txt",            # whitespace outside the allowed charset
    ]
    for bad in bad_paths:
        for file_change in (
            {"path": bad, "content": "pwn", "action": "create"},
            {"path": bad, "action": "delete"},
        ):
            r = test_client.post(
                f"/api/agentic/agents/{agent['agent_id']}/repos/safe-repo/commits",
                json={"message": "x", "files": [file_change]},
                headers=_write_headers(test_client, agent["api_key"]),
            )
            assert r.status_code == 422, f"{bad!r} ({file_change['action']}): {r.status_code} {r.text}"

    # '../../evil.txt' resolves to the base directory root; prove nothing landed there.
    assert not os.path.exists(os.path.join(_git_base_path, "evil.txt"))


def test_option_parseable_refs_rejected(test_client, _git_base_path, tmp_path):
    """`?branch=--output=<path>` must not reach git as an option.

    Refs are lone argv tokens, so one starting with '-' is parsed as an option.
    `git log --output=<path>` writes the (agent-authored) commit subject there
    and the `rev-list` that follows truncates it — an arbitrary write/truncate
    as the server user. Every ref-taking endpoint must reject it.
    """
    _register_human(test_client, "refinject@test.com")
    agent = _create_agent(test_client)
    _add_owner(test_client, agent, "refinject@test.com")
    base = f"/api/agentic/agents/{agent['agent_id']}/repos"

    test_client.post(
        base, json={"name": "ref-repo"},
        headers=_write_headers(test_client, agent["api_key"]),
    )

    victim = tmp_path / "victim.txt"
    victim.write_text("original\n")
    bad = f"--output={victim}"

    for url, params in (
        (f"{base}/ref-repo/commits", {"branch": bad}),
        (f"{base}/ref-repo/tree", {"ref": bad}),
        (f"{base}/ref-repo/blob/README.md", {"ref": bad}),
    ):
        r = test_client.get(url, params=params, headers=_auth(agent["api_key"]))
        assert r.status_code == 400, f"{url}: {r.status_code} {r.text}"

    # The write branch takes its ref in the body, where the model rejects it.
    r = test_client.post(
        f"{base}/ref-repo/commits",
        json={
            "message": "x",
            "files": [{"path": "f.txt", "content": "x", "action": "create"}],
            "branch": bad,
        },
        headers=_write_headers(test_client, agent["api_key"]),
    )
    assert r.status_code == 422, r.text

    assert victim.read_text() == "original\n"  # neither overwritten nor truncated


def test_commit_git_dir_write_rejected(test_client):
    """Writes into .git/ (hooks, config) are refused by the containment layer."""
    _register_human(test_client, "gitdir@test.com")
    agent = _create_agent(test_client)
    _add_owner(test_client, agent, "gitdir@test.com")

    test_client.post(
        f"/api/agentic/agents/{agent['agent_id']}/repos",
        json={"name": "hook-repo"},
        headers=_write_headers(test_client, agent["api_key"]),
    )

    r = test_client.post(
        f"/api/agentic/agents/{agent['agent_id']}/repos/hook-repo/commits",
        json={
            "message": "x",
            "files": [{"path": ".git/hooks/post-checkout", "content": "#!/bin/sh\n", "action": "create"}],
        },
        headers=_write_headers(test_client, agent["api_key"]),
    )
    assert r.status_code == 400, r.text
    assert "path" in r.json()["detail"].lower()


def test_commit_dotfiles_and_nested_paths_ok(test_client):
    """Legitimate dotfiles and nested paths still commit fine."""
    _register_human(test_client, "dotfile@test.com")
    agent = _create_agent(test_client)
    _add_owner(test_client, agent, "dotfile@test.com")

    test_client.post(
        f"/api/agentic/agents/{agent['agent_id']}/repos",
        json={"name": "dot-repo"},
        headers=_write_headers(test_client, agent["api_key"]),
    )

    r = test_client.post(
        f"/api/agentic/agents/{agent['agent_id']}/repos/dot-repo/commits",
        json={
            "message": "Add dotfile and nested file",
            "files": [
                {"path": ".gitignore", "content": "*.pyc\n", "action": "create"},
                {"path": "docs/notes/readme.md", "content": "hi\n", "action": "create"},
            ],
        },
        headers=_write_headers(test_client, agent["api_key"]),
    )
    assert r.status_code == 200, r.text

    r = test_client.get(
        f"/api/agentic/agents/{agent['agent_id']}/repos/dot-repo/blob/docs/notes/readme.md",
        headers=_auth(agent["api_key"]),
    )
    assert r.status_code == 200
    assert r.json()["content"] == "hi\n"

