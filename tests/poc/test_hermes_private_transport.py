"""Profile binding and private transport (package B).

Private payloads reach the agent CLI as 0600 ``@file`` references, never argv;
the child gets an allowlisted environment plus only the owning account's
credentials; failures keep a status and a stable code but never the response
body. Most tests run the real agent CLI against a local fake API through a
probe wrapper that records the child's argv, environment and payload files.
"""

from __future__ import annotations

import asyncio
import contextvars
import json
import logging
import re
import socket
import sys
import tempfile
import threading
import time
import types
from pathlib import Path
from typing import Any

import pytest

from tests.poc.hermes_stubs import (
    CHALLENGE_TOKEN,
    _FakeClawbitsApi,
    _FakePlatformConfig,
    _load_hermes_module,
)

CLI_PATH = Path(__file__).resolve().parents[2] / "extensions" / "hermes" / "agent-cli" / "clawbits_agent_cli.py"
KEY = "SYNTH_OWNER_KEY"
SYNTH = "SYNTHPRIV payload é🦀"
SERVICE_SECRETS = {"SERVICE_DB_PASSWORD": "SYNTH_DB_PW", "OPENROUTER_API_KEY": "SYNTH_OR_KEY"}
ALLOWED_ENV = {
    "PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR", "SYSTEMROOT",
    "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "no_proxy", "all_proxy",
    "CLAWBITS_API_KEY", "CLAWBITS_CHALLENGE_ANSWER", "CLAWBITS_USER_AGENT",
}
POSTS = "/api/agentic/mm/channels/chan/posts"

_PROBE = """
import json, os, runpy, stat, sys, uuid
files = [
    {{"name": os.path.basename(a[1:]), "mode": stat.S_IMODE(os.stat(a[1:]).st_mode)}}
    for a in sys.argv[1:] if a.startswith("@") and os.path.exists(a[1:])
]
record = {{"argv": sys.argv[1:], "env": dict(os.environ), "files": files}}
with open(os.path.join({out!r}, uuid.uuid4().hex + ".json"), "w") as handle:
    json.dump(record, handle)
sys.argv = [{cli!r}, *sys.argv[1:]]
runpy.run_path({cli!r}, run_name="__main__")
"""


class _Probe:
    """An agent-CLI stand-in that records each child's argv, env and @file modes, then runs the real CLI."""

    def __init__(self, tmp_path: Path) -> None:
        self.out = tmp_path / "probe"
        self.out.mkdir()
        self.path = str(tmp_path / "probe_cli.py")
        Path(self.path).write_text(_PROBE.format(out=str(self.out), cli=str(CLI_PATH)), encoding="utf-8")

    def records(self) -> list[dict[str, Any]]:
        found = sorted(self.out.glob("*.json"), key=lambda p: p.stat().st_mtime_ns)
        return [json.loads(p.read_text()) for p in found]


@pytest.fixture
def api():
    server = _FakeClawbitsApi()
    yield server
    server.close()


@pytest.fixture
def probe(tmp_path) -> _Probe:
    return _Probe(tmp_path)


def _account(mod, api: _FakeClawbitsApi, **fields: Any):
    values = {"hermes_home": Path(tempfile.gettempdir()), "base_url": api.base_url, "agent_id": "agent", "api_key": KEY}
    return mod.ClawbitsAccount(**{**values, **fields})


def _logs(caplog) -> str:
    formatter = logging.Formatter("%(message)s")
    return "\n".join(formatter.format(record) for record in caplog.records)


def _adapter(mod, api: _FakeClawbitsApi, cli_path: str = str(CLI_PATH), **extra: Any):
    cfg = _FakePlatformConfig(extra={"api_key": KEY, "agent_id": "agent", "base_url": api.base_url, "agent_cli": cli_path, **extra})
    return mod.ClawbitsAdapter(cfg)


