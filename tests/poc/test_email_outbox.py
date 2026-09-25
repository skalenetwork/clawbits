"""The mailroom outbox and the send tool: keyed email sends that survive lost responses and
restarts without a second SMTP submission, honest failed/unknown states, snooze and send-policy
holds, and chat artifacts and notices posted at least once."""

from __future__ import annotations

import asyncio
import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from typing import Any

import pytest

from tests.poc.mail_fakes import CHANNEL, MAILBOX, Crash, FakeLlm, Rig, cli_error, load_plugin


@pytest.fixture
def plugin(monkeypatch) -> SimpleNamespace:
    return load_plugin(monkeypatch)


def _owner_reply(rig: Rig, count: int = 1) -> list[Any]:
    """Admit and read ``count`` verified owner mails; their email intents, still local."""
    if rig.journal.source("email", MAILBOX) is None:
        rig.journal.create_source("email", MAILBOX, rig.server.uidvalidity, enumerated=0,
                                  note="test")
    for _ in range(count):
        rig.server.deliver(subject="Question")
    rig.intake()
    rig.work()
    return rig.deliveries("email")


def _bind(plugin: SimpleNamespace, rig: Rig) -> None:
    plugin.account.bind_account(rig.account)
    plugin.mailroom.bind_mailroom(rig.mailroom)


def _in_thread(fn: Any, *args: Any) -> Any:
    with ThreadPoolExecutor(1) as pool:
        return pool.submit(fn, *args).result()


def _notices(rig: Rig, text: str = "is not re-sent automatically") -> list[str]:
    return [t for _, t in rig.server.posts if text in t]


def test_intent_is_stored_before_the_post(plugin) -> None:
    rig = Rig(plugin)
    (intent,) = _owner_reply(rig)
    assert (intent.state, intent.attempts) == ("local", 0) and intent.key.startswith("cbr1-")
    rig.server.fault("email_send", Crash())
    with pytest.raises(Crash):
        rig.outbox()
    (posting,) = rig.deliveries("email")
    assert (posting.state, posting.attempts) == ("posting", 1) and rig.server.records == {}
    rig.restart()
    rig.outbox()
    (sent,) = rig.deliveries("email")
    assert sent.state == "accepted" and len(rig.server.smtp) == 1
    assert rig.journal.get_meta("idempotent_send") == "1", "delivery_not_found proves keys"


@pytest.mark.parametrize("proven", [False, True])
def test_lost_response_is_resolved_under_the_same_key(plugin, proven) -> None:
    rig = Rig(plugin)
    (intent,) = _owner_reply(rig)
    if proven:
        rig.journal.set_meta("idempotent_send", "1")
        rig.restart()
    rig.server.fault("email_send", cli_error(None, "timeout"), after=True)
    rig.outbox()
    assert rig.deliveries("email")[0].state == "posting", "the server acted; we cannot tell yet"
    rig.restart()
    rig.outbox()
    (sent,) = rig.deliveries("email")
    assert sent.state == "accepted" and sent.remote_id == "1"
    assert len(rig.server.smtp) == 1 and len(rig.server.records) == 1
    sends = rig.server.ops("email_send")
    assert {kw["idempotency_key"] for _, kw in sends} == {intent.key}
    assert len(sends) == (2 if proven else 1)
    assert len(rig.server.ops("email_delivery")) == (0 if proven else 1)


def test_legacy_server_ambiguous_post_becomes_unknown(plugin) -> None:
    rig = Rig(plugin)
    rig.server.honours_keys = False
    (first,) = _owner_reply(rig)
    rig.server.fault("email_send", cli_error(502, "http_error"), after=True)
    rig.outbox()
    rig.outbox()
    for _ in range(3):
        rig.outbox()
    unknown = rig.deliveries("email")[0]
    assert (unknown.state, unknown.note) == ("unknown", "idempotency_unsupported")
    assert len(rig.server.ops("email_send")) == 1 and len(rig.server.smtp) == 1
    (notice,) = _notices(rig)
    assert f"inbox resend {first.key}" in notice and "[Email unknown]" in notice

    _owner_reply(rig)
    rig.outbox()
    assert rig.deliveries("email")[1].state == "accepted", "a plain 200 is SMTP acceptance"
    assert rig.journal.get_meta("idempotent_send") is None


