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

log = logging.getLogger(__name__)

# Bound concurrent sends so a fan-out to a large channel doesn't open
# hundreds of sockets at once. Each send is a short HTTP/2 POST.
_MAX_CONCURRENCY = 8

# VAPID keypair, base64url-encoded raw EC P-256 (the format `web-push
# generate-vapid-keys` and the browser's `applicationServerKey` use). The
# public half is handed to the browser at subscribe time; the private half
# signs outgoing push requests so the push service can attribute them to us.
VAPID_PUBLIC_KEY = os.environ.get("CLAWBITS_VAPID_PUBLIC_KEY", "").strip()
VAPID_PRIVATE_KEY = os.environ.get("CLAWBITS_VAPID_PRIVATE_KEY", "").strip()
# Contact URI baked into the VAPID JWT `sub` claim — push services may use
# it to reach us about a misbehaving sender. mailto: or https: URL.
VAPID_SUBJECT = os.environ.get("CLAWBITS_VAPID_SUBJECT", "").strip() or "mailto:support@clawbits.ai"

# The push endpoint is a *client-supplied URL the server then POSTs to*, so it
# is an SSRF sink and gets the same treatment as the LobsterTalk LLM base URL
# and link-preview unfurls: scheme pinned, host vetted, no redirects. The
# browser only ever hands us one of the four real push services, so an
# allowlist is affordable here and shrinks the reachable surface to ~nothing —
# a private-address check alone would still permit a blind POST to any public
# host on the internet.
#
# FCM is pinned to exact hosts rather than a ``.googleapis.com`` suffix: that
# suffix would also clear storage.googleapis.com and every other Google API,
# handing back a chunk of the surface the allowlist exists to remove. The other
# three genuinely vary by shard, so they match on suffix.
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


def _extra_push_hosts() -> frozenset[str]:
    """Hostnames the operator has cleared in addition to the real push
    services — a self-hosted or dev push relay is the motivating case.
    Comma-separated in ``CLAWBITS_PUSH_ALLOW_HOSTS``; empty by default,
    because the endpoint is chosen by whoever calls subscribe."""
    raw = os.environ.get("CLAWBITS_PUSH_ALLOW_HOSTS", "")
    return frozenset(h.strip().lower() for h in raw.split(",") if h.strip())


def _requests_dialed_host(endpoint: str) -> str:
    """The host ``requests`` — i.e. the library that actually sends the push —
    will connect to, via the same ``urllib3`` parser it uses internally.

    Exists because validating with a *different* parser than the one that
    dials is only a check of what we think the URL says. See
    :func:`validate_push_endpoint` for the concrete divergence this closes.

    Imported lazily to match the rest of this module: processes with no VAPID
    keys never send and shouldn't pay for ``requests``/``urllib3`` at import.
    """
    from clawbits.ssrf import UnsafeHostError

    try:
        from urllib3.util import parse_url as _urllib3_parse_url
    except Exception as exc:  # pragma: no cover - urllib3 ships with requests
        raise UnsafeHostError(f"cannot verify push endpoint host: {exc}") from exc

    try:
        parsed = _urllib3_parse_url(endpoint)
    except Exception as exc:
        raise UnsafeHostError(f"unparseable push endpoint: {exc}") from exc
    if not parsed.host:
        raise UnsafeHostError("push endpoint has no host")
    return parsed.host


