"""Durable intake journal ``<state dir>/inbox.db`` of one Hermes profile (stdlib only).

Tables: ``source`` (cursors of a channel or mailbox epoch), ``item`` (each admitted post or mail
and its disposition), ``delivery`` (each outbound chat post or email with its idempotency key)
and ``reader_call`` (restricted-reader budget). Each public method is one transaction or a read.
"""

from __future__ import annotations

import argparse
import contextlib
import dataclasses
import hashlib
import json
import os
import sqlite3
import sys
import threading
import time
import urllib.parse
from collections.abc import Callable, Iterator, Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .health import profile_home, state_dir
from .read_cursors import READ_CURSOR_FILE

SCHEMA_VERSION = 1
MIN_READER = 1  # lowest SCHEMA_VERSION that may open a journal this code writes
FINAL = ("processed", "ignored", "deleted")
MAX_OPEN = 500
MAX_ATTEMPTS = 5
DELIVERY_TERMINAL = ("accepted", "posted", "failed", "unknown")
DELIVERY_STATES = ("local", "posting", "queued", "attempting", "retry_wait", *DELIVERY_TERMINAL)
KEEP_BACKUPS = 3
STALL_S = 3600.0
TOOL_SEND_GRACE_S = 300.0  # the send tool owns its POST (and one retry) this long
# The email name mirrors email_integration.EMAIL_WATERMARK_FILE (a module with heavy imports).
LEGACY_FILES = {"chat": READ_CURSOR_FILE, "email": "clawbits-email-watermark.json"}
LEGACY_REAPPEARED = "legacy_reappeared"
_KEY_PREFIX = {"email": "cbr1-", "chat": "cbc1-"}


class JournalTooNew(RuntimeError):
    """The journal's min_reader is above SCHEMA_VERSION."""


class JournalMigrationError(RuntimeError):
    """Backup or migration failed and the journal keeps its old schema; ``code`` says which."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclasses.dataclass(frozen=True)
class Source:
    id: int
    kind: str
    locator: str
    epoch: str
    state: str
    enumerated: int
    scan_through: int | None
    settled: int
    acked: int
    note: str


@dataclasses.dataclass(frozen=True)
class Item:
    id: int
    source_id: int
    lane: str
    pos: int
    ext_id: str
    reason: str
    state: str
    note: str | None
    attempts: int
    payload: dict[str, Any]
    context: dict[str, Any] | None
    not_before: float


@dataclasses.dataclass(frozen=True)
class NewItem:
    pos: int
    ext_id: str
    reason: str
    state: str = "pending"
    note: str | None = None
    payload: dict[str, Any] | None = None
    lane: str = "post"


@dataclasses.dataclass(frozen=True)
class Intent:
    kind: str
    body: str
    subject: str | None = None
    headers: dict[str, str] | None = None
    target: str | None = None
    version: int = 1


@dataclasses.dataclass(frozen=True)
class Delivery:
    key: str
    item_id: int | None
    kind: str
    version: int
    target: str | None
    subject: str | None
    body: str
    headers: dict[str, str]
    state: str
    remote_id: str | None
    note: str | None
    attempts: int
    not_before: float


_V1 = (
    "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    """CREATE TABLE source (
        id INTEGER PRIMARY KEY, backend TEXT NOT NULL, agent_id TEXT NOT NULL,
        profile TEXT NOT NULL, kind TEXT NOT NULL, locator TEXT NOT NULL, epoch TEXT NOT NULL,
        state TEXT NOT NULL, enumerated INTEGER NOT NULL, scan_through INTEGER,
        settled INTEGER NOT NULL, acked INTEGER NOT NULL DEFAULT 0, note TEXT NOT NULL,
        updated_at REAL NOT NULL, UNIQUE (backend, agent_id, profile, kind, locator, epoch))""",
    """CREATE TABLE item (
        id INTEGER PRIMARY KEY, source_id INTEGER NOT NULL REFERENCES source(id),
        lane TEXT NOT NULL, pos INTEGER NOT NULL, ext_id TEXT NOT NULL, reason TEXT NOT NULL,
        state TEXT NOT NULL, note TEXT, attempts INTEGER NOT NULL DEFAULT 0, not_before REAL,
        run TEXT, msgid TEXT, payload TEXT, context TEXT, outcome TEXT,
        created_at REAL NOT NULL, updated_at REAL NOT NULL, UNIQUE (source_id, lane, pos))""",
    "CREATE INDEX item_open ON item (source_id, state, pos)",
    "CREATE INDEX item_msgid ON item (msgid) WHERE msgid IS NOT NULL",
    """CREATE TABLE delivery (
        key TEXT PRIMARY KEY, ns TEXT NOT NULL, item_id INTEGER REFERENCES item(id),
        kind TEXT NOT NULL, version INTEGER NOT NULL, target TEXT, subject TEXT,
        body TEXT NOT NULL, headers TEXT NOT NULL, state TEXT NOT NULL, remote_id TEXT,
        note TEXT, attempts INTEGER NOT NULL DEFAULT 0, not_before REAL, resolved TEXT,
        created_at REAL NOT NULL, updated_at REAL NOT NULL, UNIQUE (item_id, kind, version))""",
    """CREATE TABLE reader_call (
        source_id INTEGER NOT NULL REFERENCES source(id), at REAL NOT NULL,
        tokens INTEGER NOT NULL)""",
    "CREATE INDEX reader_call_at ON reader_call (source_id, at)",
)


def _create_v1(db: sqlite3.Connection) -> None:
    for statement in _V1:
        db.execute(statement)


# Step from schema N to N+1; every pending step runs in one transaction.
MIGRATIONS: dict[int, Callable[[sqlite3.Connection], None]] = {0: _create_v1}


def canonical_backend(url: str) -> str:
    """Lowercase scheme and host; drop userinfo, default port, query, fragment, trailing slash."""
    parts = urllib.parse.urlsplit(url.strip())
    scheme, host, port = parts.scheme.lower(), (parts.hostname or "").lower(), parts.port
    host = f"[{host}]" if ":" in host else host
    netloc = host if port in (None, {"http": 80, "https": 443}.get(scheme)) else f"{host}:{port}"
    return urllib.parse.urlunsplit((scheme, netloc, parts.path.rstrip("/"), "", ""))


def journal_path(home: Path | str | None = None) -> Path:
    return state_dir(home) / "inbox.db"


def _dump(value: Any) -> str:
    return json.dumps(value, separators=(",", ":"))


def _private_dir(path: Path) -> Path:
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(path, 0o700)
    return path


def _stamp() -> str:
    return datetime.now(UTC).strftime("%Y%m%dT%H%M%S%fZ")


def _ro(path: Path) -> sqlite3.Connection:
    """Read-only connection that never creates the database or runs DDL."""
    db = sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    return db


def _connect(path: Path) -> sqlite3.Connection:
    """Autocommit connection via Hermes's open_db (WAL with fallback, FULL sync), else sqlite3."""
    try:
        from hermes_cli.sqlite_util import open_db
    except ImportError:
        db = sqlite3.connect(path, timeout=5.0, check_same_thread=False)
        db.row_factory = sqlite3.Row
        for pragma in ("journal_mode=WAL", "synchronous=FULL", "foreign_keys=ON"):
            db.execute(f"PRAGMA {pragma}")
    else:
        db = open_db(path, db_label="clawbits inbox", foreign_keys=True, synchronous_full=True,
                     check_same_thread=False)
    db.isolation_level = None
    return db