def test_rollback_to_a_keyless_backend_withdraws_the_proof(plugin) -> None:
    rig = Rig(plugin)
    rig.journal.set_meta("idempotent_send", "1")
    rig.restart()
    rig.server.honours_keys = False
    _owner_reply(rig)
    rig.outbox()
    assert rig.deliveries("email")[0].state == "accepted"
    assert rig.journal.get_meta("idempotent_send") == "0", "a reply without the key"
    rig.restart()
    second = _owner_reply(rig)[1]
    rig.server.fault("email_send", cli_error(None, "timeout"), after=True)
    rig.outbox()
    rig.outbox()
    unknown = rig.deliveries("email")[1]
    assert (unknown.state, unknown.note) == ("unknown", "idempotency_unsupported")
    sends = [kw["idempotency_key"] for _, kw in rig.server.ops("email_send")]
    assert sends.count(second.key) == 1 and len(rig.server.smtp) == 2, "no second SMTP send"
    assert len(_notices(rig)) == 1


def test_status_poll_after_a_rollback_becomes_unknown(plugin) -> None:
    rig = Rig(plugin)
    (intent,) = _owner_reply(rig)
    rig.server.outcomes = ["attempting"]
    rig.outbox()
    rig.server.honours_keys = False
    rig.journal.update_delivery(intent.key, "attempting")  # due now
    rig.outbox()
    (unknown,) = rig.deliveries("email")
    assert (unknown.state, unknown.note) == ("unknown", "idempotency_unsupported")
    assert rig.journal.get_meta("idempotent_send") == "0" and len(_notices(rig)) == 1


def test_idempotency_conflict_marks_failed(plugin) -> None:
    rig = Rig(plugin)
    _owner_reply(rig)
    rig.server.fault("email_send", cli_error(409, "idempotency_key_reused"))
    rig.outbox()
    rig.outbox()
    (failed,) = rig.deliveries("email")
    assert (failed.state, failed.note) == ("failed", "idempotency_key_reused")
    assert len(_notices(rig)) == 1 and len(rig.server.ops("email_send")) == 1


def test_definitive_and_retryable_post_failures(plugin, monkeypatch) -> None:
    rig = Rig(plugin)
    _owner_reply(rig)
    rig.server.fault("email_send", cli_error(422, "validation_error"))
    rig.outbox()
    assert rig.deliveries("email")[0].state == "failed"

    _owner_reply(rig)
    rig.server.fault("email_send", cli_error(402, "payment_required"))
    rig.outbox()
    held = rig.deliveries("email")[1]
    assert (held.state, held.note, held.attempts) == ("local", "payment_required", 1)
    assert held.not_before > time.time() + 30, "backs off before the same key is tried again"
    monkeypatch.setattr(plugin.mailroom, "_backoff", lambda attempt: 0.0)
    rig.journal.update_delivery(held.key, "local")
    rig.server.fault("email_send", cli_error(402, "payment_required"), times=4)
    for _ in range(4):
        rig.outbox()
    final = rig.deliveries("email")[1]
    assert (final.state, final.note, final.attempts) == ("failed", "payment_required", 5)
    assert len(rig.server.smtp) == 0


def test_send_disabled_holds_local_intents(plugin) -> None:
    rig = Rig(plugin)
    (intent,) = _owner_reply(rig)
    rig.restart(send_email=False)
    rig.outbox()
    (held,) = rig.deliveries("email")
    assert (held.state, held.note) == ("local", "send_disabled")
    assert held.not_before > time.time() + 600 and rig.server.ops("email_send") == []
    assert rig.deliveries("chat")[0].state == "posted", "the artifact still reaches chat"
    _bind(plugin, rig)
    assert plugin.email_integration._email_tool_available() is False
    result = json.loads(plugin.email_integration._send_email_tool({"subject": "s", "message": "m"}))
    assert result["code"] == "email_send_disabled"


