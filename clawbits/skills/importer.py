"""Turn an uploaded, linked or agent-reported skill into an unsaved draft.

Every source ends in the same draft the editor opens; nothing here is stored,
and the create endpoint validates the result again. Skills are text only, so
``scripts/`` and ``assets/`` are dropped with a note rather than refused.
Nothing is ever extracted to disk: archive members are read in memory, each
read bounded no matter what the archive's own headers claim.
"""
from __future__ import annotations

import asyncio
import io
import json
import re
import stat
import zipfile
import zlib
from collections.abc import Callable, Iterable
from typing import Any
from urllib.parse import quote, unquote, urlsplit

import httpx

from clawbits.skills.spec import (
    ALLOWED_FILE_ROOT,
    FILE_MAX,
    FILES_MAX,
    TOTAL_BYTES_MAX,
    SkillValidationError,
    normalize_file_path,
    normalize_files,
    normalize_manifest,
    validate_bundle,
)
from clawbits.ssrf import UnsafeHostError, make_guarded_async_client

# A zip, or the files of one folder, as uploaded.
UPLOAD_MAX = 4 * 1024 * 1024
UNPACKED_MAX = 8 * 1024 * 1024
ENTRIES_MAX = 500
# Past every cap that applies to one file, so a longer read is never needed.
_READ_MAX = TOTAL_BYTES_MAX + 1
# Unauthenticated GitHub allows 60 API calls an hour per server address; file
# bodies come from raw.githubusercontent.com, which is not counted.
_LISTINGS_MAX = 5
_GITHUB_API = "https://api.github.com"
_GITHUB_RAW = "https://raw.githubusercontent.com"
_GITHUB_NAME = re.compile(r"^[A-Za-z0-9_.-]{1,100}$")
_BAD_LINK = "Paste a public GitHub link to a skill folder or its SKILL.md"
_TOO_LARGE = "That skill folder is too large to import"

_SKILL_FILES = ("SKILL.md", "skill.md")
_DROP_REASONS = {
    "scripts": "Scripts aren't imported; skills are text only",
    "assets": "Assets aren't imported; skills are text only",
}
_OTHER_REASON = "Only SKILL.md and references/ are imported"
_ZIP_ERRORS = (zipfile.BadZipFile, zlib.error, EOFError, NotImplementedError, RuntimeError)
_KEY_RE = re.compile(r"^([A-Za-z][\w-]*):(.*)$")


class SkillImportError(ValueError):
    """The input cannot become a draft. The message is shown to the user."""


def _value(raw: str) -> Any:
    raw = raw.strip()
    # A YAML block scalar: the text is on the indented lines after the marker.
    if raw[:1] in (">", "|"):
        return " ".join(raw.partition("\n")[2].split())
    try:
        value = json.loads(raw)
    except ValueError:
        value = None
    if isinstance(value, str | bool | dict | list):
        return value
    if len(raw) > 1 and raw[0] == raw[-1] == "'":
        return raw[1:-1].replace("''", "'")
    return " ".join(raw.split())


def _parse_skill_md(text: str) -> tuple[dict[str, Any], str]:
    """``(frontmatter, body)``. Top-level keys only, each a scalar or a JSON
    value that may continue on indented lines: OpenClaw's own dialect, where
    ``metadata`` is one JSON object. Without frontmatter the whole text is the
    body."""
    text = text.removeprefix("﻿").replace("\r\n", "\n")
    lines = text.split("\n")
    if lines[0].strip() != "---":
        return {}, text
    raw: dict[str, str] = {}
    key: str | None = None
    for index, line in enumerate(lines[1:], start=1):
        if line.strip() == "---":
            body = "\n".join(lines[index + 1 :]).lstrip("\n")
            return {k: _value(v) for k, v in raw.items()}, body
        if key is not None and line[:1] in (" ", "\t"):
            raw[key] += "\n" + line
        elif match := _KEY_RE.match(line):
            key = match[1]
            raw[key] = match[2]
    return {}, text


