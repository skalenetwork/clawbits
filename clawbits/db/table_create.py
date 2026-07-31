"""Schema bring-up. Production startup runs Alembic; tests use the SQLModel
``create_all`` shortcut for speed.
"""
from __future__ import annotations

import logging

from sqlalchemy import Engine, inspect
from sqlmodel import SQLModel

from clawbits.db.engine import run_alembic_upgrade_head


class TableCreate:
    @staticmethod
    def create_all_tables(engine: Engine) -> None:
        """Bring the schema up to ``head``.

        The server uses this at startup. Tests have their own helper that
        calls :func:`clawbits.db.engine.init_db` for speed.

        The ``engine`` argument is accepted for API compatibility but not
        used — Alembic resolves the URL from ``CLAWBITS_DATABASE_URL``.
        """
        del engine
        logging.info("Running alembic upgrade head ...")
        run_alembic_upgrade_head()

    @staticmethod
    def verify_all_tables_and_seeds(engine: Engine) -> None:
        """Assert every SQLModel-registered table exists in the database."""
        from clawbits.db import models  # noqa: F401  ensure metadata populated

        expected = set(SQLModel.metadata.tables.keys())
        existing = set(inspect(engine).get_table_names())
        missing = expected - existing
        if missing:
            raise AssertionError(f"Missing tables: {sorted(missing)}")
        logging.info("Verified %d tables.", len(expected))
