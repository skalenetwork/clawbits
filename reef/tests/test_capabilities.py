"""Capability normalization + the create/PATCH/upgrade wiring around it."""

import asyncio
import re
from pathlib import Path

import pytest

from reef.capabilities import CAPABILITIES, DEFAULT_CAPABILITIES, normalize, to_env


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


def test_defaults_are_gh_and_cron():
    """Both frontends mirror this list; changing it here means changing
    DEFAULT_CAPABILITIES in the two wizards too."""
    assert DEFAULT_CAPABILITIES == ("gh", "cron")
    assert set(DEFAULT_CAPABILITIES) <= set(CAPABILITIES)
    assert normalize(DEFAULT_CAPABILITIES) == DEFAULT_CAPABILITIES  # already canonical


def test_both_wizards_mirror_the_defaults():
    """The two create wizards pre-tick their checkboxes from a hardcoded
    DEFAULT_CAPABILITIES, because the wizard's INITIAL state is a static const
    that cannot wait on an async /providers round-trip. That mirror is only safe
    if something notices when it drifts — a stale client list would pre-tick a
    box the server then contradicts, which is exactly the "the UI claimed a
    capability the agent didn't get" failure the 422 elsewhere exists to prevent.
    """
    repo = Path(__file__).parents[2]
    wizards = [
        repo / "reef" / "admin-ui" / "src" / "components" / "create-agent" / "useCreateWizard.ts",
        repo / "frontend" / "src" / "components" / "new-agent" / "useWizard.ts",
    ]
    for path in wizards:
        assert path.exists(), f"wizard moved? {path}"
        match = re.search(r"DEFAULT_CAPABILITIES\s*=\s*\[([^\]]*)\]", path.read_text())
        assert match, f"no DEFAULT_CAPABILITIES literal in {path.name}"
        mirrored = tuple(re.findall(r'"([^"]+)"', match.group(1)))
        assert mirrored == DEFAULT_CAPABILITIES, f"{path.name} drifted from reef/capabilities.py"


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


def test_omitting_capabilities_applies_the_defaults():
    """OMITTED is not the same as []. A caller that never heard of capabilities
    (an old script, a curl) gets the defaults."""
    from reef.tests.test_fleet import _svc_with_manager

    svc, rt, store = _svc_with_manager()
    sandbox, _ = asyncio.run(svc.create("openclaw", name="oc-default"))
    assert rt.created[-1].env["REEF_CAPS"] == "gh,cron"
    assert sandbox.capabilities == ("gh", "cron")
    assert asyncio.run(store.get("oc-default")).capabilities == ("gh", "cron")


def test_explicit_empty_capabilities_grants_nothing():
    """The other half of that distinction — and the reason both wizards send the
    field even when empty. If [] fell through to the defaults, unticking the box
    would silently re-grant what the operator just turned off."""
    from reef.tests.test_fleet import _svc_with_manager

    svc, rt, _store = _svc_with_manager()
    sandbox, _ = asyncio.run(svc.create("openclaw", name="oc-none", capabilities=[]))
    # Explicit "" (not an absent key): the entrypoint must actively turn the
    # gated features off rather than inherit a previous boot's config.
    assert rt.created[-1].env["REEF_CAPS"] == ""
    assert sandbox.capabilities == ()


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