def validate_push_endpoint(endpoint: str) -> None:
    """Raise :class:`clawbits.ssrf.UnsafeHostError` unless ``endpoint`` is a
    real push-service URL we are willing to POST to.

    Called both when a browser subscribes — immediate feedback, and it keeps
    junk out of the table — and again immediately before every send, because
    the first check alone constrains only what someone is willing to store,
    not where the name points by the time we dial it.

    The host is taken from the parser that *sends* (``urllib3``, via
    ``requests``, via pywebpush) rather than the one that merely parses here.
    Those two disagree on authorities containing a backslash, and the gap was
    exploitable: in ``https://169.254.169.254\\@fcm.googleapis.com/x`` httpx
    reads the host as ``fcm.googleapis.com`` — allowlisted, resolves public,
    passes every check — while urllib3 reads ``169.254.169.254`` and dials the
    metadata service. Validating on the sending parser closes the class; the
    explicit rejection of userinfo and backslashes below closes the *category*
    of authority the divergence needs, so a future parser change can't reopen
    it. Real push endpoints have neither.
    """
    from clawbits.ssrf import UnsafeHostError, check_host_is_public, dialed_host, parse_url

    # UnsafeHostError (the base) rather than PrivateAddressError for the checks
    # that aren't about the resolved address — callers catch the base, and
    # mislabelling a scheme or length rejection as "private address" would send
    # whoever reads the log looking for a DNS answer that was never involved.
    if len(endpoint) > MAX_ENDPOINT_LEN:
        raise UnsafeHostError(
            f"push endpoint too long: {len(endpoint)} > {MAX_ENDPOINT_LEN}"
        )

    # Reject the ambiguous authority outright, before any parser gets a vote.
    # A backslash is what makes the two parsers disagree, and userinfo
    # (``user@host``) is the shape that lets a bogus host sit where a reader —
    # or a parser — might take it for the real one. No push service issues
    # either, so nothing legitimate is lost.
    if "\\" in endpoint:
        raise UnsafeHostError("push endpoint must not contain a backslash")
    authority = endpoint.split("://", 1)[-1].split("/", 1)[0]
    if "@" in authority:
        raise UnsafeHostError("push endpoint must not carry userinfo")

    # parse_url turns an unparseable URL into an UnsafeHostError rather than
    # letting it escape as a 500.
    url = parse_url(endpoint)
    if url.scheme != "https":
        raise UnsafeHostError(f"push endpoint must be https, got {url.scheme!r}")

    # The authoritative host: what requests/urllib3 will actually dial.
    host = _requests_dialed_host(endpoint).lower()

    # Both parsers must agree. Belt-and-braces behind the two rejections above:
    # any *future* divergence shows up here as a refusal rather than as a
    # validated-one-host-dialed-another. ``dialed_host`` is raw_host, never
    # .host: for an internationalised name the decoded unicode form and the
    # punycode form the transport dials can resolve to different places.
    parsed_host = dialed_host(url).lower()
    if parsed_host != host:
        raise UnsafeHostError(
            f"ambiguous push endpoint host: {parsed_host!r} vs {host!r}"
        )

    extra = _extra_push_hosts()
    known = host in _PUSH_HOSTS or host.endswith(_PUSH_HOST_SUFFIXES)
    if host not in extra and not known:
        raise UnsafeHostError(f"not a known web-push service host: {host}")

    # Belt and braces behind the allowlist: an allowlisted name can still be
    # pointed at a private address, and an operator-supplied host has had no
    # vetting at all. ``extra`` doubles as the private-address escape hatch so
    # a deployment pointing push at localhost opts that name in once.
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


# ---------------------------------------------------------------------------
# Background dispatcher — runs the push fan-out off the request path
# ---------------------------------------------------------------------------
#
# Web push is slow (external HTTP to each browser's push service, up to
# ``timeout`` seconds per send). It must NOT run inline in
# ``publish_post_created``: that coroutine is run to completion by
# ``fire_and_forget`` — on a threadpool thread for sync endpoints (an agent
# posting via ``mm_create_post``) — so an inline fan-out would block that thread
# for seconds, and on the async path would stretch a GC-droppable ``create_task``
# from sub-millisecond to ~10s. Instead the post-created path calls
# ``schedule_post_web_push`` (non-blocking, thread-safe) and a single long-lived
# worker — owned by the app lifespan, pinned to the main loop — drains the queue
# and does the sending.

# Cap the backlog so a burst of posts can't grow memory without bound. A dropped
# push degrades to the recipient's in-app unread badge (SSE) plus the snapshot
# they reconcile on reconnect, so shedding the oldest job is acceptable.
_MAX_QUEUE = 10_000

_queue: asyncio.Queue[tuple[str, dict, list[int]]] | None = None
_worker_task: asyncio.Task[None] | None = None
_main_loop: asyncio.AbstractEventLoop | None = None