def _manifest(front: dict[str, Any]) -> dict[str, Any]:
    """The canonical manifest behind OpenClaw frontmatter: ``render_openclaw``
    in reverse, then the same normalization every write path runs."""
    meta = front.get("metadata")
    openclaw = meta.get("openclaw") if isinstance(meta, dict) else None
    if not isinstance(openclaw, dict):
        openclaw = {}
    requires = openclaw.get("requires")
    manifest = {
        "name": front.get("name"),
        "description": front.get("description"),
        "version": front.get("version"),
        "homepage": front.get("homepage") or openclaw.get("homepage"),
        "emoji": openclaw.get("emoji"),
        "user_invocable": front.get("user-invocable"),
        "disable_model_invocation": front.get("disable-model-invocation"),
        "requires": {**(requires if isinstance(requires, dict) else {}), "os": openclaw.get("os")},
        "env_declarations": openclaw.get("envVars"),
    }
    return normalize_manifest({k: v for k, v in manifest.items() if v is not None})


def _slug(*candidates: object) -> str:
    for candidate in candidates:
        if isinstance(candidate, str):
            slug = re.sub(r"[^a-z0-9]+", "-", candidate.lower()).strip("-")[:64].rstrip("-")
            if slug:
                return slug
    return "imported-skill"


def _text(data: bytes) -> str | None:
    """``data`` as UTF-8 text Postgres can store. UTF-16 decodes as UTF-8 full
    of NULs, which it refuses."""
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        return None
    return None if "\0" in text else text


def _drop_reason(path: str, data: bytes) -> str | None:
    if len(data) > FILE_MAX:
        return f"Larger than {FILE_MAX // 1024} KiB"
    try:
        normalize_file_path(path)
    except SkillValidationError as exc:
        return str(exc)
    return None if _text(data) is not None else "Not a text file"


def draft_from_skill_md(
    skill_md: bytes,
    references: dict[str, bytes],
    dropped: list[dict[str, str]],
    *,
    folder: str,
    source: dict[str, str],
) -> dict[str, Any]:
    """The draft for one SKILL.md and its reference files, less the ones that
    can't be stored. The slug comes from the frontmatter ``name``, else the
    folder, and ``name`` follows it."""
    text = _text(skill_md)
    if text is None:
        raise SkillImportError("SKILL.md isn't UTF-8 text")
    files: list[dict[str, str]] = []
    for path, data in sorted(references.items()):
        if reason := _drop_reason(path, data):
            dropped.append({"path": path, "reason": reason})
        else:
            files.append({"path": path, "content": data.decode("utf-8")})
    front, body = _parse_skill_md(text)
    manifest = _manifest(front)
    slug = manifest["name"] = _slug(manifest.get("name"), folder)
    try:
        validate_bundle(body, normalize_files(files))
    except SkillValidationError as exc:
        raise SkillImportError(str(exc)) from exc
    return {
        "display_name": slug.replace("-", " ").capitalize(),
        "slug": slug,
        "manifest": manifest,
        "body_md": body,
        "files": files,
        "dropped": dropped,
        "source": source,
    }


