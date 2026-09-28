"""Each profile's Clawbits account stays bound to its own endpoint, key, policy and home.

Profile A is the launch profile (the gateway fixture's HERMES_HOME and environment);
profile B is a served profile with its own ``.env`` and fake backend, entered through
Hermes's own ``_profile_runtime_scope``. The plugin is loaded by Hermes's loader.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any, NamedTuple

import pytest
from fake_clawbits import OPERATOR_DM, FakeClawbits

KEY_A, KEY_B = "cb-test-key", "cb-key-b"  # A's key comes from the gateway fixture's environment
MAIL = {"subject": "status", "message": "all good"}
GREETED = ".clawbits_greeted"
OPAQUE = "Zq7Xw2Lp9Rt4" * 4  # synthetic, no vendor shape: only its key name marks it secret
SECRET = "sk-ant-api03-" + OPAQUE  # synthetic, shaped like a vendor key


class Profile(NamedTuple):
    fake: FakeClawbits
    key: str
    home: Path


class Profiles:
    """Launch profile A and served profile B, plus the plugin module Hermes loaded."""

    def __init__(self, gw: Any, plugin: Any, fake_b: FakeClawbits, home_b: Path) -> None:
        self.plugin = plugin
        self.a = Profile(gw.fake, KEY_A, gw.home)
        self.b = Profile(fake_b, KEY_B, home_b)
        self.b_env = {
            "CLAWBITS_API_KEY": KEY_B,
            "CLAWBITS_AGENT_ID": fake_b.agent_id,
            "CLAWBITS_ENDPOINT": fake_b.base_url,
            "CLAWBITS_CHANNEL_ID": OPERATOR_DM,
            "CLAWBITS_POLL_INTERVAL": "0.1",
            "CLAWBITS_EMAIL_ENABLED": "false",
        }
        self.env_b(**self.b_env)

    def env_b(self, **values: str) -> None:
        """Replace B's .env with exactly these settings."""
        env = "".join(f"{k}={v}\n" for k, v in values.items())
        (self.b.home / ".env").write_text(env, encoding="utf-8")

    def scope_b(self) -> contextlib.AbstractContextManager[None]:
        """Hermes's served-profile scope for B: home override plus B's secret scope."""
        from gateway.run import _profile_runtime_scope

        return _profile_runtime_scope(self.b.home)

    def adapter(self, **extra: Any) -> Any:
        """A ClawbitsAdapter built in the ambient scope, as Hermes builds one per profile."""
        from gateway.config import PlatformConfig

        return self.plugin.ClawbitsAdapter(PlatformConfig(enabled=True, extra=extra))


@pytest.fixture
def plugin(gateway) -> Any:
    return gateway.load_plugin()


@pytest.fixture
def profiles(gateway, plugin, request, tmp_path) -> Profiles:
    fake_b = FakeClawbits(agent_id="agent-b")
    request.addfinalizer(fake_b.close)
    home_b = tmp_path / "home-b"
    home_b.mkdir()
    return Profiles(gateway, plugin, fake_b, home_b)


@contextlib.contextmanager
def _multiplexed(active: bool) -> Iterator[None]:
    """Hermes's process-wide profile-multiplexer switch, restored afterwards."""
    from agent.secret_scope import is_multiplex_active, set_multiplex_active

    prior = is_multiplex_active()
    set_multiplex_active(active)
    try:
        yield
    finally:
        set_multiplex_active(prior)


@pytest.fixture(params=[True, False], ids=["multiplex_on", "multiplex_off"])
def multiplex(request) -> Iterator[bool]:
    """Run under Hermes's profile multiplexer, or as a routed standalone process."""
    with _multiplexed(request.param):
        yield request.param


def _files(home: Path) -> set[Path]:
    """The profile's files, less SQLite's transient journal sidecars."""
    return {path.relative_to(home) for path in home.rglob("*")
            if path.is_file() and not path.name.endswith(("-wal", "-shm"))}


def _assert_owned(profile: Profile) -> None:
    """Every request the profile's fake saw carried the profile's key and named only its agent."""
    calls = profile.fake.calls
    assert calls and {c["api_key"] for c in calls} == {profile.key}, calls
    agent_paths = [c["path"] for c in calls if "/agents/" in c["path"] or "/teams/" in c["path"]]
    own = f"/{profile.fake.agent_id}/"
    assert agent_paths and all(own in path for path in agent_paths), agent_paths


