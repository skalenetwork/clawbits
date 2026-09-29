"""``hermes clawbits inbox status|retry|dismiss|migrate|resend`` through the signup CLI wiring."""

from __future__ import annotations

import argparse
import importlib
import os
import sqlite3
import sys
from pathlib import Path
from typing import Any

import pytest

from tests.poc.hermes_stubs import _load_hermes_module

PKG = "hermes_clawbits_test"
SECRET = "SECRET-MAIL-CONTENT"


@pytest.fixture
def plugin(monkeypatch) -> Any:
    _load_hermes_module()
    monkeypatch.setitem(sys.modules, "hermes_cli.sqlite_util", None)
    importlib.import_module(f"{PKG}.inbox_state")
    return sys.modules[PKG]


@pytest.fixture
def home() -> Path:
    return Path(os.environ["HERMES_HOME"])


def _cli(plugin, *argv: str) -> int:
    parser = argparse.ArgumentParser(prog="hermes clawbits")
    plugin.signup._setup_cli(parser)
    args = parser.parse_args(list(argv))
    return args.func(args)


def _journal(plugin, home: Path) -> Any:
    inbox = plugin.inbox_state
    return inbox.open_journal(home, backend="https://app.x", agent_id="a1", profile="default")


def _identity(monkeypatch, *, agent: str = "a1", endpoint: str = "https://App.X/") -> None:
    monkeypatch.setenv("CLAWBITS_API_KEY", "cb-key")
    monkeypatch.setenv("CLAWBITS_AGENT_ID", agent)
    monkeypatch.setenv("CLAWBITS_ENDPOINT", endpoint)


def _held(journal, kind: str, locator: str, epoch: Any, enumerated: int) -> Any:
    return journal.create_source(kind, locator, epoch, enumerated=enumerated, note="legacy:review",
                                 state="migration_needs_review")


def _review_journal(plugin, home: Path) -> tuple[Any, dict[str, Any]]:
    """A journal holding secret content in every content column, with work awaiting the operator."""
    inbox = plugin.inbox_state
    journal = _journal(plugin, home)
    chat = journal.create_source("chat", "c1", "", enumerated=0, note="server_pointer")
    posts = [inbox.NewItem(p, f"post:{p}", "live", payload={"text": SECRET}) for p in (1, 2)]
    chat = journal.admit(chat, posts, enumerated=2)
    first, second = (journal.lane_item(chat, "post", p).id for p in (1, 2))
    journal.claim([first, second], "boot:1", {"draft": SECRET, "message_id": f"<{SECRET}@x>"})
    journal.finish([first, second], "needs_review", "turn_failed", outcome={"summary": SECRET})
    mail = journal.create_source("email", "INBOX", 7, enumerated=0, note="n")
    mail = journal.admit(
        mail, [inbox.NewItem(9, "email:7:9", "backlog", lane="mail", payload={"from": SECRET})],
        enumerated=9,
    )
    item = journal.lane_item(mail, "mail", 9).id
    journal.claim([item], "boot:1")
    reply, = journal.finish([item], "processed", "owner_verified", intents=[
        inbox.Intent("email", SECRET, subject=SECRET, headers={"References": SECRET},
                     target=SECRET)])
    journal.update_delivery(reply.key, "failed", note="idempotency_key_reused")
    return journal, {"chat": chat, "mail": mail, "first": first, "second": second, "reply": reply}


def test_usage_and_missing_journal(plugin, home, capsys) -> None:
    assert _cli(plugin, "inbox") == 2
    assert "inbox {status,retry,dismiss,migrate,resend}" in capsys.readouterr().out
    assert plugin.signup._cli_command(argparse.Namespace(clawbits_command=None)) == 2
    assert "inbox {status,retry,dismiss,migrate,resend}" in capsys.readouterr().out
    assert _cli(plugin, "inbox", "status") == 0
    assert "No Clawbits inbox journal" in capsys.readouterr().out
    assert _cli(plugin, "inbox", "retry", "1") == 1
    with pytest.raises(SystemExit):
        _cli(plugin, "inbox", "migrate", "1")  # a start mode is required


def test_status_prints_codes_and_counts_never_content(plugin, home, capsys) -> None:
    journal, ids = _review_journal(plugin, home)
    (home / "clawbits-email-watermark.json").write_text(SECRET)
    assert _cli(plugin, "inbox", "status") == 0
    captured = capsys.readouterr()
    assert SECRET not in captured.out + captured.err
    out = captured.out
    assert "Items: needs_review 2, processed 1; oldest open" in out and "stalled 0" in out
    assert f"  {ids['chat'].id} chat c1 active 2 0 0 server_pointer" in out
    assert f"  {ids['first']} {ids['chat'].id} post 1 turn_failed" in out
    assert f"  {ids['reply'].key} email 1 failed idempotency_key_reused" in out
    assert "Legacy cursor files in the profile: clawbits-email-watermark.json" in out


