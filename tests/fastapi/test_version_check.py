"""Tests for the plugin version handshake.

Covers the ``GET /api/agentic/version-check`` endpoint plus the
``require_supported_plugin`` dependency wired onto signup + ``/info``.

The server's minimum is read from ``plugin/package.json`` (currently
``0.4.8`` — bumped manually in lockstep with plugin releases). These
tests pin the comparison logic, not a specific minimum, so the suite
keeps passing after future bumps.
"""
from __future__ import annotations

from packaging.version import Version
from starlette.testclient import TestClient

from clawbits.fastapi.version_check import min_plugin_version

PLUGIN_VERSION_HEADER = "X-Clawbits-Plugin-Version"


def _floor_str() -> str:
    return str(min_plugin_version())


def _below(floor: Version) -> str:
    """Return a parseable semver strictly below ``floor``."""
    # ``0.0.0`` is always <= any non-zero floor. Falls back to a synthetic
    # "less than" if the floor itself is 0.0.0 (fail-open default).
    return "0.0.0" if floor > Version("0.0.0") else "0.0.0-pre"


def _above(floor: Version) -> str:
    """A version strictly above ``floor`` — bump the major component."""
    return f"{floor.major + 1}.0.0"


def test_version_check_returns_200_for_missing_header(test_client: TestClient):
    """Plugins that pre-date the version-check protocol shouldn't be blocked."""
    resp = test_client.get("/api/agentic/version-check")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["supported"] is True
    assert body["plugin_version"] is None
    assert body["min_plugin_version"] == _floor_str()
    assert body["message"] is None


