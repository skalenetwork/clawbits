"""The durable intake journal (extensions/hermes/inbox_state.py): admission, dispositions, the
settled prefix, deliveries and their keys, reader budget, guard, backup, migration, legacy files."""

from __future__ import annotations

import contextlib
import hashlib
import importlib
import os
import sqlite3
import stat
import sys
import time
import types
from pathlib import Path
from typing import Any

import pytest

from tests.poc.hermes_stubs import _load_hermes_module

PKG = "hermes_clawbits_test"


@pytest.fixture
def inbox(monkeypatch) -> Any:
    _load_hermes_module()
    monkeypatch.setitem(sys.modules, "hermes_cli.sqlite_util", None)
    return importlib.import_module(f"{PKG}.inbox_state")


def _open(inbox, home: Path, *, backend="https://app.x", agent="a1", profile="default"):
    return inbox.open_journal(home, backend=backend, agent_id=agent, profile=profile)


def _states(journal, source) -> dict[tuple[str, int], tuple[str, str | None]]:
    rows = journal.db.execute(
        "SELECT lane, pos, state, note FROM item WHERE source_id=?", (source.id,)
    )
    return {(lane, pos): (state, note) for lane, pos, state, note in rows}


def _posts(inbox, *positions: int, **kw: Any) -> list[Any]:
    return [inbox.NewItem(p, f"post:{p}", "live", payload={"text": f"body {p}"}, **kw)
            for p in positions]


def _mail(inbox, *uids: int) -> list[Any]:
    return [inbox.NewItem(u, f"email:7:{u}", "backlog", lane="mail", payload={"size": 10})
            for u in uids]


def _chat(inbox, journal, *positions: int, enumerated: int | None = None) -> Any:
    source = journal.create_source("chat", "c1", "", enumerated=0, note="n")
    last = enumerated if enumerated is not None else max(positions, default=0)
    return journal.admit(source, _posts(inbox, *positions), enumerated=last)


def _mailbox(inbox, journal, *uids: int, epoch: int = 7) -> Any:
    source = journal.create_source("email", "INBOX", epoch, enumerated=0, note="n")
    return journal.admit(source, _mail(inbox, *uids), enumerated=max(uids, default=0))


def _item_id(journal, source, pos: int, lane: str = "post") -> int:
    return journal.lane_item(source, lane, pos).id


def _versions(path: Path) -> dict[str, str]:
    with sqlite3.connect(path) as db:
        return dict(db.execute("SELECT key, value FROM meta"))


def _set_meta(path: Path, **values: int) -> None:
    db = sqlite3.connect(path)
    db.execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    rows = [(k, str(v)) for k, v in values.items()]
    db.executemany("INSERT OR REPLACE INTO meta VALUES (?, ?)", rows)
    db.commit()
    db.close()


# --- files, connection, namespace --------------------------------------------


def test_journal_lives_in_the_plugin_state_dir(inbox, tmp_path) -> None:
    health = sys.modules[f"{PKG}.health"]
    home = tmp_path / "home"
    assert inbox.journal_path(home) == health.state_dir(home) / "inbox.db"
    assert inbox.journal_path(home) == home / "plugin-data" / "clawbits-platform" / "inbox.db"


def test_journal_files_are_private_and_durable(inbox, tmp_path) -> None:
    old = os.umask(0o022)
    try:
        home = tmp_path / "home"
        journal = _open(inbox, home)
        _chat(inbox, journal, 1)
        path = inbox.journal_path(home)
        assert stat.S_IMODE(path.parent.stat().st_mode) == 0o700
        for name in ("inbox.db", "inbox.db-wal", "inbox.db-shm"):
            assert stat.S_IMODE((path.parent / name).stat().st_mode) == 0o600, name
        pragmas = {p: journal.db.execute(f"PRAGMA {p}").fetchone()[0]
                   for p in ("journal_mode", "synchronous", "foreign_keys")}
        assert pragmas == {"journal_mode": "wal", "synchronous": 2, "foreign_keys": 1}
        journal.close()
        assert inbox.read_stats(home)["items"] == {"pending": 1}
        assert {stat.S_IMODE(p.stat().st_mode) for p in path.parent.glob("inbox.db*")} == {0o600}
    finally:
        os.umask(old)


def test_open_uses_hermes_open_db_when_importable(inbox, tmp_path, monkeypatch) -> None:
    calls: list[dict[str, Any]] = []

    def open_db(path, **kwargs):
        calls.append(kwargs)
        db = sqlite3.connect(path, check_same_thread=kwargs["check_same_thread"])
        db.row_factory = kwargs.get("row_factory", sqlite3.Row)
        return db

    hermes_sqlite = types.SimpleNamespace(open_db=open_db)
    monkeypatch.setitem(sys.modules, "hermes_cli.sqlite_util", hermes_sqlite)
    journal = _open(inbox, tmp_path / "home")
    assert calls == [{"db_label": "clawbits inbox", "foreign_keys": True, "synchronous_full": True,
                      "check_same_thread": False}]
    assert journal.db.isolation_level is None
    assert journal.create_source("chat", "c1", "", enumerated=3, note="n").enumerated == 3