def _versions(db: sqlite3.Connection) -> tuple[int, int]:
    """(schema, min_reader) recorded in the file; (0, 0) before the journal exists."""
    if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'").fetchone():
        return 0, 0
    meta = {k: v for k, v in db.execute("SELECT key, value FROM meta")}
    schema = int(meta.get("schema", 0))
    return schema, int(meta.get("min_reader", schema))


def _refuse_newer(min_reader: int) -> None:
    if min_reader > SCHEMA_VERSION:
        raise JournalTooNew(
            f"inbox journal needs plugin schema {min_reader}; this plugin has {SCHEMA_VERSION}"
        )


def _backup(db: sqlite3.Connection, directory: Path, schema: int) -> None:
    """Copy the journal to ``backups/inbox.v<schema>.<UTC>.db`` (0600); keep the newest few."""
    backups = directory / "backups"
    target = backups / f"inbox.v{schema}.{_stamp()}.db"
    try:
        _private_dir(backups)
        os.close(os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600))
        with contextlib.closing(sqlite3.connect(target)) as copy:
            db.backup(copy)
    except (OSError, sqlite3.Error) as exc:
        with contextlib.suppress(OSError):
            target.unlink()
        raise JournalMigrationError("journal_backup_failed") from exc
    by_age = sorted(backups.glob("inbox.v*.db"), key=lambda p: p.name.split(".")[-2])
    for old in by_age[:-KEEP_BACKUPS]:
        old.unlink(missing_ok=True)


def _migrate(db: sqlite3.Connection, *, migrate: bool) -> None:
    """Under the write lock: re-check both versions, then step the schema up to SCHEMA_VERSION."""
    try:
        db.execute("BEGIN IMMEDIATE")
        schema, min_reader = _versions(db)
        _refuse_newer(min_reader)
        if schema < SCHEMA_VERSION and not migrate:
            raise JournalMigrationError("journal_migration_pending")
        for version in range(schema, SCHEMA_VERSION):
            MIGRATIONS[version](db)
        if schema < SCHEMA_VERSION:
            db.executemany(
                "INSERT INTO meta (key, value) VALUES (?, ?)"
                " ON CONFLICT (key) DO UPDATE SET value=excluded.value",
                [("schema", str(SCHEMA_VERSION)), ("min_reader", str(MIN_READER))],
            )
        db.execute("COMMIT")
    except Exception as exc:
        if db.in_transaction:
            db.execute("ROLLBACK")
        if isinstance(exc, (JournalTooNew, JournalMigrationError)):
            raise
        raise JournalMigrationError("journal_migration_failed") from exc


def open_journal(home: Path, *, backend: str, agent_id: str, profile: str) -> InboxJournal:
    """Guard (JournalTooNew before any write), back up an older journal, migrate it, open it."""
    ns = (canonical_backend(backend), agent_id, profile or "default")
    return _open(home, ns, migrate=True)


def _open(home: Path | str | None, ns: tuple[str, str, str], *, migrate: bool) -> InboxJournal:
    path = journal_path(home)
    _private_dir(path.parent)
    schema = 0
    if path.exists() and path.stat().st_size:
        with contextlib.closing(_ro(path)) as probe:
            schema, min_reader = _versions(probe)
            _refuse_newer(min_reader)
            if migrate and 0 < schema < SCHEMA_VERSION:
                _backup(probe, path.parent, schema)
    if schema < SCHEMA_VERSION and not migrate:
        raise JournalMigrationError("journal_migration_pending")
    os.close(os.open(path, os.O_CREAT | os.O_RDWR, 0o600))
    os.chmod(path, 0o600)
    db = _connect(path)
    try:
        _migrate(db, migrate=migrate)
    except BaseException:
        db.close()
        raise
    return InboxJournal(db, ns, profile_home(home))