_CASES = {
    "post": (
        lambda c: c.post_message("chan", SYNTH),
        "POST", POSTS, {"message": SYNTH, "status": "published", "file_ids": []},
    ),
    "threaded_post": (
        lambda c: c.post_message("chan", SYNTH, 5, "tr_1"),
        "POST", POSTS, {"message": SYNTH, "status": "published", "file_ids": [], "parent_post_id": 5, "trace_id": "tr_1"},
    ),
    "stream_patch": (
        lambda c: c.patch_message("chan", "9", replace=SYNTH, done=True),
        "PATCH", f"{POSTS}/9", {"replace": SYNTH, "done": True},
    ),
    "status_activity": (
        lambda c: c.set_status("chan", "generating", {"kind": "tool", "label": SYNTH, "tool": None}),
        "POST", "/api/agentic/mm/channels/chan/status",
        {"status": "generating", "activity": {"kind": "tool", "label": SYNTH, "tool": None}},
    ),
    "email_send": (
        lambda c: c.email_send("agent", f"subject {SYNTH}", SYNTH, {"In-Reply-To": "<a@b>"}),
        "POST", "/api/agentic/agents/agent/email/send",
        {"subject": f"subject {SYNTH}", "message": SYNTH, "headers": {"In-Reply-To": "<a@b>"}},
    ),
    "automations_state": (
        lambda c: c.automations_state({"automations": [{"id": "a1", "prompt": SYNTH}]}),
        "POST", "/api/agentic/automations/state", {"automations": [{"id": "a1", "prompt": SYNTH}]},
    ),
}


@pytest.mark.parametrize("case", list(_CASES))
def test_private_payloads_reach_server_unchanged_and_stay_off_argv_env_logs(case, api, probe, monkeypatch, caplog) -> None:
    caplog.set_level(logging.DEBUG)
    for name, value in SERVICE_SECRETS.items():
        monkeypatch.setenv(name, value)
    monkeypatch.setenv("CLAWBITS_CHALLENGE_ANSWER", "SYNTH_LAUNCH_ANSWER")
    mod = _load_hermes_module()
    call, method, path, expected = _CASES[case]

    call(mod._ClawbitsCli.for_account(_account(mod, api), probe.path))

    request = api.writes()[-1]
    assert (request["method"], request["path"], request["body"]) == (method, path, expected)
    assert request["headers"]["authorization"] == f"Bearer {KEY}"
    assert "challenge-response" not in request["headers"], "the launch env's answer is never inherited"
    (record,) = probe.records()
    assert not any("SYNTHPRIV" in arg for arg in record["argv"])
    assert set(record["env"]) <= ALLOWED_ENV
    assert not set(SERVICE_SECRETS.values()) & set(record["env"].values())
    assert record["files"] and all(f["mode"] == 0o600 for f in record["files"])
    assert "SYNTHPRIV" not in _logs(caplog)


def test_private_file_is_0600_payload_free_and_removed_on_success_error_and_cancel(api, probe, tmp_path, monkeypatch) -> None:
    scratch = tmp_path / "tmpdir"
    scratch.mkdir()
    monkeypatch.setenv("TMPDIR", str(scratch))
    monkeypatch.setattr(tempfile, "tempdir", None)
    mod = _load_hermes_module()
    client = mod._ClawbitsCli(probe.path, api.base_url, KEY)

    def leftovers() -> list[Path]:
        return list(scratch.glob("clawbits-*.json"))

    client.post_message("chan", SYNTH)
    (file,) = probe.records()[-1]["files"]
    assert file["mode"] == 0o600
    assert re.fullmatch(r"clawbits-[^/]*\.json", file["name"]) and "SYNTH" not in file["name"]
    assert leftovers() == []

    for status in (500, 422):
        api.respond("POST", POSTS, status, {"detail": SYNTH})
        with pytest.raises(mod.ClawbitsCliError):
            client.post_message("chan", SYNTH)
        assert leftovers() == []

    with pytest.raises(RuntimeError), mod.cli_client.private_json_file({"message": SYNTH}):
        raise RuntimeError("inside the with-block")
    assert leftovers() == []

    api.responses.clear()
    api.gate = threading.Event()

    async def cancel_mid_request() -> None:
        seen = len(api.requests)
        task = asyncio.ensure_future(asyncio.to_thread(client.post_message, "chan", SYNTH))
        while len(api.requests) == seen:
            await asyncio.sleep(0.02)
        assert len(leftovers()) == 1, "the payload file exists while the request is in flight"
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        api.gate.set()

    asyncio.run(cancel_mid_request())  # joins the worker thread before returning
    assert leftovers() == []