def test_namespace_survives_key_rotation_and_url_spelling(inbox, tmp_path) -> None:
    assert inbox.canonical_backend("HTTPS://user:pw@App.X:443/base/?q=1#f") == "https://app.x/base"
    assert inbox.canonical_backend("http://h:8080/") == "http://h:8080"
    assert inbox.canonical_backend("http://[::1]:80/x") == "http://[::1]/x"
    home = tmp_path / "home"
    journal = _open(inbox, home, backend="HTTPS://App.X:443/base/")
    source = journal.create_source("email", "INBOX", 7, enumerated=0, note="n")
    source = journal.admit(source, [], enumerated=40)
    journal.close()
    reopened = _open(inbox, home, backend="https://app.x/base")  # a rotated API key is not in it
    assert reopened.source("email", "INBOX") == source
    for other in ({"agent": "a2"}, {"profile": "p2"}):
        elsewhere = _open(inbox, home, backend="https://app.x/base", **other)
        assert elsewhere.source("email", "INBOX") is None


def test_profiles_have_separate_journals(inbox, tmp_path) -> None:
    first = _open(inbox, tmp_path / "default")
    second = _open(inbox, tmp_path / "profiles" / "b", profile="b")
    _chat(inbox, first, 1, 2)
    assert second.source("chat", "c1") is None
    assert second.stats()["items"] == {}
    assert first.stats()["items"] == {"pending": 2}


# --- admission ---------------------------------------------------------------


def test_admit_commits_rows_and_cursor_together(inbox, tmp_path) -> None:
    journal = _open(inbox, tmp_path / "home")
    source = journal.create_source("chat", "c1", "", enumerated=0, note="n")
    with pytest.raises(sqlite3.IntegrityError):
        broken = inbox.NewItem(2, "post:2", "live", state=None)
        journal.admit(source, [*_posts(inbox, 1), broken], enumerated=2)
    assert journal.open_count(source) == 0
    assert journal.source("chat", "c1").enumerated == 0
    source = journal.admit(source, _posts(inbox, 1, 2), enumerated=2, scan_through=9)
    assert (source.enumerated, source.scan_through, journal.open_count(source)) == (2, 9, 2)
    assert journal.admit(source, [], enumerated=1).enumerated == 2  # the cursor never moves back


def test_disk_full_during_admit_leaves_cursor_and_raises(inbox, tmp_path) -> None:
    journal = _open(inbox, tmp_path / "home")
    source = journal.create_source("email", "INBOX", 7, enumerated=0, note="n")
    pages = journal.db.execute("PRAGMA page_count").fetchone()[0]
    journal.db.execute(f"PRAGMA max_page_count={pages + 2}")
    rows = [inbox.NewItem(u, f"email:7:{u}", "backlog", lane="mail", payload={"s": "x" * 3000})
            for u in range(1, 200)]
    with pytest.raises(sqlite3.OperationalError, match="full"):
        journal.admit(source, rows, enumerated=199)
    assert not journal.db.in_transaction
    assert journal.source("email", "INBOX").enumerated == 0 and journal.open_count(source) == 0
    journal.db.execute("PRAGMA max_page_count=1073741823")
    assert journal.admit(source, rows, enumerated=199).enumerated == 199
    assert journal.open_count(source) == 199


def test_duplicate_positions_are_ignored_not_errors(inbox, tmp_path) -> None:
    journal = _open(inbox, tmp_path / "home")
    source = _chat(inbox, journal, 5)
    journal.admit(source, [inbox.NewItem(5, "post:5", "backlog", payload={"t": 1})], enumerated=5)
    journal.admit(source, [inbox.NewItem(5, "post:5", "attention", lane="attention")], enumerated=5)
    assert _states(journal, source) == \
        {("post", 5): ("pending", None), ("attention", 5): ("pending", None)}
    assert journal.lane_item(source, "post", 5).payload == {"text": "body 5"}
    assert journal.lane_item(source, "post", 6) is None


def test_due_orders_by_position_and_honours_backoff(inbox, tmp_path) -> None:
    journal = _open(inbox, tmp_path / "home")
    source = _chat(inbox, journal, 3, 1, 2)
    journal.admit(source, [inbox.NewItem(2, "post:2", "attention", lane="attention"),
                           inbox.NewItem(4, "post:4", "live", state="ignored", note="own")],
                  enumerated=4)
    journal.retry_later([_item_id(journal, source, 1)], "dispatch_error", 60)
    now = time.time()
    assert [(i.lane, i.pos) for i in journal.due(source, 10)] == \
        [("post", 2), ("attention", 2), ("post", 3)]
    assert [i.pos for i in journal.due(source, 10, now=now + 61)] == [1, 2, 2, 3]
    assert [i.pos for i in journal.due(source, 2, lane="post", now=now + 61)] == [1, 2]
    retried = journal.due(source, 1, now=now + 61)[0]
    assert (retried.state, retried.note, retried.attempts) == ("retry_wait", "dispatch_error", 1)
    assert retried.not_before > now
    assert [i.pos for i in journal.posts_between(source, 1, 4)] == [2, 3, 4]
    assert journal.open_count(source) == 4


# --- dispositions ------------------------------------------------------------