def _plan(paths: Iterable[str]) -> tuple[str, list[str], list[dict[str, str]]]:
    """Find the one skill folder among ``paths`` (a trailing ``/`` marks a
    folder that was not listed). Returns its prefix, its SKILL.md then its
    reference files relative to it, and what is dropped with a reason. Hidden
    entries (``.git``, OpenClaw's and our own markers) and macOS archive
    litter are skipped without a note."""
    visible = [
        p for p in paths if not any(s.startswith(".") or s == "__MACOSX" for s in p.split("/"))
    ]
    markers = [p for p in visible if p.rsplit("/", 1)[-1] in _SKILL_FILES]
    if not markers:
        raise SkillImportError("No SKILL.md found")
    depth = min(p.count("/") for p in markers)
    top = sorted(p for p in markers if p.count("/") == depth)
    if len({p.rpartition("/")[0] for p in top}) > 1:
        raise SkillImportError("Found more than one skill; import one at a time")
    prefix, _, marker = top[0].rpartition("/")
    prefix = f"{prefix}/" if prefix else ""

    files = [marker]
    dropped: list[dict[str, str]] = []
    for path in visible:
        if not path.startswith(prefix) or path == top[0]:
            continue
        rel = path[len(prefix) :]
        head = rel.split("/", 1)[0]
        if head == ALLOWED_FILE_ROOT and not rel.endswith("/"):
            files.append(rel)
        else:
            dropped.append({"path": rel, "reason": _DROP_REASONS.get(head, _OTHER_REASON)})
    if (count := len(files) - 1) > FILES_MAX:
        raise SkillImportError(
            f"A skill may carry at most {FILES_MAX} reference files (found {count})"
        )
    return prefix, files, dropped


def _folder(prefix: str) -> str:
    return prefix.rstrip("/").rpartition("/")[2]


def _draft_from_tree(paths: Iterable[str], read: Callable[[str], bytes]) -> dict[str, Any]:
    prefix, files, dropped = _plan(paths)
    skill_md, *bodies = (read(prefix + path) for path in files)
    return draft_from_skill_md(
        skill_md,
        dict(zip(files[1:], bodies, strict=True)),
        dropped,
        folder=_folder(prefix),
        source={"kind": "upload"},
    )


def _checked_path(name: str) -> str:
    if not name or name.startswith("/") or "\\" in name or "\0" in name or ".." in name.split("/"):
        raise SkillImportError(f"Unsafe path in the upload: {name!r}")
    return name


def _draft_from_zip(data: bytes) -> dict[str, Any]:
    """Refuses traversal, symlinks and an archive whose headers claim more
    than :data:`UNPACKED_MAX`, all before reading a single member."""
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            members = {info.filename: info for info in archive.infolist() if not info.is_dir()}
            if len(members) > ENTRIES_MAX:
                raise SkillImportError(f"The archive holds more than {ENTRIES_MAX} files")
            if sum(info.file_size for info in members.values()) > UNPACKED_MAX:
                raise SkillImportError(
                    f"The archive unpacks to more than {UNPACKED_MAX // 2**20} MiB"
                )
            for name, info in members.items():
                _checked_path(name)
                if stat.S_ISLNK(info.external_attr >> 16):
                    raise SkillImportError(f"Symlinks aren't allowed: {name}")

            def read(path: str) -> bytes:
                with archive.open(members[path]) as member:
                    return member.read(_READ_MAX)

            return _draft_from_tree(members, read)
    except _ZIP_ERRORS as exc:
        raise SkillImportError("That file isn't a readable zip archive") from exc


def draft_from_upload(files: list[tuple[str, bytes]]) -> dict[str, Any]:
    """One ``.zip``, or the files of one skill folder, each named by its
    relative path."""
    if len(files) == 1 and files[0][0].lower().endswith(".zip"):
        return _draft_from_zip(files[0][1])
    tree = {_checked_path(name): data for name, data in files}
    return _draft_from_tree(tree, tree.__getitem__)


