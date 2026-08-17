from __future__ import annotations

import asyncio
import hashlib
import importlib.util
import sys
import types
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass
class _FakePlatformConfig:
    api_key: str | None = None
    token: str | None = None
    extra: dict[str, Any] | None = None


class _FakePlatform(str):
    pass


class _FakeBasePlatformAdapter:
    def __init__(self, config: _FakePlatformConfig, platform: _FakePlatform) -> None:
        self.config = config
        self.platform = platform
        self._running = False
        self.events: list[Any] = []

    async def handle_message(self, event: Any) -> None:
        self.events.append(event)


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
    message_type: Any
    source: Any
    raw_message: Any
    message_id: str
    media_urls: list[str] = field(default_factory=list)
    media_types: list[str] = field(default_factory=list)


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
    sys.modules["gateway.platforms.base"] = base

    session = types.ModuleType("gateway.session")
    session.SessionSource = _FakeSessionSource
    sys.modules["gateway.session"] = session

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


def test_post_id_and_cursor_handle_clawbits_shape() -> None:
    mod = _load_hermes_module()
    first = {"post_id": 41, "created_at": "2026-06-04 12:00:00"}
    second = {"post_id": 42, "created_at": "2026-06-04 12:00:00"}

    assert mod._post_id(first) == "41"
    assert mod._post_cursor_key(second) > mod._post_cursor_key(first)
    assert mod._parent_post_id_from_metadata({"raw_message": {"post_id": 41}}, None) == 41


def test_post_message_preserves_reply_and_trace() -> None:
    mod = _load_hermes_module()

    class Recorder(mod._ClawbitsCli):
        def _run(self, *args: str) -> Any:
            self.args = args
            return {"post_id": 7}

    cli = Recorder("cli.py", "http://x", "key")
    raw = cli.post_message("chan", "hello", 123, "tr_abc")

    assert raw == {"post_id": 7}
    assert cli.args[:3] == ("mm-post", "chan", "--json")
    assert '"parent_post_id": 123' in cli.args[3]
    assert '"trace_id": "tr_abc"' in cli.args[3]


def test_poll_dispatches_same_second_post_ids_after_seed() -> None:
    mod = _load_hermes_module()

    class FakeClient:
        def __init__(self) -> None:
            self.calls = 0

        def list_channels(self) -> list[Any]:
            return [mod._Channel("chan", "direct", "Chat")]

        def get_posts(self, channel_id: str) -> list[dict[str, Any]]:
            self.calls += 1
            if self.calls == 1:
                return [{"post_id": 1, "created_at": "2026-06-04 12:00:00", "message": "old", "human_id": 1}]
            return [
                {"post_id": 2, "created_at": "2026-06-04 12:00:01", "message": "a", "human_id": 1},
                {"post_id": 3, "created_at": "2026-06-04 12:00:01", "message": "b", "human_id": 1},
            ]

        def set_status(self, channel_id: str, status: str) -> None:
            pass

    cfg = _FakePlatformConfig(extra={"api_key": "key", "agent_id": "agent"})
    adapter = mod.ClawbitsAdapter(cfg)
    adapter.client = FakeClient()

    async def poll_and_drain() -> None:
        # Turns are spawned as background tasks (non-blocking dispatch);
        # drain them so the events are visible to the assertions.
        await adapter._poll_once()
        if adapter._turn_tasks:
            await asyncio.gather(*adapter._turn_tasks)

    asyncio.run(poll_and_drain())
    assert adapter.events == []

    asyncio.run(poll_and_drain())
    # Each turn is fronted by the Clawbits context block (parity with the
    # OpenClaw plugin), so assert on the trailing message text.
    assert [event.text.rsplit("\n\n", 1)[-1] for event in adapter.events] == ["a", "b"]
    assert all(e.text.startswith("[Clawbits context]") for e in adapter.events)


def test_poll_keeps_receiving_while_a_turn_is_blocked() -> None:
    """Deadlock regression: the hermes gateway resolves clarify answers via
    the same inbound path, so the poll loop must keep dispatching while an
    earlier turn is still running. A blocked turn used to freeze the poll
    loop, so the answer it waited for could never arrive."""
    mod = _load_hermes_module()

    class FakeClient:
        def __init__(self) -> None:
            self.calls = 0

        def list_channels(self) -> list[Any]:
            return [mod._Channel("chan", "direct", "Chat")]

        def get_posts(self, channel_id: str) -> list[dict[str, Any]]:
            self.calls += 1
            if self.calls == 1:
                return []  # seed pass
            if self.calls == 2:
                return [{"post_id": 1, "created_at": "2026-06-04 12:00:01", "message": "question", "human_id": 1}]
            return [
                {"post_id": 1, "created_at": "2026-06-04 12:00:01", "message": "question", "human_id": 1},
                {"post_id": 2, "created_at": "2026-06-04 12:00:02", "message": "answer", "human_id": 1},
            ]

        def set_status(self, channel_id: str, status: str) -> None:
            pass

    cfg = _FakePlatformConfig(extra={"api_key": "key", "agent_id": "agent"})
    adapter = mod.ClawbitsAdapter(cfg)
    adapter.client = FakeClient()

    async def scenario() -> list[str]:
        unblock = asyncio.Event()
        handled: list[str] = []

        async def blocking_handle(event: Any) -> None:
            # The prompt is now fronted by the Clawbits context block; the
            # message itself is the trailing paragraph.
            message = event.text.rsplit("\n\n", 1)[-1]
            handled.append(message)
            if message == "question":
                await unblock.wait()  # the "clarify" park: turn 1 waits
            elif message == "answer":
                unblock.set()  # the answer is what unblocks turn 1

        adapter.handle_message = blocking_handle
        await adapter._poll_once()  # seed cursors
        await adapter._poll_once()  # dispatches "question" (parks)
        # The poll loop must still be able to run and deliver the answer.
        await asyncio.wait_for(adapter._poll_once(), timeout=2)
        await asyncio.wait_for(asyncio.gather(*adapter._turn_tasks), timeout=2)
        return handled

    handled = asyncio.run(scenario())
    assert handled == ["question", "answer"]
    assert not adapter._turn_tasks


def test_first_poll_greets_once_and_unblocks_liveness(monkeypatch, tmp_path) -> None:
    """The first FULL poll pass greets the operator channel (once ever, marker-
    persisted) and only then sets ``_ready`` — the gate the liveness loop waits
    on, so the wizard's "available" implies greeted + cursor-seeded."""
    mod = _load_hermes_module()

    hermes_constants = types.ModuleType("hermes_constants")
    hermes_constants.get_hermes_home = lambda: str(tmp_path)
    monkeypatch.setitem(sys.modules, "hermes_constants", hermes_constants)

    class FakeClient:
        def __init__(self) -> None:
            self.greetings: list[tuple[str, str]] = []

        def list_channels(self) -> list[Any]:
            return [mod._Channel("chan", "direct", "Chat")]

        def get_posts(self, channel_id: str) -> list[dict[str, Any]]:
            return []

        def agent_info(self, agent_id: str) -> dict[str, Any]:
            return {"operator_display_name": "Mr L", "org_id": "org-1"}

        def post_message(self, channel_id, content, parent_post_id=None, trace_id=None, file_ids=None):
            self.greetings.append((channel_id, content))

    cfg = _FakePlatformConfig(extra={"api_key": "key", "agent_id": "agent", "channel_id": "chan"})
    adapter = mod.ClawbitsAdapter(cfg)
    adapter.client = FakeClient()

    assert not adapter._ready.is_set()
    asyncio.run(adapter._poll_once())
    assert adapter.client.greetings == [("chan", "Hi Mr L! Agent agent reporting in for org-1.")]
    assert adapter._ready.is_set()
    assert (tmp_path / ".clawbits_greeted").exists()

    # Second pass: already ready, no re-greet.
    asyncio.run(adapter._poll_once())
    assert len(adapter.client.greetings) == 1

    # Fresh gateway boot (new adapter, same HERMES_HOME): marker suppresses it.
    adapter2 = mod.ClawbitsAdapter(cfg)
    adapter2.client = FakeClient()
    asyncio.run(adapter2._poll_once())
    assert adapter2.client.greetings == []
    assert adapter2._ready.is_set()


def test_split_message_chunks_boundaries() -> None:
    mod = _load_hermes_module()
    assert mod._split_message_chunks("") == []
    assert mod._split_message_chunks("   ") == []
    assert mod._split_message_chunks("short") == ["short"]

    # Prefers newline/space boundaries; every chunk stays within the cap and
    # no content is lost (modulo the whitespace consumed at cut points).
    text = "line one two three\n" * 40
    chunks = mod._split_message_chunks(text, limit=100)
    assert len(chunks) > 1
    assert all(len(c) <= 100 for c in chunks)
    squash = lambda s: s.replace("\n", "").replace(" ", "")  # noqa: E731
    assert squash("".join(chunks)) == squash(text)

    # Pathological unbroken run: hard cut, nothing dropped.
    chunks = mod._split_message_chunks("a" * 9001, limit=4000)
    assert [len(c) for c in chunks] == [4000, 4000, 1001]


def test_reject_private_host_blocks_internal_addresses() -> None:
    import pytest

    mod = _load_hermes_module()
    for url in (
        "http://127.0.0.1/x.png",
        "http://169.254.169.254/latest/meta-data/",
        "http://10.0.0.8/i.png",
        "http://192.168.1.20:8188/view?filename=gen.png",
        "http://[::1]/x.png",
        "http://0.0.0.0/x.png",
    ):
        with pytest.raises(ValueError):
            mod._reject_private_host(url)


