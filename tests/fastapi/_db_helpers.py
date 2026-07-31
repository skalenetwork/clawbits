"""Shared test DB helpers for the FastAPI test suite.

Provides:
- ``TEST_DATABASE_URL`` — the URL of the shared test database (``clawbits_test``
  by default) built from ``CLAWBITS_TEST_DATABASE_URL`` or a sensible default.
- ``ensure_database(name)`` / ``drop_database(name)`` — admin-connection helpers.
- ``ephemeral_database()`` — context manager that yields a URL to a freshly
  created DB (named with ``uuid4``) whose schema is built via
  ``SQLModel.metadata.create_all``; the DB is dropped on exit.
"""
from __future__ import annotations

import os
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from urllib.parse import urlparse, urlunparse

import psycopg

DEFAULT_TEST_DATABASE_URL = (
    "postgresql+psycopg://clawbits:clawbits@localhost:5432/clawbits_test"
)


def _test_database_url() -> str:
    return os.getenv("CLAWBITS_TEST_DATABASE_URL", DEFAULT_TEST_DATABASE_URL)


TEST_DATABASE_URL: str = _test_database_url()


def _split_url(url: str) -> tuple[str, str]:
    """Return (admin_psycopg_url, db_name) for a SQLAlchemy-style URL.

    The admin URL targets the ``postgres`` DB and uses a bare ``postgresql://``
    scheme (psycopg, not SQLAlchemy).
    """
    parsed = urlparse(url)
    # SQLAlchemy uses e.g. ``postgresql+psycopg``; strip the driver for psycopg.
    scheme = parsed.scheme.split("+", 1)[0]
    db_name = (parsed.path or "/").lstrip("/")
    admin = parsed._replace(scheme=scheme, path="/postgres")
    return urlunparse(admin), db_name


def _db_url_for(db_name: str, template_url: str | None = None) -> str:
    """Return a URL identical to ``template_url`` but pointing at ``db_name``."""
    template = template_url or TEST_DATABASE_URL
    parsed = urlparse(template)
    return urlunparse(parsed._replace(path=f"/{db_name}"))


def ensure_database(name: str, template_url: str | None = None) -> None:
    """Create Postgres database ``name`` if it does not already exist."""
    admin_url, _ = _split_url(template_url or TEST_DATABASE_URL)
    with psycopg.connect(admin_url, autocommit=True) as conn, conn.cursor() as cur:
        cur.execute("SELECT 1 FROM pg_database WHERE datname = %s", (name,))
        if cur.fetchone() is None:
            # CREATE DATABASE cannot run inside a transaction; autocommit handles that.
            cur.execute(f'CREATE DATABASE "{name}"')


def drop_database(name: str, template_url: str | None = None) -> None:
    """Drop Postgres database ``name`` (with ``FORCE``, PG 13+) if it exists."""
    admin_url, _ = _split_url(template_url or TEST_DATABASE_URL)
    with psycopg.connect(admin_url, autocommit=True) as conn, conn.cursor() as cur:
        cur.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')


@contextmanager
def ephemeral_database(prefix: str = "clawbits_test_tmp") -> Iterator[str]:
    """Yield a URL to a freshly created (empty) DB; drop it on exit.

    The DB name is ``{prefix}_{uuid4().hex[:8]}``. The schema is **not**
    pre-created — the caller (typically a ``ClawBitsServer`` instance) is
    expected to bring it up via the normal startup path so the migration
    pipeline is exercised end-to-end.
    """
    name = f"{prefix}_{uuid.uuid4().hex[:8]}"
    ensure_database(name)
    try:
        yield _db_url_for(name)
    finally:
        drop_database(name)
