"""SandboxStore contract (memory + sqlite), SQLite durability, and the restart
reconciliation this durability buys us at the FleetService level.

Async methods are driven via ``asyncio.run`` (no pytest-asyncio dependency).
"""

import asyncio
import sqlite3
from datetime import UTC, datetime

import pytest

from reef.fleet import FleetService
from reef.manager import SandboxManager
from reef.models import Sandbox
from reef.runtime import DesiredState, RestartPolicy, SandboxState
from reef.store import InMemorySandboxStore
from reef.store_sqlite import SqliteSandboxStore
from reef.tests.fakes import FakeAdminRuntime


def _record(sandbox_id: str = "agent-1", **kw) -> Sandbox:
    """A fully-populated record so round-trips exercise every column (enum,
    timestamps, ports, urls, terminal_url)."""
    now = datetime(2026, 6, 4, 12, 0, tzinfo=UTC)
    return Sandbox(
        sandbox_id=sandbox_id,
        profile=kw.get("profile", "openclaw"),
        backend=kw.get("backend", "docker"),
        state=kw.get("state", SandboxState.RUNNING),
        image=kw.get("image", "reef-oc:plugin"),
        volume=kw.get("volume", f"reef-{sandbox_id}"),
        handle=kw.get("handle", f"docker://{sandbox_id}"),
        tenant=kw.get("tenant", "org-acme"),
        created_at=kw.get("created_at", now),
        updated_at=kw.get("updated_at", now),
        port=kw.get("port", 19000),
        url=kw.get("url", "http://127.0.0.1:19000"),
        terminal_port=kw.get("terminal_port", 19001),
        terminal_url=kw.get("terminal_url", "http://127.0.0.1:19001"),
        color=kw.get("color", "violet"),
        desired_state=kw.get("desired_state", DesiredState.STOPPED),
        restart_policy=kw.get("restart_policy", RestartPolicy.ALWAYS),
        restart_count=kw.get("restart_count", 2),
        last_restart_at=kw.get("last_restart_at", now),
    )


# ── Shared store contract (both implementations) ──────────────────────────────


@pytest.fixture(params=["memory", "sqlite"])
def store(request, tmp_path):
    if request.param == "memory":
        return InMemorySandboxStore()
    return SqliteSandboxStore(str(tmp_path / "reef.db"))


def test_get_missing_returns_none(store):
    assert asyncio.run(store.get("nope")) is None


def test_put_then_get_roundtrips_every_field(store):
    rec = _record("oc-1")
    asyncio.run(store.put(rec))
    got = asyncio.run(store.get("oc-1"))
    assert got == rec  # all fields, incl. state enum, timestamps, ports, terminal_url
    assert got.state is SandboxState.RUNNING  # rehydrated as the enum, not a str
    assert got.terminal_url == "http://127.0.0.1:19001"


def test_put_is_an_upsert(store):
    asyncio.run(store.put(_record("oc-1", state=SandboxState.RUNNING)))
    updated = _record("oc-1", state=SandboxState.STOPPED, terminal_url="http://127.0.0.1:29001")
    asyncio.run(store.put(updated))
    got = asyncio.run(store.get("oc-1"))
    assert got.state is SandboxState.STOPPED
    assert got.terminal_url == "http://127.0.0.1:29001"
    assert len(asyncio.run(store.list())) == 1  # overwrote, didn't duplicate


def test_delete_removes_and_is_idempotent(store):
    asyncio.run(store.put(_record("oc-1")))
    asyncio.run(store.delete("oc-1"))
    assert asyncio.run(store.get("oc-1")) is None
    asyncio.run(store.delete("oc-1"))  # missing key → no error


def test_list_returns_all_records(store):
    asyncio.run(store.put(_record("oc-1")))
    asyncio.run(store.put(_record("oc-2")))
    ids = {s.sandbox_id for s in asyncio.run(store.list())}
    assert ids == {"oc-1", "oc-2"}


