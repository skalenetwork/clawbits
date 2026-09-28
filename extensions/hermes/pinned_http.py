"""Stdlib GET that connects only to addresses it has vetted (DNS pinned to the socket).

The plugin's counterpart of ``clawbits/ssrf.py``'s ``PinnedAsyncTransport``, for
``http.client`` in a worker thread (the plugin cannot import the backend). Each
hop resolves once, vets every answer, dials only those IPs (in resolver order),
and keeps the URL hostname for the Host header, SNI and certificate check.
Redirects are followed by hand so every hop is re-parsed, re-resolved and
re-vetted. Proxy variables are ignored: a proxy resolves the name itself, where
none of this can vet it. Error messages name the host, never the path or query.
"""

from __future__ import annotations

import functools
import http.client
import io
import ipaddress
import socket
import ssl
import time
import urllib.parse
from collections.abc import Collection

MAX_REDIRECTS = 5
_CONNECT_TIMEOUT_S = 10.0  # per address, so a black-holed one leaves time for the next
_REDIRECT_STATUSES = frozenset({301, 302, 303, 307, 308})
_HEADERS = {"User-Agent": "clawbits-hermes-plugin"}  # never credentials, so none can cross origins
_CHUNK = 64 * 1024


class UnsafeURLError(ValueError):
    """The URL, or a redirect hop, is not an allowed fetch target."""