def test_settled_prefix_stops_at_earliest_open_item(inbox, tmp_path) -> None:
    journal = _open(inbox, tmp_path / "home")
    source = _chat(inbox, journal, 1, 2, 3, 4)
    attention = inbox.NewItem(4, "post:4", "attention", lane="attention")
    source = journal.admit(source, [attention], enumerated=4)
    ids = {p: _item_id(journal, source, p) for p in (1, 2, 3, 4)}
    journal.claim([ids[1], ids[2], ids[3], ids[4]], "boot:1")
    journal.finish([ids[1], ids[3], ids[4]], "processed", "triggered")
    journal.finish([ids[2]], "needs_review", "turn_failed")
    assert journal.settle(source).settled == 1  # a later success never hides the earlier failure
    journal.review(ids[2], "dismiss")
    source = journal.settle(source)
    assert source.settled == 4  # the open attention item does not block
    source = journal.admit(source, _posts(inbox, 5), enumerated=5)
    assert journal.settle(source).settled == 4
    journal.set_acked(source, 4)
    journal.set_acked(source, 2)
    assert journal.source("chat", "c1").acked == 4
    source = journal.admit(source, _posts(inbox, 8), enumerated=5)  # 6 and 7 not yet admitted
    journal.finish([_item_id(journal, source, 5)], "processed", "triggered")
    assert journal.settle(source).settled == 5, "an item past the cursor never settles it"

    mail = journal.create_source("email", "INBOX", 7, enumerated=9, note="n")
    mail = journal.admit(mail, _mail(inbox, 10, 11), enumerated=11)
    journal.finish([_item_id(journal, mail, 10, "mail")], "needs_review", "reader_failed")
    journal.finish([_item_id(journal, mail, 11, "mail")], "processed", "third_party")
    assert journal.settle(mail).settled == 9


def test_finish_rejects_unknown_dispositions(inbox, tmp_path) -> None:
    journal = _open(inbox, tmp_path / "home")
    item = _item_id(journal, _chat(inbox, journal, 1), 1)
    with pytest.raises(ValueError):
        journal.finish([item], "done", "x")
    with pytest.raises(ValueError):
        journal.review(item, "delete")
    with pytest.raises(LookupError):
        journal.review(item, "retry")  # only needs_review items are reviewed


def test_final_items_are_not_reopened_or_replied_twice(inbox, tmp_path) -> None:
    journal = _open(inbox, tmp_path / "home")
    source, item = _processed_mail(inbox, journal)
    journal.reconcile(set())  # requeued while its first reader call still runs
    journal.claim([item], "boot:2")
    reply, = journal.finish([item], "processed", "owner_verified",
                            intents=[inbox.Intent("email", "A")])
    with pytest.raises(LookupError, match="already final"):
        journal.finish([item], "processed", "owner_verified", intents=[inbox.Intent("email", "B")])
    journal.finish([item], "needs_review", "late")
    journal.claim([item], "boot:3")
    done = journal.lane_item(source, "mail", 42)
    assert (done.state, done.note, done.attempts) == ("processed", "owner_verified", 2)
    assert [(d.key, d.version, d.body) for d in journal.due_deliveries(10)] == [(reply.key, 1, "A")]

    _, held = _processed_mail(inbox, journal, uid=43)
    with pytest.raises(ValueError, match="processed disposition"):  # a reply only for processed
        journal.finish([held], "needs_review", "turn_failed", intents=[inbox.Intent("email", "d")])
    assert journal.lane_item(source, "mail", 43).state == "processing"
    first, = journal.finish([held], "needs_review", "turn_failed",
                            intents=[inbox.Intent("chat", "c")])
    journal.review(held, "retry")
    journal.claim([held], "boot:4")
    answer, notice = journal.finish([held], "processed", "owner_verified",
                                    intents=[inbox.Intent("email", "B"), inbox.Intent("chat", "n")])
    assert (answer.version, answer.body, first.version, notice.version) == (1, "B", 1, 2)
    assert [d.body for d in journal.due_deliveries(10, kind="email")] == ["A", "B"]


def test_retry_later_counts_attempts_and_holds_after_max(inbox, tmp_path) -> None:
    journal = _open(inbox, tmp_path / "home")
    source = _mailbox(inbox, journal, 1, 2, 3)
    fetch, read, done = (_item_id(journal, source, u, "mail") for u in (1, 2, 3))
    for attempt in range(1, inbox.MAX_ATTEMPTS):
        journal.retry_later([fetch], "http_503", 60)
        assert journal.lane_item(source, "mail", 1).attempts == attempt
    journal.retry_later([fetch], "http_503", 60)
    held = journal.lane_item(source, "mail", 1)
    assert (held.state, held.note) == ("needs_review", "http_503")
    journal.retry_later([fetch], "budget_exhausted", 60, count_attempt=False)  # a late call
    assert journal.lane_item(source, "mail", 1) == held

    journal.claim([read], "boot:1")
    journal.retry_later([read], "budget_exhausted", 600, count_attempt=False)  # gives it back
    assert journal.lane_item(source, "mail", 2).attempts == 0
    journal.claim([read], "boot:2")
    journal.retry_later([read], "reader_error", 30)  # the claim already counted it
    item = journal.lane_item(source, "mail", 2)
    assert (item.state, item.attempts) == ("retry_wait", 1)

    journal.finish([done], "processed", "third_party")
    journal.retry_later([done], "late", 60)
    assert journal.lane_item(source, "mail", 3).state == "processed"