def test_reject_private_host_resolution_and_allowlist(monkeypatch) -> None:
    import socket

    import pytest

    mod = _load_hermes_module()
    # Public IP literal passes without touching DNS.
    mod._reject_private_host("https://93.184.216.34/img.png")

    private_info = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("192.168.1.5", 0))]
    public_info = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 0))]

    # A hostname resolving to a private address is blocked...
    monkeypatch.setattr(socket, "getaddrinfo", lambda host, port, **kw: private_info)
    with pytest.raises(ValueError):
        mod._reject_private_host("http://imgbox.internal/i.png")

    # ...unless the operator allowlisted the host explicitly.
    monkeypatch.setenv("CLAWBITS_IMAGE_ALLOW_PRIVATE_HOSTS", "imgbox.internal")
    mod._reject_private_host("http://imgbox.internal/i.png")
    monkeypatch.delenv("CLAWBITS_IMAGE_ALLOW_PRIVATE_HOSTS")

    # A hostname resolving publicly passes.
    monkeypatch.setattr(socket, "getaddrinfo", lambda host, port, **kw: public_info)
    mod._reject_private_host("http://example.com/i.png")


def test_upload_and_post_image_splits_long_caption() -> None:
    mod = _load_hermes_module()

    class FakeClient:
        def __init__(self) -> None:
            self.posts: list[tuple[str, list[str] | None]] = []
            self.uploaded: tuple[str, str, str | None] | None = None

        def upload_file(self, channel_id: str, path: str, content_type: str | None = None) -> str:
            self.uploaded = (channel_id, path, content_type)
            return "file-1"

        def post_message(self, channel_id, content, parent_post_id=None, trace_id=None, file_ids=None):
            self.posts.append((content, file_ids))
            return {"post_id": len(self.posts)}

        def set_status(self, channel_id: str, status: str) -> None:
            pass

    cfg = _FakePlatformConfig(extra={"api_key": "key", "agent_id": "agent"})
    adapter = mod.ClawbitsAdapter(cfg)
    adapter.client = FakeClient()

    caption = "word " * 1200  # ~6000 chars, over the 4000 post cap
    result = asyncio.run(
        adapter._upload_and_post_image(
            "chan", "/tmp/x.png", caption, {}, None, content_type="image/png"
        )
    )
    assert result.success
    assert adapter.client.uploaded == ("chan", "/tmp/x.png", "image/png")
    posts = adapter.client.posts
    assert len(posts) >= 2
    assert posts[0][1] == ["file-1"], "image rides the first chunk"
    assert all(fids is None for _, fids in posts[1:]), "overflow chunks are plain posts"
    assert all(len(content) <= 4000 for content, _ in posts)
    # The image-bearing post is the send's handle, not the last overflow chunk.
    assert result.raw_response == {"post_id": 1}


def test_generating_status_heartbeats_through_the_turn(monkeypatch) -> None:
    """The 'generating' pill is re-asserted during a slow turn, not just once.

    The presence status has a ~15s server TTL; a single set at turn start
    lapses mid-turn on a slow model/tool call. The adapter must heartbeat it
    for the turn's duration and settle on 'online' afterwards.
    """
    mod = _load_hermes_module()
    # Patch the ADAPTER submodule's global — that's what _generating_heartbeat
    # reads; the package-level name is only a compatibility re-export.
    monkeypatch.setattr(mod.adapter, "GENERATING_HEARTBEAT_INTERVAL_SECONDS", 0.01)

    class FakeClient:
        def __init__(self) -> None:
            self.statuses: list[str] = []

        def set_status(self, channel_id: str, status: str) -> None:
            self.statuses.append(status)

    cfg = _FakePlatformConfig(extra={"api_key": "key", "agent_id": "agent"})
    adapter = mod.ClawbitsAdapter(cfg)
    adapter.client = FakeClient()

    async def slow_turn(event: object) -> None:
        await asyncio.sleep(0.05)  # ~5 heartbeat intervals

    adapter.handle_message = slow_turn  # type: ignore[assignment,method-assign]

    channel = mod._Channel("chan", "direct", "Chat")
    post = {"post_id": 5, "created_at": "2026-06-04 12:00:01", "message": "hi", "human_id": 1}

    async def dispatch_and_drain() -> None:
        # Dispatch spawns the turn as a background task; drain it so the
        # status sequence is complete before asserting.
        await adapter._maybe_dispatch(channel, post)
        await asyncio.gather(*adapter._turn_tasks)

    asyncio.run(dispatch_and_drain())

    statuses = adapter.client.statuses
    assert statuses, "expected status updates"
    assert statuses[0] == "generating", statuses
    assert statuses.count("generating") >= 2, f"heartbeat should renew generating: {statuses}"
    assert statuses[-1] == "online", statuses


def test_seen_dedupe_window_is_capped_and_evicts_oldest(monkeypatch) -> None:
    """``self._seen`` is a bounded FIFO, not an unbounded set: past the cap the
    oldest ids are evicted so a long-lived agent's memory can't grow forever.
    Eviction is safe because the per-channel cursor still blocks old posts."""
    mod = _load_hermes_module()
    # Patch the ADAPTER submodule's global — that's what _remember reads; the
    # package-level name is only a compatibility re-export.
    monkeypatch.setattr(mod.adapter, "_SEEN_CAP", 3)

    cfg = _FakePlatformConfig(extra={"api_key": "key", "agent_id": "agent"})
    adapter = mod.ClawbitsAdapter(cfg)

    for pid in ("p1", "p2", "p3", "p4"):
        adapter._remember(pid)
    # Cap of 3: the oldest ("p1") is evicted, insertion order preserved.
    assert list(adapter._seen) == ["p2", "p3", "p4"]
    assert "p1" not in adapter._seen
    # Membership still works and re-remembering is a no-op (no growth/reorder).
    assert "p3" in adapter._seen
    adapter._remember("p3")
    assert list(adapter._seen) == ["p2", "p3", "p4"]


def test_mention_regex_respects_word_boundaries() -> None:
    """The @mention matcher must not fire on an id that is merely a PREFIX of a
    longer id: ``@agent_1`` must not match inside ``@agent_12``."""
    mod = _load_hermes_module()
    cfg = _FakePlatformConfig(extra={"api_key": "key", "agent_id": "agent_1"})
    adapter = mod.ClawbitsAdapter(cfg)

    assert adapter._mention_re.search("hey @agent_12 there") is None
    assert adapter._mention_re.search("hey @agent_1 there") is not None
    assert adapter._mention_re.search("email me@agent_1.example") is None
    # Stripping removes the token(s) and collapses the gap; newlines survive.
    assert adapter._strip_self_mentions("hey @agent_1 how are you") == "hey how are you"
    assert adapter._strip_self_mentions("@agent_1 hello") == "hello"
    assert adapter._strip_self_mentions("thanks @agent_1") == "thanks"
    assert adapter._strip_self_mentions("@agent_1 @agent_1 hi") == "hi"


def test_channel_dispatch_strips_mention_but_keeps_raw() -> None:
    """In a shared channel, a real @mention dispatches with the token stripped
    from the model-facing text (raw_message stays untouched); a mention of a
    different, prefix-overlapping id does NOT dispatch."""
    mod = _load_hermes_module()

    class FakeClient:
        def set_status(self, channel_id: str, status: str) -> None:
            pass

    cfg = _FakePlatformConfig(extra={"api_key": "key", "agent_id": "agent_1"})
    adapter = mod.ClawbitsAdapter(cfg)
    adapter.client = FakeClient()
    channel = mod._Channel("chan", "channel", "General")  # non-direct: needs a mention

    async def dispatch(post: dict[str, Any]) -> None:
        adapter._cursors["chan"] = (0, 0, "")
        adapter._seen.clear()
        adapter.events.clear()
        await adapter._maybe_dispatch(channel, post)
        await asyncio.gather(*adapter._turn_tasks)

    # A mention of @agent_12 (we are @agent_1) must not trigger us.
    asyncio.run(dispatch({
        "post_id": 8, "created_at": "2026-06-04 12:00:01",
        "message": "ping @agent_12 only", "human_id": 1,
    }))
    assert adapter.events == []

    # A real mention: dispatched, token stripped from event text, raw preserved.
    asyncio.run(dispatch({
        "post_id": 9, "created_at": "2026-06-04 12:00:02",
        "message": "please help @agent_1 with this", "human_id": 1,
    }))
    assert len(adapter.events) == 1
    assert adapter.events[0].text.rsplit("\n\n", 1)[-1] == "please help with this"
    assert adapter.events[0].raw_message["message"] == "please help @agent_1 with this"


def test_send_retryable_only_when_request_never_issued() -> None:
    """No server-side post idempotency, so a retry after an AMBIGUOUS failure
    double-posts. ``send`` marks a failure retryable ONLY when the request was
    provably never issued (missing CLI); once posting has begun it is not."""
    mod = _load_hermes_module()

    class FailingClient:
        def set_status(self, channel_id: str, status: str) -> None:
            pass

        def post_message(self, *args: Any, **kwargs: Any) -> Any:
            raise RuntimeError("connection reset after the request went out")

    cfg = _FakePlatformConfig(extra={"api_key": "key", "agent_id": "agent"})
    adapter = mod.ClawbitsAdapter(cfg)
    adapter.client = FailingClient()

    # (a) Failure AFTER a post attempt (the bundled CLI path exists) → the
    # outcome is ambiguous, so it must NOT be retried.
    result = asyncio.run(adapter.send("chan", "hello"))
    assert result.success is False
    assert result.retryable is False

    # (b) Missing CLI → the request was never issued → safe to retry.
    adapter.cli_path = "/nonexistent/path/does/not/exist.py"
    result = asyncio.run(adapter.send("chan", "hello"))
    assert result.success is False
    assert result.retryable is True


def test_garbage_interval_env_falls_back_to_default(monkeypatch) -> None:
    """A malformed interval override must not crash adapter construction — it
    falls back to the documented default (with a logged warning)."""
    mod = _load_hermes_module()
    monkeypatch.setenv("CLAWBITS_POLL_INTERVAL", "not-a-number")
    monkeypatch.setenv("CLAWBITS_LIVENESS_INTERVAL", "")  # empty override

    cfg = _FakePlatformConfig(extra={"api_key": "key", "agent_id": "agent"})
    adapter = mod.ClawbitsAdapter(cfg)  # must not raise

    assert adapter.poll_interval == mod.DEFAULT_POLL_INTERVAL_SECONDS
    assert adapter.liveness_interval == mod.DEFAULT_LIVENESS_INTERVAL_SECONDS