def test_send_disabled_only_looks_up_an_ambiguous_post(plugin) -> None:
    rig = Rig(plugin)
    rig.journal.set_meta("idempotent_send", "1")
    (intent,) = _owner_reply(rig)
    rig.server.fault("email_send", cli_error(None, "timeout"))
    rig.outbox()
    rig.restart(send_email=False)
    rig.outbox()
    assert len(rig.server.ops("email_send")) == 1, "no new submission while sending is off"
    assert rig.deliveries("email")[0].state == "local" and rig.server.smtp == []


def test_snooze_holds_new_posts_but_polls_status(plugin) -> None:
    rig = Rig(plugin)
    _owner_reply(rig)
    rig.server.outcomes = ["attempting"]
    rig.outbox()
    first = rig.deliveries("email")[0]
    assert first.state == "attempting"
    rig.journal.update_delivery(first.key, "attempting")  # due now
    _owner_reply(rig)
    posts, sends = len(rig.server.posts), len(rig.server.ops("email_send"))
    rig.snoozed = True
    rig.outbox()
    assert len(rig.server.ops("email_send")) == sends and len(rig.server.posts) == posts
    assert [args[1] for args, _ in rig.server.ops("email_delivery")] == [first.key]
    assert rig.subsystem("outbox")["state"] == "snoozed"

    rig.server.records[first.key]["state"] = "accepted"
    rig.journal.update_delivery(first.key, "attempting")
    rig.snoozed = False
    rig.outbox()
    assert [d.state for d in rig.deliveries("email")] == ["accepted", "accepted"]
    assert [d.state for d in rig.deliveries("chat")] == ["posted", "posted"]


def test_retry_wait_is_resumed_with_the_same_key(plugin) -> None:
    rig = Rig(plugin)
    (intent,) = _owner_reply(rig)
    rig.server.outcomes = ["retry_wait"]
    rig.outbox()
    waiting = rig.deliveries("email")[0]
    assert waiting.state == "retry_wait" and waiting.not_before > time.time()
    rig.journal.update_delivery(intent.key, "retry_wait")  # next_attempt_at passed
    rig.outbox()
    assert rig.deliveries("email")[0].state == "accepted"
    sends = rig.server.ops("email_send")
    assert [kw["idempotency_key"] for _, kw in sends] == [intent.key, intent.key]
    assert rig.server.records[intent.key]["attempts"] == 2 and len(rig.server.smtp) == 1


def test_chat_artifact_is_chunked_and_posted_at_least_once(plugin) -> None:
    rig = Rig(plugin, llm=FakeLlm({"summary": "Long.", "reply": "word " * 1500}))
    _owner_reply(rig)
    rig.server.fault("post_message", Crash(), after=True)
    with pytest.raises(Crash):
        rig.outbox()
    assert rig.deliveries("chat")[0].state == "posting" and len(rig.server.posts) == 1
    rig.restart()
    rig.outbox()
    (artifact,) = rig.deliveries("chat")
    chunks = rig.server.posts[1:]
    assert len(chunks) >= 2 and all(len(text) <= 4000 for _, text in chunks)
    assert (artifact.state, artifact.remote_id, artifact.attempts) == ("posted", "p2", 2)
    assert {channel for channel, _ in rig.server.posts} == {CHANNEL}


def test_notices_are_combined_per_pass(plugin) -> None:
    rig = Rig(plugin)
    rig.journal.create_source("email", MAILBOX, 7, enumerated=0, note="test")
    for n in range(3):
        rig.server.deliver(subject=f"Big {n}", size=plugin.email_reader.MAX_MESSAGE_BYTES + 1)
    rig.intake()
    rig.work()
    rig.outbox()
    (post,) = rig.server.posts
    assert post[1].count("[Email waiting for review]") == 3
    assert {d.remote_id for d in rig.deliveries("chat")} == {"p1"}
    assert all(d.subject == "notice" and d.state == "posted" for d in rig.deliveries("chat"))


