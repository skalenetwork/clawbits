"""Bundled agent CLI: email ingestion/outbox subcommands, @file payloads, the answer
default, and the ``_ClawbitsCli`` wrappers that surface server error codes."""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from typing import Any

import pytest

from tests.poc.hermes_stubs import CHALLENGE_TOKEN, _FakeClawbitsApi, _load_hermes_module

CLI_PATH = Path(__file__).resolve().parents[2] / "extensions" / "hermes" / "agent-cli" / "clawbits_agent_cli.py"
EMAIL = "/api/agentic/agents/agent/email"


@pytest.fixture
def api():
    server = _FakeClawbitsApi()
    yield server
    server.close()


def _cli_module():
    spec = importlib.util.spec_from_file_location("clawbits_agent_cli_test", CLI_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _run(api: _FakeClawbitsApi, monkeypatch, *argv: str) -> dict[str, Any]:
    """Run the CLI in-process; return the last non-challenge request it made."""
    monkeypatch.setattr(sys, "argv", ["clawbits-agent", "--base-url", api.base_url, "--api-key", "k", *argv])
    _cli_module().main()
    return api.writes()[-1]


def test_cli_email_changes_peek_and_keyed_send_requests(api, monkeypatch, capsys) -> None:
    req = _run(api, monkeypatch, "email-changes", "agent", "--after-uid", "5", "--uidvalidity", "7", "--through-uid", "20", "--limit", "10")
    assert (req["method"], req["path"]) == ("GET", f"{EMAIL}/changes")
    assert req["query"] == {"after_uid": "5", "uidvalidity": "7", "through_uid": "20", "limit": "10"}
    assert _run(api, monkeypatch, "email-changes", "agent")["query"] == {}, "a first scan call omits every bound"

    req = _run(api, monkeypatch, "email-get", "agent", "3", "--peek", "--uidvalidity", "7", "--no-attachment-content")
    assert (req["method"], req["path"]) == ("GET", f"{EMAIL}/3")
    assert req["query"] == {"mark_read": "false", "uidvalidity": "7", "attachment_content": "false"}
    assert _run(api, monkeypatch, "email-get", "agent", "3")["query"] == {}, "plain email-get is unchanged"

    req = _run(api, monkeypatch, "email-send", "agent", "--json", '{"subject": "s", "message": "m"}', "--idempotency-key", "cbt1:k")
    assert (req["method"], req["path"], req["body"]) == ("POST", f"{EMAIL}/send", {"subject": "s", "message": "m"})
    assert req["headers"]["idempotency-key"] == "cbt1:k"
    assert "idempotency-key" not in _run(api, monkeypatch, "email-send", "agent", "s", "m")["headers"]

    req = _run(api, monkeypatch, "email-delivery", "agent", "cbt1:k")
    assert (req["method"], req["path"]) == ("GET", f"{EMAIL}/deliveries/cbt1%3Ak")


def test_cli_answer_defaults_from_env_and_explicit_answer_wins(api, monkeypatch, capsys) -> None:
    monkeypatch.setenv("CLAWBITS_CHALLENGE_ANSWER", "ENV_ANSWER")
    _run(api, monkeypatch, "mm-post", "chan", "--message", "hi")
    challenge, write = api.requests[-2:]
    assert challenge["path"] == "/api/agentic/auth/challenge"
    assert write["headers"]["challenge-response"] == "ENV_ANSWER"
    assert write["headers"]["session_token"] == CHALLENGE_TOKEN

    assert _run(api, monkeypatch, "mm-post", "chan", "--message", "hi", "--answer", "ARGV")["headers"]["challenge-response"] == "ARGV"

    monkeypatch.delenv("CLAWBITS_CHALLENGE_ANSWER")
    count = len(api.requests)
    assert "challenge-response" not in _run(api, monkeypatch, "mm-post", "chan", "--message", "hi")["headers"]
    assert len(api.requests) == count + 1, "no answer, no challenge fetch"


def test_manual_cli_invocations_unchanged(api, monkeypatch, tmp_path, capsys) -> None:
    activity = {"kind": "tool", "label": "Running", "tool": None}
    report = {"automations": [{"id": "a1", "state": "ok"}]}
    (tmp_path / "activity.json").write_text(json.dumps(activity), encoding="utf-8")
    (tmp_path / "report.json").write_text(json.dumps(report), encoding="utf-8")

    assert _run(api, monkeypatch, "mm-post", "chan", "--message", "hi")["body"] == {
        "message": "hi", "status": "published", "parent_post_id": None, "file_ids": [], "client_msg_uuid": None,
    }
    assert _run(api, monkeypatch, "mm-post", "chan", "--json", '{"message": "x", "status": "draft"}')["body"] == {"message": "x", "status": "draft"}
    for value in (json.dumps(activity), f"@{tmp_path / 'activity.json'}"):
        req = _run(api, monkeypatch, "mm-status", "chan", "generating", "--activity-json", value)
        assert req["body"] == {"status": "generating", "activity": activity}
    for value in (json.dumps(report), f"@{tmp_path / 'report.json'}"):
        assert _run(api, monkeypatch, "automations-state", value)["body"] == report
    assert _run(api, monkeypatch, "email-send", "agent", "subj", "body")["body"] == {"subject": "subj", "message": "body"}

    api.respond("POST", "/api/agentic/mm/channels/chan/posts", 422, {"detail": "message too long"})
    with pytest.raises(SystemExit) as exit_info:
        _run(api, monkeypatch, "mm-post", "chan", "--message", "hi")
    assert exit_info.value.code == 422
    assert capsys.readouterr().err.strip() == 'HTTP 422: {"detail": "message too long"}'


def test_wrappers_send_the_expected_requests(api) -> None:
    mod = _load_hermes_module()
    client = mod._ClawbitsCli(str(CLI_PATH), api.base_url, "k")

    client.email_changes("agent", 5, uidvalidity=7, through_uid=20, limit=10)
    assert api.writes()[-1]["query"] == {"after_uid": "5", "uidvalidity": "7", "through_uid": "20", "limit": "10"}
    client.email_changes("agent", 0)
    assert api.writes()[-1]["query"] == {"after_uid": "0", "limit": "50"}

    client.email_get("agent", 3, uidvalidity=7, mark_read=False, attachment_content=False)
    assert api.writes()[-1]["query"] == {"mark_read": "false", "uidvalidity": "7", "attachment_content": "false"}
    client.email_get("agent", 3)
    assert api.writes()[-1]["query"] == {}

    api.respond("POST", f"{EMAIL}/send", 200, {"state": "accepted", "idempotency_key": "cbt1:k"})
    assert client.email_send("agent", "s", "m", idempotency_key="cbt1:k") == {"state": "accepted", "idempotency_key": "cbt1:k"}
    req = api.writes()[-1]
    assert (req["headers"]["idempotency-key"], req["body"]) == ("cbt1:k", {"subject": "s", "message": "m"})

    api.respond("GET", f"{EMAIL}/deliveries/cbt1%3Ak", 200, {"state": "unknown"})
    assert client.email_delivery("agent", "cbt1:k") == {"state": "unknown"}


@pytest.mark.parametrize(
    ("call", "method", "path", "status", "body", "code", "detail"),
    [
        (
            lambda c: c.email_changes("agent", 3, uidvalidity=7),
            "GET", f"{EMAIL}/changes", 409,
            {"detail": {"code": "mailbox_epoch_changed", "uidvalidity": 9}},
            "mailbox_epoch_changed", {"code": "mailbox_epoch_changed", "uidvalidity": 9},
        ),
        (
            lambda c: c.email_send("agent", "s", "m", idempotency_key="k"),
            "POST", f"{EMAIL}/send", 409,
            {"detail": {"code": "idempotency_key_reused"}},
            "idempotency_key_reused", {"code": "idempotency_key_reused"},
        ),
        (
            lambda c: c.email_delivery("agent", "k"),
            "GET", f"{EMAIL}/deliveries/k", 404,
            {"detail": {"code": "delivery_not_found"}},
            "delivery_not_found", {"code": "delivery_not_found"},
        ),
        (lambda c: c.email_delivery("agent", "k"), "GET", f"{EMAIL}/deliveries/k", 404, {"detail": "Not Found"}, "not_found", None),
        (
            lambda c: c.email_changes("agent", 0),
            "GET", f"{EMAIL}/changes", 422,
            {"detail": [{"loc": ["path", "message_uid"], "input": "SYNTH_ECHO"}]},
            "validation_error", None,
        ),
        (lambda c: c.email_get("agent", 1), "GET", f"{EMAIL}/1", 503, {"detail": "Email service not configured"}, "not_configured", None),
    ],
    ids=["epoch_changed", "key_reused", "delivery_not_found", "plain_404", "old_backend_422", "not_configured"],
)
def test_wrapper_errors_expose_server_codes(api, call, method, path, status, body, code, detail) -> None:
    mod = _load_hermes_module()
    api.respond(method, path, status, body)

    with pytest.raises(mod.ClawbitsCliError) as error:
        call(mod._ClawbitsCli(str(CLI_PATH), api.base_url, "k"))

    assert (error.value.status, error.value.code, error.value.detail) == (status, code, detail)
    assert str(error.value) == f"HTTP {status}: {code}"
    assert mod.cli_client.http_status(error.value) == status