async def _run_mailrooms(*adapters: Any) -> None:
    """Open each profile's journal and bind its own mailroom, as connect() does."""
    for adapter in adapters:
        assert await adapter._open_journal()
        adapter._start_mailroom()


async def _exercise(adapter: Any) -> None:
    """One poll (channel seed, read ack, greeting, mailroom), a status update, a post, an
    email intake pass."""
    await adapter._poll_once()
    activity = {"kind": "tool", "label": "Running", "tool": None}
    await adapter._set_activity_best_effort(OPERATOR_DM, activity)
    assert (await adapter.send(OPERATOR_DM, "hello")).success
    await adapter._mailroom._intake_pass()


def test_profile_a_b_a_accounts_resolve_and_request_independently(profiles, multiplex):
    first = profiles.adapter()
    with profiles.scope_b():
        served = profiles.adapter()
    second = profiles.adapter()
    for adapter, profile in ((first, profiles.a), (served, profiles.b), (second, profiles.a)):
        account = adapter.account
        assert (account.base_url, account.agent_id, account.api_key, account.hermes_home) == (
            profile.fake.base_url, profile.fake.agent_id, profile.key, profile.home)

    for profile in (profiles.a, profiles.b):
        profile.fake.post("hi")  # something to seed and ack
    before_a, before_b = _files(profiles.a.home), _files(profiles.b.home)
    asyncio.run(_exercise(served))
    written_b = _files(profiles.b.home) - before_b
    plugin = profiles.plugin
    journal = plugin.inbox_state.journal_path(profiles.b.home).relative_to(profiles.b.home)
    assert written_b == {Path(GREETED), journal}
    assert _files(profiles.a.home) == before_a, "none of it in A's home"
    asyncio.run(_exercise(first))
    asyncio.run(_exercise(second))
    assert written_b <= _files(profiles.a.home), "A keeps the same state in its own home"
    assert _files(profiles.b.home) - before_b == written_b, "and never in B's"
    _assert_owned(profiles.a)
    _assert_owned(profiles.b)


def test_concurrent_profile_tasks_keep_owner_endpoint_key_and_home(
    gateway, profiles, monkeypatch, multiplex
):
    from hermes_constants import get_hermes_home

    monkeypatch.setenv("CLAWBITS_EMAIL_ENABLED", "true")
    profiles.env_b(**{**profiles.b_env, "CLAWBITS_EMAIL_ENABLED": "true"})

    async def cross_send(adapter: Any, text: str) -> None:
        assert (await adapter.send(OPERATOR_DM, text)).success
        draft = await adapter.send(OPERATOR_DM, "", metadata={"expect_edits": True})
        for _ in range(2):  # Hermes repeats the final edit of a REQUIRES_EDIT_FINALIZE stream
            edit = await adapter.edit_message(
                OPERATOR_DM, draft.message_id, f"{text} (edited)", finalize=True)
            assert edit.success

    async def scenario() -> None:
        a = profiles.adapter()
        with profiles.scope_b():
            b = profiles.adapter()
            assert await b.connect()
        assert await a.connect()
        try:
            loops = ("/email/count", "/automations/desired", "/mm/events/ws", "/alive")
            for profile in (profiles.a, profiles.b):
                await gateway.wait_for(lambda p=profile: all(
                    any(c["path"].endswith(s) for c in p.fake.calls) for s in loops))
            with profiles.scope_b():  # A's work started under B's scope, B's work unscoped
                a_task = asyncio.create_task(cross_send(a, "from a"))
            b_task = asyncio.create_task(cross_send(b, "from b"))
            await asyncio.gather(a_task, b_task)
            await asyncio.sleep(0.5)  # more poll ticks with both profiles live
            with profiles.scope_b():
                a_home = a._spawn(asyncio.to_thread(get_hermes_home))
            b_home = b._spawn(asyncio.to_thread(get_hermes_home))
            assert (Path(await a_home), Path(await b_home)) == (profiles.a.home, profiles.b.home)
        finally:
            await asyncio.gather(a.disconnect(), b.disconnect())

    asyncio.run(scenario())
    for profile, own, other in ((profiles.a, "from a", "from b"), (profiles.b, "from b", "from a")):
        _assert_owned(profile)
        messages = [p["message"] for p in profile.fake.posts]
        assert {own, f"{own} (edited)"} <= set(messages), messages
        assert not any(other in m for m in messages), messages
        rejected = [c for c in profile.fake.calls if c.get("status") == 409]
        assert not rejected, "no edit of a published post"
        status = profiles.plugin.health.read_status(profile.home)
        assert status is not None, "status.json in the owner's state dir"