def test_unknown_operator_channel_is_reported_not_skipped(plugin) -> None:
    rig = Rig(plugin)
    rig.channel = None
    _owner_reply(rig)
    rig.outbox()
    (chat,) = rig.deliveries("chat")
    assert (chat.state, chat.target) == ("local", None) and rig.server.posts == []
    assert rig.subsystem("outbox")["error"] == "operator_channel_unknown"
    rig.channel = CHANNEL
    rig.outbox()
    assert rig.deliveries("chat")[0].state == "posted" and rig.subsystem("outbox")["error"] is None


def test_queued_notice_survives_a_restart(plugin) -> None:
    rig = Rig(plugin)
    rig.server.fault("email_send", cli_error(402, "payment_required"))
    key = rig.mailroom.send_tool_email("Report", "done")["idempotency_key"]
    rig.restart()
    rig.outbox()
    rig.restart()
    rig.outbox()
    (notice,) = _notices(rig)
    assert f"inbox resend {key}" in notice and "[Email failed]" in notice


def test_failed_chat_post_backs_off_then_fails(plugin, monkeypatch) -> None:
    monkeypatch.setattr(plugin.mailroom, "_backoff", lambda attempt: 0.0)
    rig = Rig(plugin)
    _owner_reply(rig)
    rig.server.fault("post_message", cli_error(403, "forbidden"), times=5)
    for attempt in range(1, 5):
        rig.outbox()
        chat = rig.deliveries("chat")[0]
        assert (chat.state, chat.note, chat.attempts) == ("local", "forbidden", attempt)
    rig.outbox()
    assert rig.deliveries("chat")[0].state == "failed"
    assert rig.subsystem("outbox")["error"] == "http_403"


def test_resend_creates_a_new_version_key(plugin) -> None:
    rig = Rig(plugin)
    rig.server.honours_keys = False
    (intent,) = _owner_reply(rig)
    rig.server.fault("email_send", cli_error(None, "timeout"))
    rig.outbox()
    rig.outbox()
    assert rig.deliveries("email")[0].state == "unknown"
    rig.server.honours_keys = True
    new = rig.journal.resend(intent.key)
    assert new.key != intent.key and new.version == 2 and new.key.startswith("cbr1-")
    rig.outbox()
    states = {d.key: d.state for d in rig.deliveries("email")}
    assert states == {intent.key: "unknown", new.key: "accepted"}
    assert [kw["idempotency_key"] for _, kw in rig.server.ops("email_send")][-1] == new.key


# --- send tool ------------------------------------------------------------------


def test_send_tool_fits_the_body_and_returns_the_delivery_state(plugin) -> None:
    rig = Rig(plugin)
    _bind(plugin, rig)
    ei = plugin.email_integration
    assert ei._email_tool_available() is True
    args = {"subject": "re: Hi", "message": "x" * 40_000}
    result = json.loads(_in_thread(ei._send_email_tool, args))
    assert result["state"] == "accepted" and result["idempotency_key"].startswith("cbt1-")
    ((agent, subject, body, headers), kwargs), = rig.server.ops("email_send")
    assert (agent, subject, headers) == ("agent1", "re: Hi", None)
    assert len(body) <= 10_000 and kwargs["idempotency_key"] == result["idempotency_key"]
    assert ei.EMAIL_TOOL_SCHEMA["name"] == "clawbits_send_email"
    assert "function" not in ei.EMAIL_TOOL_SCHEMA, "Hermes wraps the schema itself"


def test_send_tool_stores_its_key_before_the_post_and_reuses_it(plugin) -> None:
    rig = Rig(plugin)
    rig.server.fault("email_send", Crash())
    with pytest.raises(Crash):
        rig.mailroom.send_tool_email("Report", "done")
    (stored,) = rig.deliveries("email")
    assert stored.key.startswith("cbt1-") and stored.state == "posting"
    assert stored.item_id is None and rig.server.records == {}

    rig.journal.set_meta("idempotent_send", "1")
    rig.restart()
    _bind(plugin, rig)
    rig.server.fault("email_send", cli_error(None, "timeout"), after=True)
    result = json.loads(_in_thread(plugin.email_integration._send_email_tool,
                                   {"subject": "Report", "message": "done"}))
    assert result["state"] == "accepted"
    sends = rig.server.ops("email_send")[-2:]
    assert [kw["idempotency_key"] for _, kw in sends] == [result["idempotency_key"]] * 2
    assert len(rig.server.smtp) == 1, "one same-key retry, one message"