def test_claim_and_finish_record_message_ids_per_namespace(inbox, tmp_path) -> None:
    home = tmp_path / "home"
    journal = _open(inbox, home)
    source = _mailbox(inbox, journal, 1, 2)
    first, second = _item_id(journal, source, 1, "mail"), _item_id(journal, source, 2, "mail")
    journal.claim([first], "boot:1", {"message_id": " <m1@x> ", "subject": "s"})
    context = journal.lane_item(source, "mail", 1).context
    assert context == {"message_id": " <m1@x> ", "subject": "s"}
    assert not journal.seen_message_id("<m1@x>")  # only processed mail counts
    journal.finish([first], "processed", "owner_verified")
    journal.finish([second], "processed", "third_party", outcome={"message_id": "<m2@x>"})
    assert journal.seen_message_id("<m1@x>") and journal.seen_message_id("<m2@x>")
    assert not _open(inbox, home, agent="a2").seen_message_id("<m1@x>")


def test_reconcile_requeues_mail_and_reviews_interrupted_turns(inbox, tmp_path) -> None:
    journal = _open(inbox, tmp_path / "home")
    chat = _chat(inbox, journal, 1, 2, 3, 4)
    mail = _mailbox(inbox, journal, 10, 11)
    ids = {p: _item_id(journal, chat, p) for p in (1, 2, 3, 4)}
    journal.claim([ids[1]], "old:1")
    journal.claim([ids[2]], "boot:7")
    journal.retry_later([ids[4]], "dispatch_error", 60)
    fresh, worn = _item_id(journal, mail, 10, "mail"), _item_id(journal, mail, 11, "mail")
    journal.claim([fresh], "old:2")
    for n in range(inbox.MAX_ATTEMPTS - 1):
        journal.claim([worn], f"old:{n + 3}")
        journal.retry_later([worn], "reader_error", 0)
    journal.claim([worn], "old:9")

    assert journal.reconcile({"boot:7"}) == {"requeued": 1, "needs_review": 2, "backlog": 2}
    assert _states(journal, chat) == {
        ("post", 1): ("needs_review", "interrupted"), ("post", 2): ("processing", None),
        ("post", 3): ("pending", None), ("post", 4): ("retry_wait", "dispatch_error")}
    assert _states(journal, mail) == {("mail", 10): ("pending", "interrupted"),
                                      ("mail", 11): ("needs_review", "interrupted")}
    assert {journal.lane_item(chat, "post", p).reason for p in (3, 4)} == {"backlog"}
    journal.retry_later([ids[1]], "budget_exhausted", 0, count_attempt=False)  # its run ends late
    assert journal.lane_item(chat, "post", 1).state == "needs_review"
    assert journal.reconcile(set()) == {"requeued": 0, "needs_review": 1, "backlog": 0}


def test_retire_holds_waiting_items_and_requeue_releases_them(inbox, tmp_path) -> None:
    journal = _open(inbox, tmp_path / "home")
    old = _mailbox(inbox, journal, 1, 2, 3)
    journal.retry_later([_item_id(journal, old, 2, "mail")], "http_503", 60)
    journal.finish([_item_id(journal, old, 3, "mail")], "processed", "third_party")
    journal.retire(old, "epoch_changed")
    assert journal.source("email", "INBOX") is None
    assert {k: v[0] for k, v in _states(journal, old).items()} == \
        {("mail", 1): "needs_review", ("mail", 2): "needs_review", ("mail", 3): "processed"}
    new = journal.create_source("email", "INBOX", 8, enumerated=0, note="epoch_changed")
    assert journal.source("email", "INBOX") == new

    new = journal.admit(new, _mail(inbox, 1, 2), enumerated=2)
    unread, large = _item_id(journal, new, 1, "mail"), _item_id(journal, new, 2, "mail")
    for _ in range(3):  # the reader flaps: each hold claims the item, each release requeues it
        journal.claim([unread], "boot:1")
        journal.finish([unread], "needs_review", "reader_unavailable")
        assert journal.requeue(new, "reader_unavailable") == 1
    journal.finish([large], "needs_review", "too_large")
    assert _states(journal, new) == {("mail", 1): ("pending", "requeued"),
                                     ("mail", 2): ("needs_review", "too_large")}
    assert journal.lane_item(new, "mail", 1).attempts == 0


def test_a_returning_epoch_reactivates_its_source(inbox, tmp_path) -> None:
    journal = _open(inbox, tmp_path / "home")
    first = _mailbox(inbox, journal, 1, 2)
    journal.finish([_item_id(journal, first, 1, "mail")], "processed", "third_party")
    journal.retire(first, "epoch_changed")
    waiting = _item_id(journal, first, 2, "mail")
    with pytest.raises(LookupError, match=f"retired source {first.id}; dismiss it"):
        journal.review(waiting, "retry")  # its UID cannot be fetched in another epoch
    second = journal.create_source("email", "INBOX", 8, enumerated=0, note="epoch_changed")
    journal.retire(second, "epoch_changed")
    back = journal.create_source("email", "INBOX", 7, enumerated=0, note="epoch_changed")
    assert (back.id, back.state, back.note, back.enumerated) == \
        (first.id, "active", "epoch_changed", 2)
    assert journal.source("email", "INBOX") == back
    back = journal.admit(back, _mail(inbox, 1, 2, 3), enumerated=3)
    assert _states(journal, back) == {("mail", 1): ("processed", "third_party"),
                                      ("mail", 2): ("needs_review", "epoch_changed"),
                                      ("mail", 3): ("pending", None)}
    journal.review(waiting, "retry")
    assert journal.create_source("email", "INBOX", 7, enumerated=50, note="x") == back  # live


