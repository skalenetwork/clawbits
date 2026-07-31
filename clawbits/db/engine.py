"""SQLModel engine + session helpers for Clawbits.

A single module-level :class:`Engine` is lazily created on first access via
:func:`get_engine` and cached.  The engine connects to Postgres through the
``psycopg`` driver by default; the URL can be overridden with the
``CLAWBITS_DATABASE_URL`` environment variable.

Schema management is delegated to Alembic — see
:func:`run_alembic_upgrade_head`. Use :func:`init_db` only in tests where
spinning up Alembic is unwanted overhead.
"""
from __future__ import annotations

import os
import pathlib

from sqlalchemy import Engine
from sqlmodel import Session, SQLModel, create_engine

DEFAULT_DATABASE_URL = "postgresql+psycopg://clawbits:clawbits@localhost:5432/clawbits"

_engine: Engine | None = None
_REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
_ALEMBIC_INI = _REPO_ROOT / "alembic.ini"


def get_database_url() -> str:
    """Resolve the database URL from the environment (or fall back to default)."""
    return os.getenv("CLAWBITS_DATABASE_URL", DEFAULT_DATABASE_URL)


def create_engine_from_env() -> Engine:
    """Build a new Engine from the current environment. Used by the server at startup."""
    url = get_database_url()
    return create_engine(url, pool_pre_ping=True)


def get_engine() -> Engine:
    """Return the process-wide engine, lazily creating it on first call."""
    global _engine
    if _engine is None:
        _engine = create_engine_from_env()
    return _engine


def run_alembic_upgrade_head() -> None:
    """Run ``alembic upgrade head`` against the env-configured database.

    Alembic owns schema management; the app calls this at startup so that a
    fresh database is brought up to date and an existing one is migrated.
    The DB URL is read from ``CLAWBITS_DATABASE_URL`` inside ``env.py`` —
    set the env var before calling this if you want a non-default target.
    """
    from alembic import command
    from alembic.config import Config

    if not _ALEMBIC_INI.is_file():
        raise FileNotFoundError(
            f"alembic.ini not found at {_ALEMBIC_INI}. If running in a "
            "container, ensure the Dockerfile COPYs alembic.ini into /app/."
        )
    command.upgrade(Config(str(_ALEMBIC_INI)), "head")


def init_db(engine: Engine) -> None:
    """Create all SQLModel-registered tables (no migration history written).

    Used by the test harness, which manages its own DB lifecycle. Production
    code should call :func:`run_alembic_upgrade_head` instead.
    """
    from clawbits.db import models  # noqa: F401  populate metadata

    SQLModel.metadata.create_all(engine)


def new_session(engine: Engine | None = None) -> Session:
    """Return a freshly opened :class:`Session`. Caller must close it."""
    eng = engine or get_engine()
    return Session(eng)