@pytest.mark.parametrize("mode", ["multiplex", "routed_standalone"])
def test_missing_b_credentials_never_fall_back_to_a(profiles, mode):
    from gateway.platforms._shared import get_scoped_secret

    plugin = profiles.plugin
    profiles.env_b(OTHER_SETTING="x")
    with _multiplexed(mode == "multiplex"), profiles.scope_b():
        if mode == "routed_standalone":
            # Hermes's own scoped read falls through to the launch env here; the plugin must not.
            assert get_scoped_secret("CLAWBITS_API_KEY") == KEY_A
        assert plugin._env_enablement() is None
        assert not plugin.resolve_account().usable
        adapter = profiles.adapter()
        assert asyncio.run(adapter.connect()) is False
        assert adapter.fatal_error_code == "clawbits_not_configured"
        assert not plugin._email_tool_available()
        assert json.loads(plugin._send_email_tool(MAIL))["code"] == "clawbits_unavailable"
    assert profiles.a.fake.calls == [] and profiles.b.fake.calls == []


def test_disabled_b_send_policy_does_not_inherit_a(profiles, monkeypatch, multiplex):
    plugin = profiles.plugin
    monkeypatch.setenv("CLAWBITS_EMAIL_SEND_ENABLED", "true")
    profiles.env_b(**profiles.b_env, CLAWBITS_EMAIL_SEND_ENABLED="false")
    a = profiles.adapter()
    with profiles.scope_b():
        b = profiles.adapter()
    asyncio.run(_run_mailrooms(a, b))  # the send tool goes through the profile's own mailroom
    try:
        with profiles.scope_b():
            assert b.account.send_email is False
            assert not plugin._email_tool_available()
            assert json.loads(plugin._send_email_tool(MAIL))["code"] == "email_send_disabled"
        assert plugin._email_tool_available()
        assert json.loads(plugin._send_email_tool(MAIL))["state"] == "accepted"
        sends = [c for c in profiles.a.fake.calls if c["path"].endswith("/email/send")]
        assert [(c["path"], c["api_key"]) for c in sends] == [
            (f"/api/agentic/agents/{profiles.a.fake.agent_id}/email/send", KEY_A)]
        assert profiles.b.fake.calls == [] and profiles.b.fake.sent == []

        monkeypatch.setenv("CLAWBITS_EMAIL_SEND_ENABLED", "false")
        profiles.env_b(**profiles.b_env)  # B leaves the switch unset: its default, not A's value
        assert not plugin._email_tool_available()
        with profiles.scope_b():
            assert profiles.adapter().account.send_email is True
            assert plugin._email_tool_available()
    finally:
        for adapter in (a, b):
            plugin.mailroom.unbind_mailroom(adapter._mailroom)


def test_email_tool_availability_inside_and_outside_bound_scope(profiles):
    import tools.registry
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override

    plugin = profiles.plugin
    assert plugin._email_tool_available in tools.registry._NO_CACHE_CHECK_FNS
    assert plugin.active_account().api_key == KEY_A

    async def scenario() -> None:
        with profiles.scope_b():
            # A config.yaml-only identity: known to the tool only through the bound adapter.
            bound = profiles.adapter(
                api_key="cb-key-b-yaml", agent_id="agent-b", base_url=profiles.b.fake.base_url)
            assert await bound.connect()
            assert plugin.active_account() is bound.account
        assert plugin.active_account().api_key == KEY_A
        await bound.disconnect()
        with profiles.scope_b():
            assert plugin.active_account().api_key == KEY_B
        token = set_hermes_home_override(str(profiles.b.home))
        try:
            # Routed without B's secret scope: nothing to read.
            assert plugin.active_account() is None
        finally:
            reset_hermes_home_override(token)

    asyncio.run(scenario())


