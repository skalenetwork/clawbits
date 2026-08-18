"""Git repository manager — wraps subprocess calls to git.

Repos are stored on disk at ``{base_path}/{org_id}/{repo_name}``.

Environment variable:
    GIT_REPOS_BASE_PATH  – root directory for all repos
                           (default: ~/.local/share/clawbits/git_repos)
"""
import logging
import os
import re
import subprocess
from pathlib import Path

from clawbits.domain import SYSTEM_EMAIL

logger = logging.getLogger(__name__)

# The default must live outside the application directory: repo contents are
# agent-supplied, and a repo root under the source tree turns any containment
# bug into writes next to importable code.
GIT_REPOS_BASE_PATH = os.getenv(
    "GIT_REPOS_BASE_PATH",
    os.path.join(os.path.expanduser("~"), ".local", "share", "clawbits", "git_repos"),
)


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


def _validate_rel_path(rel_path: str) -> list[str]:
    """Lexically validate a repo-relative path and return its components.

    Raises ValueError if ``rel_path`` is absolute or has an empty / ``.`` /
    ``..`` / ``.git`` component. ``.git`` is rejected because a write there
    (hooks, config) executes on the next git invocation.
    """
    if os.path.isabs(rel_path) or rel_path.startswith(("/", "\\")):
        raise ValueError(f"absolute path not allowed: {rel_path!r}")
    parts = rel_path.replace("\\", "/").split("/")
    if any(part in ("", ".", "..") or part.lower() == ".git" for part in parts):
        raise ValueError(f"invalid path component in: {rel_path!r}")
    return parts


# Refs reach this module straight from query params. A ref is passed to git as
# its own argv token, so one starting with "-" is parsed as an *option*, not a
# revision — and several of the commands below accept ``--output=<path>``, which
# redirects their output to an arbitrary file (``git log``/``git show`` write the
# commit subject or diff there; ``rev-list`` truncates the file to zero even
# though it then errors). The charset below is strictly tighter than
# ``git check-ref-format``: it admits branch names, tag names, ``refs/...``
# paths and SHAs, and excludes every character that could start an option or
# reach git's revision grammar (``^ ~ : ? * [ \ @{`` and whitespace).
_REF_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9._/-]*$", re.ASCII)


def _validate_ref(ref: str) -> str:
    """Validate a branch / tag / commit-ish before it becomes a git argv token.

    Raises ValueError unless ``ref`` is a plain ref name or SHA. The leading
    character is constrained to alphanumeric/underscore, which is what rejects
    the option-injection case (a leading ``-``); the rest bars git's range and
    reflog syntax so a ref can only ever name one revision.
    """
    if not ref:
        raise ValueError("ref must not be empty")
    if len(ref) > 255:
        raise ValueError(f"ref too long ({len(ref)} chars, max 255)")
    if not _REF_RE.match(ref):
        raise ValueError(f"invalid ref: {ref!r}")
    if ".." in ref or "//" in ref or ref.endswith(("/", ".", ".lock")):
        raise ValueError(f"invalid ref: {ref!r}")
    return ref


def _write_repo_file(rpath: str, parts: list[str], content: str) -> None:
    """Write a file at ``parts`` under ``rpath`` without following any symlink.

    Walks component-by-component with ``dir_fd`` + ``O_NOFOLLOW``, so a symlink
    in the working tree (including one materialized by checkout, or one that
    appears mid-walk) can never redirect the write outside the repository or
    into ``.git``. Raises ValueError if any component is a symlink or not a
    plain directory / regular file.
    """
    dir_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    fd = os.open(rpath, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        for part in parts[:-1]:
            try:
                try:
                    nfd = os.open(part, dir_flags, dir_fd=fd)
                except FileNotFoundError:
                    try:
                        os.mkdir(part, dir_fd=fd)
                    except FileExistsError:
                        pass
                    nfd = os.open(part, dir_flags, dir_fd=fd)
            except OSError as e:
                raise ValueError(f"unsafe path component {part!r} in {'/'.join(parts)!r}") from e
            os.close(fd)
            fd = nfd
        try:
            ffd = os.open(
                parts[-1],
                os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW | os.O_CLOEXEC,
                0o644,
                dir_fd=fd,
            )
        except OSError as e:
            raise ValueError(f"unsafe path {'/'.join(parts)!r}") from e
        with os.fdopen(ffd, "wb") as fh:
            fh.write(content.encode("utf-8"))
    finally:
        os.close(fd)


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
    _validate_ref(branch)
    rpath = repo_path(base_path, org_id, repo_name)
    if not os.path.isdir(rpath):
        return []

    fmt = "%H%n%s%n%an%n%ae%n%aI"  # sha, subject, author name, author email, ISO date
    # Every option must precede --end-of-options; git treats everything after it
    # as a non-option, so a --format= placed later fails to parse.
    result = _run_git(
        [
            "log", f"--format={fmt}", f"--skip={offset}", f"--max-count={limit}",
            "--end-of-options", branch,
        ],
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
    _validate_ref(branch)
    rpath = repo_path(base_path, org_id, repo_name)
    if not os.path.isdir(rpath):
        return 0
    result = _run_git(["rev-list", "--count", "--end-of-options", branch], cwd=rpath)
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
    _validate_ref(ref)
    rpath = repo_path(base_path, org_id, repo_name)
    if not os.path.isdir(rpath):
        return []

    # ``path`` needs no check of its own: git resolves it inside the tree and
    # refuses anything that leaves the repository ("is outside repository").
    tree_ref = f"{ref}:{path}" if path else ref
    result = _run_git(["ls-tree", "-l", "--end-of-options", tree_ref], cwd=rpath)
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
    _validate_ref(ref)
    rpath = repo_path(base_path, org_id, repo_name)
    if not os.path.isdir(rpath):
        return None

    result = _run_git(["show", "--end-of-options", f"{ref}:{path}"], cwd=rpath)
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

    # Validate every path before mutating anything: paths are agent-supplied,
    # and the write below happens before git sees them. The branch is checked
    # for the same reason the read paths check refs — as a lone token it is
    # option-parseable, and ``checkout --orphan=<name>`` succeeds.
    _validate_ref(branch)
    parts_by_path = {f["path"]: _validate_rel_path(f["path"]) for f in files}

    env = {
        "GIT_AUTHOR_NAME": author_name,
        "GIT_AUTHOR_EMAIL": author_email,
        "GIT_COMMITTER_NAME": author_name,
        "GIT_COMMITTER_EMAIL": author_email,
    }

    # Checkout the branch; on failure abort rather than commit elsewhere.
    if _run_git(["checkout", "--end-of-options", branch], cwd=rpath, env=env).returncode != 0:
        return None

    # Apply file changes. Physical (symlink) checks happen inside
    # _write_repo_file, necessarily after checkout has settled the tree.
    for f in files:
        action = f["action"]

        if action in ("create", "update"):
            _write_repo_file(rpath, parts_by_path[f["path"]], f.get("content") or "")
            if _run_git(["add", "--", f["path"]], cwd=rpath).returncode != 0:
                return None
        elif action == "delete":
            if _run_git(["rm", "-f", "--", f["path"]], cwd=rpath).returncode != 0:
                return None

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
