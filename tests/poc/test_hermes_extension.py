from __future__ import annotations

import argparse
import asyncio
import contextlib
import hashlib
import json
import sys
import types
from pathlib import Path
from typing import Any

from tests.poc.hermes_stubs import (
    _drain,
    _event,
    _FakePlatformConfig,
    _FakeProcessingOutcome,
    _load_hermes_module,
)


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
            self.body = json.loads(Path(args[3][1:]).read_text())
            return {"post_id": 7}

    cli = Recorder("cli.py", "http://x", "key")
    raw = cli.post_message("chan", "hello", 123, "tr_abc")

    assert raw == {"post_id": 7}
    assert cli.args[:3] == ("mm-post", "chan", "--json")
    assert cli.args[3].startswith("@"), "the body rides a private file, never argv"
    assert cli.body["parent_post_id"] == 123
    assert cli.body["trace_id"] == "tr_abc"
    assert cli.body["message"] == "hello"


def test_first_poll_greets_once_and_unblocks_liveness(monkeypatch, tmp_path) -> None:
    """The first FULL poll pass greets the operator channel (once ever, marker-
    persisted) and only then sets ``_ready`` — the gate the liveness loop waits
    on, so the wizard's "available" implies greeted and every channel sourced."""
    mod = _load_hermes_module()
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))

    class FakeClient:
        def __init__(self) -> None:
            self.greetings: list[tuple[str, str]] = []

        def list_channels(self) -> list[Any]:
            return [mod._Channel("chan", "direct", "Chat")]

        def get_posts(self, channel_id: str, limit: int = 50, after_post_id: int | None = None):
            return []

        def agent_info(self, agent_id: str) -> dict[str, Any]:
            return {"operator_display_name": "Mr L", "org_id": "org-1"}

        def post_message(self, channel_id, content, parent_post_id=None, trace_id=None, file_ids=None):
            self.greetings.append((channel_id, content))

    cfg = _FakePlatformConfig(extra={"api_key": "key", "agent_id": "agent", "channel_id": "chan"})

    def first_passes(client: FakeClient) -> Any:
        adapter = mod.ClawbitsAdapter(cfg)
        adapter.client = client
        assert not adapter._ready.is_set()

        async def run() -> None:
            assert await adapter._open_journal()
            await adapter._poll_once()
            assert adapter._ready.is_set()
            await adapter._poll_once()

        asyncio.run(run())
        return adapter

    first_passes(client := FakeClient())
    assert client.greetings == [("chan", "Hi Mr L! Agent agent reporting in for org-1.")]
    assert (tmp_path / ".clawbits_greeted").exists(), "the second pass did not re-greet"

    # Fresh gateway boot (new adapter, same HERMES_HOME): the marker suppresses it.
    first_passes(client := FakeClient())
    assert client.greetings == []


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

    async def slow_turn(event: object) -> Any:
        await asyncio.sleep(0.05)  # ~5 heartbeat intervals
        return _FakeProcessingOutcome.SUCCESS

    adapter.turn = slow_turn  # type: ignore[assignment,method-assign]

    async def dispatch_and_drain() -> None:
        await adapter.handle_message(_event("5"))
        await _drain(adapter)

    asyncio.run(dispatch_and_drain())

    statuses = adapter.client.statuses
    assert statuses, "expected status updates"
    assert statuses[0] == "generating", statuses
    assert statuses.count("generating") >= 2, f"heartbeat should renew generating: {statuses}"
    assert statuses[-1] == "online", statuses


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


def test_events_url_carries_no_secret() -> None:
    """The Bearer credential rides a header; a query param would land in logs."""
    mod = _load_hermes_module()
    cfg = _FakePlatformConfig(extra={"api_key": "sekret", "agent_id": "agent"})
    adapter = mod.ClawbitsAdapter(cfg)
    url = adapter._events_ws_url()
    assert "api_key" not in url
    assert "sekret" not in url
    assert url.endswith("/api/agentic/mm/events/ws")
    assert adapter.authorization_is_upstream is True


