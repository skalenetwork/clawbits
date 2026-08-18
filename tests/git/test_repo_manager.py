"""Containment tests for repo_manager — the layer below the API models.

The pydantic pattern on ``FileChange.path`` rejects most hostile paths at the
endpoint; these tests pin the defense-in-depth check inside ``create_commit``
so a future caller (or model change) cannot reintroduce the traversal.
"""
import os
from pathlib import Path

import pytest

from clawbits.git import repo_manager


def _commit_one(base_path, path, action="create"):
    return repo_manager.create_commit(
        str(base_path), "org1", "r1", "msg",
        [{"path": path, "content": "x", "action": action}],
        author_name="agent-1", author_email="agent-1@test",
    )


def test_rejects_escaping_paths(tmp_path):
    repo_manager.init_repo(str(tmp_path), "org1", "r1")

    bad_paths = [
        "../../evil.txt",              # traversal out of the repo
        "../sibling-repo/f.txt",       # traversal into another repo
        "/etc/cron.d/evil",            # absolute: os.path.join discards the base
        "a/../../../b.txt",            # traversal mid-path
        "./x.txt",                     # '.' component
        "a//b.txt",                    # empty component
        "a\\..\\b.txt",                # backslash separators
        ".git/hooks/post-checkout",    # git-dir write executes on next checkout
        ".git/config",
    ]
    for bad in bad_paths:
        with pytest.raises(ValueError):
            _commit_one(tmp_path, bad)
        with pytest.raises(ValueError):
            _commit_one(tmp_path, bad, action="delete")

    assert not (tmp_path / "evil.txt").exists()
    assert not (tmp_path / "b.txt").exists()


def test_rejects_symlink_escape(tmp_path):
    base = tmp_path / "base"
    rpath = repo_manager.init_repo(str(base), "org1", "r1")
    outside = tmp_path / "outside"
    outside.mkdir()
    os.symlink(outside, os.path.join(rpath, "link"))

    with pytest.raises(ValueError):
        _commit_one(base, "link/evil.txt")
    assert not (outside / "evil.txt").exists()


def test_rejects_symlink_into_git_dir(tmp_path):
    """A symlink whose target is *inside* the repo (.git) must also be refused."""
    rpath = repo_manager.init_repo(str(tmp_path), "org1", "r1")
    os.symlink(os.path.join(rpath, ".git"), os.path.join(rpath, "metadata"))

    with pytest.raises(ValueError):
        _commit_one(tmp_path, "metadata/hooks/post-checkout")
    assert not (Path(rpath) / ".git" / "hooks" / "post-checkout").exists()


def test_rejects_symlink_planted_via_branch_checkout(tmp_path):
    """Checkout runs before writes; a symlink restored by it must not be followed."""
    base = tmp_path / "base"
    outside = tmp_path / "outside"
    outside.mkdir()
    rpath = repo_manager.init_repo(str(base), "org1", "r1")

    # Plant a committed symlink on a side branch, out-of-band of the API.
    env = {
        "GIT_AUTHOR_NAME": "a", "GIT_AUTHOR_EMAIL": "a@test",
        "GIT_COMMITTER_NAME": "a", "GIT_COMMITTER_EMAIL": "a@test",
    }
    assert repo_manager._run_git(["checkout", "-b", "evil"], cwd=rpath).returncode == 0
    os.symlink(outside, os.path.join(rpath, "link"))
    assert repo_manager._run_git(["add", "link"], cwd=rpath).returncode == 0
    assert repo_manager._run_git(["commit", "-m", "plant"], cwd=rpath, env=env).returncode == 0
    assert repo_manager._run_git(["checkout", "main"], cwd=rpath).returncode == 0

    with pytest.raises(ValueError):
        repo_manager.create_commit(
            str(base), "org1", "r1", "msg",
            [{"path": "link/x.txt", "content": "x", "action": "create"}],
            author_name="agent-1", author_email="agent-1@test",
            branch="evil",
        )
    assert not (outside / "x.txt").exists()


def test_unknown_branch_fails_without_committing(tmp_path):
    repo_manager.init_repo(str(tmp_path), "org1", "r1")

    result = _commit_one(tmp_path, "f.txt")  # implicit branch="main" works
    assert result is not None

    before = repo_manager.count_commits(str(tmp_path), "org1", "r1")
    result = repo_manager.create_commit(
        str(tmp_path), "org1", "r1", "msg",
        [{"path": "g.txt", "content": "x", "action": "create"}],
        author_name="agent-1", author_email="agent-1@test",
        branch="does-not-exist",
    )
    assert result is None
    assert repo_manager.count_commits(str(tmp_path), "org1", "r1") == before


