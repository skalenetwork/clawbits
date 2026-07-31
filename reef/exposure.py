"""The exposure seam: HOW an exposed agent's Control UI is reached.

- ``DirectPortExposure`` (local dev): a forwarded loopback host port →
  ``http://localhost:<port>``. No proxy / DNS / TLS; ``publish``/``unpublish``
  are no-ops.
- ``SubdomainProxyExposure`` (prod): an nginx wildcard route
  ``https://<hash>.<base_domain>`` → the same forwarded loopback port. The hash
  is a deterministic, unguessable digest of the sandbox id (stable across
  restarts, no extra state). ``publish`` writes a per-agent server block and
  reloads nginx; ``unpublish`` removes it.

Chosen by config (``REEF_BASE_DOMAIN`` set ⇒ proxy, else direct — see
``reef.runtime_factory.make_exposure``). The agent's in-guest UI port comes
from the profile (``AgentProfile.ui_port``), so strategies stay agent-agnostic.
"""

import hashlib
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from reef._subprocess import Runner, _default_runner
from reef.errors import RuntimeUnavailable


def surface_digest(secret: str, sandbox_id: str, surface: str = "ui") -> str:
    """Deterministic, unguessable name for one agent surface: the subdomain in
    ``SubdomainProxyExposure`` and the path segment in the API's surface proxy
    (``/s/<digest>/`` — see ``reef.api.proxy``). The Control UI keeps the bare
    digest (stable / backward-compatible); any other surface (the terminal)
    folds its name in for a distinct digest."""
    key = f"{secret}:{sandbox_id}"
    if surface != "ui":
        key = f"{key}:{surface}"
    return hashlib.sha256(key.encode()).hexdigest()[:32]


@dataclass(frozen=True, slots=True)
class Exposure:
    """Result of exposing an agent: where to reach it + optional one-time secret.

    ``password`` is empty when the profile has no static password, or when
    reusing an already-exposed agent — secrets are issued only at creation,
    never persisted.
    """

    sandbox_id: str
    url: str
    port: int
    password: str
    terminal_url: str | None = None  # scoped web-terminal URL (shares the password); None if none


class ExposureStrategy(Protocol):
    def forward(self, port: int, guest_port: int) -> str:
        """The ``-p`` forward spec: host ``port`` → ``guest_port``."""
        ...

    def url_for(self, sandbox_id: str, port: int, *, surface: str = "ui") -> str:
        """The public URL the user opens. Pure — computed before the agent boots
        (it feeds the agent's ``OPENCLAW_PUBLIC_URL``). ``surface`` ("ui" |
        "terminal" | …) lets one agent expose several ports under distinct routes."""
        ...

    async def publish(self, sandbox_id: str, port: int, *, surface: str = "ui") -> None:
        """Register/refresh the route to one agent surface (no-op when there's no proxy)."""
        ...

    async def unpublish(self, sandbox_id: str) -> None:
        """Remove ALL of the agent's routes (no-op when there's no proxy). Idempotent."""
        ...


class DirectPortExposure:
    """Local dev: forward a loopback host port straight to the guest gateway."""

    def __init__(self, bind: str = "127.0.0.1") -> None:
        self.bind = bind

    def forward(self, port: int, guest_port: int) -> str:
        return f"{self.bind}:{port}:{guest_port}"

    def url_for(self, sandbox_id: str, port: int, *, surface: str = "ui") -> str:
        # Use the loopback IP, not "localhost": the runtime publishes the port on
        # 127.0.0.1 (IPv4), but browsers often resolve "localhost" to ::1 (IPv6),
        # where nothing listens → the tab hangs. The host port already distinguishes
        # surfaces, so the URL is the same for ui/terminal.
        host = "127.0.0.1" if self.bind in ("0.0.0.0", "::", "") else self.bind
        return f"http://{host}:{port}"

    async def publish(self, sandbox_id: str, port: int, *, surface: str = "ui") -> None:
        return None  # nothing fronts the port locally

    async def unpublish(self, sandbox_id: str) -> None:
        return None