def _report(db: sqlite3.Connection) -> dict[str, Any] | None:
    """Versions, counts by state, oldest open age, stalled work, held sources; codes and numbers."""
    schema, min_reader = _versions(db)
    if not schema:
        return None
    supported = min_reader <= SCHEMA_VERSION
    report: dict[str, Any] = {"schema": schema, "min_reader": min_reader, "supported": supported}
    if not supported:
        return report
    now = time.time()

    def counts(sql: str) -> dict[str, int]:
        return {str(k): n for k, n in db.execute(sql)}

    def scalar(sql: str, *params: Any) -> Any:
        return db.execute(sql, params).fetchone()[0]

    oldest = scalar(f"SELECT MIN(created_at) FROM item WHERE state NOT IN {FINAL}")
    stalled_items = scalar(
        "SELECT COUNT(*) FROM item WHERE state='processing' AND updated_at<?", now - STALL_S
    )
    stalled_deliveries = scalar(
        "SELECT COUNT(*) FROM delivery"
        " WHERE state IN ('posting', 'queued', 'attempting', 'retry_wait')"
        " AND COALESCE(not_before, updated_at)<?",
        now - STALL_S,
    )
    held = db.execute(
        "SELECT kind, id FROM source WHERE state='migration_needs_review' ORDER BY id"
    )
    return {
        **report,
        "items": counts("SELECT state, COUNT(*) FROM item GROUP BY state"),
        "review_reasons": counts(
            "SELECT COALESCE(note, ''), COUNT(*) FROM item WHERE state='needs_review' GROUP BY 1"
        ),
        "oldest_open_age_s": None if oldest is None else max(0.0, now - oldest),
        "stalled": stalled_items + stalled_deliveries,
        "replies": counts(
            "SELECT state, COUNT(*) FROM delivery WHERE resolved IS NULL GROUP BY state"
        ),
        "sources_needing_review": [f"{kind}:{sid}" for kind, sid in held],
    }


def read_stats(home: Path | str | None) -> dict[str, Any] | None:
    """Journal report for ``doctor``, read-only (mode=ro, no DDL); None without a journal."""
    path = journal_path(home)
    if not path.is_file() or not path.stat().st_size:
        return None
    with contextlib.closing(_ro(path)) as db:
        return _report(db)


def legacy_present(home: Path | str | None) -> dict[str, Path]:
    """Pre-journal cursor files in the profile home, by source kind."""
    root = profile_home(home)
    return {kind: root / name for kind, name in LEGACY_FILES.items() if (root / name).is_file()}


_JSON_NULL = {"payload": "{}", "context": "null", "headers": "{}"}  # JSON columns, read of NULL


def _row(cls: type, row: sqlite3.Row) -> Any:
    """A Source, Item or Delivery from a ``SELECT *`` row, by field name."""

    def value(name: str) -> Any:
        if name in _JSON_NULL:
            return json.loads(row[name] or _JSON_NULL[name])
        return float(row[name] or 0) if name == "not_before" else row[name]

    return cls(**{f.name: value(f.name) for f in dataclasses.fields(cls)})


# Just below a source's first open post or mail item, inside an UPDATE of that source.
_FIRST_OPEN = (
    "(SELECT MIN(pos) - 1 FROM item WHERE source_id=source.id AND lane!='attention'"
    f" AND state NOT IN {FINAL})"
)


def _identity(db: sqlite3.Connection, item_id: int, kind: str) -> tuple[list[str], int]:
    """(namespace, kind, locator, epoch, pos) of the item and its newest ``kind`` version."""
    if kind not in _KEY_PREFIX:
        raise ValueError(f"not a delivery kind: {kind}")
    row = db.execute(
        "SELECT s.backend, s.agent_id, s.profile, s.kind, s.locator, s.epoch, i.pos,"
        " (SELECT COALESCE(MAX(version), 0) FROM delivery WHERE item_id=i.id AND kind=?)"
        " FROM item i JOIN source s ON s.id=i.source_id WHERE i.id=?",
        (kind, item_id),
    ).fetchone()
    if row is None:
        raise LookupError(f"no item {item_id}")
    return [str(v) for v in tuple(row)[:7]], row[7]


def _key(identity: list[str], kind: str, version: int) -> str:
    """Idempotency key of a delivery: identity and version only, never content."""
    digest = hashlib.sha256("|".join([*identity, str(version)]).encode()).hexdigest()[:40]
    return _KEY_PREFIX[kind] + digest


