"""Plugin version-check surface.

"What plugin version does this server expect." Each floor is read from the
manifest of the plugin that ships **in this tree**, so every server build is
implicitly pinned to the plugins that shipped with it. We accept any plugin at or
above its floor; older ones get a structured 426 from the
``require_supported_plugin`` dependency on endpoints whose wire contract changed.

**Floors are per plugin kind, and this is load-bearing.** Clawbits has more than
one client plugin and they have entirely independent version lines:

    openclaw  → plugin/package.json                (e.g. 0.7.1)
    hermes    → extensions/hermes/plugin.yaml      (e.g. 0.5.0)
    ironclaw  → ironclaw-channel/Cargo.toml        (e.g. 0.1.0)

A single global floor taken from the OpenClaw plugin used to be compared against
*every* caller. That made Hermes enrollment impossible: it honestly reported 0.4.16,
was measured against OpenClaw's 0.7.1, and every ``/api/agentic/signup-commit`` came
back 426 ``plugin_outdated`` — so the agent never got an api_key, its platform never
configured ("No messaging platforms enabled"), and it never phoned home. Worse, the
numbers are unrelated, so bumping the OpenClaw plugin silently raised the bar for a
plugin that had nothing to do with it, and the remedy it printed
("run `openclaw plugins update clawbits`") was nonsense for a Hermes agent.

Callers declare themselves with ``X-Clawbits-Plugin-Kind``. A missing/unknown kind
falls back to ``openclaw`` — that is exactly the behaviour every plugin in the wild
already gets, so nothing that works today starts failing.

The endpoint itself (``GET /api/agentic/version-check``) is **not** gated
— an outdated plugin must be able to call it to discover that it is
outdated. The hard gate is reserved for routes that genuinely break with
older clients.
"""

from __future__ import annotations

import json
import logging
import re
import tomllib
from functools import cache
from pathlib import Path

from fastapi import Header, HTTPException
from packaging.version import InvalidVersion, Version

from clawbits.datastructures.version_check_response import VersionCheckResponse

# ``Path(__file__).resolve()`` →
#   parents[0] = clawbits/fastapi
#   parents[1] = clawbits
#   parents[2] = repo root (or ``/app`` in the production container — the
#                 Dockerfile copies each manifest below there; a floor whose
#                 manifest is absent fails OPEN, so forgetting the COPY silently
#                 disables that plugin's gate rather than 426-ing everyone).
_REPO_ROOT = Path(__file__).resolve().parents[2]
_PLUGIN_PACKAGE_JSON = _REPO_ROOT / "plugin" / "package.json"
_HERMES_PLUGIN_YAML = _REPO_ROOT / "extensions" / "hermes" / "plugin.yaml"
_IRONCLAW_CHANNEL_CARGO = _REPO_ROOT / "ironclaw-channel" / "Cargo.toml"

# The plugin kinds a caller may declare via ``X-Clawbits-Plugin-Kind``.
PLUGIN_KIND_OPENCLAW = "openclaw"
PLUGIN_KIND_HERMES = "hermes"
PLUGIN_KIND_IRONCLAW = "ironclaw"

# Missing/unknown kind ⇒ openclaw. Every plugin already in the wild predates the
# kind header, and openclaw's floor is what they are measured against today —
# so this default is precisely "no behaviour change for anyone shipping now".
DEFAULT_PLUGIN_KIND = PLUGIN_KIND_OPENCLAW

# How each kind names its clawbits component, for the "how do I fix this" hint in
# the 426. Telling a Hermes operator to run `openclaw plugins update` is noise.
_UPDATE_HINT = {
    PLUGIN_KIND_OPENCLAW: "Run `openclaw plugins update clawbits`.",
    PLUGIN_KIND_HERMES: (
        "Update the bundled Clawbits Hermes plugin (extensions/hermes) and rebuild "
        "the agent's image."
    ),
    PLUGIN_KIND_IRONCLAW: "Reinstall the Clawbits IronClaw channel (ironclaw-channel).",
}

# Same anchoring: the repo root in dev, ``/app`` in the production container
# (the Dockerfile copies ``pyproject.toml`` there). ``[project].version`` here
# is the canonical product version that ``scripts/bump_version.py`` keeps in
# lock-step across backend / frontend / desktop.
_PYPROJECT_TOML = Path(__file__).resolve().parents[2] / "pyproject.toml"