def test_failed_git_action_does_not_fake_success(tmp_path):
    """Deleting a nonexistent file must fail, not produce an empty 'success' commit."""
    repo_manager.init_repo(str(tmp_path), "org1", "r1")

    before = repo_manager.count_commits(str(tmp_path), "org1", "r1")
    result = _commit_one(tmp_path, "nonexistent.txt", action="delete")
    assert result is None
    assert repo_manager.count_commits(str(tmp_path), "org1", "r1") == before


def test_rejects_option_parseable_refs(tmp_path):
    """A ref starting with '-' is parsed by git as an option, not a revision.

    ``git log``/``git show`` accept ``--output=<path>`` and write there; a
    ``rev-list`` that then errors has already truncated the file. Each read sink
    must refuse the ref outright rather than hand it to git.
    """
    repo_manager.init_repo(str(tmp_path), "org1", "r1")
    victim = tmp_path / "victim.txt"
    victim.write_text("original\n")

    bad_refs = [
        f"--output={victim}",          # the write / truncate primitive
        "--help",                      # any option at all
        "-",                           # bare dash
        "main..evil",                  # range syntax
        "main^{tree}",                 # revision grammar
        "HEAD@{1}",                    # reflog syntax
        "refs//heads/main",            # empty component
        "main.lock",                   # git's own reserved suffix
        "",                            # empty
        "a" * 256,                     # over the length cap
    ]
    for bad in bad_refs:
        with pytest.raises(ValueError):
            repo_manager.list_commits(str(tmp_path), "org1", "r1", branch=bad)
        with pytest.raises(ValueError):
            repo_manager.count_commits(str(tmp_path), "org1", "r1", branch=bad)
        with pytest.raises(ValueError):
            repo_manager.list_tree(str(tmp_path), "org1", "r1", ref=bad)
        with pytest.raises(ValueError):
            repo_manager.read_blob(str(tmp_path), "org1", "r1", bad, "README.md")
        with pytest.raises(ValueError):
            repo_manager.create_commit(
                str(tmp_path), "org1", "r1", "msg",
                [{"path": "f.txt", "content": "x", "action": "create"}],
                author_name="agent-1", author_email="agent-1@test",
                branch=bad,
            )

    assert victim.read_text() == "original\n"  # neither overwritten nor truncated


def test_accepts_legitimate_refs(tmp_path):
    """The ref check must not break branch names, tags, refs/ paths or SHAs."""
    repo_manager.init_repo(str(tmp_path), "org1", "r1")
    rpath = repo_manager.repo_path(str(tmp_path), "org1", "r1")
    sha = repo_manager.list_commits(str(tmp_path), "org1", "r1")[0]["sha"]
    assert repo_manager._run_git(["tag", "v1.0.0"], cwd=rpath).returncode == 0
    assert repo_manager._run_git(["branch", "feature/x_1-2"], cwd=rpath).returncode == 0

    for ref in ("main", "feature/x_1-2", "v1.0.0", "refs/heads/main", sha, sha[:7], "HEAD"):
        assert repo_manager.read_blob(str(tmp_path), "org1", "r1", ref, "README.md") == "# r1\n"
        assert repo_manager.list_tree(str(tmp_path), "org1", "r1", ref=ref)
        assert repo_manager.count_commits(str(tmp_path), "org1", "r1", branch=ref) == 1
        assert len(repo_manager.list_commits(str(tmp_path), "org1", "r1", branch=ref)) == 1


def test_accepts_contained_paths(tmp_path):
    repo_manager.init_repo(str(tmp_path), "org1", "r1")

    commit = repo_manager.create_commit(
        str(tmp_path), "org1", "r1", "msg",
        [
            {"path": ".gitignore", "content": "*.pyc\n", "action": "create"},
            {"path": "docs/notes/readme.md", "content": "hi\n", "action": "create"},
        ],
        author_name="agent-1", author_email="agent-1@test",
    )
    assert commit is not None
    rpath = Path(repo_manager.repo_path(str(tmp_path), "org1", "r1"))
    assert (rpath / ".gitignore").read_text() == "*.pyc\n"
    assert (rpath / "docs" / "notes" / "readme.md").read_text() == "hi\n"
