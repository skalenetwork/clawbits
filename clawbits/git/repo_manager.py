"""Git repository manager — wraps subprocess calls to git.

Repos are stored on disk at ``{base_path}/{org_id}/{repo_name}``.

Environment variable:
    GIT_REPOS_BASE_PATH  – root directory for all repos (default: ./git_repos)
"""
import logging
import os
import subprocess
from pathlib import Path

from clawbits.domain import SYSTEM_EMAIL

logger = logging.getLogger(__name__)

GIT_REPOS_BASE_PATH = os.getenv("GIT_REPOS_BASE_PATH", os.path.join(os.getcwd(), "git_repos"))


def _run_git(args: list[str], cwd: str, env: dict | None = None) -> subprocess.CompletedProcess:
    """Run a git command and return the result."""
    full_env = {**os.environ, **(env or {})}
    result = subprocess.run(
        ["git"] + args,
        cwd=cwd,
        capture_output=True,
        text=True,
        env=full_env,
        timeout=30,
    )
    if result.returncode != 0:
        logger.error(f"git {' '.join(args)} failed in {cwd}: {result.stderr}")
    return result


def repo_path(base_path: str, org_id: str, repo_name: str) -> str:
    """Return the on-disk path for a repository."""
    return os.path.join(base_path, org_id, repo_name)


def init_repo(
    base_path: str,
    org_id: str,
    repo_name: str,
    author_name: str = "Clawbits",
    author_email: str = SYSTEM_EMAIL,
) -> str:
    """Initialize a new git repo with an empty initial commit.

    Returns the absolute path to the repo.
    """
    rpath = repo_path(base_path, org_id, repo_name)
    os.makedirs(rpath, exist_ok=True)

    env = {
        "GIT_AUTHOR_NAME": author_name,
        "GIT_AUTHOR_EMAIL": author_email,
        "GIT_COMMITTER_NAME": author_name,
        "GIT_COMMITTER_EMAIL": author_email,
    }

    _run_git(["init", "-b", "main"], cwd=rpath)
    # Create initial commit with a README
    readme_path = os.path.join(rpath, "README.md")
    Path(readme_path).write_text(f"# {repo_name}\n", encoding="utf-8")
    _run_git(["add", "."], cwd=rpath)
    _run_git(["commit", "-m", "Initial commit"], cwd=rpath, env=env)

    return rpath


def list_commits(
    base_path: str,
    org_id: str,
    repo_name: str,
    branch: str = "main",
    limit: int = 50,
    offset: int = 0,
) -> list[dict]:
    """List commits on a branch, newest first.

    Returns list of {sha, message, author_name, author_email, date}.
    """
    rpath = repo_path(base_path, org_id, repo_name)
    if not os.path.isdir(rpath):
        return []

    fmt = "%H%n%s%n%an%n%ae%n%aI"  # sha, subject, author name, author email, ISO date
    result = _run_git(
        ["log", branch, f"--format={fmt}", f"--skip={offset}", f"--max-count={limit}"],
        cwd=rpath,
    )
    if result.returncode != 0:
        return []

    lines = result.stdout.strip().split("\n")
    commits = []
    i = 0
    while i + 4 < len(lines):
        commits.append({
            "sha": lines[i],
            "message": lines[i + 1],
            "author_name": lines[i + 2],
            "author_email": lines[i + 3],
            "date": lines[i + 4],
        })
        i += 5
    return commits


def count_commits(base_path: str, org_id: str, repo_name: str, branch: str = "main") -> int:
    """Count total commits on a branch."""
    rpath = repo_path(base_path, org_id, repo_name)
    if not os.path.isdir(rpath):
        return 0
    result = _run_git(["rev-list", "--count", branch], cwd=rpath)
    if result.returncode != 0:
        return 0
    return int(result.stdout.strip())


def list_tree(
    base_path: str,
    org_id: str,
    repo_name: str,
    ref: str = "main",
    path: str = "",
) -> list[dict]:
    """List entries in a tree (directory) at a given ref and path.

    Returns list of {name, path, type, size}.
    """
    rpath = repo_path(base_path, org_id, repo_name)
    if not os.path.isdir(rpath):
        return []

    tree_ref = f"{ref}:{path}" if path else ref
    result = _run_git(["ls-tree", "-l", tree_ref], cwd=rpath)
    if result.returncode != 0:
        return []

    entries = []
    for line in result.stdout.strip().split("\n"):
        if not line.strip():
            continue
        # Format: <mode> <type> <sha> <size>\t<name>
        parts = line.split("\t", 1)
        if len(parts) != 2:
            continue
        meta, name = parts
        meta_parts = meta.split()
        if len(meta_parts) < 4:
            continue
        entry_type = meta_parts[1]  # "blob" or "tree"
        size_str = meta_parts[3]
        size = int(size_str) if size_str != "-" else None
        full_path = f"{path}/{name}" if path else name
        entries.append({
            "name": name,
            "path": full_path,
            "type": entry_type,
            "size": size,
        })
    return entries


def read_blob(
    base_path: str,
    org_id: str,
    repo_name: str,
    ref: str,
    path: str,
) -> str | None:
    """Read file content at a given ref and path.

    Returns the content as a string, or None if not found.
    """
    rpath = repo_path(base_path, org_id, repo_name)
    if not os.path.isdir(rpath):
        return None

    result = _run_git(["show", f"{ref}:{path}"], cwd=rpath)
    if result.returncode != 0:
        return None
    return result.stdout


def create_commit(
    base_path: str,
    org_id: str,
    repo_name: str,
    message: str,
    files: list[dict],
    author_name: str,
    author_email: str,
    branch: str = "main",
) -> dict | None:
    """Create a commit with file changes.

    Args:
        files: list of {path, content, action} dicts.
        action: "create", "update", or "delete".

    Returns the commit dict {sha, message, author_name, author_email, date} or None on failure.
    """
    rpath = repo_path(base_path, org_id, repo_name)
    if not os.path.isdir(rpath):
        return None

    env = {
        "GIT_AUTHOR_NAME": author_name,
        "GIT_AUTHOR_EMAIL": author_email,
        "GIT_COMMITTER_NAME": author_name,
        "GIT_COMMITTER_EMAIL": author_email,
    }

    # Checkout the branch
    _run_git(["checkout", branch], cwd=rpath, env=env)

    # Apply file changes
    for f in files:
        file_path = os.path.join(rpath, f["path"])
        action = f["action"]

        if action in ("create", "update"):
            # Ensure parent directory exists
            os.makedirs(os.path.dirname(file_path), exist_ok=True)
            Path(file_path).write_text(f.get("content", ""), encoding="utf-8")
            _run_git(["add", f["path"]], cwd=rpath)
        elif action == "delete":
            _run_git(["rm", "-f", f["path"]], cwd=rpath)

    # Commit
    result = _run_git(["commit", "-m", message, "--allow-empty"], cwd=rpath, env=env)
    if result.returncode != 0:
        logger.error(f"Commit failed: {result.stderr}")
        return None

    # Get the commit info
    result = _run_git(["log", "-1", "--format=%H%n%s%n%an%n%ae%n%aI"], cwd=rpath)
    if result.returncode != 0:
        return None

    lines = result.stdout.strip().split("\n")
    if len(lines) < 5:
        return None

    return {
        "sha": lines[0],
        "message": lines[1],
        "author_name": lines[2],
        "author_email": lines[3],
        "date": lines[4],
    }