def test_version_check_supported_when_at_or_above_min(test_client: TestClient):
    floor = min_plugin_version()
    resp = test_client.get(
        "/api/agentic/version-check",
        headers={PLUGIN_VERSION_HEADER: str(floor)},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["supported"] is True
    assert body["plugin_version"] == str(floor)
    assert body["min_plugin_version"] == _floor_str()
    assert body["message"] is None

    # Above the floor also passes.
    resp = test_client.get(
        "/api/agentic/version-check",
        headers={PLUGIN_VERSION_HEADER: _above(floor)},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["supported"] is True


def test_version_check_unsupported_below_min(test_client: TestClient):
    floor = min_plugin_version()
    if floor <= Version("0.0.0"):
        # Fail-open default — there's nothing strictly below it that can
        # parse as a semver; the gate is disabled in this build and the
        # below-floor test is meaningless.
        return
    below = _below(floor)
    resp = test_client.get(
        "/api/agentic/version-check",
        headers={PLUGIN_VERSION_HEADER: below},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["supported"] is False
    assert body["plugin_version"] == below
    assert body["min_plugin_version"] == str(floor)
    assert body["message"] is not None and "update" in body["message"].lower()


def test_version_check_invalid_header_treated_as_missing(test_client: TestClient):
    resp = test_client.get(
        "/api/agentic/version-check",
        headers={PLUGIN_VERSION_HEADER: "not-a-version"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    # Unparseable header → treated as None → fall back to "supported".
    assert body["supported"] is True
    assert body["plugin_version"] is None


def test_require_supported_plugin_gates_signup(test_client: TestClient):
    """An outdated plugin hitting signup gets 426 with structured detail."""
    floor = min_plugin_version()
    if floor <= Version("0.0.0"):
        return  # gate disabled in this build
    resp = test_client.post(
        "/api/agentic/agents/signup",
        json={"org_id": "anything"},
        headers={PLUGIN_VERSION_HEADER: _below(floor)},
    )
    assert resp.status_code == 426, resp.text
    detail = resp.json()["detail"]
    assert detail["code"] == "plugin_outdated"
    assert detail["min_plugin_version"] == str(floor)
    assert "update" in detail["message"].lower()


def test_require_supported_plugin_allows_missing_header(test_client: TestClient):
    """Missing header keeps backwards-compat — request reaches the handler
    (and there fails for unrelated reasons, but NOT 426)."""
    resp = test_client.post(
        "/api/agentic/agents/signup",
        json={"org_id": "nonexistent-org"},
    )
    assert resp.status_code != 426, resp.text


# ── Per-plugin floors ────────────────────────────────────────────────────────
#
# Clawbits has several client plugins with entirely independent version lines
# (openclaw → plugin/package.json, hermes → extensions/hermes/plugin.yaml,
# ironclaw → ironclaw-channel/Cargo.toml). A single global floor taken from the
# OpenClaw plugin used to be applied to all of them, which made Hermes agents
# IMPOSSIBLE TO ENROL: hermes honestly reported 0.4.16, was measured against
# openclaw's 0.7.1, and every /api/agentic/signup-commit came back 426. The agent
# then had no api_key, its platform never configured ("No messaging platforms
# enabled"), it never phoned home, and the Add-agent wizard hung on "hatching".

PLUGIN_KIND_HEADER = "X-Clawbits-Plugin-Kind"


def test_each_floor_comes_from_its_own_plugin_manifest():
    """Each kind's floor is read from that plugin's own manifest in this tree, so
    bumping one plugin cannot raise the bar for an unrelated one."""
    import json
    import re
    import tomllib
    from pathlib import Path

    from clawbits.fastapi.version_check import min_plugin_version

    root = Path(__file__).resolve().parents[2]

    openclaw = json.loads((root / "plugin" / "package.json").read_text())["version"]
    assert str(min_plugin_version("openclaw")) == openclaw

    hermes_yaml = (root / "extensions" / "hermes" / "plugin.yaml").read_text()
    hermes = re.search(r"""^version:\s*['"]?([^'"\s#]+)""", hermes_yaml, re.M).group(1)
    assert str(min_plugin_version("hermes")) == hermes

    cargo = tomllib.loads((root / "ironclaw-channel" / "Cargo.toml").read_text())
    assert str(min_plugin_version("ironclaw")) == cargo["package"]["version"]


def test_hermes_plugin_at_its_own_version_is_supported(test_client: TestClient):
    """THE regression: the hermes plugin, reporting the version this tree actually
    ships, must pass the gate on the endpoint that enrols it. Before per-kind floors
    this was a 426 and Hermes could never be created."""
    from clawbits.fastapi.version_check import min_plugin_version

    shipped = str(min_plugin_version("hermes"))
    resp = test_client.post(
        "/api/agentic/agents/signup",
        json={"org_id": "nonexistent-org"},
        headers={PLUGIN_VERSION_HEADER: shipped, PLUGIN_KIND_HEADER: "hermes"},
    )
    # It may fail for unrelated reasons (no such org) — it must NOT be 426.
    assert resp.status_code != 426, resp.text


def test_hermes_version_would_still_fail_against_the_openclaw_floor(test_client: TestClient):
    """Pin the bug itself: the hermes version measured against openclaw's floor is
    rejected. This is what the missing kind header used to cause."""
    from clawbits.fastapi.version_check import is_plugin_supported, min_plugin_version

    hermes_v = min_plugin_version("hermes")
    openclaw_floor = min_plugin_version("openclaw")
    if hermes_v >= openclaw_floor:
        return  # the two lines happen to have converged; nothing to prove
    assert is_plugin_supported(hermes_v, "hermes") is True
    assert is_plugin_supported(hermes_v, "openclaw") is False


def test_unknown_or_missing_kind_falls_back_to_openclaw(test_client: TestClient):
    """Every plugin already in the wild predates the kind header, so the default must
    keep measuring them against exactly the floor they get today."""
    from clawbits.fastapi.version_check import min_plugin_version, normalize_plugin_kind

    assert normalize_plugin_kind(None) == "openclaw"
    assert normalize_plugin_kind("nonsense") == "openclaw"

    floor = min_plugin_version("openclaw")
    if floor <= Version("0.0.0"):
        return
    resp = test_client.post(
        "/api/agentic/agents/signup",
        json={"org_id": "anything"},
        headers={PLUGIN_VERSION_HEADER: _below(floor)},  # no kind header
    )
    assert resp.status_code == 426, resp.text
    assert resp.json()["detail"]["plugin_kind"] == "openclaw"


def test_426_hint_is_runtime_appropriate(test_client: TestClient):
    """A Hermes operator must not be told to run `openclaw plugins update clawbits`."""
    from clawbits.fastapi.version_check import min_plugin_version

    floor = min_plugin_version("hermes")
    if floor <= Version("0.0.0"):
        return
    resp = test_client.post(
        "/api/agentic/agents/signup",
        json={"org_id": "anything"},
        headers={PLUGIN_VERSION_HEADER: "0.0.0", PLUGIN_KIND_HEADER: "hermes"},
    )
    assert resp.status_code == 426, resp.text
    detail = resp.json()["detail"]
    assert detail["plugin_kind"] == "hermes"
    assert detail["min_plugin_version"] == str(floor)
    assert "openclaw plugins update" not in detail["message"]
    assert "extensions/hermes" in detail["message"]
