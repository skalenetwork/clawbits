"""Real-Hermes harness: the Clawbits plugin under Hermes's own loader and GatewayRunner.

Run it through scripts/hermes_runtime_tests.sh, which provides the pinned Hermes venv.
HERMES_RUNTIME_LAYOUT picks the plugin layout: ``bundled`` (the Reef image: a read-only
bundled platform plus the image's managed config.yaml) or ``user`` (self-hosted: a user
plugin listed in plugins.enabled).
"""

from __future__ import annotations

import asyncio
import atexit
import contextlib
import importlib.util
import os
import re
import shutil
import sqlite3
import sys
import tempfile
import time
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

import pytest

HERMES = importlib.util.find_spec("hermes_cli") is not None
if not HERMES:  # the repo venv: collect nothing and leave its environment alone
    collect_ignore_glob = ["*"]
else:
    # Hermes reads HERMES_HOME at import time in places, and the caller's own Hermes or
    # Clawbits settings must not leak in: reset both before any Hermes import.
    for _name in list(os.environ):
        if _name.startswith(("HERMES_", "CLAWBITS_")) and not _name.startswith("HERMES_RUNTIME_"):
            del os.environ[_name]
    os.environ["HERMES_HOME"] = tempfile.mkdtemp(prefix="cb-hermes-boot-")
    atexit.register(shutil.rmtree, os.environ["HERMES_HOME"], ignore_errors=True)
    os.environ["HERMES_DISABLE_LAZY_INSTALLS"] = "1"
    import gateway.run  # noqa: F401

from fake_clawbits import MODEL, OPERATOR_DM, FakeClawbits  # noqa: E402

REPO = Path(__file__).resolve().parents[2]
PLUGIN_SRC = REPO / "extensions" / "hermes"
IMAGE_CONFIG = REPO / "images" / "hermes" / "config.yaml"
LAYOUT = os.getenv("HERMES_RUNTIME_LAYOUT", "bundled")
_IGNORE = shutil.ignore_patterns("__pycache__", "*.pyc")


def pytest_configure(config) -> None:
    if HERMES and LAYOUT not in ("bundled", "user"):
        raise pytest.UsageError(f"HERMES_RUNTIME_LAYOUT must be bundled or user, not {LAYOUT!r}")


def pytest_report_header(config) -> list[str]:
    """Record the Hermes rev/version, plugin version and layout under test."""
    if not HERMES:
        return []
    from hermes_cli import __version__ as hermes_version

    manifest = (PLUGIN_SRC / "plugin.yaml").read_text(encoding="utf-8")
    plugin_version = re.search(r"^version:\s*(\S+)", manifest, re.M).group(1)
    label = os.getenv("HERMES_RUNTIME_LABEL", "unpinned")
    rev = os.getenv("HERMES_RUNTIME_REV", "unknown")
    return [
        f"hermes: {label} {rev} (version {hermes_version})",
        f"clawbits plugin: {plugin_version}, layout: {LAYOUT}",
    ]


def _text(content: Any) -> str:
    """Flatten OpenAI message content (a string or a list of parts)."""
    if isinstance(content, list):
        return "".join(part.get("text", "") for part in content if isinstance(part, dict))
    return content or ""


def _merge(base: dict[str, Any], extra: dict[str, Any]) -> dict[str, Any]:
    out = dict(base)
    for key, value in extra.items():
        nested = isinstance(value, dict) and isinstance(out.get(key), dict)
        out[key] = _merge(out[key], value) if nested else value
    return out