def test_get_handles_nullable_optional_fields(store):
    # A minimal record (most optionals None) round-trips without choking.
    rec = Sandbox(
        sandbox_id="bare",
        profile="openclaw",
        backend="fake",
        state=SandboxState.CREATING,
        image="reef-oc:plugin",
        volume="reef-bare",
    )
    asyncio.run(store.put(rec))
    got = asyncio.run(store.get("bare"))
    assert got == rec
    assert got.handle is None and got.created_at is None and got.terminal_url is None


# ── SQLite durability ─────────────────────────────────────────────────────────


def test_sqlite_persists_across_instances(tmp_path):
    db = str(tmp_path / "reef.db")
    rec = _record("oc-persist")
    asyncio.run(SqliteSandboxStore(db).put(rec))
    # Fresh store object, same file — the records (incl. terminal_url) survive.
    reopened = SqliteSandboxStore(db)
    got = asyncio.run(reopened.get("oc-persist"))
    assert got == rec
    assert got.terminal_url == "http://127.0.0.1:19001"


def test_sqlite_creates_parent_dir(tmp_path):
    db = tmp_path / "nested" / "dir" / "reef.db"
    asyncio.run(SqliteSandboxStore(str(db)).put(_record("oc-1")))
    assert db.exists()


def test_sqlite_reopen_migration_is_idempotent(tmp_path):
    db = str(tmp_path / "reef.db")
    asyncio.run(SqliteSandboxStore(db).put(_record("oc-1")))
    # Re-opening (re-running the migration) neither errors nor drops data.
    reopened = SqliteSandboxStore(db)
    assert asyncio.run(reopened.get("oc-1")) is not None
    with sqlite3.connect(db) as conn:
        assert conn.execute("PRAGMA user_version").fetchone()[0] == 4


# The v1 schema (pre-``color``) — used to assert the in-place v1→v2 migration.
_V1_CREATE = """
CREATE TABLE sandboxes (
    sandbox_id TEXT PRIMARY KEY, profile TEXT NOT NULL, backend TEXT NOT NULL,
    state TEXT NOT NULL, image TEXT NOT NULL, volume TEXT NOT NULL, handle TEXT,
    tenant TEXT, created_at TEXT, updated_at TEXT, port INTEGER, url TEXT,
    terminal_port INTEGER, terminal_url TEXT
)
"""


def test_sqlite_migrates_v1_db_to_v4_adding_columns(tmp_path):
    """An existing v1 DB gains every later column (color + self-healing +
    created_image_id) without losing rows, and the self-healing fields backfill
    sensibly."""
    db = str(tmp_path / "reef.db")
    with sqlite3.connect(db) as conn:
        conn.execute(_V1_CREATE)
        # A running and a stopped row, to check the desired_state backfill.
        conn.execute(
            "INSERT INTO sandboxes (sandbox_id, profile, backend, state, image, volume) "
            "VALUES ('run-1','openclaw','docker','running','reef-oc:plugin','reef-run-1')"
        )
        conn.execute(
            "INSERT INTO sandboxes (sandbox_id, profile, backend, state, image, volume) "
            "VALUES ('stop-1','openclaw','docker','stopped','reef-oc:plugin','reef-stop-1')"
        )
        conn.execute("PRAGMA user_version = 1")
        conn.commit()

    # Opening the store runs the v1→v4 migration in place.
    store = SqliteSandboxStore(db)
    run, stop = asyncio.run(store.get("run-1")), asyncio.run(store.get("stop-1"))
    assert run is not None and run.color is None  # rows preserved, color defaults null
    assert run.created_image_id is None  # legacy row has no recorded image id
    with sqlite3.connect(db) as conn:
        cols = [r[1] for r in conn.execute("PRAGMA table_info(sandboxes)")]
        assert {"color", "created_image_id", "desired_state", "restart_policy", "restart_count"} <= set(cols)
        assert conn.execute("PRAGMA user_version").fetchone()[0] == 4

    # Backfill: a running agent should stay up, a stopped one stays stopped; policy defaults.
    assert run.desired_state is DesiredState.RUNNING
    assert stop.desired_state is DesiredState.STOPPED
    assert run.restart_policy is RestartPolicy.ON_FAILURE and run.restart_count == 0

    # The new columns are writable and durable.
    run.color = "blue"
    run.restart_policy = RestartPolicy.ALWAYS
    run.created_image_id = "sha256:abc123"
    asyncio.run(store.put(run))
    reread = asyncio.run(SqliteSandboxStore(db).get("run-1"))
    assert reread.color == "blue" and reread.restart_policy is RestartPolicy.ALWAYS
    assert reread.created_image_id == "sha256:abc123"


