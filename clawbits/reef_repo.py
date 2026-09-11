"""The org's reef repository: git is the bus between clawbits and a reef host.

One private repo per org, three branches, one writer each. ``main`` holds the
reviewed ``roles/*.toml``; clawbits writes ``fleet/<host>/<name>.toml`` on
``fleet``; each host writes ``status/<host>.json`` on ``status``. clawbits never
talks to a reef host and nothing ever connects to it: the host pulls.

Only ``api.github.com`` is reached from here, with a fine-grained token scoped
to that one repository. The token is unsealed per request and never logged.
"""

from __future__ import annotations

import asyncio
import base64
import json
import re
import tomllib
from collections import OrderedDict
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Literal

import httpx

API = "https://api.github.com"
BRANCHES = ("main", "fleet", "status")
LIVE_WITHIN = timedelta(minutes=25)

type Health = Literal["live", "stale", "failing"]

_client = httpx.AsyncClient(
    timeout=10.0,
    headers={"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"},
)
# GitHub does not count a 304 against the rate limit, so status and role reads
# send the ETag their URL last answered with and a 304 reuses that body. Fleet
# files are never cached: each one carries a live signup token.
CACHED_DIRS = ("status", "roles")
ETAG_CACHE_SIZE = 256
_etags: OrderedDict[str, tuple[str, dict | list]] = OrderedDict()

REPO_RE = re.compile(r"^[A-Za-z0-9][\w.-]{0,99}/[A-Za-z0-9][\w.-]{0,99}$")
# reef's own rule (crates/reef-core/src/name.rs ``is_name``), enforced here so
# a bad name fails in the UI instead of on the host.
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
        """Raise unless the bus can run here: the token sees the repository, it
        is private, and all three branches exist.

        The connect form makes this one call, so every check that has to happen
        before a token is stored happens in it. Privacy is not a preference:
        every fleet file carries a live single-use signup token and the org id.
        A missing branch answers 404 on the Contents API exactly as a missing
        path does, so a later write could never tell them apart."""
        found = await self._send("GET", f"{API}/repos/{self.repo}")
        if found is None or isinstance(found, list):
            raise ReefRepoError(f"{self.repo} not found, or the token cannot see it")
        if not found.get("private"):
            raise ReefRepoError(
                f"{self.repo} is public. Fleet files carry one-time signup tokens, "
                "so the repository has to be private."
            )
        heads = await asyncio.gather(
            *(self._send("GET", f"{API}/repos/{self.repo}/branches/{b}") for b in BRANCHES)
        )
        missing = [b for b, head in zip(BRANCHES, heads, strict=True) if head is None]
        if missing:
            raise ReefRepoError(
                f"{self.repo} is missing the {', '.join(missing)} "
                f"branch{'es' if len(missing) > 1 else ''}. "
                "Create the three the bus runs on: main, fleet and status."
            )

    async def read(self, branch: str, path: str) -> tuple[str, bytes] | None:
        """``(sha, content)`` for a file, or ``None`` when it does not exist."""
        found = await self._get(branch, path)
        if found is None or isinstance(found, list):
            return None
        return found["sha"], base64.b64decode(found["content"])

    async def write(
        self, branch: str, path: str, content: bytes, message: str, author: Author
    ) -> None:
        """Create a file. No sha is sent, so GitHub refuses to overwrite.

        A 404 means the branch is gone, and it must not read as success: the
        caller has already minted the one-time token this file was to carry, so
        a silent no-op burns it and declares an agent that can never enrol."""
        body = _commit(branch, message, author, content=base64.b64encode(content).decode())
        written = await self._send("PUT", self._url(path), json=body)
        if written is None:
            raise ReefRepoError(
                f"branch '{branch}' not found in {self.repo}: nothing was written"
            )

    async def delete(self, branch: str, path: str, message: str, author: Author) -> None:
        head = await self.read(branch, path)
        if head is None:
            return
        body = _commit(branch, message, author, sha=head[0])
        await self._send("DELETE", self._url(path), json=body)

    async def list(self, branch: str, directory: str) -> list[str]:
        """File names directly under ``directory``; empty when it is absent."""
        found = await self._get(branch, directory)
        if not isinstance(found, list):
            return []
        return [e["name"] for e in found if e["type"] == "file"]

    async def _get(self, branch: str, path: str) -> dict | list | None:
        return await self._send(
            "GET", self._url(path), cache=path.startswith(CACHED_DIRS), params={"ref": branch}
        )

    def _url(self, path: str) -> str:
        return f"{API}/repos/{self.repo}/contents/{path.lstrip('/')}"

    async def _send(self, method: str, url: str, cache: bool = False, **kw) -> dict | list | None:
        request = _client.build_request(
            method, url, headers={"Authorization": f"Bearer {self.token}"}, **kw
        )
        key = str(request.url)
        cached = _etags.get(key) if cache else None
        if cached:
            _etags.move_to_end(key)
            request.headers["If-None-Match"] = cached[0]
        try:
            r = await _client.send(request)
        except httpx.HTTPError as e:
            raise ReefRepoError(f"github unreachable: {e}") from e
        if cached and r.status_code == 304:
            return cached[1]
        if r.status_code == 404:
            return None
        if r.status_code in (409, 422):
            raise ReefRepoConflict(_github_message(r))
        if r.status_code >= 400:
            raise ReefRepoError(_github_message(r))
        body = r.json() if r.content else None
        if cache and body is not None and (etag := r.headers.get("ETag")):
            _etags[key] = (etag, body)
            _etags.move_to_end(key)
            if len(_etags) > ETAG_CACHE_SIZE:
                _etags.popitem(last=False)
        return body


def _commit(branch: str, message: str, author: Author, **body: str) -> dict:
    return {
        "branch": branch,
        "message": message,
        "author": {"name": author.name, "email": author.email},
        **body,
    }


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


def parse_status(raw: bytes, now: datetime) -> dict | None:
    """One ``status/<host>.json`` with ``last_seen`` and ``health`` derived,
    or ``None`` when a host wrote nonsense. ``at`` is the reconciler's
    ten-minute heartbeat, so twenty-five minutes without one is two missed
    beats; a file with no ``at`` predates it and proves nothing alive."""
    try:
        found = json.loads(raw)
    except ValueError:
        return None
    if not isinstance(found, dict):
        return None
    try:
        seen = datetime.strptime(found["at"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC)
    except (KeyError, TypeError, ValueError):
        seen = None
    health: Health = (
        "failing"
        if found.get("result") == "failed"
        else "live"
        if seen and now - seen <= LIVE_WITHIN
        else "stale"
    )
    return found | {"last_seen": seen, "health": health}


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


def fleet_name(agent_id: str) -> str:
    """An agent id fitted to reef's name rule: lowercased, underscores to
    hyphens, no trailing hyphen, and a letter first."""
    name = agent_id.lower().replace("_", "-").rstrip("-")
    return name if name[:1].isalpha() else f"a{name}"


def _normalize(url: str | None) -> str:
    return (url or "").strip().rstrip("/")
