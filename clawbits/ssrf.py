"""Shared SSRF guard: refuse to reach hosts that resolve to non-public IPs.

One implementation, two callers with different policies on top of it:

* :mod:`clawbits.link_preview.fetcher` — unfurling a chat link must never
  become a private-network scanner.
* :mod:`clawbits.lobstertalk.attention.triage` — the org-configured LLM
  endpoint is attacker-choosable (org creation is self-serve), so the same
  rule applies, with an operator allowlist for deployments that genuinely
  run a local model.

The check resolves the name and rejects if *any* returned address is
non-public — the most conservative reading a defender would want.

The historic limitation (shared with every resolve-then-connect guard) was
that the client resolves the name *again* when it connects, so a name that
flips between the check and the connection slipped through — not a race an
attacker has to win by luck, since whoever controls the authoritative
nameserver for a domain can simply answer the two queries differently.
:class:`PinnedAsyncTransport` (and the :func:`make_guarded_async_client`
factory over it) closes that: it resolves and vets the host itself and dials
the vetted IP, carrying the original hostname through as the TLS SNI / cert
name, so the connection can't be retargeted between the check and the connect.
Callers that go through the factory (LLM triage) are covered; a bare
:func:`check_host_is_public` call is still only as strong as the window before
the socket resolves, so treat network egress policy as the backstop on a
shared deployment regardless.

Resolution is also isolated onto a small dedicated thread pool (see
:func:`arun_guarded`): ``getaddrinfo`` can't be cancelled, so a hostile
nameserver's blocked threads must not be able to starve the default executor
that DB/Redis work shares via ``asyncio.to_thread``.
"""

from __future__ import annotations

import asyncio
import ipaddress
import socket
from collections.abc import Callable, Collection
from concurrent.futures import ThreadPoolExecutor
from functools import partial

import httpx


class UnsafeHostError(Exception):
    """Base: this host must not be contacted."""


class PrivateAddressError(UnsafeHostError):
    """The host isn't a safe target: it resolved to a non-public address, or
    the URL couldn't be parsed well enough to tell."""


class HostResolutionError(UnsafeHostError):
    """The host could not be resolved at all."""


def dialed_host(url: str | httpx.URL) -> str:
    """The hostname a client will actually connect to.

    Deliberately ``raw_host`` (the on-the-wire ASCII form) and never ``.host``:
    for an internationalised name httpx's ``.host`` returns the *decoded*
    unicode, while its transport dials ``raw_host``. Resolving the decoded
    form re-encodes it through CPython's IDNA2003 codec, which does not agree
    with the IDNA2008 encoding in the URL — ``xn--fa-hia.example`` decodes to
    ``faß.example`` and re-encodes to ``fass.example``, a name the attacker can
    point somewhere public while the punycode name they actually get dialed on
    points at 169.254.169.254. Checking the decoded form would vet one host and
    connect to another.
    """
    return parse_url(url).raw_host.decode("ascii")


def parse_url(url: str | httpx.URL) -> httpx.URL:
    """Parse ``url``, turning a rejection into an :class:`UnsafeHostError`.

    httpx refuses some inputs outright (``https://0177.0.0.1/``). A URL we
    can't even parse is one we certainly can't vet, so it belongs on the
    unsafe path rather than escaping as a 500.
    """
    if isinstance(url, httpx.URL):
        return url
    try:
        return httpx.URL(url)
    except Exception as exc:
        raise PrivateAddressError(f"unparseable URL: {exc}") from exc


def redact_url(url: str | httpx.URL) -> str:
    """A URL safe to put in a log line: scheme, host, port and path only.

    Userinfo (``user:pass@``), the query string and the fragment are each a
    place a secret can ride along — an org's base URL is operator-visible in
    the server log, so those parts are dropped before it lands there. Best
    effort: an input we can't even parse comes back as a placeholder rather
    than raising into the log call."""
    try:
        u = parse_url(url)
    except UnsafeHostError:
        return "<unparseable-url>"
    host = u.raw_host.decode("ascii") if u.raw_host else ""
    port = f":{u.port}" if u.port is not None else ""
    return f"{u.scheme}://{host}{port}{u.path}"


def _resolve(host: str) -> set[str]:
    """Every address ``host`` resolves to.

    Its own function so tests can stub resolution by patching *this* name.
    Patching ``socket.getaddrinfo`` instead would redirect the whole process
    — including the database and Redis clients — because this module's
    ``socket`` is the stdlib module itself, not a copy.
    """
    try:
        infos = socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)
    except (socket.gaierror, UnicodeError) as exc:
        # UnicodeError as well as gaierror: the resolver runs the name through
        # the stdlib 'idna' codec, which rejects an over-long label outright
        # ("xn--" + 100 chars). That's still just "this name doesn't resolve",
        # and it must not escape as an unhandled 500 from the save handler.
        raise HostResolutionError(f"DNS lookup failed: {exc}") from exc
    return {info[4][0] for info in infos}


def check_host_is_public(host: str, *, allow_hosts: Collection[str] = ()) -> None:
    """Raise unless ``host`` resolves exclusively to public addresses.

    ``allow_hosts`` is an operator-supplied escape hatch (matched
    case-insensitively on the hostname as configured, not on the resolved
    address): a deployment that points a feature at ``localhost`` opts that
    name in explicitly rather than the guard being weakened for everyone.
    """
    if host.lower() in {h.lower() for h in allow_hosts}:
        return
    for addr in _resolve(host):
        try:
            ip = ipaddress.ip_address(addr)
        except ValueError:
            continue
        if _is_unsafe(ip):
            raise PrivateAddressError(f"refusing to reach private address: {addr}")


