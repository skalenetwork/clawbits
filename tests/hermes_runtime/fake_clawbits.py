"""Fake Clawbits agent API, agent events WebSocket and OpenAI-compatible model stub."""

from __future__ import annotations

import asyncio
import hashlib
import itertools
import json
import re
import socket
import threading
import time
from datetime import UTC, datetime
from email.utils import format_datetime
from typing import Any

import uvicorn
from fastapi import FastAPI, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, model_validator
from starlette.exceptions import HTTPException as StarletteHTTPException

AGENT_ID = "agent-x"
OPERATOR_ID = 7
OPERATOR_DM = "dm-op"
OPERATOR_CHAT = "chat-op"  # a named agent_chat room the operator opened beside the DM
OPERATOR_EMAIL = "op@example.com"
MODEL = "stub-model"
# The first line of the email reader's system prompt (extensions/hermes/email_reader.py).
READER_MARKER = "You read one email"
_IDEMPOTENCY_KEY = re.compile(r"[A-Za-z0-9_.:~+=-]{1,128}")


def tool(name: str, **arguments: Any) -> dict[str, Any]:
    """A scripted assistant tool call for FakeClawbits.script()."""
    return {"name": name, "arguments": arguments}


def is_reader_request(request: dict[str, Any]) -> bool:
    """Whether a chat completion came from the restricted email reader, not an agent turn."""
    return any(
        m.get("role") == "system" and READER_MARKER in str(m.get("content") or "")
        for m in request.get("messages", [])
    )


def _now() -> str:
    """A post timestamp as the backend formats it: naive UTC, whole seconds."""
    return datetime.now(UTC).strftime("%Y-%m-%d %H:%M:%S")


def _envelope(request: Request, status: int, detail: Any) -> JSONResponse:
    """The backend's error body for every failure."""
    return JSONResponse(
        {"error": True, "status_code": status, "detail": detail, "path": request.url.path}, status_code=status
    )


class _PatchBody(BaseModel):
    """Mirrors MmPostPatchRequest: one of append/replace and/or done, or cancel alone."""

    model_config = ConfigDict(extra="forbid")
    append: str | None = Field(default=None, max_length=4000)
    replace: str | None = Field(default=None, max_length=40000)
    done: bool = False
    cancel: bool = False

    @model_validator(mode="after")
    def _require_exactly_one_op(self) -> _PatchBody:
        if self.cancel and (self.append is not None or self.replace is not None or self.done):
            raise ValueError("cancel is mutually exclusive with append/replace/done")
        if self.append is not None and self.replace is not None:
            raise ValueError("append and replace are mutually exclusive")
        if not (self.cancel or self.done) and self.append is None and self.replace is None:
            raise ValueError("append, replace, done, or cancel must be set")
        return self


class _ReadBody(BaseModel):
    """Mirrors MmMarkReadRequest."""

    model_config = ConfigDict(extra="forbid")
    post_id: int = Field(ge=0)


