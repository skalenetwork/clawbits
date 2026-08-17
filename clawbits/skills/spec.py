"""Validation, normalization and hashing for skill versions.

Every write path (create, publish, fork) goes through :func:`normalize_manifest`.
A skill is instructions the model follows, so the allowlist here is a security
boundary: ``metadata.openclaw.install`` (a download-and-execute step),
``requires.config`` (a probe of the agent's own config) and ``always`` (skips
every eligibility gate) are dropped and cannot be reintroduced downstream.
"""
from __future__ import annotations

import hashlib
import re
from typing import Any

from clawbits.automations.spec import canonical_json

_ALLOWED_MANIFEST_KEYS = frozenset(
    {
        "name",
        "description",
        "version",
        "homepage",
        "user_invocable",
        "disable_model_invocation",
        "runtimes",
        "requires",
        "env_declarations",
        "emoji",
    }
)
_ALLOWED_REQUIRES_KEYS = frozenset({"bins", "anyBins", "env", "os"})
_REQUIRED_MANIFEST_KEYS = ("name", "description")

# OpenClaw's rule: 1-64 lowercase/digits/hyphens, and it must equal the parent
# directory name. We reuse it as the slug rule so the two can never disagree.
SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")

# Skill identity is a flat name space per agent and four clawbits-* skills ship
# in every image, so an org skill of that name would shadow one.
RESERVED_SLUG_PREFIX = "clawbits-"

# description is injected into every prompt of every agent that installs it.
DESCRIPTION_MAX = 160
BODY_MAX = 65_536
FILE_MAX = 65_536
FILES_MAX = 9
TOTAL_BYTES_MAX = 262_144
ALLOWED_FILE_ROOT = "references"

_PATH_SEGMENT_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
# "." and ".." match _PATH_SEGMENT_RE, so they need an explicit reject.
_TRAVERSAL_SEGMENTS = frozenset({".", ".."})
_RESERVED_PATH_SEGMENT = ".clawbits"
_KNOWN_RUNTIMES = ("openclaw", "hermes", "ironclaw")


class SkillValidationError(ValueError):
    """Raised when a skill manifest or bundle is not storable."""


def _normalize_requires(requires: Any) -> dict[str, list[str]] | None:
    if not isinstance(requires, dict):
        return None
    out: dict[str, list[str]] = {}
    for key in sorted(_ALLOWED_REQUIRES_KEYS):
        value = requires.get(key)
        if not isinstance(value, list):
            continue
        items = [v.strip() for v in value if isinstance(v, str) and v.strip()]
        if items:
            out[key] = items
    return out or None


def _normalize_env_declarations(declarations: Any) -> list[dict[str, Any]] | None:
    """Keep env var names and prose only, never values."""
    if not isinstance(declarations, list):
        return None
    out: list[dict[str, Any]] = []
    for entry in declarations:
        if not isinstance(entry, dict):
            continue
        name = entry.get("name")
        if not isinstance(name, str) or not name.strip():
            continue
        item: dict[str, Any] = {"name": name.strip()}
        description = entry.get("description")
        if isinstance(description, str) and description.strip():
            item["description"] = description.strip()
        item["required"] = bool(entry.get("required", False))
        out.append(item)
    return out or None


def _normalize_runtimes(runtimes: Any) -> list[str]:
    if not isinstance(runtimes, list):
        return ["openclaw"]
    return [r for r in _KNOWN_RUNTIMES if r in runtimes] or ["openclaw"]


def normalize_manifest(manifest: dict[str, Any]) -> dict[str, Any]:
    """Reduce a manifest to the allowed keys. Unknown keys are dropped."""
    if not isinstance(manifest, dict):
        raise SkillValidationError("manifest must be an object")

    result: dict[str, Any] = {}

    name = manifest.get("name")
    if isinstance(name, str):
        result["name"] = name.strip().lower()

    description = manifest.get("description")
    if isinstance(description, str):
        # One frontmatter line: a stray newline would corrupt the YAML.
        result["description"] = " ".join(description.split())

    for key in ("version", "homepage", "emoji"):
        value = manifest.get(key)
        if isinstance(value, str) and value.strip():
            result[key] = value.strip()

    for key in ("user_invocable", "disable_model_invocation"):
        if key in manifest:
            result[key] = bool(manifest[key])

    result["runtimes"] = _normalize_runtimes(manifest.get("runtimes"))

    requires = _normalize_requires(manifest.get("requires"))
    if requires is not None:
        result["requires"] = requires

    env_declarations = _normalize_env_declarations(manifest.get("env_declarations"))
    if env_declarations is not None:
        result["env_declarations"] = env_declarations

    return {k: v for k, v in result.items() if k in _ALLOWED_MANIFEST_KEYS}


def validate_manifest(manifest: dict[str, Any], *, slug: str) -> None:
    """Assert the minimal storable shape. Runs before normalization."""
    if not isinstance(manifest, dict):
        raise SkillValidationError("manifest must be an object")

    missing = [k for k in _REQUIRED_MANIFEST_KEYS if not manifest.get(k)]
    if missing:
        raise SkillValidationError(
            "manifest missing required field(s): " + ", ".join(missing)
        )

    name = str(manifest.get("name", "")).strip().lower()
    if not SLUG_RE.match(name):
        raise SkillValidationError(
            "name must be 1-64 chars of lowercase letters, digits or hyphens"
        )
    if name != slug:
        raise SkillValidationError(
            f"manifest name '{name}' must match the skill slug '{slug}'"
        )

    description = str(manifest.get("description", "")).strip()
    if len(description) > DESCRIPTION_MAX:
        raise SkillValidationError(
            f"description must be {DESCRIPTION_MAX} characters or fewer "
            f"(got {len(description)})"
        )


