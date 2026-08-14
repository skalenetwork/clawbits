"""Plugin version, read once from ``plugin.yaml``.

Lives in its own module (not ``__init__``) so every sibling module can import
``PLUGIN_VERSION`` without pulling in the adapter or the gateway imports —
``__init__`` re-exports it for the outside world.
"""

from __future__ import annotations

import logging
import re
from pathlib import Path

logger = logging.getLogger(__name__)

# Last-resort value if the manifest can't be read (a broken install). Kept in step
# with plugin.yaml, but never the thing that ships — see _read_plugin_version.
_FALLBACK_PLUGIN_VERSION = "0.7.0"


def _read_plugin_version() -> str:
    """This plugin's version, read from the ``plugin.yaml`` beside this file.

    ONE source of truth, deliberately. That same ``version:`` line is (a) awk'd by the
    reef image entrypoint to stamp ``CLAWBITS_PLUGIN_VERSION``, and (b) read by the
    clawbits server as the Hermes version FLOOR (``clawbits/fastapi/version_check.py``).
    A hard-coded constant here would be a fourth copy free to drift from the manifest —
    and the failure mode is nasty: the agent reports one version while the server floors
    on another, so enrollment dies with a 426 ``plugin_outdated`` that looks like a
    server bug. Read the manifest instead.
    """
    manifest = Path(__file__).resolve().parent / "plugin.yaml"
    try:
        for line in manifest.read_text(encoding="utf-8").splitlines():
            match = re.match(r"""^version:\s*['"]?([^'"\s#]+)""", line)
            if match:
                return match.group(1)
    except OSError:
        logger.warning("clawbits: could not read %s — falling back to %s", manifest, _FALLBACK_PLUGIN_VERSION)
    return _FALLBACK_PLUGIN_VERSION


PLUGIN_VERSION = _read_plugin_version()
