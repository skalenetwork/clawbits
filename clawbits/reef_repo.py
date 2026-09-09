"""The org's reef repository: git is the bus between clawbits and a reef host.

One private repo per org, three branches, one writer each. ``main`` holds the
reviewed ``roles/*.toml``; clawbits writes ``fleet/<host>/<name>.toml`` on
``fleet``; each host writes ``status/<host>.json`` on ``status``. clawbits never
talks to a reef host and nothing ever connects to it — the host pulls.

Only ``api.github.com`` is reached from here, with a fine-grained token scoped
to that one repository. The token is unsealed per request and never logged.
"""

from __future__ import annotations

import base64
import json
import re
import tomllib
from dataclasses import dataclass

import httpx

API = "https://api.github.com"
TIMEOUT = httpx.Timeout(10.0)

REPO_RE = re.compile(r"^[A-Za-z0-9][\w.-]{0,99}/[A-Za-z0-9][\w.-]{0,99}$")
# reef's own rule (crates/reef-core/src/name.rs ``is_name``): 1-40 chars,
# starts with a lowercase letter, no trailing hyphen. Enforced here so a bad
# name fails in the UI instead of on the host.
NAME_RE = re.compile(r"^[a-z](?:[a-z0-9-]{0,38}[a-z0-9])?$")
OWNER_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
PUBLIC_HOST_RE = re.compile(r"^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$")


class ReefRepoError(RuntimeError):
    """A GitHub call failed. The message is GitHub's own."""


class ReefRepoConflict(ReefRepoError):
    """The path already exists. Every request here is constructed, never
    user-shaped, so GitHub's 409/422 on a create can only mean that."""


@dataclass(frozen=True, slots=True)
class Author:
    name: str
    email: str


@dataclass(frozen=True, slots=True)
class Secret:
    env: str
    host: str


@dataclass(frozen=True, slots=True)
class Role:
    name: str
    image: str
    egress: list[str]
    secrets: list[Secret]
    resources: dict[str, int]


@dataclass(frozen=True, slots=True)
class ReefRepo:
    repo: str
    token: str

    async def probe(self) -> None:
        """Raise unless the token can see this repository. The one call the
        connect form makes: a repo the token cannot read is a 404 on every
        later path, indistinguishable from an empty branch."""
        if await self._send("GET", f"{API}/repos/{self.repo}") is None:
            raise ReefRepoError(f"{self.repo} not found, or the token cannot see it")

    async def read(self, branch: str, path: str) -> tuple[str, bytes] | None:
        """``(sha, content)`` for a file, or ``None`` when it does not exist."""
        found = await self._send("GET", self._url(path), params={"ref": branch})
        if found is None or isinstance(found, list):
            return None
        return found["sha"], base64.b64decode(found["content"])

    async def write(
        self, branch: str, path: str, content: bytes, message: str, author: Author
    ) -> None:
        """Create a file. Fails with 409 semantics if it already exists: no sha
        is sent, so GitHub refuses to overwrite."""
        await self._send(
            "PUT",
            self._url(path),
            json={
                "branch": branch,
                "message": message,
                "content": base64.b64encode(content).decode(),
                "author": {"name": author.name, "email": author.email},
            },
        )

    async def delete(self, branch: str, path: str, message: str, author: Author) -> None:
        head = await self.read(branch, path)
        if head is None:
            return
        await self._send(
            "DELETE",
            self._url(path),
            json={
                "branch": branch,
                "message": message,
                "sha": head[0],
                "author": {"name": author.name, "email": author.email},
            },
        )

    async def last_commit(self, branch: str, path: str) -> str | None:
        """When a path last changed, ISO-8601. A host's status file carries no
        timestamp of its own — the commit is the timestamp, and a commit that
        stops advancing is how a stopped reconciler looks."""
        found = await self._send(
            "GET",
            f"{API}/repos/{self.repo}/commits",
            params={"path": path, "sha": branch, "per_page": 1},
        )
        if not found or not isinstance(found, list):
            return None
        return found[0].get("commit", {}).get("committer", {}).get("date")

    async def list(self, branch: str, directory: str) -> list[str]:
        """File names directly under ``directory``; empty when it is absent."""
        found = await self._send("GET", self._url(directory), params={"ref": branch})
        if not isinstance(found, list):
            return []
        return [e["name"] for e in found if e["type"] == "file"]

    def _url(self, path: str) -> str:
        return f"{API}/repos/{self.repo}/contents/{path.lstrip('/')}"

    async def _send(self, method: str, url: str, **kw) -> dict | list | None:
        headers = {
            "Authorization": f"Bearer {self.token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        }
        try:
            async with httpx.AsyncClient(timeout=TIMEOUT) as client:
                r = await client.request(method, url, headers=headers, **kw)
        except httpx.HTTPError as e:
            raise ReefRepoError(f"github unreachable: {e}") from e
        if r.status_code == 404:
            return None
        if r.status_code in (409, 422):
            raise ReefRepoConflict(_github_message(r))
        if r.status_code >= 400:
            raise ReefRepoError(_github_message(r))
        return r.json() if r.content else None


def _github_message(r: httpx.Response) -> str:
    try:
        body = r.json()
    except ValueError:
        return f"github returned {r.status_code}"
    return str(body.get("message") or f"github returned {r.status_code}")


def parse_role(name: str, raw: bytes, endpoint: str) -> Role | None:
    """One role from ``main:roles/``, or ``None`` when it is unparseable or
    points its agents at a different clawbits than this one."""
    try:
        data = tomllib.loads(raw.decode())
    except (UnicodeDecodeError, tomllib.TOMLDecodeError):
        return None
    if _normalize(data.get("env", {}).get("CLAWBITS_ENDPOINT")) != _normalize(endpoint):
        return None
    secrets = data.get("secrets", {})
    return Role(
        name=str(data.get("name") or name),
        image=str(data.get("image", "")),
        egress=[str(d) for d in data.get("network", {}).get("egress", [])],
        secrets=[
            Secret(env=env, host=str(spec.get("host", "")))
            for env, spec in secrets.items()
            if isinstance(spec, dict)
        ],
        resources={k: v for k, v in data.get("resources", {}).items() if isinstance(v, int)},
    )


def parse_status(raw: bytes) -> dict | None:
    """One ``status/<host>.json``, or ``None`` when a host wrote nonsense."""
    try:
        found = json.loads(raw)
    except ValueError:
        return None
    return found if isinstance(found, dict) else None


def fleet_toml(name: str, role: str, owner: str, env: dict[str, str]) -> bytes:
    """The fleet file clawbits writes, exactly once per agent. Every value is
    validated by the caller against the patterns above, so plain quoting holds."""
    lines = [
        "version = 1",
        "",
        f"[agents.{name}]",
        f'role  = "{role}"',
        f'owner = "{owner}"',
        "",
        f"[agents.{name}.env]",
    ]
    width = max(len(k) for k in env)
    lines += [f'{k.ljust(width)} = "{v}"' for k, v in env.items()]
    return ("\n".join(lines) + "\n").encode()


def _normalize(url: str | None) -> str:
    return (url or "").strip().rstrip("/")