class InboxJournal:
    """One profile's journal on one connection, shared by the event loop and tool threads."""

    def __init__(self, db: sqlite3.Connection, ns: tuple[str, str, str], home: Path) -> None:
        self.db, self.ns, self.home = db, ns, home
        self._lock = threading.RLock()

    @contextlib.contextmanager
    def _tx(self) -> Iterator[sqlite3.Connection]:
        with self._lock:
            self.db.execute("BEGIN IMMEDIATE")
            try:
                yield self.db
                self.db.execute("COMMIT")
            except BaseException:
                if self.db.in_transaction:  # SQLITE_FULL and I/O errors roll back on their own
                    self.db.execute("ROLLBACK")
                raise

    def _rows(self, sql: str, params: Sequence[Any] = ()) -> list[sqlite3.Row]:
        with self._lock:
            return self.db.execute(sql, params).fetchall()

    def _write(self, sql: str, params: Sequence[Any] | dict[str, Any] = ()) -> int:
        """One statement in its own transaction; its rowcount."""
        with self._tx() as db:
            return db.execute(sql, params).rowcount

    def _get(self, cls: type, table: str, column: str, value: Any) -> Any:
        rows = self._rows(f"SELECT * FROM {table} WHERE {column}=?", (value,))
        if not rows:
            raise LookupError(f"no {table} {value}")
        return _row(cls, rows[0])

    def _source(self, source_id: int) -> Source:
        return self._get(Source, "source", "id", source_id)

    def _delivery(self, key: str) -> Delivery:
        return self._get(Delivery, "delivery", "key", key)

    def source(self, kind: str, locator: str) -> Source | None:
        """Newest non-retired source for ``kind``/``locator`` in this namespace."""
        rows = self._rows(
            "SELECT * FROM source WHERE backend=? AND agent_id=? AND profile=? AND kind=?"
            " AND locator=? AND state!='retired' ORDER BY id DESC LIMIT 1",
            (*self.ns, kind, locator),
        )
        return _row(Source, rows[0]) if rows else None

    def create_source(
        self, kind: str, locator: str, epoch: Any, *, enumerated: int, note: str,
        state: str = "active",
    ) -> Source:
        """Insert a source; a retired one of the same epoch (an epoch can come back) is reactivated
        with its cursors, a live one returned as is. ``note`` records the start decision."""
        unique = (*self.ns, kind, locator, str(epoch))
        with self._tx() as db:
            db.execute(
                "INSERT INTO source (backend, agent_id, profile, kind, locator, epoch, state,"
                " enumerated, settled, note, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
                " ON CONFLICT (backend, agent_id, profile, kind, locator, epoch) DO UPDATE SET"
                " state=excluded.state, note=excluded.note, updated_at=excluded.updated_at"
                " WHERE state='retired'",
                (*unique, state, enumerated, enumerated, note, time.time()),
            )
            source_id = db.execute(
                "SELECT id FROM source WHERE backend=? AND agent_id=? AND profile=? AND kind=?"
                " AND locator=? AND epoch=?",
                unique,
            ).fetchone()[0]
        return self._source(source_id)

    def update_source(
        self, source: Source, *, state: str | None = None, note: str | None = None,
        enumerated: int | None = None,
    ) -> Source:
        """Change state or note; ``enumerated`` only moves forward, except on a held source,
        whose ``settled`` follows it but stays below its first open item."""
        self._write(
            "UPDATE source SET"
            " enumerated=CASE WHEN :pos IS NULL THEN enumerated"
            "  WHEN state='migration_needs_review' THEN :pos ELSE MAX(enumerated, :pos) END,"
            " settled=CASE WHEN :pos IS NULL OR state!='migration_needs_review' THEN settled"
            f"  ELSE MIN(:pos, COALESCE({_FIRST_OPEN}, :pos)) END,"
            " state=COALESCE(:state, state), note=COALESCE(:note, note), updated_at=:now"
            " WHERE id=:id",
            {"pos": enumerated, "state": state, "note": note, "now": time.time(), "id": source.id},
        )
        return self._source(source.id)

    def retire(self, source: Source, note: str) -> None:
        """Retire an epoch; its waiting items go to needs_review(note)."""
        now = time.time()
        with self._tx() as db:
            db.execute(
                "UPDATE source SET state='retired', note=?, updated_at=? WHERE id=?",
                (note, now, source.id),
            )
            db.execute(
                "UPDATE item SET state='needs_review', note=?, updated_at=?"
                " WHERE source_id=? AND state IN ('pending', 'retry_wait')",
                (note, now, source.id),
            )

    def move_legacy(self, kind: str) -> Path | None:
        """Mark ``kind`` adopted, then move its legacy file (if any) into ``<state dir>/legacy/``.

        Call it once a kind's sources exist, whatever they started from; returns the moved path."""
        self.set_meta(f"legacy_moved:{kind}", _stamp())
        source = legacy_present(self.home).get(kind)
        if source is None:
            return None
        target = _private_dir(state_dir(self.home) / "legacy") / source.name
        if target.exists():
            target = target.with_name(f"{source.name}.{_stamp()}")
        os.replace(source, target)
        os.chmod(target, 0o600)
        return target

    def hold_legacy(self) -> int:
        """Hold active sources of each adopted kind whose legacy file is back (a pre-journal plugin
        ran) for review; how many."""
        kinds = [k for k in legacy_present(self.home) if self.get_meta(f"legacy_moved:{k}")]
        if not kinds:
            return 0
        return self._write(
            "UPDATE source SET state='migration_needs_review', note=?, updated_at=?"
            " WHERE backend=? AND agent_id=? AND profile=? AND state='active'"
            f" AND kind IN ({','.join('?' * len(kinds))})",
            (LEGACY_REAPPEARED, time.time(), *self.ns, *kinds),
        )

    def admit(
        self, source: Source, rows: Sequence[NewItem], *, enumerated: int,
        scan_through: int | None = None,
    ) -> Source:
        """Insert a page (repeated positions ignored) and advance the cursor in one transaction."""
        now = time.time()
        with self._tx() as db:
            db.executemany(
                "INSERT INTO item (source_id, lane, pos, ext_id, reason, state, note, payload,"
                " created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
                " ON CONFLICT (source_id, lane, pos) DO NOTHING",
                [(source.id, r.lane, r.pos, r.ext_id, r.reason, r.state, r.note,
                  _dump(r.payload or {}), now, now) for r in rows],
            )
            db.execute(
                "UPDATE source SET enumerated=MAX(enumerated, ?), scan_through=?, updated_at=?"
                " WHERE id=?",
                (enumerated, scan_through, now, source.id),
            )
        return self._source(source.id)

    def lane_item(self, source: Source, lane: str, pos: int) -> Item | None:
        rows = self._rows(
            "SELECT * FROM item WHERE source_id=? AND lane=? AND pos=?", (source.id, lane, pos)
        )
        return _row(Item, rows[0]) if rows else None

    def open_count(self, source: Source) -> int:
        """Items without a final disposition (backpressure against MAX_OPEN)."""
        sql = f"SELECT COUNT(*) FROM item WHERE source_id=? AND state NOT IN {FINAL}"
        return self._rows(sql, (source.id,))[0][0]

    def due(
        self, source: Source, limit: int, *, lane: str | None = None, now: float | None = None
    ) -> list[Item]:
        """Pending and due retry_wait items, oldest position first."""
        rows = self._rows(
            "SELECT * FROM item WHERE source_id=? AND (? IS NULL OR lane=?) AND (state='pending'"
            " OR (state='retry_wait' AND COALESCE(not_before, 0)<=?)) ORDER BY pos, id LIMIT ?",
            (source.id, lane, lane, time.time() if now is None else now, limit),
        )
        return [_row(Item, r) for r in rows]

    def posts_between(self, source: Source, lo: int, hi: int) -> list[Item]:
        """Post-lane items with ``lo < pos <= hi``, in order."""
        rows = self._rows(
            "SELECT * FROM item WHERE source_id=? AND lane='post' AND pos>? AND pos<=?"
            " ORDER BY pos",
            (source.id, lo, hi),
        )
        return [_row(Item, r) for r in rows]

    def claim(self, ids: Sequence[int], run: str, context: dict[str, Any] | None = None) -> None:
        """Mark pending or retry_wait items processing for dispatch ``run`` (attempts+1), keeping
        ``context`` and its message_id."""
        now, ctx = time.time(), _dump(context) if context else None
        msgid = str((context or {}).get("message_id") or "").strip() or None
        with self._tx() as db:
            db.executemany(
                "UPDATE item SET state='processing', run=?, attempts=attempts+1,"
                " context=COALESCE(?, context), msgid=COALESCE(?, msgid), updated_at=?"
                " WHERE id=? AND state IN ('pending', 'retry_wait')",
                [(run, ctx, msgid, now, i) for i in ids],
            )

    def finish(
        self, ids: Sequence[int], state: str, note: str, *, outcome: dict[str, Any] | None = None,
        intents: Sequence[Intent] = (),
    ) -> list[Delivery]:
        """Record a disposition on items not yet final and, for one item, its delivery intents.

        One transaction. Intents for a final item raise LookupError; an email intent needs a
        processed disposition and keeps one row per version (``Intent.version``), chat intents
        take the item's next versions."""
        if state not in (*FINAL, "needs_review"):
            raise ValueError(f"not a disposition: {state}")
        if intents and len(ids) != 1:
            raise ValueError("delivery intents belong to exactly one item")
        if state != "processed" and any(i.kind == "email" for i in intents):
            raise ValueError("email intents need a processed disposition")
        now, keys = time.time(), []
        msgid = str((outcome or {}).get("message_id") or "").strip() or None
        with self._tx() as db:
            finished = db.executemany(
                "UPDATE item SET state=?, note=?, outcome=COALESCE(?, outcome),"
                f" msgid=COALESCE(?, msgid), updated_at=? WHERE id=? AND state NOT IN {FINAL}",
                [(state, note, _dump(outcome) if outcome else None, msgid, now, i) for i in ids],
            ).rowcount
            if intents and not finished:
                raise LookupError(f"item {ids[0]} is missing or already final")
            for intent in intents:
                identity, newest = _identity(db, ids[0], intent.kind)
                version = intent.version
                if intent.kind != "email":
                    version = max(version, newest + 1)
                keys.append(_key(identity, intent.kind, version))
                db.execute(
                    "INSERT INTO delivery (key, ns, item_id, kind, version, target, subject, body,"
                    " headers, state, created_at, updated_at)"
                    " VALUES (?,?,?,?,?,?,?,?,?,'local',?,?)"
                    " ON CONFLICT (item_id, kind, version) DO NOTHING",
                    (keys[-1], "|".join(identity[:3]), ids[0], intent.kind, version,
                     intent.target, intent.subject, intent.body, _dump(intent.headers or {}),
                     now, now),
                )
        return [self._delivery(k) for k in keys]

    def retry_later(
        self, ids: Sequence[int], note: str, delay: float, *, count_attempt: bool = True
    ) -> None:
        """retry_wait until ``delay`` passes; a counted failure at MAX_ATTEMPTS is needs_review.

        Only dispatcher states change (never needs_review or final). A claim already counted its
        attempt; an uncounted retry of a claimed item gives it back."""
        if count_attempt:
            attempts = "attempts + (state != 'processing')"
            state = (
                f"CASE WHEN {attempts} >= {MAX_ATTEMPTS} THEN 'needs_review' ELSE 'retry_wait' END"
            )
        else:
            attempts, state = "MAX(attempts - (state = 'processing'), 0)", "'retry_wait'"
        now = time.time()
        with self._tx() as db:
            db.executemany(
                f"UPDATE item SET state={state}, attempts={attempts}, note=?, not_before=?,"
                " updated_at=? WHERE id=? AND state IN ('pending', 'processing', 'retry_wait')",
                [(note, now + delay, now, i) for i in ids],
            )

    def requeue(self, source: Source, note: str) -> int:
        """needs_review(note) items of ``source`` go back to pending, attempts reset; how many."""
        return self._write(
            "UPDATE item SET state='pending', note='requeued', attempts=0, not_before=NULL,"
            " reason=CASE WHEN reason='live' THEN 'backlog' ELSE reason END, updated_at=?"
            " WHERE source_id=? AND state='needs_review' AND note=?",
            (time.time(), source.id, note),
        )

    def seen_message_id(self, msgid: str) -> bool:
        """True if a processed email item in this namespace already had this Message-ID."""
        rows = self._rows(
            "SELECT 1 FROM item i JOIN source s ON s.id=i.source_id WHERE i.msgid=?"
            " AND i.state='processed' AND s.kind='email' AND s.backend=? AND s.agent_id=?"
            " AND s.profile=? LIMIT 1",
            (msgid.strip(), *self.ns),
        )
        return bool(rows)

    def settle(self, source: Source) -> Source:
        """Advance ``settled`` to just below the first open post or mail item, at most to
        ``enumerated`` (items admitted past the cursor never count); never back."""
        target = f"MIN(enumerated, COALESCE({_FIRST_OPEN}, enumerated))"
        self._write(
            f"UPDATE source SET settled={target}, updated_at=? WHERE id=? AND {target}>settled",
            (time.time(), source.id),
        )
        return self._source(source.id)

    def set_acked(self, source: Source, pos: int) -> None:
        """Record the position acked to the server (monotonic)."""
        self._write(
            "UPDATE source SET acked=MAX(acked, ?), updated_at=? WHERE id=?",
            (pos, time.time(), source.id),
        )

    def record_tool_send(self, key: str, subject: str, body: str) -> Delivery:
        """Persist a send-tool email as posting before its POST (idempotent on ``key``); the
        outbox waits TOOL_SEND_GRACE_S."""
        now = time.time()
        self._write(
            "INSERT INTO delivery (key, ns, kind, version, subject, body, headers, state,"
            " attempts, not_before, created_at, updated_at)"
            " VALUES (?, ?, 'email', 1, ?, ?, '{}', 'posting', 1, ?, ?, ?)"
            " ON CONFLICT (key) DO NOTHING",
            (key, "|".join(self.ns), subject, body, now + TOOL_SEND_GRACE_S, now, now),
        )
        return self._delivery(key)

    def due_deliveries(
        self, limit: int, *, kind: str | None = None, now: float | None = None
    ) -> list[Delivery]:
        """Non-terminal deliveries of this namespace that are due, oldest first."""
        rows = self._rows(
            f"SELECT * FROM delivery WHERE ns=? AND state NOT IN {DELIVERY_TERMINAL}"
            " AND (? IS NULL OR kind=?) AND COALESCE(not_before, 0)<=?"
            " ORDER BY created_at, rowid LIMIT ?",
            ("|".join(self.ns), kind, kind, time.time() if now is None else now, limit),
        )
        return [_row(Delivery, r) for r in rows]

    def update_delivery(
        self, key: str, state: str, *, remote_id: str | None = None, note: str | None = None,
        delay: float | None = None,
    ) -> None:
        """Adopt a local or server delivery state; entering posting counts an attempt, ``delay``
        defers the next look."""
        if state not in DELIVERY_STATES:
            raise ValueError(f"not a delivery state: {state}")
        now = time.time()
        changed = self._write(
            "UPDATE delivery SET state=?, remote_id=COALESCE(?, remote_id), note=?,"
            " attempts=attempts+?, not_before=?, updated_at=? WHERE key=?",
            (state, remote_id, note, int(state == "posting"), now + delay if delay else None,
             now, key),
        )
        if not changed:
            raise LookupError(f"no delivery {key}")

    def resend(self, key: str) -> Delivery:
        """Operator re-send of a failed or unknown delivery: a local copy under the next version."""
        now = time.time()
        with self._tx() as db:
            old = db.execute(
                "SELECT * FROM delivery WHERE key=? AND state IN ('failed', 'unknown')"
                " AND resolved IS NULL",
                (key,),
            ).fetchone()
            if old is None:
                raise LookupError(f"delivery {key} is not failed or unknown")
            if old["item_id"] is None:
                version = old["version"] + 1
                new_key = key[:5] + hashlib.sha256(f"{key}|{version}".encode()).hexdigest()[:40]
            else:
                identity, newest = _identity(db, old["item_id"], old["kind"])
                version = newest + 1
                new_key = _key(identity, old["kind"], version)
            db.execute(
                "UPDATE delivery SET resolved='resent', updated_at=? WHERE key=?", (now, key)
            )
            db.execute(
                "INSERT INTO delivery (key, ns, item_id, kind, version, target, subject, body,"
                " headers, state, created_at, updated_at) SELECT ?, ns, item_id, kind, ?, target,"
                " subject, body, headers, 'local', ?, ? FROM delivery WHERE key=?",
                (new_key, version, now, now, key),
            )
        return self._delivery(new_key)

    def dismiss_delivery(self, key: str) -> None:
        """Operator acceptance of a failed or unknown delivery without re-sending it."""
        dismissed = self._write(
            "UPDATE delivery SET resolved='dismissed', updated_at=? WHERE key=?"
            " AND state IN ('failed', 'unknown') AND resolved IS NULL",
            (time.time(), key),
        )
        if not dismissed:
            raise LookupError(f"delivery {key} is not failed or unknown")

    def record_reader_call(self, source: Source, *, tokens: int, at: float) -> None:
        """Count one restricted-reader call and its tokens against the mailbox budget."""
        self._write(
            "INSERT INTO reader_call (source_id, at, tokens) VALUES (?, ?, ?)",
            (source.id, at, int(tokens)),
        )

    def reader_usage(self, source: Source, *, since: float) -> tuple[int, int]:
        """(tokens, calls) since ``since`` across every epoch of this source's mailbox."""
        row = self._rows(
            "SELECT COALESCE(SUM(c.tokens), 0), COUNT(*) FROM reader_call c"
            " JOIN source s ON s.id=c.source_id JOIN source t ON t.id=?"
            " WHERE c.at>=? AND s.backend=t.backend AND s.agent_id=t.agent_id"
            " AND s.profile=t.profile AND s.kind=t.kind AND s.locator=t.locator",
            (source.id, since),
        )[0]
        return int(row[0]), int(row[1])

    def reconcile(self, live_runs: set[str]) -> dict[str, int]:
        """Restart accounting for processing items outside ``live_runs``: mail below MAX_ATTEMPTS
        goes back to pending (the reader has no side effects), the rest to
        needs_review('interrupted'); waiting live items become backlog."""
        live = sorted(live_runs)
        stale = f"state='processing' AND COALESCE(run, '') NOT IN ({','.join('?' * len(live))})"
        now = time.time()
        with self._tx() as db:
            requeued = db.execute(
                f"UPDATE item SET state='pending', note='interrupted', updated_at=?"
                f" WHERE {stale} AND lane='mail' AND attempts<?",
                (now, *live, MAX_ATTEMPTS),
            ).rowcount
            review = db.execute(
                f"UPDATE item SET state='needs_review', note='interrupted', updated_at=?"
                f" WHERE {stale}",
                (now, *live),
            ).rowcount
            backlog = db.execute(
                "UPDATE item SET reason='backlog', updated_at=?"
                " WHERE reason='live' AND state IN ('pending', 'retry_wait')",
                (now,),
            ).rowcount
        return {"requeued": requeued, "needs_review": review, "backlog": backlog}

    def review(self, item_id: int, action: str) -> None:
        """Operator decision on a needs_review item: ``retry`` (pending again, attempts reset; not
        for a retired source) or ``dismiss`` (ignored)."""
        changes = {
            "retry": "state='pending', note='operator_retry', attempts=0, not_before=NULL,"
            " reason=CASE WHEN reason='live' THEN 'backlog' ELSE reason END",
            "dismiss": "state='ignored', note='dismissed'",
        }
        if action not in changes:
            raise ValueError(f"not a review action: {action}")
        with self._tx() as db:
            source = db.execute(
                "SELECT s.id, s.state FROM item i JOIN source s ON s.id=i.source_id"
                " WHERE i.id=? AND i.state='needs_review'",
                (item_id,),
            ).fetchone()
            if source is None:
                raise LookupError(f"item {item_id} is not awaiting review")
            if action == "retry" and source["state"] == "retired":
                raise LookupError(f"item {item_id} is in retired source {source['id']}; dismiss it")
            db.execute(
                f"UPDATE item SET {changes[action]}, updated_at=? WHERE id=?",
                (time.time(), item_id),
            )

    def get_meta(self, key: str) -> str | None:
        rows = self._rows("SELECT value FROM meta WHERE key=?", (key,))
        return rows[0][0] if rows else None

    def set_meta(self, key: str, value: str) -> None:
        self._write(
            "INSERT INTO meta (key, value) VALUES (?, ?)"
            " ON CONFLICT (key) DO UPDATE SET value=excluded.value",
            (key, value),
        )

    def stats(self) -> dict[str, Any]:
        """The ``read_stats`` report of this journal."""
        with self._lock:
            return _report(self.db) or {}

    def prune(self, *, retain_s: float = 7 * 86400, drop_s: float = 30 * 86400) -> None:
        """Blank the content of final items and settled deliveries after ``retain_s``; after
        ``drop_s`` drop settled chat rows (mail stays for Message-ID dedupe) and reader calls."""
        now = time.time()
        keep, drop = now - retain_s, now - drop_s
        with self._tx() as db:
            db.execute(
                "UPDATE item SET payload=NULL, context=NULL, outcome=NULL"
                f" WHERE state IN {FINAL} AND updated_at<?"
                " AND COALESCE(payload, context, outcome) IS NOT NULL",
                (keep,),
            )
            db.execute(
                "UPDATE delivery SET subject=NULL, body='', headers='{}'"
                " WHERE (state IN ('accepted', 'posted') OR resolved IS NOT NULL)"
                " AND updated_at<? AND body!=''",
                (keep,),
            )
            db.execute(
                f"DELETE FROM item WHERE state IN {FINAL} AND lane!='mail' AND updated_at<?"
                " AND pos<=(SELECT settled FROM source WHERE id=item.source_id)"
                " AND id NOT IN (SELECT item_id FROM delivery WHERE item_id IS NOT NULL)",
                (drop,),
            )
            db.execute("DELETE FROM reader_call WHERE at<?", (drop,))

    def close(self) -> None:
        with self._lock:
            self.db.close()