def test_cli_errors_keep_status_and_code_but_drop_body_urls_and_argv(api, caplog) -> None:
    caplog.set_level(logging.DEBUG)
    mod = _load_hermes_module()
    cli = mod.cli_client
    client = mod._ClawbitsCli(str(CLI_PATH), api.base_url, KEY)
    echo = {"detail": [{"loc": ["body", "message"], "msg": "too long", "input": "SYNTH_ECHO"}]}

    api.respond("POST", POSTS, 422, echo)
    with pytest.raises(mod.ClawbitsCliError) as error:
        client.post_message("chan", "SYNTH_ECHO")
    assert str(error.value) == "HTTP 422: validation_error"
    assert cli.http_status(error.value) == 422
    assert error.value.detail is None

    api.respond("GET", "/api/agentic/agents/agent/email/count", 503, {"detail": "Email send service not configured"})
    with pytest.raises(mod.ClawbitsCliError) as error:
        client.email_count("agent")
    assert (error.value.status, error.value.code) == (503, "not_configured")

    api.respond("GET", "/api/agentic/mm/channels", 426, {"detail": {"code": "plugin_outdated", "min_plugin_version": "9.9.9"}})
    with pytest.raises(mod.ClawbitsCliError) as error:
        client.list_channels()
    assert (error.value.status, error.value.code) == (426, "plugin_outdated")

    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        closed_port = sock.getsockname()[1]
    with pytest.raises(mod.ClawbitsCliError) as error:
        mod._ClawbitsCli(str(CLI_PATH), f"http://127.0.0.1:{closed_port}", KEY).list_channels()
    assert str(error.value) == "agent-cli: URLError"

    api.delay = 3
    with pytest.raises(mod.ClawbitsCliError) as error:
        cli._run_agent_cli(str(CLI_PATH), api.base_url, "mm-posts", "chan", api_key=KEY, timeout=1)
    assert str(error.value) == "agent-cli: timeout"
    api.delay = 0

    adapter = _adapter(mod, api)
    result = asyncio.run(adapter.send("chan", "SYNTH_ECHO reply"))
    assert (result.success, result.error) == (False, "HTTP 422: validation_error")

    api.respond("PATCH", f"{POSTS}/9", 422, echo)
    result = asyncio.run(adapter.edit_message("chan", "9", "SYNTH_ECHO reply", finalize=True))
    assert (result.success, result.error) == (False, "HTTP 422: validation_error")

    logs = _logs(caplog)
    assert "SYNTH_ECHO" not in logs and api.base_url not in logs


@pytest.mark.parametrize(
    ("returncode", "stderr", "expected"),
    [
        (2, "usage: clawbits_agent_cli.py [-h]\nclawbits_agent_cli.py: error: invalid int value: 'SYNTH'\n", "agent-cli: usage_error"),
        (1, "Traceback (most recent call last):\n  File \"x\"\nurllib.error.URLError: <urlopen error SYNTH>\n", "agent-cli: URLError"),
        (1, "Traceback (most recent call last):\nValueError: first line\nSYNTH_TOKEN\n", "agent-cli: exit_1"),
        (1, "clawbits_agent_cli.py: SYNTH\n", "agent-cli: exit_1"),
        (1, "unknown command: SYNTH\n", "agent-cli: exit_1"),
        (1, "HTTP 503: <html>SYNTH</html>\n", "HTTP 503: unavailable"),
    ],
)
def test_cli_error_codes_are_exception_names_or_exit_status(returncode: int, stderr: str, expected: str) -> None:
    mod = _load_hermes_module()
    assert str(mod.cli_client._cli_error(returncode, stderr)) == expected


