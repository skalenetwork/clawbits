"""Web Push (VAPID) — self-hosted browser push, no third-party SaaS.

We talk straight to the browser's own push service (Chrome→Google,
Firefox→Mozilla, Safari→Apple) signing each request with a VAPID keypair
*we* own. There is no notification vendor in the path; the keypair is the
only credential.

Keys are stored per env via dotenvx: the private key encrypted, the public
key + subject ``--plain`` (neither is secret — the public key is the
browser's applicationServerKey). The only secret that never lands in git is
dotenvx's own decryption key (``DOTENV_PRIVATE_KEY_<ENV>``). When VAPID is
unset the whole web-push path degrades to a no-op so dev/test runs without
keys don't error and the subscribe UI stays hidden.

Generate a keypair + the ready-to-run dotenvx commands to store it:

    uv run python -m clawbits.realtime.web_push --generate-keys --env staging
    # omit --env to emit a separate keypair (and command set) for all three

The post-created path enqueues via :func:`schedule_post_web_push` (non-blocking,
thread-safe); a lifespan-owned worker (:func:`start_push_dispatcher`) drains the
queue and runs :func:`dispatch_post_web_push` off the request path. See below.
"""

from __future__ import annotations

import asyncio
import functools
import json
import logging
import os

from clawbits.domain import APP_URL

log = logging.getLogger(__name__)

# Bound concurrent sends so a fan-out to a large channel doesn't open
# hundreds of sockets at once. Each send is a short HTTP/2 POST.
_MAX_CONCURRENCY = 8

# base64url raw EC P-256, the format the browser's `applicationServerKey`
# wants. Public half goes to the browser, private half signs our sends.
VAPID_PUBLIC_KEY = os.environ.get("CLAWBITS_VAPID_PUBLIC_KEY", "").strip()
VAPID_PRIVATE_KEY = os.environ.get("CLAWBITS_VAPID_PRIVATE_KEY", "").strip()
# Contact URI baked into the VAPID JWT `sub` claim — push services may use
# it to reach us about a misbehaving sender. mailto: or https: URL.
VAPID_SUBJECT = os.environ.get("CLAWBITS_VAPID_SUBJECT", "").strip() or "mailto:support@clawbits.ai"

# A client-supplied URL the server POSTs to, i.e. an SSRF sink: scheme pinned,
# host vetted, no redirects. The browser only ever hands us a real push service,
# so an allowlist is affordable and a private-address check alone would still
# permit a blind POST to any public host.
#
# FCM is pinned to exact hosts, not a ``.googleapis.com`` suffix, which would
# clear every other Google API. The other three vary by shard.
_PUSH_HOSTS = frozenset(
    {
        "fcm.googleapis.com",       # FCM — Chrome, Edge (Chromium), Brave
        "android.googleapis.com",   # legacy GCM endpoint, still issued
    }
)
_PUSH_HOST_SUFFIXES = (
    ".push.services.mozilla.com",   # Firefox
    ".push.apple.com",              # Safari / macOS + iOS
    ".notify.windows.com",          # WNS — legacy Edge
)

# Endpoints are ~150-500 chars in practice. The DB column is untyped-length
# ``Text`` (models.PushDevice.token), so this is the only cap that exists.
MAX_ENDPOINT_LEN = 2048

# Named, because a bare backslash literal in the check below reads as a typo.
BSLASH = "\\"


def _extra_push_hosts() -> frozenset[str]:
    """Hostnames the operator has cleared in addition to the real push
    services — a self-hosted or dev push relay is the motivating case.
    Comma-separated in ``CLAWBITS_PUSH_ALLOW_HOSTS``; empty by default,
    because the endpoint is chosen by whoever calls subscribe."""
    raw = os.environ.get("CLAWBITS_PUSH_ALLOW_HOSTS", "")
    return frozenset(h.strip().lower() for h in raw.split(",") if h.strip())


