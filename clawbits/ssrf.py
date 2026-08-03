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

Known limitation (shared with every resolve-then-connect guard): the client
resolves the name again when it connects, so a name that flips between the
check and the connection slips through. Note this is not a race an attacker
has to win by luck — whoever controls the authoritative nameserver for a
domain can simply answer the two queries differently. Closing it needs the
resolved address pinned into the connection itself, which neither httpx nor
the openai SDK exposes without a custom transport; the mitigations here are a
small window and forbidding redirects at the call sites, so a single attacker
*response* can't retarget the request. On a shared deployment, treat network
egress policy as the real control.
"""

from __future__ import annotations

import ipaddress
import socket
from collections.abc import Collection

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
