"""Mailroom: email intake, the restricted reader worker and the outbox of one profile.

Intake admits ``/email/changes`` pages into the journal. The worker reads each mail with the
tool-less reader and records its chat artifact (and, for verified owner mail, an emailed reply)
as delivery intents. The outbox posts chat intents at least once and sends email under the
delivery's Idempotency-Key. Mail never becomes a gateway MessageEvent.
"""

from __future__ import annotations

import asyncio
import contextlib
import dataclasses
import json
import logging
import math
import secrets
import threading
import time
from collections.abc import Awaitable, Callable
from datetime import datetime
from typing import Any

from .account import ClawbitsAccount, _active_home, _flag, _home_key, scoped_setting
from .cli_client import ClawbitsCliError, _ClawbitsCli, http_status
from .email_integration import (
    DEFAULT_EMAIL_POLL_INTERVAL_SECONDS,
    EMAIL_SUBJECT_MAX_CHARS,
    MIN_EMAIL_POLL_INTERVAL_SECONDS,
    _email_uids,
    _is_self_addressed,
    _reply_headers,
    _reply_subject,
    email_body,
    email_reply_context,
    fit_email_body,
    is_auto_submitted,
    is_automated,
    load_email_watermark,
    message_id,
)
from .email_reader import (
    CALL_WINDOW_S,
    MAX_FIELD_CHARS,
    MAX_MESSAGE_BYTES,
    READER_MAX_ATTEMPTS,
    TOKEN_WINDOW_S,
    ReaderError,
    ReaderLimits,
    _code,
    _int,
    budget_wait,
    build_mail_input,
    clean,
    decide,
    read_mail,
    reader_ready,
    render_artifact,
    render_notice,
)
from .health import HealthStatus, error_code
from .inbox_state import (
    MAX_ATTEMPTS,
    MAX_OPEN,
    Delivery,
    InboxJournal,
    Intent,
    Item,
    NewItem,
    Source,
    legacy_present,
)
from .messages import _message_id_from_response, _split_message_chunks

logger = logging.getLogger(__name__)

PAGE = 50
MAX_PAGES = 4  # /email/changes pages per intake pass; has_more runs the next pass at once
DEGRADED_S = 900.0  # an unsupported or unconfigured mailbox is probed again after 15 minutes
BACKOFF_S = (60.0, 900.0)
WORK_BATCH = 10
IDLE_S = 60.0
OUTBOX_S = 30.0
OUTBOX_BATCH = 20
SEND_HOLD_S = 3600.0
PRUNE_S = 86_400.0
BACKFILL_MAX = 200
_TICK = 5.0  # longest wait before a loop re-checks running()
_AMBIGUOUS = frozenset({500, 502, 504})  # the server may have acted on the request
_FINAL = frozenset({400, 409, 413, 422})  # repeating the same request cannot succeed
_SERVER_STATES = ("queued", "attempting", "accepted", "retry_wait", "failed", "unknown")
_PAGE_INTS = ("uidvalidity", "through_uid", "next_after_uid")
_PENDING = "pending_notices"  # journal meta: operator notices queued but not yet posted
_UNSUPPORTED_NOTICE = (
    "[Email intake paused] This Clawbits server has no incremental mailbox API. Mail stays on"
    " the server and is checked again every 15 minutes."
)
_EPOCH_NOTICE = (
    "[Email] The mailbox was reset (new UIDVALIDITY) and is read again from the start; unfinished"
    " mail from before needs review: hermes clawbits inbox status"
)