def _transport_host(endpoint: str) -> str:
    """The host ``requests`` will actually dial, resolved by its own pipeline.

    Vetting a URL with one parser and dialing it with another is an exploitable
    gap, so the authoritative answer has to come from the library that opens
    the socket — not from httpx, which we use only for the shared SSRF helpers.
    """
    import urllib3
    from requests.models import PreparedRequest

    pr = PreparedRequest()
    pr.prepare_url(endpoint, None)  # requote/IDNA exactly as a real send would
    return (urllib3.util.parse_url(pr.url).host or "").lower()


def validate_push_endpoint(endpoint: str) -> None:
    """Raise :class:`clawbits.ssrf.UnsafeHostError` unless ``endpoint`` is a
    real push-service URL we are willing to POST to.

    Called both when a browser subscribes — immediate feedback, and it keeps
    junk out of the table — and again immediately before every send, because
    the first check alone constrains only what someone is willing to store,
    not where the name points by the time we dial it.

    The host is taken from the *transport's* parser and cross-checked against
    httpx's. The two disagree on an authority containing a backslash before an
    ``@``: httpx reads everything up to the ``@`` as userinfo and reports the
    trailing (allowlisted) host, while requests treats the backslash as a path
    separator and dials the *leading* name instead. Vetting one host and
    connecting to another defeats both the allowlist and the private-address
    check, so anything the two parsers disagree about is refused outright.
    """
    from clawbits.ssrf import UnsafeHostError, check_host_is_public, dialed_host, parse_url

    # The base error, not PrivateAddressError: this rejection has nothing to do
    # with a resolved address, and the log line should not imply one.
    if len(endpoint) > MAX_ENDPOINT_LEN:
        raise UnsafeHostError(
            f"push endpoint too long: {len(endpoint)} > {MAX_ENDPOINT_LEN}"
        )

    # Characters the two parsers disagree about, refused before either sees
    # them: backslash is the live bypass, controls get silently stripped by
    # some parsers, non-ASCII would go through IDNA. No real endpoint needs any.
    if not endpoint.isascii():
        raise UnsafeHostError("push endpoint must be ASCII")
    forbidden = {
        c for c in endpoint if c == BSLASH or c.isspace() or ord(c) < 0x20 or ord(c) == 0x7F
    }
    if forbidden:
        raise UnsafeHostError(f"push endpoint contains forbidden characters: {sorted(forbidden)!r}")

    # parse_url turns an unparseable URL into an UnsafeHostError rather than
    # letting it escape as a 500.
    url = parse_url(endpoint)
    if url.scheme != "https":
        raise UnsafeHostError(f"push endpoint must be https, got {url.scheme!r}")

    # Userinfo is the other half of the confusion — it is what lets a hostile
    # host masquerade as an allowlisted one — and a real push subscription
    # never carries credentials.
    if url.userinfo:
        raise UnsafeHostError("push endpoint must not contain userinfo")

    # Vet the host we actually dial, so the transport's parser wins. raw_host,
    # never .host: unicode and punycode forms can resolve differently.
    host = _transport_host(endpoint)
    if not host:
        raise UnsafeHostError("push endpoint has no host")
    httpx_host = dialed_host(url).lower()
    if host != httpx_host:
        raise UnsafeHostError(f"URL parsers disagree on the host ({host} vs {httpx_host})")
    extra = _extra_push_hosts()
    known = host in _PUSH_HOSTS or host.endswith(_PUSH_HOST_SUFFIXES)
    if host not in extra and not known:
        raise UnsafeHostError(f"not a known web-push service host: {host}")

    # An allowlisted name can still point at a private address, and an
    # operator-supplied host had no vetting. ``extra`` is also the escape hatch
    # for a deployment pushing to localhost.
    check_host_is_public(host, allow_hosts=extra)