def test_status_of_an_uninitialised_or_newer_journal(plugin, home, capsys) -> None:
    path = plugin.inbox_state.journal_path(home)
    path.parent.mkdir(parents=True)
    path.touch()
    assert _cli(plugin, "inbox", "status") == 0
    assert "not initialised yet" in capsys.readouterr().out
    path.unlink()
    _journal(plugin, home).close()
    with sqlite3.connect(path) as db:
        db.execute("UPDATE meta SET value='9' WHERE key IN ('schema', 'min_reader')")
    assert _cli(plugin, "inbox", "status") == 1
    assert "schema 9 needs a newer plugin (min_reader 9)" in capsys.readouterr().out
    assert _cli(plugin, "inbox", "retry", "1") == 1
    assert "needs plugin schema 9" in capsys.readouterr().err


def test_retry_and_dismiss_items_and_deliveries(plugin, home, capsys) -> None:
    journal, ids = _review_journal(plugin, home)  # the gateway keeps its journal open meanwhile
    assert _cli(plugin, "inbox", "retry", str(ids["first"])) == 0
    assert _cli(plugin, "inbox", "dismiss", str(ids["second"])) == 0
    assert _cli(plugin, "inbox", "dismiss", ids["reply"].key) == 0
    out = capsys.readouterr().out
    assert f"Item {ids['first']} queued for retry." in out
    assert f"Item {ids['second']} dismissed." in out
    assert f"Delivery {ids['reply'].key} dismissed." in out
    first, second = (journal.lane_item(ids["chat"], "post", p) for p in (1, 2))
    assert (first.state, first.note, first.attempts, first.reason) == \
        ("pending", "operator_retry", 0, "backlog")
    assert (second.state, second.note) == ("ignored", "dismissed")
    assert journal.stats()["replies"] == {}

    assert _cli(plugin, "inbox", "retry", str(ids["first"])) == 1
    assert "is not awaiting review" in capsys.readouterr().err
    assert _cli(plugin, "inbox", "retry", "abc") == 1
    assert "not an item id" in capsys.readouterr().err
    assert _cli(plugin, "inbox", "dismiss", ids["reply"].key) == 1


def test_resend_creates_a_new_key(plugin, home, capsys) -> None:
    journal, ids = _review_journal(plugin, home)
    assert _cli(plugin, "inbox", "resend", ids["reply"].key) == 0
    out = capsys.readouterr().out
    new, = journal.due_deliveries(10)
    assert (new.version, new.state) == (2, "local") and new.key != ids["reply"].key
    assert out == f"Delivery {ids['reply'].key} resent as {new.key} (version 2).\n"
    assert _cli(plugin, "inbox", "resend", ids["reply"].key) == 1


def test_migrate_resolves_held_sources(plugin, home, capsys, monkeypatch) -> None:
    inbox = plugin.inbox_state
    journal = _journal(plugin, home)
    email = _held(journal, "email", "INBOX", 7, 10)
    chat = _held(journal, "chat", "c1", "", 4)
    (home / "clawbits-email-watermark.json").write_text('{"last_uid": 10}')
    assert _cli(plugin, "inbox", "migrate", str(email.id), "--adopt") == 0
    assert capsys.readouterr().out == \
        f"Source {email.id} (email) active after position 10 (migrated:adopt).\n"
    adopted = journal.source("email", "INBOX")
    assert (adopted.state, adopted.note) == ("active", "migrated:adopt")
    assert inbox.legacy_present(home) == {}
    assert (inbox.journal_path(home).parent / "legacy" / "clawbits-email-watermark.json").is_file()
    assert journal.get_meta("legacy_moved:email")
    assert _cli(plugin, "inbox", "migrate", str(email.id), "--adopt") == 1
    assert "not held for migration" in capsys.readouterr().err

    assert _cli(plugin, "inbox", "migrate", str(chat.id), "--from-uid", "20") == 0
    chat = journal.source("chat", "c1")
    assert (chat.enumerated, chat.settled, chat.note) == (19, 19, "migrated:from_uid")

    journal.retire(journal.source("email", "INBOX"), "epoch_changed")
    held = _held(journal, "email", "INBOX", 8, 0)
    _identity(monkeypatch)
    pages: list[tuple[Any, ...]] = []
    changes = {"uidvalidity": 9, "through_uid": 55}

    def email_changes(self, agent_id, after_uid, **kwargs):
        pages.append((agent_id, after_uid, kwargs))
        return changes

    monkeypatch.setattr(plugin.cli_client._ClawbitsCli, "email_changes", email_changes)
    assert _cli(plugin, "inbox", "migrate", str(held.id), "--new-only") == 1
    assert "epoch changed" in capsys.readouterr().err
    assert journal.source("email", "INBOX").state == "migration_needs_review"
    changes["uidvalidity"] = 8
    assert _cli(plugin, "inbox", "migrate", str(held.id), "--new-only") == 0
    assert pages[-1] == ("a1", 0, {"limit": 1})
    started = journal.source("email", "INBOX")
    assert (started.enumerated, started.note) == (55, "migrated:new_only")


