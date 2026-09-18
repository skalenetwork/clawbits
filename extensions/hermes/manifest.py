"""Plugin version, read once from ``plugin.yaml``.

Lives in its own module (not ``__init__``) so every sibling module can import
``PLUGIN_VERSION`` without pulling in the adapter or the gateway imports —
``__init__`` re-exports it for the outside world. The same ``version:`` line
is the Hermes floor the clawbits server enforces
(``clawbits/fastapi/version_check.py``), so the manifest is the one source.
"""

from __future__ import annotations

import re
from pathlib import Path


def _read_plugin_version() -> str:
    manifest = Path(__file__).resolve().parent / "plugin.yaml"
    for line in manifest.read_text(encoding="utf-8").splitlines():
        if found := re.match(r"""^version:\s*['"]?([^'"\s#]+)""", line):
            return found.group(1)
    raise RuntimeError(f"{manifest} has no version")


PLUGIN_VERSION = _read_plugin_version()
