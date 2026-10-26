"""A game's own Hermes sessions: find them, size them, and delete them whole (decision 18).

A game's moves run in the synthetic chat ``widget-<id>`` (:mod:`.widgets`); once its history grows
past a bound, the next move starts a fresh generation ``widget-<id>.g<n>`` and the old one is deleted
(a cost bound: Hermes compresses inside a session's own lineage and a game's run has no memory or
skill tools, so the hand never leaves it either way). When the game ends, every generation goes.

Hermes keeps a session in these places, and deletion clears each, feature-detected per revision:
- ``state.db``: the ``sessions`` rows of the whole lineage (compression children carry the same
  chat id and key), their ``messages``, the FTS tables kept in sync by Hermes's own delete triggers,
  and unreferenced ``system_prompts``: ``SessionDB.delete_sessions`` with ``sessions_dir``, which
  also removes ``sessions/<id>.json(l)`` and ``request_dump_<id>_*.json`` (in the profile's own
  home, and in the session store's directory when that differs); from Hermes 7cc3fb8 with
  ``exclude_active_write_guards`` (a row a turn still holds is skipped: "busy");
- the delivery ledger (``delivery_obligations``): a move that ended in text rather than NO_REPLY,
  with streaming off, left that text there, kept 7 days after delivery; every row of the game's
  session keys goes;
- the routing index (``SessionStore._entries``, mirrored to ``gateway_routing`` and sessions.json):
  ``remove_by_session_id`` where Hermes has it (7cc3fb8), else the ``_entries.pop`` + ``_save``
  that ``prune_old_entries`` uses at every revision. A routing entry left behind would hand the
  deleted id to the next message on the key and recreate its row (#42422), so a deleted game's key
  is never used again;
- the runner's cached agent, which holds the history in memory: ``_evict_cached_agent``.
Nothing is deleted while a turn runs on a key (the adapter's session guard, the runner's running
slot). SQLite keeps freed pages until they are reused or vacuumed.

Reads go straight to ``state.db``, read-only; every write goes through Hermes's own objects,
but for the transcript files in a second directory, removed the way Hermes removes them.
"""

from __future__ import annotations

import contextlib
import inspect
import logging
import sqlite3
from collections.abc import Callable, Iterable
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_GAME_ROWS = (
    "SELECT id, chat_id, session_key, parent_session_id FROM sessions "
    "WHERE source = 'clawbits' AND chat_id LIKE 'widget-%'"
)


def _parse(chat_id: Any) -> tuple[str, int] | None:
    from .widgets import parse_game_chat

    return parse_game_chat(chat_id)


def _connect(home: Path) -> sqlite3.Connection | None:
    """``state.db`` read-only; None when there is none yet."""
    path = Path(home) / "state.db"
    if not path.exists():
        return None
    return sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=5)


def _game_rows(home: Path) -> list[tuple[str, str, str | None, str | None]]:
    """Every game session row: (id, chat_id, session_key, parent_session_id)."""
    conn = _connect(home)
    if conn is None:
        return []
    with contextlib.closing(conn):
        rows = conn.execute(_GAME_ROWS).fetchall()
    return [row for row in rows if _parse(row[1]) is not None]


def game_session_ids(home: Path) -> set[str] | None:
    """Ids of every game session in ``home``'s ``state.db``; None when it can't be read."""
    try:
        return {row[0] for row in _game_rows(home)}
    except sqlite3.Error:
        return None


def _remove_session_files(directory: Path, session_id: str) -> None:
    """What ``SessionDB._remove_session_files`` removes, in one more directory."""
    targets = [directory / f"{session_id}{suffix}" for suffix in (".json", ".jsonl")]
    with contextlib.suppress(OSError):
        targets.extend(directory.glob(f"request_dump_{session_id}_*.json"))
    for path in targets:
        with contextlib.suppress(OSError):
            path.unlink(missing_ok=True)


def _key_chat(session_key: str) -> str | None:
    """The chat a Clawbits DM key names (``<ns>:clawbits:dm:<chat>``)."""
    head, sep, chat = session_key.rpartition(":clawbits:dm:")
    return chat if sep and head and ":" not in chat else None