def is_unsafe_ip(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    """True unless ``ip`` is a plain public address (same rule as clawbits.ssrf._is_unsafe)."""
    if not ip.is_global or (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
    ):
        return True
    embedded = (
        getattr(ip, "ipv4_mapped", None),
        getattr(ip, "sixtofour", None),
        (getattr(ip, "teredo", None) or (None, None))[1],
    )
    return any(e is not None and is_unsafe_ip(e) for e in embedded)


def vetted_addresses(host: str, port: int, *, allow_private: bool = False) -> list[str]:
    """Resolve ``host`` once; every answer in resolver order, all public unless ``allow_private``."""
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except (OSError, UnicodeError) as exc:
        raise UnsafeURLError(f"cannot resolve {host!r}") from exc
    addrs = list(dict.fromkeys(info[4][0] for info in infos))
    if not addrs:
        raise UnsafeURLError(f"no address for {host!r}")
    for addr in addrs:
        try:
            ip = ipaddress.ip_address(addr)
        except ValueError:
            raise UnsafeURLError(f"{host!r} resolved to unparseable {addr!r}") from None
        if not allow_private and is_unsafe_ip(ip):
            raise UnsafeURLError(f"{host!r} resolves to non-public address {addr}")
    return addrs


def _dial(addrs: list[str], port: int, deadline: float) -> socket.socket:
    last: OSError | None = None
    for addr in addrs:  # connect errors only; nothing has been sent yet
        budget = min(_CONNECT_TIMEOUT_S, _remaining(deadline))
        try:
            return socket.create_connection((addr, port), budget)
        except OSError as exc:
            last = exc
    raise last or OSError("no vetted address")


class _DeadlineReader(io.RawIOBase):
    """Raw socket reader that limits each recv to the time left before ``deadline``."""

    def __init__(self, sock: socket.socket, raw: io.RawIOBase, deadline: float):
        self._sock, self._raw, self._deadline = sock, raw, deadline

    def readable(self) -> bool:
        return True

    def readinto(self, buffer: memoryview) -> int | None:
        self._sock.settimeout(_remaining(self._deadline))
        return self._raw.readinto(buffer)

    def close(self) -> None:
        self._raw.close()
        super().close()


class _DeadlineResponse(http.client.HTTPResponse):
    """Status line, headers and body are all read against the total deadline."""

    def __init__(self, sock: socket.socket, *args, deadline: float, **kwargs):
        super().__init__(sock, *args, **kwargs)
        self.fp = io.BufferedReader(_DeadlineReader(sock, self.fp.detach(), deadline))


class _PinnedHTTPConnection(http.client.HTTPConnection):
    """Dials only ``addrs``; ``self.host`` (the URL hostname) stays the Host header."""

    def __init__(self, host: str, port: int, addrs: list[str], deadline: float):
        super().__init__(host, port)
        self._addrs, self._deadline = addrs, deadline
        self.response_class = functools.partial(_DeadlineResponse, deadline=deadline)

    def connect(self) -> None:
        self.sock = _dial(self._addrs, self.port, self._deadline)
        self.sock.settimeout(_remaining(self._deadline))  # bounds TLS handshake and request send


class _PinnedHTTPSConnection(_PinnedHTTPConnection):
    """TLS over the pinned socket; SNI and the certificate check use the URL hostname."""

    default_port = 443

    def connect(self) -> None:
        super().connect()
        # Default verify paths honour SSL_CERT_FILE/SSL_CERT_DIR (Reef's msb CA).
        self.sock = ssl.create_default_context().wrap_socket(self.sock, server_hostname=self.host)


def _split(url: str) -> tuple[urllib.parse.SplitResult, str, int]:
    parts = urllib.parse.urlsplit(url)
    host = parts.hostname or ""
    if parts.scheme not in ("http", "https") or not host:
        raise UnsafeURLError("only http(s) URLs with a host are fetched")
    if "@" in parts.netloc or not host.isascii():
        raise UnsafeURLError(f"refusing credentials or a non-ASCII host in {host!r}")
    if any(c <= " " or c == "\x7f" for c in parts.path + parts.query):
        raise UnsafeURLError(f"refusing whitespace or control characters in a path on {host!r}")
    return parts, host, parts.port or (443 if parts.scheme == "https" else 80)


def _remaining(deadline: float) -> float:
    left = deadline - time.monotonic()
    if left <= 0:
        raise TimeoutError("download deadline exceeded")
    return left


def _read_capped(resp: http.client.HTTPResponse, max_bytes: int) -> bytes:
    # resp.length is the parsed Content-Length: None when chunked or invalid.
    if resp.length is not None and resp.length > max_bytes:
        raise ValueError(f"response exceeds {max_bytes} bytes")
    body = bytearray()
    while chunk := resp.read1(_CHUNK):
        body += chunk
        if len(body) > max_bytes:
            raise ValueError(f"response exceeds {max_bytes} bytes")
    return bytes(body)


def fetch(
    url: str,
    *,
    max_bytes: int,
    timeout: float,
    allow_private_hosts: Collection[str] = (),
    trust_first_hop: bool = False,
) -> tuple[bytes, str | None]:
    """GET ``url``: pinned DNS, every redirect re-vetted, streaming byte cap, total deadline.

    A hop may reach private addresses only when its own hostname is listed in
    ``allow_private_hosts`` (exact, case-insensitive) or, with
    ``trust_first_hop``, when it is the caller-trusted first URL. Neither is
    inherited by a redirect target.
    """
    deadline = time.monotonic() + timeout
    allowed = {h.lower() for h in allow_private_hosts}
    for hop in range(MAX_REDIRECTS + 1):
        parts, host, port = _split(url)
        private_ok = host in allowed or (trust_first_hop and hop == 0)
        addrs = vetted_addresses(host, port, allow_private=private_ok)
        cls = _PinnedHTTPSConnection if parts.scheme == "https" else _PinnedHTTPConnection
        conn = cls(host, port, addrs, deadline)
        try:
            target = urllib.parse.urlunsplit(("", "", parts.path or "/", parts.query, ""))
            conn.request("GET", target, headers=_HEADERS)
            resp = conn.getresponse()
            if resp.status in _REDIRECT_STATUSES:
                location = resp.getheader("Location")
                if not location:
                    raise UnsafeURLError(f"redirect from {host!r} without Location")
                url = urllib.parse.urljoin(url, location)
                continue
            if not 200 <= resp.status < 300:
                raise ValueError(f"HTTP {resp.status} from {host!r}")
            content_type = (resp.getheader("Content-Type") or "").split(";", 1)[0].strip() or None
            return _read_capped(resp, max_bytes), content_type
        finally:
            conn.close()
    raise UnsafeURLError(f"more than {MAX_REDIRECTS} redirects")
