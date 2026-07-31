"""SandboxManager behavior against the in-memory fake runtime + store.

Pure in-memory: no DB, no network, no hypervisor. Async methods are driven via
``asyncio.run`` so no pytest-asyncio dependency is needed.
"""

import asyncio

from reef import (
    FakeRuntime,
    InMemorySandboxStore,
    OpenClawProfile,
    SandboxManager,
    SandboxState,
)

CREDS = {
    "anthropic_api_key": "sk-ant-test",
    "endpoint": "https://clawbits.ai",
    "api_key": "agent-key",
    "agent_id": "SilverPigeon3",
    "org_id": "org_123",
    "channel_id": "chan_123",
}


def _manager():
    runtime = FakeRuntime()
    store = InMemorySandboxStore()
    return SandboxManager(runtime, store, backend="fake"), runtime, store


def test_ensure_running_creates_and_starts():
    mgr, runtime, _ = _manager()
    profile = OpenClawProfile(image="openclaw-runtime:test")

    sb = asyncio.run(mgr.ensure_running("agent-1", profile, CREDS))

    assert sb.state is SandboxState.RUNNING
    assert sb.handle == "fake://agent-1"
    assert sb.profile == "openclaw"
    assert sb.backend == "fake"
    assert sb.image == "openclaw-runtime:test"
    # the spec env carried the mapped creds (never the raw creds dict)
    env = runtime.created[0].env
    assert env["CLAWBITS_AGENT_ID"] == "SilverPigeon3"
    assert env["CLAWBITS_ENDPOINT"] == "https://clawbits.ai"
    assert env["ANTHROPIC_API_KEY"] == "sk-ant-test"
    # the profile's mount dest flows into the spec (the runtime stays agent-agnostic)
    assert runtime.created[0].volume_dest == "/home/node/.openclaw/workspace"


def test_ensure_running_is_idempotent():
    mgr, runtime, _ = _manager()
    profile = OpenClawProfile(image="openclaw-runtime:test")

    asyncio.run(mgr.ensure_running("agent-1", profile, CREDS))
    asyncio.run(mgr.ensure_running("agent-1", profile, CREDS))

    # second call is a no-op: only one create
    assert len(runtime.created) == 1


def test_stop_then_ensure_running_restarts_same_volume():
    mgr, runtime, _ = _manager()
    profile = OpenClawProfile(image="openclaw-runtime:test")

    first = asyncio.run(mgr.ensure_running("agent-1", profile, CREDS))
    vol = first.volume
    asyncio.run(mgr.stop("agent-1"))
    again = asyncio.run(mgr.ensure_running("agent-1", profile, CREDS))

    assert again.state is SandboxState.RUNNING
    assert again.volume == vol  # workspace preserved across restart
    assert len(runtime.created) == 1  # restarted, not recreated


def test_destroy_removes_sandbox():
    mgr, _, store = _manager()
    profile = OpenClawProfile(image="openclaw-runtime:test")

    asyncio.run(mgr.ensure_running("agent-1", profile, CREDS))
    asyncio.run(mgr.destroy("agent-1"))

    assert asyncio.run(store.get("agent-1")) is None


def test_default_volume_is_stable():
    mgr, _, _ = _manager()
    profile = OpenClawProfile(image="openclaw-runtime:test")
    sb = asyncio.run(mgr.ensure_running("agent-xyz", profile, CREDS))
    assert sb.volume == "reef-agent-xyz"


def test_net_allow_flows_to_spec():
    mgr, runtime, _ = _manager()
    profile = OpenClawProfile(image="openclaw-runtime:test")
    asyncio.run(mgr.ensure_running("a1", profile, CREDS, net_allow=["api.anthropic.com"]))
    assert runtime.created[0].net_allow == ("api.anthropic.com",)


def test_user_env_is_lowest_precedence():
    # The manager deliberately does NOT validate user_env (fleet rejects reserved
    # keys up front) — this pins the raw merge order as defense-in-depth:
    # user_env < build_env < extra_env < REEF_STATUS_DIR.
    mgr, runtime, _ = _manager()
    profile = OpenClawProfile(image="openclaw-runtime:test")
    asyncio.run(
        mgr.ensure_running(
            "a1",
            profile,
            CREDS,
            extra_env={"X": "extra"},
            user_env={
                "ANTHROPIC_API_KEY": "mine",  # build_env sets it from creds → loses
                "X": "user",  # extra_env collides → loses
                "REEF_STATUS_DIR": "/evil",  # manager pins it → loses
                "CUSTOM_FLAG": "1",  # no collision → survives
            },
        )
    )
    env = runtime.created[0].env
    assert env["ANTHROPIC_API_KEY"] == "sk-ant-test"
    assert env["X"] == "extra"
    assert env["REEF_STATUS_DIR"] == profile.status_dir
    assert env["CUSTOM_FLAG"] == "1"


def test_expose_user_env_applies_only_on_first_create():
    mgr, runtime, _ = _manager()
    profile = OpenClawProfile(image="openclaw-runtime:test")
    asyncio.run(mgr.expose("a1", profile, CREDS, user_env={"CUSTOM_FLAG": "1"}))
    asyncio.run(mgr.stop("a1"))
    asyncio.run(mgr.expose("a1", profile, CREDS, user_env={"CUSTOM_FLAG": "2"}))
    # Restarted, not recreated — the original env (like the access secret) sticks.
    assert len(runtime.created) == 1
    assert runtime.created[0].env["CUSTOM_FLAG"] == "1"


def test_profile_extra_mounts_become_named_extra_volumes():
    mgr, runtime, _ = _manager()
    profile = OpenClawProfile(image="openclaw-runtime:test")
    asyncio.run(mgr.ensure_running("agent-1", profile, CREDS))
    # OpenClaw's auth-profile secrets dir rides a second named volume, suffixed
    # off the main one so it shares its lifecycle (never auto-removed).
    assert runtime.created[0].extra_volumes == (
        ("reef-agent-1-config", "/home/node/.config/openclaw"),
    )