class Gateway:
    """One GatewayRunner with the plugin, bound to a FakeClawbits; call it with a scenario."""

    def __init__(
        self, fake: FakeClawbits, home: Path, plugin_dir: Path, config: dict[str, Any]
    ) -> None:
        self.fake = fake
        self.home = home
        self.plugin_dir = plugin_dir
        self.config = config  # written to HERMES_HOME/config.yaml by every load_plugin/start
        self.runner: Any = None
        self.adapter: Any = None
        # Every MessageEvent a platform adapter passed to Hermes, less Hermes's restore replays.
        self.events: list[Any] = []

    def __call__(
        self,
        scenario: Callable[[Gateway], Awaitable[None]],
        *,
        config: dict[str, Any] | None = None,
    ) -> None:
        """Start, run one async scenario and always stop; config deep-merges into config.yaml.

        Every scenario also checks that the plugin never edited an already published post.
        """
        self.config = _merge(self.config, config or {})

        async def main() -> None:
            try:
                await self.start()
                await scenario(self)
            finally:
                await self.stop()

        asyncio.run(main())
        rejected = [
            c["path"] for c in self.fake.calls if c["method"] == "PATCH" and c.get("status") == 409
        ]
        assert not rejected, f"edits of published posts: {rejected}\n{self.dump()}"

    def load_plugin(self) -> Any:
        """Write config.yaml and load the plugin through Hermes's loader; its package module."""
        import yaml
        from gateway.platform_registry import platform_registry
        from hermes_cli.plugins import discover_plugins

        (self.home / "config.yaml").write_text(yaml.safe_dump(self.config), encoding="utf-8")
        discover_plugins(force=True)
        return sys.modules[platform_registry.get("clawbits").adapter_factory.__module__]

    async def start(self) -> None:
        """Start a GatewayRunner; wait for the first full poll and (if enabled) the WebSocket."""
        from gateway.config import Platform, load_gateway_config
        from gateway.run import GatewayRunner

        accepted = self.fake.ws_accepted
        self.load_plugin()
        self.runner = GatewayRunner(load_gateway_config())
        assert await self.runner.start(), "GatewayRunner.start() failed"
        self.adapter = self.runner.adapters.get(Platform("clawbits"))
        assert self.adapter is not None, f"no clawbits adapter among {list(self.runner.adapters)}"
        await self.wait_for(self.adapter._ready.is_set, 30)
        if self.fake.ws_enabled:
            await self.wait_for(lambda: self.fake.ws_accepted > accepted)

    async def stop(self) -> None:
        """Release held model responses, then stop the runner."""
        self.fake.release_model()
        if self.runner is not None:
            await self.runner.stop()
        self.runner = self.adapter = None

    async def restart(self) -> None:
        """Stop, then start on the same HERMES_HOME and fake (the catch-up path)."""
        await self.stop()
        await self.start()

    async def wait_for(self, predicate: Callable[[], Any], timeout: float = 15) -> None:
        """Poll a condition; fail with a dump of posts and model inputs."""
        deadline = time.monotonic() + timeout
        while not predicate():
            if time.monotonic() > deadline:
                raise AssertionError(f"condition not met within {timeout}s\n{self.dump()}")
            await asyncio.sleep(0.05)

    async def push_ws(self, event: dict[str, Any], timeout: float = 15) -> None:
        """Send one events WebSocket event once the adapter holds a socket (it may reconnect)."""
        await self.wait_for(lambda: self.fake.ws_connected, timeout)
        self.fake.push_ws(event)

    async def settled(self, post: dict[str, Any], timeout: float = 15) -> None:
        """Wait for the plugin's read ack of post (its turn completed) and an idle chat session."""
        channel = post["channel_id"]
        await self.wait_for(lambda: self.acked(post) and not self.busy(channel), timeout)

    def acked(self, post: dict[str, Any]) -> bool:
        """Whether the plugin's read ack covers post."""
        return self.fake.read_ptr.get(post["channel_id"], 0) >= post["post_id"]

    def busy(self, chat_id: str) -> bool:
        """Whether the adapter holds a session guard for chat_id (the ack lands just before)."""
        return any(f":{chat_id}:" in f"{key}:" for key in self.adapter._active_sessions)

    def replies(self, since: int = 0, channel: str | None = None) -> list[str]:
        """Agent-authored post bodies from fake.posts[since:]."""
        return [
            p["message"]
            for p in self.fake.posts[since:]
            if p["agent_id"] == self.fake.agent_id and not p.get("deleted")
            and channel in (None, p["channel_id"])
        ]

    def user_inputs(self) -> list[str]:
        """Last user message of each agent chat-completion request."""
        out = []
        for request in self.fake.agent_requests:
            users = [m for m in request.get("messages", []) if m.get("role") == "user"]
            out.append(_text(users[-1].get("content")) if users else "")
        return out

    def transcript(self) -> list[tuple[str, str]]:
        """(role, content) rows from HERMES_HOME/state.db messages."""
        return self.query("select role, content from messages order by id")

    def query(self, sql: str) -> list[tuple[Any, ...]]:
        """Rows of one read-only query against HERMES_HOME/state.db."""
        with contextlib.closing(sqlite3.connect(self.home / "state.db")) as db:
            return list(db.execute(sql))

    def sessions(self) -> int:
        """Number of sessions Hermes has recorded in state.db."""
        return self.query("select count(*) from sessions")[0][0]

    def tool_results(self, name: str) -> list[str]:
        """Tool results the model was sent for calls to tool ``name``, oldest first."""
        calls: set[str] = set()
        results: dict[str, str] = {}
        for request in self.fake.model_requests:
            for message in request.get("messages", []):
                for call in message.get("tool_calls") or []:
                    if call["function"]["name"] == name:
                        calls.add(call["id"])
                if message.get("role") == "tool" and message.get("tool_call_id") in calls:
                    results.setdefault(message["tool_call_id"], _text(message.get("content")))
        return list(results.values())

    def dump(self) -> str:
        posts = "\n".join(
            f"  {p['post_id']} {p['channel_id']} {p['agent_id'] or p['human_id']} {p['status']}: "
            f"{p['message'][:120]!r}"
            for p in self.fake.posts
        )
        inputs = "\n".join(f"  {text[:160]!r}" for text in self.user_inputs()[-5:])
        return f"posts:\n{posts}\nread_ptr: {self.fake.read_ptr}\nlast model inputs:\n{inputs}"


