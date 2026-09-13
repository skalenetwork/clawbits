"""Git repositories on disk at ``{base_path}/{org_id}/{repo_name}``, driven through the git CLI."""
import logging
import os
import re
import subprocess
from pathlib import Path

from clawbits.domain import SYSTEM_EMAIL

logger = logging.getLogger(__name__)

# Outside the source tree: repo contents are agent-supplied, so a containment bug must not write next to code.
GIT_REPOS_BASE_PATH = os.getenv(
    "GIT_REPOS_BASE_PATH",
    os.path.join(os.path.expanduser("~"), ".local", "share", "clawbits", "git_repos"),
)

_LOG_FORMAT = "--format=%H%n%s%n%an%n%ae%n%aI"
_COMMIT_FIELDS = ("sha", "message", "author_name", "author_email", "date")

# A ref is its own argv token, so a leading "-" parses as an option (``--output=<path>`` writes anywhere).
# Stricter than ``git check-ref-format``: branch, tag, ``refs/`` path or SHA, and no revision grammar.
_REF_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9._/-]*$", re.ASCII)


def _run_git(args: list[str], cwd: str, env: dict | None = None) -> subprocess.CompletedProcess:
    result = subprocess.run(
        ["git", "-c", "commit.gpgsign=false", *args],
        cwd=cwd,
        capture_output=True,
        text=True,
        env={**os.environ, **(env or {})},
        timeout=30,
    )
    if result.returncode != 0:
        logger.error("git %s failed in %s: %s", " ".join(args), cwd, result.stderr)
    return result


def _author_env(name: str, email: str) -> dict[str, str]:
    return {
        "GIT_AUTHOR_NAME": name,
        "GIT_AUTHOR_EMAIL": email,
        "GIT_COMMITTER_NAME": name,
        "GIT_COMMITTER_EMAIL": email,
    }


def _parse_commits(stdout: str) -> list[dict]:
    lines = stdout.strip().split("\n")
    return [dict(zip(_COMMIT_FIELDS, lines[i : i + 5], strict=True)) for i in range(0, len(lines) - 4, 5)]


def repo_path(base_path: str, org_id: str, repo_name: str) -> str:
    return os.path.join(base_path, org_id, repo_name)


def _validate_rel_path(rel_path: str) -> list[str]:
    """The components of a repo-relative path. ValueError when it is absolute or has an empty,
    ``.``, ``..`` or ``.git`` component: a write under ``.git`` executes on the next git call."""
    if os.path.isabs(rel_path) or rel_path.startswith(("/", "\\")):
        raise ValueError(f"absolute path not allowed: {rel_path!r}")
    parts = rel_path.replace("\\", "/").split("/")
    if any(part in ("", ".", "..") or part.lower() == ".git" for part in parts):
        raise ValueError(f"invalid path component in: {rel_path!r}")
    return parts


def _validate_ref(ref: str) -> None:
    if not ref:
        raise ValueError("ref must not be empty")
    if len(ref) > 255:
        raise ValueError(f"ref too long ({len(ref)} chars, max 255)")
    if not _REF_RE.match(ref) or ".." in ref or "//" in ref or ref.endswith(("/", ".", ".lock")):
        raise ValueError(f"invalid ref: {ref!r}")


def _write_repo_file(rpath: str, parts: list[str], content: str) -> None:
    """Write ``parts`` under ``rpath`` one ``dir_fd`` + ``O_NOFOLLOW`` hop at a time, so no symlink, even one
    checkout materialized or one that appears mid-walk, can redirect the write. ValueError on any unsafe hop."""
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
    """Create the repo with a README as its first commit; returns its path."""
    rpath = repo_path(base_path, org_id, repo_name)
    os.makedirs(rpath, exist_ok=True)
    _run_git(["init", "-b", "main"], cwd=rpath)
    Path(rpath, "README.md").write_text(f"# {repo_name}\n", encoding="utf-8")
    _run_git(["add", "."], cwd=rpath)
    _run_git(["commit", "-m", "Initial commit"], cwd=rpath, env=_author_env(author_name, author_email))
    return rpath


