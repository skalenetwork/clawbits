"""Durable ``SandboxStore`` backed by a single SQLite file.

The default store in prod/dev: unlike ``InMemorySandboxStore`` it survives an
``reef.api`` restart, so previously-created agents reconcile back as ``managed``
(with their ``terminal_url`` + stable ports) instead of degrading to drift. Same
4-method async ``SandboxStore`` Protocol — nothing downstream (manager / fleet /
API) changes. Postgres is the later multi-host successor behind the same seam.

Design: stdlib ``sqlite3`` (no new dependency), WAL mode, one ``sandboxes`` table
mirroring the ``Sandbox`` dataclass. SQLite is synchronous, so every operation
runs off the event loop via ``asyncio.to_thread`` over a short-lived connection —
single-host admin-plane traffic, so per-op connect cost is irrelevant and there's
no shared-state/thread-affinity hazard. ``put`` is an upsert.

**Secret-free, non-negotiable:** the ``Sandbox`` record carries no password/token
(the access secret is returned once by ``SandboxManager.expose`` and lives only in
the container env), and this table has no column that could hold one. The DB never
contains secrets — see docs/REEF.md §9 #4.
"""

import asyncio
import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime

from reef.models import Sandbox
from reef.runtime import DesiredState, RestartPolicy, SandboxState

# Bump when the schema changes; tracked via ``PRAGMA user_version`` (no ORM/Alembic).
_SCHEMA_VERSION = 5

# Columns mirror the ``Sandbox`` dataclass 1:1. Deliberately NO password/token
# column — the record is secret-free and so is this table.
_COLUMNS = (
    "sandbox_id",
    "profile",
    "backend",
    "state",
    "image",
    "volume",
    "handle",
    "tenant",
    "created_at",
    "updated_at",
    "port",
    "url",
    "terminal_port",
    "terminal_url",
    "color",
    "created_image_id",
    "desired_state",
    "restart_policy",
    "restart_count",
    "last_restart_at",
    "capabilities",
)

_CREATE_TABLE = """
CREATE TABLE IF NOT EXISTS sandboxes (
    sandbox_id    TEXT PRIMARY KEY,
    profile       TEXT NOT NULL,
    backend       TEXT NOT NULL,
    state         TEXT NOT NULL,
    image         TEXT NOT NULL,
    volume        TEXT NOT NULL,
    handle        TEXT,
    tenant        TEXT,
    created_at    TEXT,
    updated_at    TEXT,
    port          INTEGER,
    url           TEXT,
    terminal_port INTEGER,
    terminal_url  TEXT,
    color         TEXT,
    created_image_id TEXT,
    desired_state   TEXT,
    restart_policy  TEXT,
    restart_count   INTEGER,
    last_restart_at TEXT,
    capabilities    TEXT
)
"""

_UPSERT = (
    f"INSERT INTO sandboxes ({', '.join(_COLUMNS)}) "
    f"VALUES ({', '.join('?' for _ in _COLUMNS)}) "
    "ON CONFLICT(sandbox_id) DO UPDATE SET "
    + ", ".join(f"{c}=excluded.{c}" for c in _COLUMNS if c != "sandbox_id")
)


def _to_row(s: Sandbox) -> tuple:
    """Serialize a ``Sandbox`` to a row: enum → its value, datetimes → ISO text."""
    return (
        s.sandbox_id,
        s.profile,
        s.backend,
        s.state.value,
        s.image,
        s.volume,
        s.handle,
        s.tenant,
        s.created_at.isoformat() if s.created_at else None,
        s.updated_at.isoformat() if s.updated_at else None,
        s.port,
        s.url,
        s.terminal_port,
        s.terminal_url,
        s.color,
        s.created_image_id,
        s.desired_state.value,
        s.restart_policy.value,
        s.restart_count,
        s.last_restart_at.isoformat() if s.last_restart_at else None,
        # Comma-separated; normalize() guarantees a stable order and no commas
        # inside a name, so a plain join round-trips without quoting.
        ",".join(s.capabilities or ()),
    )


def _from_row(row: sqlite3.Row) -> Sandbox:
    """Rebuild a ``Sandbox`` from a row (inverse of ``_to_row``)."""
    return Sandbox(
        sandbox_id=row["sandbox_id"],
        profile=row["profile"],
        backend=row["backend"],
        state=SandboxState(row["state"]),
        image=row["image"],
        volume=row["volume"],
        handle=row["handle"],
        tenant=row["tenant"],
        created_at=datetime.fromisoformat(row["created_at"]) if row["created_at"] else None,
        updated_at=datetime.fromisoformat(row["updated_at"]) if row["updated_at"] else None,
        port=row["port"],
        url=row["url"],
        terminal_port=row["terminal_port"],
        terminal_url=row["terminal_url"],
        color=row["color"],
        created_image_id=row["created_image_id"],
        desired_state=(
            DesiredState(row["desired_state"]) if row["desired_state"] else DesiredState.RUNNING
        ),
        restart_policy=(
            RestartPolicy(row["restart_policy"])
            if row["restart_policy"]
            else RestartPolicy.ON_FAILURE
        ),
        restart_count=row["restart_count"] or 0,
        last_restart_at=(
            datetime.fromisoformat(row["last_restart_at"]) if row["last_restart_at"] else None
        ),
        # NULL (pre-v5 row) and '' (explicitly no capabilities) both land on ().
        # Note this does NOT pick up DEFAULT_CAPABILITIES: those apply at CREATE,
        # to an omitted field. An existing agent's granted set is operator state,
        # so a later change to the defaults must not silently widen it on the next
        # upgrade — re-grant explicitly via PATCH /fleet/{id}.
        capabilities=tuple(c for c in (row["capabilities"] or "").split(",") if c),
    )