def test_send_tool_without_proven_keys_looks_the_key_up(plugin) -> None:
    rig = Rig(plugin)
    rig.server.fault("email_send", cli_error(None, "timeout"), after=True)
    result = _in_thread(rig.mailroom.send_tool_email, "Report", "done")
    assert result["state"] == "accepted" and len(rig.server.ops("email_send")) == 1
    assert len(rig.server.ops("email_delivery")) == 1 and len(rig.server.smtp) == 1


def test_unresolved_tool_send_is_left_to_the_outbox_after_its_grace(plugin) -> None:
    rig = Rig(plugin)
    rig.server.fault("email_send", cli_error(None, "timeout"))
    rig.server.fault("email_delivery", cli_error(None, "timeout"))
    result = rig.mailroom.send_tool_email("Report", "done")
    assert result["state"] == "posting"
    rig.outbox()
    assert len(rig.server.ops("email_send")) == 1, "the tool owns its POST during the grace"
    rig.journal.update_delivery(result["idempotency_key"], "posting")  # grace over
    rig.outbox()
    assert rig.deliveries("email")[0].state == "accepted" and len(rig.server.smtp) == 1


def test_send_tool_definitive_failure_is_reported_not_retried(plugin) -> None:
    rig = Rig(plugin)
    rig.server.fault("email_send", cli_error(402, "payment_required"))
    result = rig.mailroom.send_tool_email("Report", "done")
    assert (result["state"], result["error"]) == ("failed", "payment_required")
    rig.outbox()
    assert len(rig.server.ops("email_send")) == 1


def test_send_tool_typed_errors(plugin, monkeypatch) -> None:
    ei = plugin.email_integration
    monkeypatch.delenv("CLAWBITS_API_KEY", raising=False)
    monkeypatch.delenv("CLAWBITS_AGENT_ID", raising=False)
    assert json.loads(ei._send_email_tool({}))["code"] == "clawbits_unavailable"
    rig = Rig(plugin)
    plugin.account.bind_account(rig.account)
    assert ei._email_tool_available() is False, "no mailroom, no tool"
    assert json.loads(ei._send_email_tool({"subject": "s", "message": "m"}))["code"] == (
        "clawbits_unavailable"
    )
    plugin.mailroom.bind_mailroom(rig.mailroom)
    monkeypatch.setattr(rig.mailroom, "send_tool_email",
                        lambda *a: (_ for _ in ()).throw(OSError("disk full")))
    error = json.loads(ei._send_email_tool({"subject": "s", "message": "m"}))
    assert error == {"error": "The email could not be recorded for sending", "code": "OSError"}
    assert rig.server.ops("email_send") == []


def test_send_tool_is_thread_safe_alongside_the_outbox(plugin) -> None:
    rig = Rig(plugin)
    _owner_reply(rig, count=3)
    results: list[dict[str, Any]] = []
    start = threading.Barrier(9)

    def send(n: int) -> None:
        start.wait()
        results.append(rig.mailroom.send_tool_email(f"Note {n}", "body"))

    async def main() -> None:
        threads = [threading.Thread(target=send, args=(n,)) for n in range(8)]
        for thread in threads:
            thread.start()
        start.wait()
        await rig.mailroom._outbox_pass()
        await asyncio.gather(*(asyncio.to_thread(t.join) for t in threads))

    asyncio.run(main())
    assert len({r["idempotency_key"] for r in results}) == 8
    assert all(r["state"] == "accepted" for r in results)
    assert all(d.state == "accepted" for d in rig.deliveries("email"))
    assert len(rig.server.smtp) == 11