@functools.cache
def _no_redirect_session_class() -> type:
    """The ``requests.Session`` subclass used for sends, built on first use.

    Importing ``requests`` at module scope would pull it into every process
    that touches this module, including ones with no VAPID keys that never
    send — so the import (and the class) are built lazily and cached.
    """
    import requests

    class _NoRedirectSession(requests.Session):
        """A session that refuses to follow redirects.

        pywebpush calls ``requests.post`` without ``allow_redirects`` and the
        ``requests`` default is True, so an allowlisted push host answering a
        307 would bounce our POST wherever it liked — defeating the host check
        in :func:`validate_push_endpoint`. pywebpush exposes no flag for this,
        only the ``requests_session`` seam, so we pin it on the way through.
        """

        def request(self, *args, **kwargs):
            kwargs["allow_redirects"] = False
            return super().request(*args, **kwargs)

    return _NoRedirectSession


def _new_send_session():
    """A fresh session per send.

    Not shared: ``requests.Session`` isn't thread-safe and sends run eight-way
    concurrent, and a shared jar would carry cookies between pushes to
    different services. This matches what pywebpush did before — bare
    ``requests.post`` also builds a session per call — so it costs nothing we
    weren't already paying.
    """
    return _no_redirect_session_class()()


def vapid_configured() -> bool:
    """True only when both halves of the keypair are present.

    Gates the entire web-push surface: the subscribe/unsubscribe endpoints
    404 and the fan-out dispatch returns early when this is False, so a
    deployment without keys behaves exactly as before this feature existed —
    and in particular accumulates no ``push_devices`` rows.
    """
    return bool(VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY)


def vapid_public_key() -> str | None:
    """The browser-facing applicationServerKey, or None when unconfigured."""
    return VAPID_PUBLIC_KEY or None


# Friendly env name → its dotenvx file. One keypair per env (they must differ).
_ENV_FILES = {
    "dev": ".env.development",
    "staging": ".env.staging",
    "prod": ".env.production",
}


def _gen_keypair() -> tuple[str, str]:
    """Return a fresh ``(public, private)`` VAPID keypair, base64url-encoded.

    Imported lazily so the module has no hard dependency on the crypto stack
    at import time (keeps the no-op path light)."""
    import base64

    from cryptography.hazmat.primitives import serialization
    from py_vapid import Vapid

    vapid = Vapid()
    vapid.generate_keys()

    def b64url(raw: bytes) -> str:
        return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")

    public_raw = vapid.public_key.public_bytes(
        serialization.Encoding.X962,
        serialization.PublicFormat.UncompressedPoint,
    )
    private_raw = vapid.private_key.private_numbers().private_value.to_bytes(32, "big")
    return b64url(public_raw), b64url(private_raw)


def _print_env_block(env: str, subject: str) -> None:
    """Print ready-to-run ``dotenvx set`` commands for one env's fresh keypair.

    The private key is encrypted by dotenvx (its default); the public key and
    subject are stored ``--plain`` — neither is secret (the public key is
    literally shipped to browsers as the applicationServerKey)."""
    env_file = _ENV_FILES[env]
    public, private = _gen_keypair()
    print(f"# ── VAPID keys for {env} ({env_file}) — fresh keypair ──")
    print(f"dotenvx set CLAWBITS_VAPID_PRIVATE_KEY '{private}' -f {env_file}")
    print(f"dotenvx set CLAWBITS_VAPID_PUBLIC_KEY '{public}' --plain -f {env_file}")
    print(f"dotenvx set CLAWBITS_VAPID_SUBJECT '{subject}' --plain -f {env_file}")
    print()


# The fan-out is slow external HTTP (seconds per send) and must never run
# inline in ``publish_post_created``, which ``fire_and_forget`` runs to
# completion — on a threadpool thread for sync endpoints. So that path enqueues
# and a single lifespan-owned worker drains the queue.

# Cap the backlog so a burst of posts can't grow memory without bound. A dropped
# push degrades to the recipient's in-app unread badge (SSE) plus the snapshot
# they reconcile on reconnect, so shedding the oldest job is acceptable.
_MAX_QUEUE = 10_000

_queue: asyncio.Queue[tuple[str, dict, list[int]]] | None = None
_worker_task: asyncio.Task[None] | None = None
_main_loop: asyncio.AbstractEventLoop | None = None


