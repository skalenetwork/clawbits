"""Capability normalization + the create/PATCH/upgrade wiring around it."""

import asyncio

import pytest

from reef.capabilities import CAPABILITIES, normalize, to_env


def test_normalize_accepts_both_shapes():
    # The store/API pass a list; a profile receives creds["capabilities"] as a
    # comma-separated STRING (creds is dict[str, str]) — walking that as a
    # sequence would iterate characters.
    assert normalize(["gh", "cron"]) == ("gh", "cron")
    assert normalize("gh,cron") == ("gh", "cron")
    assert normalize("") == () and normalize(None) == () and normalize([]) == ()


def test_normalize_is_order_stable_and_deduped():
    # An unstable value would make every upgrade look like a capability change.
    assert normalize(["cron", "gh"]) == normalize(["gh", "cron"]) == ("gh", "cron")
    assert normalize(["gh", "gh"]) == ("gh",)
    assert normalize([" GH ", "Cron"]) == ("gh", "cron")


def test_normalize_rejects_unknown_rather_than_dropping():
    # Dropping silently would hand back an agent less capable than the UI claimed.
    with pytest.raises(ValueError, match="unknown capability"):
        normalize(["gh", "root"])
    with pytest.raises(ValueError, match="unknown capability"):
        normalize(["group:messaging"])


def test_to_env_always_sets_the_var():
    # Empty must be an explicit "", not an absent key: the entrypoint needs to
    # tell "granted nothing" (turn features OFF) from "old reef" (leave alone).
    assert to_env([]) == {"REEF_CAPS": ""}
    assert to_env(["cron"]) == {"REEF_CAPS": "cron"}


def test_capability_names_are_the_two_that_leave_the_vm():
    # Guard the selection rule: only capabilities the microVM does NOT contain.
    assert set(CAPABILITIES) == {"gh", "cron"}


def test_create_rejects_unknown_capability_before_any_runtime_call(monkeypatch):
    from reef.tests.test_fleet import _svc_with_manager

    svc, rt, _store = _svc_with_manager()
    with pytest.raises(ValueError, match="unknown capability"):
        asyncio.run(svc.create("openclaw", name="oc-bad", capabilities=["nope"]))
    assert rt.created == []  # fail-fast: nothing was provisioned


def test_create_persists_and_injects_capabilities():
    from reef.tests.test_fleet import _svc_with_manager

    svc, rt, store = _svc_with_manager()
    sandbox, _ = asyncio.run(
        svc.create("openclaw", name="oc-caps", capabilities=["cron", "gh"])
    )
    # Guest side: the entrypoint reads REEF_CAPS.
    assert rt.created[-1].env["REEF_CAPS"] == "gh,cron"
    # Record side: still answerable long after the create call.
    assert sandbox.capabilities == ("gh", "cron")
    assert asyncio.run(store.get("oc-caps")).capabilities == ("gh", "cron")


def test_create_without_capabilities_injects_explicit_empty():
    from reef.tests.test_fleet import _svc_with_manager

    svc, rt, _store = _svc_with_manager()
    asyncio.run(svc.create("openclaw", name="oc-none"))
    assert rt.created[-1].env["REEF_CAPS"] == ""


def test_capabilities_cannot_be_self_granted_via_user_env():
    """Every toggle is a REEF_* var and that prefix is reserved, so the generic
    create-time `env` passthrough cannot be used to grant a capability."""
    from reef.tests.test_fleet import _svc_with_manager

    svc, _rt, _store = _svc_with_manager()
    with pytest.raises(ValueError, match="managed by reef"):
        asyncio.run(svc.create("openclaw", name="oc-evil", env={"REEF_CAPS": "gh,cron"}))


def test_patch_updates_the_record_and_can_revoke():
    from reef.tests.test_fleet import _svc_with_manager

    svc, _rt, store = _svc_with_manager()
    asyncio.run(svc.create("openclaw", name="oc-patch", capabilities=["gh"]))
    rec = asyncio.run(svc.update_settings("oc-patch", capabilities=["cron"]))
    assert rec.capabilities == ("cron",)
    # [] revokes everything; omitting the field leaves it untouched.
    assert asyncio.run(svc.update_settings("oc-patch", capabilities=[])).capabilities == ()
    assert asyncio.run(svc.update_settings("oc-patch", color="blue")).capabilities == ()
    assert asyncio.run(store.get("oc-patch")).capabilities == ()
