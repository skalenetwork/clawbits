"""Fakes for the mailroom tests: a mailbox and keyed-send server following the agent email API
(docs/protocol/AGENT_EMAIL_API.md), a client with the ``_ClawbitsCli`` surface the mailroom uses,
a reader LLM, and a rig that rebuilds the mailroom over the same journal file (a restart)."""

from __future__ import annotations

import asyncio
import hashlib
import importlib
import json
import os
import sys
import threading
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from tests.poc.hermes_stubs import _load_hermes_module

PKG = "hermes_clawbits_test"
AGENT = "agent1"
MAILBOX = f"{AGENT}@mail.clawbits.ai"
OWNER = "owner@x.example"
CHANNEL = "dm-owner"


def cli_error(status: int | None, code: str, detail: dict[str, Any] | None = None) -> Exception:
    return sys.modules[f"{PKG}.cli_client"].ClawbitsCliError(status, code, detail)


class Crash(BaseException):
    """A simulated process death: no ``except Exception`` in the mailroom stops it."""


def load_plugin(monkeypatch: Any) -> SimpleNamespace:
    """Load the plugin package; the journal uses the stdlib sqlite fallback."""
    _load_hermes_module()
    monkeypatch.setitem(sys.modules, "hermes_cli.sqlite_util", None)
    names = ("mailroom", "inbox_state", "email_integration", "account", "health", "email_reader",
             "cli_client")
    return SimpleNamespace(**{n: importlib.import_module(f"{PKG}.{n}") for n in names})


class FakeServer:
    """One mailbox (UIDs per UIDVALIDITY epoch) and the keyed outbox, with fault injection."""

    def __init__(self, uidvalidity: int = 7) -> None:
        self.uidvalidity = uidvalidity
        self.next_uid = 1
        self.messages: dict[int, dict[str, Any]] = {}
        self.seen: set[int] = set()
        self.records: dict[str, dict[str, Any]] = {}
        self.smtp: list[dict[str, Any]] = []
        self.posts: list[tuple[str, str]] = []
        self.calls: list[tuple[str, tuple[Any, ...], dict[str, Any]]] = []
        self.honours_keys = True
        self.outcomes: list[str] = []  # SMTP outcome per attempt; accepted when empty
        self.faults: dict[str, list[tuple[BaseException, bool]]] = {}
        self.garbled: dict[str, list[Any]] = {}
        self.lock = threading.Lock()

    def deliver(
        self, *, sender: str = OWNER, subject: str = "Hello", body: str = "hi",
        verdict: str = "pass", headers: dict[str, str] | None = None, size: int = 100,
        uid: int | None = None, msgid: str | None = None, **extra: Any,
    ) -> int:
        uid = uid or self.next_uid
        self.next_uid = uid + 1
        self.messages[uid] = {
            "uid": uid, "from_addr": sender, "to_addr": MAILBOX, "subject": subject,
            "date": "Tue, 22 Sep 2026 10:00:00 +0000", "size": size, "body_text": body,
            "headers": {"Message-ID": msgid or f"<m{uid}.{self.uidvalidity}@x.example>",
                        **(headers or {})},
            "sender_auth": {"verdict": verdict, "address": sender.lower(), "reason": "r"},
            "attachments": [{"filename": "a.txt", "content_type": "text/plain", "size": 3,
                             "content_b64": "YWJj"}],
            **extra,
        }
        return uid

    def reset(self, uidvalidity: int) -> None:
        """Recreate the mailbox: a new epoch whose UIDs start again at 1."""
        old = [self.messages[u] for u in sorted(self.messages)]
        self.uidvalidity, self.next_uid, self.messages, self.seen = uidvalidity, 1, {}, set()
        for message in old:
            uid = self.next_uid
            self.next_uid += 1
            self.messages[uid] = {**message, "uid": uid}

    def fault(self, op: str, exc: BaseException, *, after: bool = False, times: int = 1) -> None:
        """Raise ``exc`` on the next ``op`` call, before it acts (or after, a lost response)."""
        self.faults.setdefault(op, []).extend([(exc, after)] * times)

    def garble(self, op: str, body: Any, *, times: int = 1) -> None:
        """Answer the next ``op`` calls with ``body`` (a 200 outside the API) without acting."""
        self.garbled.setdefault(op, []).extend([body] * times)

    def ops(self, op: str) -> list[tuple[tuple[Any, ...], dict[str, Any]]]:
        return [(args, kwargs) for name, args, kwargs in self.calls if name == op]

    def record(self, key: str) -> dict[str, Any]:
        rec = self.records[key]
        public = {k: v for k, v in rec.items() if k != "hash" and v is not None}
        return {**public, "status": "sent" if rec["state"] == "accepted" else rec["state"]}


