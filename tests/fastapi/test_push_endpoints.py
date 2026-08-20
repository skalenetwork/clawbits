"""Web-push subscribe is an SSRF sink: the client picks a URL, the server
POSTs to it.

``endpoint`` used to be a bare ``str`` with no scheme, host or length check,
stored verbatim and handed to pywebpush — which does a plain ``requests.post``
that follows redirects. Any authenticated human could aim it at an internal
service and fire it by triggering a post they didn't author (agent replies
carry ``human_id=None``, so the author-exclusion filter excludes nobody).

These tests pin the validation, the VAPID gate, and the device-row ownership
check.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from clawbits.db.models import PushDevice
from clawbits.realtime import web_push
from clawbits.realtime.web_push import BSLASH
from clawbits.ssrf import UnsafeHostError
from tests.fastapi._auth_helpers import auth_headers, login_human

# Shaped like a real FCM subscription; the host is what matters.
GOOD_ENDPOINT = "https://fcm.googleapis.com/fcm/send/cJKlMnOpQrS:APA91bF_" + "x" * 60
KEYS = {"p256dh": "BN" + "a" * 85, "auth": "c" * 22}


@pytest.fixture
def vapid(monkeypatch):
    """Configure VAPID so the routes are reachable at all."""
    monkeypatch.setattr(web_push, "VAPID_PUBLIC_KEY", "BPublicKeyStub")
    monkeypatch.setattr(web_push, "VAPID_PRIVATE_KEY", "PrivateKeyStub")


@pytest.fixture
def public_dns(monkeypatch):
    """Resolve every name to a public address.

    Patches ``clawbits.ssrf._resolve`` rather than ``socket.getaddrinfo`` —
    that module's ``socket`` is the stdlib module itself, so patching the
    latter would redirect the database and Redis clients too (see the
    docstring on ``_resolve``).
    """
    monkeypatch.setattr("clawbits.ssrf._resolve", lambda host: ["93.184.216.34"])


def _subscribe(tc: TestClient, token: str, endpoint: str):
    return tc.post(
        "/api/push/web/subscribe",
        headers=auth_headers(token),
        json={"endpoint": endpoint, "keys": KEYS},
    )


def _devices(engine, token: str) -> list[PushDevice]:
    with Session(engine) as db:
        return list(db.exec(select(PushDevice).where(PushDevice.token == token)).all())


def test_accepts_a_real_push_service_endpoint(test_client, _test_engine, vapid, public_dns):
    token, _ = login_human(test_client, "push-ok@clawbits.ai")
    resp = _subscribe(test_client, token, GOOD_ENDPOINT)
    assert resp.status_code == 200, resp.text
    assert len(_devices(_test_engine, GOOD_ENDPOINT)) == 1


@pytest.mark.parametrize(
    ("endpoint", "why"),
    [
        ("http://fcm.googleapis.com/fcm/send/abc", "plain http"),
        ("file:///etc/passwd", "non-http scheme"),
        ("https://169.254.169.254/latest/meta-data/", "cloud metadata service"),
        ("https://localhost:8080/internal", "loopback"),
        ("https://evil.example.com/collect", "public, but not a push service"),
        ("https://fcm.googleapis.com.evil.example/x", "suffix-confusion on the allowlist"),
        ("https://storage.googleapis.com/bucket/x", "a Google API that is not FCM"),
        ("https://evil.example.com/.push.apple.com", "push host only in the path"),
        ("https://fcm.googleapis.com/" + "a" * 4096, "over the length cap"),
        # Parser-confusion: httpx reads everything before the "@" as userinfo
        # and reports the allowlisted trailing host, while requests treats the
        # backslash as a path separator and dials the LEADING name. Vetting one
        # host and dialing another defeats both the allowlist and the
        # private-address guard, so these must never be stored.
        (
            "https://attacker.example" + BSLASH + "@fcm.googleapis.com/x",
            "backslash-before-@ splits the host between parsers",
        ),
        (
            "https://127.0.0.1" + BSLASH + "@fcm.googleapis.com/x",
            "same trick pointed at loopback",
        ),
        (
            "https://169.254.169.254" + BSLASH + "@web.push.apple.com/x",
            "same trick pointed at cloud metadata",
        ),
        ("https://user:pw@fcm.googleapis.com/x", "userinfo on an allowlisted host"),
        ("https://evil.example.com@fcm.googleapis.com/x", "userinfo masquerade"),
        ("https://fcm.googleapis.com\t/x", "tab in the authority"),
        ("https://fcm.googleapis.com\n/x", "newline in the authority"),
        ("https://fcm.googleapis.com\r/x", "carriage return in the authority"),
        ("https://fcm.googleap\u0131s.com/x", "dotless-i homoglyph (IDNA)"),
    ],
)
def test_rejects_unsafe_endpoints(test_client, _test_engine, vapid, endpoint, why):
    token, _ = login_human(test_client, "push-bad@clawbits.ai")
    resp = _subscribe(test_client, token, endpoint)
    assert resp.status_code == 422, f"{why} should be refused: {resp.status_code} {resp.text}"
    assert _devices(_test_engine, endpoint) == [], f"{why} must not be stored"


def test_private_address_behind_an_allowlisted_host_is_refused(
    test_client, _test_engine, vapid, monkeypatch
):
    """The allowlist is not the only gate — a push-service name that resolves
    inward is still refused, which is what stops a DNS-rebind."""
    monkeypatch.setattr("clawbits.ssrf._resolve", lambda host: ["127.0.0.1"])
    token, _ = login_human(test_client, "push-rebind@clawbits.ai")
    resp = _subscribe(test_client, token, GOOD_ENDPOINT)
    assert resp.status_code == 422, resp.text
    assert _devices(_test_engine, GOOD_ENDPOINT) == []


def test_subscribe_404s_without_vapid(test_client, _test_engine, public_dns, monkeypatch):
    """No keys means nothing can ever be sent, so storing rows is pure risk."""
    monkeypatch.setattr(web_push, "VAPID_PUBLIC_KEY", "")
    monkeypatch.setattr(web_push, "VAPID_PRIVATE_KEY", "")
    token, _ = login_human(test_client, "push-novapid@clawbits.ai")
    resp = _subscribe(test_client, token, GOOD_ENDPOINT)
    assert resp.status_code == 404, resp.text
    assert _devices(_test_engine, GOOD_ENDPOINT) == []


def test_subscribe_requires_a_human(test_client, vapid, public_dns):
    test_client.cookies.clear()
    resp = test_client.post(
        "/api/push/web/subscribe", json={"endpoint": GOOD_ENDPOINT, "keys": KEYS}
    )
    assert resp.status_code in (401, 403), resp.text


def test_resubscribing_someone_elses_endpoint_replaces_rather_than_rebinds(
    test_client, _test_engine, vapid, public_dns
):
    """A row belonging to someone else is destroyed and re-created, never
    mutated in place.

    Scope warning, deliberately encoded here so nobody reads more safety into
    this than it provides: because ``uq_push_devices_token`` keys on the token
    alone, the *end state* is the same either way — one row, owned by the last
    subscriber, and the victim left with none. What changes is row identity,
    i.e. the caller can no longer take over an existing row. Closing the
    eviction itself needs the natural key to become ``(human_id, token)``,
    which is a migration and is not done here.
    """
    victim_token, victim = login_human(test_client, "push-victim@clawbits.ai")
    assert _subscribe(test_client, victim_token, GOOD_ENDPOINT).status_code == 200
    rows = _devices(_test_engine, GOOD_ENDPOINT)
    assert [r.human_id for r in rows] == [int(victim["id"])]
    victim_row_id = rows[0].id

    attacker_token, attacker = login_human(test_client, "push-attacker@clawbits.ai")
    assert _subscribe(test_client, attacker_token, GOOD_ENDPOINT).status_code == 200

    rows = _devices(_test_engine, GOOD_ENDPOINT)
    assert len(rows) == 1, "the unique constraint still holds"
    assert rows[0].human_id == int(attacker["id"])
    assert rows[0].id != victim_row_id, (
        "the victim's row must be deleted and a fresh one inserted, "
        "not re-pointed at the caller"
    )
    with Session(_test_engine) as db:
        victim_rows = db.exec(
            select(PushDevice).where(PushDevice.human_id == int(victim["id"]))
        ).all()
    assert list(victim_rows) == []


def test_resubscribing_own_endpoint_refreshes_in_place(
    test_client, _test_engine, vapid, public_dns
):
    """The ownership check must not break the normal case: a browser
    re-subscribing its own endpoint keeps its row rather than churning it."""
    token, user = login_human(test_client, "push-self@clawbits.ai")
    assert _subscribe(test_client, token, GOOD_ENDPOINT).status_code == 200
    first = _devices(_test_engine, GOOD_ENDPOINT)[0]

    assert _subscribe(test_client, token, GOOD_ENDPOINT).status_code == 200
    rows = _devices(_test_engine, GOOD_ENDPOINT)
    assert len(rows) == 1
    assert rows[0].id == first.id, "re-subscribing must not churn the row"
    assert rows[0].human_id == int(user["id"])


def test_vetted_host_is_the_host_the_transport_dials():
    """The invariant behind the reject table above.

    Validation used to read the host with httpx while the send dialed it with
    requests. Any input the two parsers disagree about is a bypass, so the
    check now takes the host from the transport and refuses on disagreement.
    """
    hostile = "https://attacker.example" + BSLASH + "@fcm.googleapis.com/x"
    # The transport really would go somewhere else — this is the bug, not a
    # hypothetical.
    assert web_push._transport_host(hostile) == "attacker.example"
    with pytest.raises(UnsafeHostError):
        web_push.validate_push_endpoint(hostile)

    # A legitimate endpoint still passes, and vets the host it actually dials.
    web_push.validate_push_endpoint(GOOD_ENDPOINT)
    assert web_push._transport_host(GOOD_ENDPOINT) == "fcm.googleapis.com"


def test_send_refuses_a_row_that_no_longer_validates(monkeypatch):
    """Stored rows outlive the subscribe-time check, so ``_send_one`` re-vets.

    A refusal must not read as ``dead`` — that return value prunes the row,
    and a transient resolver failure would then silently delete a legitimate
    subscription.
    """
    called = []
    # ``_send_one`` does ``from pywebpush import webpush`` at call time, so the
    # attribute has to be replaced on pywebpush itself, not on web_push.
    monkeypatch.setattr("pywebpush.webpush", lambda **kw: called.append(kw))
    target = {"id": 1, "token": "https://evil.example.com/x", "p256dh": "p", "auth": "a"}
    assert web_push._send_one(target, "{}") == "error"
    assert called == [], "must not dial an endpoint that failed validation"


def test_send_session_refuses_redirects():
    """pywebpush calls ``requests.post`` with no ``allow_redirects``, and the
    library default is True — an allowlisted host answering 307 would
    otherwise bounce our POST anywhere."""
    captured = {}

    class _Probe(web_push._no_redirect_session_class()):
        def send(self, request, **kwargs):  # noqa: ANN001
            captured.update(kwargs)
            raise RuntimeError("stop before the socket")

    probe = _Probe()
    with pytest.raises(RuntimeError):
        probe.post("https://fcm.googleapis.com/x", data=b"", allow_redirects=True)
    assert captured["allow_redirects"] is False