# Fail-open default. If ``plugin/package.json`` is missing or unreadable
# (broken build, dev shell with no plugin tree, …) the gate is effectively
# disabled rather than the server refusing every request. A startup smoke
# test asserts that the resolved version is non-zero so a misconfigured
# image is caught in CI.
_FAIL_OPEN_VERSION = Version("0.0.0")


def _version_from_package_json(path: Path) -> str:
    with path.open() as f:
        raw = json.load(f).get("version")
    if not isinstance(raw, str):
        raise ValueError("version field missing or not a string")
    return raw


def _version_from_plugin_yaml(path: Path) -> str:
    """The ``version:`` key of a hermes plugin manifest.

    Parsed with a regex rather than a YAML dependency: the manifest is flat, and
    this is the same single line the agent's own entrypoint reads with awk to stamp
    CLAWBITS_PLUGIN_VERSION — so server floor and reported version come from one key.
    """
    for line in path.read_text(encoding="utf-8").splitlines():
        m = re.match(r"""^version:\s*['"]?([^'"\s#]+)""", line)
        if m:
            return m.group(1)
    raise ValueError("no top-level `version:` key")


def _version_from_cargo_toml(path: Path) -> str:
    with path.open("rb") as f:
        raw = tomllib.load(f).get("package", {}).get("version")
    if not isinstance(raw, str):
        raise ValueError("[package].version missing or not a string")
    return raw


# kind -> (manifest path, reader). The manifest that ships in THIS tree is the floor
# for that plugin, mirroring how the server has always pinned itself to the plugin it
# was built with — just once per plugin instead of once globally.
_FLOOR_SOURCES: dict[str, tuple[Path, object]] = {
    PLUGIN_KIND_OPENCLAW: (_PLUGIN_PACKAGE_JSON, _version_from_package_json),
    PLUGIN_KIND_HERMES: (_HERMES_PLUGIN_YAML, _version_from_plugin_yaml),
    PLUGIN_KIND_IRONCLAW: (_IRONCLAW_CHANNEL_CARGO, _version_from_cargo_toml),
}


def normalize_plugin_kind(kind: str | None) -> str:
    """Map a caller-declared kind onto a known one; unknown/missing ⇒ openclaw."""
    if not kind:
        return DEFAULT_PLUGIN_KIND
    candidate = kind.strip().lower()
    return candidate if candidate in _FLOOR_SOURCES else DEFAULT_PLUGIN_KIND


@cache
def min_plugin_version(kind: str = DEFAULT_PLUGIN_KIND) -> Version:
    """The server's minimum supported version for ONE plugin kind.

    Cached per kind. Each floor comes from that plugin's own manifest in this tree,
    so bumping a manifest is the only way to tighten its floor — and bumping one
    plugin can no longer raise the bar for an unrelated one.
    """
    kind = normalize_plugin_kind(kind)
    path, read = _FLOOR_SOURCES[kind]
    try:
        return Version(read(path))  # type: ignore[operator]
    except (OSError, KeyError, ValueError, InvalidVersion, tomllib.TOMLDecodeError) as exc:
        logging.warning(
            "version_check: could not read %s plugin version from %s — gate disabled (%s)",
            kind,
            path,
            exc,
        )
        return _FAIL_OPEN_VERSION


@cache
def server_version() -> str:
    """The server's product version, read from ``pyproject.toml``.

    This is the value the web client compares against the version baked into
    its bundle at build time: on every SSE (re)connect the server announces
    this version, and a client running an older bundle (a tab held open
    across a deploy) prompts the user to reload. The project isn't
    pip-installed in the container (``uv sync --no-install-project``), so
    ``importlib.metadata`` can't see it — we read the source of truth
    directly. Cached once per process; falls back to ``"0.0.0"`` if the file
    is missing/unreadable, in which case the worst case is the client simply
    never prompts (a stale ``"0.0.0"`` won't match any real bundle, but it
    also won't crash the stream).
    """
    try:
        with _PYPROJECT_TOML.open("rb") as f:
            raw = tomllib.load(f).get("project", {}).get("version")
        if not isinstance(raw, str):
            raise ValueError("project.version missing or not a string")
        return raw
    except (OSError, KeyError, ValueError) as exc:
        logging.warning(
            "version_check: could not read server version from %s (%s)",
            _PYPROJECT_TOML,
            exc,
        )
        return "0.0.0"