@pytest.mark.parametrize("b_env_credentials", [True, False], ids=["b_env", "b_yaml_only"])
def test_env_enablement_seeds_only_the_owning_profile(profiles, b_env_credentials):
    from gateway.config import GatewayConfig, Platform, PlatformConfig
    from gateway.config_env import _enable_plugin_platform
    from gateway.platform_registry import platform_registry

    entry = platform_registry.get("clawbits")
    config = GatewayConfig()
    config.platforms[Platform("clawbits")] = PlatformConfig(
        enabled=True, extra={"api_key": "cb-key-b-yaml", "agent_id": "agent-b"})
    if not b_env_credentials:
        profiles.env_b(OTHER_SETTING="x")
    with _multiplexed(True), profiles.scope_b():
        _enable_plugin_platform(config, entry)
    extra = config.platforms[Platform("clawbits")].extra
    assert extra["api_key"] == (KEY_B if b_env_credentials else "cb-key-b-yaml")
    assert KEY_A not in extra.values()


def test_duplicate_account_is_fingerprinted_for_hermes_refusal(profiles):
    from gateway.config import Platform
    from gateway.run import GatewayRunner

    platform = Platform("clawbits")
    launch = profiles.adapter()
    profiles.env_b(**{**profiles.b_env, "CLAWBITS_API_KEY": KEY_A})
    with profiles.scope_b():
        duplicate = profiles.adapter()
    profiles.env_b(**profiles.b_env)
    with profiles.scope_b():
        distinct = profiles.adapter()

    claim, duplicate_claim, distinct_claim = (
        GatewayRunner._adapter_credential_claim(platform, adapter)
        for adapter in (launch, duplicate, distinct)
    )
    assert claim is not None and KEY_A not in str(claim)
    assert duplicate_claim == claim and distinct_claim not in (None, claim)

    runner = object.__new__(GatewayRunner)  # only the refusal logic, without a running gateway
    runner._update_platform_runtime_status = lambda *args, **kwargs: None
    claimed = {claim: "default"}
    assert runner._refuse_duplicate_claim(duplicate_claim, claimed, "b", platform, "credential")
    assert not runner._refuse_duplicate_claim(distinct_claim, claimed, "b", platform, "credential")


def test_activity_preview_uses_shared_redactor(plugin, monkeypatch):
    import agent.redact

    activity = plugin.adapter._tool_activity
    keys = ("api.key", "access.key", "private.key", "stripe.key", "auth_token", "db-password")
    quoted = [f'"api.key": "{OPAQUE}"', f"'stripe.key':'{OPAQUE}'"]
    for form in [f"{key}={OPAQUE}" for key in keys] + quoted:
        label = activity(f"is searching the web for {form} docs…", preview=True)["label"]
        assert label.startswith("Searching the web for ") and OPAQUE not in label, label
    label = activity(f"is searching the web for {SECRET} docs…", preview=True)["label"]
    assert label.startswith("Searching the web for ") and SECRET not in label, label
    assert plugin.adapter._redacted(label) == label, "a second pass leaves masked text alone"
    masked = "Searching the web for token=***"
    assert plugin.adapter._redacted(masked) == masked
    reading = activity(f"is reading /home/u/.ssh/{SECRET}…", preview=True)
    assert reading == {"kind": "tool", "label": "Reading", "tool": None}

    def broken(*args: Any, **kwargs: Any) -> str:
        raise RuntimeError("redactor down")

    monkeypatch.setattr(agent.redact, "redact_sensitive_text", broken)
    label = activity(f"is searching the web for {SECRET}…", preview=True)["label"]
    assert label == "[redaction-unavailable]"


def test_cron_redacted_payload_passes_through_adapter_unchanged(gateway, plugin):
    from agent.redact import redact_sensitive_text
    from gateway.config import PlatformConfig

    raw = "\n".join([
        "Nightly report ✅ — 3 tasks done",
        f"config: api.key={SECRET}",
        f"OPENAI_API_KEY=sk-proj-{'A' * 40}",
        "already masked: token=***",
    ])
    delivered = redact_sensitive_text(raw, force=True)  # what Hermes's cron delivery sends
    assert delivered != raw
    adapter = plugin.ClawbitsAdapter(PlatformConfig(enabled=True))
    assert asyncio.run(adapter.send(OPERATOR_DM, delivered)).success
    assert gateway.fake.posts[-1]["message"] == delivered