def test_resolving_a_held_source_never_settles_past_open_items(inbox, tmp_path) -> None:
    home = tmp_path / "home"
    journal = _open(inbox, home)
    source = _chat(inbox, journal, *range(1, 11))
    ids = {p: _item_id(journal, source, p) for p in range(1, 11)}
    journal.finish([ids[p] for p in range(1, 6)], "processed", "triggered")
    journal.finish([ids[6]], "needs_review", "turn_failed")
    assert journal.settle(source).settled == 5
    journal.move_legacy("chat")
    (home / inbox.LEGACY_FILES["chat"]).write_text("{}")  # a pre-journal plugin ran
    assert journal.hold_legacy() == 1
    held = journal.source("chat", "c1")
    source = journal.update_source(held, state="active", note="migrated:new_only", enumerated=150)
    assert (source.enumerated, source.settled) == (150, 5)
    journal.review(ids[6], "dismiss")
    journal.finish([ids[p] for p in range(7, 11)], "processed", "triggered")
    assert journal.settle(source).settled == 150


def test_update_source_moves_cursor_forward_or_sets_a_held_start(inbox, tmp_path) -> None:
    journal = _open(inbox, tmp_path / "home")
    active = journal.create_source("chat", "c1", "", enumerated=10, note="server_pointer")
    assert journal.update_source(active, enumerated=5).enumerated == 10
    active = journal.update_source(active, enumerated=15, note="adopted")
    assert (active.enumerated, active.settled, active.note, active.state) == \
        (15, 10, "adopted", "active")
    held = journal.create_source("email", "INBOX", 7, enumerated=10, note="legacy:review",
                                 state="migration_needs_review")
    held = journal.update_source(held, state="active", note="migrated:from_uid", enumerated=3)
    assert (held.state, held.enumerated, held.settled) == ("active", 3, 3)


# --- deliveries ----------------------------------------------------------------


def _processed_mail(inbox, journal, uid: int = 42, epoch: int = 7) -> tuple[Any, int]:
    source = journal.source("email", "INBOX")
    source = source or journal.create_source("email", "INBOX", epoch, enumerated=0, note="n")
    source = journal.admit(source, _mail(inbox, uid), enumerated=uid)
    item = _item_id(journal, source, uid, "mail")
    journal.claim([item], "boot:1")
    return source, item


def test_delivery_keys_derive_from_identity_not_body(inbox, tmp_path) -> None:
    journal = _open(inbox, tmp_path / "one")
    _, item = _processed_mail(inbox, journal)
    reply, artifact = journal.finish([item], "processed", "owner_verified", intents=[
        inbox.Intent("email", "first body", subject="Re: hi", headers={"In-Reply-To": "<m@x>"}),
        inbox.Intent("chat", "artifact", target="c1")])
    digest = hashlib.sha256(b"https://app.x|a1|default|email|INBOX|7|42|1").hexdigest()[:40]
    assert (reply.key, artifact.key) == (f"cbr1-{digest}", f"cbc1-{digest}")
    assert (reply.state, reply.version, reply.headers, reply.subject) == \
        ("local", 1, {"In-Reply-To": "<m@x>"}, "Re: hi")
    assert (artifact.kind, artifact.target, artifact.body) == ("chat", "c1", "artifact")

    rebuilt = _open(inbox, tmp_path / "two", backend="https://App.X/")  # a lost, rebuilt journal
    _, item = _processed_mail(inbox, rebuilt)
    same, = rebuilt.finish([item], "processed", "owner_verified",
                           intents=[inbox.Intent("email", "other")])
    assert same.key == reply.key and "body" not in same.key

    newer = _open(inbox, tmp_path / "three")
    _, item = _processed_mail(inbox, newer, epoch=8)
    moved, second, third = newer.finish([item], "processed", "x", intents=[
        inbox.Intent("email", "b"), inbox.Intent("chat", "a"), inbox.Intent("chat", "notice")])
    assert moved.key != reply.key
    assert (second.version, third.version) == (1, 2) and second.key != third.key
    _, item = _processed_mail(inbox, newer, uid=43)
    bumped, = newer.finish([item], "processed", "x",
                           intents=[inbox.Intent("email", "b", version=2)])
    assert bumped.version == 2


def test_finish_with_intents_is_atomic(inbox, tmp_path) -> None:
    journal = _open(inbox, tmp_path / "home")
    source, item = _processed_mail(inbox, journal)
    with pytest.raises(ValueError):
        journal.finish([item], "processed", "x",
                       intents=[inbox.Intent("email", "b"), inbox.Intent("fax", "b")])
    assert journal.lane_item(source, "mail", 42).state == "processing"
    assert journal.due_deliveries(10) == []
    with pytest.raises(ValueError):
        journal.finish([item, item + 1], "processed", "x", intents=[inbox.Intent("email", "b")])