def _parse_header(value: str | None) -> Version | None:
    if not value:
        return None
    try:
        return Version(value.strip())
    except InvalidVersion:
        return None


def parse_plugin_version(
    x_clawbits_plugin_version: str | None = Header(default=None),
):
    """FastAPI dependency: parse the ``X-Clawbits-Plugin-Version`` header.

    Returns a :class:`packaging.version.Version` when the header carries
    a parseable semver, or ``None`` when the header is missing /
    unparseable. The return type is left unannotated so FastAPI's schema
    generator (which doesn't know how to describe a ``Version`` object)
    stays out of it; this dependency is only consumed by other Python
    code, never exposed in the OpenAPI surface.
    """
    return _parse_header(x_clawbits_plugin_version)


def parse_plugin_kind(
    x_clawbits_plugin_kind: str | None = Header(default=None),
) -> str:
    """FastAPI dependency: which plugin is calling (``X-Clawbits-Plugin-Kind``).

    Missing/unknown ⇒ ``openclaw``, so plugins that predate the header keep being
    measured against exactly the floor they are measured against today.
    """
    return normalize_plugin_kind(x_clawbits_plugin_kind)


def is_plugin_supported(
    plugin_version: Version | None, kind: str = DEFAULT_PLUGIN_KIND
) -> bool:
    """A plugin is supported when it reports a version at or above the floor FOR ITS
    OWN KIND. Missing/unparseable versions are accepted to stay backwards-compatible
    with plugins that pre-date this protocol.
    """
    if plugin_version is None:
        return True
    return plugin_version >= min_plugin_version(normalize_plugin_kind(kind))


def build_version_check_response(
    plugin_version,
    operator_id: int | None = None,
    operator_display_name: str | None = None,
    kind: str = DEFAULT_PLUGIN_KIND,
) -> VersionCheckResponse:
    kind = normalize_plugin_kind(kind)
    floor = min_plugin_version(kind)
    supported = is_plugin_supported(plugin_version, kind)
    message: str | None = None
    if not supported:
        hint = _UPDATE_HINT[kind]
        greeting = f"Hi {operator_display_name} — your" if operator_display_name else "Your"
        message = (
            f"{greeting} Clawbits {kind} plugin ({plugin_version}) is below the "
            f"server's minimum supported version {floor}. {hint}"
        )
    return VersionCheckResponse(
        supported=supported,
        plugin_version=str(plugin_version) if plugin_version is not None else None,
        min_plugin_version=str(floor),
        message=message,
        operator_id=operator_id,
        operator_display_name=operator_display_name,
    )


def require_supported_plugin(
    x_clawbits_plugin_version: str | None = Header(default=None),
    x_clawbits_plugin_kind: str | None = Header(default=None),
) -> None:
    """Hard-gate dependency: 426 when the plugin is below the floor for its kind.

    Attach to endpoints whose wire contract has changed in a way that
    older plugins can't handle — calling them with an old plugin would
    otherwise surface as a confusing 404 / schema mismatch instead of an
    actionable "please update" message.

    The kind matters: this gate sits on ``/api/agentic/signup-commit``, so getting the
    floor wrong doesn't degrade an agent, it makes the agent *impossible to enrol* —
    which is exactly what happened to Hermes when every caller was measured against
    the OpenClaw plugin's version.
    """
    parsed = _parse_header(x_clawbits_plugin_version)
    kind = normalize_plugin_kind(x_clawbits_plugin_kind)
    if is_plugin_supported(parsed, kind):
        return
    floor = min_plugin_version(kind)
    raise HTTPException(
        status_code=426,
        detail={
            "code": "plugin_outdated",
            "plugin_kind": kind,
            "min_plugin_version": str(floor),
            "plugin_version": str(parsed) if parsed is not None else None,
            "message": (
                f"This endpoint requires the {kind} plugin >= {floor}. {_UPDATE_HINT[kind]}"
            ),
        },
    )