def test_validate_config_answers_with_a_bool(monkeypatch) -> None:
    """A ``(False, reason)`` tuple is truthy, which enabled a platform with no credentials."""
    mod = _load_hermes_module()
    monkeypatch.delenv("CLAWBITS_API_KEY", raising=False)
    monkeypatch.delenv("CLAWBITS_AGENT_ID", raising=False)
    assert mod.validate_config(_FakePlatformConfig()) is False
    assert mod.is_connected() is False
    assert mod.validate_config(_FakePlatformConfig(extra={"api_key": "k", "agent_id": "a"})) is True


def test_env_enablement_seed_is_flat(monkeypatch) -> None:
    """The gateway lifts the seed into ``extra`` itself (only ``home_channel`` is popped)."""
    mod = _load_hermes_module()
    monkeypatch.setenv("CLAWBITS_API_KEY", "k")
    monkeypatch.setenv("CLAWBITS_AGENT_ID", "a")
    monkeypatch.setenv("CLAWBITS_CHANNEL_ID", "chan")
    monkeypatch.delenv("CLAWBITS_ENDPOINT", raising=False)
    seed = mod._env_enablement()
    assert (seed["api_key"], seed["agent_id"], seed["base_url"]) == ("k", "a", "https://app.clawbits.ai")
    assert seed["home_channel"]["chat_id"] == "chan"
    assert "extra" not in seed and "enabled" not in seed


# --- signup ------------------------------------------------------------------

_IDENTITY_ENV = (
    "OPENROUTER_API_KEY=or-1\nCLAWBITS_API_KEY=old-key\nCLAWBITS_AGENT_ID=old-agent\n"
    "CLAWBITS_POLL_INTERVAL=5\n"
)


def _signup(monkeypatch, tmp_path, responses: dict[str, Any]) -> tuple[list[str], Path]:
    """Run ``hermes clawbits signup`` over a stored identity, against a fake
    agent CLI that answers (or raises) per command; returns the commands it saw."""
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    env = tmp_path / ".env"
    env.write_text(_IDENTITY_ENV, encoding="utf-8")

    _load_hermes_module()
    signup_mod = sys.modules["hermes_clawbits_test.signup"]
    seen: list[str] = []

    def fake_cli(cli_path: str, base_url: str, *args: str, **_: Any) -> Any:
        seen.append(args[0])
        answer = responses[args[0]]
        if isinstance(answer, BaseException):
            raise answer
        return answer

    monkeypatch.setattr(signup_mod, "_run_agent_cli", fake_cli)
    monkeypatch.setattr(signup_mod, "_mint_initial_tokens", lambda *a, **k: True)
    args = argparse.Namespace(clawbits_command="signup", endpoint=None, signup_token="tok")
    assert signup_mod._cli_command(args) == 0
    return seen, env


def test_signup_keeps_an_identity_the_backend_accepts(monkeypatch, tmp_path) -> None:
    seen, env = _signup(monkeypatch, tmp_path, {"agent-info": {"agent_id": "old-agent"}})
    assert seen == ["agent-info"], "a current identity never re-enrols"
    assert env.read_text() == _IDENTITY_ENV


def test_signup_replaces_a_revoked_identity(monkeypatch, tmp_path) -> None:
    seen, env = _signup(
        monkeypatch,
        tmp_path,
        {
            "agent-info": RuntimeError('HTTP 401: {"detail": "invalid api key"}'),
            "signup-commit": {"agent_id": "new-agent", "api_key": "new-key"},
            "mm-operator-channel": {"channel_id": "chan-9"},
        },
    )
    assert seen == ["agent-info", "signup-commit", "mm-operator-channel"]
    assert env.read_text().splitlines() == [
        "OPENROUTER_API_KEY=or-1",
        "CLAWBITS_POLL_INTERVAL=5",
        "CLAWBITS_API_KEY=new-key",
        "CLAWBITS_AGENT_ID=new-agent",
        "CLAWBITS_CHANNEL_ID=chan-9",
    ], "only the identity lines move; other settings stay where they were"


def test_signup_keeps_the_identity_through_an_outage(monkeypatch, tmp_path) -> None:
    import subprocess

    seen, env = _signup(
        monkeypatch, tmp_path, {"agent-info": subprocess.TimeoutExpired("agent-cli", 60)}
    )
    assert seen == ["agent-info"], "only a 401/403 counts as revoked"
    assert env.read_text() == _IDENTITY_ENV