def test_client_user_agent_is_the_owning_accounts_not_the_active_scopes(api, monkeypatch) -> None:
    monkeypatch.setenv("CLAWBITS_USER_AGENT", "SYNTH_SCOPE_UA/1")
    mod = _load_hermes_module()

    mod._ClawbitsCli.for_account(_account(mod, api)).list_channels()
    assert api.requests[-1]["headers"]["user-agent"] == "clawbits-hermes-plugin"
    mod._ClawbitsCli.for_account(_account(mod, api, user_agent="owner/1")).list_channels()
    assert api.requests[-1]["headers"]["user-agent"] == "owner/1"


def test_child_env_is_allowlist_plus_owner_credentials(api, probe, monkeypatch) -> None:
    ambient = {
        **SERVICE_SECRETS,
        "GITHUB_TOKEN": "SYNTH_GH",
        "AWS_SECRET_ACCESS_KEY": "SYNTH_AWS",
        "PYTHONPATH": "/synth/pythonpath",
        "HERMES_HOME": "/synth/home",
        "SSL_CERT_FILE": "/.msb/tls/ca.pem",
        "HTTPS_PROXY": "http://proxy.invalid:3128",
        "CLAWBITS_API_KEY": "SYNTH_LAUNCH_KEY",
    }
    for name, value in ambient.items():
        monkeypatch.setenv(name, value)
    mod = _load_hermes_module()

    mod._ClawbitsCli.for_account(_account(mod, api), probe.path).list_channels()
    env = probe.records()[-1]["env"]
    assert env["SSL_CERT_FILE"] == "/.msb/tls/ca.pem"
    assert env["HTTPS_PROXY"] == "http://proxy.invalid:3128"
    assert env["CLAWBITS_API_KEY"] == KEY
    for name in ("SERVICE_DB_PASSWORD", "OPENROUTER_API_KEY", "GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY", "PYTHONPATH", "HERMES_HOME"):
        assert name not in env

    mod.cli_client._run_agent_cli(probe.path, api.base_url, "version-check")
    assert "CLAWBITS_API_KEY" not in probe.records()[-1]["env"], "pre-enrollment calls carry no key"
    assert "authorization" not in api.requests[-1]["headers"]


def test_challenge_answer_rides_env_not_argv(api, probe) -> None:
    mod = _load_hermes_module()
    client = mod._ClawbitsCli.for_account(_account(mod, api, answer="SYNTH_ANSWER"), probe.path)

    client.post_message("chan", "hi")

    argv = probe.records()[-1]["argv"]
    assert "--answer" not in argv and not any("SYNTH_ANSWER" in arg for arg in argv)
    challenge, write = api.requests[-2:]
    assert (challenge["method"], challenge["path"]) == ("GET", "/api/agentic/auth/challenge")
    assert write["path"] == POSTS
    assert write["headers"]["challenge-response"] == "SYNTH_ANSWER"
    assert write["headers"]["session_token"] == CHALLENGE_TOKEN


def _statuses(adapter, api: _FakeClawbitsApi, *phrases: str | None) -> list[dict[str, Any]]:
    """Drive set_status_text from a Hermes worker thread; return each status request body."""

    async def run() -> list[dict[str, Any]]:
        adapter._loop = asyncio.get_running_loop()
        bodies = []
        for phrase in phrases:
            seen = len(api.requests)
            await asyncio.to_thread(adapter.set_status_text, "chan", phrase)
            deadline = time.monotonic() + 10
            while len(api.requests) == seen and time.monotonic() < deadline:
                await asyncio.sleep(0.02)
            bodies.append(api.requests[-1]["body"])
        return bodies

    return asyncio.run(run())


def test_tool_activity_is_action_only_by_default(api, probe) -> None:
    mod = _load_hermes_module()
    adapter = _adapter(mod, api, probe.path)

    bodies = _statuses(
        adapter,
        api,
        "is running cat SYNTH_ARG…",
        "is reading /home/u/.ssh/SYNTH_ARG…",
        "is searching the web for SYNTH_ARG…",
        "is using mcp_x…",
        "garbage SYNTH_ARG",
        None,
    )

    tool = [
        ("Running", None), ("Reading", None), ("Searching", None), ("Using mcp_x", "mcp_x"), ("Working", None),
    ]
    assert [body["activity"] for body in bodies[:-1]] == [{"kind": "tool", "label": label, "tool": name} for label, name in tool]
    assert bodies[-1] == {"status": "generating"}, "None clears the activity lane"
    assert "SYNTH_ARG" not in json.dumps(api.requests)
    assert not any("SYNTH_ARG" in arg for record in probe.records() for arg in record["argv"])