def test_ws_header_kwarg_matches_installed_websockets() -> None:
    """The Bearer auth header rides whichever kwarg the installed websockets
    version accepts: ``additional_headers`` (>=14) or ``extra_headers`` (older).
    An unintrospectable connect falls back to the current name."""
    mod = _load_hermes_module()

    class NewWebsockets:
        def connect(self, uri, *, additional_headers=None, **kw):  # noqa: ANN001
            ...

    class OldWebsockets:
        def connect(self, uri, *, extra_headers=None, **kw):  # noqa: ANN001
            ...

    class OpaqueWebsockets:
        connect = 123  # not a callable with an introspectable signature

    assert mod._ws_header_kwarg(NewWebsockets()) == "additional_headers"
    assert mod._ws_header_kwarg(OldWebsockets()) == "extra_headers"
    assert mod._ws_header_kwarg(OpaqueWebsockets()) == "additional_headers"

    # The events URL no longer carries the secret as a query param.
    cfg = _FakePlatformConfig(extra={"api_key": "sekret", "agent_id": "agent"})
    adapter = mod.ClawbitsAdapter(cfg)
    url = adapter._events_ws_url()
    assert "api_key" not in url
    assert "sekret" not in url
    assert url.endswith("/api/agentic/mm/events/ws")


def test_fallback_plugin_version_matches_manifest() -> None:
    """``_FALLBACK_PLUGIN_VERSION`` is the last-resort value used only when
    plugin.yaml can't be read; it must not drift from the manifest's ``version:``
    line (the real floor the server enforces). Parse with the module's regex."""
    import re

    mod = _load_hermes_module()
    manifest = Path(__file__).resolve().parents[2] / "extensions" / "hermes" / "plugin.yaml"
    version = None
    for line in manifest.read_text(encoding="utf-8").splitlines():
        match = re.match(r"""^version:\s*['"]?([^'"\s#]+)""", line)
        if match:
            version = match.group(1)
            break
    assert version is not None, "no version: line found in plugin.yaml"
    assert mod._FALLBACK_PLUGIN_VERSION == version


def test_agent_body_names_the_agent_and_matches_plugin_wording() -> None:
    """Parity with plugin/src/agent-body.ts: same bracketed context block, and
    the agent is named to itself. Without the name it cannot recognise
    "Scaleweld, any idea why…" as addressed to it — which is exactly what the
    server-side triage step nudges on."""
    mod = _load_hermes_module()

    body = mod._build_agent_body("staging is broken", chat_id="room-9", agent_id="Scaleweld")
    assert body.startswith("[Clawbits context]")
    assert "You are the Clawbits agent Scaleweld" in body
    assert "without an @mention" in body
    assert "[end Clawbits context]" in body
    assert body.endswith("\n\nstaging is broken"), "message text trails the prompt"
    assert "room-9" not in body, "raw channel id never reaches the model"


def test_agent_body_session_id_matches_the_plugin_algorithm() -> None:
    """sha256('clawbits:session:<chat>')[:12] — identical to the plugin's
    clawbitsSessionId, so an agent reports the same id across a runtime swap."""
    mod = _load_hermes_module()
    expected = "sess_" + hashlib.sha256(b"clawbits:session:room-9").hexdigest()[:12]

    assert mod._clawbits_session_id("room-9") == expected
    assert expected in mod._build_agent_body("hi", chat_id="room-9")


def test_agent_body_attention_framing_sits_closest_to_the_ask() -> None:
    """Context, then the reply-only-if-useful framing, then the message: the
    instruction nearest the ask carries the most weight (plugin ordering)."""
    mod = _load_hermes_module()

    body = mod._build_agent_body(
        "anyone?",
        chat_id="chan",
        agent_id="Scaleweld",
        attention_preamble=mod._ATTENTION_PREAMBLE,
    )
    assert body.index("[Clawbits context]") < body.index("[Attention]") < body.index("anyone?")


def test_agent_body_without_ids_leaves_text_shape_alone() -> None:
    """No ids and no framing → context block only, message still trailing."""
    mod = _load_hermes_module()

    body = mod._build_agent_body("hello")
    assert "You are the Clawbits agent" not in body
    assert "session id for this chat" not in body
    assert body.endswith("\n\nhello")


def test_attention_dispatch_carries_context_and_framing() -> None:
    """The nudge path must ship both blocks — this is the path where the agent
    most needs to know its own name."""
    mod = _load_hermes_module()

    cfg = _FakePlatformConfig(extra={"api_key": "key", "agent_id": "Scaleweld"})
    adapter = mod.ClawbitsAdapter(cfg)
    event = {
        "type": "mutualist.consider",
        "channel_id": "chan",
        "data": {"post_id": 11, "message": "staging is down, anyone?", "human_id": 1},
    }

    async def dispatch_and_drain() -> None:
        await adapter._dispatch_attention(event)
        if adapter._turn_tasks:
            await asyncio.gather(*adapter._turn_tasks)

    asyncio.run(dispatch_and_drain())
    assert len(adapter.events) == 1
    text = adapter.events[0].text
    assert "You are the Clawbits agent Scaleweld" in text
    assert "[Attention]" in text
    assert text.endswith("staging is down, anyone?")


def test_unaddressed_post_stays_nudgeable_after_polling() -> None:
    """The bug this guards: the poller used to mark EVERY post seen before
    deciding whether to dispatch, so a channel post the agent isn't mentioned
    in landed in ``_seen``. The server still runs triage on that post and
    publishes a nudge seconds later — which was then dropped as a duplicate,
    making LobsterTalk inert on this runtime. The poll loop always won the race
    (~3s poll vs an LLM triage call)."""
    mod = _load_hermes_module()

    class FakeClient:
        def __init__(self) -> None:
            self.calls = 0

        def list_channels(self) -> list[Any]:
            return [mod._Channel("chan", "public", "General")]

        def get_posts(self, channel_id: str) -> list[dict[str, Any]]:
            self.calls += 1
            if self.calls == 1:
                return []  # seed pass
            # Not a DM, no @mention → the poller must skip it, not swallow it.
            return [{
                "post_id": 7, "created_at": "2026-06-04 12:00:01",
                "message": "staging is down, anyone?", "human_id": 1,
            }]

        def set_status(self, channel_id: str, status: str) -> None:
            pass

    cfg = _FakePlatformConfig(extra={"api_key": "key", "agent_id": "Scaleweld"})
    adapter = mod.ClawbitsAdapter(cfg)
    adapter.client = FakeClient()

    async def scenario() -> None:
        await adapter._poll_once()          # seed
        await adapter._poll_once()          # sees the post, must not dispatch
        await adapter._poll_once()          # and must not remember it via cursor
        if adapter._turn_tasks:
            await asyncio.gather(*adapter._turn_tasks)
        assert adapter.events == [], "unaddressed post must not be dispatched by polling"
        assert "7" not in adapter._seen, "skipped post must stay nudgeable"

        # Now the server's nudge arrives — it must still get through.
        await adapter._dispatch_attention({
            "type": "mutualist.consider",
            "channel_id": "chan",
            "data": {"post_id": 7, "message": "staging is down, anyone?", "human_id": 1},
        })
        if adapter._turn_tasks:
            await asyncio.gather(*adapter._turn_tasks)

    asyncio.run(scenario())
    assert len(adapter.events) == 1, "attention nudge dispatched after the poller skipped it"
    assert adapter.events[0].text.endswith("staging is down, anyone?")


def test_dispatched_post_is_remembered_so_a_nudge_cannot_double_fire() -> None:
    """The other half of the contract: a post the poller DID dispatch (a DM
    here) is remembered, so a nudge for the same post is correctly deduped."""
    mod = _load_hermes_module()

    class FakeClient:
        def __init__(self) -> None:
            self.calls = 0

        def list_channels(self) -> list[Any]:
            return [mod._Channel("chan", "direct", "Chat")]

        def get_posts(self, channel_id: str) -> list[dict[str, Any]]:
            self.calls += 1
            if self.calls == 1:
                return []
            return [{
                "post_id": 8, "created_at": "2026-06-04 12:00:01",
                "message": "hello there", "human_id": 1,
            }]

        def set_status(self, channel_id: str, status: str) -> None:
            pass

    cfg = _FakePlatformConfig(extra={"api_key": "key", "agent_id": "Scaleweld"})
    adapter = mod.ClawbitsAdapter(cfg)
    adapter.client = FakeClient()

    async def scenario() -> None:
        await adapter._poll_once()
        await adapter._poll_once()
        if adapter._turn_tasks:
            await asyncio.gather(*adapter._turn_tasks)
        assert len(adapter.events) == 1, "DM is dispatched by the poll loop"
        assert "8" in adapter._seen

        await adapter._dispatch_attention({
            "type": "mutualist.consider",
            "channel_id": "chan",
            "data": {"post_id": 8, "message": "hello there", "human_id": 1},
        })
        if adapter._turn_tasks:
            await asyncio.gather(*adapter._turn_tasks)

    asyncio.run(scenario())
    assert len(adapter.events) == 1, "nudge for an already-dispatched post is deduped"


def test_streaming_reply_creates_patches_and_finalizes() -> None:
    mod = _load_hermes_module()

    class FakeClient:
        def __init__(self) -> None:
            self.posts: list[tuple[Any, ...]] = []
            self.patches: list[tuple[str, str, dict[str, Any]]] = []

        def post_message(self, *args: Any) -> dict[str, Any]:
            self.posts.append(args)
            return {"post_id": 91}

        def patch_message(self, channel_id: str, post_id: str, **body: Any) -> dict[str, Any]:
            self.patches.append((channel_id, post_id, body))
            return {"post_id": int(post_id)}

        def set_status(self, channel_id: str, status: str, activity: Any = None) -> None:
            pass

    cfg = _FakePlatformConfig(extra={"api_key": "key", "agent_id": "agent"})
    adapter = mod.ClawbitsAdapter(cfg)
    adapter.client = FakeClient()

    result = asyncio.run(
        adapter.send("chan", "first tokens", reply_to="12", metadata={"expect_edits": True})
    )
    assert result.success and result.message_id == "91"
    assert adapter.client.posts[0][-1] == "streaming"
    assert adapter.client.patches[0] == ("chan", "91", {"replace": "first tokens"})

    result = asyncio.run(adapter.edit_message("chan", "91", "complete", finalize=True))
    assert result.success
    assert adapter.client.patches[-1] == (
        "chan",
        "91",
        {"replace": "complete", "done": True},
    )