class FakeClawbits:
    """Fake Clawbits agent API + events WebSocket + OpenAI-compatible model stub on one loopback port."""

    def __init__(self, agent_id: str = AGENT_ID) -> None:
        self.agent_id = agent_id
        self.mailbox = f"{agent_id}@mail.example.com"
        self.lock = threading.RLock()
        self.channels: list[dict[str, Any]] = [
            {"channel_id": OPERATOR_DM, "channel_type": "direct", "name": OPERATOR_DM},
            {"channel_id": OPERATOR_CHAT, "channel_type": "agent_chat", "name": OPERATOR_CHAT, "display_name": "New chat"},
            {"channel_id": "dm-other", "channel_type": "direct", "name": "dm-other"},  # DM with human 8
            {"channel_id": "pub", "channel_type": "public", "name": "pub"},
        ]
        self.posts: list[dict[str, Any]] = []
        self.read_ptr: dict[str, int] = {}
        self.snoozed = False
        self.inter_agent = False
        self.identity_status = 200  # non-200: /info and /operator-channel fail with it
        self.ws_enabled = True  # False: the events WebSocket refuses connections
        self.ws_accepted = 0  # events WebSocket connections accepted so far
        # Every HTTP request and WS connect: method, path, query, api_key, status.
        self.calls: list[dict[str, Any]] = []
        self.emails: list[dict[str, Any]] = []
        self.uidvalidity = 1
        self.uidnext = 1
        self.sent: list[dict[str, Any]] = []  # accepted POST /email/send bodies (+ idempotency_key)
        self.deliveries: dict[str, dict[str, Any]] = {}  # Idempotency-Key -> outbox record
        self._send_hashes: dict[str, str] = {}  # Idempotency-Key -> request payload hash
        self.send_state = "accepted"  # outcome recorded for new keyed sends
        self.model_requests: list[dict[str, Any]] = []
        # Answer to every email-reader call; scripted replies are for agent turns only.
        self.reader_reply: Any = json.dumps({"summary": "A short note.", "reply": "Noted."})
        self._replies: list[Any] = []
        self._gate: threading.Event | None = None
        self._ws_loop: asyncio.AbstractEventLoop | None = None
        self._ws_clients: set[asyncio.Queue[dict[str, Any]]] = set()
        self._post_ids = itertools.count(101)
        self._call_ids = itertools.count(1)
        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        self.base_url = f"http://127.0.0.1:{sock.getsockname()[1]}"
        config = uvicorn.Config(self._app(), log_level="warning", lifespan="off", ws="websockets-sansio")
        self._server = uvicorn.Server(config)
        threading.Thread(target=self._server.run, kwargs={"sockets": [sock]}, daemon=True).start()
        deadline = time.monotonic() + 10
        while not self._server.started:
            if time.monotonic() > deadline:
                raise RuntimeError("fake Clawbits server did not start")
            time.sleep(0.01)

    # --- test API ---------------------------------------------------------

    def post(
        self,
        text: str,
        *,
        channel: str = OPERATOR_DM,
        human_id: int | None = OPERATOR_ID,
        agent_id: str | None = None,
        name: str = "Op",
        files: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        """Publish a post as an authenticated human (or, with agent_id, as an agent)."""
        return self._add_post(
            channel, text, human_id=None if agent_id else human_id, agent_id=agent_id, name=name, files=files
        )

    def add_email(
        self,
        *,
        from_addr: str = OPERATOR_EMAIL,
        subject: str = "hello",
        body: str = "hi",
        sender_auth: dict[str, Any] | None = None,
        **fields: Any,
    ) -> dict[str, Any]:
        """Deliver one message to the agent's INBOX; sender_auth is omitted unless given (older backend)."""
        with self.lock:
            record = {
                "uid": self.uidnext, "from_addr": from_addr, "to_addr": self.mailbox, "subject": subject,
                "date": format_datetime(datetime.now(UTC)), "is_read": False, "size": len(body),
                "body_text": body, "body_html": None, "attachments": [], "headers": {}, **fields,
            }
            if sender_auth is not None:
                record["sender_auth"] = sender_auth
            self.uidnext += 1
            self.emails.append(record)
            return record

    @property
    def reader_requests(self) -> list[dict[str, Any]]:
        """Chat completions the email reader made."""
        return [r for r in self.model_requests if is_reader_request(r)]

    @property
    def agent_requests(self) -> list[dict[str, Any]]:
        """Chat completions an agent turn made."""
        return [r for r in self.model_requests if not is_reader_request(r)]

    def script(self, *replies: Any) -> None:
        """Queue model replies: str = final text, tool(...) = one tool call, [tool(...), ...] =
        parallel calls, (text, [tool(...)]) = both."""
        with self.lock:
            self._replies.extend(replies)

    def hold_model(self) -> threading.Event:
        """Block chat completions until the returned event is set."""
        self._gate = threading.Event()
        return self._gate

    def release_model(self) -> None:
        """Let every held and future chat completion through."""
        if self._gate is not None:
            self._gate.set()
        self._gate = None

    @property
    def ws_connected(self) -> bool:
        return bool(self._ws_clients)

    def push_ws(self, event: dict[str, Any]) -> None:
        """Send one event down every open agent events WebSocket; await Gateway.push_ws to wait for one."""
        if not self._ws_clients:
            raise AssertionError("agent events WebSocket not connected")
        self._broadcast(event)

    def snapshot(self) -> dict[str, Any]:
        """The agent's channels and controls, as GET /mm/channels and the WS snapshot carry them."""
        with self.lock:
            channels = []
            for channel in self.channels:
                ids = [
                    p["post_id"] for p in self.posts
                    if p["channel_id"] == channel["channel_id"] and p["status"] == "published" and not p.get("deleted")
                ]
                channels.append({
                    "created_at": "2026-01-01 00:00:00", **channel,
                    "latest_post_id": max(ids, default=None),
                    "last_read_post_id": self.read_ptr.get(channel["channel_id"]),
                })
        return {
            "channels": channels, "total": len(channels), "snoozed": self.snoozed,
            "inter_agent_mode_enabled": self.inter_agent, "inter_agent_message_limit": 10,
        }

    def close(self) -> None:
        """Stop the server."""
        self.release_model()
        self._server.should_exit = True

    # --- state helpers ----------------------------------------------------

    def _add_post(
        self,
        channel: str,
        text: str,
        *,
        name: str,
        human_id: int | None = None,
        agent_id: str | None = None,
        status: str = "published",
        parent_post_id: int | None = None,
        files: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        with self.lock:
            post = {
                "post_id": next(self._post_ids), "channel_id": channel, "human_id": human_id,
                "agent_id": agent_id, "poster_display_name": name, "message": text, "created_at": _now(),
                "status": status, "parent_post_id": parent_post_id, "files": files or [],
            }
            self.posts.append(post)
        self._publish(post)
        return post

    def _publish(self, post: dict[str, Any]) -> None:
        if not self.snoozed:
            self._broadcast({"type": "post.created", "channel_id": post["channel_id"], "data": dict(post)})

    def _broadcast(self, event: dict[str, Any]) -> None:
        loop = self._ws_loop
        for queue in list(self._ws_clients):
            loop.call_soon_threadsafe(queue.put_nowait, event)

    def _email(self, uid: int) -> dict[str, Any] | None:
        return next((e for e in self.emails if e["uid"] == uid), None)

    def _check_epoch(self, uidvalidity: int | None) -> None:
        if uidvalidity is not None and uidvalidity != self.uidvalidity:
            raise HTTPException(409, {"code": "mailbox_epoch_changed", "uidvalidity": self.uidvalidity})

    @staticmethod
    def _summary(email: dict[str, Any]) -> dict[str, Any]:
        keys = ("uid", "from_addr", "to_addr", "subject", "date", "is_read", "size")
        return {**{k: email[k] for k in keys}, "snippet": (email["body_text"] or "")[:140],
                "has_attachments": bool(email["attachments"])}

    def _completion(self, reply: Any, stream: bool) -> Any:
        text, calls = reply if isinstance(reply, tuple) else (reply, [])
        if not isinstance(text, str):
            text, calls = "", text
        calls = calls if isinstance(calls, list) else [calls]
        tool_calls = [
            {"id": f"call_{next(self._call_ids)}", "type": "function",
             "function": {"name": c["name"], "arguments": json.dumps(c["arguments"])}}
            for c in calls
        ]
        finish = "tool_calls" if tool_calls else "stop"
        usage = {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}
        head = {"id": "chatcmpl-stub", "created": int(time.time()), "model": MODEL}
        if not stream:
            message: dict[str, Any] = {"role": "assistant", "content": text or None}
            if tool_calls:
                message["tool_calls"] = tool_calls
            return {**head, "object": "chat.completion", "usage": usage,
                    "choices": [{"index": 0, "message": message, "finish_reason": finish}]}
        delta: dict[str, Any] = {"role": "assistant", "content": text}
        if tool_calls:
            delta["tool_calls"] = [{"index": i, **c} for i, c in enumerate(tool_calls)]
        chunks = [
            {**head, "object": "chat.completion.chunk", "choices": [{"index": 0, "delta": delta, "finish_reason": None}]},
            {**head, "object": "chat.completion.chunk", "usage": usage,
             "choices": [{"index": 0, "delta": {}, "finish_reason": finish}]},
        ]
        body = "".join(f"data: {json.dumps(c)}\n\n" for c in chunks) + "data: [DONE]\n\n"
        return Response(body, media_type="text/event-stream")

    # --- routes -----------------------------------------------------------

    def _app(self) -> FastAPI:
        app = FastAPI()
        api = "/api/agentic"
        mail = api + "/agents/{aid}/email"

        @app.exception_handler(StarletteHTTPException)
        async def http_error(request: Request, exc: StarletteHTTPException):
            return _envelope(request, exc.status_code, exc.detail)

        @app.exception_handler(RequestValidationError)
        async def validation_error(request: Request, exc: RequestValidationError):
            errors = [{**e, "ctx": {k: str(v) for k, v in e["ctx"].items()}} if "ctx" in e else e for e in exc.errors()]
            return _envelope(request, 422, errors)

        @app.exception_handler(Exception)
        async def server_error(request: Request, exc: Exception):
            return _envelope(request, 500, "Internal Server Error")

        @app.middleware("http")
        async def log_calls(request: Request, call_next):
            auth = request.headers.get("authorization") or ""
            call = {
                "method": request.method,
                "path": request.url.path,
                "query": dict(request.query_params),
                "api_key": auth.removeprefix("Bearer ") or None,
            }
            self.calls.append(call)
            response = await call_next(request)
            call["status"] = response.status_code
            return response

        @app.get(api + "/mm/channels")
        async def channels():
            return self.snapshot()

        @app.get(api + "/mm/channels/{cid}/posts")
        async def posts(cid: str, limit: int = 50, offset: int = 0, after_post_id: int | None = None):
            limit = max(1, min(limit, 200))
            with self.lock:
                rows = [
                    dict(p) for p in self.posts
                    if p["channel_id"] == cid and p["status"] in ("streaming", "published") and not p.get("deleted")
                ]
            has_more = False
            if after_post_id is None:
                rows = rows[::-1][offset:offset + limit]
            else:
                rows = [p for p in rows if p["post_id"] > after_post_id]
                has_more = len(rows) > limit
                rows = rows[:limit]
            return {"posts": rows, "total": len(rows), "limit": limit, "offset": offset, "has_more": has_more}

        @app.post(api + "/mm/channels/{cid}/posts")
        async def create_post(cid: str, request: Request):
            body = await request.json()
            return self._add_post(
                cid, body.get("message") or "", agent_id=self.agent_id, name=self.agent_id,
                status=body.get("status") or "published", parent_post_id=body.get("parent_post_id"),
            )

        @app.patch(api + "/mm/channels/{cid}/posts/{pid}")
        async def patch_post(cid: str, pid: int, body: _PatchBody):
            with self.lock:
                post = next(
                    (p for p in self.posts if p["post_id"] == pid and p["channel_id"] == cid and not p.get("deleted")),
                    None,
                )
                if post is None:
                    raise HTTPException(404, "Post not found")
                if post["agent_id"] != self.agent_id:
                    raise HTTPException(403, "Not the post owner")
                if post["status"] != "streaming":
                    raise HTTPException(409, "post is not streaming")
                if body.cancel:
                    post["deleted"] = True
                    return Response(status_code=204)
                if body.append is not None:
                    post["message"] += body.append
                elif body.replace is not None:
                    post["message"] = body.replace
                if body.done:
                    post["status"] = "published"
                row = dict(post)
            if body.done:
                self._publish(row)
            return row

        @app.post(api + "/mm/channels/{cid}/status")
        async def channel_status(cid: str):
            return {"ok": True}

        @app.post(api + "/mm/channels/{cid}/read")
        async def mark_read(cid: str, body: _ReadBody):
            with self.lock:  # clamped to the newest existing post at or below the ack
                ids = [p["post_id"] for p in self.posts if p["channel_id"] == cid and p["post_id"] <= body.post_id]
                if ids:
                    self.read_ptr[cid] = max(self.read_ptr.get(cid, 0), max(ids))
                return {"channel_id": cid, "last_read_post_id": self.read_ptr.get(cid, 0)}

        @app.post(api + "/alive")
        async def alive():
            return {"ok": True}

        @app.get(api + "/agents/{aid}/info")
        async def info(aid: str):
            if self.identity_status != 200:
                raise HTTPException(self.identity_status, "identity unavailable")
            return {"agent_id": self.agent_id, "org_id": "org-test", "operator_id": OPERATOR_ID,
                    "operator_email": OPERATOR_EMAIL, "operator_display_name": "Op"}

        @app.get(api + "/mm/teams/{aid}/operator-channel")
        async def operator_channel(aid: str):
            if self.identity_status != 200:
                raise HTTPException(self.identity_status, "identity unavailable")
            return {"channel_id": OPERATOR_DM, "channel_type": "direct", "name": OPERATOR_DM,
                    "created_at": "2026-01-01 00:00:00"}

        @app.get(api + "/automations/desired")
        async def automations_desired():
            return {"automations": []}

        @app.post(api + "/automations/state")
        async def automations_state():
            return {"ok": True}

        @app.get(mail + "/count")
        async def email_count(aid: str):
            with self.lock:
                unread = sum(not e["is_read"] for e in self.emails)
                return {"total": len(self.emails), "unread": unread, "email_address": self.mailbox}

        @app.get(mail + "/inbox")
        async def email_inbox(aid: str, limit: int = 50, offset: int = 0, unread_only: bool = False):
            with self.lock:
                rows = sorted(self.emails, key=lambda e: -e["uid"])
                unread = sum(not e["is_read"] for e in rows)
                if unread_only:
                    rows = [e for e in rows if not e["is_read"]]
                page = [self._summary(e) for e in rows[offset:offset + limit]]
            return {"emails": page, "total": len(rows), "unread_count": unread, "limit": limit, "offset": offset}

        @app.get(mail + "/changes")
        async def email_changes(
            aid: str, after_uid: int = 0, uidvalidity: int | None = None,
            through_uid: int | None = None, limit: int = 50,
        ):
            self._check_epoch(uidvalidity)
            limit = max(1, min(limit, 200))
            with self.lock:
                newest = self.uidnext - 1
                through = newest if through_uid is None else min(through_uid, newest)
                after = max(after_uid, 0)
                uids = sorted(e["uid"] for e in self.emails if after < e["uid"] <= through)
                page, has_more = uids[:limit], len(uids) > limit
                return {
                    "uidvalidity": self.uidvalidity, "through_uid": through,
                    "emails": [self._summary(self._email(uid)) for uid in page],
                    "next_after_uid": page[-1] if has_more else max(after, through), "has_more": has_more,
                }

        @app.get(mail + "/deliveries/{key}")
        async def email_delivery(aid: str, key: str):
            if key not in self.deliveries:
                raise HTTPException(404, {"code": "delivery_not_found"})
            return self.deliveries[key]

        @app.post(mail + "/send")
        async def email_send(aid: str, request: Request):
            body = await request.json()
            key = request.headers.get("idempotency-key")
            base = {"from_addr": self.mailbox, "to_addr": OPERATOR_EMAIL, "subject": body.get("subject")}
            if key is None:
                self.sent.append({**body, "idempotency_key": None})
                return {"status": "sent", **base}
            if not _IDEMPOTENCY_KEY.fullmatch(key):
                raise HTTPException(400, {"code": "invalid_idempotency_key"})
            digest = hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()
            with self.lock:
                if key in self.deliveries:
                    if self._send_hashes[key] != digest:
                        raise HTTPException(409, {"code": "idempotency_key_reused"})
                    return self.deliveries[key]
                state = self.send_state
                self._send_hashes[key] = digest
                self.deliveries[key] = {
                    "status": "sent" if state == "accepted" else state, **base,
                    "delivery_id": len(self.deliveries) + 1, "idempotency_key": key, "state": state,
                    "message_id": f"<{key}@mail.example.com>", "attempts": 1,
                }
                if state == "accepted":
                    self.sent.append({**body, "idempotency_key": key})
                return self.deliveries[key]

        @app.get(mail + "/{uid}")
        async def email_get(
            aid: str, uid: int, uidvalidity: int | None = None, mark_read: bool = True,
            attachment_content: bool = True,
        ):
            self._check_epoch(uidvalidity)
            with self.lock:
                email = self._email(uid)
                if email is None:
                    raise HTTPException(404, f"Email with UID {uid} not found")
                detail = dict(email)
                if mark_read:
                    email["is_read"] = True
            if not attachment_content:
                detail["attachments"] = [{**a, "content_b64": None} for a in detail["attachments"]]
            return detail

        @app.delete(mail + "/{uid}")
        async def email_delete(aid: str, uid: int, uidvalidity: int | None = None):
            self._check_epoch(uidvalidity)
            with self.lock:
                email = self._email(uid)
                if email is None:
                    raise HTTPException(404, f"Email with UID {uid} not found")
                self.emails.remove(email)
            return {"status": "deleted", "agent_id": aid, "message_uid": uid}

        @app.websocket(api + "/mm/events/ws")
        async def events(ws: WebSocket):
            auth = ws.headers.get("authorization") or ""
            self.calls.append({"method": "WS", "path": ws.url.path, "query": dict(ws.query_params),
                               "api_key": auth.removeprefix("Bearer ") or None})
            if not self.ws_enabled:
                await ws.close(code=1013)
                return
            await ws.accept()
            queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
            self._ws_loop = asyncio.get_running_loop()
            await ws.send_json({"type": "snapshot", "data": self.snapshot()})
            self._ws_clients.add(queue)
            self.ws_accepted += 1

            async def pump() -> None:
                while True:
                    await ws.send_json(await queue.get())

            sender = asyncio.create_task(pump())
            try:
                while True:
                    await ws.receive_text()
            except WebSocketDisconnect:
                pass
            finally:
                self._ws_clients.discard(queue)
                sender.cancel()

        @app.get("/v1/models")
        async def models():
            return {"object": "list", "data": [{"id": MODEL, "object": "model", "context_length": 65536}]}

        @app.post("/v1/chat/completions")
        async def chat_completions(request: Request):
            body = await request.json()
            with self.lock:
                self.model_requests.append(body)
            if is_reader_request(body):
                return self._completion(self.reader_reply, bool(body.get("stream")))
            gate = self._gate
            if gate is not None:
                await asyncio.to_thread(gate.wait, 120)
            with self.lock:
                reply = self._replies.pop(0) if self._replies else "stub reply"
            return self._completion(reply, bool(body.get("stream")))

        return app