def validate_slug(slug: str) -> None:
    if not isinstance(slug, str) or not SLUG_RE.match(slug):
        raise SkillValidationError(
            "slug must be 1-64 chars of lowercase letters, digits or hyphens"
        )
    if slug.startswith(RESERVED_SLUG_PREFIX):
        raise SkillValidationError(
            f"the '{RESERVED_SLUG_PREFIX}' prefix is reserved for built-in skills"
        )


def normalize_file_path(path: Any) -> str:
    """Validate one support-file path. Rejects traversal and absolute paths."""
    if not isinstance(path, str) or not path.strip():
        raise SkillValidationError("file path must be a non-empty string")
    candidate = path.strip()
    if candidate.startswith("/") or "\\" in candidate or "\0" in candidate:
        raise SkillValidationError(f"invalid file path: {path!r}")

    segments = candidate.split("/")
    if len(segments) < 2 or segments[0] != ALLOWED_FILE_ROOT:
        raise SkillValidationError(
            f"file path must live under '{ALLOWED_FILE_ROOT}/': {path!r}"
        )
    for segment in segments:
        if segment in _TRAVERSAL_SEGMENTS:
            raise SkillValidationError(f"path traversal is not allowed: {path!r}")
        if not _PATH_SEGMENT_RE.match(segment):
            raise SkillValidationError(f"invalid path segment {segment!r} in {path!r}")
        if segment == _RESERVED_PATH_SEGMENT:
            raise SkillValidationError(
                f"'{_RESERVED_PATH_SEGMENT}' is reserved for the install marker"
            )
    return candidate


def normalize_files(files: Any) -> list[dict[str, Any]]:
    """Validate paths, hash contents, cap size. Returns entries sorted by path."""
    if files is None:
        return []
    if not isinstance(files, list):
        raise SkillValidationError("files must be an array")
    if len(files) > FILES_MAX:
        raise SkillValidationError(
            f"a skill may carry at most {FILES_MAX} support files (got {len(files)})"
        )

    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for entry in files:
        if not isinstance(entry, dict):
            raise SkillValidationError("each file must be an object")
        path = normalize_file_path(entry.get("path"))
        if path in seen:
            raise SkillValidationError(f"duplicate file path: {path}")
        seen.add(path)

        content = entry.get("content")
        if not isinstance(content, str):
            raise SkillValidationError(f"file {path} must carry string content")
        encoded = content.encode("utf-8")
        if len(encoded) > FILE_MAX:
            raise SkillValidationError(
                f"file {path} is {len(encoded)} bytes (max {FILE_MAX})"
            )
        out.append(
            {
                "path": path,
                "content": content,
                "sha256": hashlib.sha256(encoded).hexdigest(),
                "size_bytes": len(encoded),
            }
        )

    out.sort(key=lambda f: f["path"])
    return out


def validate_bundle(body_md: str, files: list[dict[str, Any]]) -> None:
    if not isinstance(body_md, str):
        raise SkillValidationError("body must be a string")
    body_bytes = len(body_md.encode("utf-8"))
    if body_bytes > BODY_MAX:
        raise SkillValidationError(f"body is {body_bytes} bytes (max {BODY_MAX})")
    total = body_bytes + sum(f["size_bytes"] for f in files)
    if total > TOTAL_BYTES_MAX:
        raise SkillValidationError(
            f"skill bundle is {total} bytes (max {TOTAL_BYTES_MAX})"
        )


def content_hash(
    manifest: dict[str, Any], body_md: str, files: list[dict[str, Any]]
) -> str:
    """Stable hash of a normalized version.

    Files are sorted here rather than trusting the caller: a JSON array is
    order-significant, and this value gates whether the plugin rewrites a skill.
    """
    payload = {
        "manifest": manifest,
        "body_md": body_md,
        "files": sorted(
            ({"path": f["path"], "sha256": f["sha256"]} for f in files),
            key=lambda f: f["path"],
        ),
    }
    return hashlib.sha256(canonical_json(payload).encode("utf-8")).hexdigest()


def next_patch_version(current: str | None) -> str:
    if not current:
        return "1.0.0"
    parts = current.split(".")
    if len(parts) != 3 or not all(p.isdigit() for p in parts):
        return "1.0.0"
    major, minor, patch = (int(p) for p in parts)
    return f"{major}.{minor}.{patch + 1}"


__all__ = [
    "BODY_MAX",
    "DESCRIPTION_MAX",
    "FILES_MAX",
    "FILE_MAX",
    "RESERVED_SLUG_PREFIX",
    "SLUG_RE",
    "TOTAL_BYTES_MAX",
    "SkillValidationError",
    "content_hash",
    "next_patch_version",
    "normalize_file_path",
    "normalize_files",
    "normalize_manifest",
    "validate_bundle",
    "validate_manifest",
    "validate_slug",
]