def _newest(journal: InboxJournal, source: Source) -> int:
    """The server's newest position for ``source``, read with this profile's identity."""
    from .account import resolve_account
    from .cli_client import _ClawbitsCli

    account = resolve_account()
    if not account.usable:
        raise LookupError("no Clawbits identity in this profile")
    owner = journal._rows("SELECT backend, agent_id FROM source WHERE id=?", (source.id,))[0]
    if tuple(owner) != (canonical_backend(account.base_url), account.agent_id):
        raise LookupError(f"source {source.id} belongs to another backend or agent")
    client = _ClawbitsCli.for_account(account)
    if source.kind == "email":
        page = client.email_changes(account.agent_id, 0, limit=1)
        if str(page.get("uidvalidity")) != source.epoch:
            raise LookupError("the mailbox epoch changed; the gateway starts the new epoch itself")
        return int(page.get("through_uid") or 0)
    channel = next((c for c in client.list_channels() if c.id == source.locator), None)
    if channel is None or channel.latest_post_id is None:
        raise LookupError(f"channel {source.locator} reports no newest post")
    return int(channel.latest_post_id)


def _refuse_rewind(journal: InboxJournal, source: Source, start: int) -> None:
    """A source read before restarts at or past its cursor: an earlier start would skip the rows
    kept for it and admit its pruned ones again."""
    if start >= source.enumerated:
        return
    has_items = journal._rows("SELECT 1 FROM item WHERE source_id=? LIMIT 1", (source.id,))
    if has_items or source.note == LEGACY_REAPPEARED:
        raise LookupError(
            f"source {source.id} was read through position {source.enumerated};"
            f" use --adopt or --from-uid {source.enumerated + 1} or later"
        )