def list_commits(
    base_path: str,
    org_id: str,
    repo_name: str,
    branch: str = "main",
    limit: int = 50,
    offset: int = 0,
) -> list[dict]:
    """Commits on ``branch``, newest first."""
    _validate_ref(branch)
    rpath = repo_path(base_path, org_id, repo_name)
    if not os.path.isdir(rpath):
        return []
    # Options must precede --end-of-options: git parses everything after it as a revision.
    args = ["log", _LOG_FORMAT, f"--skip={offset}", f"--max-count={limit}", "--end-of-options", branch]
    result = _run_git(args, cwd=rpath)
    return _parse_commits(result.stdout) if result.returncode == 0 else []


def count_commits(base_path: str, org_id: str, repo_name: str, branch: str = "main") -> int:
    _validate_ref(branch)
    rpath = repo_path(base_path, org_id, repo_name)
    if not os.path.isdir(rpath):
        return 0
    result = _run_git(["rev-list", "--count", "--end-of-options", branch], cwd=rpath)
    return int(result.stdout.strip()) if result.returncode == 0 else 0


def list_tree(
    base_path: str,
    org_id: str,
    repo_name: str,
    ref: str = "main",
    path: str = "",
) -> list[dict]:
    """Entries of the directory ``path`` at ``ref``."""
    _validate_ref(ref)
    rpath = repo_path(base_path, org_id, repo_name)
    if not os.path.isdir(rpath):
        return []
    # ``path`` needs no check: git resolves it inside the tree and refuses anything outside the repository.
    result = _run_git(["ls-tree", "-l", "--end-of-options", f"{ref}:{path}" if path else ref], cwd=rpath)
    if result.returncode != 0:
        return []
    entries = []
    for line in result.stdout.strip().split("\n"):
        meta, tab, name = line.partition("\t")
        fields = meta.split()
        if not tab or len(fields) < 4:
            continue
        entries.append({
            "name": name,
            "path": f"{path}/{name}" if path else name,
            "type": fields[1],
            "size": None if fields[3] == "-" else int(fields[3]),
        })
    return entries


def read_blob(base_path: str, org_id: str, repo_name: str, ref: str, path: str) -> str | None:
    _validate_ref(ref)
    rpath = repo_path(base_path, org_id, repo_name)
    if not os.path.isdir(rpath):
        return None
    result = _run_git(["show", "--end-of-options", f"{ref}:{path}"], cwd=rpath)
    return result.stdout if result.returncode == 0 else None


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
    """Commit ``files`` (``{path, content, action}``, action ``create``, ``update`` or ``delete``)
    on ``branch``. ``None`` when any git step fails."""
    rpath = repo_path(base_path, org_id, repo_name)
    if not os.path.isdir(rpath):
        return None
    # Everything is validated before the first write: paths are agent-supplied, and a lone branch
    # token is option-parseable (``checkout --orphan=<name>`` succeeds).
    _validate_ref(branch)
    parts_by_path = {f["path"]: _validate_rel_path(f["path"]) for f in files}
    env = _author_env(author_name, author_email)
    if _run_git(["checkout", "--end-of-options", branch], cwd=rpath, env=env).returncode != 0:
        return None
    for f in files:
        if f["action"] in ("create", "update"):
            _write_repo_file(rpath, parts_by_path[f["path"]], f.get("content") or "")
            args = ["add", "--", f["path"]]
        elif f["action"] == "delete":
            args = ["rm", "-f", "--", f["path"]]
        else:
            continue
        if _run_git(args, cwd=rpath).returncode != 0:
            return None
    if _run_git(["commit", "-m", message, "--allow-empty"], cwd=rpath, env=env).returncode != 0:
        return None
    result = _run_git(["log", "-1", _LOG_FORMAT], cwd=rpath)
    commits = _parse_commits(result.stdout) if result.returncode == 0 else []
    return commits[0] if commits else None