class SubdomainProxyExposure:
    """Prod: front each agent with an nginx wildcard subdomain over TLS.

    Each agent gets ``https://<hash>.<base_domain>`` where ``<hash>`` is a
    deterministic digest of the sandbox id (+ an optional server secret) — stable
    and unguessable, with no persisted state. ``publish`` writes a per-agent
    server block into ``nginx_dir`` (included by the base nginx config) and
    reloads; ``unpublish`` removes it. The base wildcard server, the
    ``*.<base_domain>`` cert (Let's Encrypt DNS-01), and DNS are host setup — see
    ``nginx/reef-base.conf.example``.
    """

    def __init__(
        self,
        base_domain: str,
        *,
        nginx_dir: str = "/etc/nginx/reef.d",
        tls_cert: str | None = None,
        tls_key: str | None = None,
        reload_cmd: Sequence[str] = ("nginx", "-s", "reload"),
        secret: str = "",
        target_host: str = "127.0.0.1",
        runner: Runner | None = None,
    ) -> None:
        self.base_domain = base_domain.strip(".")
        self._dir = Path(nginx_dir)
        self._cert = tls_cert
        self._key = tls_key
        self._reload_cmd = list(reload_cmd)
        self._secret = secret
        self._target = target_host
        self._run = runner or _default_runner

    def subdomain(self, sandbox_id: str, surface: str = "ui") -> str:
        return surface_digest(self._secret, sandbox_id, surface)

    def forward(self, port: int, guest_port: int) -> str:
        return f"{self._target}:{port}:{guest_port}"

    def url_for(self, sandbox_id: str, port: int, *, surface: str = "ui") -> str:
        return f"https://{self.subdomain(sandbox_id, surface)}.{self.base_domain}"

    def _conf_path(self, sandbox_id: str, surface: str = "ui") -> Path:
        # '@' is not a legal sandbox-id char (fleet._NAME_RE), so '<id>@<surface>.conf'
        # can never collide with another agent's '<id>.conf'.
        name = sandbox_id if surface == "ui" else f"{sandbox_id}@{surface}"
        return self._dir / f"{name}.conf"

    def _render(self, sandbox_id: str, port: int, surface: str = "ui") -> str:
        host = f"{self.subdomain(sandbox_id, surface)}.{self.base_domain}"
        tls = ""
        if self._cert and self._key:
            tls = f"    ssl_certificate {self._cert};\n    ssl_certificate_key {self._key};\n"
        return (
            f"# reef agent: {sandbox_id}\n"
            "server {\n"
            "    listen 443 ssl;\n"
            f"    server_name {host};\n"
            f"{tls}"
            "    location / {\n"
            f"        proxy_pass http://{self._target}:{port};\n"
            "        proxy_http_version 1.1;\n"
            "        proxy_set_header Host $host;\n"
            "        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n"
            "        proxy_set_header X-Forwarded-Proto https;\n"
            "        proxy_set_header Upgrade $http_upgrade;\n"
            '        proxy_set_header Connection "upgrade";\n'
            "        proxy_read_timeout 3600s;\n"
            "    }\n"
            "}\n"
        )

    async def publish(self, sandbox_id: str, port: int, *, surface: str = "ui") -> None:
        self._dir.mkdir(parents=True, exist_ok=True)
        self._conf_path(sandbox_id, surface).write_text(self._render(sandbox_id, port, surface))
        await self._reload()

    async def unpublish(self, sandbox_id: str) -> None:
        # Remove every surface registered for this agent (Control UI + terminal, …).
        removed = False
        for path in (self._conf_path(sandbox_id), *self._dir.glob(f"{sandbox_id}@*.conf")):
            if path.exists():
                path.unlink()
                removed = True
        if removed:
            await self._reload()

    async def _reload(self) -> None:
        rc, out, err = await self._run(self._reload_cmd)
        if rc != 0:
            raise RuntimeUnavailable(f"nginx reload failed (rc={rc}): {err.strip() or out.strip()}")