def test_activity_preview_opt_in_is_redacted_and_fails_closed(monkeypatch) -> None:
    mod = _load_hermes_module()
    activity = mod.adapter._tool_activity
    monkeypatch.delitem(sys.modules, "agent.redact", raising=False)

    assert activity("is searching the web for SYNTH…", preview=True)["label"] == "[redaction-unavailable]"
    for phrase, label in (
        ("is running cat SYNTH…", "Running"),
        ("is reading /x/SYNTH…", "Reading"),
        ("is browsing https://h/SYNTH…", "Browsing"),
    ):
        assert activity(phrase, preview=True) == {"kind": "tool", "label": label, "tool": None}

    redact = types.ModuleType("agent.redact")
    redact.redact_sensitive_text = lambda text, **_: text.replace("sk-SYNTH", "***")
    redact.redact_for_egress = lambda text: text
    monkeypatch.setitem(sys.modules, "agent.redact", redact)
    assert activity("is searching the web for key sk-SYNTH…", preview=True)["label"] == "Searching the web for key ***"
    assert activity("is searching the web for key sk-SYNTH…", preview=False)["label"] == "Searching"


def test_signup_style_calls_stay_compatible(api, probe, monkeypatch) -> None:
    """signup.py calls ``_run_agent_cli(cli, base, *args, api_key=...)`` and reads the parsed result."""
    monkeypatch.setenv("CLAWBITS_USER_AGENT", "synth-agent/1")
    mod = _load_hermes_module()
    api.respond("GET", "/api/agentic/agents/agent/info", 200, {"operator_id": 7})

    assert mod.cli_client._run_agent_cli(probe.path, api.base_url, "agent-info", "agent", api_key=KEY) == {"operator_id": 7}
    assert api.requests[-1]["headers"]["user-agent"] == "synth-agent/1"


# --- profile binding ----------------------------------------------------------


