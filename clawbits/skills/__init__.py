"""Org-owned library of agent skills.

The catalog (``skills``, ``skill_versions``) is ordinary org-scoped CRUD an
agent report can never mutate. The sync plane (``agent_skill_installs``) carries
the desired-state machinery, reconciled by the agent's plugin over its outbound
lane. See ``docs/protocol/SKILLS_LIBRARY_PLAN.md``.
"""
from clawbits.skills.render import (
    DEFAULT_RUNTIME,
    SKILL_RUNTIMES,
    SkillRuntime,
    render_skill,
    resolve_runtime,
)
from clawbits.skills.spec import (
    SkillValidationError,
    content_hash,
    next_patch_version,
    normalize_files,
    normalize_manifest,
    validate_bundle,
    validate_manifest,
    validate_slug,
)

__all__ = [
    "DEFAULT_RUNTIME",
    "SKILL_RUNTIMES",
    "SkillRuntime",
    "SkillValidationError",
    "content_hash",
    "next_patch_version",
    "normalize_files",
    "normalize_manifest",
    "render_skill",
    "resolve_runtime",
    "validate_bundle",
    "validate_manifest",
    "validate_slug",
]