def test_migrate_after_legacy_reappeared_keeps_journal_work(plugin, home, capsys,
                                                           monkeypatch) -> None:
    inbox = plugin.inbox_state
    journal = _journal(plugin, home)
    chat = journal.create_source("chat", "c1", "", enumerated=0, note="server_pointer")
    chat = journal.admit(chat, [inbox.NewItem(p, f"post:{p}", "live") for p in range(1, 11)],
                         enumerated=10)
    ids = {p: journal.lane_item(chat, "post", p).id for p in range(1, 11)}
    journal.finish([ids[p] for p in range(1, 6)], "processed", "triggered")
    journal.finish([ids[6]], "needs_review", "turn_failed")
    journal.settle(chat)
    pruned = journal.create_source("chat", "c2", "", enumerated=30, note="server_pointer")
    journal.move_legacy("chat")
    (home / inbox.LEGACY_FILES["chat"]).write_text("{}")  # 0.9.0 ran again
    assert journal.hold_legacy() == 2
    for source, uid, cursor in ((chat, "1", 10), (chat, "10", 10), (pruned, "5", 30)):
        assert _cli(plugin, "inbox", "migrate", str(source.id), "--from-uid", uid) == 1
        assert f"was read through position {cursor}; use --adopt or --from-uid {cursor + 1}" \
            in capsys.readouterr().err
    assert journal.source("chat", "c1").state == "migration_needs_review"

    heads = [plugin.messages._Channel("c1", latest_post_id=150)]
    monkeypatch.setattr(plugin.cli_client._ClawbitsCli, "list_channels", lambda self: heads)
    _identity(monkeypatch)
    assert _cli(plugin, "inbox", "migrate", str(chat.id), "--new-only") == 0
    assert capsys.readouterr().out == (f"Source {chat.id} (chat) active after position 150"
                                       " (migrated:new_only); 5 open item(s) kept.\n")
    chat = journal.source("chat", "c1")
    assert (chat.state, chat.enumerated, chat.settled) == ("active", 150, 5)  # 6 stays unacked
    fresh = _held(journal, "chat", "c3", "", 10)  # never read: any start
    assert _cli(plugin, "inbox", "migrate", str(fresh.id), "--from-uid", "3") == 0
    assert journal.source("chat", "c3").enumerated == 2


def test_retry_refuses_items_of_a_retired_epoch(plugin, home, capsys) -> None:
    inbox = plugin.inbox_state
    journal = _journal(plugin, home)
    old = journal.create_source("email", "INBOX", 7, enumerated=0, note="n")
    old = journal.admit(old, [inbox.NewItem(3, "email:7:3", "backlog", lane="mail")], enumerated=3)
    item = journal.lane_item(old, "mail", 3).id
    journal.retire(old, "epoch_changed")
    journal.create_source("email", "INBOX", 8, enumerated=0, note="epoch_changed")
    assert _cli(plugin, "inbox", "retry", str(item)) == 1
    assert f"item {item} is in retired source {old.id}; dismiss it" in capsys.readouterr().err
    assert journal.lane_item(old, "mail", 3).state == "needs_review"
    assert _cli(plugin, "inbox", "dismiss", str(item)) == 0
    assert journal.lane_item(old, "mail", 3).state == "ignored"


def test_migrate_new_only_reads_the_channel_head(plugin, home, capsys, monkeypatch) -> None:
    journal = _journal(plugin, home)
    held = _held(journal, "chat", "c1", "", 4)
    channel = plugin.messages._Channel
    heads = [channel("c0", latest_post_id=3), channel("c1", latest_post_id=77)]
    monkeypatch.setattr(plugin.cli_client._ClawbitsCli, "list_channels", lambda self: heads)
    for agent, endpoint in (("a2", "https://app.x"), ("a1", "https://other.x")):
        _identity(monkeypatch, agent=agent, endpoint=endpoint)  # not the identity that owns it
        assert _cli(plugin, "inbox", "migrate", str(held.id), "--new-only") == 1
        assert "belongs to another backend or agent" in capsys.readouterr().err
    _identity(monkeypatch)
    assert _cli(plugin, "inbox", "migrate", str(held.id), "--new-only") == 0
    assert journal.source("chat", "c1").enumerated == 77
    monkeypatch.delenv("CLAWBITS_API_KEY")
    other = _held(journal, "chat", "c2", "", 0)
    assert _cli(plugin, "inbox", "migrate", str(other.id), "--new-only") == 1
    assert "no Clawbits identity" in capsys.readouterr().err


def test_cli_never_migrates_the_journal(plugin, home, capsys, monkeypatch) -> None:
    journal, ids = _review_journal(plugin, home)
    journal.close()
    monkeypatch.setattr(plugin.inbox_state, "SCHEMA_VERSION", 2)
    assert _cli(plugin, "inbox", "retry", str(ids["first"])) == 1
    assert "journal_migration_pending" in capsys.readouterr().err
    with sqlite3.connect(plugin.inbox_state.journal_path(home)) as db:
        assert db.execute("SELECT value FROM meta WHERE key='schema'").fetchone() == ("1",)
        state = db.execute("SELECT state FROM item WHERE id=?", (ids["first"],)).fetchone()
        assert state == ("needs_review",)
    assert not (plugin.inbox_state.journal_path(home).parent / "backups").exists()