def test_attachment_only_post_reaches_hermes_media(monkeypatch) -> None:
    mod = _load_hermes_module()
    monkeypatch.setattr(
        sys.modules["hermes_clawbits_test.adapter"],
        "cache_post_attachments",
        lambda client, post: (["/cache/report.pdf"], ["application/pdf"], ["[document saved]"]),
    )

    class FakeClient:
        def set_status(self, channel_id: str, status: str, activity: Any = None) -> None:
            pass

    cfg = _FakePlatformConfig(extra={"api_key": "key", "agent_id": "agent"})
    adapter = mod.ClawbitsAdapter(cfg)
    adapter.client = FakeClient()
    adapter._cursors["chan"] = (0, 0, "")
    post = {
        "post_id": 7,
        "created_at": "2026-06-04 12:00:01",
        "message": "",
        "human_id": 1,
        "files": [
            {
                "file_id": "f1",
                "filename": "report.pdf",
                "content_type": "application/pdf",
                "size_bytes": 10,
            }
        ],
    }

    async def scenario() -> None:
        await adapter._maybe_dispatch(mod._Channel("chan", "direct", "DM"), post)
        await asyncio.gather(*adapter._turn_tasks)

    asyncio.run(scenario())
    assert len(adapter.events) == 1
    assert adapter.events[0].media_urls == ["/cache/report.pdf"]
    assert adapter.events[0].media_types == ["application/pdf"]
    assert adapter.events[0].message_type == "document"


def test_snooze_and_inter_agent_limit_are_enforced() -> None:
    mod = _load_hermes_module()

    class FakeClient:
        def __init__(self) -> None:
            self.posts: list[str] = []

        def post_message(self, channel_id: str, message: str, *args: Any) -> dict[str, Any]:
            self.posts.append(message)
            return {"post_id": 99}

        def set_status(self, channel_id: str, status: str, activity: Any = None) -> None:
            pass

    cfg = _FakePlatformConfig(extra={"api_key": "key", "agent_id": "me"})
    adapter = mod.ClawbitsAdapter(cfg)
    adapter.client = FakeClient()
    channel = mod._Channel("chan", "public", "Room")
    adapter._cursors["chan"] = (0, 0, "")

    async def scenario() -> None:
        adapter._apply_controls({"snoozed": True})
        await adapter._maybe_dispatch(
            channel,
            {"post_id": 1, "created_at": "2026-06-04 12:00:01", "message": "@me hi", "human_id": 1},
        )
        adapter._apply_controls(
            {
                "snoozed": False,
                "inter_agent_mode_enabled": True,
                "inter_agent_message_limit": 1,
            }
        )
        await adapter._maybe_dispatch(
            channel,
            {"post_id": 2, "created_at": "2026-06-04 12:00:02", "message": "@me first", "agent_id": "peer"},
        )
        await adapter._maybe_dispatch(
            channel,
            {"post_id": 3, "created_at": "2026-06-04 12:00:03", "message": "@me second", "agent_id": "peer"},
        )
        await asyncio.gather(*adapter._turn_tasks)

    asyncio.run(scenario())
    assert len(adapter.events) == 1
    assert adapter.events[0].message_id == "2"
    assert adapter._reply_prefixes["2"] == "@peer"
    assert adapter.client.posts == ["@peer Nice, but need human guidance to proceed."]


def test_email_reply_context_preserves_threading_headers() -> None:
    mod = _load_hermes_module()
    email_mod = sys.modules["hermes_clawbits_test.email_integration"]
    context = email_mod.email_reply_context(
        {"uid": 42, "subject": "Question", "headers": {"Message-ID": "<abc@example>"}}
    )

    class FakeClient:
        def email_send(
            self,
            agent_id: str,
            subject: str,
            message: str,
            headers: dict[str, str],
        ) -> dict[str, str]:
            self.call = (agent_id, subject, message, headers)
            return {"status": "sent"}

    client = FakeClient()
    email_mod.send_email_reply(client, "agent", context, "answer")
    assert client.call == (
        "agent",
        "Re: Question",
        "answer",
        {
            # Auto-Submitted is what stops an owner-side vacation responder from
            # bouncing this reply straight back into the agent's mailbox.
            "Auto-Submitted": "auto-replied",
            "In-Reply-To": "<abc@example>",
            "References": "<abc@example>",
        },
    )
    assert mod.PLUGIN_VERSION == "0.7.0"


def test_automation_interval_keeps_anchor_and_existing_next_run(monkeypatch) -> None:
    _load_hermes_module()
    automation_mod = sys.modules["hermes_clawbits_test.automations"]
    monkeypatch.setattr(automation_mod.time, "time", lambda: 1_000.0)
    schedule = {"kind": "every", "everyMs": 60_000, "anchorMs": 900_000}
    next_ms, anchor_ms = automation_mod._next_schedule_ms(schedule, None)
    assert (next_ms, anchor_ms) == (1_020_000, 900_000)

    existing = {
        "enabled": True,
        "state": "scheduled",
        "next_run_at": "1970-01-01T00:18:00+00:00",
        "clawbits_desired_schedule": schedule,
        "clawbits_anchor_ms": anchor_ms,
    }
    assert automation_mod._next_schedule_ms(schedule, existing) == (1_080_000, 900_000)


# --- automations reconciler -------------------------------------------------
#
# The fake below mirrors the real ``/opt/hermes/cron/jobs.py`` contract, checked
# against the shipped ``hermes-agent`` image: ``update_job`` merges unknown keys
# and returns the merged record, ``remove_job`` returns False (never raises) for
# a job that is already gone, ``repeat`` is stored as ``{"times", "completed"}``
# even though ``create_job`` takes it as an int, and only ``id`` is immutable.


