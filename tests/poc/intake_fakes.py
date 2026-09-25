"""Fakes for the chat intake tests: a Clawbits client with serial posts and Hermes's busy sessions.

tests/hermes_runtime covers the same contracts against the real gateway.
"""

from __future__ import annotations

import asyncio
import sys
from collections import defaultdict
from typing import Any

from tests.poc.hermes_stubs import _FakePlatformConfig, _FakeProcessingOutcome

OPERATOR = 1
SUCCESS = _FakeProcessingOutcome.SUCCESS
FAILURE = _FakeProcessingOutcome.FAILURE
CANCELLED = _FakeProcessingOutcome.CANCELLED


class FakeClawbits:
    """Channels with serial posts: forward reads (``limit``/``after_post_id``), the channels
    snapshot with read pointers, a mark_read log clamped like the server, and status calls."""

    def __init__(self, channels: dict[str, str | None] | None = None) -> None:
        self.types = dict(channels or {"dm": "direct"})
        self.posts: dict[str, list[dict[str, Any]]] = {c: [] for c in self.types}
        self.pointers: dict[str, int] = {}
        self.acks: list[tuple[str, int]] = []
        self.reads: list[tuple[str, int, int | None]] = []
        self.statuses: list[tuple[str, str]] = []
        self.sent: list[tuple[str, str]] = []
        self.serial = 0  # the newest post id handed out
        self.snoozed = False
        self.inter_agent = False
        self.ignore_after = False  # a backend that predates after_post_id
        self.report_latest = True

    def post(
        self, text: str, channel: str = "dm", *, serial: int | None = None, **fields: Any
    ) -> dict[str, Any]:
        """Publish a post (by the operator unless ``human_id``/``agent_id`` say otherwise)."""
        fields.setdefault("human_id", None if fields.get("agent_id") else OPERATOR)
        self.serial = max(self.serial, serial or self.serial + 1)
        post = {"post_id": serial or self.serial, "channel_id": channel, "message": text,
                "created_at": "2026-06-04 12:00:00", **fields}
        self.posts[channel].append(post)
        self.posts[channel].sort(key=lambda p: p["post_id"])
        return post

    def control_snapshot(self) -> dict[str, Any]:
        def latest(cid: str) -> int | None:
            posts = self.posts[cid] if self.report_latest else []
            return posts[-1]["post_id"] if posts else None

        channels = [
            {"channel_id": cid, "type": kind, "name": cid, "latest_post_id": latest(cid),
             "last_read_post_id": self.pointers.get(cid)}
            for cid, kind in self.types.items()
        ]
        return {"channels": channels, "snoozed": self.snoozed,
                "inter_agent_mode_enabled": self.inter_agent}

    def get_posts(
        self, channel_id: str, limit: int = 50, after_post_id: int | None = None
    ) -> list[dict[str, Any]]:
        self.reads.append((channel_id, limit, after_post_id))
        posts = self.posts.get(channel_id, [])
        if after_post_id is None or self.ignore_after:
            return [dict(p) for p in posts[-limit:]]
        return [dict(p) for p in posts if p["post_id"] > after_post_id][:limit]

    def mark_read(self, channel_id: str, post_id: int) -> dict[str, Any]:
        self.acks.append((channel_id, post_id))
        below = [p["post_id"] for p in self.posts.get(channel_id, []) if p["post_id"] <= post_id]
        if below:
            self.pointers[channel_id] = max(self.pointers.get(channel_id, 0), max(below))
        return {"channel_id": channel_id, "last_read_post_id": self.pointers.get(channel_id, 0)}

    def set_status(self, channel_id: str, status: str, activity: Any = None) -> None:
        self.statuses.append((channel_id, status))

    def agent_info(self, agent_id: str) -> dict[str, Any]:
        return {"operator_id": OPERATOR, "operator_email": "op@example.com",
                "operator_display_name": "Op"}

    def operator_channel(self, agent_id: str) -> str:
        return "dm"

    def post_message(self, channel_id: str, content: str, *args: Any, **kwargs: Any) -> dict:
        self.sent.append((channel_id, content))
        self.serial += 1
        return {"post_id": self.serial}