class FakeClient:
    """The ``_ClawbitsCli`` methods the mailroom calls, served by a FakeServer."""

    def __init__(self, server: FakeServer) -> None:
        self.server = server

    def _run(self, op: str, act: Any, *args: Any, **kwargs: Any) -> Any:
        server = self.server
        with server.lock:
            server.calls.append((op, args, kwargs))
            if server.garbled.get(op):
                return server.garbled[op].pop(0)
            exc, after = (server.faults.get(op) or [(None, False)])[0]
            if exc is not None:
                server.faults[op].pop(0)
                if not after:
                    raise exc
            result = act(*args, **kwargs)
        if exc is not None:
            raise exc
        return result

    def email_count(self, agent_id: str) -> dict[str, Any]:
        return self._run("email_count", lambda _: {"email_address": MAILBOX}, agent_id)

    def email_changes(self, agent_id: str, after_uid: int, **kwargs: Any) -> dict[str, Any]:
        return self._run("email_changes", self._changes, agent_id, after_uid, **kwargs)

    def _changes(
        self, agent_id: str, after_uid: int, *, uidvalidity: int | None = None,
        through_uid: int | None = None, limit: int = 50,
    ) -> dict[str, Any]:
        s = self.server
        if uidvalidity is not None and uidvalidity != s.uidvalidity:
            raise cli_error(409, "mailbox_epoch_changed",
                            {"code": "mailbox_epoch_changed", "uidvalidity": s.uidvalidity})
        newest = s.next_uid - 1
        through = newest if through_uid is None else min(through_uid, newest)
        after = max(after_uid, 0)
        uids = sorted(u for u in s.messages if after < u <= through)
        page, more = uids[:limit], len(uids) > limit
        rows = [{k: s.messages[u][k] for k in ("uid", "from_addr", "subject", "size")}
                for u in page]
        return {"uidvalidity": s.uidvalidity, "through_uid": through, "emails": rows,
                "next_after_uid": page[-1] if more else max(after, through), "has_more": more}

    def email_get(self, agent_id: str, uid: int, **kwargs: Any) -> dict[str, Any]:
        return self._run("email_get", self._get, agent_id, uid, **kwargs)

    def _get(
        self, agent_id: str, uid: int, *, uidvalidity: int | None = None, mark_read: bool = True,
        attachment_content: bool = True,
    ) -> dict[str, Any]:
        s = self.server
        if uidvalidity is not None and uidvalidity != s.uidvalidity:
            raise cli_error(409, "mailbox_epoch_changed",
                            {"code": "mailbox_epoch_changed", "uidvalidity": s.uidvalidity})
        if uid not in s.messages:
            raise cli_error(404, "not_found")
        if mark_read:
            s.seen.add(uid)
        detail = json.loads(json.dumps(s.messages[uid]))
        if not attachment_content:
            for attachment in detail["attachments"]:
                attachment.pop("content_b64", None)
        return detail

    def email_inbox(self, agent_id: str, limit: int = 50, offset: int = 0) -> dict[str, Any]:
        def listing() -> dict[str, Any]:
            uids = sorted(self.server.messages, reverse=True)[offset:offset + limit]
            return {"emails": [{"uid": u} for u in uids]}

        return self._run("email_inbox", listing)

    def email_send(
        self, agent_id: str, subject: str, message: str, headers: dict[str, str] | None = None,
        *, idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        args = (agent_id, subject, message, headers)
        return self._run("email_send", self._send, *args, idempotency_key=idempotency_key)

    def _send(
        self, agent_id: str, subject: str, message: str, headers: dict[str, str] | None,
        *, idempotency_key: str | None,
    ) -> dict[str, Any]:
        s = self.server
        payload = {"subject": subject, "message": message, "headers": headers}
        if not (idempotency_key and s.honours_keys):
            s.smtp.append(payload)
            return {"status": "sent", "from_addr": MAILBOX, "to_addr": OWNER, "subject": subject}
        digest = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
        rec = s.records.get(idempotency_key)
        if rec is None:
            rec = s.records[idempotency_key] = {
                "delivery_id": len(s.records) + 1, "idempotency_key": idempotency_key,
                "state": "queued", "message_id": f"<d{len(s.records) + 1}@mail.clawbits.ai>",
                "attempts": 0, "hash": digest, "subject": subject,
            }
        elif rec["hash"] != digest:
            raise cli_error(409, "idempotency_key_reused", {"code": "idempotency_key_reused"})
        if rec["state"] in ("queued", "retry_wait"):
            rec["attempts"] += 1
            rec["state"] = s.outcomes.pop(0) if s.outcomes else "accepted"
            rec["next_attempt_at"] = (
                "2000-01-01T00:00:00+00:00" if rec["state"] == "retry_wait" else None
            )
            if rec["state"] == "accepted":
                s.smtp.append({**payload, "key": idempotency_key})
        return s.record(idempotency_key)

    def email_delivery(self, agent_id: str, key: str) -> dict[str, Any]:
        def lookup(agent_id: str, key: str) -> dict[str, Any]:
            if not self.server.honours_keys:
                raise cli_error(404, "not_found")
            if key not in self.server.records:
                raise cli_error(404, "delivery_not_found", {"code": "delivery_not_found"})
            return self.server.record(key)

        return self._run("email_delivery", lookup, agent_id, key)

    def post_message(self, channel_id: str, content: str, *args: Any, **kwargs: Any) -> Any:
        def post() -> dict[str, Any]:
            self.server.posts.append((channel_id, content))
            return {"id": f"p{len(self.server.posts)}"}

        return self._run("post_message", post)


class FakeLlm:
    """Only ``acomplete_structured`` exists; touching any other capability fails the test."""

    def __init__(self, parsed: Any = None, *, raises: BaseException | None = None,
                 tokens: int = 42) -> None:
        self.parsed = parsed if parsed is not None else {"summary": "A note.", "reply": "Sure."}
        self.raises, self.tokens, self.calls = raises, tokens, []

    async def acomplete_structured(self, **kwargs: Any) -> SimpleNamespace:
        self.calls.append(kwargs)
        if self.raises is not None:
            raise self.raises
        return SimpleNamespace(parsed=self.parsed, usage=SimpleNamespace(total_tokens=self.tokens))

    def __getattr__(self, name: str) -> Any:
        if name.startswith("__"):
            raise AttributeError(name)
        raise AssertionError(f"reader used {name}")


class Rig:
    """One profile: a journal file, a fake server and a mailroom rebuilt on ``restart``."""

    def __init__(self, plugin: SimpleNamespace, *, home: Path | None = None,
                 server: FakeServer | None = None, llm: Any = "default", profile: str = "default",
                 **account: Any) -> None:
        self.plugin, self.server, self.profile = plugin, server or FakeServer(), profile
        self.home = home or Path(os.environ["HERMES_HOME"])
        self.llm = FakeLlm() if llm == "default" else llm
        self.snoozed, self.owner, self.channel = False, OWNER, CHANNEL
        self.account_kw = {"base_url": "https://app.x", "agent_id": AGENT, "api_key": "k1",
                           **account}
        self.open()

    def open(self) -> None:
        p = self.plugin
        self.journal = p.inbox_state.open_journal(
            self.home, backend=self.account_kw["base_url"], agent_id=AGENT, profile=self.profile
        )
        self.journal.reconcile(set())
        self.account = p.account.ClawbitsAccount(hermes_home=self.home, **self.account_kw)
        self.health = p.health.HealthStatus(self.home / "status", plugin_version="t", profile="p")
        self.mailroom = p.mailroom.Mailroom(
            account=self.account, client=FakeClient(self.server), journal=self.journal,
            llm=self.llm, health=self.health, operator=self._operator,
            snoozed=lambda: self.snoozed,
        )

    async def _operator(self) -> tuple[str | None, str | None]:
        return self.owner, self.channel

    def restart(self, **account: Any) -> None:
        self.journal.close()
        self.account_kw.update(account)
        self.open()

    def intake(self) -> float:
        return asyncio.run(self.mailroom._intake_pass())

    def work(self) -> float:
        return asyncio.run(self.mailroom._work_pass())

    def outbox(self) -> float:
        return asyncio.run(self.mailroom._outbox_pass())

    def cycle(self, rounds: int = 1) -> None:
        for _ in range(rounds):
            self.intake()
            self.work()
            self.outbox()

    def source(self) -> Any:
        return self.journal.source("email", MAILBOX)

    def items(self) -> dict[int, tuple[str, str | None]]:
        """(state, note) by uid for the current source."""
        rows = self.journal.db.execute(
            "SELECT pos, state, note FROM item WHERE source_id=? ORDER BY pos", (self.source().id,)
        )
        return {pos: (state, note) for pos, state, note in rows}

    def deliveries(self, kind: str | None = None) -> list[Any]:
        rows = self.journal.db.execute(
            "SELECT key FROM delivery WHERE ? IS NULL OR kind=? ORDER BY created_at, rowid",
            (kind, kind),
        )
        return [self.journal._delivery(key) for (key,) in rows]

    def subsystem(self, name: str) -> dict[str, Any]:
        return self.health.doc["subsystems"].get(name, {})
