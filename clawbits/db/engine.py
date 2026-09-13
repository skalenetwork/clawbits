"""Engine and session helpers. ``CLAWBITS_DATABASE_URL`` overrides the local default URL;
Alembic owns the schema (:func:`run_alembic_upgrade_head`) and :func:`init_db` is for tests."""
from __future__ import annotations

import os
import pathlib

from sqlalchemy import Engine
from sqlmodel import Session, SQLModel, create_engine

DEFAULT_DATABASE_URL = "postgresql+psycopg://clawbits:clawbits@localhost:5432/clawbits"

_engine: Engine | None = None
_ALEMBIC_INI = pathlib.Path(__file__).resolve().parents[2] / "alembic.ini"


def get_database_url() -> str:
    return os.getenv("CLAWBITS_DATABASE_URL", DEFAULT_DATABASE_URL)


def create_engine_from_env() -> Engine:
    return create_engine(
        get_database_url(), pool_pre_ping=True, pool_size=10, max_overflow=10, pool_use_lifo=True
    )


def get_engine() -> Engine:
    """The process-wide engine, created on first use."""
    global _engine
    if _engine is None:
        _engine = create_engine_from_env()
    return _engine


def run_alembic_upgrade_head() -> None:
    from alembic import command
    from alembic.config import Config

    if not _ALEMBIC_INI.is_file():
        raise FileNotFoundError(
            f"alembic.ini not found at {_ALEMBIC_INI}. If running in a "
            "container, ensure the Dockerfile COPYs alembic.ini into /app/."
        )
    command.upgrade(Config(str(_ALEMBIC_INI)), "head")


def init_db(engine: Engine) -> None:
    """Create every table without migration history. Test harness only."""
    from clawbits.db import models  # noqa: F401

    SQLModel.metadata.create_all(engine)


def new_session(engine: Engine | None = None) -> Session:
    """A new :class:`Session` the caller must close."""
    return Session(engine or get_engine())