@pytest.fixture(scope="session")
def bundled_plugins(tmp_path_factory) -> Path:
    """Hermes's bundled plugins plus the Clawbits platform, read-only as the image bakes it."""
    from hermes_cli.plugins import get_bundled_plugins_dir

    bundled = tmp_path_factory.mktemp("hermes-install") / "plugins"
    shutil.copytree(get_bundled_plugins_dir(), bundled, ignore=_IGNORE)
    clawbits = bundled / "platforms" / "clawbits"
    shutil.copytree(PLUGIN_SRC, clawbits, ignore=_IGNORE)
    for path in [clawbits, *clawbits.rglob("*")]:
        path.chmod(path.stat().st_mode & ~0o222)
    return bundled


@pytest.fixture
def gateway(request, tmp_path, monkeypatch) -> Gateway:
    """A not-yet-started Gateway with its own HERMES_HOME, plugin layout and FakeClawbits.

    Configure ``gateway.fake`` (or extra environment via monkeypatch) first, then call
    ``gateway(scenario)``.
    """
    from gateway.platforms.base import BasePlatformAdapter

    fake = FakeClawbits()
    request.addfinalizer(fake.close)
    home = tmp_path / "home"
    home.mkdir()
    config: dict[str, Any] = {
        "model": {"default": MODEL, "provider": "custom", "base_url": f"{fake.base_url}/v1",
                  "api_key": "stub", "context_length": 65536},
        "auxiliary": {"title_generation": {"enabled": False}},
    }
    if LAYOUT == "user":
        plugin_dir = home / "plugins" / "clawbits-platform"
        shutil.copytree(PLUGIN_SRC, plugin_dir, ignore=_IGNORE)
        config["plugins"] = {"enabled": ["clawbits-platform"]}
    else:
        bundled = request.getfixturevalue("bundled_plugins")
        plugin_dir = bundled / "platforms" / "clawbits"
        managed = tmp_path / "etc-hermes"
        managed.mkdir()
        shutil.copy(IMAGE_CONFIG, managed / "config.yaml")
        monkeypatch.setenv("HERMES_BUNDLED_PLUGINS", str(bundled))
        monkeypatch.setenv("HERMES_MANAGED_DIR", str(managed))
    # A throwaway HOME: provider discovery (e.g. /model) must not find, or try to refresh,
    # credentials the developer's own tools keep there.
    (tmp_path / "user-home").mkdir()
    for name, value in {
        "HOME": str(tmp_path / "user-home"),
        "HERMES_HOME": str(home),
        "CLAWBITS_API_KEY": "cb-test-key",
        "CLAWBITS_AGENT_ID": fake.agent_id,
        "CLAWBITS_ENDPOINT": fake.base_url,
        "CLAWBITS_CHANNEL_ID": OPERATOR_DM,
        "CLAWBITS_POLL_INTERVAL": "0.1",
        "CLAWBITS_EMAIL_ENABLED": "false",
    }.items():
        monkeypatch.setenv(name, value)

    gw = Gateway(fake, home, plugin_dir, config)
    handle_message = BasePlatformAdapter.handle_message

    async def spy(adapter, event):
        # Hermes's startup-restore drain re-submits a queued event it has marked as a replay.
        if not getattr(event, "_hermes_startup_restore_replay", False):
            gw.events.append(event)
        return await handle_message(adapter, event)

    monkeypatch.setattr(BasePlatformAdapter, "handle_message", spy)
    return gw