def _github_target(url: str) -> tuple[str, str, str | None, str]:
    """``(owner, repo, ref, folder)`` from a github.com repo, tree or blob link,
    or a raw.githubusercontent.com link. File links must name the SKILL.md."""
    parts = urlsplit(url.strip())
    host = (parts.hostname or "").lower()
    segments = [unquote(s) for s in parts.path.split("/") if s]
    if parts.scheme not in ("http", "https") or len(segments) < 2:
        raise SkillImportError(_BAD_LINK)
    owner, repo, rest = segments[0], segments[1].removesuffix(".git"), segments[2:]
    if host in ("github.com", "www.github.com"):
        if rest and (rest[0] not in ("tree", "blob") or len(rest) < 2):
            raise SkillImportError(_BAD_LINK)
        ref, path, is_file = (rest[1], rest[2:], rest[0] == "blob") if rest else (None, [], False)
    elif host == "raw.githubusercontent.com" and len(rest) >= 2:
        if rest[0] == "refs" and len(rest) >= 4 and rest[1] in ("heads", "tags"):
            rest = rest[2:]
        ref, path, is_file = rest[0], rest[1:], True
    else:
        raise SkillImportError(_BAD_LINK)
    if is_file:
        if not path or path[-1] not in _SKILL_FILES:
            raise SkillImportError(_BAD_LINK)
        path = path[:-1]
    if not (_GITHUB_NAME.match(owner) and _GITHUB_NAME.match(repo)):
        raise SkillImportError(_BAD_LINK)
    return owner, repo, ref, "/".join(path)


async def _get(client: httpx.AsyncClient, url: str) -> bytes:
    """A GitHub response body, cut at :data:`_READ_MAX`."""
    try:
        async with client.stream("GET", url) as response:
            if response.status_code == 404:
                raise SkillImportError("Nothing public at that link")
            if response.status_code in (403, 429):
                raise SkillImportError(
                    "GitHub is limiting imports right now; try again later or upload the folder"
                )
            if response.status_code != 200:
                raise SkillImportError(f"GitHub answered {response.status_code}")
            body = bytearray()
            async for chunk in response.aiter_bytes():
                body += chunk
                if len(body) >= _READ_MAX:
                    break
            return bytes(body[:_READ_MAX])
    except (httpx.HTTPError, UnsafeHostError) as exc:
        raise SkillImportError("Couldn't reach GitHub") from exc


async def draft_from_github(url: str) -> dict[str, Any]:
    """A public skill folder, listed through the unauthenticated contents API
    (``references/`` recursively, nothing else) with file bodies from raw.
    Every request goes through the SSRF-pinned client, which never follows a
    redirect."""
    owner, repo, ref, folder = _github_target(url)
    query = f"?ref={quote(ref, safe='')}" if ref else ""
    listings = 0

    def repo_path(rel: str) -> str:
        return quote("/".join(p for p in (folder, rel) if p))

    async with make_guarded_async_client(
        timeout=10.0, headers={"User-Agent": "clawbits-skill-import"}
    ) as client:

        async def walk(rel: str) -> list[str]:
            nonlocal listings
            listings += 1
            if listings > _LISTINGS_MAX:
                raise SkillImportError(_TOO_LARGE)
            contents = f"{_GITHUB_API}/repos/{owner}/{repo}/contents/{repo_path(rel)}{query}"
            body = await _get(client, contents)
            try:
                entries = json.loads(body)
            except ValueError as exc:
                raise SkillImportError(_TOO_LARGE) from exc
            if not isinstance(entries, list):
                raise SkillImportError(_BAD_LINK)
            paths: list[str] = []
            for entry in entries:
                path = f"{rel}/{entry['name']}" if rel else entry["name"]
                if entry["type"] == "file":
                    paths.append(path)
                elif entry["type"] == "dir" and path.split("/", 1)[0] == ALLOWED_FILE_ROOT:
                    paths += await walk(path)
                else:
                    paths.append(f"{path}/")
            return paths

        prefix, files, dropped = _plan(await walk(""))
        raw = f"{_GITHUB_RAW}/{owner}/{repo}/{quote(ref or 'HEAD', safe='')}"
        skill_md, *bodies = await asyncio.gather(
            *(_get(client, f"{raw}/{repo_path(prefix + path)}") for path in files)
        )
    return draft_from_skill_md(
        skill_md,
        dict(zip(files[1:], bodies, strict=True)),
        dropped,
        folder=_folder(prefix) or folder.rpartition("/")[2] or repo,
        source={"kind": "url", "url": url},
    )