def test_channel_prompt_names_the_agent_and_matches_plugin_wording() -> None:
    """Parity with plugin/src/agent-body.ts: same bracketed context block, and
    the agent is named to itself. Without the name it cannot recognise
    "Scaleweld, any idea why…" as addressed to it — which is exactly what the
    server-side triage step nudges on."""
    mod = _load_hermes_module()

    prompt = mod._clawbits_channel_prompt("room-9", "Scaleweld")
    assert prompt.startswith("[Clawbits context]")
    assert "You are the Clawbits agent Scaleweld" in prompt
    assert "without an @mention" in prompt
    assert prompt.endswith("[end Clawbits context]")
    assert "room-9" not in prompt, "raw channel id never reaches the model"


def test_channel_prompt_session_id_matches_the_plugin_algorithm() -> None:
    """sha256('clawbits:session:<chat>')[:12] — identical to the plugin's
    clawbitsSessionId, so an agent reports the same id across a runtime swap."""
    mod = _load_hermes_module()
    expected = "sess_" + hashlib.sha256(b"clawbits:session:room-9").hexdigest()[:12]

    assert mod._clawbits_session_id("room-9") == expected
    assert expected in mod._clawbits_channel_prompt("room-9", None)
    assert "You are the Clawbits agent" not in mod._clawbits_channel_prompt("room-9", None)


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


def test_email_reply_context_preserves_threading_headers() -> None:
    mod = _load_hermes_module()
    email_mod = sys.modules["hermes_clawbits_test.email_integration"]
    context = email_mod.email_reply_context(
        {"uid": 42, "subject": "Question", "headers": {"Message-ID": "<abc@example>"}}
    )

    assert email_mod._reply_subject(context.subject) == "Re: Question"
    assert email_mod._reply_headers(context) == {
        # Auto-Submitted is what stops an owner-side vacation responder from
        # bouncing this reply straight back into the agent's mailbox.
        "Auto-Submitted": "auto-replied",
        "In-Reply-To": "<abc@example>",
        "References": "<abc@example>",
    }
    assert mod.PLUGIN_VERSION == "0.10.0"


def test_automation_interval_keeps_anchor_and_existing_next_run(monkeypatch) -> None:
    _load_hermes_module()
    automation_mod = sys.modules["hermes_clawbits_test.automations"]
    monkeypatch.setattr(automation_mod.time, "time", lambda: 1_000.0)
    schedule = {"kind": "every", "everyMs": 60_000, "anchorMs": 900_000}
    next_ms, anchor_ms, missed = automation_mod._next_schedule_ms(schedule, None)
    assert (next_ms, anchor_ms, missed) == (1_020_000, 900_000, None)

    existing = {
        "enabled": True,
        "state": "scheduled",
        "next_run_at": "1970-01-01T00:18:00+00:00",
        "clawbits_desired_schedule": schedule,
        "clawbits_anchor_ms": anchor_ms,
    }
    assert automation_mod._next_schedule_ms(schedule, existing) == (1_080_000, 900_000, None)


# --- automations reconciler -------------------------------------------------
#
# The fake below mirrors the real ``/opt/hermes/cron/jobs.py`` contract, checked
# against the shipped ``hermes-agent`` image: ``update_job`` merges unknown keys
# and returns the merged record but refuses to reactivate a completed job,
# ``trigger_job`` refuses a terminal job, ``rearm_oneshot`` is the one way back,
# ``remove_job`` returns False (never raises) for a job that is already gone,
# ``repeat`` is stored as ``{"times", "completed"}`` even though ``create_job``
# takes it as an int, and only ``id`` is immutable.


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

    def _find(self, job_id: str) -> int | None:
        return next((i for i, job in enumerate(self.jobs) if job["id"] == str(job_id)), None)

    def update_job(self, job_id: str, updates: dict[str, Any]) -> dict[str, Any] | None:
        self.calls.append(("update_job", str(job_id), dict(updates)))
        index = self._find(job_id)
        if index is None:
            return None
        if self.jobs[index].get("state") == "completed" and (
            updates.get("state") not in (None, "completed")
            or updates.get("enabled") is True
            or updates.get("next_run_at") is not None
            or "schedule" in updates
        ):
            raise ValueError("Cannot activate terminal cron job through update_job")
        self.jobs[index] = {**self.jobs[index], **updates}
        return dict(self.jobs[index])

    def rearm_oneshot(self, job_id: str, run_at: Any) -> dict[str, Any] | None:
        self.calls.append(("rearm_oneshot", str(job_id), run_at))
        index = self._find(job_id)
        if index is None:
            return None
        if (self.jobs[index].get("repeat") or {}).get("times") is None:
            raise ValueError("Cannot re-arm recurring jobs")
        self.jobs[index] = {
            **self.jobs[index],
            "schedule": run_at,
            "next_run_at": run_at,
            "enabled": True,
            "state": "scheduled",
            "paused_at": None,
            "paused_reason": None,
            "repeat": {"times": 1, "completed": 0},
        }
        return dict(self.jobs[index])

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
        index = self._find(job_id)
        if index is not None and self.jobs[index].get("state") == "completed":
            raise ValueError("Cannot run: job is completed (terminal)")
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
        "rearm_oneshot",
        "remove_job",
        "trigger_job",
    ):
        setattr(jobs_mod, name, getattr(fake, name))
    cron.jobs = jobs_mod
    sys.modules["cron"] = cron
    sys.modules["cron.jobs"] = jobs_mod