class SqliteSandboxStore:
    """File-backed ``SandboxStore``. Durable across process restarts.

    The constructor ensures the parent dir exists and runs a create-table-if-missing
    migration; pass any filesystem path (e.g. ``~/.reef/reef.db``).
    """

    def __init__(self, db_path: str, *, timeout: float = 5.0) -> None:
        self._path = str(db_path)
        self._timeout = timeout  # busy-timeout (seconds) for a transient write lock
        os.makedirs(os.path.dirname(os.path.abspath(self._path)) or ".", exist_ok=True)
        with self._connect() as conn:
            # WAL is a persistent DB property — set once here, inherited by every
            # later connection (better single-writer/many-reader concurrency).
            conn.execute("PRAGMA journal_mode=WAL")
            self._migrate(conn)

    @contextmanager
    def _connect(self):
        conn = sqlite3.connect(self._path, timeout=self._timeout)
        conn.row_factory = sqlite3.Row
        try:
            yield conn
        finally:
            conn.close()

    def _migrate(self, conn: sqlite3.Connection) -> None:
        version = conn.execute("PRAGMA user_version").fetchone()[0]
        if version >= _SCHEMA_VERSION:
            return
        # Fresh DB: create with every column. Existing DB: a no-op here, patched below.
        conn.execute(_CREATE_TABLE)
        if version < 2:
            # v1 → v2: add the per-agent ``color`` column to a pre-existing table.
            # Harmless duplicate on a table we just created with it — guard the error.
            try:
                conn.execute("ALTER TABLE sandboxes ADD COLUMN color TEXT")
            except sqlite3.OperationalError:
                pass  # column already present
        if version < 3:
            # v2 → v3: self-healing columns. Add them, then backfill existing rows.
            for ddl in (
                "ALTER TABLE sandboxes ADD COLUMN desired_state TEXT",
                "ALTER TABLE sandboxes ADD COLUMN restart_policy TEXT",
                "ALTER TABLE sandboxes ADD COLUMN restart_count INTEGER",
                "ALTER TABLE sandboxes ADD COLUMN last_restart_at TEXT",
            ):
                try:
                    conn.execute(ddl)
                except sqlite3.OperationalError:
                    pass  # column already present (fresh CREATE above)
            # A running/failed agent should stay up (desired running); a deliberately
            # stopped one stays stopped (don't let the reconciler revive it).
            conn.execute(
                "UPDATE sandboxes SET desired_state = "
                "CASE WHEN state = 'stopped' THEN 'stopped' ELSE 'running' END "
                "WHERE desired_state IS NULL"
            )
            conn.execute(
                "UPDATE sandboxes SET restart_policy = 'on-failure' WHERE restart_policy IS NULL"
            )
            conn.execute("UPDATE sandboxes SET restart_count = 0 WHERE restart_count IS NULL")
        if version < 4:
            # v3 → v4: the active image digest recorded at create/upgrade (drives
            # the "running an older image" upgrade affordance). Left NULL on
            # existing rows — they get an id on their next upgrade.
            try:
                conn.execute("ALTER TABLE sandboxes ADD COLUMN created_image_id TEXT")
            except sqlite3.OperationalError:
                pass  # column already present (fresh CREATE above)
        if version < 5:
            # v4 → v5: per-agent opt-in capabilities (reef.capabilities). Left NULL
            # on existing rows, which reads back as () — the safe baseline, so an
            # upgrade never silently grants an existing agent anything new.
            try:
                conn.execute("ALTER TABLE sandboxes ADD COLUMN capabilities TEXT")
            except sqlite3.OperationalError:
                pass  # column already present (fresh CREATE above)
        conn.execute(f"PRAGMA user_version = {_SCHEMA_VERSION}")
        conn.commit()

    # ── sync DB ops (run off the event loop) ──
    def _get_sync(self, sandbox_id: str) -> Sandbox | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM sandboxes WHERE sandbox_id = ?", (sandbox_id,)
            ).fetchone()
        return _from_row(row) if row is not None else None

    def _put_sync(self, sandbox: Sandbox) -> None:
        with self._connect() as conn:
            conn.execute(_UPSERT, _to_row(sandbox))
            conn.commit()

    def _delete_sync(self, sandbox_id: str) -> None:
        with self._connect() as conn:
            conn.execute("DELETE FROM sandboxes WHERE sandbox_id = ?", (sandbox_id,))
            conn.commit()

    def _list_sync(self) -> list[Sandbox]:
        with self._connect() as conn:
            rows = conn.execute("SELECT * FROM sandboxes").fetchall()
        return [_from_row(r) for r in rows]

    # ── SandboxStore Protocol (async) ──
    async def get(self, sandbox_id: str) -> Sandbox | None:
        return await asyncio.to_thread(self._get_sync, sandbox_id)

    async def put(self, sandbox: Sandbox) -> None:
        await asyncio.to_thread(self._put_sync, sandbox)

    async def delete(self, sandbox_id: str) -> None:
        await asyncio.to_thread(self._delete_sync, sandbox_id)

    async def list(self) -> list[Sandbox]:
        return await asyncio.to_thread(self._list_sync)