def start_push_dispatcher() -> None:
    """Start the background push worker. Call once from the app lifespan while
    the event loop is running. No-op when no transport is configured (the
    whole push surface is inert then) or when already started."""
    global _queue, _worker_task, _main_loop
    from clawbits.realtime.apns_push import apns_configured

    if not vapid_configured() and not apns_configured():
        log.info("push: no transport configured — dispatcher not started")
        return
    if _worker_task is not None:
        return
    _main_loop = asyncio.get_running_loop()
    _queue = asyncio.Queue(maxsize=_MAX_QUEUE)
    _worker_task = _main_loop.create_task(_dispatch_worker(_queue))
    log.info("web push: background dispatcher started")


async def stop_push_dispatcher() -> None:
    """Cancel the worker on shutdown. Mirrors :func:`start_push_dispatcher`."""
    global _queue, _worker_task, _main_loop
    task = _worker_task
    _worker_task = None
    _queue = None
    _main_loop = None
    if task is None:
        return
    task.cancel()
    try:
        await task
    except (asyncio.CancelledError, Exception):
        pass


def schedule_post_web_push(
    channel_id: str, post: dict, member_human_ids: list[int]
) -> None:
    """Enqueue a post's browser-push fan-out and return immediately.

    Safe to call from any thread: the post-created publish runs on the main
    loop for async endpoints but on a threadpool thread for sync ones (agent
    posts), so we hop onto the dispatcher's loop via ``call_soon_threadsafe``
    rather than touching the ``asyncio.Queue`` (not thread-safe) directly. No-op
    when the dispatcher isn't running — VAPID unconfigured, or before startup /
    after shutdown.
    """
    loop = _main_loop
    if loop is None or _queue is None or not member_human_ids:
        return
    loop.call_soon_threadsafe(_enqueue, channel_id, post, member_human_ids)


def _enqueue(channel_id: str, post: dict, member_human_ids: list[int]) -> None:
    """Put one job on the queue (runs on the dispatcher loop, where Queue access
    is safe). Sheds the oldest job when the backlog is full rather than blocking
    the producer or growing memory."""
    if _queue is None:
        return
    job = (channel_id, post, member_human_ids)
    try:
        _queue.put_nowait(job)
    except asyncio.QueueFull:
        try:
            _queue.get_nowait()  # evict oldest, then retry once
            _queue.task_done()
            _queue.put_nowait(job)
        except (asyncio.QueueEmpty, asyncio.QueueFull):
            log.warning("web push: queue full — dropped push for %s", channel_id)


async def _dispatch_worker(queue: asyncio.Queue[tuple[str, dict, list[int]]]) -> None:
    """Drain the queue forever, one fan-out at a time. Each
    ``dispatch_post_web_push`` already bounds its own send concurrency, so
    serial draining keeps total in-flight sends bounded under load. A failure in
    one job is logged and never kills the worker."""
    log.info("web push: dispatch worker running")
    while True:
        channel_id, post, member_human_ids = await queue.get()
        try:
            await dispatch_post_web_push(channel_id, post, member_human_ids)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # pragma: no cover - defensive
            log.warning("web push: dispatch job failed for %s: %s", channel_id, exc)
        finally:
            queue.task_done()


# ---------------------------------------------------------------------------
# Dispatch — send a push to a channel's members when a post is published
# ---------------------------------------------------------------------------