class FakeGateway:
    """Hermes's busy-session handling around the adapter's hooks: one turn per chat; while it runs a
    resolvable command is handled in place (``/stop``, ``/new`` cancel it), and anything else waits
    in a FIFO or, with ``merge``, is absorbed without hooks. While ``prompt`` (a pending clarify or
    approval) a controlled answer is intercepted whether or not a turn is running. ``defer`` accepts
    an event without starting it (a pending head); ``hold`` keeps turns running until ``finish``."""

    def __init__(self, adapter: Any, *, hold: bool = False, merge: bool = False) -> None:
        self.adapter, self.hold, self.merge = adapter, hold, merge
        self.defer = self.prompt = False
        self.events: list[Any] = []
        self.inline: list[Any] = []
        self.absorbed: list[Any] = []
        self.running: dict[str, tuple[Any, asyncio.Future[Any], asyncio.Task[None]]] = {}
        self.pending: dict[str, Any] = {}
        self.queued: dict[str, list[Any]] = defaultdict(list)
        adapter.handle_message = self.handle_message
        adapter._fake_gateway = self

    async def handle_message(self, event: Any) -> None:
        self.events.append(event)
        chat = event.source.chat_id
        if self.prompt and event.allow_gateway_control:
            self.inline.append(event)  # an answer to a pending prompt, busy chat or not
        elif chat in self.running or chat in self.pending:
            command = event.get_command()
            if command and sys.modules["hermes_cli.commands"].resolve_command(command):
                self.inline.append(event)
                if command in ("stop", "new", "reset") and chat in self.running:
                    self.running[chat][2].cancel()
            else:
                (self.absorbed if self.merge else self.queued[chat]).append(event)
        elif self.defer:
            self.pending[chat] = event
        else:
            self._start(event)

    def start_pending(self, chat: str) -> None:
        self._start(self.pending.pop(chat))

    async def complete(self, chat: str = "dm", outcome: Any = SUCCESS) -> None:
        """End the chat's held turn with ``outcome`` and wait for its hooks."""
        _, done, task = self.running[chat]
        done.set_result(outcome)
        await task

    def texts(self) -> list[str]:
        return [event.text for event in self.events]

    def _start(self, event: Any) -> None:
        done = asyncio.get_running_loop().create_future()
        if not self.hold:
            done.set_result(SUCCESS)
        task = asyncio.create_task(self._run(event, done))
        self.running[event.source.chat_id] = (event, done, task)

    async def _run(self, event: Any, done: asyncio.Future[Any]) -> None:
        chat = event.source.chat_id
        await self.adapter.on_processing_start(event)
        try:
            outcome = await done
        except asyncio.CancelledError:
            outcome = CANCELLED
        await self.adapter.on_processing_complete(event, outcome)
        del self.running[chat]
        if self.queued[chat]:
            self._start(self.queued[chat].pop(0))

    async def cancel_all(self) -> None:
        tasks = [task for _, _, task in self.running.values()]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


def adapter_for(mod: Any, fake: FakeClawbits, **extra: Any) -> Any:
    """A ClawbitsAdapter (agent ``agent``) on the per-test HERMES_HOME talking to ``fake``."""
    config = _FakePlatformConfig(extra={"api_key": "key", "agent_id": "agent", **extra})
    adapter = mod.ClawbitsAdapter(config)
    adapter.client = fake
    return adapter


def run(coro: Any, timeout: float = 60) -> Any:
    return asyncio.run(asyncio.wait_for(coro, timeout))


async def idle(adapter: Any, gateway: FakeGateway | None = None) -> None:
    """Wait for hand-offs and for turns that may finish (stub turns, or released fake turns)."""
    for _ in range(1000):
        tasks = [*adapter._handoffs, *(t for t in getattr(adapter, "tasks", []) if not t.done())]
        if gateway is not None:
            tasks += [task for _, done, task in gateway.running.values() if done.done()]
        if not tasks:
            return
        await asyncio.gather(*tasks, return_exceptions=True)


async def pump(adapter: Any, gateway: FakeGateway | None = None, passes: int = 4) -> None:
    """Full intake passes with hand-offs and finishing turns settled in between."""
    for _ in range(passes):
        await adapter._poll_once()
        await idle(adapter, gateway)


def items(adapter: Any, channel: str = "dm") -> dict[int, tuple[str, str | None]]:
    """pos -> (state, note) of the channel's post-lane items."""
    rows = adapter._journal.db.execute(
        "SELECT i.pos, i.state, i.note FROM item i JOIN source s ON s.id = i.source_id"
        " WHERE s.locator = ? AND i.lane = 'post' ORDER BY i.pos",
        (channel,),
    )
    return {pos: (state, note) for pos, state, note in rows}
