"""Per-runtime SKILL.md rendering.

One canonical manifest is stored; the runtime-specific frontmatter is derived
here. The three runtimes gate on different fields, so storing raw SKILL.md text
and shipping it everywhere would silently lose gating on two of three. Keeping
emission here also keeps the sync wire protocol dialect-blind.
"""
from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any


def _compact(values: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in values.items() if v}


def _document(pairs: list[tuple[str, Any]], body_md: str) -> str:
    """Frontmatter of the non-``None`` pairs, each value as JSON (which YAML
    reads as is), then the body."""
    frontmatter = "\n".join(
        f"{key}: {json.dumps(value, ensure_ascii=False, sort_keys=True)}"
        for key, value in pairs
        if value is not None
    )
    return "---\n" + frontmatter + "\n---\n\n" + body_md.rstrip("\n") + "\n"


def render_openclaw(manifest: dict[str, Any], body_md: str) -> str:
    requires = manifest.get("requires") or {}
    meta = _compact({
        "emoji": manifest.get("emoji"),
        "homepage": manifest.get("homepage"),
        "requires": _compact({k: requires.get(k) for k in ("bins", "anyBins", "env")}),
        "os": requires.get("os"),
        "envVars": [
            {
                "name": d["name"],
                "required": bool(d.get("required", False)),
                **({"description": d["description"]} if d.get("description") else {}),
            }
            for d in manifest.get("env_declarations") or []
        ],
    })
    return _document(
        [
            ("name", manifest["name"]),
            ("description", manifest["description"]),
            ("version", manifest.get("version")),
            ("user-invocable", manifest.get("user_invocable")),
            ("disable-model-invocation", manifest.get("disable_model_invocation")),
            ("metadata", {"openclaw": meta} if meta else None),
        ],
        body_md,
    )


def render_hermes(manifest: dict[str, Any], body_md: str) -> str:
    """Provisional: the Hermes frontmatter set is documented but unverified."""
    requires = manifest.get("requires") or {}
    declarations = manifest.get("env_declarations")
    meta = _compact({
        "emoji": manifest.get("emoji"),
        "requires": _compact({k: requires.get(k) for k in ("bins", "anyBins")}),
    })
    return _document(
        [
            ("name", manifest["name"]),
            ("description", manifest["description"]),
            ("version", manifest.get("version")),
            (
                "required_environment_variables",
                [d["name"] for d in declarations if d.get("required")] if declarations else None,
            ),
            ("platforms", requires.get("os") or None),
            ("metadata", {"hermes": meta} if meta else None),
        ],
        body_md,
    )


def render_ironclaw(manifest: dict[str, Any], body_md: str) -> str:
    """Preview only: IronClaw cannot receive skills (see SKILL_RUNTIMES)."""
    return _document(
        [
            ("name", manifest["name"]),
            ("description", manifest["description"]),
            ("version", manifest.get("version")),
            ("activation", {"keywords": [manifest["name"]], "auto_activate": True}),
        ],
        body_md,
    )


@dataclass(frozen=True, slots=True)
class SkillRuntime:
    name: str
    # Is there a shipping client that can receive a skill? Gates install only;
    # list and uninstall stay open so pre-existing rows remain removable.
    can_receive: bool
    render: Callable[[dict[str, Any], str], str]


SKILL_RUNTIMES: dict[str, SkillRuntime] = {
    "openclaw": SkillRuntime("openclaw", True, render_openclaw),
    "hermes": SkillRuntime("hermes", False, render_hermes),
    # WASM channel, sandboxed away from the filesystem.
    "ironclaw": SkillRuntime("ironclaw", False, render_ironclaw),
}

# agent_type is NULL until the first modern alive ping; every existing gate
# treats NULL as openclaw. A UX guard, never a security boundary.
DEFAULT_RUNTIME = "openclaw"


def resolve_runtime(agent_type: str | None) -> SkillRuntime:
    return SKILL_RUNTIMES.get(agent_type or DEFAULT_RUNTIME, SKILL_RUNTIMES[DEFAULT_RUNTIME])


__all__ = ["SKILL_RUNTIMES", "SkillRuntime", "resolve_runtime"]