def test_delivery_states_backoff_and_operator_resend(inbox, tmp_path) -> None:
    home = tmp_path / "home"
    journal = _open(inbox, home)
    _, item = _processed_mail(inbox, journal)
    reply, notice = journal.finish([item], "processed", "owner_verified",
                                   intents=[inbox.Intent("email", "r"), inbox.Intent("chat", "n")])
    assert [d.key for d in journal.due_deliveries(10, kind="email")] == [reply.key]
    assert [d.key for d in journal.due_deliveries(10)] == [reply.key, notice.key]
    assert _open(inbox, home, agent="a2").due_deliveries(10) == []
    journal.update_delivery(reply.key, "posting")
    journal.update_delivery(reply.key, "retry_wait", remote_id="d1", note="http_503", delay=60)
    now = time.time()
    assert [d.key for d in journal.due_deliveries(10, kind="email")] == []
    waiting, = journal.due_deliveries(10, kind="email", now=now + 61)
    assert (waiting.state, waiting.remote_id, waiting.note, waiting.attempts) == \
        ("retry_wait", "d1", "http_503", 1)
    journal.update_delivery(reply.key, "accepted")
    journal.update_delivery(notice.key, "unknown", note="ambiguous")
    assert journal.due_deliveries(10, now=now + 61) == []
    with pytest.raises(ValueError):
        journal.update_delivery(reply.key, "sent")
    with pytest.raises(LookupError):
        journal.update_delivery("cbr1-missing", "accepted")

    again = journal.resend(notice.key)
    assert (again.state, again.version, again.body) == ("local", 2, "n")
    assert again.key.startswith("cbc1-")
    assert again.key != notice.key
    with pytest.raises(LookupError):
        journal.resend(notice.key)
    with pytest.raises(LookupError):
        journal.resend(reply.key)
    assert journal.stats()["replies"] == {"accepted": 1, "local": 1}


def test_tool_sends_are_persisted_before_the_post(inbox, tmp_path) -> None:
    journal = _open(inbox, tmp_path / "home")
    sent = journal.record_tool_send("cbt1-abc", "Hello", "Body")
    assert (sent.state, sent.attempts, sent.item_id, sent.subject) == ("posting", 1, None, "Hello")
    assert journal.record_tool_send("cbt1-abc", "Hello", "Body") == sent
    assert journal.due_deliveries(10) == []
    later = time.time() + inbox.TOOL_SEND_GRACE_S + 1
    assert [d.key for d in journal.due_deliveries(10, now=later)] == ["cbt1-abc"]
    journal.update_delivery("cbt1-abc", "failed", note="idempotency_key_reused")
    again = journal.resend("cbt1-abc")
    assert again.key.startswith("cbt1-") and again.key != "cbt1-abc" and again.version == 2
    journal.update_delivery(again.key, "unknown")
    journal.dismiss_delivery(again.key)
    with pytest.raises(LookupError):
        journal.dismiss_delivery(again.key)
    assert journal.stats()["replies"] == {}


# --- reader budget -------------------------------------------------------------


def test_reader_usage_counts_the_mailbox_across_epochs(inbox, tmp_path) -> None:
    journal = _open(inbox, tmp_path / "home")
    now = time.time()
    old = journal.create_source("email", "INBOX", 7, enumerated=0, note="n")
    journal.record_reader_call(old, tokens=100, at=now - 7200)
    journal.record_reader_call(old, tokens=200, at=now - 60)
    journal.retire(old, "epoch_changed")
    new = journal.create_source("email", "INBOX", 8, enumerated=0, note="n")
    journal.record_reader_call(new, tokens=300, at=now - 10)
    other = journal.create_source("email", "OTHER", 1, enumerated=0, note="n")
    journal.record_reader_call(other, tokens=999, at=now)
    assert journal.reader_usage(new, since=now - 3600) == (500, 2)
    assert journal.reader_usage(new, since=now - 86400) == (600, 3)
    assert journal.reader_usage(other, since=now - 86400) == (999, 1)
    journal.prune(drop_s=3600)
    assert journal.reader_usage(new, since=0) == (500, 2)


# --- retention -------------------------------------------------------------------


def test_prune_keeps_dispositions_drops_content(inbox, tmp_path) -> None:
    journal = _open(inbox, tmp_path / "home")
    chat = _chat(inbox, journal, 1, 2, 3)
    journal.claim([_item_id(journal, chat, 1)], "boot:1", {"draft": "secret draft"})
    journal.finish([_item_id(journal, chat, 1)], "processed", "triggered")
    journal.finish([_item_id(journal, chat, 2)], "processed", "summarized",
                   intents=[inbox.Intent("chat", "posted text")])
    source, mail = _processed_mail(inbox, journal)
    sent, = journal.finish([mail], "processed", "owner_verified", outcome={"summary": "summary"},
                           intents=[inbox.Intent("email", "reply text", subject="Re: s")])
    journal.update_delivery(sent.key, "accepted")
    _, other = _processed_mail(inbox, journal, uid=43)
    dismissed, = journal.finish([other], "processed", "owner_verified",
                                intents=[inbox.Intent("email", "failed reply", subject="Re: t")])
    journal.update_delivery(dismissed.key, "failed", note="http_422")
    journal.dismiss_delivery(dismissed.key)
    chat = journal.settle(chat)

    journal.prune(retain_s=-1)
    done = journal.lane_item(chat, "post", 1)
    assert (done.state, done.note, done.payload, done.context) == \
        ("processed", "triggered", {}, None)
    assert journal.lane_item(chat, "post", 3).payload == {"text": "body 3"}
    assert journal.db.execute("SELECT outcome FROM item WHERE id=?", (mail,)).fetchone()[0] is None
    blanked = journal.db.execute("SELECT subject, body, headers FROM delivery WHERE key IN (?, ?)",
                                 (sent.key, dismissed.key)).fetchall()
    assert [tuple(row) for row in blanked] == [(None, "", "{}")] * 2
    assert journal.due_deliveries(10)[0].body == "posted text"  # unsent content stays

    journal.prune(retain_s=-1, drop_s=-1)
    assert set(_states(journal, chat)) == {("post", 2), ("post", 3)}  # 2 is kept for its delivery
    assert journal.lane_item(source, "mail", 42).state == "processed"  # kept for Message-ID dedupe


