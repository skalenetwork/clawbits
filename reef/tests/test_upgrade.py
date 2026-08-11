"""In-place image upgrade: ``SandboxManager.recreate_with_image`` (replay env +
reuse volumes + bump image), ``FleetService.upgrade`` (image-env subtraction +
profile resolution), and the ``POST /fleet/{id}/upgrade`` route.

Async bits run via ``asyncio.run`` (no pytest-asyncio).
"""

from __future__ import annotations

import asyncio

from fastapi.testclient import TestClient

from reef.api.app import create_app
from reef.fleet import FleetService
from reef.manager import SandboxManager
from reef.models import Sandbox
from reef.profiles import OpenClawProfile
from reef.runtime import DesiredState, Limits, SandboxState
from reef.store import InMemorySandboxStore
from reef.tests.fakes import FakeAdminRuntime


def _seed_running(store, rt, *, image="reef-oc:old", desired=DesiredState.RUNNING, profile="openclaw"):
    rec = Sandbox(
        sandbox_id="oc1",
        profile=profile,
        backend="fake",
        state=SandboxState.RUNNING,
        image=image,
        volume="reef-oc1",
        handle="oc1",
        port=19000,
        terminal_port=19001,
        desired_state=desired,
        color="blue",
    )
    rt.states["oc1"] = SandboxState.RUNNING
    return rec


# ── manager.recreate_with_image ───────────────────────────────────────────────
def test_recreate_replays_env_reuses_volume_and_bumps_image():
    async def scenario():
        rt = FakeAdminRuntime()
        store = InMemorySandboxStore()
        mgr = SandboxManager(rt, store, backend="fake")
        rec = _seed_running(store, rt)
        await store.put(rec)

        profile = OpenClawProfile(image="reef-oc:new")
        env = {
            "OPENCLAW_GATEWAY_TOKEN": "the-access-secret",  # replayed ⇒ password preserved
            "CLAWBITS_ORG_ID": "acme",
            "MY_FLAG": "on",
        }
        out = await mgr.recreate_with_image("oc1", profile, env, limits=Limits(cpus=2, memory_mb=2048))

        assert out.image == "reef-oc:new"
        assert out.state is SandboxState.RUNNING
        assert out.color == "blue"  # operator settings preserved
        # destroyed then re-created (volumes survive destroy).
        assert ("destroy", "oc1") in rt.calls
        spec = rt.created[-1]
        assert spec.image == "reef-oc:new"
        assert spec.volume == "reef-oc1"  # SAME named volume
        assert spec.env["OPENCLAW_GATEWAY_TOKEN"] == "the-access-secret"
        assert spec.env["CLAWBITS_ORG_ID"] == "acme"
        assert spec.env["MY_FLAG"] == "on"
        assert spec.env["REEF_STATUS_DIR"]  # status mount re-declared
        # Forwards re-minted from the RECORD's ports (not inspect).
        assert any("19000" in p for p in spec.ports)
        assert any("19001" in p for p in spec.ports)
        # The persistent config volume (where identity is mirrored) is reused.
        assert ("reef-oc1-config", "/home/node/.config/openclaw") in spec.extra_volumes

    asyncio.run(scenario())


def test_recreate_respects_a_deliberate_stop():
    async def scenario():
        rt = FakeAdminRuntime()
        store = InMemorySandboxStore()
        mgr = SandboxManager(rt, store, backend="fake")
        rec = _seed_running(store, rt, desired=DesiredState.STOPPED)
        await store.put(rec)
        out = await mgr.recreate_with_image("oc1", OpenClawProfile(image="reef-oc:new"), {})
        # Recreated but NOT started — the operator had it stopped.
        assert out.state is SandboxState.STOPPED
        assert ("start", "oc1") not in rt.calls

    asyncio.run(scenario())


