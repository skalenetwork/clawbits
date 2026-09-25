"""Self-checks for the harness: the fake's backend contract and the Gateway driver features."""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any

import pytest
from fake_clawbits import OPERATOR_CHAT, OPERATOR_DM, FakeClawbits, tool

MAIL = "/api/agentic/agents/agent-x/email"


@pytest.fixture
def fake(request) -> FakeClawbits:
    fake = FakeClawbits()
    request.addfinalizer(fake.close)
    return fake


def _http(fake: FakeClawbits, method: str, path: str, body: Any = None, headers: dict[str, str] | None = None):
    """(status, decoded JSON body or None) for one request to the fake."""
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(
        fake.base_url + path, data=data, method=method, headers={"Content-Type": "application/json", **(headers or {})}
    )
    try:
        with urllib.request.urlopen(request) as response:
            status, raw = response.status, response.read()
    except urllib.error.HTTPError as exc:
        status, raw = exc.code, exc.read()
    return status, json.loads(raw) if raw else None


def _attention(post: dict[str, Any]) -> dict[str, Any]:
    return {"type": "lobstertalk.consider", "channel_id": post["channel_id"], "data": post}


def test_fake_errors_use_the_backend_envelope(fake):
    fake.identity_status = 503
    status, body = _http(fake, "GET", "/api/agentic/agents/agent-x/info")
    assert (status, body["error"], body["detail"], body["path"]) == (503, True, "identity unavailable", "/api/agentic/agents/agent-x/info")
    status, body = _http(fake, "GET", "/api/agentic/nope")
    assert (status, body["status_code"], body["path"]) == (404, 404, "/api/agentic/nope")
    status, body = _http(fake, "POST", f"/api/agentic/mm/channels/{OPERATOR_DM}/read", {})
    assert status == 422 and body["error"] is True and body["detail"][0]["loc"] == ["body", "post_id"], body
    status, body = _http(fake, "POST", f"/api/agentic/mm/channels/{OPERATOR_DM}/posts", ["not", "an", "object"])
    assert (status, body["detail"]) == (500, "Internal Server Error")


def test_fake_posts_follow_the_backend_state_machine(fake):
    base = f"/api/agentic/mm/channels/{OPERATOR_DM}/posts"
    human = fake.post("hello")
    fake._add_post(OPERATOR_DM, "held for approval", name="Op", human_id=7, status="draft")
    _, stream = _http(fake, "POST", base, {"message": "", "status": "streaming"})
    _, other = _http(fake, "POST", base, {"message": "", "status": "streaming"})

    _, page = _http(fake, "GET", base + "?after_post_id=0")
    assert [p["post_id"] for p in page["posts"]] == [human["post_id"], stream["post_id"], other["post_id"]]
    for patch in ({}, {"append": "a", "replace": "b"}, {"cancel": True, "done": True}, {"append": "x" * 4001},
                  {"replace": "x" * 40001}, {"append": "a", "extra": 1}):
        status, body = _http(fake, "PATCH", f"{base}/{stream['post_id']}", patch)
        assert status == 422 and body["error"] is True, (patch, body)
    assert _http(fake, "PATCH", f"{base}/{human['post_id']}", {"done": True})[0] == 403
    assert _http(fake, "PATCH", f"/api/agentic/mm/channels/pub/posts/{stream['post_id']}", {"done": True})[0] == 404

    assert _http(fake, "PATCH", f"{base}/{stream['post_id']}", {"append": "Hel"})[1]["message"] == "Hel"
    status, body = _http(fake, "PATCH", f"{base}/{stream['post_id']}", {"replace": "Hello", "done": True})
    assert (status, body["message"], body["status"]) == (200, "Hello", "published")
    status, body = _http(fake, "PATCH", f"{base}/{stream['post_id']}", {"append": "!"})
    assert (status, body["detail"]) == (409, "post is not streaming")
    assert _http(fake, "PATCH", f"{base}/{other['post_id']}", {"cancel": True}) == (204, None)
    assert _http(fake, "PATCH", f"{base}/{other['post_id']}", {"done": True})[0] == 404

    status, body = _http(fake, "POST", f"/api/agentic/mm/channels/{OPERATOR_DM}/read", {"post_id": 10**6})
    assert body["last_read_post_id"] == other["post_id"], body  # clamped to the newest post at or below