def _automations_mod():
    _load_hermes_module()
    mod = sys.modules["hermes_clawbits_test.automations"]
    # No Hermes here to pin a profile to; test_hermes_automations_catchup.py covers the pin.
    mod._profile_scope = lambda home: contextlib.nullcontext()
    return mod


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
    mod.reconcile_automations_once(client, "agent", "chan", hermes_home=Path("/unused"))
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
        call[0] == "rearm_oneshot" or (call[0] == "update_job" and "schedule" in call[2])
        for call in fake.calls
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
    rearms = [call for call in fake.calls if call[0] == "rearm_oneshot"]
    assert rearms == [("rearm_oneshot", "1", mod._iso_at(now_ms + 3_600_000))]
    assert fake.jobs[0]["state"] == "scheduled"


def _fired_one_shot(monkeypatch, mod, now_ms: int) -> tuple[_FakeCronJobs, _FakeAutomationsClient]:
    """A one-shot that fired at ``now_ms + 600_000``, as Hermes leaves it."""
    monkeypatch.setattr(mod.time, "time", lambda: now_ms / 1000)
    fake = _FakeCronJobs()
    client = _FakeAutomationsClient([_desired(_spec(schedule={"kind": "at", "at": now_ms + 600_000}))])
    _run_pass(mod, fake, client)
    fake.jobs[0].update(
        {
            "state": "completed",
            "enabled": False,
            "next_run_at": None,
            "repeat": {"times": 1, "completed": 1},
            "last_run_at": mod._iso_at(now_ms + 600_000),
            "last_status": "ok",
        }
    )
    monkeypatch.setattr(mod.time, "time", lambda: (now_ms + 900_000) / 1000)
    return fake, client


def test_run_now_on_a_fired_one_shot_rearms_then_triggers(monkeypatch) -> None:
    """``trigger_job`` refuses a terminal job, so a manual run re-arms it first."""
    mod = _automations_mod()
    now_ms = 2_000_000_000_000
    fake, client = _fired_one_shot(monkeypatch, mod, now_ms)
    client.items = [
        _desired(_spec(schedule={"kind": "at", "at": now_ms + 600_000}), run_requested_generation=1)
    ]
    report = _run_pass(mod, fake, client)

    names = [call[0] for call in fake.calls]
    assert names.index("rearm_oneshot") < names.index("trigger_job")
    rearms = [call for call in fake.calls if call[0] == "rearm_oneshot"]
    assert rearms == [("rearm_oneshot", "1", mod._iso_at(now_ms + 900_000))]
    assert _managed(report)[0]["run_observed_generation"] == 1
    assert not any(run["summary"].get("did_not_run") for run in report["runs"])