# ── fleet.upgrade ─────────────────────────────────────────────────────────────
def test_upgrade_subtracts_image_baked_env(monkeypatch):
    monkeypatch.setenv("REEF_OPENCLAW_IMAGE", "reef-oc:new")

    async def scenario():
        rt = FakeAdminRuntime()
        store = InMemorySandboxStore()
        mgr = SandboxManager(rt, store, backend="fake")
        svc = FleetService(rt, store, manager=mgr)
        rec = _seed_running(store, rt, image="reef-oc:old")
        await store.put(rec)
        # Container env = reef-injected + the OLD image's baked ENV.
        rt.inspect_data["oc1"] = {
            "config": {
                "env": [
                    ["OPENCLAW_GATEWAY_TOKEN", "tok"],
                    ["CLAWBITS_ORG_ID", "acme"],
                    ["REEF_IMAGE_VERSION", "0.5.0"],  # image-baked — must NOT replay
                    ["PATH", "/usr/bin"],  # image-baked — must NOT replay
                ],
                "cpus": 2,
                "memory_mib": 2048,
            }
        }
        rt.image_env_data = {"REEF_IMAGE_VERSION": "0.5.0", "PATH": "/usr/bin"}

        out = await svc.upgrade("oc1")
        assert out.image == "reef-oc:new"
        spec = rt.created[-1]
        # Reef-injected vars replayed…
        assert spec.env["OPENCLAW_GATEWAY_TOKEN"] == "tok"
        assert spec.env["CLAWBITS_ORG_ID"] == "acme"
        # …image-baked vars subtracted so the new image's own ENV wins.
        assert "REEF_IMAGE_VERSION" not in spec.env
        assert "PATH" not in spec.env

    asyncio.run(scenario())


def test_upgrade_unknown_or_drift_raises_not_found():
    from reef.errors import SandboxNotFound

    async def scenario():
        rt = FakeAdminRuntime()
        store = InMemorySandboxStore()
        svc = FleetService(rt, store, manager=SandboxManager(rt, store, backend="fake"))
        # Not in the store ⇒ drift / unknown ⇒ reef can't recreate it.
        try:
            await svc.upgrade("ghost")
        except SandboxNotFound:
            return
        raise AssertionError("expected SandboxNotFound")

    asyncio.run(scenario())


# ── route ─────────────────────────────────────────────────────────────────────
def _client(rt, store):
    return TestClient(create_app(service=FleetService(rt, store, manager=SandboxManager(rt, store, backend="fake"))))


def test_upgrade_route_ok(monkeypatch):
    monkeypatch.setenv("REEF_OPENCLAW_IMAGE", "reef-oc:new")
    rt = FakeAdminRuntime()
    store = InMemorySandboxStore()
    rec = _seed_running(store, rt, image="reef-oc:old")
    asyncio.run(store.put(rec))
    rt.inspect_data["oc1"] = {"config": {"env": [["CLAWBITS_ORG_ID", "acme"]], "cpus": 2, "memory_mib": 2048}}
    r = _client(rt, store).post("/fleet/oc1/upgrade")
    assert r.status_code == 200, r.text
    assert r.json() == {"sandbox_id": "oc1", "state": "running"}


def test_upgrade_route_unknown_is_404():
    rt = FakeAdminRuntime()
    store = InMemorySandboxStore()
    assert _client(rt, store).post("/fleet/ghost/upgrade").status_code == 404


def test_upgrade_recomputes_net_allow_union_for_ollama(monkeypatch):
    # Regression guard for the silent-LLM-death case: create() opens host
    # egress for a host-local ollama, and upgrade() must recompute the SAME
    # union from the replayed env — clawbits endpoint alone would drop the
    # rule and strand the agent's LLM on msb after the first image upgrade.
    monkeypatch.setenv("REEF_OPENCLAW_IMAGE", "reef-oc:new")

    async def scenario():
        rt = FakeAdminRuntime()
        store = InMemorySandboxStore()
        mgr = SandboxManager(rt, store, backend="fake")
        svc = FleetService(rt, store, manager=mgr)
        rec = _seed_running(store, rt, image="reef-oc:old")
        await store.put(rec)
        rt.inspect_data["oc1"] = {
            "config": {
                "env": [
                    ["OPENCLAW_GATEWAY_TOKEN", "tok"],
                    ["CLAWBITS_ENDPOINT", "https://clawbits.ai"],  # public — no rule alone
                    ["OLLAMA_HOST", "http://host.microsandbox.internal:11434"],
                ],
            }
        }
        rt.image_env_data = {}

        await svc.upgrade("oc1")
        spec = rt.created[-1]
        assert spec.env["OLLAMA_HOST"] == "http://host.microsandbox.internal:11434"
        assert spec.net_allow == ("public", "host")

    asyncio.run(scenario())