def test_sqlite_table_holds_no_secret_columns(tmp_path):
    # The DB is secret-free by construction: no column could ever hold a
    # password/token (the access secret lives only in the container env).
    db = str(tmp_path / "reef.db")
    SqliteSandboxStore(db)
    with sqlite3.connect(db) as conn:
        cols = [row[1].lower() for row in conn.execute("PRAGMA table_info(sandboxes)")]
    forbidden = ("password", "passwd", "secret", "token", "cred")
    assert not [c for c in cols if any(bad in c for bad in forbidden)]


# ── FleetService restart reconciliation (the actual fix) ──────────────────────


def test_fleet_reconciles_managed_and_terminal_url_after_restart(tmp_path):
    """The bug this fixes: when ``reef.api`` restarts, a durable store keeps the
    record, so the agent matches the still-running container again — ``managed``
    with its ``terminal_url`` intact, not degraded to drift."""
    db = str(tmp_path / "reef.db")
    # The runtime stands in for the running containers — it SURVIVES the restart;
    # only the store is rebuilt from disk.
    rt = FakeAdminRuntime()

    # ── first boot: create + expose a SQLite-backed agent ──
    store1 = SqliteSandboxStore(db)
    svc1 = FleetService(rt, store1, manager=SandboxManager(rt, store1, backend="fake"))
    _sandbox, exp = asyncio.run(svc1.create("openclaw", name="oc-restart"))
    assert exp.terminal_url  # openclaw exposes a scoped terminal as a 2nd surface
    before = asyncio.run(svc1.get_detail("oc-restart"))
    assert before.managed is True
    assert before.access is not None and before.access.terminal_url == exp.terminal_url

    # ── restart: brand-new store on the same file (manager not needed for reads) ──
    store2 = SqliteSandboxStore(db)
    svc2 = FleetService(rt, store2)
    after = asyncio.run(svc2.get_detail("oc-restart"))
    assert after.managed is True  # ← would be False (drift) with the in-memory store
    assert after.url == exp.url
    assert after.access is not None
    assert after.access.terminal_url == exp.terminal_url  # terminal button survives


def test_fleet_without_durable_store_loses_managed_on_restart(tmp_path):
    """Contrast: the in-memory store is wiped on restart, so the same agent comes
    back as drift (``managed=False``) — the regression we're fixing."""
    rt = FakeAdminRuntime()
    store1 = InMemorySandboxStore()
    svc1 = FleetService(rt, store1, manager=SandboxManager(rt, store1, backend="fake"))
    asyncio.run(svc1.create("openclaw", name="oc-eph"))
    assert asyncio.run(svc1.get_detail("oc-eph")).managed is True

    # Restart with a fresh in-memory store (same surviving runtime) → drift.
    svc2 = FleetService(rt, InMemorySandboxStore())
    after = asyncio.run(svc2.get_detail("oc-eph"))
    assert after.managed is False
    assert after.url is None  # the stored Control-UI url is gone with the record
    # The Control UI url/password are still recoverable from the live guest env,
    # but the terminal_url was store-only — so the terminal button vanishes. That
    # lost terminal_url is exactly what the durable store above restores.
    assert after.access is not None
    assert after.access.terminal_url is None