def test_retiming_a_fired_one_shot_while_disabled_rearms_it_paused(monkeypatch) -> None:
    mod = _automations_mod()
    now_ms = 2_000_000_000_000
    fake, client = _fired_one_shot(monkeypatch, mod, now_ms)
    later = now_ms + 3_600_000
    client.items = [
        _desired(_spec(schedule={"kind": "at", "at": later}, enabled=False), desired_generation=2)
    ]
    report = _run_pass(mod, fake, client)

    assert _managed(report)[0]["status"] == "applied"
    rearms = [call for call in fake.calls if call[0] == "rearm_oneshot"]
    assert rearms == [("rearm_oneshot", "1", mod._iso_at(later))]
    assert fake.jobs[0]["enabled"] is False
    assert fake.jobs[0]["state"] == "paused", "re-paused through pause_job, marker included"
    assert fake.jobs[0]["paused_reason"] == "Paused in Clawbits"
    assert fake.jobs[0]["next_run_at"] == mod._iso_at(later)


def test_declined_run_now_on_a_fired_one_shot_disarms_again(monkeypatch) -> None:
    mod = _automations_mod()
    now_ms = 2_000_000_000_000
    fake, client = _fired_one_shot(monkeypatch, mod, now_ms)
    fake.trigger_result = None
    client.items = [
        _desired(_spec(schedule={"kind": "at", "at": now_ms + 600_000}), run_requested_generation=1)
    ]
    report = _run_pass(mod, fake, client)

    assert any(call[0] == "rearm_oneshot" for call in fake.calls)
    assert fake.jobs[0]["state"] == "completed", "a declined run leaves nothing armed"
    runs = [r for r in report["runs"] if r["gateway_run_id"] == "run-now:1"]
    assert runs[0]["summary"]["did_not_run"] is True


def test_prompt_edit_on_a_pending_one_shot_does_not_rearm(monkeypatch) -> None:
    """A pending one-shot is not a reactivation: the edit goes through
    update_job with its time intact, and a live run claim cannot refuse it."""
    mod = _automations_mod()
    now_ms = 2_000_000_000_000
    monkeypatch.setattr(mod.time, "time", lambda: now_ms / 1000)
    at = now_ms + 600_000
    fake = _FakeCronJobs()
    client = _FakeAutomationsClient([_desired(_spec(schedule={"kind": "at", "at": at}))])
    _run_pass(mod, fake, client)

    spec = _spec(schedule={"kind": "at", "at": at})
    spec["payload"] = {"kind": "agentTurn", "message": "changed"}
    client.items = [_desired(spec, desired_generation=2)]
    report = _run_pass(mod, fake, client)

    assert _managed(report)[0]["status"] == "applied"
    assert not any(call[0] == "rearm_oneshot" for call in fake.calls)
    assert fake.jobs[0]["prompt"] == "changed"
    assert fake.jobs[0]["schedule"] == mod._iso_at(at)
    assert fake.jobs[0]["state"] == "scheduled"