def start_push_dispatcher() -> None:
    """Start the background push worker. Call once from the app lifespan while
    the event loop is running. No-op when VAPID isn't configured (the whole
    web-push surface is inert then) or when already started."""
    global _queue, _worker_task, _main_loop
    if not vapid_configured():
        log.info("web push: VAPID unconfigured — dispatcher not started")
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
    """Fan a published post out to members' browsers as a Web Push.

    Called from the post-created fan-out (alongside the SSE publish). This
    is the "reach a member whose tab is closed" layer — the service worker
    suppresses the OS notification when one of the member's tabs is focused,
    mirroring the desktop ``document.hasFocus()`` gate, so an actively-
    watching user never gets a redundant ping.

    No-op when VAPID isn't configured. The author is excluded (derived from
    the post when not passed); muted members are skipped (they still get the
    in-app unread badge over SSE). All blocking work — the DB reads and the
    pywebpush sends — runs in worker threads so the event loop stays free.
    Dead subscriptions (push service returns 404/410) are pruned.
    """
    if not vapid_configured() or not member_human_ids:
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
    channel_meta, targets = prepared
    if not targets:
        return

    data = json.dumps(_build_payload(channel_meta, post))
    sem = asyncio.Semaphore(_MAX_CONCURRENCY)

    async def _one(target: dict) -> str:
        async with sem:
            return await asyncio.to_thread(_send_one, target, data)

    results = await asyncio.gather(*[_one(t) for t in targets])
    dead_ids = [t["id"] for t, r in zip(targets, results, strict=True) if r == "dead"]
    if dead_ids:
        try:
            await asyncio.to_thread(_prune_devices, dead_ids)
        except Exception as exc:  # pragma: no cover - defensive
            log.warning("web push: prune failed: %s", exc)


def _collect_targets(
    channel_id: str, member_human_ids: list[int], author_human_id: int | None
) -> tuple[dict | None, list[dict]] | None:
    """Resolve who to push to (off the event loop). Opens its own session.

    Returns ``(channel_meta, devices)`` or ``None`` when there's nobody to
    notify before any DB work."""
    from clawbits.db.engine import new_session
    from clawbits.db.table_read import TableRead

    candidates = [h for h in member_human_ids if h != author_human_id]
    if not candidates:
        return None
    with new_session() as session:
        muted = TableRead.get_muted_human_ids(session, channel_id, candidates)
        recipients = [h for h in candidates if h not in muted]
        if not recipients:
            return (None, [])
        devices = TableRead.get_webpush_devices_for_humans(session, recipients)
        channel_meta = TableRead.get_channel_notification_meta(session, channel_id)
    return (channel_meta, devices)


def _send_one(target: dict, data: str) -> str:
    """Send one push (blocking; runs in a thread).

    Returns ``"ok"`` | ``"dead"`` (subscription gone — prune it) | ``"error"``.
    """
    from pywebpush import WebPushException, webpush

    from clawbits.ssrf import UnsafeHostError, redact_url

    # Re-vet at dial time, not just at subscribe time: the row outlives the
    # check that let it in, and DNS can move under us in between. Deliberately
    # returns "error" rather than "dead" — a refused endpoint must be logged,
    # not silently pruned, or a transient resolver failure would quietly delete
    # a legitimate subscription.
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


def _build_payload(channel_meta: dict | None, post: dict) -> dict:
    """Notification content. DM → title is the other person, body is the
    message; channel → title is ``#name``, body is ``Author: message``
    (mirrors the desktop notification's author folding)."""
    channel_id = (channel_meta or {}).get("channel_id") or post.get("channel_id") or ""
    is_direct = bool(channel_meta and channel_meta.get("channel_type") == "direct")
    display = None
    if channel_meta:
        display = channel_meta.get("display_name") or channel_meta.get("name")
    author = post.get("poster_display_name") or "Someone"

    if is_direct:
        title = display or author
        body = _preview(post)
    else:
        title = f"#{display}" if display else author
        body = f"{author}: {_preview(post)}"

    return {
        "title": title,
        "body": body,
        "author": author,
        "channelId": channel_id,
        "url": f"/channels/{channel_id}" if channel_id else "/",
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