class _Degraded(Exception):
    """Intake cannot run against this backend for now; ``code`` names why."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class _NoHealth:
    def __getattr__(self, name: str) -> Callable[..., None]:
        return lambda *args, **kwargs: None


def _backoff(attempt: int) -> float:
    return min(BACKOFF_S[1], BACKOFF_S[0] * 2 ** max(attempt - 1, 0))


def _number(name: str, default: float) -> float:
    try:
        value = float(scoped_setting(name) or default)
    except ValueError:
        return default
    return value if math.isfinite(value) else default


def _bad_response() -> ClawbitsCliError:
    return ClawbitsCliError(None, "mailbox_bad_response")


def _valid_page(page: Any) -> bool:
    """A /email/changes page with integer cursors and uids; a garbled 200 must not move them."""
    if not (isinstance(page, dict) and all(type(page.get(k)) is int for k in _PAGE_INTS)):
        return False
    rows = page.get("emails")
    return isinstance(rows, list) and all(
        isinstance(r, dict) and type(r.get("uid")) is int for r in rows
    )


def _load_notices(journal: InboxJournal) -> dict[str, str]:
    """The notices ``_notify_once`` queued and none posted yet."""
    try:
        notices = json.loads(journal.get_meta(_PENDING) or "{}")
    except ValueError:
        return {}
    if not isinstance(notices, dict):
        return {}
    return {str(k): str(v) for k, v in notices.items() if not journal.get_meta(f"notice:{k}")}


def _backfill_count(choice: str) -> int:
    """N of a ``backfill:N`` first-start choice (at most BACKFILL_MAX); 0 for new_only."""
    kind, _, count = choice.strip().lower().partition(":")
    return min(int(count), BACKFILL_MAX) if kind == "backfill" and count.isdigit() else 0


def _cli_code(exc: BaseException) -> str:
    return exc.code if isinstance(exc, ClawbitsCliError) else error_code(exc)


def _due_in(value: Any) -> float:
    """Seconds until an ISO ``next_attempt_at`` (at least 5), else 60."""
    try:
        return max(5.0, datetime.fromisoformat(str(value)).timestamp() - time.time())
    except (TypeError, ValueError):
        return 60.0


def _held_notice(source: Source) -> str:
    return (
        f"[Email intake held] Mail from before the inbox journal needs a decision ({source.note})."
        f" Run: hermes clawbits inbox migrate {source.id} --adopt | --new-only | --from-uid N"
    )


def _delivery_notice(d: Delivery, state: str, note: str) -> str:
    return (
        f"[Email {state}] {_code(d.subject)} ({note}) is not re-sent automatically."
        f" To send it again: hermes clawbits inbox resend {d.key}"
    )


class Mailroom:
    """Email intake, reader worker and outbox for one profile's account and journal.

    Build it inside the owning profile's scope: the reader knobs are read from its settings.
    """

    def __init__(
        self, *, account: ClawbitsAccount, client: _ClawbitsCli, journal: InboxJournal,
        llm: Any | None, health: HealthStatus | None,
        operator: Callable[[], Awaitable[tuple[str | None, str | None]]],
        snoozed: Callable[[], bool],
    ) -> None:
        self.account, self.client, self.journal, self.llm = account, client, journal, llm
        self.health = health or _NoHealth()
        self._operator, self._snoozed = operator, snoozed
        self._run_id = f"mail:{secrets.token_hex(4)}"
        self._events = {name: asyncio.Event() for name in ("email", "reader", "outbox")}
        self._loop_ref: asyncio.AbstractEventLoop | None = None
        self._mailbox: str | None = None
        self._channel: str | None = None
        self._lock = threading.Lock()  # queued notices, shared with outbox and send-tool threads
        self._notices = _load_notices(journal)
        self._requeued = False
        self._pruned = 0.0
        self._proven = journal.get_meta("idempotent_send") == "1"
        self._poll_s = max(
            MIN_EMAIL_POLL_INTERVAL_SECONDS,
            _number("CLAWBITS_EMAIL_POLL_INTERVAL", DEFAULT_EMAIL_POLL_INTERVAL_SECONDS),
        )
        self._first_start = scoped_setting("CLAWBITS_INBOX_FIRST_START") or "new_only"
        policy = (scoped_setting("CLAWBITS_INBOX_LEGACY_MIGRATION") or "review").lower()
        self._legacy_policy = policy if policy in ("adopt", "new_only") else "review"
        self._ingest_automated = _flag(scoped_setting("CLAWBITS_EMAIL_INGEST_AUTOMATED"), False)
        self._limits = ReaderLimits(
            int(_number("CLAWBITS_EMAIL_READER_DAILY_TOKENS", 200_000)),
            int(_number("CLAWBITS_EMAIL_READER_HOURLY_CALLS", 30)),
        )
        enabled = _flag(scoped_setting("CLAWBITS_EMAIL_READER"), True)
        self._ready = reader_ready(llm, enabled, self._limits)
        if not account.receive_email:
            self.health.ok("email", state="disabled")

    # --- lifecycle ------------------------------------------------------------

    async def run(self, running: Callable[[], bool]) -> None:
        """Intake (when receiving), reader worker and outbox until ``running()`` is false."""
        self._loop_ref = asyncio.get_running_loop()
        loops = [self._loop("outbox", self._outbox_pass, running)]
        if self.account.receive_email:
            loops += [
                self._loop("email", self._intake_pass, running),
                self._loop("reader", self._work_pass, running),
            ]
        await asyncio.gather(*loops)

    def wake(self) -> None:
        """Run every loop's next pass now; safe from any thread."""
        for name in self._events:
            self._set(name)

    def _set(self, name: str) -> None:
        loop, event = self._loop_ref, self._events[name]
        with contextlib.suppress(RuntimeError):
            if loop is None or asyncio.get_running_loop() is loop:
                event.set()
                return
        if not loop.is_closed():
            with contextlib.suppress(RuntimeError):
                loop.call_soon_threadsafe(event.set)

    async def _loop(
        self, name: str, step: Callable[[], Awaitable[float]], running: Callable[[], bool]
    ) -> None:
        """Run ``step`` until stopped; a raised pass is recorded and retried with backoff."""
        event, failures = self._events[name], 0
        while running():
            event.clear()
            try:
                delay = await step()
                failures = 0
            except Exception as exc:
                failures += 1
                delay = _backoff(failures)
                self.health.fail(name, exc, interval_s=delay)
                logger.warning("clawbits: %s pass failed (%s)", name, error_code(exc))
            deadline = time.monotonic() + delay
            while running() and not event.is_set() and (left := deadline - time.monotonic()) > 0:
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(event.wait(), min(left, _TICK))
            await asyncio.sleep(0)

    def _notify_once(self, key: str, text: str) -> None:
        """Queue a model-free notice to the operator, once per key; the queue is kept in the
        journal until posted."""
        with self._lock:
            if key in self._notices or self.journal.get_meta(f"notice:{key}"):
                return
            self._notices[key] = text
            self.journal.set_meta(_PENDING, json.dumps(self._notices))
        self._set("outbox")

    async def _operator_identity(self) -> tuple[str | None, str | None]:
        """(operator email, operator channel); the last known channel when the lookup fails."""
        try:
            email, channel = await self._operator()
        except Exception as exc:
            logger.warning("clawbits: operator lookup failed (%s)", error_code(exc))
            return None, self._channel
        self._channel = channel or self._channel
        return email, self._channel

    # --- intake ---------------------------------------------------------------

    async def _changes(self, after: int, **bounds: Any) -> dict[str, Any]:
        """One /email/changes page with integer cursors; 404 or 422: the backend predates it."""
        try:
            page = await asyncio.to_thread(
                self.client.email_changes, self.account.agent_id, after, **bounds
            )
        except ClawbitsCliError as exc:
            if exc.status in (404, 422):
                raise _Degraded("mailbox_api_unsupported") from exc
            raise
        if not _valid_page(page):
            raise _bad_response()
        return page

    async def _intake_pass(self) -> float:
        try:
            source = await self._email_source()
            return self._poll_s if source is None else await self._scan(source)
        except _Degraded as exc:
            self.health.fail("email", exc.code, interval_s=DEGRADED_S)
            if exc.code == "mailbox_api_unsupported":
                self._notify_once(exc.code, _UNSUPPORTED_NOTICE)
            return DEGRADED_S
        except ClawbitsCliError as exc:
            if exc.code != "not_configured":
                raise
            self.health.ok("email", state="not_configured", interval_s=DEGRADED_S)
            return DEGRADED_S

    async def _email_source(self) -> Source | None:
        """The mailbox's active source, created on first start; None while held for review."""
        if self._mailbox is None:
            counts = await asyncio.to_thread(self.client.email_count, self.account.agent_id)
            mailbox = str(counts.get("email_address") or "").strip().lower()
            if not mailbox:
                raise _Degraded("mailbox_unknown")
            self._mailbox = mailbox
        source = self.journal.source("email", self._mailbox) or await self._first_source()
        if source.state == "migration_needs_review":
            probe = await self._changes(0, limit=1)
            if str(probe["uidvalidity"]) == source.epoch:
                self.health.fail("email", "migration_needs_review", interval_s=self._poll_s)
                self._notify_once(f"held:{source.id}:{source.note}", _held_notice(source))
                return None
            source = await self._new_epoch(source, probe["uidvalidity"])
        if self.journal.get_meta("legacy_moved:email") is None:
            self.journal.move_legacy("email")
        return source

    async def _first_source(self) -> Source:
        """Create the source: after a retired epoch from 0, else per the legacy watermark policy,
        else per the first-start choice."""
        probe = await self._changes(0, limit=1)
        epoch, newest = str(probe["uidvalidity"]), probe["through_uid"]

        def create(start: int, note: str, state: str = "active") -> Source:
            return self.journal.create_source(
                "email", self._mailbox, epoch, enumerated=start, note=note, state=state
            )

        if self.journal.get_meta(self._epoch_mark()):
            return create(0, "epoch_changed")
        if "email" not in legacy_present(self.journal.home):
            count = _backfill_count(self._first_start)
            if not count:
                return create(newest, "first_start:new_only")
            listing = await asyncio.to_thread(
                self.client.email_inbox, self.account.agent_id, count, 0
            )
            uids = [uid for uid in _email_uids(listing) if uid <= newest][-count:]
            return create(min(uids) - 1 if uids else newest, f"first_start:backfill:{count}")
        if self._legacy_policy == "new_only":
            return create(newest, "migrated:new_only")
        uid, recorded = load_email_watermark(self.journal.home)
        bound = uid is not None and uid <= newest and recorded in (None, int(epoch))
        if bound and self._legacy_policy == "adopt":
            return create(uid, "migrated:adopt")
        if bound:
            return create(uid, "legacy_watermark", "migration_needs_review")
        return create(0, "legacy_watermark_unbound", "migration_needs_review")

    def _epoch_mark(self) -> str:
        """Meta key set once a source of this mailbox and namespace is retired for a new epoch."""
        return "epoch_changed:" + "|".join((*self.journal.ns, self._mailbox or ""))

    async def _new_epoch(self, old: Source, epoch: Any) -> Source:
        """Retire ``old`` (its waiting mail to review) and enumerate the new epoch from 0; the
        epoch mark, written first, lets the next pass create the successor if this one fails."""
        if type(epoch) is not int or str(epoch) == old.epoch:
            epoch = (await self._changes(0, limit=1))["uidvalidity"]
        if str(epoch) == old.epoch:
            raise _bad_response()  # a 409 while the epoch is unchanged
        self.journal.set_meta(self._epoch_mark(), str(epoch))
        self.journal.retire(old, "epoch_changed")
        if old.state == "active":
            self._notify_once(f"epoch:{old.id}", _EPOCH_NOTICE)
        return self.journal.create_source(
            "email", self._mailbox, epoch, enumerated=0, note="epoch_changed"
        )

    async def _scan(self, source: Source) -> float:
        """Admit up to MAX_PAGES pages of one scan; a stored ``scan_through`` continues it."""
        for _ in range(MAX_PAGES):
            room = MAX_OPEN - self.journal.open_count(source)
            if room <= 0:
                self.health.ok("email", state="queue_full", interval_s=self._poll_s)
                return self._poll_s
            bounds: dict[str, Any] = {"limit": min(PAGE, room)}
            if source.scan_through is not None:
                bounds.update(uidvalidity=int(source.epoch), through_uid=source.scan_through)
            try:
                page = await self._changes(source.enumerated, **bounds)
            except ClawbitsCliError as exc:
                if exc.status != 409:
                    raise
                source = await self._new_epoch(source, (exc.detail or {}).get("uidvalidity"))
                continue
            if str(page["uidvalidity"]) != source.epoch:
                source = await self._new_epoch(source, page["uidvalidity"])
                continue
            rows = [self._row(source, r) for r in page["emails"] if r["uid"] > source.enumerated]
            more = bool(page.get("has_more"))
            source = self.journal.admit(
                source, rows, enumerated=page["next_after_uid"],
                scan_through=page["through_uid"] if more else None,
            )
            source = self.journal.settle(source)
            if rows:
                self.health.receipt("email")
                self._set("reader")
            if not more:
                self.health.ok("email", interval_s=self._poll_s, state="active", epoch=source.epoch)
                return self._poll_s
        return 0.0

    def _row(self, source: Source, row: dict[str, Any]) -> NewItem:
        uid = row["uid"]
        payload = {
            "from_addr": clean(row.get("from_addr"), MAX_FIELD_CHARS, one_line=True),
            "subject": clean(row.get("subject"), MAX_FIELD_CHARS, one_line=True),
            "size": _int(row.get("size")),
        }
        reason = "snoozed" if self._snoozed() else "live"
        return NewItem(uid, f"email:{source.epoch}:{uid}", reason, payload=payload, lane="mail")

    # --- reader worker --------------------------------------------------------

    async def _work_pass(self) -> float:
        if self._mailbox is None:
            return IDLE_S
        source = self.journal.source("email", self._mailbox)
        if source is None or source.state != "active":
            return IDLE_S
        if self._snoozed():
            self.health.ok("reader", state="snoozed", interval_s=IDLE_S)
            return IDLE_S
        if not self._ready:
            self.health.fail("reader", "reader_unavailable", interval_s=IDLE_S)
        elif not self._requeued:
            self.journal.requeue(source, "reader_unavailable")
            self._requeued = True
        items = self.journal.due(source, WORK_BATCH, lane="mail")
        if not items:
            if self._ready:
                self.health.ok("reader", state="idle", interval_s=IDLE_S)
            return IDLE_S
        owner, channel = await self._operator_identity()
        if not owner:
            self.health.fail("reader", "operator_unknown", interval_s=IDLE_S)
            return IDLE_S
        delay = 0.0 if len(items) == WORK_BATCH else IDLE_S
        for item in items:
            if self._snoozed():
                break
            if (wait := await self._process(source, item, owner, channel)) is not None:
                delay = wait
                break
        self.journal.settle(source)
        self._set("outbox")  # after the pass, so its notices go out combined
        return delay

    def _inbox_url(self, uid: int) -> str:
        return f"{self.account.base_url}/agents/{self.account.agent_id}/inbox/{uid}"

    async def _process(
        self, source: Source, item: Item, owner: str, channel: str | None
    ) -> float | None:
        """Claim one due mail and read it; an unexpected error retries it with backoff (the
        journal escalates to review at MAX_ATTEMPTS). A returned delay ends the pass."""
        self.journal.claim([item.id], self._run_id)
        try:
            return await self._read(source, item, owner, channel)
        except Exception as exc:
            code = error_code(exc)
            self.health.fail("reader", code)
            logger.warning("clawbits: mail item %s failed (%s)", item.id, code)
            self.journal.retry_later([item.id], code, _backoff(item.attempts + 1))
            return None

    async def _read(
        self, source: Source, item: Item, owner: str, channel: str | None
    ) -> float | None:
        """A claimed mail to a disposition or a retry."""
        row, url = item.payload, self._inbox_url(item.pos)
        attempt = item.attempts + 1

        def review(reason: str) -> None:
            text = render_notice(row, reason, url)
            notice = Intent("chat", text, subject="notice", target=channel)
            self._finish(item, "needs_review", reason, intents=[notice])

        if _int(row.get("size")) > MAX_MESSAGE_BYTES:
            return review("too_large")
        try:
            detail = await asyncio.to_thread(
                self.client.email_get, self.account.agent_id, item.pos,
                uidvalidity=int(source.epoch), mark_read=False, attachment_content=False,
            )
        except Exception as exc:
            if http_status(exc) == 404:
                return self._finish(item, "deleted", "vanished_same_epoch")
            if http_status(exc) == 409:  # intake retires the epoch; the rest of the batch waits
                self._set("email")
                self._finish(item, "needs_review", "epoch_changed")
                return IDLE_S
            if attempt >= MAX_ATTEMPTS:
                return review("fetch_failed")
            self.journal.retry_later([item.id], "fetch_failed", _backoff(attempt))
            return None
        msgid = message_id(detail)
        outcome = {"message_id": msgid} if msgid else None
        if msgid and self.journal.seen_message_id(msgid):
            return self._finish(item, "ignored", "duplicate_message_id")
        text, cut = email_body(detail)
        mail = build_mail_input(detail, text, body_truncated=cut)
        decision = decide(
            mail, owner_email=owner,
            self_addressed=_is_self_addressed(detail, self.account.agent_id, self._mailbox),
            automated=is_automated(detail), reply_suppressed=is_auto_submitted(detail),
            ingest_automated=self._ingest_automated, send_enabled=self.account.send_email,
            reader_ready=self._ready,
        )
        if decision.action == "ignore":
            return self._finish(item, "ignored", decision.reason, outcome=outcome)
        if decision.action == "hold":
            return review(decision.reason)
        now = time.time()
        usage = (
            self.journal.reader_usage(source, since=now - TOKEN_WINDOW_S)[0],
            self.journal.reader_usage(source, since=now - CALL_WINDOW_S)[1],
        )
        if (wait := budget_wait(usage, self._limits)) is not None:
            self.journal.retry_later([item.id], "budget_exhausted", wait, count_attempt=False)
            self.health.ok("reader", state="budget_exhausted", interval_s=wait)
            return wait
        try:
            summary, reply, flags, tokens = await read_mail(
                self.llm, mail, want_reply=decision.reply == "allowed"
            )
        except ReaderError as exc:
            self.journal.record_reader_call(source, tokens=exc.tokens, at=now)
            self.health.fail("reader", exc.reason)
            return review(exc.reason)
        except Exception as exc:
            self.journal.record_reader_call(source, tokens=mail.estimated_tokens(), at=now)
            self.health.fail("reader", exc)
            if attempt >= READER_MAX_ATTEMPTS:
                return review("reader_failed")
            self.journal.retry_later([item.id], "reader_error", _backoff(attempt))
            return None
        self.journal.record_reader_call(source, tokens=tokens, at=now)
        self.health.ok("reader", state="ready", interval_s=IDLE_S)
        artifact = render_artifact(mail, decision, summary, reply, flags, url)
        intents = [Intent("chat", artifact, subject="artifact", target=channel)]
        if decision.reply == "allowed" and reply:
            headers = _reply_headers(email_reply_context(detail))
            subject = _reply_subject(mail.subject)
            intents.append(Intent("email", fit_email_body(reply), subject=subject, headers=headers))
        outcome = {**(outcome or {}), "flags": flags}
        return self._finish(item, "processed", decision.reason, outcome=outcome, intents=intents)

    def _finish(
        self, item: Item, state: str, note: str, *, outcome: dict[str, Any] | None = None,
        intents: list[Intent] | tuple[()] = (),
    ) -> None:
        """Record a disposition; an item settled elsewhere meanwhile keeps that and drops this."""
        try:
            self.journal.finish([item.id], state, note, outcome=outcome, intents=intents)
        except LookupError:
            logger.info("clawbits: mail item %s was settled elsewhere; result dropped", item.id)

    # --- outbox ---------------------------------------------------------------

    async def _outbox_pass(self) -> float:
        snoozed, ok = self._snoozed(), True
        for delivery in self.journal.due_deliveries(OUTBOX_BATCH, kind="email"):
            await asyncio.to_thread(self._advance_email, delivery, not snoozed)
        chats = [] if snoozed else self.journal.due_deliveries(OUTBOX_BATCH, kind="chat")
        if chats or (self._notices and not snoozed):
            _, channel = await self._operator_identity()
            ok = await self._post_chats(chats, channel)
        if time.time() - self._pruned >= PRUNE_S:
            self.journal.prune()
            self._pruned = time.time()
        if ok:
            self.health.ok("outbox", interval_s=OUTBOX_S, state="snoozed" if snoozed else "active")
        return OUTBOX_S

    async def _post_chats(self, chats: list[Delivery], channel: str | None) -> bool:
        """Post artifacts one by one and notices combined per target; False if a post failed or
        has no operator channel to go to."""
        batches: list[tuple[str | None, list[Delivery]]] = []
        notices: dict[str | None, list[Delivery]] = {}
        for d in chats:
            if d.subject == "notice":
                notices.setdefault(d.target or channel, []).append(d)
            else:
                batches.append((d.target or channel, [d]))
        groups, ok = [*batches, *notices.items()], True
        for target, group in groups:
            if target:
                ok = await self._deliver_chat(target, group) and ok
        with self._lock:
            pending = dict(self._notices)
        if (pending and not channel) or not all(target for target, _ in groups):
            self.health.fail("outbox", "operator_channel_unknown", interval_s=OUTBOX_S)
            return False
        if pending:
            try:
                await self._post(channel, "\n".join(pending.values()))
            except Exception as exc:
                self.health.fail("outbox", exc, interval_s=OUTBOX_S)
                return False
            with self._lock:
                for key in pending:
                    self._notices.pop(key, None)
                    self.journal.set_meta(f"notice:{key}", "1")
                self.journal.set_meta(_PENDING, json.dumps(self._notices))
        return ok

    async def _deliver_chat(self, target: str, group: list[Delivery]) -> bool:
        """Post deliveries as one message, at least once: a crash while posting posts again."""
        for d in group:
            self.journal.update_delivery(d.key, "posting")
        try:
            post_id = await self._post(target, "\n".join(d.body for d in group))
        except Exception as exc:
            self.health.fail("outbox", exc, interval_s=OUTBOX_S)
            code = _cli_code(exc)
            for d in group:
                if d.attempts + 1 >= MAX_ATTEMPTS:
                    self.journal.update_delivery(d.key, "failed", note=code)
                else:
                    delay = _backoff(d.attempts + 1)
                    self.journal.update_delivery(d.key, "local", note=code, delay=delay)
            return False
        for d in group:
            self.journal.update_delivery(d.key, "posted", remote_id=post_id)
        return True

    async def _post(self, target: str, text: str) -> str | None:
        first = None
        for chunk in _split_message_chunks(text):
            reply = await asyncio.to_thread(self.client.post_message, target, chunk)
            first = first or _message_id_from_response(reply)
        return first

    def _advance_email(self, d: Delivery, may_post: bool) -> Delivery:
        """One outbox step for an email delivery; runs off the event loop."""
        may_post = may_post and self.account.send_email
        if d.state == "local" and not self.account.send_email:
            self.journal.update_delivery(d.key, "local", note="send_disabled", delay=SEND_HOLD_S)
            return dataclasses.replace(d, note="send_disabled")
        if d.state == "local":
            return self._post_email(d, fresh=True) if may_post else d
        if d.state == "posting":
            return self._resolve(d, may_post)
        if d.state in ("queued", "retry_wait") and may_post:
            return self._post_email(d)  # the server attempts SMTP only when the key is repeated
        return self._poll(d)

    def _post_email(self, d: Delivery, *, fresh: bool = False, retry: bool = True) -> Delivery:
        """POST the delivery under its key (``fresh``: mark it posting first); adopt the reply."""
        if fresh:
            self.journal.update_delivery(d.key, "posting")
            d = dataclasses.replace(d, state="posting", attempts=d.attempts + 1)
        try:
            record = self.client.email_send(
                self.account.agent_id, d.subject or "", d.body, d.headers or None,
                idempotency_key=d.key,
            )
        except Exception as exc:
            return self._post_failed(d, exc, retry=retry)
        return self._adopt(d, record)

    def _post_failed(self, d: Delivery, exc: Exception, *, retry: bool) -> Delivery:
        status = http_status(exc)
        if status is None or status in _AMBIGUOUS:
            return d  # the outcome is unknown; the key resolves it on the next step
        code = _cli_code(exc)
        if not retry or status in _FINAL or d.attempts >= MAX_ATTEMPTS:
            return self._settle(d, "failed", code)
        self.journal.update_delivery(d.key, "local", note=code, delay=_backoff(d.attempts))
        return dataclasses.replace(d, state="local", note=code)

    def _resolve(self, d: Delivery, may_post: bool, *, retry: bool = True) -> Delivery:
        """A POST with an unknown outcome: repeat it under a proven key, else look the key up."""
        if self._proven and may_post:
            return self._post_email(d, retry=retry)

        def unrecorded() -> Delivery:
            if may_post:
                return self._post_email(d, retry=retry)
            self.journal.update_delivery(d.key, "local")
            return dataclasses.replace(d, state="local")

        return self._lookup(d, unrecorded)

    def _poll(self, d: Delivery) -> Delivery:
        return self._lookup(d, lambda: self._settle(d, "unknown", "delivery_not_found"))

    def _lookup(self, d: Delivery, unrecorded: Callable[[], Delivery]) -> Delivery:
        """Adopt the server's record of the key; ``unrecorded`` handles a key it never saw."""
        try:
            record = self.client.email_delivery(self.account.agent_id, d.key)
        except Exception as exc:
            if getattr(exc, "code", None) == "delivery_not_found":  # keys honoured, none recorded
                self._set_proof(True)
                return unrecorded()
            if http_status(exc) == 404:  # a backend without keyed sends cannot tell
                self._set_proof(False)
                return self._settle(d, "unknown", "idempotency_unsupported")
            return d
        return self._adopt(d, record)

    def _adopt(self, d: Delivery, record: Any) -> Delivery:
        """Take the server's record, or a pre-key backend's plain reply, as the delivery state.

        A reply that does not echo the key (a backend ignoring keys, e.g. after a rollback)
        withdraws the proof that re-POSTs are safe."""
        record = record if isinstance(record, dict) else {}
        self._set_proof(record.get("idempotency_key") == d.key)
        state = record.get("state") or ("accepted" if record.get("status") == "sent" else "")
        state = state if state in _SERVER_STATES else "unknown"
        remote = None if record.get("delivery_id") is None else str(record["delivery_id"])
        note = record.get("error") if isinstance(record.get("error"), str) else None
        if state in ("failed", "unknown"):
            return self._settle(d, state, note or state, remote)
        delay = {"attempting": 60.0, "queued": 5.0}.get(state)
        if state == "retry_wait":
            delay = _due_in(record.get("next_attempt_at"))
        self.journal.update_delivery(d.key, state, remote_id=remote, note=note, delay=delay)
        return dataclasses.replace(d, state=state, note=note, remote_id=remote or d.remote_id)

    def _settle(self, d: Delivery, state: str, note: str, remote: str | None = None) -> Delivery:
        """A final failed/unknown state: recorded, one operator notice, never re-sent by itself."""
        self.journal.update_delivery(d.key, state, remote_id=remote, note=note)
        self._notify_once(f"delivery:{d.key}", _delivery_notice(d, state, note))
        return dataclasses.replace(d, state=state, note=note, remote_id=remote or d.remote_id)

    def _set_proof(self, proven: bool) -> None:
        """Record whether this backend honours Idempotency-Key (``_resolve`` re-POSTs if so)."""
        if proven != self._proven:
            self.journal.set_meta("idempotent_send", "1" if proven else "0")
            self._proven = proven

    # --- send tool ------------------------------------------------------------

    def send_tool_email(self, subject: str, message: str) -> dict[str, Any]:
        """Email the owner for the send tool (sync); the cbt1 key is stored before the POST."""
        subject = subject.strip()
        if subject.lower().startswith("re:"):
            subject = _reply_subject(subject)
        key = "cbt1-" + secrets.token_hex(20)
        subject, body = subject[:EMAIL_SUBJECT_MAX_CHARS], fit_email_body(message)
        d = self.journal.record_tool_send(key, subject, body)
        d = self._post_email(d, retry=False)
        if d.state == "posting":
            d = self._resolve(d, True, retry=False)
        result: dict[str, Any] = {"state": d.state, "idempotency_key": key}
        if d.note:
            result["error"] = d.note
        return result


_MAILROOMS: dict[str, Mailroom] = {}


def bind_mailroom(mailroom: Mailroom) -> None:
    """Publish a mailroom for the send tool running in the same profile."""
    _MAILROOMS[mailroom.account.key] = mailroom


def unbind_mailroom(mailroom: Mailroom) -> None:
    """Withdraw the mailroom if it is still the one bound for its profile."""
    if _MAILROOMS.get(mailroom.account.key) is mailroom:
        del _MAILROOMS[mailroom.account.key]


def active_mailroom() -> Mailroom | None:
    """The mailroom bound for the active profile, if its gateway runs one."""
    try:
        return _MAILROOMS.get(_home_key(_active_home()))
    except Exception:
        return None