def test_prompt_edit_on_a_paused_one_shot_keeps_it_paused(monkeypatch) -> None:
    mod = _automations_mod()
    now_ms = 2_000_000_000_000
    monkeypatch.setattr(mod.time, "time", lambda: now_ms / 1000)
    schedule = {"kind": "at", "at": now_ms + 600_000}
    fake = _FakeCronJobs()
    client = _FakeAutomationsClient([_desired(_spec(schedule=schedule, enabled=False))])
    _run_pass(mod, fake, client)
    assert fake.jobs[0]["state"] == "paused"

    spec = _spec(schedule=schedule, enabled=False)
    spec["payload"] = {"kind": "agentTurn", "message": "changed"}
    client.items = [_desired(spec, desired_generation=2)]
    _run_pass(mod, fake, client)

    assert not any(call[0] == "rearm_oneshot" for call in fake.calls)
    assert fake.jobs[0]["enabled"] is False
    assert fake.jobs[0]["state"] == "paused", "the pause marker survives an edit"
    assert fake.jobs[0]["paused_reason"] == "Paused in Clawbits"


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
    mod.reconcile_automations_once(client, "agent", "chan", hermes_home=Path("/unused"))

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
        mod.reconcile_automations_once(client, "agent", "chan", hermes_home=Path("/unused"))
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

        def fake_pass(*_args: Any, **_kwargs: Any) -> None:
            nonlocal passes
            passes += 1
            wake.set()  # a nudge lands while the pass is running

        monkeypatch.setattr(mod, "reconcile_automations_once", fake_pass)
        task = asyncio.create_task(
            mod.run_automations_reconciler(
                object(), "agent", "chan", wake, lambda: passes < 2, hermes_home=Path("/unused")
            )
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


def test_legacy_watermark_is_read_with_and_without_uidvalidity(tmp_path) -> None:
    """The mailroom adopts a pre-journal watermark only within its own UIDVALIDITY."""
    _load_hermes_module()
    email_mod = sys.modules["hermes_clawbits_test.email_integration"]
    path = tmp_path / email_mod.EMAIL_WATERMARK_FILE
    path.write_text('{"last_uid": 42, "uidvalidity": 900}')
    assert email_mod.load_email_watermark(tmp_path) == (42, 900)
    path.write_text('{"last_uid": 7}')
    assert email_mod.load_email_watermark(tmp_path) == (7, None)
    path.write_text("not json")
    assert email_mod.load_email_watermark(tmp_path) == (None, None)


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
        self.acks: list[tuple[str, int]] = []

    def mark_read(self, channel_id: str, post_id: int) -> None:
        self.acks.append((channel_id, int(post_id)))

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
            raise RuntimeError("model died")

        adapter.turn = boom  # type: ignore[method-assign]
        await adapter.handle_message(_event("5"))
        await _drain(adapter)

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

    async def scenario() -> None:
        ready = asyncio.Event()

        async def turn(event: Any) -> Any:
            if event.message_id == "slow":
                await adapter.send("chan", "B partial", metadata={"expect_edits": True})
                ready.set()
                await asyncio.sleep(0.2)
            else:
                await ready.wait()
            return _FakeProcessingOutcome.SUCCESS

        adapter.turn = turn  # type: ignore[method-assign]
        await adapter.handle_message(_event("slow"))
        await adapter.handle_message(_event("fast"))
        slow, fast = adapter.tasks
        await fast
        assert adapter._open_streams == {"91": "chan"}, "the sibling turn's draft is still live"
        await slow

    asyncio.run(scenario())
    assert adapter._open_streams == {}, "each turn still closes its own draft"


def test_turn_stop_hard_stops_the_turn_and_keeps_its_partial_reply() -> None:
    """``turn.stop`` reaches Hermes as a bare ``/stop`` on the running turn's own
    source; its "Stopped" answer stays out of the chat, and the draft keeps what
    streamed. The cancelled turn then settles like any other (test_chat_intake.py
    ::test_control_bypass_while_busy_is_settled_as_control)."""
    mod = _load_hermes_module()
    adapter = _stream_adapter(mod)
    stops: list[Any] = []

    async def scenario() -> None:
        opened = asyncio.Event()
        stopped = asyncio.Event()
        enqueue = adapter.handle_message

        async def handle_message(event: Any) -> None:
            if event.text != "/stop":
                return await enqueue(event)
            stops.append(event)
            await adapter.send("chan", "⚡ Stopped.", reply_to=event.message_id)
            stopped.set()

        async def turn(_event: Any) -> Any:
            await adapter.send("chan", "partial", metadata={"expect_edits": True})
            opened.set()
            await stopped.wait()
            return _FakeProcessingOutcome.CANCELLED

        adapter.turn = turn  # type: ignore[method-assign]
        adapter.handle_message = handle_message  # type: ignore[method-assign]
        await adapter.handle_message(_event("7", post_id=7))
        await opened.wait()
        await adapter._stop_turns("other")
        await adapter._stop_turns("chan")
        await adapter._stop_turns("chan")
        await _drain(adapter)

    asyncio.run(scenario())
    assert [(e.text, e.message_id, e.source.chat_id) for e in stops] == [("/stop", "stop-7", "chan")]
    assert len(adapter.client.posts) == 1, "only the draft is posted, never the stop answer"
    assert adapter.client.patches[-1][2] == {"append": "\n\n_(stopped)_", "done": True}
    assert adapter._turns == {}


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


def test_legacy_read_cursor_file_is_read_leniently(tmp_path) -> None:
    _load_hermes_module()
    rc = sys.modules["hermes_clawbits_test.read_cursors"]
    assert rc.load_read_cursors(tmp_path) == {}
    path = tmp_path / rc.READ_CURSOR_FILE
    path.write_text(json.dumps({"chan": 41, "other": "7", "junk": "x"}))
    assert rc.load_read_cursors(tmp_path) == {"chan": 41, "other": 7}, "junk values are dropped"
    path.write_text("{truncated")
    assert rc.load_read_cursors(tmp_path) == {}