# --- guard, backup, migration ------------------------------------------------------


def test_corrupt_journal_is_refused_and_preserved(inbox, tmp_path) -> None:
    home = tmp_path / "home"
    path = inbox.journal_path(home)
    path.parent.mkdir(parents=True)
    path.write_bytes(b"not a database" * 100)
    with pytest.raises(sqlite3.DatabaseError):
        _open(inbox, home)
    with pytest.raises(sqlite3.DatabaseError):
        inbox.read_stats(home)
    assert path.read_bytes() == b"not a database" * 100


def test_guard_refuses_newer_min_reader_before_any_ddl(inbox, tmp_path) -> None:
    home = tmp_path / "home"
    _open(inbox, home).close()
    path = inbox.journal_path(home)
    newer = inbox.SCHEMA_VERSION + 1
    _set_meta(path, schema=newer, min_reader=newer)
    before = path.read_bytes()
    with pytest.raises(inbox.JournalTooNew):
        _open(inbox, home)
    assert path.read_bytes() == before
    assert inbox.read_stats(home) == {"schema": newer, "min_reader": newer, "supported": False}
    assert list((path.parent).glob("backups")) == []

    _set_meta(path, schema=newer, min_reader=inbox.SCHEMA_VERSION)  # newer but readable
    journal = _open(inbox, home)
    assert journal.stats()["schema"] == newer
    assert journal.get_meta("min_reader") == str(inbox.SCHEMA_VERSION)