def test_account_prefers_config_then_scoped_settings(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("CLAWBITS_API_KEY", "env_key")
    monkeypatch.setenv("CLAWBITS_AGENT_ID", "env_agent")
    monkeypatch.setenv("CLAWBITS_ENDPOINT", "https://env.example/")
    monkeypatch.setenv("CLAWBITS_CHALLENGE_ANSWER", "SYNTH_ANSWER")
    monkeypatch.setenv("CLAWBITS_ACTIVITY_PREVIEW", "yes")
    mod = _load_hermes_module()

    account = mod.resolve_account(_FakePlatformConfig(api_key="cfg_key", extra={"agent_id": "yaml_agent", "email_send_enabled": False}))

    assert (account.api_key, account.agent_id, account.base_url) == ("cfg_key", "yaml_agent", "https://env.example")
    assert (account.receive_email, account.send_email, account.activity_preview) == (True, False, True)
    assert account.usable
    assert "cfg_key" not in repr(account) and "SYNTH_ANSWER" not in repr(account)


def test_routed_profile_never_reads_the_launch_env(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("CLAWBITS_API_KEY", "SYNTH_LAUNCH_KEY")
    monkeypatch.setenv("CLAWBITS_AGENT_ID", "launch_agent")
    mod = _load_hermes_module()
    home_b = tmp_path / "profiles" / "b"
    monkeypatch.setattr(sys.modules["hermes_constants"], "get_hermes_home_override", lambda: str(home_b))
    monkeypatch.setattr(sys.modules["agent.secret_scope"], "current_secret_scope", lambda: {"CLAWBITS_AGENT_ID": "agent_b"})

    account = mod.resolve_account()
    assert (account.api_key, account.agent_id, account.hermes_home) == ("", "agent_b", home_b)
    assert not account.usable
    assert mod._env_enablement() is None
    assert mod.active_account() is None
    assert mod._email_tool_available() is False
    assert json.loads(mod._send_email_tool({"subject": "s", "message": "m"}))["code"] == "clawbits_unavailable"

    adapter = mod.ClawbitsAdapter(_FakePlatformConfig(extra={}))
    assert asyncio.run(adapter.connect()) is False
    assert adapter.fatal_error[0] == "clawbits_not_configured" and adapter.fatal_error[2] is False


def test_bound_account_serves_tools_until_unbound(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("CLAWBITS_API_KEY", "env_key")
    monkeypatch.setenv("CLAWBITS_AGENT_ID", "env_agent")
    mod = _load_hermes_module()
    home = mod.account._active_home()
    bound = mod.ClawbitsAccount(hermes_home=home, base_url="https://b.example", agent_id="bound_agent", api_key="bound_key")

    mod.account.bind_account(bound)
    assert mod.active_account() is bound
    mod.account.unbind_account(mod.ClawbitsAccount(hermes_home=home, base_url="x", agent_id="other", api_key="k"))
    assert mod.active_account() is bound, "only the bound instance can withdraw itself"
    mod.account.unbind_account(bound)
    assert mod.active_account().api_key == "env_key"


def test_email_tool_check_is_never_cached_across_profiles(monkeypatch) -> None:
    mod = _load_hermes_module()
    uncached: set[Any] = set()
    monkeypatch.setitem(sys.modules, "tools", types.ModuleType("tools"))
    monkeypatch.setitem(sys.modules, "tools.registry", types.SimpleNamespace(no_cache_check_fn=uncached.add))
    tools: dict[str, dict[str, Any]] = {}

    class Ctx:
        def register_tool(self, **kwargs: Any) -> None:
            tools[kwargs["name"]] = kwargs

        def register_cli_command(self, **kwargs: Any) -> None:
            pass

        def register_platform(self, **kwargs: Any) -> None:
            pass

    mod.register(Ctx())
    assert tools["clawbits_send_email"]["check_fn"] in uncached


def test_spawned_tasks_keep_the_owner_context() -> None:
    mod = _load_hermes_module()
    owner: contextvars.ContextVar[str] = contextvars.ContextVar("owner", default="ambient")

    def build():
        owner.set("profile-b")
        return mod.ClawbitsAdapter(_FakePlatformConfig(extra={"api_key": "k", "agent_id": "a"}))

    adapter = contextvars.copy_context().run(build)

    async def read() -> tuple[str, str]:
        return owner.get(), await asyncio.to_thread(owner.get)

    async def run() -> tuple[str, str]:
        return await adapter._spawn(read())

    assert owner.get() == "ambient"
    assert asyncio.run(run()) == ("profile-b", "profile-b")


class _MailClient:
    """Answers the mailroom: an unconfigured mailbox, so intake needs no network."""

    def __init__(self, mod) -> None:
        self.error = mod.ClawbitsCliError(503, "not_configured")
        self.counts = 0

    def email_count(self, agent_id: str) -> dict[str, Any]:
        self.counts += 1
        raise self.error


async def _idle(*_: Any, **__: Any) -> None:
    return None


def _refuse_journal(*_: Any, **__: Any) -> Any:
    raise OSError("inbox journal unavailable")


def _wired(mod, monkeypatch, tmp_path, *, reader_llm: Any = None, **env: str):
    """An adapter whose chat loops idle and whose client answers only the mailroom."""
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("CLAWBITS_API_KEY", "k")
    monkeypatch.setenv("CLAWBITS_AGENT_ID", "agent")
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    monkeypatch.setattr(mod.adapter, "run_automations_reconciler", _idle)
    monkeypatch.setattr(mod.adapter, "hold_missed_slots", lambda home: 0)
    monkeypatch.setattr(mod.mailroom, "_TICK", 0.01)
    cfg = _FakePlatformConfig(extra={"api_key": "k", "agent_id": "agent", "channel_id": "dm"})
    adapter = mod.ClawbitsAdapter(cfg, reader_llm=reader_llm)
    for loop in ("_poll_loop", "_liveness_loop", "_lobstertalk_ws_loop"):
        setattr(adapter, loop, _idle)
    adapter.client = _MailClient(mod)
    return adapter


async def _until(adapter, predicate: Any, timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while not predicate():
        assert time.monotonic() < deadline, adapter._health.doc["subsystems"]
        await asyncio.sleep(0.01)


def _state(adapter, name: str) -> str | None:
    return adapter._health.doc["subsystems"].get(name, {}).get("state")


@pytest.mark.parametrize("receive", [True, False], ids=["receive_on", "receive_off"])
def test_connect_runs_one_mailroom_for_the_profile(monkeypatch, tmp_path, receive: bool) -> None:
    mod = _load_hermes_module()
    llm = object()
    env = {} if receive else {"CLAWBITS_EMAIL_ENABLED": "false"}
    adapter = _wired(mod, monkeypatch, tmp_path, reader_llm=llm, **env)

    async def run() -> None:
        assert await adapter.connect()
        mailroom = adapter._mailroom
        assert mailroom is not None and mod.mailroom.active_mailroom() is mailroom
        assert (mailroom.journal, mailroom.llm) == (adapter._journal, llm)
        assert mod._email_tool_available() is True, "the send tool follows the mailroom"
        # The outbox always runs; intake only when the profile receives email.
        await _until(adapter, lambda: _state(adapter, "outbox") == "active")
        await _until(adapter, lambda: _state(adapter, "email") in ("not_configured", "disabled"))
        assert _state(adapter, "email") == ("not_configured" if receive else "disabled")
        assert (adapter.client.counts > 0) is receive
        await adapter.disconnect()

    asyncio.run(run())
    assert adapter._mailroom is None and mod.mailroom.active_mailroom() is None
    assert mod._email_tool_available() is False, "no gateway, no send tool"


def test_no_mailroom_while_the_journal_is_unavailable(monkeypatch, tmp_path) -> None:
    mod = _load_hermes_module()
    adapter = _wired(mod, monkeypatch, tmp_path)
    monkeypatch.setattr(mod.adapter, "open_journal", _refuse_journal)

    async def run() -> None:
        assert await adapter.connect()
        assert adapter._journal is None and adapter._mailroom is None
        assert adapter._mailroom_task is None
        assert mod._email_tool_available() is False, "mail has nowhere durable to land"
        await adapter.disconnect()

    asyncio.run(run())


def test_send_policy_keeps_the_email_tool_out_of_reach(monkeypatch, tmp_path) -> None:
    mod = _load_hermes_module()
    adapter = _wired(mod, monkeypatch, tmp_path, CLAWBITS_EMAIL_SEND_ENABLED="false")

    async def run() -> None:
        assert await adapter.connect()
        assert adapter._mailroom is not None, "the outbox still resolves what it already holds"
        assert mod._email_tool_available() is False
        error = json.loads(mod._send_email_tool({"subject": "s", "message": "m"}))
        assert error["code"] == "email_send_disabled"
        await adapter.disconnect()

    asyncio.run(run())


def test_register_hands_the_adapter_the_context_llm(monkeypatch) -> None:
    mod = _load_hermes_module()
    monkeypatch.setenv("CLAWBITS_API_KEY", "k")
    monkeypatch.setenv("CLAWBITS_AGENT_ID", "agent")
    llm = object()
    platforms: dict[str, dict[str, Any]] = {}

    class Ctx:
        def __init__(self) -> None:
            self.llm = llm

        def register_tool(self, **kwargs: Any) -> None:
            pass

        def register_cli_command(self, **kwargs: Any) -> None:
            pass

        def register_platform(self, **kwargs: Any) -> None:
            platforms[kwargs["name"]] = kwargs

    mod.register(Ctx())
    adapter = platforms["clawbits"]["adapter_factory"](_FakePlatformConfig(extra={}))
    assert adapter._reader_llm is llm, "the reader runs on the profile's own model"