class GameSessions:
    """The game sessions of one profile: ``home`` holds its ``state.db``; ``adapter`` is the running
    Clawbits adapter, whose session store and runner Hermes wires in (``set_session_store``,
    ``gateway_runner``)."""

    def __init__(self, home: Path, adapter: Any) -> None:
        self.home = Path(home)
        self._adapter = adapter

    @property
    def _store(self) -> Any:
        return getattr(self._adapter, "_session_store", None)

    @property
    def _runner(self) -> Any:
        return getattr(self._adapter, "gateway_runner", None)

    def _ours(self, key: str) -> bool:
        """Whether a key is this profile's: a multiplexed gateway's one store holds every profile's."""
        key_of = getattr(self._adapter, "_game_key", None)
        if not callable(key_of):
            return True
        return key.rpartition(":clawbits:dm:")[0] == key_of("widget-0").rpartition(":clawbits:dm:")[0]

    def routes(self) -> list[tuple[str, str | None, str]]:
        """This profile's routing entries of game chats: (session key, session id, chat id)."""
        store = self._store
        if store is None:
            return []
        try:
            entries = store.list_sessions()
        except Exception:
            entries = list((getattr(store, "_entries", None) or {}).values())
        out = []
        for entry in entries:
            key = str(getattr(entry, "session_key", "") or "")
            chat = getattr(getattr(entry, "origin", None), "chat_id", None) or _key_chat(key)
            if key and _parse(chat) is not None and ":clawbits:" in key and self._ours(key):
                out.append((key, getattr(entry, "session_id", None), str(chat)))
        return out

    def games(self) -> dict[str, set[int]]:
        """Each game with a session here, and its generations."""
        games: dict[str, set[int]] = {}
        chats = [chat for _, _, chat in self.routes()]
        with contextlib.suppress(sqlite3.Error):
            chats += [row[1] for row in _game_rows(self.home)]
        for chat in chats:
            if (game := _parse(chat)) is not None:
                games.setdefault(game[0], set()).add(game[1])
        return games

    def size(self, chat_id: str) -> tuple[int, int]:
        """(messages, characters) a game chat's sessions hold, archived compression rows included."""
        try:
            conn = _connect(self.home)
            if conn is None:
                return 0, 0
            with contextlib.closing(conn):
                count, chars = conn.execute(
                    "SELECT COUNT(m.id), COALESCE(SUM(LENGTH(m.content)), 0) FROM messages m "
                    "JOIN sessions s ON s.id = m.session_id WHERE s.source = 'clawbits' AND s.chat_id = ?",
                    (chat_id,),
                ).fetchone()
            return int(count or 0), int(chars or 0)
        except sqlite3.Error:
            return 0, 0

    def delete(
        self, widget_id: str, gens: Iterable[int] | None, busy: Callable[[str], bool]
    ) -> str:
        """Delete a game's sessions, every generation or only ``gens``: "deleted", "none" (it has
        none here), "busy" (a turn still runs on one; try again) or "kept" (Hermes refused)."""
        wanted = None if gens is None else set(gens)

        def ours(chat: Any) -> bool:
            game = _parse(chat)
            return game is not None and game[0].lower() == widget_id.lower() and (
                wanted is None or game[1] in wanted)

        routes = [route for route in self.routes() if ours(route[2])]
        try:
            rows = _game_rows(self.home)
        except sqlite3.Error:
            logger.warning("clawbits: game %s sessions not read; kept for the sweep", widget_id)
            return "kept"
        mine = [row for row in rows if ours(row[1])]
        ids = {row[0] for row in mine} | {sid for _, sid, _ in routes if sid}
        # Anything branched off them goes too (compression children carry the chat id already).
        while True:
            more = {row[0] for row in rows if row[3] in ids} - ids
            if not more:
                break
            ids |= more
        keys = {key for key, _, _ in routes} | {row[2] for row in mine if row[2]}
        if not ids and not keys:
            return "none"
        if any(busy(key) for key in keys):
            return "busy"
        runner = self._runner
        evict = getattr(runner, "_evict_cached_agent", None)
        for key in keys:
            if callable(evict):
                with contextlib.suppress(Exception):
                    evict(key)
        if ids:
            outcome = self._delete_rows(sorted(ids), next(iter(keys), None))
            if outcome != "deleted":
                return outcome
        self._drop_ledger(keys)
        self._drop_routes(keys, {sid for _, sid, _ in routes if sid} | ids)
        logger.info("clawbits: deleted %d session(s) of game %s", len(ids), widget_id)
        return "deleted"

    def _session_db(self, key: str | None) -> Any:
        store = self._store
        for_key = getattr(store, "_db_for_key", None)
        if callable(for_key):
            with contextlib.suppress(Exception):
                if (db := for_key(key)) is not None:
                    return db
        if (db := getattr(store, "_db", None)) is not None:
            return db
        from hermes_state import SessionDB

        return SessionDB(db_path=self.home / "state.db")

    def _sessions_dirs(self) -> list[Path]:
        """Where Hermes keeps a game's transcript files: the profile's own ``<home>/sessions`` (a
        turn's request dumps and diverted JSONL, ``get_hermes_home()``), then the session store's
        directory when it differs (a multiplexed gateway's one store is the launch profile's, and
        ``gateway.sessions_dir`` moves the launch profile's transcripts)."""
        dirs = [self.home / "sessions"]
        configured = getattr(self._store, "sessions_dir", None) or getattr(
            getattr(self._runner, "config", None), "sessions_dir", None)
        if configured and Path(configured) != dirs[0]:
            dirs.append(Path(configured))
        return dirs

    def _delete_rows(self, ids: list[str], key: str | None) -> str:
        own, *others = self._sessions_dirs()
        try:
            db = self._session_db(key)
            params = inspect.signature(db.delete_sessions).parameters
            kwargs: dict[str, Any] = {"sessions_dir": own}
            skipped: list[str] = []
            if "exclude_active_write_guards" in params:  # Hermes 7cc3fb8+
                kwargs["exclude_active_write_guards"] = True
                if "skipped_ids" in params:
                    kwargs["skipped_ids"] = skipped
            db.delete_sessions(ids, **kwargs)
        except Exception:
            logger.warning("clawbits: game sessions not deleted; kept for the sweep", exc_info=True)
            return "kept"
        for directory in others:
            for sid in set(ids) - set(skipped):
                _remove_session_files(directory, sid)
        return "busy" if skipped else "deleted"

    def _drop_ledger(self, keys: set[str]) -> None:
        """A move's final text in Hermes's delivery ledger (``delivery_obligations``, kept 7 days
        once delivered): every row of the game's session keys, through the ledger's own store."""
        if not keys:
            return
        try:
            from gateway.delivery_ledger import _DB_LOCK, _transaction
        except ImportError:
            return
        try:
            with _DB_LOCK, _transaction() as conn:
                conn.executemany(
                    "DELETE FROM delivery_obligations WHERE session_key = ?", [(key,) for key in sorted(keys)]
                )
        except Exception:
            logger.warning("clawbits: game delivery ledger rows not dropped", exc_info=True)

    def _drop_routes(self, keys: set[str], session_ids: set[str]) -> None:
        store = self._store
        if store is None:
            return
        remove = getattr(store, "remove_by_session_id", None)
        if callable(remove):
            for sid in session_ids:
                with contextlib.suppress(Exception):
                    remove(sid)
        entries, lock, save = (getattr(store, name, None) for name in ("_entries", "_lock", "_save"))
        if entries is None or lock is None or not callable(save):
            return
        try:
            with lock:
                ensure = getattr(store, "_ensure_loaded_locked", None)
                if callable(ensure):
                    ensure()
                dropped = [key for key in keys if entries.pop(key, None) is not None]
                if dropped:
                    save()
        except Exception:
            logger.warning("clawbits: game routing entries not dropped", exc_info=True)
