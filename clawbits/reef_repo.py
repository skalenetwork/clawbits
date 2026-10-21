"""The org's reef repository: git is the bus between clawbits and a reef host.

One private repo per org, three branches, one writer each. ``main`` holds the
reviewed ``roles/*.toml``; clawbits writes ``fleet/<host>/<name>.toml`` on
``fleet``; each host writes ``status/<host>.json`` on ``status``. clawbits never
talks to a reef host and nothing ever connects to it: the host pulls.

Each org reaches its repository through a GitHub App of its own, created from
a manifest clawbits hands to GitHub and installed on that one repository. Every
call carries an installation token with read access unless it writes, minted
only after GitHub confirms the installation reaches that repository alone.
"""

from __future__ import annotations

import asyncio
import base64
import json
import re
import time
import tomllib
import urllib.parse
from collections import OrderedDict
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Literal

import httpx
import jwt

API = "https://api.github.com"
BRANCHES = ("main", "fleet", "status")
LIVE_WITHIN = timedelta(minutes=25)
TOKEN_SLACK = timedelta(minutes=5)

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
_tokens: dict[tuple[int, bool], tuple[str, datetime]] = {}
_minting = asyncio.Lock()

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
class ReefApp:
    """An org's own GitHub App: its id, its slug and its private key."""

    id: int
    slug: str
    key: str


@dataclass(frozen=True, slots=True)
class ReefRepo:
    repo: str
    app: ReefApp
    installation: int

    async def probe(self) -> None:
        """Raise unless the bus can run here: the repository is private and all
        three branches exist.

        Connecting makes this one call, so every check that has to happen before
        the repository is stored happens in it. Privacy is not a preference:
        every fleet file carries a live single-use signup token and the org id.
        A missing branch answers 404 on the Contents API exactly as a missing
        path does, so a later write could never tell them apart."""
        found = await self._send("GET", f"{API}/repos/{self.repo}")
        if found is None or isinstance(found, list):
            raise ReefRepoError(f"{self.repo} not found, or the Clawbits app cannot see it")
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
        self,
        branch: str,
        path: str,
        content: bytes,
        message: str,
        author: Author,
        sha: str | None = None,
    ) -> None:
        """Replace the file at ``sha``, or create one: without a sha GitHub
        refuses to overwrite.

        A 404 means the branch is gone, and it must not read as success: the
        caller has already minted the one-time token this file was to carry, so
        a silent no-op burns it and declares an agent that can never enrol."""
        body = _commit(branch, message, author, content=base64.b64encode(content).decode())
        if sha:
            body["sha"] = sha
        written = await self._send("PUT", self._url(path), json=body)
        if written is None:
            raise ReefRepoError(
                f"branch '{branch}' not found in {self.repo}: nothing was written"
            )

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
        token = await _installation_token(self.app, self.installation, self.repo, method != "GET")
        return await _request(method, url, token, cache, **kw)


async def _request(
    method: str, url: str, token: str | None, cache: bool = False, **kw
) -> dict | list | None:
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    request = _client.build_request(method, url, headers=headers, **kw)
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


def _app_jwt(app: ReefApp) -> str:
    """The App's own credential, good for ten minutes."""
    now = int(time.time())
    claims = {"iat": now - 60, "exp": now + 540, "iss": str(app.id)}
    return jwt.encode(claims, app.key, algorithm="RS256")


