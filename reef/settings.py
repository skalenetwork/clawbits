"""Operator-adjustable settings, persisted next to the fleet state.

Today this is just the **public URL override**: the origin agent Control-UI /
terminal links are built on (see ``reef.api.routes._publicize_access``). A value
set here from the admin UI wins over the ``REEF_PUBLIC_URL`` env var, letting an
operator repoint the surface links at a new tunnel without editing an env file
and restarting the process.

Stored as a tiny JSON file at ``${REEF_STATE_DIR:-~/.reef}/settings.json`` (the
same state root the SQLite store roots under, see ``runtime_factory``).
"""

from __future__ import annotations

import json
import os
from pathlib import Path

_FILENAME = "settings.json"


def _state_dir() -> Path:
    return Path(os.getenv("REEF_STATE_DIR") or os.path.expanduser("~/.reef"))


def _path() -> Path:
    return _state_dir() / _FILENAME


def _load() -> dict:
    try:
        data = json.loads(_path().read_text())
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}
    return data if isinstance(data, dict) else {}


def _save(data: dict) -> None:
    path = _path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, indent=2))
    tmp.replace(path)  # atomic on POSIX


def get_public_url_override() -> str | None:
    """The operator-set override, or ``None`` when unset/blank."""
    value = _load().get("public_url")
    return value.strip() if isinstance(value, str) and value.strip() else None


def set_public_url_override(url: str | None) -> None:
    """Persist (or clear, with ``None``/blank) the public URL override."""
    data = _load()
    if url and url.strip():
        data["public_url"] = url.strip()
    else:
        data.pop("public_url", None)
    _save(data)


def public_url_env() -> str | None:
    """The ``REEF_PUBLIC_URL`` env value, or ``None`` when unset/blank."""
    value = os.getenv("REEF_PUBLIC_URL")
    return value.strip() if value and value.strip() else None


def effective_public_url() -> str | None:
    """The origin to build surface URLs on: the operator override wins over the
    ``REEF_PUBLIC_URL`` env var. ``None`` when neither is set (callers then fall
    back to the request origin)."""
    return get_public_url_override() or public_url_env()
