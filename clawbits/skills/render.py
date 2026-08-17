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


def _frontmatter_lines(pairs: list[tuple[str, Any]]) -> list[str]:
    lines: list[str] = []
    for key, value in pairs:
        if value is None:
            continue
        if isinstance(value, str):
            lines.append(f"{key}: {json.dumps(value, ensure_ascii=False)}")
        elif isinstance(value, bool):
            lines.append(f"{key}: {'true' if value else 'false'}")
        else:
            lines.append(
                f"{key}: {json.dumps(value, ensure_ascii=False, sort_keys=True)}"
            )
    return lines


def _document(frontmatter: list[str], body_md: str) -> str:
    return "---\n" + "\n".join(frontmatter) + "\n---\n\n" + body_md.rstrip("\n") + "\n"


def render_openclaw(manifest: dict[str, Any], body_md: str) -> str:
    meta: dict[str, Any] = {}
    if emoji := manifest.get("emoji"):
        meta["emoji"] = emoji
    if homepage := manifest.get("homepage"):
        meta["homepage"] = homepage

    requires = manifest.get("requires") or {}
    oc_requires = {k: v for k, v in requires.items() if k in ("bins", "anyBins", "env")}
    if oc_requires:
        meta["requires"] = oc_requires
    if os_list := requires.get("os"):
        meta["os"] = os_list
    if declarations := manifest.get("env_declarations"):
        meta["envVars"] = [
            {
                "name": d["name"],
                "required": bool(d.get("required", False)),
                **({"description": d["description"]} if d.get("description") else {}),
            }
            for d in declarations
        ]

    pairs: list[tuple[str, Any]] = [
        ("name", manifest["name"]),
        ("description", manifest["description"]),
    ]
    if version := manifest.get("version"):
        pairs.append(("version", version))
    if "user_invocable" in manifest:
        pairs.append(("user-invocable", manifest["user_invocable"]))
    if "disable_model_invocation" in manifest:
        pairs.append(("disable-model-invocation", manifest["disable_model_invocation"]))
    if meta:
        pairs.append(("metadata", {"openclaw": meta}))

    return _document(_frontmatter_lines(pairs), body_md)


def render_hermes(manifest: dict[str, Any], body_md: str) -> str:
    """Provisional: the Hermes frontmatter set is documented but unverified."""
    requires = manifest.get("requires") or {}
    pairs: list[tuple[str, Any]] = [
        ("name", manifest["name"]),
        ("description", manifest["description"]),
    ]
    if version := manifest.get("version"):
        pairs.append(("version", version))
    if declarations := manifest.get("env_declarations"):
        pairs.append((
            "required_environment_variables",
            [d["name"] for d in declarations if d.get("required")],
        ))
    if os_list := requires.get("os"):
        pairs.append(("platforms", os_list))

    meta: dict[str, Any] = {}
    if emoji := manifest.get("emoji"):
        meta["emoji"] = emoji
    hermes_requires = {k: v for k, v in requires.items() if k in ("bins", "anyBins")}
    if hermes_requires:
        meta["requires"] = hermes_requires
    if meta:
        pairs.append(("metadata", {"hermes": meta}))

    return _document(_frontmatter_lines(pairs), body_md)


def render_ironclaw(manifest: dict[str, Any], body_md: str) -> str:
    """Preview only — IronClaw cannot receive skills (see SKILL_RUNTIMES)."""
    pairs: list[tuple[str, Any]] = [
        ("name", manifest["name"]),
        ("description", manifest["description"]),
    ]
    if version := manifest.get("version"):
        pairs.append(("version", version))
    pairs.append(
        ("activation", {"keywords": [manifest["name"]], "auto_activate": True})
    )
    return _document(_frontmatter_lines(pairs), body_md)


@dataclass(frozen=True, slots=True)
class SkillRuntime:
    name: str
    # Is there a shipping client that can receive a skill? Gates install only;
    # list and uninstall stay open so pre-existing rows remain removable.
    can_receive: bool
    apply_mode: str
    skills_dir: str | None
    render: Callable[[dict[str, Any], str], str]


SKILL_RUNTIMES: dict[str, SkillRuntime] = {
    # <workspace>/skills is both OpenClaw's highest-precedence root and the only
    # reef path on the persistent volume. Never ~/.openclaw/skills.
    "openclaw": SkillRuntime("openclaw", True, "watch", "<workspace>/skills", render_openclaw),
    # Inferred from HERMES_HOME; never inside plugins/, which is wiped each boot.
    "hermes": SkillRuntime("hermes", False, "ondemand", "/opt/data/skills", render_hermes),
    # WASM channel, sandboxed away from the filesystem.
    "ironclaw": SkillRuntime("ironclaw", False, "restart", None, render_ironclaw),
}

# agent_type is NULL until the first modern alive ping; every existing gate
# treats NULL as openclaw. A UX guard, never a security boundary.
DEFAULT_RUNTIME = "openclaw"


def resolve_runtime(agent_type: str | None) -> SkillRuntime:
    return SKILL_RUNTIMES.get(
        agent_type or DEFAULT_RUNTIME, SKILL_RUNTIMES[DEFAULT_RUNTIME]
    )


def render_skill(manifest: dict[str, Any], body_md: str, *, runtime: str) -> str:
    entry = SKILL_RUNTIMES.get(runtime)
    if entry is None:
        raise ValueError(f"unknown runtime: {runtime}")
    return entry.render(manifest, body_md)


__all__ = [
    "DEFAULT_RUNTIME",
    "SKILL_RUNTIMES",
    "SkillRuntime",
    "render_hermes",
    "render_ironclaw",
    "render_openclaw",
    "render_skill",
    "resolve_runtime",
]