def test_fake_email_changes_keyed_send_and_deliveries(fake):
    fake.add_email(subject="status?", body="how is it going", sender_auth={"verdict": "pass"})
    status, body = _http(fake, "GET", MAIL + "/changes?after_uid=0&uidvalidity=1")
    assert status == 200 and [e["uid"] for e in body["emails"]] == [1] and body["next_after_uid"] == 1, body
    status, body = _http(fake, "GET", MAIL + "/changes?after_uid=0&uidvalidity=9")
    assert (status, body["detail"]) == (409, {"code": "mailbox_epoch_changed", "uidvalidity": 1})
    status, body = _http(fake, "GET", MAIL + "/1?mark_read=false&attachment_content=false")
    assert status == 200 and body["sender_auth"] == {"verdict": "pass"} and not fake.emails[0]["is_read"]

    reply = {"subject": "Re: status?", "message": "fine"}
    s1, r1 = _http(fake, "POST", MAIL + "/send", reply, {"Idempotency-Key": "k1"})
    s2, r2 = _http(fake, "POST", MAIL + "/send", reply, {"Idempotency-Key": "k1"})
    s3, r3 = _http(fake, "POST", MAIL + "/send", {**reply, "message": "other"}, {"Idempotency-Key": "k1"})
    assert (s1, s2, s3) == (200, 200, 409) and r1 == r2 and r1["state"] == "accepted", (r1, r3)
    assert r3["detail"] == {"code": "idempotency_key_reused"} and len(fake.sent) == 1
    assert _http(fake, "POST", MAIL + "/send", reply, {"Idempotency-Key": "bad key"})[0] == 400
    status, body = _http(fake, "GET", MAIL + "/deliveries/k1")
    assert status == 200 and body["message_id"] == r1["message_id"]
    status, body = _http(fake, "GET", MAIL + "/deliveries/nope")
    assert (status, body["detail"]) == (404, {"code": "delivery_not_found"})


def test_hold_release_and_scripted_tool_calls(gateway):
    async def scenario(gw):
        config = str(gw.home / "config.yaml")
        gw.fake.script(tool("skills_list"), [tool("read_file", path=config), tool("skills_list")], "done")
        gate = gw.fake.hold_model()
        start, m = len(gw.fake.posts), len(gw.fake.model_requests)
        post = gw.fake.post("plan it")
        await gw.wait_for(lambda: len(gw.fake.model_requests) > m)
        assert gw.fake.read_ptr.get(OPERATOR_DM, 0) < post["post_id"] and gw.busy(OPERATOR_DM)
        gate.set()
        await gw.settled(post)

        assert gw.replies(start, OPERATOR_DM)[-1] == "done", gw.dump()
        requests = gw.fake.model_requests[m:]
        results = [[msg for msg in r["messages"] if msg.get("role") == "tool"] for r in requests]
        assert [len(r) for r in results] == [0, 1, 3], gw.dump()
        assert '"skills"' in results[-1][0]["content"] and "stub-model" in results[-1][1]["content"], gw.dump()
        assert [role for role, _ in gw.transcript()].count("tool") == 3

    gateway(scenario)


def test_restart_catch_up_and_ws_push(gateway):
    async def scenario(gw):
        assert gw.fake.ws_connected  # start() waits for the events WebSocket
        await gw.settled(gw.fake.post("first"))
        await gw.stop()
        gw.fake.post("missed one")
        missed = gw.fake.post("missed two")
        seen = len(gw.events)
        await gw.start()
        await gw.settled(missed)
        assert str(missed["post_id"]) in [e.message_id for e in gw.events[seen:]], gw.dump()

        pub = gw.fake.post("anyone around?", channel="pub", human_id=8, name="Bob")
        await gw.push_ws(_attention(pub))
        await gw.wait_for(lambda: str(pub["post_id"]) in [e.message_id for e in gw.events])
        assert {c["api_key"] for c in gw.fake.calls if c["path"].startswith("/api/agentic/")} == {"cb-test-key"}

    gateway(scenario)


def test_push_ws_waits_for_a_refused_socket_to_reconnect(gateway):
    async def scenario(gw):
        await gw.settled(gw.fake.post("still there?"))
        assert not gw.fake.ws_connected and gw.fake.ws_accepted == 0
        with pytest.raises(AssertionError, match="not connected"):
            gw.fake.push_ws({"type": "automation.sync"})

        gw.fake.ws_enabled = True
        pub = gw.fake.post("anyone around?", channel="pub", human_id=8, name="Bob")
        await gw.push_ws(_attention(pub), timeout=30)
        await gw.wait_for(lambda: str(pub["post_id"]) in [e.message_id for e in gw.events])

    gateway.fake.ws_enabled = False
    gateway(scenario)


def test_operator_agent_chat_room_without_identity(gateway):
    async def scenario(gw):
        post = gw.fake.post("in a named chat", channel=OPERATOR_CHAT)
        await gw.settled(post)
        assert [e.source.chat_id for e in gw.events if e.message_id == str(post["post_id"])] == [OPERATOR_CHAT]
        assert gw.replies(channel=OPERATOR_CHAT), gw.dump()

    gateway.fake.identity_status = 503
    gateway(scenario)
