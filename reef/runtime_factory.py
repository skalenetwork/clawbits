"""Pick the agent runtime for this host.

Docker locally (Mac dev — microsandbox's host↔guest relay is unreliable there),
microsandbox on Linux (prod). Both implementations satisfy ``AdminRuntime``, so
nothing downstream (manager, ``FleetService``, the API) changes. Override the
per-platform default with ``REEF_RUNTIME=docker|microsandbox``.
"""

import os
import sys

from reef.exposure import DirectPortExposure, ExposureStrategy, SubdomainProxyExposure
from reef.runtime import AdminRuntime
from reef.store import SandboxStore


def default_backend() -> str:
    """Per-platform default: docker on macOS, microsandbox elsewhere."""
    return "docker" if sys.platform == "darwin" else "microsandbox"


def make_runtime(backend: str | None = None) -> AdminRuntime:
    """Construct the configured runtime. ``backend`` overrides env, which
    overrides the per-platform default. Imports are lazy so a host needs only
    the backend it actually uses on its PATH."""
    choice = (backend or os.getenv("REEF_RUNTIME") or default_backend()).strip().lower()
    if choice == "docker":
        from reef.docker_runtime import DockerRuntime

        return DockerRuntime()
    if choice in ("microsandbox", "msb"):
        from reef.microsandbox_runtime import MicrosandboxRuntime

        return MicrosandboxRuntime()
    raise ValueError(f"unknown REEF_RUNTIME={choice!r} (expected 'docker' or 'microsandbox')")


def _default_db_path() -> str:
    """Where the SQLite store lives: ``REEF_DB_PATH`` if set, else
    ``${REEF_STATE_DIR:-~/.reef}/reef.db`` (``REEF_STATE_DIR`` already roots the
    runtime's per-agent status mounts)."""
    explicit = os.getenv("REEF_DB_PATH")
    if explicit:
        return explicit
    state_dir = os.getenv("REEF_STATE_DIR") or os.path.expanduser("~/.reef")
    return os.path.join(state_dir, "reef.db")


def make_store() -> SandboxStore:
    """Pick the sandbox store. ``REEF_STORE=sqlite`` (default) is a durable single
    file that survives an API restart, so agents reconcile as ``managed`` instead
    of degrading to drift; ``REEF_STORE=memory`` is the ephemeral dict store (tests,
    throwaway dev). Lazy imports keep each path's deps off the other. The SQLite DB
    path comes from ``_default_db_path``."""
    choice = (os.getenv("REEF_STORE") or "sqlite").strip().lower()
    if choice == "sqlite":
        from reef.store_sqlite import SqliteSandboxStore

        return SqliteSandboxStore(_default_db_path())
    if choice == "memory":
        from reef.store import InMemorySandboxStore

        return InMemorySandboxStore()
    raise ValueError(f"unknown REEF_STORE={choice!r} (expected 'sqlite' or 'memory')")


def make_exposure() -> ExposureStrategy:
    """Pick the exposure strategy: an nginx subdomain proxy when ``REEF_BASE_DOMAIN``
    is set (prod), else a direct forwarded port (local dev)."""
    base = os.getenv("REEF_BASE_DOMAIN")
    if not base:
        return DirectPortExposure()
    return SubdomainProxyExposure(
        base,
        nginx_dir=os.getenv("REEF_NGINX_DIR", "/etc/nginx/reef.d"),
        tls_cert=os.getenv("REEF_TLS_CERT"),
        tls_key=os.getenv("REEF_TLS_KEY"),
        secret=os.getenv("REEF_SUBDOMAIN_SECRET", ""),
    )