async def _installation_token(app: ReefApp, installation: int, repo: str, write: bool) -> str:
    """A token with write access only when the call writes, handed out only
    while the installation reaches ``repo`` and nothing else: an org admin can
    widen it on GitHub at any time, and each mint, about hourly, checks again.
    One mint at a time, so parallel reads on a cold cache share a token."""
    key = (installation, write)
    async with _minting:
        cached = _tokens.get(key)
        if cached and cached[1] - TOKEN_SLACK > datetime.now(UTC):
            return cached[0]
        minted = await _request(
            "POST",
            f"{API}/app/installations/{installation}/access_tokens",
            _app_jwt(app),
            json={"permissions": {"contents": "write" if write else "read", "metadata": "read"}},
        )
        if not isinstance(minted, dict):
            raise ReefRepoError(f"The Clawbits app is no longer installed on {repo}")
        reach = await _request(
            "GET", f"{API}/installation/repositories", minted["token"], params={"per_page": 2}
        )
        repos = reach["repositories"] if isinstance(reach, dict) else []
        names = [r["full_name"].lower() for r in repos]
        if names != [repo.lower()]:
            raise ReefRepoError(
                f"The Clawbits app on GitHub must reach {repo} alone: "
                "limit its installation to that one repository"
            )
        _tokens[key] = (minted["token"], datetime.fromisoformat(minted["expires_at"]))
        return minted["token"]


async def installation_for(app: ReefApp, repo: str) -> int | None:
    """The App's installation covering ``repo``, or ``None`` when it is not installed there."""
    found = await _request("GET", f"{API}/repos/{repo}/installation", _app_jwt(app))
    return found["id"] if isinstance(found, dict) else None


async def is_organization(owner: str) -> bool:
    found = await _request("GET", f"{API}/users/{owner}", None)
    return isinstance(found, dict) and found.get("type") == "Organization"


def manifest(owner: str, organization: bool, base: str, state: str) -> tuple[str, str]:
    """Where to POST the App's manifest, and the manifest: a private App that
    ``owner`` owns, reading and writing contents, with no webhook, returning to
    clawbits once it is created and once it is installed."""
    where = (
        f"https://github.com/organizations/{owner}/settings/apps/new"
        if organization
        else "https://github.com/settings/apps/new"
    )
    body = {
        "name": f"Clawbits {owner}"[:34],
        "url": base,
        "hook_attributes": {"url": base, "active": False},
        "redirect_url": f"{base}/api/auth/reef/github/created",
        "setup_url": f"{base}/api/auth/reef/github/installed",
        "public": False,
        "default_permissions": {"contents": "write", "metadata": "read"},
        "default_events": [],
    }
    return f"{where}?" + urllib.parse.urlencode({"state": state}), json.dumps(body)


async def create_app(code: str) -> tuple[ReefApp, str]:
    """Trade the code GitHub returns once the App exists for the App itself,
    and the login of the account that owns it. The code is the credential."""
    made = await _request(
        "POST", f"{API}/app-manifests/{urllib.parse.quote(code, safe='')}/conversions", None
    )
    if not isinstance(made, dict):
        raise ReefRepoError("GitHub no longer knows that app: start again")
    return ReefApp(id=made["id"], slug=made["slug"], key=made["pem"]), made["owner"]["login"]


def install_url(app: ReefApp, state: str) -> str:
    return f"https://github.com/apps/{app.slug}/installations/new?" + urllib.parse.urlencode(
        {"state": state}
    )


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
    """The fleet file that declares an agent, replaced only by its tombstone.
    Every value is validated by the caller against the patterns above, so plain
    quoting holds."""
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


def purge_toml(name: str) -> bytes:
    """The tombstone that replaces an agent's fleet file: the host deletes the
    agent with its volumes, and the name stays taken."""
    return f'version = 1\npurge = ["{name}"]\n'.encode()


def fleet_entry(name: str, raw: bytes) -> tuple[str, str, dict[str, str]] | None:
    """``(role, owner, env)`` of the agent a fleet file declares, or ``None``
    for a tombstone or anything else."""
    try:
        entry = tomllib.loads(raw.decode())["agents"][name]
        return entry["role"], entry["owner"], dict(entry.get("env", {}))
    except (UnicodeDecodeError, tomllib.TOMLDecodeError, KeyError, TypeError):
        return None


def fleet_name(agent_id: str) -> str:
    """An agent id fitted to reef's name rule: lowercased, underscores to
    hyphens, no trailing hyphen, and a letter first."""
    name = agent_id.lower().replace("_", "-").rstrip("-")
    return name if name[:1].isalpha() else f"a{name}"


def _normalize(url: str | None) -> str:
    return (url or "").strip().rstrip("/")
