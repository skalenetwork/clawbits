"""Stub ``gateway.*`` modules, the plugin loader and a fake Clawbits HTTP API shared by the poc tests.

These fakes stand in for Hermes so the plugin can be unit-tested without a real
runtime; tests/hermes_runtime covers the real gateway.
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
import os
import sys
import threading
import time
import types
import urllib.parse
from dataclasses import dataclass, field
from enum import Enum
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


@dataclass
class _FakePlatformConfig:
    api_key: str | None = None
    token: str | None = None
    extra: dict[str, Any] | None = None


class _FakePlatform(str):
    pass


class _FakeProcessingOutcome(Enum):
    SUCCESS = "success"
    FAILURE = "failure"
    CANCELLED = "cancelled"


class _FakeBasePlatformAdapter:
    """``handle_message`` enqueues the turn like the gateway does: a background
    task brackets the overridable ``turn`` with the processing hooks."""

    def __init__(self, config: _FakePlatformConfig, platform: _FakePlatform) -> None:
        self.config = config
        self.platform = platform
        self._running = False
        self.events: list[Any] = []
        self.tasks: list[asyncio.Task[None]] = []

    def _set_fatal_error(self, code: str, message: str, *, retryable: bool) -> None:
        self._running = False
        self.fatal_error = (code, message, retryable)

    def set_status_text(self, chat_id: str, text: str | None) -> None:
        pass

    async def handle_message(self, event: Any) -> None:
        self.events.append(event)
        self.tasks.append(asyncio.create_task(self._process(event)))

    async def _process(self, event: Any) -> None:
        await self.on_processing_start(event)
        try:
            outcome = await self.turn(event)
        except Exception:
            outcome = _FakeProcessingOutcome.FAILURE
        await self.on_processing_complete(event, outcome)

    async def turn(self, event: Any) -> Any:
        return _FakeProcessingOutcome.SUCCESS

    async def on_processing_start(self, event: Any) -> None:
        pass

    async def on_processing_complete(self, event: Any, outcome: Any) -> None:
        pass


class _FakeMessageType:
    TEXT = "text"
    PHOTO = "photo"
    VIDEO = "video"
    AUDIO = "audio"
    DOCUMENT = "document"


@dataclass
class _FakeSendResult:
    success: bool
    message_id: str | None = None
    raw_response: Any = None
    error: str | None = None
    retryable: bool = False


@dataclass
class _FakeMessageEvent:
    text: str
    message_type: Any = "text"
    source: Any = None
    raw_message: Any = None
    message_id: str | None = None
    media_urls: list[str] = field(default_factory=list)
    media_types: list[str] = field(default_factory=list)
    ledger_message_id: str | None = None
    channel_prompt: str | None = None
    channel_context: str | None = None
    internal: bool = False
    metadata: dict[str, Any] = field(default_factory=dict)
    allow_gateway_control: bool = True

    # Copied from gateway/platforms/event.py (MessageEvent.is_command/get_command).
    def is_command(self) -> bool:
        return self.allow_gateway_control and (self.text or "").lstrip().startswith("/")

    def get_command(self) -> str | None:
        if not self.is_command():
            return None
        raw = (self.text or "").lstrip().split(maxsplit=1)[0][1:].lower().split("@", 1)[0]
        return None if "/" in raw else raw


# A subset of Hermes's built-in gateway commands (hermes_cli/commands.py registry).
_NATIVE_COMMANDS = frozenset({"stop", "new", "reset", "usage", "model", "approve", "deny", "help", "status"})


def _resolve_command(name: str) -> str | None:
    key = name.lower().lstrip("/")
    return key if key in _NATIVE_COMMANDS else None


def _process_hermes_home() -> Path:
    return Path(os.path.expanduser(os.environ.get("HERMES_HOME") or "~/.hermes"))


def _module(name: str, **attrs: Any) -> types.ModuleType:
    module = types.ModuleType(name)
    module.__dict__.update(attrs)
    sys.modules[name] = module
    return module


def _install_hermes_runtime_stubs() -> None:
    """hermes_cli.commands, hermes_constants, agent.secret_scope and gateway.platforms._shared.

    Unscoped, non-multiplexed semantics: the home is HERMES_HOME, there is no
    override or secret scope, and scoped reads fall through to os.environ.
    No ``agent.redact`` stub, so redaction fails closed unless a test adds one.
    """
    commands = _module("hermes_cli.commands", resolve_command=_resolve_command)
    _module("hermes_cli", commands=commands)
    constants = _module(
        "hermes_constants",
        get_hermes_home_override=lambda: None,
        get_process_hermes_home=_process_hermes_home,
    )
    constants.get_hermes_home = lambda: Path(constants.get_hermes_home_override() or _process_hermes_home())
    constants.hermes_home_key = lambda path=None: str(
        Path(path if path is not None else constants.get_hermes_home()).expanduser().resolve()
    )
    secret_scope = _module("agent.secret_scope", current_secret_scope=lambda: None)
    _module("agent", secret_scope=secret_scope)
    _module("gateway.platforms._shared", get_scoped_secret=lambda name, default=None, **_: os.environ.get(name, default))


@dataclass
class _FakeSessionSource:
    platform: Any
    chat_id: str
    chat_name: str | None = None
    chat_type: str | None = None
    user_id: str | None = None
    user_name: str | None = None
    message_id: str | None = None


def _load_hermes_module():
    sys.modules["gateway"] = types.ModuleType("gateway")
    config = types.ModuleType("gateway.config")
    config.Platform = _FakePlatform
    config.PlatformConfig = _FakePlatformConfig
    sys.modules["gateway.config"] = config

    platforms = types.ModuleType("gateway.platforms")
    sys.modules["gateway.platforms"] = platforms
    base = types.ModuleType("gateway.platforms.base")
    base.BasePlatformAdapter = _FakeBasePlatformAdapter
    base.MessageEvent = _FakeMessageEvent
    base.MessageType = _FakeMessageType
    base.SendResult = _FakeSendResult
    base.ProcessingOutcome = _FakeProcessingOutcome
    sys.modules["gateway.platforms.base"] = base

    session = types.ModuleType("gateway.session")
    session.SessionSource = _FakeSessionSource
    sys.modules["gateway.session"] = session
    _install_hermes_runtime_stubs()

    # Load the plugin the way the Hermes loader does (hermes_cli/plugins.py):
    # as a real PACKAGE with submodule_search_locations, so the plugin's
    # relative imports (.adapter, .messages, …) resolve. Purge any prior load
    # first — stale submodule entries would otherwise be silently reused.
    plugin_dir = Path(__file__).resolve().parents[2] / "extensions" / "hermes"
    for name in [m for m in sys.modules if m == "hermes_clawbits_test" or m.startswith("hermes_clawbits_test.")]:
        del sys.modules[name]
    spec = importlib.util.spec_from_file_location(
        "hermes_clawbits_test",
        plugin_dir / "__init__.py",
        submodule_search_locations=[str(plugin_dir)],
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


async def _drain(adapter) -> None:
    """Finish the turns handle_message enqueued."""
    await asyncio.gather(*[task for task in adapter.tasks if not task.done()])
    adapter.tasks.clear()


def _event(message_id: str, chat_id: str = "chan", **raw: Any) -> _FakeMessageEvent:
    return _FakeMessageEvent(
        text="hi",
        message_type="text",
        source=_FakeSessionSource(platform="clawbits", chat_id=chat_id),
        raw_message=raw,
        message_id=message_id,
    )


CHALLENGE_TOKEN = "st-challenge"


class _FakeClawbitsApi:
    """Recording fake of the Clawbits agent HTTP API, for tests that run the real agent CLI.

    Every request lands in ``requests`` as {method, path, query, headers, body}.
    ``respond`` scripts a (status, JSON body) per method and path; anything else
    gets 200 ``{"ok": true}``. ``gate`` (when set) holds each non-challenge
    request until it is released, and ``delay`` slows every response.
    """

    def __init__(self) -> None:
        self.requests: list[dict[str, Any]] = []
        self.responses: dict[tuple[str, str], tuple[int, Any]] = {}
        self.gate: threading.Event | None = None
        self.delay = 0.0
        api = self

        class Handler(BaseHTTPRequestHandler):
            def _handle(self) -> None:
                url = urllib.parse.urlsplit(self.path)
                raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
                try:
                    body: Any = json.loads(raw) if raw else None
                except ValueError:
                    body = raw.decode("utf-8", "replace")
                api.requests.append({
                    "method": self.command,
                    "path": url.path,
                    "query": dict(urllib.parse.parse_qsl(url.query)),
                    "headers": {k.lower(): v for k, v in self.headers.items()},
                    "body": body,
                })
                if url.path == "/api/agentic/auth/challenge":
                    status, reply = 200, {"session_token": CHALLENGE_TOKEN, "challenge": "q"}
                else:
                    if api.gate is not None:
                        api.gate.wait(10)
                    time.sleep(api.delay)
                    status, reply = api.responses.get((self.command, url.path), (200, {"ok": True}))
                data = json.dumps(reply).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            do_GET = do_POST = do_PATCH = do_PUT = do_DELETE = _handle

            def log_message(self, *args: Any) -> None:
                pass

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._server.daemon_threads = True
        self.base_url = f"http://127.0.0.1:{self._server.server_address[1]}"
        threading.Thread(target=self._server.serve_forever, daemon=True).start()

    def respond(self, method: str, path: str, status: int, body: Any) -> None:
        """Script the reply for one method and path."""
        self.responses[(method, path)] = (status, body)

    def writes(self) -> list[dict[str, Any]]:
        """Requests other than the challenge fetch."""
        return [r for r in self.requests if r["path"] != "/api/agentic/auth/challenge"]

    def close(self) -> None:
        if self.gate is not None:
            self.gate.set()
        self._server.shutdown()
        self._server.server_close()
