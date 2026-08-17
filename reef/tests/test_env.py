"""The editable user-env overlay: which keys the operator owns, how a change is
applied (restart vs recreate vs neither), and the disclosure rules."""

from __future__ import annotations

import asyncio

import pytest
from fastapi.testclient import TestClient

from reef.agents import AGENT_TYPES
from reef.api.app import create_app
from reef.errors import RuntimeUnavailable, SandboxBusy
from reef.fleet import (
    _DANGEROUS_ENV_KEYS,
    _ENV_FEATURE_KEY,
    _MASK,
    RESERVED_ENV_KEYS,
    FleetService,
    _supports_env_file,
)
from reef.guest_env import EnvRecord
from reef.manager import SandboxManager
from reef.models import Sandbox
from reef.runtime import DesiredState, SandboxState
from reef.store import InMemorySandboxStore
from reef.tests.fakes import FakeAdminRuntime

TOKEN = "s3cret"

# Non-empty on purpose: the replay refuses to guess which vars reef injected when
# the image reports nothing baked.
BAKED = {"PATH": "/usr/bin", "REEF_IMAGE_VERSION": "0.5.0"}
FEATURE = {"REEF_FEATURES": "env-file", "REEF_ENV_DIR": "/home/node/.reef-env"}


def _seed(
    rt: FakeAdminRuntime,
    store: InMemorySandboxStore,
    *,
    sandbox_id: str = "oc1",
    profile: str = "openclaw",
    image: str = "reef-oc:test",
    injected: dict[str, str] | None = None,
    user: dict[str, str] | None = None,
    feature: bool = True,
    state: SandboxState = SandboxState.RUNNING,
    desired: DesiredState = DesiredState.RUNNING,
    managed: bool = True,
    capabilities: tuple[str, ...] = (),
    logs: str = "",
) -> Sandbox | None:
    """An agent whose container env is ``baked + injected + user``. ``managed=False``
    seeds a drift VM; ``feature=False`` an agent on a pre-env-file image."""
    baked = {**BAKED, **(FEATURE if feature else {})}
    container = {**baked, **(injected or {}), **(user or {})}
    rt.image_env_data = dict(baked)
    rt.seed(
        sandbox_id,
        state=state,
        image=image,
        logs=logs,
        inspect={
            "config": {
                "name": sandbox_id,
                "image": {"Oci": {"reference": image}},
                "env": [[k, v] for k, v in container.items()],
                "cpus": 2,
                "memory_mib": 2048,
            }
        },
    )
    if not managed:
        return None
    rec = Sandbox(
        sandbox_id=sandbox_id,
        profile=profile,
        backend="fake",
        state=state,
        image=image,
        volume=f"reef-{sandbox_id}",
        handle=sandbox_id,
        port=19000,
        terminal_port=19001,
        desired_state=desired,
        capabilities=capabilities,
    )
    asyncio.run(store.put(rec))
    return rec


def _client(rt: FakeAdminRuntime, store: InMemorySandboxStore, monkeypatch) -> TestClient:
    """An authenticated client over a service that can recreate."""
    monkeypatch.setenv("REEF_ADMIN_TOKEN", TOKEN)
    mgr = SandboxManager(rt, store, backend="fake")
    client = TestClient(create_app(service=FleetService(rt, store, manager=mgr)))
    client.headers["Authorization"] = f"Bearer {TOKEN}"
    return client


def _svc(rt: FakeAdminRuntime, store: InMemorySandboxStore) -> FleetService:
    return FleetService(rt, store, manager=SandboxManager(rt, store, backend="fake"))


# Every cred key any profile reads, so ``build_env`` takes every branch it has.
FULL_CREDS = {
    "org_id": "org-1",
    "endpoint": "https://app.clawbits.ai",
    "signup_token": "human-abc",
    "agent_id": "agent-1",
    "api_key": "key-1",
    "channel_id": "chan-1",
    "anthropic_api_key": "ant",
    "openai_api_key": "oai",
    "openai_codex": "1",
    "gemini_api_key": "gem",
    "nearai_api_key": "near",
    "openrouter_api_key": "orte",
    "ollama_host": "http://host.microsandbox.internal:11434",
    "model": "anthropic/claude-x",
    "gateway_token": "tok",
    "secrets_master_key": "master",
    "capabilities": "cron,gh",
}


def test_profiles_declare_every_key_they_inject():
    for name, agent_type in AGENT_TYPES.items():
        profile = agent_type.profile()
        emitted = set(profile.build_env(FULL_CREDS)) | set(
            profile.exposure_env(password="p", public_url="https://u.example")
        )
        assert len(emitted) >= 20, f"{name} emitted only {sorted(emitted)}"
        missing = emitted - set(profile.managed_env_keys)
        assert not missing, f"{name} injects undeclared key(s): {sorted(missing)}"


def test_ironclaw_gateway_token_is_not_user_env(monkeypatch):
    for profile, image, key in (
        ("ironclaw", "reef-ic:test", "GATEWAY_AUTH_TOKEN"),
        ("ironclaw", "reef-ic:test", "SECRETS_MASTER_KEY"),
        ("hermes", "reef-hm:test", "HERMES_DASHBOARD_HOST"),
    ):
        rt, store = FakeAdminRuntime(), InMemorySandboxStore()
        _seed(
            rt,
            store,
            profile=profile,
            image=image,
            injected={key: "the-access-secret"},
            user={"AGENTPIT_API_KEY": "sk-live-example"},
        )
        client = _client(rt, store, monkeypatch)

        listed = [v["key"] for v in client.get("/fleet/oc1/env").json()["vars"]]
        assert listed == ["AGENTPIT_API_KEY"], f"{key} leaked into {profile}'s user env"

        r = client.patch("/fleet/oc1/env", json={"unset": [key], "apply": "none"})
        assert r.status_code == 422, r.text
        assert "managed by reef" in r.json()["detail"]
        assert "oc1" not in rt.guest_env_data


def test_get_env_lists_only_user_vars_and_never_a_value(monkeypatch):
    secret = "sk-live-SUPERSECRET"
    rt, store = FakeAdminRuntime(), InMemorySandboxStore()
    _seed(
        rt,
        store,
        injected={
            "CLAWBITS_API_KEY": "key-1",
            "OPENCLAW_GATEWAY_TOKEN": "tok",
            "REEF_CAPS": "cron",
        },
        user={"AGENTPIT_API_KEY": secret},
    )
    r = _client(rt, store, monkeypatch).get("/fleet/oc1/env")
    assert r.status_code == 200, r.text
    assert secret not in r.text
    body = r.json()
    assert [v["key"] for v in body["vars"]] == ["AGENTPIT_API_KEY"]
    assert set(body["vars"][0]) == {"key", "value_length", "source"}
    assert body["vars"][0]["value_length"] == len(secret)
    assert body["vars"][0]["source"] == "container"
    assert body["editable"] is True
    assert body["apply_modes"] == ["restart", "recreate"]
    assert body["state"] == "running"
    assert body["pending"] is False