async def dispatch_post_web_push(
    channel_id: str,
    post: dict,
    member_human_ids: list[int],
    author_human_id: int | None = None,
) -> None:
    """Fan a published post out to members' devices (web push + APNs).

    Called from the post-created fan-out (alongside the SSE publish). This
    is the "reach a member whose app isn't open" layer. Web pushes carry a
    service-worker payload that suppresses the OS notification when one of
    the member's tabs is focused, mirroring the desktop
    ``document.hasFocus()`` gate, so an actively-watching user never gets a
    redundant ping.

    No-op when no transport is configured. The author is excluded (derived
    from the post when not passed); muted members are skipped (they still
    get the in-app unread badge over SSE). All blocking work — DB reads and
    the sends — runs in worker threads so the event loop stays free. Dead
    subscriptions (push service reports the token gone) are pruned.
    """
    from clawbits.realtime.apns_push import apns_configured

    if not member_human_ids:
        return
    if not vapid_configured() and not apns_configured():
        return
    if author_human_id is None and isinstance(post, dict):
        author_human_id = post.get("human_id")

    try:
        prepared = await asyncio.to_thread(
            _collect_targets, channel_id, member_human_ids, author_human_id
        )
    except Exception as exc:  # pragma: no cover - defensive
        log.warning("web push: target collection failed for %s: %s", channel_id, exc)
        return
    if prepared is None:
        return
    channel_meta, targets, apns_targets = prepared
    title, body = notification_copy(channel_meta, post)

    dead_ids: list[int] = []
    if targets and vapid_configured():
        data = json.dumps(_build_payload(channel_meta, post))
        sem = asyncio.Semaphore(_MAX_CONCURRENCY)

        async def _one(target: dict) -> str:
            async with sem:
                return await asyncio.to_thread(_send_one, target, data)

        results = await asyncio.gather(*[_one(t) for t in targets])
        dead_ids.extend(
            t["id"] for t, r in zip(targets, results, strict=True) if r == "dead"
        )

    if apns_targets and apns_configured():
        from clawbits.realtime.apns_push import fan_out as apns_fan_out

        try:
            dead_ids.extend(await apns_fan_out(apns_targets, title, body, channel_id))
        except Exception as exc:  # pragma: no cover - defensive
            log.warning("apns: fan-out failed for %s: %s", channel_id, exc)

    if dead_ids:
        try:
            await asyncio.to_thread(_prune_devices, dead_ids)
        except Exception as exc:  # pragma: no cover - defensive
            log.warning("web push: prune failed: %s", exc)


def _collect_targets(
    channel_id: str, member_human_ids: list[int], author_human_id: int | None
) -> tuple[dict | None, list[dict], list[dict]] | None:
    """Resolve who to push to (off the event loop). Opens its own session.

    Returns ``(channel_meta, web_devices, apns_devices)`` or ``None`` when
    there's nobody to notify before any DB work."""
    from clawbits.db.engine import new_session
    from clawbits.db.table_read import TableRead

    candidates = [h for h in member_human_ids if h != author_human_id]
    if not candidates:
        return None
    with new_session() as session:
        muted = TableRead.get_muted_human_ids(session, channel_id, candidates)
        recipients = [h for h in candidates if h not in muted]
        if not recipients:
            return (None, [], [])
        web_devices = TableRead.get_webpush_devices_for_humans(session, recipients)
        apns_devices = TableRead.get_apns_devices_for_humans(session, recipients)
        channel_meta = TableRead.get_channel_notification_meta(session, channel_id)
    return (channel_meta, web_devices, apns_devices)


def _send_one(target: dict, data: str) -> str:
    """Send one push (blocking; runs in a thread).

    Returns ``"ok"`` | ``"dead"`` (subscription gone — prune it) | ``"error"``.
    """
    from pywebpush import WebPushException, webpush

    from clawbits.ssrf import UnsafeHostError, redact_url

    # Re-vet at dial time: the row outlives the check that let it in. Returns
    # "error", not "dead" — a resolver blip must not prune a live subscription.
    try:
        validate_push_endpoint(target["token"])
    except UnsafeHostError as exc:
        log.warning("web push: refusing endpoint %s: %s", redact_url(target["token"]), exc)
        return "error"

    subscription = {
        "endpoint": target["token"],
        "keys": {"p256dh": target["p256dh"], "auth": target["auth"]},
    }
    try:
        webpush(
            subscription_info=subscription,
            data=data,
            vapid_private_key=VAPID_PRIVATE_KEY,
            # Fresh dict per call — pywebpush mutates it (adds exp/aud).
            vapid_claims={"sub": VAPID_SUBJECT},
            content_encoding="aes128gcm",
            timeout=10,
            # Without this pywebpush uses the bare ``requests`` module, which
            # follows redirects by default. A 30x now surfaces as a >202 status
            # (an "error", not "dead"), so the row survives.
            requests_session=_new_send_session(),
        )
        return "ok"
    except WebPushException as exc:
        status = exc.response.status_code if exc.response is not None else None
        if status in (404, 410):
            return "dead"
        log.warning("web push: send failed (status=%s)", status)
        return "error"
    except Exception as exc:  # pragma: no cover - defensive
        log.warning("web push: send error: %s", exc)
        return "error"


