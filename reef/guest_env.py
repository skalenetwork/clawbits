"""The reef-managed guest env file: one ``<op> <KEY> <base64(value)>`` record per
line, written host-side by reef and parsed (never sourced) by the image entrypoint.
"""

import base64
import os
import re
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

ENV_FILENAME = "env"
_MAX_BYTES = 256 * 1024

_HEADER_LINES = (
    "# reef guest env v1 - written by reef, parsed (never eval'd) by the entrypoint.",
    "v1",
)

# Mirrors the entrypoint's key guard; also what stops a key with a space or a
# newline from injecting a second record.
_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


@dataclass(frozen=True, slots=True)
class EnvRecord:
    """``op`` is ``"s"`` (set) or ``"u"`` (unset); ``value`` is plaintext here -
    base64 exists only on the wire to the guest."""

    op: Literal["s", "u"]
    key: str
    value: str = ""


def serialize(records: Sequence[EnvRecord]) -> str:
    lines = list(_HEADER_LINES)
    for rec in records:
        if rec.op not in ("s", "u"):
            raise ValueError(f"unknown env record op {rec.op!r}")
        if not _KEY_RE.match(rec.key):
            raise ValueError(f"invalid env key {rec.key!r}")
        if rec.op == "u":
            lines.append(f"u {rec.key}")
            continue
        encoded = base64.b64encode(rec.value.encode("utf-8")).decode("ascii")
        # An empty value would leave a trailing space that is easy to strip in
        # transit; write the two-field form instead.
        lines.append(f"s {rec.key} {encoded}" if encoded else f"s {rec.key}")
    return "\n".join(lines) + "\n"


def parse(text: str) -> list[EnvRecord]:
    """A malformed line is skipped rather than raising, matching the guest-side parser."""
    if len(text) > _MAX_BYTES:
        return []
    out: list[EnvRecord] = []
    for line in text.splitlines():
        parts = line.split()
        if not 2 <= len(parts) <= 3:
            continue
        op, key = parts[0], parts[1]
        if op not in ("s", "u") or not _KEY_RE.match(key):
            continue
        if op == "u":
            if len(parts) == 2:
                out.append(EnvRecord(op="u", key=key))
            continue
        if len(parts) == 2:
            out.append(EnvRecord(op="s", key=key))
            continue
        try:
            value = base64.b64decode(parts[2], validate=True).decode("utf-8")
        except ValueError:
            continue
        if "\x00" in value:
            continue
        out.append(EnvRecord(op="s", key=key, value=value))
    return out


def read_env_file(host_dir: str | Path) -> list[EnvRecord] | None:
    """``None`` when the file is missing, oversized or unreadable, versus ``[]`` for
    a file that exists and carries no records."""
    path = Path(host_dir) / ENV_FILENAME
    try:
        if path.stat().st_size > _MAX_BYTES:
            return None
        raw = path.read_text(encoding="utf-8")
    except OSError, ValueError:
        return None
    return parse(raw)


def ensure_env_dir(host_dir: str | Path) -> None:
    """The leaf is world-readable because a host file owned by the reef user appears
    as ``root:root`` in the guest, so the guest's non-root uid reaches it through the
    world bits or not at all; confidentiality is the 0700 parent's job."""
    directory = Path(host_dir)
    parent = directory.parent
    if not parent.exists():
        parent.mkdir(parents=True, exist_ok=True)
        os.chmod(parent, 0o700)
    directory.mkdir(exist_ok=True)
    os.chmod(directory, 0o755)


_PENDING_KEY = "REEF_PENDING_REBUILD"


def pending_handle(sandbox_id: str) -> str:
    """``+`` is outside the sandbox-id charset (``fleet._NAME_RE``), so this sibling
    env dir can never collide with a real agent's - and it is mounted into no guest."""
    return f"{sandbox_id}+pending"


def encode_blob(payload: str) -> list[EnvRecord]:
    return [EnvRecord(op="s", key=_PENDING_KEY, value=payload)]


def decode_blob(records: Sequence[EnvRecord] | None) -> str | None:
    for record in records or ():
        if record.op == "s" and record.key == _PENDING_KEY:
            return record.value
    return None


def write_env_file(host_dir: str | Path, records: Sequence[EnvRecord]) -> None:
    """Replace ``<host_dir>/env`` atomically, so a boot racing a save never sees a
    half-written file."""
    directory = Path(host_dir)
    ensure_env_dir(directory)
    text = serialize(records)
    tmp = directory / ".env.tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, 0o644)  # O_CREAT's mode is masked by the umask; the guest must read it
        os.replace(tmp, directory / ENV_FILENAME)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