def _act(journal: InboxJournal, args: argparse.Namespace) -> str:
    command = args.inbox_command
    if command == "resend":
        new = journal.resend(args.key)
        return f"Delivery {args.key} resent as {new.key} (version {new.version})."
    if command == "migrate":
        source = journal._source(args.source)
        if source.state != "migration_needs_review":
            raise LookupError(f"source {source.id} is {source.state}, not held for migration")
        if args.adopt:
            mode, start = "adopt", None
        elif args.new_only:
            mode, start = "new_only", _newest(journal, source)
        else:
            mode, start = "from_uid", max(args.from_uid - 1, 0)
        if start is not None:
            _refuse_rewind(journal, source, start)
        note = f"migrated:{mode}"
        source = journal.update_source(source, state="active", note=note, enumerated=start)
        journal.move_legacy(source.kind)
        after = f"active after position {source.enumerated} ({note})"
        kept = journal.open_count(source)
        tail = f"; {kept} open item(s) kept" if kept else ""
        return f"Source {source.id} ({source.kind}) {after}{tail}."
    target = str(args.item)
    if command == "dismiss" and not target.isdigit():
        journal.dismiss_delivery(target)
        return f"Delivery {target} dismissed."
    if not target.isdigit():
        raise LookupError(f"{target} is not an item id")
    journal.review(int(target), command)
    return f"Item {target} {'queued for retry' if command == 'retry' else 'dismissed'}."