class _FakeCronJobs:
    def __init__(self) -> None:
        self.jobs: list[dict[str, Any]] = []
        self.calls: list[tuple[Any, ...]] = []
        self._next_id = 1
        self.trigger_result: Any = {"ok": True}
        self.trigger_raises: Exception | None = None
        self.remove_raises: Exception | None = None

    def create_job(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(("create_job", kwargs))
        job = {
            "id": str(self._next_id),
            "name": kwargs.get("name"),
            "prompt": kwargs.get("prompt"),
            "schedule": kwargs.get("schedule"),
            "repeat": {"times": kwargs.get("repeat"), "completed": 0},
            "deliver": kwargs.get("deliver"),
            "model": kwargs.get("model"),
            "origin": kwargs.get("origin"),
            "enabled": True,
            "state": "scheduled",
        }
        self._next_id += 1
        self.jobs.append(job)
        return dict(job)

    def list_jobs(self, include_disabled: bool = False) -> list[dict[str, Any]]:
        return [dict(j) for j in self.jobs if include_disabled or j.get("enabled", True)]

    def update_job(self, job_id: str, updates: dict[str, Any]) -> dict[str, Any] | None:
        self.calls.append(("update_job", str(job_id), dict(updates)))
        for index, job in enumerate(self.jobs):
            if job["id"] == str(job_id):
                self.jobs[index] = {**job, **updates}
                return dict(self.jobs[index])
        return None

    def pause_job(self, job_id: str, reason: str | None = None) -> dict[str, Any] | None:
        self.calls.append(("pause_job", str(job_id), reason))
        return self.update_job(job_id, {"enabled": False, "state": "paused", "paused_reason": reason})

    def remove_job(self, job_id: str) -> bool:
        self.calls.append(("remove_job", str(job_id)))
        if self.remove_raises is not None:
            raise self.remove_raises
        before = len(self.jobs)
        self.jobs = [j for j in self.jobs if j["id"] != str(job_id)]
        return len(self.jobs) < before

    def trigger_job(self, job_id: str) -> Any:
        self.calls.append(("trigger_job", str(job_id)))
        if self.trigger_raises is not None:
            raise self.trigger_raises
        return self.trigger_result


class _FakeAutomationsClient:
    def __init__(self, items: list[dict[str, Any]]) -> None:
        self.items = items
        self.reports: list[dict[str, Any]] = []
        self.state_raises: Exception | None = None

    def automations_desired(self) -> dict[str, Any]:
        return {"automations": self.items}

    def automations_state(self, report: dict[str, Any]) -> dict[str, Any]:
        self.reports.append(report)
        if self.state_raises is not None:
            raise self.state_raises
        return {"desired_generation": 1}


def _install_fake_cron(fake: _FakeCronJobs) -> None:
    cron = sys.modules.get("cron") or types.ModuleType("cron")
    jobs_mod = types.ModuleType("cron.jobs")
    for name in (
        "create_job",
        "list_jobs",
        "update_job",
        "pause_job",
        "remove_job",
        "trigger_job",
    ):
        setattr(jobs_mod, name, getattr(fake, name))
    cron.jobs = jobs_mod
    sys.modules["cron"] = cron
    sys.modules["cron.jobs"] = jobs_mod


def _automations_mod():
    _load_hermes_module()
    return sys.modules["hermes_clawbits_test.automations"]


def _desired(spec: dict[str, Any], **overrides: Any) -> dict[str, Any]:
    item = {
        "automation_id": "a1",
        "intent": "present",
        "desired_generation": 1,
        "desired_spec": spec,
    }
    item.update(overrides)
    return item


def _spec(**overrides: Any) -> dict[str, Any]:
    # Interval rather than cron by default: the cron branch needs ``croniter``,
    # which ships in the Hermes image but not in this repo's venv.
    spec = {
        "name": "Daily digest",
        "payload": {"kind": "agentTurn", "message": "summarise the day"},
        "schedule": {"kind": "every", "everyMs": 3_600_000},
        "enabled": True,
    }
    spec.update(overrides)
    return spec


def _run_pass(mod, fake: _FakeCronJobs, client: _FakeAutomationsClient) -> dict[str, Any]:
    _install_fake_cron(fake)
    mod.reconcile_automations_once(client, "agent", "chan")
    return client.reports[-1]


def _managed(report: dict[str, Any], automation_id: str = "a1") -> list[dict[str, Any]]:
    return [m for m in report["managed"] if m["automation_id"] == automation_id]


def test_fired_one_shot_reports_applied_not_failed(monkeypatch) -> None:
    """The headline bug: a one-shot that ran correctly used to report `failed`
    forever, because the schedule was recomputed and its `at` was now past."""
    mod = _automations_mod()
    now_ms = 2_000_000_000_000
    monkeypatch.setattr(mod.time, "time", lambda: now_ms / 1000)
    spec = _spec(schedule={"kind": "at", "at": now_ms + 600_000})

    fake = _FakeCronJobs()
    client = _FakeAutomationsClient([_desired(spec)])
    first = _run_pass(mod, fake, client)
    assert _managed(first)[0]["status"] == "applied"

    # The job fires: Hermes marks it completed and stamps last_run_at.
    fake.jobs[0].update(
        {
            "state": "completed",
            "repeat": {"times": 1, "completed": 1},
            "last_run_at": mod._iso_at(now_ms + 600_000),
            "last_status": "completed",
        }
    )
    monkeypatch.setattr(mod.time, "time", lambda: (now_ms + 900_000) / 1000)
    second = _run_pass(mod, fake, client)

    entry = _managed(second)[0]
    assert entry["status"] == "applied", "a fired one-shot is done, not broken"
    assert entry["reported_state"]["state"] == "completed"
    assert "nextRunAtMs" not in entry["reported_state"]
    assert not any(
        call[0] == "update_job" and "schedule" in call[2] for call in fake.calls
    ), "a terminal one-shot must never be re-armed"


def test_edited_one_shot_rearms(monkeypatch) -> None:
    mod = _automations_mod()
    now_ms = 2_000_000_000_000
    monkeypatch.setattr(mod.time, "time", lambda: now_ms / 1000)
    fake = _FakeCronJobs()
    client = _FakeAutomationsClient([_desired(_spec(schedule={"kind": "at", "at": now_ms + 600_000}))])
    _run_pass(mod, fake, client)
    fake.jobs[0].update(
        {"state": "completed", "last_run_at": mod._iso_at(now_ms + 600_000), "last_status": "ok"}
    )

    # Operator edits the automation to a new future time — the hash changes.
    monkeypatch.setattr(mod.time, "time", lambda: (now_ms + 900_000) / 1000)
    client.items = [
        _desired(_spec(schedule={"kind": "at", "at": now_ms + 3_600_000}), desired_generation=2)
    ]
    report = _run_pass(mod, fake, client)

    assert _managed(report)[0]["status"] == "applied"
    assert any(call[0] == "update_job" and "schedule" in call[2] for call in fake.calls)


def test_bad_generation_does_not_abort_pass() -> None:
    """A malformed field on one automation used to raise before the state POST,
    freezing every other automation on the agent on 'Applying…'."""
    mod = _automations_mod()
    fake = _FakeCronJobs()
    client = _FakeAutomationsClient(
        [
            _desired(_spec(), automation_id="bad", desired_generation="not-a-number"),
            _desired(_spec(), automation_id="good"),
        ]
    )
    report = _run_pass(mod, fake, client)

    assert len(client.reports) == 1, "the state report still went out"
    assert _managed(report, "good")[0]["status"] == "applied"
    assert _managed(report, "bad")[0]["status"] == "applied"


def test_remove_failure_does_not_report_removed() -> None:
    mod = _automations_mod()
    fake = _FakeCronJobs()
    client = _FakeAutomationsClient([_desired(_spec())])
    _run_pass(mod, fake, client)

    fake.remove_raises = RuntimeError("cron store locked")
    client.items = [_desired(_spec(), intent="absent", desired_generation=2)]
    report = _run_pass(mod, fake, client)

    entry = _managed(report)[0]
    assert entry["status"] == "failed", "reporting 'removed' would delete the row server-side"
    assert "cron store locked" in entry["error"]


def test_missing_job_removal_is_success() -> None:
    mod = _automations_mod()
    fake = _FakeCronJobs()
    client = _FakeAutomationsClient([_desired(_spec(), intent="absent")])
    report = _run_pass(mod, fake, client)
    assert _managed(report)[0]["status"] == "removed"


def test_run_report_failure_does_not_double_report(monkeypatch) -> None:
    mod = _automations_mod()
    fake = _FakeCronJobs()
    client = _FakeAutomationsClient([_desired(_spec())])
    _install_fake_cron(fake)

    def boom(*_args: Any, **_kwargs: Any) -> None:
        raise RuntimeError("telemetry exploded")

    monkeypatch.setattr(mod, "_run_report", boom)
    mod.reconcile_automations_once(client, "agent", "chan")

    entries = _managed(client.reports[-1])
    assert len(entries) == 1, "one automation must produce exactly one managed entry"
    assert entries[0]["status"] == "applied"


def test_run_report_synthesized_from_job_record(monkeypatch) -> None:
    """Fallback path: on a Hermes without `cron.executions`, run rows are
    synthesised from the job record rather than reporting nothing at all."""
    mod = _automations_mod()
    fake = _FakeCronJobs()
    client = _FakeAutomationsClient([_desired(_spec())])
    _run_pass(mod, fake, client)

    fake.jobs[0].update(
        {
            "last_run_at": "2026-08-12T09:00:00+00:00",
            "last_status": "failed",
            "last_error": "model timed out",
        }
    )
    report = _run_pass(mod, fake, client)
    runs = [r for r in report["runs"] if r["automation_id"] == "a1"]
    assert len(runs) == 1
    assert runs[0]["status"] == "error"
    assert runs[0]["summary"]["error"] == "model timed out"
    assert runs[0]["gateway_run_id"] == f"run:{mod._iso_ms('2026-08-12T09:00:00+00:00')}"
    assert "finished_at_ms" not in runs[0], "Hermes records no duration; 0s would be a lie"

    # Re-reporting the same run must upsert, not duplicate.
    again = _run_pass(mod, fake, client)
    assert [r["gateway_run_id"] for r in again["runs"] if r["automation_id"] == "a1"] == [
        runs[0]["gateway_run_id"]
    ]


def test_unknown_run_status_is_omitted_not_green() -> None:
    mod = _automations_mod()
    assert mod._run_status("timeout", False) == "error"
    assert mod._run_status("completed", False) == "ok"
    assert mod._run_status("", False) is None
    assert mod._run_status("", True) == "error"
    assert mod._run_status("weird-new-status", False) is None


def test_consecutive_errors_accumulate_and_persist() -> None:
    mod = _automations_mod()
    fake = _FakeCronJobs()
    client = _FakeAutomationsClient([_desired(_spec())])
    _run_pass(mod, fake, client)

    streaks = []
    for index in range(3):
        fake.jobs[0].update(
            {
                "last_run_at": f"2026-08-12T09:0{index}:00+00:00",
                "last_status": "failed",
                "last_error": "boom",
            }
        )
        report = _run_pass(mod, fake, client)
        streaks.append(_managed(report)[0]["reported_state"]["consecutiveErrors"])
    assert streaks == [1, 2, 3], "without this the UI's fail streak never reaches its threshold"

    fake.jobs[0].update(
        {"last_run_at": "2026-08-12T09:05:00+00:00", "last_status": "ok", "last_error": None}
    )
    report = _run_pass(mod, fake, client)
    assert _managed(report)[0]["reported_state"]["consecutiveErrors"] == 0, "a clean run resets it"


def test_streak_not_rewritten_when_no_new_run() -> None:
    mod = _automations_mod()
    fake = _FakeCronJobs()
    client = _FakeAutomationsClient([_desired(_spec())])
    _run_pass(mod, fake, client)
    fake.jobs[0].update({"last_run_at": "2026-08-12T09:00:00+00:00", "last_status": "ok"})
    _run_pass(mod, fake, client)
    before = sum(1 for c in fake.calls if c[0] == "update_job" and mod._STREAK_KEY in c[2])
    _run_pass(mod, fake, client)
    after = sum(1 for c in fake.calls if c[0] == "update_job" and mod._STREAK_KEY in c[2])
    assert before == after == 1, "the streak sentinel is written once per real run, not per pass"


def test_delete_after_run_deletes_only_after_successful_post(monkeypatch) -> None:
    mod = _automations_mod()
    now_ms = 2_000_000_000_000
    monkeypatch.setattr(mod.time, "time", lambda: now_ms / 1000)
    spec = _spec(schedule={"kind": "at", "at": now_ms + 600_000}, deleteAfterRun=True)
    fake = _FakeCronJobs()
    client = _FakeAutomationsClient([_desired(spec)])
    _run_pass(mod, fake, client)
    fake.jobs[0].update(
        {
            "state": "completed",
            "last_run_at": mod._iso_at(now_ms + 600_000),
            "last_status": "ok",
        }
    )
    monkeypatch.setattr(mod.time, "time", lambda: (now_ms + 900_000) / 1000)

    # The POST fails: nothing may be deleted, so the terminal report survives.
    client.state_raises = RuntimeError("network")
    _install_fake_cron(fake)
    try:
        mod.reconcile_automations_once(client, "agent", "chan")
    except RuntimeError:
        pass
    assert fake.jobs, "a failed report must not take the job with it"

    client.state_raises = None
    _run_pass(mod, fake, client)
    assert not fake.jobs, "a clean one-shot run is disarmed once the report landed"


def test_delete_after_run_keeps_a_failed_one_shot(monkeypatch) -> None:
    mod = _automations_mod()
    now_ms = 2_000_000_000_000
    monkeypatch.setattr(mod.time, "time", lambda: now_ms / 1000)
    spec = _spec(schedule={"kind": "at", "at": now_ms + 600_000}, deleteAfterRun=True)
    fake = _FakeCronJobs()
    client = _FakeAutomationsClient([_desired(spec)])
    _run_pass(mod, fake, client)
    fake.jobs[0].update(
        {
            "state": "completed",
            "last_run_at": mod._iso_at(now_ms + 600_000),
            "last_status": "failed",
            "last_error": "boom",
        }
    )
    monkeypatch.setattr(mod.time, "time", lambda: (now_ms + 900_000) / 1000)
    _run_pass(mod, fake, client)
    assert fake.jobs, "a failed one-shot stays so it can be retried"


def test_deleted_one_shot_reports_applied_from_gateway_job_id(monkeypatch) -> None:
    """After deleteAfterRun removed the job, the server still lists the
    automation as present — without this branch it would be recreated and re-run."""
    mod = _automations_mod()
    now_ms = 2_000_000_000_000
    monkeypatch.setattr(mod.time, "time", lambda: now_ms / 1000)
    spec = _spec(schedule={"kind": "at", "at": now_ms - 3_600_000}, deleteAfterRun=True)
    fake = _FakeCronJobs()
    client = _FakeAutomationsClient([_desired(spec, gateway_job_id="7")])
    report = _run_pass(mod, fake, client)

    entry = _managed(report)[0]
    assert entry["status"] == "applied"
    assert entry["gateway_job_id"] == "7"
    assert not any(call[0] == "create_job" for call in fake.calls), "must not re-run a done one-shot"


def test_past_one_shot_never_applied_reports_failed(monkeypatch) -> None:
    mod = _automations_mod()
    now_ms = 2_000_000_000_000
    monkeypatch.setattr(mod.time, "time", lambda: now_ms / 1000)
    spec = _spec(schedule={"kind": "at", "at": now_ms - 3_600_000})
    fake = _FakeCronJobs()
    client = _FakeAutomationsClient([_desired(spec)])
    report = _run_pass(mod, fake, client)
    assert _managed(report)[0]["status"] == "failed"


def test_declined_run_now_reports_miss_row() -> None:
    mod = _automations_mod()
    fake = _FakeCronJobs()
    client = _FakeAutomationsClient([_desired(_spec())])
    _run_pass(mod, fake, client)

    fake.trigger_result = None  # gateway declined
    client.items = [_desired(_spec(), run_requested_generation=1)]
    report = _run_pass(mod, fake, client)

    runs = [r for r in report["runs"] if r["gateway_run_id"] == "run-now:1"]
    assert len(runs) == 1
    assert runs[0]["status"] == "error"
    assert runs[0]["summary"]["did_not_run"] is True
    assert _managed(report)[0]["run_observed_generation"] == 1


def test_transient_decline_is_skipped_not_error() -> None:
    mod = _automations_mod()
    fake = _FakeCronJobs()
    client = _FakeAutomationsClient([_desired(_spec())])
    _run_pass(mod, fake, client)
    fake.trigger_result = {"ran": False, "reason": "already-running"}
    client.items = [_desired(_spec(), run_requested_generation=1)]
    report = _run_pass(mod, fake, client)
    runs = [r for r in report["runs"] if r["gateway_run_id"] == "run-now:1"]
    assert runs[0]["status"] == "skipped"


def test_trigger_exception_is_reported_not_raised() -> None:
    mod = _automations_mod()
    fake = _FakeCronJobs()
    client = _FakeAutomationsClient([_desired(_spec())])
    _run_pass(mod, fake, client)
    fake.trigger_raises = RuntimeError("scheduler down")
    client.items = [_desired(_spec(), run_requested_generation=1)]
    report = _run_pass(mod, fake, client)
    assert _managed(report)[0]["status"] == "applied"
    assert any(r["gateway_run_id"] == "run-now:1" for r in report["runs"])


def test_paused_run_now_row_marks_did_not_run() -> None:
    mod = _automations_mod()
    fake = _FakeCronJobs()
    client = _FakeAutomationsClient([_desired(_spec(enabled=False), run_requested_generation=1)])
    report = _run_pass(mod, fake, client)
    runs = [r for r in report["runs"] if r["gateway_run_id"] == "run-now:1"]
    assert runs[0]["summary"]["did_not_run"] is True


def test_every_schedule_uses_native_interval() -> None:
    mod = _automations_mod()
    fake = _FakeCronJobs()
    client = _FakeAutomationsClient(
        [_desired(_spec(schedule={"kind": "every", "everyMs": 600_000}))]
    )
    _run_pass(mod, fake, client)

    created = [c for c in fake.calls if c[0] == "create_job"][0][1]
    assert created["schedule"] == "every 10m"
    assert created["repeat"] is None, "Hermes owns the re-arm for a native interval"


def test_native_interval_update_omits_schedule_when_unchanged() -> None:
    mod = _automations_mod()
    schedule = {"kind": "every", "everyMs": 600_000}
    fake = _FakeCronJobs()
    client = _FakeAutomationsClient([_desired(_spec(schedule=schedule))])
    _run_pass(mod, fake, client)

    # Prompt-only edit: including `schedule` would restart the interval grid.
    spec = _spec(schedule=schedule)
    spec["payload"] = {"kind": "agentTurn", "message": "something else"}
    client.items = [_desired(spec, desired_generation=2)]
    before = len(fake.calls)
    _run_pass(mod, fake, client)
    updates = [c for c in fake.calls[before:] if c[0] == "update_job"]
    assert updates, "a prompt edit is drift and must update"
    assert not any("schedule" in c[2] for c in updates)


def test_non_minute_interval_falls_back_to_one_shot() -> None:
    mod = _automations_mod()
    fake = _FakeCronJobs()
    client = _FakeAutomationsClient(
        [_desired(_spec(schedule={"kind": "every", "everyMs": 90_000}))]
    )
    _run_pass(mod, fake, client)
    created = [c for c in fake.calls if c[0] == "create_job"][0][1]
    assert created["repeat"] == 1
    assert created["schedule"].startswith("20"), "an ISO instant, not a native interval"


def test_prompt_edit_on_paused_automation_does_not_resume() -> None:
    mod = _automations_mod()
    fake = _FakeCronJobs()
    client = _FakeAutomationsClient([_desired(_spec(enabled=False))])
    _run_pass(mod, fake, client)
    assert fake.jobs[0]["enabled"] is False

    spec = _spec(enabled=False)
    spec["payload"] = {"kind": "agentTurn", "message": "changed"}
    client.items = [_desired(spec, desired_generation=2)]
    _run_pass(mod, fake, client)
    assert fake.jobs[0]["enabled"] is False, "editing a paused automation must not arm it"


def test_orphan_managed_job_is_mirrored_as_external() -> None:
    mod = _automations_mod()
    fake = _FakeCronJobs()
    client = _FakeAutomationsClient([_desired(_spec())])
    _run_pass(mod, fake, client)

    # The server no longer lists it, but the job is still on the agent, firing.
    client.items = []
    report = _run_pass(mod, fake, client)
    assert not report["managed"]
    assert [e["gateway_job_id"] for e in report["external"]] == ["1"]


def test_unsupported_session_target_is_rejected() -> None:
    mod = _automations_mod()
    fake = _FakeCronJobs()
    client = _FakeAutomationsClient([_desired(_spec(sessionTarget="main"))])
    report = _run_pass(mod, fake, client)
    assert _managed(report)[0]["status"] == "failed"
    assert not any(c[0] == "create_job" for c in fake.calls)


def test_sentinel_write_failure_does_not_create_duplicate() -> None:
    mod = _automations_mod()
    fake = _FakeCronJobs()
    client = _FakeAutomationsClient([_desired(_spec())])
    _run_pass(mod, fake, client)
    # Simulate the sentinel never landing: the job exists but is unlabelled.
    fake.jobs[0].pop(mod._MANAGED_KEY)

    client.items = [_desired(_spec(), gateway_job_id="1", desired_generation=2)]
    before = sum(1 for c in fake.calls if c[0] == "create_job")
    _run_pass(mod, fake, client)
    after = sum(1 for c in fake.calls if c[0] == "create_job")
    assert after == before, "an unlabelled job is found by gateway_job_id, not recreated"


def test_wake_during_pass_triggers_immediate_repass(monkeypatch) -> None:
    mod = _automations_mod()
    monkeypatch.setattr(mod, "AUTOMATIONS_RECONCILE_INTERVAL_SECONDS", 3600.0)
    monkeypatch.setattr(mod, "AUTOMATIONS_MIN_REPASS_SECONDS", 0.0)
    passes = 0

    async def scenario() -> None:
        nonlocal passes
        wake = asyncio.Event()

        def fake_pass(*_args: Any) -> None:
            nonlocal passes
            passes += 1
            wake.set()  # a nudge lands while the pass is running

        monkeypatch.setattr(mod, "reconcile_automations_once", fake_pass)
        task = asyncio.create_task(
            mod.run_automations_reconciler(object(), "agent", "chan", wake, lambda: passes < 2)
        )
        await asyncio.wait_for(task, timeout=5)

    asyncio.run(scenario())
    assert passes == 2, "a mid-pass nudge must not be cleared and forgotten"


# --- email ------------------------------------------------------------------


def test_long_reply_is_truncated_to_the_server_limit() -> None:
    _load_hermes_module()
    email_mod = sys.modules["hermes_clawbits_test.email_integration"]
    fitted = email_mod.fit_email_body("x" * 40_000)
    assert len(fitted) <= 10_000, "the server rejects a body over 10k and the reply would be lost"
    assert fitted.endswith("the full reply is in the Clawbits chat.]")
    assert email_mod.fit_email_body("   ") == "(the agent produced an empty reply)"
    assert email_mod.fit_email_body("short") == "short"


def test_long_subject_is_capped() -> None:
    _load_hermes_module()
    email_mod = sys.modules["hermes_clawbits_test.email_integration"]
    assert len(email_mod._reply_subject("s" * 400)) <= 256


def test_email_reply_mirrors_to_chat_before_sending(monkeypatch) -> None:
    """A send that 422s must not also cost the user the chat copy."""
    mod = _load_hermes_module()
    order: list[str] = []

    class FakeClient:
        def post_message(self, channel_id: str, message: str, *args: Any) -> dict[str, Any]:
            order.append("post")
            return {"post_id": 5}

        def email_send(self, *args: Any, **kwargs: Any) -> dict[str, str]:
            order.append("email")
            raise RuntimeError("HTTP 422: message too long")

        def set_status(self, channel_id: str, status: str, activity: Any = None) -> None:
            pass

    cfg = _FakePlatformConfig(extra={"api_key": "k", "agent_id": "agent"})
    adapter = mod.ClawbitsAdapter(cfg)
    adapter.client = FakeClient()
    email_mod = sys.modules["hermes_clawbits_test.email_integration"]
    context = email_mod.email_reply_context({"uid": 3, "subject": "Hi", "headers": {}})
    adapter._email_reply_contexts["9"] = context

    result = asyncio.run(adapter.send("chan", "the answer", reply_to="9"))
    assert order == ["post", "email"], "chat mirror lands first"
    assert result.success is False and result.retryable is False


def test_email_failure_still_finalizes_the_streaming_post() -> None:
    """The failure is deterministic (over-long body), so retrying would loop
    forever and could double-send if the first email actually landed."""
    mod = _load_hermes_module()

    class FakeClient:
        def __init__(self) -> None:
            self.patches: list[dict[str, Any]] = []

        def patch_message(self, channel_id: str, post_id: str, **body: Any) -> dict[str, Any]:
            self.patches.append(body)
            return {"post_id": int(post_id)}

        def email_send(self, *args: Any, **kwargs: Any) -> dict[str, str]:
            raise RuntimeError("HTTP 422: message too long")

    cfg = _FakePlatformConfig(extra={"api_key": "k", "agent_id": "agent"})
    adapter = mod.ClawbitsAdapter(cfg)
    adapter.client = FakeClient()
    email_mod = sys.modules["hermes_clawbits_test.email_integration"]
    adapter._stream_email_contexts["12"] = email_mod.email_reply_context(
        {"uid": 3, "subject": "Hi", "headers": {}}
    )

    result = asyncio.run(adapter.edit_message("chan", "12", "the answer", finalize=True))
    assert result.success is True
    assert adapter.client.patches[-1]["done"] is True, "the draft must never be left streaming"
    assert "could not send this as an email" in adapter.client.patches[-1]["replace"]
    assert "12" not in adapter._stream_email_contexts


def test_third_party_email_is_not_auto_replied() -> None:
    mod = _load_hermes_module()
    email_mod = sys.modules["hermes_clawbits_test.email_integration"]
    assert email_mod.is_from_owner({"from_addr": "Owner <boss@corp.com>"}, "boss@corp.com")
    assert not email_mod.is_from_owner({"from_addr": "stranger@elsewhere.com"}, "boss@corp.com")
    assert not email_mod.is_from_owner({"from_addr": "boss@corp.com"}, None)

    body = email_mod._format_email_turn({"from_addr": "s@x.com"}, [], from_owner=False)
    assert "NOT from your owner" in body
    assert "untrusted email body" in body, "an inbound email is a prompt-injection channel"


def test_autoresponders_are_skipped() -> None:
    _load_hermes_module()
    email_mod = sys.modules["hermes_clawbits_test.email_integration"]
    assert email_mod.is_auto_submitted({"headers": {"Auto-Submitted": "auto-replied"}})
    assert email_mod.is_auto_submitted({"headers": {"Precedence": "bulk"}})
    assert email_mod.is_auto_submitted({"headers": {"List-Id": "<x.example.com>"}})
    assert not email_mod.is_auto_submitted({"headers": {"Auto-Submitted": "no"}})
    assert not email_mod.is_auto_submitted({"headers": {"Subject": "hello"}})


def test_self_addressed_only_matches_the_agents_own_domain() -> None:
    _load_hermes_module()
    email_mod = sys.modules["hermes_clawbits_test.email_integration"]
    assert email_mod._is_self_addressed(
        {"from_addr": "snivy@clawbits.ai"}, "snivy", "snivy@clawbits.ai"
    )
    assert not email_mod._is_self_addressed(
        {"from_addr": "snivy@gmail.com"}, "snivy", "snivy@clawbits.ai"
    ), "a stranger who happens to share the local part is not the agent"


def test_watermark_round_trips_uidvalidity(tmp_path, monkeypatch) -> None:
    _load_hermes_module()
    email_mod = sys.modules["hermes_clawbits_test.email_integration"]
    monkeypatch.setattr(email_mod, "_watermark_path", lambda: tmp_path / "wm.json")
    email_mod.save_email_watermark(42, 900)
    assert email_mod.load_email_watermark() == (42, 900)
    # A file written by the previous format still loads.
    (tmp_path / "wm.json").write_text('{"last_uid": 7}')
    assert email_mod.load_email_watermark() == (7, None)
    assert email_mod.load_email_watermark.__doc__


def test_email_body_never_rides_on_argv() -> None:
    """argv is world-readable through ps; the body is private correspondence."""
    mod = _load_hermes_module()
    captured: list[tuple[str, ...]] = []

    cli = mod._ClawbitsCli("/nonexistent/cli.py", "http://x", "key", "0.7.0", None)
    payloads: list[dict[str, Any]] = []

    def fake_run(*args: str) -> Any:
        captured.append(args)
        path = args[args.index("--json") + 1]
        assert path.startswith("@")
        payloads.append(__import__("json").loads(Path(path[1:]).read_text()))
        return {"status": "sent"}

    cli._run = fake_run  # type: ignore[method-assign]
    cli.email_send("agent", "Secret subject", "Confidential body", {"In-Reply-To": "<a@b>"})

    flat = " ".join(captured[0])
    assert "Confidential body" not in flat and "Secret subject" not in flat
    assert payloads[0]["message"] == "Confidential body"
    assert payloads[0]["headers"] == {"In-Reply-To": "<a@b>"}


# --- streaming and activity --------------------------------------------------


class _StreamClient:
    def __init__(self) -> None:
        self.posts: list[tuple[Any, ...]] = []
        self.patches: list[tuple[str, str, dict[str, Any]]] = []

    def post_message(self, *args: Any) -> dict[str, Any]:
        self.posts.append(args)
        return {"post_id": 91}

    def patch_message(self, channel_id: str, post_id: str, **body: Any) -> dict[str, Any]:
        self.patches.append((channel_id, post_id, body))
        return {"post_id": int(post_id)}

    def set_status(self, channel_id: str, status: str, activity: Any = None) -> None:
        pass


def _stream_adapter(mod):
    cfg = _FakePlatformConfig(extra={"api_key": "k", "agent_id": "agent"})
    adapter = mod.ClawbitsAdapter(cfg)
    adapter.client = _StreamClient()
    return adapter


def test_failed_turn_closes_the_streaming_post() -> None:
    """An abandoned draft shimmers in the channel until the server reaps it."""
    mod = _load_hermes_module()
    adapter = _stream_adapter(mod)

    async def scenario() -> None:
        async def boom(_event: Any) -> None:
            # The draft is opened mid-turn, as the gateway does, and then the
            # turn dies before anything finalizes it.
            await adapter.send("chan", "partial", metadata={"expect_edits": True})
            assert adapter._open_streams == {"91": "chan"}
            raise RuntimeError("model died")

        adapter.handle_message = boom  # type: ignore[method-assign]
        await adapter._run_turn("chan", object())

    asyncio.run(scenario())
    closing = [p for p in adapter.client.patches if p[2].get("done")]
    assert closing, "the draft must be finalized, not left streaming"
    assert "failed to generate" in closing[-1][2]["replace"]
    assert adapter._open_streams == {}


def test_disconnect_closes_open_streams() -> None:
    mod = _load_hermes_module()
    adapter = _stream_adapter(mod)

    async def scenario() -> None:
        await adapter.send("chan", "partial", metadata={"expect_edits": True})
        await adapter.disconnect()

    asyncio.run(scenario())
    assert any(p[2].get("done") for p in adapter.client.patches)
    assert adapter._open_streams == {}


def test_streamed_body_is_capped_to_the_patch_limit() -> None:
    mod = _load_hermes_module()
    adapter = _stream_adapter(mod)
    result = asyncio.run(adapter.edit_message("chan", "91", "y" * 60_000, finalize=True))
    assert result.success
    replaced = adapter.client.patches[-1][2]["replace"]
    assert len(replaced) <= 40_000, "over the cap the PATCH 422s and the draft never closes"
    assert replaced.endswith("_(reply truncated)_")


def test_long_interim_bubble_is_posted_not_swallowed() -> None:
    """A real reply that happens to open with the emoji must not vanish."""
    mod = _load_hermes_module()
    adapter = _stream_adapter(mod)
    short = asyncio.run(adapter.send("chan", "💬 checking the logs"))
    assert short.success and not adapter.client.posts, "a short bubble stays ephemeral"

    long_reply = "💬 " + ("a real answer. " * 100)
    result = asyncio.run(adapter.send("chan", long_reply))
    assert adapter.client.posts, "a long message is a reply, not a status bubble"
    assert result.message_id == "91"


def test_activity_label_is_not_clamped_to_the_old_160(monkeypatch) -> None:
    mod = _load_hermes_module()
    label = mod.adapter._sanitize_activity("ran " + "x" * 900)
    assert len(label) > 160, "the server allows 1200; 160 was a reverted regression"
    assert len(label) <= 1000


def test_activity_sanitizer_redacts_secrets() -> None:
    mod = _load_hermes_module()
    assert "[redacted]" in mod.adapter._sanitize_activity("using api_key: sk-abc123")
    assert "sk-abc123" not in mod.adapter._sanitize_activity("using api_key: sk-abc123")


def test_unknown_channel_is_not_treated_as_a_dm() -> None:
    """Otherwise the agent auto-replies to every post in a public room it has
    not polled yet — which is exactly what happens while discovery is failing."""
    mod = _load_hermes_module()
    adapter = _stream_adapter(mod)

    async def scenario() -> None:
        await adapter._dispatch_realtime_post(
            {
                "channel_id": "unseen",
                "data": {
                    "post_id": 3,
                    "channel_id": "unseen",
                    "created_at": "2026-06-04 12:00:01",
                    "message": "chatting to someone else",
                    "human_id": 1,
                },
            }
        )
        if adapter._turn_tasks:
            await asyncio.gather(*adapter._turn_tasks)

    asyncio.run(scenario())
    assert adapter.events == [], "no mention, unknown channel type: not our turn"


def test_attention_dispatches_an_attachment_only_post(monkeypatch) -> None:
    mod = _load_hermes_module()
    monkeypatch.setattr(
        sys.modules["hermes_clawbits_test.adapter"],
        "cache_post_attachments",
        lambda client, post: (["/cache/a.pdf"], ["application/pdf"], ["[document saved]"]),
    )
    adapter = _stream_adapter(mod)

    async def scenario() -> None:
        await adapter._dispatch_attention(
            {
                "channel_id": "chan",
                "data": {
                    "post_id": 8,
                    "created_at": "2026-06-04 12:00:01",
                    "message": "",
                    "human_id": 1,
                    "files": [
                        {
                            "file_id": "f1",
                            "filename": "a.pdf",
                            "content_type": "application/pdf",
                            "size_bytes": 4,
                        }
                    ],
                },
            }
        )
        await asyncio.gather(*adapter._turn_tasks)

    asyncio.run(scenario())
    assert len(adapter.events) == 1
    assert adapter.events[0].media_urls == ["/cache/a.pdf"]


def test_stream_state_is_bounded() -> None:
    mod = _load_hermes_module()
    adapter = _stream_adapter(mod)
    cap = mod.adapter._REPLY_CONTEXT_CAP
    for index in range(cap + 50):
        adapter._open_streams[str(index)] = "chan"
    adapter._trim_stream_state()
    assert len(adapter._open_streams) == cap, "a crashed turn never pops its entry"


def test_a_finishing_turn_does_not_close_a_sibling_turns_stream() -> None:
    """Two turns can run at once in the same channel; the first to finish must
    not yank the other's live draft."""
    mod = _load_hermes_module()
    adapter = _stream_adapter(mod)
    ready = asyncio.Event()

    async def scenario() -> None:
        async def slow_turn(_event: Any) -> None:
            await adapter.send("chan", "B partial", metadata={"expect_edits": True})
            ready.set()
            await asyncio.sleep(0.2)

        async def fast_turn(_event: Any) -> None:
            await ready.wait()

        adapter.handle_message = slow_turn  # type: ignore[method-assign]
        slow = asyncio.create_task(adapter._run_turn("chan", object()))
        await ready.wait()
        open_id = next(iter(adapter._open_streams))

        adapter.handle_message = fast_turn  # type: ignore[method-assign]
        await adapter._run_turn("chan", object())
        assert open_id in adapter._open_streams, "the sibling turn's draft is still live"
        await slow

    asyncio.run(scenario())
    assert adapter._open_streams == {}, "each turn still closes its own draft"


class _EmailPollClient:
    def __init__(self, details: dict[int, dict[str, Any]], owner: str | None = "boss@corp.com"):
        self.details = details
        self.owner = owner
        self.posts: list[tuple[Any, ...]] = []

    def email_count(self, agent_id: str) -> dict[str, Any]:
        return {"total": len(self.details), "unread": 0, "email_address": "snivy@clawbits.ai"}

    def agent_info(self, agent_id: str) -> dict[str, Any]:
        return {"agent_id": agent_id, "operator_email": self.owner}

    def email_inbox(self, agent_id: str, limit: int, offset: int) -> dict[str, Any]:
        if offset:
            return {"emails": []}
        return {"emails": [{"uid": uid} for uid in sorted(self.details)]}

    def email_get(self, agent_id: str, uid: int) -> dict[str, Any]:
        return self.details[uid]

    def post_message(self, *args: Any) -> dict[str, Any]:
        self.posts.append(args)
        return {"post_id": 1}

    def set_status(self, channel_id: str, status: str, activity: Any = None) -> None:
        pass


def _email_adapter(mod, client, tmp_path, monkeypatch, watermark: int | None = 0):
    email_mod = sys.modules["hermes_clawbits_test.email_integration"]
    monkeypatch.setattr(email_mod, "_watermark_path", lambda: tmp_path / "wm.json")
    cfg = _FakePlatformConfig(extra={"api_key": "k", "agent_id": "snivy", "channel_id": "chan"})
    adapter = mod.ClawbitsAdapter(cfg)
    adapter.client = client
    adapter._email_watermark = watermark
    return adapter


def test_owner_email_is_resolved_from_agent_info(tmp_path, monkeypatch) -> None:
    """The mailbox count response carries no operator address; without pulling
    it from agent-info every message would look third-party and never be
    answered by email."""
    mod = _load_hermes_module()
    client = _EmailPollClient(
        {
            1: {"uid": 1, "from_addr": "boss@corp.com", "subject": "hi", "body_text": "hello"},
            2: {"uid": 2, "from_addr": "stranger@x.com", "subject": "spam", "body_text": "buy"},
        }
    )
    adapter = _email_adapter(mod, client, tmp_path, monkeypatch)

    async def scenario() -> None:
        await adapter._poll_email_once()
        await asyncio.gather(*adapter._turn_tasks)

    asyncio.run(scenario())
    assert adapter._email_owner == "boss@corp.com"
    assert "email:1" in adapter._email_reply_contexts, "owner mail gets an emailed reply"
    assert "email:2" not in adapter._email_reply_contexts, "a stranger's mail does not"
    assert len(adapter.events) == 2, "both still reach the agent as turns"


def test_uid_reset_reseeds_the_watermark(tmp_path, monkeypatch) -> None:
    """A reprovisioned mailbox restarts uids; without this, intake stops dead."""
    mod = _load_hermes_module()
    client = _EmailPollClient({1: {"uid": 1, "from_addr": "boss@corp.com", "body_text": "x"}})
    adapter = _email_adapter(mod, client, tmp_path, monkeypatch, watermark=9_000)

    asyncio.run(adapter._poll_email_once())
    assert adapter._email_watermark == 1, "reseeded to the mailbox's newest uid"


def test_autoresponder_mail_is_not_dispatched(tmp_path, monkeypatch) -> None:
    mod = _load_hermes_module()
    client = _EmailPollClient(
        {
            1: {
                "uid": 1,
                "from_addr": "boss@corp.com",
                "body_text": "out of office",
                "headers": {"Auto-Submitted": "auto-replied"},
            }
        }
    )
    adapter = _email_adapter(mod, client, tmp_path, monkeypatch)

    async def scenario() -> None:
        await adapter._poll_email_once()
        if adapter._turn_tasks:
            await asyncio.gather(*adapter._turn_tasks)

    asyncio.run(scenario())
    assert adapter.events == [], "answering an autoresponder is how mail loops start"
    assert adapter._email_watermark == 1


def _install_fake_executions(latest: Any) -> None:
    cron = sys.modules.get("cron") or types.ModuleType("cron")
    mod = types.ModuleType("cron.executions")
    mod.latest_execution = lambda job_id: latest
    cron.executions = mod
    sys.modules["cron"] = cron
    sys.modules["cron.executions"] = mod


def test_execution_log_is_preferred_over_the_job_record() -> None:
    """`cron.executions` exists on current Hermes and carries the real run id,
    both endpoints and the recorded error — better data than the job record."""
    mod = _automations_mod()
    fake = _FakeCronJobs()
    client = _FakeAutomationsClient([_desired(_spec())])
    _run_pass(mod, fake, client)

    fake.jobs[0].update({"last_run_at": "2026-08-12T09:00:00+00:00", "last_status": "ok"})
    _install_fake_executions(
        {
            "id": "exec-abc",
            "status": "failed",
            "claimed_at": "2026-08-12T09:00:00+00:00",
            "finished_at": "2026-08-12T09:00:42+00:00",
            "error": "provider refused",
        }
    )
    try:
        report = _run_pass(mod, fake, client)
    finally:
        sys.modules.pop("cron.executions", None)
        if "cron" in sys.modules:
            sys.modules["cron"].__dict__.pop("executions", None)

    runs = [r for r in report["runs"] if r["automation_id"] == "a1"]
    assert runs[0]["gateway_run_id"] == "exec-abc", "the real execution id, not a synthetic one"
    assert runs[0]["status"] == "error"
    assert runs[0]["summary"]["error"] == "provider refused"
    assert runs[0]["finished_at_ms"] is not None, "the execution log does carry a duration"


def test_running_execution_reports_no_terminal_status() -> None:
    mod = _automations_mod()
    fake = _FakeCronJobs()
    client = _FakeAutomationsClient([_desired(_spec())])
    _run_pass(mod, fake, client)
    _install_fake_executions(
        {"id": "exec-live", "status": "running", "claimed_at": "2026-08-12T09:00:00+00:00"}
    )
    try:
        report = _run_pass(mod, fake, client)
    finally:
        sys.modules.pop("cron.executions", None)
        if "cron" in sys.modules:
            sys.modules["cron"].__dict__.pop("executions", None)

    runs = [r for r in report["runs"] if r["automation_id"] == "a1"]
    assert "status" not in runs[0], "an in-flight attempt must not be reported as ok"
    assert "finished_at_ms" not in runs[0]


def test_create_job_does_not_pass_a_string_origin() -> None:
    """create_job's `origin` is Optional[Dict] and flips its deliver default;
    a bare string there is a type violation."""
    mod = _automations_mod()
    fake = _FakeCronJobs()
    client = _FakeAutomationsClient([_desired(_spec())])
    _run_pass(mod, fake, client)
    created = [c for c in fake.calls if c[0] == "create_job"][0][1]
    assert not isinstance(created.get("origin"), str)