def _prune_devices(device_ids: list[int]) -> None:
    """Delete dead subscriptions (blocking; runs in a thread)."""
    from clawbits.db.engine import new_session
    from clawbits.db.table_write import TableWrite

    with new_session() as session:
        removed = TableWrite.prune_push_devices(session, device_ids)
        session.commit()
    if removed:
        log.info("web push: pruned %d dead subscription(s)", removed)


def notification_copy(
    channel_meta: dict | None, post: dict
) -> tuple[str, str]:
    """Notification title + body, shared by the web and APNs payloads.

    DM → title is the other person, body is the message; channel → title is
    ``#name``, body is ``Author: message`` (mirrors the desktop
    notification's author folding)."""
    is_direct = bool(channel_meta and channel_meta.get("channel_type") == "direct")
    display = None
    if channel_meta:
        display = channel_meta.get("display_name") or channel_meta.get("name")
    author = post.get("poster_display_name") or "Someone"
    if is_direct:
        return (display or author), _preview(post)
    return (f"#{display}" if display else author), f"{author}: {_preview(post)}"


def _build_payload(channel_meta: dict | None, post: dict) -> dict:
    """Service-worker payload for web pushes."""
    channel_id = (channel_meta or {}).get("channel_id") or post.get("channel_id") or ""
    author = post.get("poster_display_name") or "Someone"
    title, body = notification_copy(channel_meta, post)

    return {
        "title": title,
        "body": body,
        "author": author,
        "channelId": channel_id,
        # ABSOLUTE, on the app origin — never a bare path. A relative URL is
        # resolved by the service worker against *its own* origin, and browsers
        # that registered the SW before the apex cutover (2026-08-12, when the
        # app moved off clawbits.ai) still hold a registration on the apex. Those
        # clients opened ``clawbits.ai/channels/…``, which the marketing site
        # 404s. Sending the origin in the payload steers even those stale
        # registrations to the right host. See ``setupPushClickNavigation``,
        # which folds a same-origin absolute URL back to a path for soft nav.
        "url": f"{APP_URL}/channels/{channel_id}" if channel_id else f"{APP_URL}/",
        # Same tag per channel → a newer message replaces the older banner
        # instead of stacking, even if delivery races a streaming finalise.
        "tag": f"channel:{channel_id}",
    }


def _preview(post: dict) -> str:
    """One-line message preview for the notification body."""
    msg = (post.get("message") or "").strip()
    if msg:
        msg = " ".join(msg.split())
        return f"{msg[:140]}…" if len(msg) > 140 else msg
    files = post.get("files") or []
    if files:
        return "Sent an attachment" if len(files) == 1 else f"Sent {len(files)} attachments"
    return "New message"


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(
        prog="python -m clawbits.realtime.web_push",
        description="Generate VAPID keypair(s) and print dotenvx commands to store them.",
    )
    parser.add_argument(
        "--generate-keys",
        action="store_true",
        help="generate keypair(s) + the dotenvx commands to store them",
    )
    parser.add_argument(
        "--env",
        choices=list(_ENV_FILES),
        help="target env. Omit to emit a separate keypair for dev, staging, AND prod.",
    )
    parser.add_argument(
        "--subject",
        default="mailto:support@clawbits.ai",
        help="VAPID contact (mailto: / https:); the same value across envs is fine.",
    )
    args = parser.parse_args()

    if not args.generate_keys:
        parser.print_help()
        raise SystemExit(0)

    for env in [args.env] if args.env else list(_ENV_FILES):
        _print_env_block(env, args.subject)