def test_guard_rechecks_under_the_write_lock(inbox, tmp_path, monkeypatch) -> None:
    home = tmp_path / "home"
    path = inbox.journal_path(home)
    newer = inbox.SCHEMA_VERSION + 1
    connect = inbox._connect

    def racing_connect(target: Path) -> sqlite3.Connection:
        _set_meta(target, schema=newer, min_reader=newer)  # a newer plugin wins the race
        return connect(target)

    monkeypatch.setattr(inbox, "_connect", racing_connect)
    with pytest.raises(inbox.JournalTooNew):
        _open(inbox, home)  # no file at the probe
    assert _versions(path) == {"schema": str(newer), "min_reader": str(newer)}
    with contextlib.closing(sqlite3.connect(path)) as db:
        assert [r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")] == \
            ["meta"]

    monkeypatch.setattr(inbox, "_connect", connect)
    cli_home = tmp_path / "cli"
    _open(inbox, cli_home).close()
    monkeypatch.setattr(inbox, "_connect", racing_connect)
    with pytest.raises(inbox.JournalTooNew):
        inbox._open(cli_home, ("", "", ""), migrate=False)  # the operator CLI's open


def test_migration_backs_up_first_and_is_atomic(inbox, tmp_path, monkeypatch) -> None:
    home = tmp_path / "home"
    journal = _open(inbox, home)
    journal.create_source("chat", "c1", "", enumerated=5, note="n")
    journal.close()
    path = inbox.journal_path(home)
    with sqlite3.connect(path) as db:
        before = list(db.iterdump())
    runs: list[int] = []

    def add_column(db: sqlite3.Connection) -> None:
        db.execute("ALTER TABLE item ADD COLUMN extra TEXT")
        runs.append(1)
        if len(runs) == 1:
            raise RuntimeError("interrupted")

    monkeypatch.setattr(inbox, "SCHEMA_VERSION", 2)
    monkeypatch.setattr(inbox, "MIN_READER", 2)
    monkeypatch.setitem(inbox.MIGRATIONS, 1, add_column)
    with pytest.raises(inbox.JournalMigrationError) as failed:
        _open(inbox, home)
    assert failed.value.code == "journal_migration_failed"
    assert _versions(path) == {"schema": "1", "min_reader": "1"}
    with sqlite3.connect(path) as db:
        assert "extra" not in [c[1] for c in db.execute("PRAGMA table_info(item)")]
        assert db.execute("SELECT enumerated FROM source").fetchone() == (5,)
    backups = path.parent / "backups"
    first, = backups.glob("inbox.v1.*.db")
    assert stat.S_IMODE(first.stat().st_mode) == 0o600
    with sqlite3.connect(first) as db:
        assert list(db.iterdump()) == before

    journal = _open(inbox, home)  # the next open retries
    assert _versions(path) == {"schema": "2", "min_reader": "2"}
    assert journal.source("chat", "c1").enumerated == 5
    journal.close()
    for version in (2, 3, 4):
        monkeypatch.setattr(inbox, "SCHEMA_VERSION", version + 1)
        monkeypatch.setitem(inbox.MIGRATIONS, version, lambda db: None)
        _open(inbox, home).close()
    assert sorted(p.name.split(".")[1] for p in backups.glob("*.db")) == ["v2", "v3", "v4"]


def test_backup_failure_holds_without_migrating(inbox, tmp_path, monkeypatch) -> None:
    home = tmp_path / "home"
    _open(inbox, home).close()
    path = inbox.journal_path(home)
    (path.parent / "backups").write_text("not a directory")
    monkeypatch.setattr(inbox, "SCHEMA_VERSION", 2)
    monkeypatch.setitem(inbox.MIGRATIONS, 1, lambda db: db.execute("ALTER TABLE item ADD x TEXT"))
    with pytest.raises(inbox.JournalMigrationError) as failed:
        _open(inbox, home)
    assert failed.value.code == "journal_backup_failed"
    assert _versions(path)["schema"] == "1"


# --- legacy files ----------------------------------------------------------------


def test_legacy_files_moved_aside_after_adoption(inbox, tmp_path) -> None:
    cursors = importlib.import_module(f"{PKG}.read_cursors")
    email = importlib.import_module(f"{PKG}.email_integration")
    assert inbox.LEGACY_FILES == \
        {"chat": cursors.READ_CURSOR_FILE, "email": email.EMAIL_WATERMARK_FILE}
    home = tmp_path / "home"
    home.mkdir()
    for name in inbox.LEGACY_FILES.values():
        (home / name).write_text('{"last_uid": 10}')
    assert set(inbox.legacy_present(home)) == {"chat", "email"}
    journal = _open(inbox, home)
    held = journal.create_source("email", "INBOX", 7, enumerated=10, note="legacy:review",
                                 state="migration_needs_review")
    journal.create_source("chat", "c1", "", enumerated=3, note="server_pointer")
    assert journal.hold_legacy() == 0  # files the upgrade found are not a pre-journal plugin run

    moved = journal.move_legacy("chat")
    legacy = inbox.journal_path(home).parent / "legacy"
    assert moved == legacy / "clawbits-read-cursors.json"
    assert stat.S_IMODE(moved.stat().st_mode) == 0o600
    assert set(inbox.legacy_present(home)) == {"email"}
    assert journal.move_legacy("chat") is None
    assert journal.hold_legacy() == 0

    (home / "clawbits-read-cursors.json").write_text('{"c1": 9}')  # a pre-journal plugin ran again
    assert journal.hold_legacy() == 1
    chat = journal.source("chat", "c1")
    assert (chat.state, chat.note) == ("migration_needs_review", "legacy_reappeared")
    assert inbox.read_stats(home)["sources_needing_review"] == \
        [f"email:{held.id}", f"chat:{chat.id}"]
    again = journal.move_legacy("chat")
    assert again != moved
    assert (moved.read_text(), again.read_text()) == ('{"last_uid": 10}', '{"c1": 9}')
    assert not (home / "clawbits-read-cursors.json").exists()

    fresh = _open(inbox, tmp_path / "fresh")  # nothing to move: the adoption is still recorded
    mail = fresh.create_source("email", "INBOX", 7, enumerated=0, note="first_start:new_only")
    assert fresh.move_legacy("email") is None
    (tmp_path / "fresh" / "clawbits-email-watermark.json").write_text('{"last_uid": 3}')
    assert fresh.hold_legacy() == 1
    assert fresh.source("email", "INBOX").id == mail.id
    assert fresh.source("email", "INBOX").note == "legacy_reappeared"


# --- read-only report ------------------------------------------------------------


def test_read_stats_is_read_only_and_feeds_doctor(inbox, tmp_path) -> None:
    home = tmp_path / "home"
    assert inbox.read_stats(home) is None
    inbox.journal_path(home).parent.mkdir(parents=True)
    inbox.journal_path(home).touch()
    assert inbox.read_stats(home) is None

    journal = _open(inbox, home)
    chat = _chat(inbox, journal, 1, 2, 3, 4, 5)
    failed = [_item_id(journal, chat, 1), _item_id(journal, chat, 2)]
    journal.finish(failed, "needs_review", "interrupted")
    held = journal.create_source("email", "INBOX", 7, enumerated=0, note="legacy:review",
                                 state="migration_needs_review")
    _, item = _processed_mail(inbox, journal)
    notice, = journal.finish([item], "processed", "x", intents=[inbox.Intent("chat", "n")])
    journal.update_delivery(notice.key, "unknown")
    journal.set_meta("idempotent_send", "1")
    journal.close()

    path = inbox.journal_path(home)
    before = (path.read_bytes(), path.stat().st_mtime_ns)
    stats = inbox.read_stats(home)
    assert (path.read_bytes(), path.stat().st_mtime_ns) == before
    assert stats["items"] == {"needs_review": 2, "pending": 3, "processed": 1}
    assert stats["review_reasons"] == {"interrupted": 2}
    assert stats["replies"] == {"unknown": 1}
    assert stats["sources_needing_review"] == [f"email:{held.id}"]
    assert stats["stalled"] == 0 and stats["oldest_open_age_s"] >= 0
    assert (stats["schema"], stats["min_reader"], stats["supported"]) == (1, 1, True)

    doctor = importlib.import_module(f"{PKG}.doctor")
    checks = {c.name: c for c in doctor.queue_checks(home)}
    assert checks["queue"].level == "fail"
    assert checks["queue"].detail.startswith("needs_review 2, pending 3, oldest open")
    assert checks["queue"].detail.endswith("1 source(s) need migration review")
    assert (checks["outbox"].level, checks["outbox"].detail) == ("fail", "unknown 1")