def test_patch_restart_writes_file_and_does_not_recreate(monkeypatch):
    rt, store = FakeAdminRuntime(), InMemorySandboxStore()
    _seed(rt, store)
    r = _client(rt, store, monkeypatch).patch(
        "/fleet/oc1/env",
        json={"set": {"AGENTPIT_API_KEY": "sk-live-example"}, "apply": "restart"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["changed"] is True
    assert body["applied"] == "restart"
    assert body["takes_effect"] == "now"
    assert body["vars"] == [{"key": "AGENTPIT_API_KEY", "value_length": 15, "source": "file"}]
    assert rt.calls == [("stop", "oc1"), ("start", "oc1")]
    assert rt.created == []
    assert rt.guest_env_data["oc1"] == [EnvRecord("s", "AGENTPIT_API_KEY", "sk-live-example")]


def test_patch_recreate_pins_the_current_image(monkeypatch):
    monkeypatch.setenv("REEF_OPENCLAW_IMAGE", "reef-oc:new")
    rt, store = FakeAdminRuntime(), InMemorySandboxStore()
    _seed(rt, store, image="reef-oc:old", feature=False)
    r = _client(rt, store, monkeypatch).patch(
        "/fleet/oc1/env",
        json={"set": {"AGENTPIT_API_KEY": "sk-live-example"}, "apply": "recreate"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["applied"] == "recreate"
    assert r.json()["takes_effect"] == "now"
    assert rt.created[-1].image == "reef-oc:old"
    assert rt.created[-1].env["AGENTPIT_API_KEY"] == "sk-live-example"


def test_patch_recreate_preserves_net_allow_and_caps(monkeypatch):
    rt, store = FakeAdminRuntime(), InMemorySandboxStore()
    _seed(
        rt,
        store,
        feature=False,
        capabilities=("cron",),
        injected={
            "CLAWBITS_ENDPOINT": "http://host.microsandbox.internal:8000",
            "REEF_CAPS": "gh",  # stale: what the container booted with
        },
    )
    r = _client(rt, store, monkeypatch).patch(
        "/fleet/oc1/env", json={"set": {"A_KEY": "v"}, "apply": "recreate"}
    )
    assert r.status_code == 200, r.text
    spec = rt.created[-1]
    assert spec.net_allow == ("public", "host")
    assert spec.env["REEF_CAPS"] == "cron"  # from the RECORD, not the container
    assert spec.env["CLAWBITS_ENDPOINT"] == "http://host.microsandbox.internal:8000"


def test_patch_noop_does_not_restart(monkeypatch):
    rt, store = FakeAdminRuntime(), InMemorySandboxStore()
    _seed(rt, store, user={"AGENTPIT_API_KEY": "sk-live-example"})
    r = _client(rt, store, monkeypatch).patch(
        "/fleet/oc1/env",
        json={"set": {"AGENTPIT_API_KEY": "sk-live-example"}, "apply": "restart"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["changed"] is False
    assert r.json()["applied"] == "none"
    assert rt.calls == []
    assert "oc1" not in rt.guest_env_data


def test_patch_on_stopped_agent_leaves_it_stopped(monkeypatch):
    rt, store = FakeAdminRuntime(), InMemorySandboxStore()
    _seed(rt, store, state=SandboxState.STOPPED, desired=DesiredState.STOPPED)
    r = _client(rt, store, monkeypatch).patch(
        "/fleet/oc1/env", json={"set": {"A_KEY": "v"}, "apply": "restart"}
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["changed"] is True
    assert body["applied"] == "none"
    assert body["takes_effect"] == "on_next_start"
    assert body["state"] == "stopped"
    assert ("start", "oc1") not in rt.calls
    assert rt.guest_env_data["oc1"] == [EnvRecord("s", "A_KEY", "v")]


def test_unset_removes_and_empty_string_is_kept(monkeypatch):
    rt, store = FakeAdminRuntime(), InMemorySandboxStore()
    _seed(rt, store, user={"OLD_KEY": "x", "KEEP": "y"})
    client = _client(rt, store, monkeypatch)
    r = client.patch(
        "/fleet/oc1/env",
        json={"set": {"EMPTY": ""}, "unset": ["OLD_KEY"], "apply": "none"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["changed"] is True
    assert body["applied"] == "none"
    assert body["takes_effect"] == "on_next_start"
    assert {v["key"] for v in body["vars"]} == {"KEEP", "EMPTY"}

    assert EnvRecord("u", "OLD_KEY") in rt.guest_env_data["oc1"]
    assert EnvRecord("s", "EMPTY", "") in rt.guest_env_data["oc1"]

    after = {v["key"]: v for v in client.get("/fleet/oc1/env").json()["vars"]}
    assert set(after) == {"KEEP", "EMPTY"}
    assert after["EMPTY"]["value_length"] == 0
    assert after["EMPTY"]["source"] == "file"


def test_patch_rejects_reserved_keys_and_bad_requests(monkeypatch):
    rt, store = FakeAdminRuntime(), InMemorySandboxStore()
    _seed(rt, store, user={"MINE": "v"})
    client = _client(rt, store, monkeypatch)

    def patch(body: dict) -> tuple[int, str]:
        r = client.patch("/fleet/oc1/env", json={"apply": "none", **body})
        return r.status_code, str(r.json().get("detail", ""))

    for key in ("REEF_X", "CLAWBITS_API_KEY"):  # reef's namespace, a profile's key
        code, detail = patch({"set": {key: "x"}})
        assert code == 422, (key, detail)
        assert "managed by reef" in detail, (key, detail)
    code, detail = patch({"set": {"BIG": "v" * 5000}})
    assert code == 422 and "too long (5000 chars)" in detail
    code, detail = patch({"set": {"NULLY": "a\x00b"}})
    assert code == 422 and "NUL byte" in detail
    code, detail = patch({"set": {"MINE": "v2"}, "unset": ["MINE"]})
    assert code == 422 and "in both set and unset" in detail
    code, detail = patch({"unset": ["NEVER_SET"]})
    assert code == 422 and "is not set on this agent" in detail

    assert rt.calls == [] and "oc1" not in rt.guest_env_data


def test_patch_count_cap_applies_to_the_result_not_the_delta(monkeypatch):
    rt, store = FakeAdminRuntime(), InMemorySandboxStore()
    _seed(rt, store, user={f"K{i}": "v" for i in range(32)})
    r = _client(rt, store, monkeypatch).patch(
        "/fleet/oc1/env", json={"set": {"ONE_MORE": "v"}, "apply": "none"}
    )
    assert r.status_code == 422, r.text
    assert "too many env vars (33)" in r.json()["detail"]


def test_patch_422_body_never_echoes_the_value(monkeypatch):
    secret = "sk-live-SUPERSECRET"
    rt, store = FakeAdminRuntime(), InMemorySandboxStore()
    _seed(rt, store)
    client = _client(rt, store, monkeypatch)

    r = client.patch("/fleet/oc1/env", json={"set": {"CLAWBITS_API_KEY": secret}})
    assert r.status_code == 422, r.text
    assert secret not in r.text
    assert "CLAWBITS_API_KEY" in r.json()["detail"]

    r = client.patch("/fleet/oc1/env", json={"set": f"AGENTPIT_API_KEY={secret}"})
    assert r.status_code == 422, r.text
    assert secret not in r.text
    for err in r.json()["detail"]:
        assert "input" not in err and "ctx" not in err

    long_secret = "sk-live-" + "x" * 5000
    r = client.patch("/fleet/oc1/env", json={"set": {"A_KEY": long_secret}})
    assert r.status_code == 422, r.text
    assert long_secret not in r.text
    assert "sk-live-x" not in r.text
    assert f"({len(long_secret)} chars)" in r.json()["detail"]


def test_create_rejects_profile_managed_keys():
    rt, store = FakeAdminRuntime(), InMemorySandboxStore()
    svc = _svc(rt, store)
    for agent_type, key in (
        ("ironclaw", "SECRETS_MASTER_KEY"),
        ("ironclaw", "GATEWAY_AUTH_TOKEN"),
        ("hermes", "GATEWAY_ALLOW_ALL_USERS"),
        ("hermes", "HERMES_DASHBOARD_HOST"),
    ):
        with pytest.raises(ValueError, match="managed by reef"):
            asyncio.run(svc.create(agent_type, name="oc-managed", env={key: "x"}))
    asyncio.run(svc.create("openclaw", name="oc-ok", env={"OPENCLAW_STATE_DIR": "/data"}))
    assert rt.created[-1].env["OPENCLAW_STATE_DIR"] == "/data"


def test_concurrent_patch_is_409():
    class GatedRuntime(FakeAdminRuntime):
        def __init__(self) -> None:
            super().__init__()
            self.gate = asyncio.Event()

        async def write_guest_env(self, handle, records) -> None:
            await self.gate.wait()
            await super().write_guest_env(handle, records)

    rt, store = GatedRuntime(), InMemorySandboxStore()
    _seed(rt, store)
    svc = _svc(rt, store)

    async def scenario():
        first = asyncio.create_task(svc.set_env("oc1", set_vars={"A_KEY": "v"}, apply="none"))
        await asyncio.sleep(0)  # let it reach the gate, holding the lock
        with pytest.raises(SandboxBusy):
            await svc.set_env("oc1", set_vars={"B_KEY": "v"}, apply="none")
        rt.gate.set()
        assert (await first).changed is True
        assert (await svc.set_env("oc1", set_vars={"B_KEY": "v"}, apply="none")).changed

    asyncio.run(scenario())


def test_concurrent_patch_is_409_over_http(monkeypatch):
    rt, store = FakeAdminRuntime(), InMemorySandboxStore()
    _seed(rt, store)
    svc = _svc(rt, store)
    monkeypatch.setenv("REEF_ADMIN_TOKEN", TOKEN)
    client = TestClient(create_app(service=svc))
    client.headers["Authorization"] = f"Bearer {TOKEN}"
    lock = svc._env_lock("oc1")
    asyncio.run(lock.acquire())
    try:
        r = client.patch("/fleet/oc1/env", json={"set": {"A_KEY": "v"}, "apply": "none"})
    finally:
        lock.release()
    assert r.status_code == 409, r.text
    assert "busy" in r.json()["detail"]


def test_env_routes_require_the_admin_token(monkeypatch):
    rt, store = FakeAdminRuntime(), InMemorySandboxStore()
    _seed(rt, store)
    monkeypatch.setenv("REEF_ADMIN_TOKEN", TOKEN)
    client = TestClient(create_app(service=_svc(rt, store)))
    assert client.get("/fleet/oc1/env").status_code == 401
    assert client.patch("/fleet/oc1/env", json={"set": {"A_KEY": "v"}}).status_code == 401
    auth = {"Authorization": f"Bearer {TOKEN}"}
    assert client.get("/fleet/oc1/env", headers=auth).status_code == 200


def test_env_routes_503_when_auth_unconfigured(monkeypatch):
    monkeypatch.delenv("REEF_ADMIN_TOKEN", raising=False)
    rt, store = FakeAdminRuntime(), InMemorySandboxStore()
    _seed(rt, store)
    client = TestClient(create_app(service=_svc(rt, store)))
    for r in (
        client.get("/fleet/oc1/env"),
        client.patch("/fleet/oc1/env", json={"set": {"A_KEY": "v"}}),
    ):
        assert r.status_code == 503, r.text
        assert "REEF_ADMIN_TOKEN" in r.json()["detail"]
    assert client.get("/fleet").status_code == 200


def test_logs_redact_user_env_values():
    rt, store = FakeAdminRuntime(), InMemorySandboxStore()
    secret = "sk-live-SUPERSECRET"
    _seed(
        rt,
        store,
        user={"AGENTPIT_API_KEY": secret, "SHORT": "on"},
        injected={"OPENCLAW_GATEWAY_TOKEN": "gateway-token-value"},
        logs=f"skill: GET /v1/x -> 401 (key={secret})\nmode=on\n",
    )
    out = asyncio.run(_svc(rt, store).logs("oc1"))
    assert secret not in out
    assert "key=***" in out
    assert "mode=on" in out


def test_patch_on_drift_is_404_and_get_reports_not_editable(monkeypatch):
    rt, store = FakeAdminRuntime(), InMemorySandboxStore()
    _seed(rt, store, managed=False, user={"AGENTPIT_API_KEY": "sk-live-example"})
    client = _client(rt, store, monkeypatch)

    body = client.get("/fleet/oc1/env").json()
    assert body["editable"] is False
    assert [v["key"] for v in body["vars"]] == ["AGENTPIT_API_KEY"]
    assert body["desired_state"] is None

    r = client.patch("/fleet/oc1/env", json={"set": {"A_KEY": "v"}, "apply": "none"})
    assert r.status_code == 404, r.text
    assert "oc1" not in rt.guest_env_data


# Keys the GUEST's reader drops on its own, all outside RESERVED_ENV_KEYS and
# outside OpenClawProfile.managed_env_keys: the server's mirror of the guest
# filter is the only thing between them and a 200.
GUEST_DROPPED = (
    "GATEWAY_FOO",
    "HERMES_FOO",
    "IRONCLAW_FOO",
    "SECRETS_MASTER_KEY",
    "CLAWBITS_FOO",
    "OPENCLAW_GATEWAY_FOO",
)


def test_a_pre_feature_container_refuses_every_write_and_still_recreates(monkeypatch):
    """The apply gate reads the LIVE container env, and it gates the WRITE."""
    rt, store = FakeAdminRuntime(), InMemorySandboxStore()
    _seed(rt, store, feature=False)
    rt.image_env_data = {**BAKED, **FEATURE}
    assert _ENV_FEATURE_KEY not in dict(rt.inspect_data["oc1"]["config"]["env"])

    client = _client(rt, store, monkeypatch)
    assert client.get("/fleet/oc1/env").json()["apply_modes"] == ["recreate"]

    for mode in ("restart", "none"):
        r = client.patch(
            "/fleet/oc1/env", json={"set": {"A_KEY": "sk-live-example"}, "apply": mode}
        )
        assert r.status_code == 422, (mode, r.text)
        detail = r.json()["detail"]
        assert "upgrade" in detail and "recreate" in detail
        assert rt.calls == []
        assert "oc1" not in rt.guest_env_data
        assert client.get("/fleet/oc1/env").json()["vars"] == []

    r = client.patch(
        "/fleet/oc1/env", json={"set": {"A_KEY": "sk-live-example"}, "apply": "recreate"}
    )
    assert r.status_code == 200, r.text
    assert r.json()["changed"] is True
    assert r.json()["applied"] == "recreate"
    assert ("destroy", "oc1") in rt.calls
    assert rt.created[-1].env["A_KEY"] == "sk-live-example"


def test_keys_the_guest_drops_are_refused_and_never_listed(monkeypatch):
    rt, store = FakeAdminRuntime(), InMemorySandboxStore()
    _seed(rt, store, injected={k: "already-here" for k in GUEST_DROPPED}, user={"MINE": "v"})
    client = _client(rt, store, monkeypatch)
    managed = AGENT_TYPES["openclaw"].profile().managed_env_keys

    for key in GUEST_DROPPED:
        assert key not in RESERVED_ENV_KEYS and key not in managed, key
        for body in ({"set": {key: "x"}}, {"unset": [key]}):
            r = client.patch("/fleet/oc1/env", json={"apply": "none", **body})
            assert r.status_code == 422, (key, r.text)
            assert "managed by reef" in r.json()["detail"], (key, r.text)

    assert [v["key"] for v in client.get("/fleet/oc1/env").json()["vars"]] == ["MINE"]
    assert rt.calls == [] and "oc1" not in rt.guest_env_data


def test_user_settable_managed_key_is_readable_and_survives_a_later_patch(monkeypatch):
    rt, store = FakeAdminRuntime(), InMemorySandboxStore()
    _seed(rt, store, profile="ironclaw", image="reef-ic:test", user={"OTHER": "v"})
    client = _client(rt, store, monkeypatch)
    assert "LLM_BACKEND" in AGENT_TYPES["ironclaw"].profile().managed_env_keys

    r = client.patch("/fleet/oc1/env", json={"set": {"LLM_BACKEND": "groq"}, "apply": "none"})
    assert r.status_code == 200, r.text
    assert r.json()["changed"] is True

    body = client.get("/fleet/oc1/env").json()
    assert {v["key"] for v in body["vars"]} == {"OTHER", "LLM_BACKEND"}

    r = client.patch("/fleet/oc1/env", json={"set": {"UNRELATED": "v"}, "apply": "none"})
    assert r.status_code == 200, r.text
    assert {v["key"] for v in r.json()["vars"]} == {"OTHER", "LLM_BACKEND", "UNRELATED"}
    assert EnvRecord("s", "LLM_BACKEND", "groq") in rt.guest_env_data["oc1"]


class _FlakyRuntime(FakeAdminRuntime):
    """Lifecycle calls that can be made to fail, then stop failing. Raises BEFORE
    the superclass records the call, i.e. the operation did not happen at all."""

    def __init__(self) -> None:
        super().__init__()
        self.fail: set[str] = set()

    async def stop(self, handle: str) -> None:
        if "stop" in self.fail:
            raise RuntimeUnavailable("fake: stop refused")
        await super().stop(handle)

    async def destroy(self, handle: str) -> None:
        if "destroy" in self.fail:
            raise RuntimeUnavailable("fake: destroy refused")
        await super().destroy(handle)


def test_failed_restart_restores_the_overlay_verbatim_and_stays_retriable(monkeypatch):
    rt, store = _FlakyRuntime(), InMemorySandboxStore()
    _seed(rt, store)
    client = _client(rt, store, monkeypatch)
    rt.fail = {"stop"}
    body = {"set": {"AGENTPIT_API_KEY": "new-value"}, "apply": "restart"}

    assert client.patch("/fleet/oc1/env", json=body).status_code == 503
    assert rt.guest_env_data["oc1"] == []
    assert client.get("/fleet/oc1/env").json()["vars"] == []

    before = [
        EnvRecord("s", "AGENTPIT_API_KEY", "old-value"),
        # Filtered out of the read (REEF_ is guest-dropped), so only a VERBATIM
        # undo - the file as read, not a rebuild of the view - brings it back.
        EnvRecord("s", "REEF_LEFTOVER", "from-an-older-reef"),
    ]
    rt.guest_env_data["oc1"] = list(before)
    assert client.patch("/fleet/oc1/env", json=body).status_code == 503
    assert rt.guest_env_data["oc1"] == before
    # Both values are 9 chars: the record list above pins WHICH one came back.
    assert client.get("/fleet/oc1/env").json()["vars"] == [
        {"key": "AGENTPIT_API_KEY", "value_length": 9, "source": "file"},
    ]

    rt.fail.clear()
    r = client.patch("/fleet/oc1/env", json=body)
    assert r.status_code == 200, r.text
    assert r.json()["changed"] is True and r.json()["applied"] == "restart"
    assert rt.calls == [("stop", "oc1"), ("start", "oc1")]
    assert rt.guest_env_data["oc1"] == [EnvRecord("s", "AGENTPIT_API_KEY", "new-value")]


def test_failed_recreate_leaves_the_save_retriable(monkeypatch):
    rt, store = _FlakyRuntime(), InMemorySandboxStore()
    _seed(rt, store)
    client = _client(rt, store, monkeypatch)
    rt.fail = {"destroy"}

    body = {"set": {"AGENTPIT_API_KEY": "sk-live-example"}, "apply": "recreate"}
    r = client.patch("/fleet/oc1/env", json=body)
    assert r.status_code == 503, r.text
    assert rt.created == []
    assert rt.guest_env_data["oc1"] == []
    assert client.get("/fleet/oc1/env").json()["vars"] == []

    rt.fail.clear()
    r = client.patch("/fleet/oc1/env", json=body)
    assert r.status_code == 200, r.text
    assert r.json()["changed"] is True
    assert r.json()["applied"] == "recreate"
    assert ("destroy", "oc1") in rt.calls
    assert rt.created[-1].env["AGENTPIT_API_KEY"] == "sk-live-example"


def test_recreate_on_a_pre_feature_image_writes_no_overlay(monkeypatch):
    rt, store = FakeAdminRuntime(), InMemorySandboxStore()
    _seed(rt, store, feature=False)
    client = _client(rt, store, monkeypatch)

    r = client.patch(
        "/fleet/oc1/env",
        json={"set": {"AGENTPIT_API_KEY": "sk-live-example"}, "apply": "recreate"},
    )
    assert r.status_code == 200, r.text
    listed = [{"key": "AGENTPIT_API_KEY", "value_length": 15, "source": "container"}]
    assert r.json()["vars"] == listed
    assert "oc1" not in rt.guest_env_data  # not "written empty" - never written
    assert rt.created[-1].env["AGENTPIT_API_KEY"] == "sk-live-example"
    body = client.get("/fleet/oc1/env").json()
    assert body["vars"] == listed
    assert body["apply_modes"] == ["recreate"]


def test_failed_recreate_on_a_pre_feature_image_restores_what_it_found(monkeypatch):
    rt, store = _FlakyRuntime(), InMemorySandboxStore()
    _seed(rt, store, feature=False)
    client = _client(rt, store, monkeypatch)
    rt.fail = {"destroy"}
    body = {"set": {"NEW_KEY": "v"}, "apply": "recreate"}

    assert client.patch("/fleet/oc1/env", json=body).status_code == 503
    assert "oc1" not in rt.guest_env_data
    assert client.get("/fleet/oc1/env").json()["vars"] == []

    before = [
        EnvRecord("s", "OLD_KEY", "from-before-the-downgrade"),
        EnvRecord("s", "REEF_LEFTOVER", "from-an-older-reef"),
    ]
    rt.guest_env_data["oc1"] = list(before)
    assert client.patch("/fleet/oc1/env", json=body).status_code == 503
    assert rt.created == []
    assert rt.guest_env_data["oc1"] == before
    assert client.get("/fleet/oc1/env").json()["vars"] == [
        {"key": "OLD_KEY", "value_length": 25, "source": "file"},
    ]

    rt.fail.clear()
    r = client.patch("/fleet/oc1/env", json=body)
    assert r.status_code == 200, r.text
    assert r.json()["changed"] is True and r.json()["applied"] == "recreate"
    assert rt.guest_env_data["oc1"] == []
    assert rt.created[-1].env["OLD_KEY"] == "from-before-the-downgrade"
    assert rt.created[-1].env["NEW_KEY"] == "v"
    assert {v["source"] for v in r.json()["vars"]} == {"container"}


def test_legacy_ld_preload_is_hidden_unpinned_and_cleaned_by_a_recreate(monkeypatch):
    rt, store = FakeAdminRuntime(), InMemorySandboxStore()
    _seed(rt, store, injected={"LD_PRELOAD": "/tmp/evil.so"}, user={"MINE": "v"})
    client = _client(rt, store, monkeypatch)

    assert [v["key"] for v in client.get("/fleet/oc1/env").json()["vars"]] == ["MINE"]
    r = client.patch("/fleet/oc1/env", json={"unset": ["LD_PRELOAD"], "apply": "none"})
    assert r.status_code == 422 and "not settable" in r.json()["detail"]

    r = client.patch("/fleet/oc1/env", json={"set": {"OTHER": "v"}, "apply": "restart"})
    assert r.status_code == 200, r.text
    assert [rec.key for rec in rt.guest_env_data["oc1"]] == ["MINE", "OTHER"]
    assert dict(rt.inspect_data["oc1"]["config"]["env"])["LD_PRELOAD"] == "/tmp/evil.so"

    r = client.patch("/fleet/oc1/env", json={"set": {"THIRD": "v"}, "apply": "recreate"})
    assert r.status_code == 200, r.text
    assert "LD_PRELOAD" not in rt.created[-1].env
    assert rt.created[-1].env["MINE"] == "v"

    _seed(rt, store, sandbox_id="oc2", injected={"LD_PRELOAD": "/tmp/evil.so"})
    asyncio.run(_svc(rt, store).upgrade("oc2"))
    assert "LD_PRELOAD" not in rt.created[-1].env


def test_feature_marker_survives_a_second_token_with_a_space(monkeypatch):
    assert _supports_env_file({_ENV_FEATURE_KEY: "other, env-file"}) is True
    assert _supports_env_file({_ENV_FEATURE_KEY: " env-file "}) is True
    assert _supports_env_file({_ENV_FEATURE_KEY: "env-file,other"}) is True
    assert _supports_env_file({_ENV_FEATURE_KEY: "env-filet"}) is False  # whole token
    assert _supports_env_file({_ENV_FEATURE_KEY: ""}) is False
    assert _supports_env_file({}) is False

    rt, store = FakeAdminRuntime(), InMemorySandboxStore()
    _seed(rt, store)
    cfg = rt.inspect_data["oc1"]["config"]
    cfg["env"] = [[k, "other, env-file" if k == _ENV_FEATURE_KEY else v] for k, v in cfg["env"]]
    rt.image_env_data[_ENV_FEATURE_KEY] = "other, env-file"
    client = _client(rt, store, monkeypatch)

    assert client.get("/fleet/oc1/env").json()["apply_modes"] == ["restart", "recreate"]
    r = client.patch("/fleet/oc1/env", json={"set": {"A_KEY": "v"}, "apply": "restart"})
    assert r.status_code == 200, r.text
    assert r.json()["applied"] == "restart"
    assert rt.created == []


def test_a_trailing_newline_is_refused_by_both_doors(monkeypatch):
    rt, store = FakeAdminRuntime(), InMemorySandboxStore()
    _seed(rt, store)
    client = _client(rt, store, monkeypatch)
    svc = _svc(rt, store)
    secret = "sk-live-SUPERSECRET"

    r = client.patch("/fleet/oc1/env", json={"set": {"A_KEY": secret + "\n"}, "apply": "restart"})
    assert r.status_code == 422, r.text
    detail = r.json()["detail"]
    assert "A_KEY" in detail and "newline" in detail
    assert secret not in r.text  # the 422 names the key and the rule, never the value
    assert "oc1" not in rt.guest_env_data  # refused before the write and the bounce
    assert rt.calls == []

    with pytest.raises(ValueError, match="newline") as excinfo:
        asyncio.run(svc.create("openclaw", name="oc-nl", env={"A_KEY": secret + "\n"}))
    assert secret not in str(excinfo.value)
    assert rt.created == []

    r = client.patch("/fleet/oc1/env", json={"set": {"A_KEY": "line1\nline2"}, "apply": "none"})
    assert r.status_code == 200, r.text
    assert rt.guest_env_data["oc1"] == [EnvRecord("s", "A_KEY", "line1\nline2")]
    asyncio.run(svc.create("openclaw", name="oc-inner", env={"A_KEY": "line1\nline2"}))
    assert rt.created[-1].env["A_KEY"] == "line1\nline2"


class _FlakierRuntime(_FlakyRuntime):
    """``_FlakyRuntime`` plus the calls that are the SECOND half of an apply, so the
    stop (or destroy) has already landed. ``write_guest_env`` fails by COUNT: a
    test can let the apply's own write through and refuse only the UNDO's."""

    def __init__(self) -> None:
        super().__init__()
        self.writes_before_failure: int | None = None  # None ⇒ writes never fail
        self.writes = 0

    async def start(self, handle: str) -> None:
        if "start" in self.fail:
            raise RuntimeUnavailable("fake: start refused")
        await super().start(handle)

    async def create(self, spec):
        if "create" in self.fail:
            raise RuntimeUnavailable("fake: create refused")
        return await super().create(spec)

    async def write_guest_env(self, handle: str, records) -> None:
        self.writes += 1
        if self.writes_before_failure is not None and self.writes > self.writes_before_failure:
            raise RuntimeUnavailable("fake: overlay write refused")
        await super().write_guest_env(handle, records)


def test_failed_start_leaves_the_agent_down_and_the_save_retriable(monkeypatch):
    rt, store = _FlakierRuntime(), InMemorySandboxStore()
    _seed(rt, store)
    before = [EnvRecord("s", "AGENTPIT_API_KEY", "old-value")]
    rt.guest_env_data["oc1"] = list(before)
    client = _client(rt, store, monkeypatch)
    rt.fail = {"start"}

    body = {"set": {"AGENTPIT_API_KEY": "new-value"}, "apply": "restart"}
    r = client.patch("/fleet/oc1/env", json=body)
    assert r.status_code == 503, r.text
    assert rt.calls == [("stop", "oc1")]  # the half that did land
    assert rt.guest_env_data["oc1"] == before
    view = client.get("/fleet/oc1/env").json()
    assert view["vars"] == [{"key": "AGENTPIT_API_KEY", "value_length": 9, "source": "file"}]
    assert view["state"] == "stopped"

    rt.fail.clear()
    r = client.patch("/fleet/oc1/env", json=body)
    assert r.status_code == 200, r.text
    assert r.json()["changed"] is True  # a real change again, not a no-op
    assert r.json()["applied"] == "none"
    assert r.json()["takes_effect"] == "on_next_start"
    assert rt.calls == [("stop", "oc1")]  # nothing was bounced a second time
    assert rt.guest_env_data["oc1"] == [EnvRecord("s", "AGENTPIT_API_KEY", "new-value")]


def test_failed_create_restores_the_overlay_and_never_claims_the_save_landed(monkeypatch):
    rt, store = _FlakierRuntime(), InMemorySandboxStore()
    _seed(rt, store)
    before = [EnvRecord("s", "AGENTPIT_API_KEY", "old-value")]
    rt.guest_env_data["oc1"] = list(before)
    client = _client(rt, store, monkeypatch)
    rt.fail = {"create"}

    body = {"set": {"AGENTPIT_API_KEY": "new-value"}, "apply": "recreate"}
    r = client.patch("/fleet/oc1/env", json=body)
    assert r.status_code == 503, r.text
    assert rt.calls == [("destroy", "oc1")] and rt.created == []
    assert rt.guest_env_data["oc1"] == before

    # Both env paths say WHY there is nothing to read or write - not "unknown id".
    for r in (client.get("/fleet/oc1/env"), client.patch("/fleet/oc1/env", json=body)):
        assert r.status_code == 503, r.text
        assert "has no container right now" in r.json()["detail"]
    assert rt.guest_env_data["oc1"] == before

    # …and the rebuild the message points at makes both editable again.
    rt.fail.clear()
    assert client.post("/fleet/oc1/start").status_code == 200
    view = client.get("/fleet/oc1/env")
    assert view.status_code == 200, view.text
    assert view.json()["editable"] is True
    assert rt.guest_env_data["oc1"] == before  # the undo's file, still untouched


def test_a_failed_undo_reports_the_apply_failure_not_its_own(monkeypatch):
    rt, store = _FlakierRuntime(), InMemorySandboxStore()
    _seed(rt, store)
    client = _client(rt, store, monkeypatch)
    rt.fail = {"stop"}
    rt.writes_before_failure = 1  # the apply's write lands; the undo's is refused

    r = client.patch("/fleet/oc1/env", json={"set": {"A_KEY": "v"}, "apply": "restart"})
    assert r.status_code == 503, r.text
    assert "stop refused" in r.json()["detail"]
    assert "overlay write refused" not in r.text
    assert rt.writes == 2  # the undo really was attempted and really did fail
    assert rt.guest_env_data["oc1"] == [EnvRecord("s", "A_KEY", "v")]


def test_a_refused_overlay_write_bounces_nothing_and_stays_retriable(monkeypatch):
    rt, store = _FlakierRuntime(), InMemorySandboxStore()
    _seed(rt, store)
    before = [EnvRecord("s", "AGENTPIT_API_KEY", "old-value")]
    rt.guest_env_data["oc1"] = list(before)
    client = _client(rt, store, monkeypatch)
    rt.writes_before_failure = 0

    body = {"set": {"AGENTPIT_API_KEY": "new-value"}, "apply": "restart"}
    r = client.patch("/fleet/oc1/env", json=body)
    assert r.status_code == 503, r.text
    assert rt.calls == []
    assert rt.guest_env_data["oc1"] == before

    rt.writes_before_failure = None
    r = client.patch("/fleet/oc1/env", json=body)
    assert r.status_code == 200, r.text
    assert r.json()["changed"] is True and r.json()["applied"] == "restart"
    assert rt.calls == [("stop", "oc1"), ("start", "oc1")]
    assert rt.guest_env_data["oc1"] == [EnvRecord("s", "AGENTPIT_API_KEY", "new-value")]


def test_dangerous_key_in_the_overlay_file_is_hidden_dropped_and_never_promoted(monkeypatch):
    rt, store = FakeAdminRuntime(), InMemorySandboxStore()
    _seed(rt, store, user={"MINE": "v"})
    rt.guest_env_data["oc1"] = [
        EnvRecord("s", "MINE", "v"),
        EnvRecord("s", "LD_PRELOAD", "/tmp/evil.so"),
    ]
    client = _client(rt, store, monkeypatch)

    assert [v["key"] for v in client.get("/fleet/oc1/env").json()["vars"]] == ["MINE"]
    r = client.patch("/fleet/oc1/env", json={"set": {"OTHER": "v"}, "apply": "restart"})
    assert r.status_code == 200, r.text
    assert [rec.key for rec in rt.guest_env_data["oc1"]] == ["MINE", "OTHER"]

    r = client.patch("/fleet/oc1/env", json={"set": {"THIRD": "v"}, "apply": "recreate"})
    assert r.status_code == 200, r.text
    assert "LD_PRELOAD" not in rt.created[-1].env
    assert rt.created[-1].env["MINE"] == "v"
    assert rt.created[-1].env["THIRD"] == "v"


def test_detail_env_never_carries_a_user_value_after_a_recreate(monkeypatch):
    rt, store = FakeAdminRuntime(), InMemorySandboxStore()
    _seed(rt, store, injected={"CLAWBITS_API_KEY": "reef-issued", "OPENCLAW_GATEWAY_TOKEN": "gw-t"})
    client = _client(rt, store, monkeypatch)
    values = {"DATABASE_URL": "postgres://u:pw@h/db", "AGENTPIT_API_KEY": "sk-live-SUPERSECRET"}

    r = client.patch("/fleet/oc1/env", json={"set": values, "apply": "recreate"})
    assert r.status_code == 200, r.text
    assert {k: rt.created[-1].env[k] for k in values} == values

    r = client.get("/fleet/oc1")
    assert r.status_code == 200, r.text
    for value in values.values():
        assert value not in r.text
    assert r.json()["env"]["CLAWBITS_API_KEY"] == _MASK
    assert r.json()["env"]["OPENCLAW_GATEWAY_TOKEN"] == _MASK


def test_every_dangerous_key_is_refused_by_create_and_patch(monkeypatch):
    assert {"LD_AUDIT", "NODE_EXTRA_CA_CERTS"} <= _DANGEROUS_ENV_KEYS
    rt, store = FakeAdminRuntime(), InMemorySandboxStore()
    _seed(rt, store)
    svc, client = _svc(rt, store), _client(rt, store, monkeypatch)

    for key in sorted(_DANGEROUS_ENV_KEYS):
        with pytest.raises(ValueError, match="not settable"):
            asyncio.run(svc.create("openclaw", name="oc-danger", env={key: "x"}))
        r = client.patch("/fleet/oc1/env", json={"set": {key: "x"}, "apply": "none"})
        assert r.status_code == 422, (key, r.text)
        assert "not settable" in r.json()["detail"], (key, r.text)
    assert rt.created == [] and rt.calls == [] and "oc1" not in rt.guest_env_data


def test_a_failed_create_leaves_the_agent_visible_and_recoverable(monkeypatch):
    rt, store = _FlakierRuntime(), InMemorySandboxStore()
    _seed(rt, store, injected={"OPENCLAW_GATEWAY_TOKEN": "the-access-secret"})
    client = _client(rt, store, monkeypatch)
    rt.fail = {"create"}

    body = {"set": {"A_KEY": "v"}, "apply": "recreate"}
    assert client.patch("/fleet/oc1/env", json=body).status_code == 503
    rec = asyncio.run(store.get("oc1"))
    assert rec.state is SandboxState.FAILED and rec.handle is None
    assert rec.desired_state is DesiredState.RUNNING  # intent survives a failure
    assert [(e["sandbox_id"], e["state"], e["managed"]) for e in client.get("/fleet").json()] == [
        ("oc1", "failed", True)
    ]
    detail = client.get("/fleet/oc1")  # it has a record; 404 would be a lie
    assert detail.status_code == 200, detail.text
    assert detail.json()["state"] == "failed" and detail.json()["managed"] is True

    # The ordinary control recovers it - on the SAME image and the SAME volumes.
    rt.fail.clear()
    r = client.post("/fleet/oc1/start")
    assert r.status_code == 200 and r.json()["state"] == "running", r.text
    assert rt.calls == [("destroy", "oc1"), ("start", "oc1")]  # no second destroy
    assert [(s.image, s.volume, s.extra_volumes) for s in rt.created] == [
        ("reef-oc:test", "reef-oc1", (("reef-oc1-config", "/home/node/.config/openclaw"),))
    ]
    # Replayed, not re-minted: the operator's access password still works.
    assert rt.created[-1].env["OPENCLAW_GATEWAY_TOKEN"] == "the-access-secret"
    assert client.get("/fleet/oc1").json()["state"] == "running"
    assert asyncio.run(store.get("oc1")).image == "reef-oc:test"


def test_a_rebuild_needs_a_record_but_survives_a_reef_restart(monkeypatch):
    """``start`` still must not rebuild without a store record (drift, or an id reef
    never knew). A failed create in a PREVIOUS reef process is no longer one of
    those cases: the spec is parked host-side, so recovery outlives the process."""
    rt, store = _FlakierRuntime(), InMemorySandboxStore()
    _seed(rt, store, injected={"OPENCLAW_GATEWAY_TOKEN": "the-access-secret"})
    client = _client(rt, store, monkeypatch)
    rt.fail = {"create"}
    body = {"set": {"A_KEY": "v"}, "apply": "recreate"}
    assert client.patch("/fleet/oc1/env", json=body).status_code == 503
    rt.fail.clear()

    assert client.get("/fleet/ghost").status_code == 404
    assert client.post("/fleet/ghost/start").status_code == 404

    fresh = _client(rt, store, monkeypatch)  # a reef restart: the in-memory stash is gone
    r = fresh.post("/fleet/oc1/start")
    assert r.status_code == 200 and r.json()["state"] == "running", r.text
    assert rt.created[-1].image == "reef-oc:test"
    assert rt.created[-1].env["OPENCLAW_GATEWAY_TOKEN"] == "the-access-secret"
    assert "oc1+pending" not in rt.guest_env_data  # dropped once the container is back
    assert fresh.get("/fleet/oc1/env").json()["editable"] is True


def test_a_failed_recreate_save_is_rolled_back_and_never_lands_on_start(monkeypatch):
    """The save was reported FAILED, so recovery must restore the env the destroyed
    container HAD - not the one that failed to apply. A failed unset in particular
    must not delete the key."""
    old, new, kept = "OLD-value-aaaaaaaaaaaaaaaa", "NEWv", "keepme"
    rt, store = _FlakierRuntime(), InMemorySandboxStore()
    _seed(rt, store, user={"K1": old, "K2": kept})
    client = _client(rt, store, monkeypatch)
    rt.fail = {"create"}

    body = {"set": {"K1": new}, "unset": ["K2"], "apply": "recreate"}
    r = client.patch("/fleet/oc1/env", json=body)
    assert r.status_code == 503, r.text
    assert "rolled back" in r.json()["detail"]

    rt.fail.clear()
    assert client.post("/fleet/oc1/start").status_code == 200
    assert rt.created[-1].env["K1"] == old  # the failed set did not go live
    assert rt.created[-1].env["K2"] == kept  # the failed unset did not delete the key
    assert client.get("/fleet/oc1/env").json()["vars"] == [
        {"key": "K1", "value_length": len(old), "source": "container"},
        {"key": "K2", "value_length": len(kept), "source": "container"},
    ]

    r = client.patch("/fleet/oc1/env", json=body)  # and the save is still retriable
    assert r.status_code == 200 and r.json()["changed"] is True, r.text
    assert rt.created[-1].env["K1"] == new and "K2" not in rt.created[-1].env


def test_a_failed_recreate_whose_undo_also_failed_reports_the_save_as_pending(monkeypatch):
    """The other arm. The overlay outranks the -e layer a rebuild replays, so a save
    reef could not undo IS pending, and recovery makes it live - claiming "rolled
    back" here is how a save reported failed goes into effect unannounced."""
    old, new, kept = "OLD-value-aaaaaaaaaaaaaaaa", "NEWv", "keepme"
    rt, store = _FlakierRuntime(), InMemorySandboxStore()
    _seed(rt, store, user={"K1": old, "K2": kept})
    client = _client(rt, store, monkeypatch)
    rt.fail = {"create"}
    rt.writes_before_failure = 2  # the apply's write and the stash land, the undo's does not

    body = {"set": {"K1": new}, "unset": ["K2"], "apply": "recreate"}
    r = client.patch("/fleet/oc1/env", json=body)
    assert r.status_code == 503, r.text
    detail = r.json()["detail"]
    assert "It is now PENDING" in detail and "rolled back" not in detail

    rt.fail.clear()
    rt.writes_before_failure = None
    assert client.post("/fleet/oc1/start").status_code == 200
    assert rt.created[-1].env["K1"] == old and rt.created[-1].env["K2"] == kept
    # What the guest computes at boot is exactly what the 503 promised: the set is
    # live off the file, the unset is not - hence "re-read its env and set it".
    assert client.get("/fleet/oc1/env").json()["vars"] == [
        {"key": "K1", "value_length": len(new), "source": "file"},
        {"key": "K2", "value_length": len(kept), "source": "container"},
    ]


def test_upgrade_recovers_a_container_less_agent_onto_the_active_image(monkeypatch):
    """The other control the copy names. It reads the parked spec rather than
    inspecting a container that no longer exists, so it works after a restart too."""
    monkeypatch.setenv("REEF_OPENCLAW_IMAGE", "reef-oc:new")
    rt, store = _FlakierRuntime(), InMemorySandboxStore()
    _seed(rt, store, image="reef-oc:old", injected={"OPENCLAW_GATEWAY_TOKEN": "the-access-secret"})
    client = _client(rt, store, monkeypatch)
    rt.fail = {"create"}
    body = {"set": {"A_KEY": "v"}, "apply": "recreate"}
    assert client.patch("/fleet/oc1/env", json=body).status_code == 503
    rt.fail.clear()

    fresh = _client(rt, store, monkeypatch)
    r = fresh.post("/fleet/oc1/upgrade")
    assert r.status_code == 200 and r.json()["state"] == "running", r.text
    assert rt.created[-1].image == "reef-oc:new"
    assert rt.created[-1].env["OPENCLAW_GATEWAY_TOKEN"] == "the-access-secret"
    assert "A_KEY" not in rt.created[-1].env  # the rolled-back env, carried forward


def test_with_no_parked_spec_neither_control_claims_it_can_recover(monkeypatch):
    """The stash is the whole recovery. Without it, both controls say what actually
    has to happen instead of pointing at each other."""
    rt, store = _FlakierRuntime(), InMemorySandboxStore()
    _seed(rt, store)
    client = _client(rt, store, monkeypatch)
    rt.fail = {"create"}
    body = {"set": {"A_KEY": "v"}, "apply": "recreate"}
    assert client.patch("/fleet/oc1/env", json=body).status_code == 503
    rt.fail.clear()
    rt.guest_env_data.pop("oc1+pending")  # the stash could not be written

    fresh = _client(rt, store, monkeypatch)
    for r in (
        fresh.post("/fleet/oc1/start"),
        fresh.post("/fleet/oc1/upgrade"),
        fresh.get("/fleet/oc1/env"),  # must not point at either of those two
    ):
        assert r.status_code == 503, r.text
        assert "Delete this agent and create it again" in r.json()["detail"]
    assert rt.created == []


def test_a_failed_upgrade_rebuilds_on_the_image_that_was_running(monkeypatch):
    """The other recreate. Recovery restores what was running, so a failed upgrade
    rolls BACK - it never ships the image change the failed attempt was after."""
    monkeypatch.setenv("REEF_OPENCLAW_IMAGE", "reef-oc:new")
    monkeypatch.setenv("REEF_ADMIN_TOKEN", TOKEN)
    rt, store = _FlakierRuntime(), InMemorySandboxStore()
    _seed(rt, store, image="reef-oc:old")
    svc = _svc(rt, store)
    client = TestClient(create_app(service=svc))
    client.headers["Authorization"] = f"Bearer {TOKEN}"

    rt.fail = {"create"}
    with pytest.raises(RuntimeUnavailable):
        asyncio.run(svc.upgrade("oc1"))
    assert asyncio.run(store.get("oc1")).state is SandboxState.FAILED

    r = client.get("/fleet/oc1/env")  # same container-less path, but no env was touched
    assert r.status_code == 503, r.text
    assert "rolled back" not in r.json()["detail"] and "env change" not in r.json()["detail"]

    rt.fail.clear()
    assert client.post("/fleet/oc1/start").status_code == 200
    assert rt.created[-1].image == "reef-oc:old"
    assert asyncio.run(store.get("oc1")).image == "reef-oc:old"


def test_unknown_and_drift_ids_are_404_on_every_env_and_recovery_route(monkeypatch):
    """Recovery only exists for records reef holds. An id it never knew and a
    hand-created VM must 404 rather than be handed a rebuild it cannot spec."""
    rt, store = FakeAdminRuntime(), InMemorySandboxStore()
    _seed(rt, store, sandbox_id="drift1", managed=False)
    client = _client(rt, store, monkeypatch)

    for sandbox_id in ("ghost", "drift1"):
        body = {"set": {"A_KEY": "v"}, "apply": "none"}
        assert client.patch(f"/fleet/{sandbox_id}/env", json=body).status_code == 404
        assert client.post(f"/fleet/{sandbox_id}/upgrade").status_code == 404
    for r in (client.get("/fleet/ghost"), client.get("/fleet/ghost/env")):
        assert r.status_code == 404, r.text
    assert client.post("/fleet/ghost/start").status_code == 404
    assert rt.created == []


def test_a_legacy_trailing_newline_value_is_never_written_to_the_file(monkeypatch):
    rt, store = FakeAdminRuntime(), InMemorySandboxStore()
    _seed(rt, store, user={"LEGACY": "val\n"})
    client = _client(rt, store, monkeypatch)

    r = client.patch("/fleet/oc1/env", json={"set": {"OTHER": "v"}, "apply": "restart"})
    assert r.status_code == 422, r.text
    detail = r.json()["detail"]
    assert "LEGACY" in detail and "newline" in detail and "predates the rule" in detail
    assert "oc1" not in rt.guest_env_data and rt.calls == []
    assert client.get("/fleet/oc1/env").json()["vars"] == [
        {"key": "LEGACY", "value_length": 4, "source": "container"},
    ]

    r = client.patch("/fleet/oc1/env", json={"set": {"LEGACY": "val"}, "apply": "restart"})
    assert r.status_code == 200, r.text
    assert rt.guest_env_data["oc1"] == [EnvRecord("s", "LEGACY", "val")]


def test_rotating_a_create_time_value_leaves_the_old_one_nowhere(monkeypatch):
    rt, store = FakeAdminRuntime(), InMemorySandboxStore()
    _seed(rt, store, user={"AGENTPIT_API_KEY": "leaked-v1"})
    client = _client(rt, store, monkeypatch)

    def rotate(value: str, apply: str) -> None:
        r = client.patch(
            "/fleet/oc1/env", json={"set": {"AGENTPIT_API_KEY": value}, "apply": apply}
        )
        assert r.status_code == 200, r.text

    rotate("rotated-v2", "restart")
    assert dict(rt.inspect_data["oc1"]["config"]["env"])["AGENTPIT_API_KEY"] == "leaked-v1"

    asyncio.run(_svc(rt, store).upgrade("oc1"))
    assert rt.created[-1].env["AGENTPIT_API_KEY"] == "rotated-v2"
    assert "leaked-v1" not in rt.created[-1].env.values()

    rotate("rotated-v3", "recreate")
    assert rt.created[-1].env["AGENTPIT_API_KEY"] == "rotated-v3"
    assert not {"leaked-v1", "rotated-v2"} & set(rt.created[-1].env.values())