def test_upgrade_net_allow_covers_ironclaw_base_url_spelling(monkeypatch):
    # An ironclaw agent's replayed env spells the endpoint OLLAMA_BASE_URL.
    monkeypatch.setenv("REEF_OPENCLAW_IMAGE", "reef-oc:new")

    async def scenario():
        rt = FakeAdminRuntime()
        store = InMemorySandboxStore()
        mgr = SandboxManager(rt, store, backend="fake")
        svc = FleetService(rt, store, manager=mgr)
        rec = _seed_running(store, rt, image="reef-oc:old")
        await store.put(rec)
        rt.inspect_data["oc1"] = {
            "config": {
                "env": [["OLLAMA_BASE_URL", "http://192.168.1.20:11434"]],
            }
        }
        rt.image_env_data = {}
        await svc.upgrade("oc1")
        assert rt.created[-1].net_allow == ("public", "private")

    asyncio.run(scenario())


def test_upgrade_net_allow_covers_hermes_base_url_spelling(monkeypatch):
    # A hermes agent's replayed env spells the clawbits endpoint
    # CLAWBITS_BASE_URL (profiles.HermesProfile), not CLAWBITS_ENDPOINT —
    # the upgrade must keep the host-egress rule or the agent loses its
    # clawbits backend on msb after the first image upgrade.
    monkeypatch.setenv("REEF_HERMES_IMAGE", "reef-hm:new")

    async def scenario():
        rt = FakeAdminRuntime()
        store = InMemorySandboxStore()
        mgr = SandboxManager(rt, store, backend="fake")
        svc = FleetService(rt, store, manager=mgr)
        rec = _seed_running(store, rt, image="reef-hm:old", profile="hermes")
        await store.put(rec)
        rt.inspect_data["oc1"] = {
            "config": {
                "env": [["CLAWBITS_BASE_URL", "http://host.microsandbox.internal:8000"]],
            }
        }
        rt.image_env_data = {}
        await svc.upgrade("oc1")
        assert rt.created[-1].net_allow == ("public", "host")

    asyncio.run(scenario())


def test_upgrade_takes_capabilities_from_the_record_not_the_container(monkeypatch):
    """Capabilities are the ONE thing upgrade does not replay from the container.

    The running container carries the REEF_CAPS it BOOTED with, which goes stale
    the moment an operator PATCHes the grant. The record is authoritative, so a
    grant made since the last boot must land, and a revoke must actually reach
    the guest (hence an explicit empty value rather than an absent key)."""
    monkeypatch.setenv("REEF_OPENCLAW_IMAGE", "reef-oc:new")

    async def scenario():
        rt = FakeAdminRuntime()
        store = InMemorySandboxStore()
        mgr = SandboxManager(rt, store, backend="fake")
        svc = FleetService(rt, store, manager=mgr)
        rec = _seed_running(store, rt, image="reef-oc:old")
        rec.capabilities = ("cron",)  # operator PATCHed since the container booted
        await store.put(rec)
        rt.inspect_data["oc1"] = {
            "config": {
                "env": [
                    ["OPENCLAW_GATEWAY_TOKEN", "tok"],
                    ["REEF_CAPS", "gh"],  # stale: what it booted with
                ],
            }
        }
        rt.image_env_data = {}

        await svc.upgrade("oc1")
        assert rt.created[-1].env["REEF_CAPS"] == "cron"

        # And a full revoke reaches the guest as an explicit empty value.
        rec2 = await store.get("oc1")
        rec2.capabilities = ()
        await store.put(rec2)
        rt.inspect_data["oc1"] = {
            "config": {"env": [["OPENCLAW_GATEWAY_TOKEN", "tok"], ["REEF_CAPS", "cron"]]}
        }
        await svc.upgrade("oc1")
        assert rt.created[-1].env["REEF_CAPS"] == ""

    asyncio.run(scenario())