_STATUS_ROWS = (
    (
        "Sources (id kind locator state enumerated settled acked note):",
        "SELECT id, kind, locator, state, enumerated, settled, acked, note FROM source ORDER BY id",
    ),
    (
        "Needs review (item source lane pos note; retry ITEM | dismiss ITEM):",
        "SELECT id, source_id, lane, pos, note FROM item WHERE state='needs_review'"
        " ORDER BY id LIMIT 50",
    ),
    (
        "Deliveries failed or unknown (key kind version state note; resend KEY | dismiss KEY):",
        "SELECT key, kind, version, state, note FROM delivery WHERE state IN ('failed', 'unknown')"
        " AND resolved IS NULL ORDER BY created_at LIMIT 50",
    ),
)


def _status(home: Path) -> int:
    path = journal_path(home)
    with contextlib.closing(_ro(path)) as db:
        report = _report(db)
        if report is None:
            print(f"Inbox journal {path}: not initialised yet.")
            return 0
        if not report["supported"]:
            print(f"Inbox journal {path}: schema {report['schema']} needs a newer plugin"
                  f" (min_reader {report['min_reader']}).")
            return 1
        items = ", ".join(f"{state} {n}" for state, n in sorted(report["items"].items())) or "none"
        age = report["oldest_open_age_s"]
        oldest = "" if age is None else f"; oldest open {int(age)}s"
        lines = [
            f"Inbox journal {path} (schema {report['schema']})",
            f"Items: {items}{oldest}; stalled {report['stalled']}",
        ]
        for title, sql in _STATUS_ROWS:
            if rows := db.execute(sql).fetchall():
                lines += [title, *("  " + " ".join(str(v) for v in row) for row in rows)]
    if legacy := legacy_present(home):
        names = ", ".join(p.name for p in legacy.values())
        lines.append(f"Legacy cursor files in the profile: {names}")
    print(*lines, sep="\n")
    return 0


def run_inbox_cli(args: argparse.Namespace) -> int:
    """``hermes clawbits inbox status|retry|dismiss|migrate|resend``; ids, codes, counts only."""
    command = getattr(args, "inbox_command", None)
    if command not in ("status", "retry", "dismiss", "migrate", "resend"):
        print("usage: hermes clawbits inbox {status,retry,dismiss,migrate,resend} ...")
        return 2
    home = profile_home()
    if not journal_path(home).is_file():
        print(f"No Clawbits inbox journal in {home}.")
        return 0 if command == "status" else 1
    try:
        if command == "status":
            return _status(home)
        with contextlib.closing(_open(home, ("", "", ""), migrate=False)) as journal:
            print(_act(journal, args))
    except (RuntimeError, LookupError, ValueError, OSError, sqlite3.Error) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0
