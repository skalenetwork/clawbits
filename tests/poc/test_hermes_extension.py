from __future__ import annotations

import asyncio
import hashlib
import importlib.util
import sys
import types
from dataclasses import dataclass
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