def _is_unsafe(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    """Whether ``ip`` is anything other than a plain public address.

    Deliberately the *union* of two rules, because neither alone is enough:

    * ``not is_global`` catches routable-but-not-public ranges the classic
      enumeration misses — notably 100.64.0.0/10 (RFC 6598), where several
      managed Kubernetes offerings put pod IPs, and every Tailscale tailnet.
    * the enumeration catches ranges ``is_global`` reports as global anyway,
      notably multicast (224.0.0.0/4, ff00::/8) and the NAT64 well-known
      prefix 64:ff9b::/96 — on an IPv6-only network that last one reaches
      IPv4 link-local, metadata service included.

    IPv4 embedded in IPv6 is unwrapped and re-checked rather than trusted to
    the stdlib: recent CPython classifies ``::ffff:169.254.169.254`` correctly
    through ``ipv4_mapped``, but that behavior is version-dependent and 6to4 /
    Teredo carry an address the outer form's flags say nothing about.
    """
    if not ip.is_global:
        return True
    if (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
    ):
        return True
    for embedded in (
        getattr(ip, "ipv4_mapped", None),
        getattr(ip, "sixtofour", None),
        (getattr(ip, "teredo", None) or (None, None))[1],
    ):
        if embedded is not None and _is_unsafe(embedded):
            return True
    return False


# --- Bounded, isolated resolution -------------------------------------------
#
# getaddrinfo blocks and can't be cancelled, so a name pointed at a slow or
# hostile nameserver leaves a thread stuck for the OS resolver timeout no
# matter what deadline the caller wraps around it. Running those on the default
# asyncio executor (shared with every ``asyncio.to_thread`` in the process —
# DB, Redis) or on anyio's ``run_in_threadpool`` pool lets a self-service org
# starve unrelated work. A small dedicated pool keeps the blast radius to "DNS
# is slow for a moment"; ``max_workers`` caps concurrency, and callers are
# themselves cooldown-/rate-limited so the work queue can't be flooded.
_RESOLVER_MAX_THREADS = 8
_resolver_executor = ThreadPoolExecutor(
    max_workers=_RESOLVER_MAX_THREADS, thread_name_prefix="ssrf-resolve"
)


async def arun_guarded[T](func: Callable[..., T], /, *args: object) -> T:
    """Run a blocking SSRF check (``check_host_is_public``, ``check_endpoint_``
    ``allowed``, ...) on the dedicated resolver pool instead of the default
    executor. Exceptions propagate unchanged, so the caller's
    ``UnsafeHostError`` handling is untouched — this only moves *where* the
    blocking resolve runs."""
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(_resolver_executor, partial(func, *args))


def _pick_pinned_ip(host: str) -> str:
    """Resolve ``host``, reject if *any* address is non-public, and return one
    vetted address to dial. Same all-or-nothing policy as
    :func:`check_host_is_public`; an IPv4 result is preferred for the pinned
    dial because it needs no bracket handling. Raises
    :class:`HostResolutionError` if the name yields no usable address."""
    safe: list[str] = []
    for addr in _resolve(host):
        try:
            ip = ipaddress.ip_address(addr)
        except ValueError:
            continue
        if _is_unsafe(ip):
            raise PrivateAddressError(f"refusing to reach private address: {addr}")
        safe.append(addr)
    if not safe:
        raise HostResolutionError(f"no usable address for {host!r}")
    safe.sort(key=lambda a: ":" in a)  # IPv4 (no colon) first
    return safe[0]


class PinnedAsyncTransport(httpx.AsyncHTTPTransport):
    """An httpx transport that resolves + vets the host itself and dials the
    vetted IP, closing the resolve-then-connect (DNS-rebinding) gap: a name
    that passed an earlier check can't be re-pointed at a private address for
    the actual connection. The original hostname is carried through as the TLS
    ``server_hostname`` (SNI + cert verification), so certificate checking is
    unchanged — only the A/AAAA lookup is pinned.

    ``allow_hosts`` mirrors :func:`check_host_is_public`: a listed hostname is
    dialed by name (private/loopback permitted) for the self-hosted-model case;
    every other host is pinned to a vetted public address."""

    def __init__(self, *args: object, allow_hosts: Collection[str] = (), **kwargs: object):
        super().__init__(*args, **kwargs)
        self._allow_hosts = frozenset(h.lower() for h in allow_hosts)

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        raw = request.url.raw_host
        host = raw.decode("ascii") if raw else ""
        if host and host.lower() not in self._allow_hosts:
            # Raises UnsafeHostError on a rebind to a private address — httpx
            # surfaces it as the request's failure, which the caller already
            # treats as "couldn't reach the endpoint".
            ip = await arun_guarded(_pick_pinned_ip, host)
            request.url = request.url.copy_with(host=ip)
            # SNI + cert name stay the real host; only the dialed address is
            # the pinned IP. httpx forwards this extension to httpcore, which
            # uses it as the TLS server_hostname.
            request.extensions = {**request.extensions, "sni_hostname": host}
        return await super().handle_async_request(request)


def make_guarded_async_client(
    *, allow_hosts: Collection[str] = (), **kwargs: object
) -> httpx.AsyncClient:
    """An :class:`httpx.AsyncClient` whose transport pins vetted IPs (see
    :class:`PinnedAsyncTransport`) and which never follows redirects — a
    redirect is a second, unvetted hop that would sidestep the pin. Pass the
    operator allowlist through ``allow_hosts``; other client kwargs (``timeout``
    etc.) are forwarded verbatim."""
    kwargs.setdefault("follow_redirects", False)
    transport = PinnedAsyncTransport(allow_hosts=allow_hosts, retries=0)
    return httpx.AsyncClient(transport=transport, **kwargs)
