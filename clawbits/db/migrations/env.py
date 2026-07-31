"""Alembic env.

Resolves the DB URL from ``CLAWBITS_DATABASE_URL`` (the same env var the app
reads) and points autogenerate at ``SQLModel.metadata`` so
``alembic revision --autogenerate`` diffs the live DB against
``clawbits.db.models``.
"""
from __future__ import annotations

from logging.config import fileConfig

from alembic import context
from sqlalchemy import create_engine, pool
from sqlmodel import SQLModel

# Importing models populates SQLModel.metadata before autogenerate runs.
from clawbits.db import models  # noqa: F401
from clawbits.db.engine import get_database_url

config = context.config

if config.config_file_name is not None:
    # ``disable_existing_loggers=False`` is critical here. The default
    # is True, which silently disables every logger created before
    # alembic ran — including ``clawbits.auth`` and any other module
    # logger imported during startup. The first observed symptom was
    # that auth events stopped being logged after the first request:
    # the ``auth.logger.ready`` startup banner fired (before alembic),
    # but every per-request auth log went to /dev/null (after alembic).
    fileConfig(config.config_file_name, disable_existing_loggers=False)

target_metadata = SQLModel.metadata


def run_migrations_offline() -> None:
    """Render migrations as SQL without connecting to a DB."""
    context.configure(
        url=get_database_url(),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        compare_type=True,
        compare_server_default=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Apply migrations against a real DB connection."""
    engine = create_engine(get_database_url(), poolclass=pool.NullPool)
    with engine.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            compare_type=True,
            compare_server_default=True,
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
