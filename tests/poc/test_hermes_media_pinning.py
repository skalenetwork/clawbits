"""Image/attachment downloads connect only to the addresses they vetted.

These exercise the connection boundary itself: socket.getaddrinfo is
scripted per name and socket.create_connection is a spy that routes the
vetted public IP to a loopback server, so a test fails if the helper ever dials
something it did not vet, resolves a hop twice, or loses the hostname for
Host/SNI/certificate checks."""

from __future__ import annotations

import datetime
import http.server
import ipaddress
import socket
import ssl
import threading
import time
from pathlib import Path

import pytest

from tests.poc.hermes_stubs import _load_hermes_module

PUBLIC4 = "93.184.216.34"
PUBLIC6 = "2606:4700::1111"
_real_gai = socket.getaddrinfo
_real_connect = socket.create_connection


# --- connection-boundary fakes -------------------------------------------------


class FakeDNS:
    """Scripted getaddrinfo for names; literals go to the real resolver (no network)."""

    def __init__(self, zone):
        self.zone, self.queries = zone, []

    def __call__(self, host, port, family=0, type=0, proto=0, flags=0):
        try:
            ipaddress.ip_address(host.split("%")[0])
            return _real_gai(host, port, family, type, proto, flags)
        except ValueError:
            pass
        self.queries.append(host)
        answers = self.zone.get(host)
        if answers is None:
            raise socket.gaierror(socket.EAI_NONAME, "unknown name")
        if callable(answers):
            answers = answers()
        return [
            (socket.AF_INET6, socket.SOCK_STREAM, 6, "", (a, port, 0, 0)) if ":" in a
            else (socket.AF_INET, socket.SOCK_STREAM, 6, "", (a, port))
            for a in answers
        ]


class Dialer:
    """create_connection spy: records every dialed (ip, port) and timeout, routes known ones to
    loopback after ``delay`` s; a ``blackholed`` one sleeps out its timeout and fails."""

    def __init__(self):
        self.routes, self.calls, self.timeouts, self.blackholed, self.delay = {}, [], [], set(), 0.0

    def __call__(self, address, timeout=None, source_address=None, **kw):
        addr = tuple(address[:2])
        self.calls.append(addr)
        self.timeouts.append(timeout)
        if addr in self.blackholed:
            time.sleep(timeout)
            raise TimeoutError("timed out")
        target = self.routes.get(addr)
        if target is None:
            raise ConnectionRefusedError(f"unrouted {address}")
        time.sleep(self.delay)
        return _real_connect(target, timeout)


@pytest.fixture(scope="module")
def plugin():
    return _load_hermes_module()


@pytest.fixture
def ph(plugin):
    return plugin.pinned_http


@pytest.fixture
def net(monkeypatch):
    dns, dial = FakeDNS({}), Dialer()
    monkeypatch.setattr(socket, "getaddrinfo", dns)
    monkeypatch.setattr(socket, "create_connection", dial)
    for var in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy",
                "CLAWBITS_IMAGE_ALLOW_PRIVATE_HOSTS"):
        monkeypatch.delenv(var, raising=False)
    return dns, dial


@pytest.fixture
def serve():
    """Threaded loopback HTTP(S) servers, shut down and closed at teardown.

    serve(routes, tls=, http11=) with routes: path -> fn(handler); returns (port, seen)."""
    servers = []

    def start(routes, *, tls=None, http11=False):
        seen = {"headers": [], "sni": []}

        class H(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1" if http11 else "HTTP/1.0"

            def do_GET(self):
                seen["headers"].append(dict(self.headers))
                routes[self.path.split("?")[0]](self)

            def log_message(self, *a):
                pass

        srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
        srv.daemon_threads = True
        if tls is not None:
            ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            ctx.load_cert_chain(*tls)
            ctx.sni_callback = lambda sock, name, c: seen["sni"].append(name)
            srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
        servers.append(srv)
        threading.Thread(target=srv.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True).start()
        return srv.server_address[1], seen

    yield start
    for srv in servers:
        srv.shutdown()
        srv.server_close()


def png(h, body=b"\x89PNG-bytes"):
    h.send_response(200)
    h.send_header("Content-Type", "image/png; charset=binary")
    h.send_header("Content-Length", str(len(body)))
    h.end_headers()
    h.wfile.write(body)


def redirect(to):
    def _h(h):
        h.send_response(302)
        h.send_header("Location", to)
        h.send_header("Content-Length", "0")
        h.end_headers()
    return _h


def self_signed(tmp_path, name):
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import NameOID

    key = ec.generate_private_key(ec.SECP256R1())
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, name)])
    now = datetime.datetime.now(datetime.UTC)
    cert = (
        x509.CertificateBuilder().subject_name(subject).issuer_name(subject)
        .public_key(key.public_key()).serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1)).not_valid_after(now + datetime.timedelta(days=1))
        .add_extension(x509.SubjectAlternativeName([x509.DNSName(name)]), critical=False)
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .sign(key, hashes.SHA256())
    )
    cert_pem, key_pem = tmp_path / f"{name}.pem", tmp_path / f"{name}.key"
    cert_pem.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    key_pem.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                          serialization.NoEncryption()))
    return str(cert_pem), str(key_pem)


# --- tests -----------------------------------------------------------------------


def test_normal_public_image_is_fetched_through_the_vetted_ip(ph, net, serve):
    dns, dial = net
    port, seen = serve({"/cat.png": png})  # HTTP/1.0: the server closes after the body
    dns.zone["img.example"] = [PUBLIC4]
    dial.routes[(PUBLIC4, 80)] = ("127.0.0.1", port)
    body, ctype = ph.fetch("http://img.example/cat.png?x=1", max_bytes=1024, timeout=5)
    assert body == b"\x89PNG-bytes" and ctype == "image/png"
    assert dial.calls == [(PUBLIC4, 80)]
    assert seen["headers"][0]["Host"] == "img.example"


def test_dns_change_between_check_and_connect_cannot_retarget(ph, net, serve):
    dns, dial = net
    port, _ = serve({"/a.png": png})
    answers = iter([[PUBLIC4], ["127.0.0.1"], ["169.254.169.254"]])
    dns.zone["flip.example"] = lambda: next(answers)
    dial.routes[(PUBLIC4, 80)] = ("127.0.0.1", port)
    ph.fetch("http://flip.example/a.png", max_bytes=1024, timeout=5)
    assert dns.queries == ["flip.example"]  # resolved exactly once per hop
    assert dial.calls == [(PUBLIC4, 80)]  # and dialed only what was vetted


def test_mixed_public_private_answers_are_refused_before_dialing(ph, net):
    dns, dial = net
    dns.zone["split.example"] = [PUBLIC4, "10.0.0.5"]
    with pytest.raises(ph.UnsafeURLError, match="10.0.0.5"):
        ph.fetch("http://split.example/a.png", max_bytes=1024, timeout=5)
    assert dial.calls == []


def test_ipv6_then_ipv4_answers_are_tried_in_resolver_order(ph, net, serve):
    dns, dial = net
    port, _ = serve({"/a.png": png})
    dns.zone["dual.example"] = [PUBLIC6, PUBLIC4]
    dial.routes[(PUBLIC4, 80)] = ("127.0.0.1", port)  # the v6 dial is refused
    body, _ = ph.fetch("http://dual.example/a.png", max_bytes=1024, timeout=5)
    assert body.startswith(b"\x89PNG")
    assert dial.calls == [(PUBLIC6, 80), (PUBLIC4, 80)]


def test_a_black_holed_address_leaves_time_for_the_next_vetted_one(ph, net, serve, monkeypatch):
    dns, dial = net
    port, _ = serve({"/a.png": png})
    monkeypatch.setattr(ph, "_CONNECT_TIMEOUT_S", 0.3)
    dns.zone["dual.example"] = [PUBLIC6, PUBLIC4]
    dial.blackholed.add((PUBLIC6, 80))  # broken IPv6: SYNs dropped
    dial.routes[(PUBLIC4, 80)] = ("127.0.0.1", port)
    body, _ = ph.fetch("http://dual.example/a.png", max_bytes=1024, timeout=2)
    assert body.startswith(b"\x89PNG")
    assert dial.calls == [(PUBLIC6, 80), (PUBLIC4, 80)] and dial.timeouts[0] == 0.3


def test_tls_handshake_gets_only_the_time_left_after_a_slow_connect(ph, net):
    dns, dial = net
    with socket.create_server(("127.0.0.1", 0)) as silent:  # completes TCP, never answers TLS
        dns.zone["img.example"] = [PUBLIC4]
        dial.routes[(PUBLIC4, 443)] = silent.getsockname()
        dial.delay = 0.7
        started = time.monotonic()
        with pytest.raises(TimeoutError):
            ph.fetch("https://img.example/a.png", max_bytes=1024, timeout=1.0)
        assert time.monotonic() - started < 1.4


@pytest.mark.parametrize("addr", ["127.0.0.1", "10.1.2.3", "100.64.0.1", "169.254.169.254", "0.0.0.0",
                                  "::1", "fe80::1", "fc00::1", "::ffff:169.254.169.254",
                                  "64:ff9b::a9fe:a9fe", "2002:a9fe:a9fe::1"])
def test_every_non_public_class_is_refused(ph, net, addr):
    dns, dial = net
    dns.zone["bad.example"] = [addr]
    with pytest.raises(ph.UnsafeURLError):
        ph.fetch("http://bad.example/a.png", max_bytes=1024, timeout=5)
    with pytest.raises(ph.UnsafeURLError):
        ph.fetch(f"http://{'[' + addr + ']' if ':' in addr else addr}/a.png", max_bytes=1024, timeout=5)
    assert dial.calls == []


@pytest.mark.parametrize("location", ["http://127.0.0.1:8080/x", "http://169.254.169.254/latest/meta-data/",
                                      "http://[::1]/", "http://meta.example/", "file:///etc/passwd",
                                      "gopher://img.example/"])
def test_redirect_to_loopback_metadata_or_other_scheme_is_refused(ph, net, location, serve):
    dns, dial = net
    port, _ = serve({"/a.png": redirect(location)})
    dns.zone["img.example"] = [PUBLIC4]
    dns.zone["meta.example"] = ["169.254.169.254"]
    dial.routes[(PUBLIC4, 80)] = ("127.0.0.1", port)
    with pytest.raises(ph.UnsafeURLError):
        ph.fetch("http://img.example/a.png", max_bytes=1024, timeout=5, allow_private_hosts=["img.example"])
    assert dial.calls == [(PUBLIC4, 80)]


def test_redirect_limit(ph, net, serve):
    dns, dial = net
    port, _ = serve({"/a.png": redirect("/a.png")})
    dns.zone["loop.example"] = [PUBLIC4]
    dial.routes[(PUBLIC4, 80)] = ("127.0.0.1", port)
    with pytest.raises(ph.UnsafeURLError, match="redirects"):
        ph.fetch("http://loop.example/a.png", max_bytes=1024, timeout=5)
    assert len(dial.calls) == ph.MAX_REDIRECTS + 1


def test_redirect_hop_is_re_resolved_and_sends_only_fixed_headers(ph, net, serve):
    dns, dial = net
    port, seen = serve({"/a.png": redirect("http://cdn.example/b.png"), "/b.png": png})
    dns.zone.update({"img.example": [PUBLIC4], "cdn.example": ["93.184.216.35"]})
    dial.routes[(PUBLIC4, 80)] = dial.routes[("93.184.216.35", 80)] = ("127.0.0.1", port)
    ph.fetch("http://img.example/a.png", max_bytes=1024, timeout=5)
    assert dns.queries == ["img.example", "cdn.example"]
    assert dial.calls == [(PUBLIC4, 80), ("93.184.216.35", 80)]
    assert seen["headers"][1]["Host"] == "cdn.example"
    assert set(seen["headers"][1]) == {"Host", "User-Agent", "Accept-Encoding"}


@pytest.mark.parametrize("url", ["file:///etc/passwd", "ftp://img.example/a.png",
                                 "http://user:pw@img.example/a.png", "http://exämple.com/a.png",
                                 "http:///a.png"])
def test_bad_urls_are_refused_without_dns(ph, net, url):
    dns, dial = net
    with pytest.raises(ph.UnsafeURLError):
        ph.fetch(url, max_bytes=1024, timeout=5)
    assert dns.queries == [] and dial.calls == []


def test_errors_name_the_host_never_the_path_or_query(ph, net, serve):
    dns, dial = net

    def gone(h):
        h.send_response(404)
        h.end_headers()

    port, _ = serve({"/gone": gone})
    dns.zone.update({"img.example": [PUBLIC4], "bad.example": ["10.0.0.5"]})
    dial.routes[(PUBLIC4, 80)] = ("127.0.0.1", port)
    for url in ("http://img.example/gone?sig=SECRET", "http://bad.example/SECRET?sig=SECRET",
                "http://img.example/a b/SECRET?sig=SECRET", "http://img.example/\x00SECRET"):
        with pytest.raises(ValueError) as exc:
            ph.fetch(url, max_bytes=1024, timeout=5)
        assert "SECRET" not in str(exc.value) and ".example" in str(exc.value)
    assert dial.calls == [(PUBLIC4, 80)]  # the refused paths never reach the network


def test_tls_verifies_and_sends_sni_for_the_url_hostname(ph, net, tmp_path, monkeypatch, serve):
    dns, dial = net
    cert = self_signed(tmp_path, "img.example")
    port, seen = serve({"/a.png": png}, tls=cert)
    dns.zone["img.example"] = [PUBLIC4]
    dial.routes[(PUBLIC4, 443)] = ("127.0.0.1", port)
    monkeypatch.setenv("SSL_CERT_FILE", cert[0])  # how Reef's msb CA is trusted
    body, _ = ph.fetch("https://img.example/a.png", max_bytes=1024, timeout=5)
    assert body.startswith(b"\x89PNG")
    assert seen["sni"] == ["img.example"] and seen["headers"][0]["Host"] == "img.example"
    assert dial.calls == [(PUBLIC4, 443)]


def test_tls_hostname_mismatch_fails(ph, net, tmp_path, monkeypatch, serve):
    dns, dial = net
    cert = self_signed(tmp_path, "other.example")
    port, _ = serve({"/a.png": png}, tls=cert)
    dns.zone["img.example"] = [PUBLIC4]
    dial.routes[(PUBLIC4, 443)] = ("127.0.0.1", port)
    monkeypatch.setenv("SSL_CERT_FILE", cert[0])
    with pytest.raises(ssl.SSLCertVerificationError):
        ph.fetch("https://img.example/a.png", max_bytes=1024, timeout=5)


def test_untrusted_certificate_fails_without_ssl_cert_file(ph, net, tmp_path, monkeypatch, serve):
    dns, dial = net
    cert = self_signed(tmp_path, "img.example")
    port, _ = serve({"/a.png": png}, tls=cert)
    dns.zone["img.example"] = [PUBLIC4]
    dial.routes[(PUBLIC4, 443)] = ("127.0.0.1", port)
    monkeypatch.delenv("SSL_CERT_FILE", raising=False)
    with pytest.raises(ssl.SSLCertVerificationError):
        ph.fetch("https://img.example/a.png", max_bytes=1024, timeout=5)


def test_oversized_chunked_response_without_content_length_is_cut(ph, net, serve):
    dns, dial = net
    sent = []

    def chunked(h):
        h.send_response(200)
        h.send_header("Content-Type", "image/png")
        h.send_header("Transfer-Encoding", "chunked")
        h.end_headers()
        try:
            for _ in range(256):  # 4 MiB offered
                h.wfile.write(b"4000\r\n" + b"x" * 0x4000 + b"\r\n")
                sent.append(1)
            h.wfile.write(b"0\r\n\r\n")
        except OSError:
            pass

    port, _ = serve({"/big.png": chunked}, http11=True)
    dns.zone["img.example"] = [PUBLIC4]
    dial.routes[(PUBLIC4, 80)] = ("127.0.0.1", port)
    with pytest.raises(ValueError, match="exceeds 65536"):
        ph.fetch("http://img.example/big.png", max_bytes=65536, timeout=5)


def test_declared_oversize_is_refused_before_reading(ph, net, serve):
    dns, dial = net

    def liar(h):
        h.send_response(200)
        h.send_header("Content-Length", str(10**9))
        h.end_headers()

    port, _ = serve({"/a.png": liar})
    dns.zone["img.example"] = [PUBLIC4]
    dial.routes[(PUBLIC4, 80)] = ("127.0.0.1", port)
    with pytest.raises(ValueError, match="exceeds"):
        ph.fetch("http://img.example/a.png", max_bytes=1024, timeout=5)


def test_unparseable_content_length_falls_back_to_the_read_cap(ph, net, serve):
    dns, dial = net

    def odd(h):
        h.send_response(200)
        h.send_header("Content-Length", "\xb2")  # str.isdigit() is True, int() raises
        h.end_headers()
        h.wfile.write(b"\x89PNG")

    port, _ = serve({"/a.png": odd})
    dns.zone["img.example"] = [PUBLIC4]
    dial.routes[(PUBLIC4, 80)] = ("127.0.0.1", port)
    assert ph.fetch("http://img.example/a.png", max_bytes=1024, timeout=5)[0] == b"\x89PNG"


def test_total_deadline_stops_a_slow_drip(ph, net, serve):
    dns, dial = net

    def drip(h):
        h.send_response(200)
        h.send_header("Transfer-Encoding", "chunked")
        h.end_headers()
        try:
            for _ in range(50):
                h.wfile.write(b"1\r\nx\r\n")
                h.wfile.flush()
                time.sleep(0.1)
        except OSError:
            pass

    port, _ = serve({"/a.png": drip}, http11=True)
    dns.zone["img.example"] = [PUBLIC4]
    dial.routes[(PUBLIC4, 80)] = ("127.0.0.1", port)
    started = time.monotonic()
    with pytest.raises(TimeoutError):
        ph.fetch("http://img.example/a.png", max_bytes=1 << 20, timeout=0.5)
    assert time.monotonic() - started < 1.5


def test_total_deadline_stops_a_slow_header_drip(ph, net, serve):
    dns, dial = net

    def drip_headers(h):
        try:
            h.wfile.write(b"HTTP/1.1 200 OK\r\nX-Slow: ")
            for _ in range(50):  # every byte lands well inside any per-read timeout
                h.wfile.write(b"a")
                time.sleep(0.1)
        except OSError:
            pass

    port, _ = serve({"/a.png": drip_headers}, http11=True)
    dns.zone["img.example"] = [PUBLIC4]
    dial.routes[(PUBLIC4, 80)] = ("127.0.0.1", port)
    started = time.monotonic()
    with pytest.raises(TimeoutError):
        ph.fetch("http://img.example/a.png", max_bytes=1024, timeout=0.5)
    assert time.monotonic() - started < 1.5


def test_proxy_environment_is_ignored(ph, net, monkeypatch, serve):
    dns, dial = net
    port, _ = serve({"/a.png": png})
    for var in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy"):
        monkeypatch.setenv(var, "http://proxy.example:3128")
    dns.zone["img.example"] = [PUBLIC4]
    dns.zone["proxy.example"] = ["10.0.0.1"]
    dial.routes[(PUBLIC4, 80)] = ("127.0.0.1", port)
    ph.fetch("http://img.example/a.png", max_bytes=1024, timeout=5)
    assert dns.queries == ["img.example"] and dial.calls == [(PUBLIC4, 80)]


def test_allowlisted_private_host_is_fetched_and_still_pinned(ph, net, serve):
    dns, dial = net
    port, _ = serve({"/view": png, "/hop": redirect("http://comfy.lan:8188/view")})
    dns.zone["comfy.lan"] = ["192.168.1.5"]
    dial.routes[("192.168.1.5", 8188)] = ("127.0.0.1", port)
    ph.fetch("http://comfy.lan:8188/view?f=a.png", max_bytes=1024, timeout=5, allow_private_hosts=["COMFY.LAN"])
    # a same-host redirect uses the target's own listing
    ph.fetch("http://comfy.lan:8188/hop", max_bytes=1024, timeout=5, allow_private_hosts=["comfy.lan"])
    with pytest.raises(ph.UnsafeURLError):
        ph.fetch("http://comfy.lan:8188/view", max_bytes=1024, timeout=5)  # unlisted
    assert set(dial.calls) == {("192.168.1.5", 8188)}


def test_allowlist_is_not_inherited_by_a_redirect(ph, net, serve):
    dns, dial = net
    port, _ = serve({"/view": redirect("http://nas.lan/secret")})
    dns.zone.update({"comfy.lan": ["192.168.1.5"], "nas.lan": ["192.168.1.9"]})
    dial.routes[("192.168.1.5", 80)] = ("127.0.0.1", port)
    with pytest.raises(ph.UnsafeURLError, match="192.168.1.9"):
        ph.fetch("http://comfy.lan/view", max_bytes=1024, timeout=5, allow_private_hosts=["comfy.lan"])
    assert dial.calls == [("192.168.1.5", 80)]


def test_trusted_first_hop_allows_private_but_redirects_are_vetted(ph, net, serve):
    dns, dial = net
    port, _ = serve({"/b/k": png, "/b/r": redirect("http://10.0.0.9/")})
    dns.zone["minio"] = ["172.18.0.3"]
    dial.routes[("172.18.0.3", 9000)] = ("127.0.0.1", port)
    body, _ = ph.fetch("http://minio:9000/b/k?X-Amz-Signature=s", max_bytes=1024, timeout=5, trust_first_hop=True)
    assert body.startswith(b"\x89PNG")
    with pytest.raises(ph.UnsafeURLError, match="10.0.0.9"):
        ph.fetch("http://minio:9000/b/r", max_bytes=1024, timeout=5, trust_first_hop=True)


@pytest.mark.parametrize("addr", ["10.0.0.1", "127.0.0.1", "169.254.169.254", "100.64.0.1", "224.0.0.1",
                                  "0.0.0.0", "198.18.0.1", "192.0.2.1", "93.184.216.34", "8.8.8.8",
                                  "::1", "fe80::1", "fc00::1", "2001:db8::1", "64:ff9b::a9fe:a9fe",
                                  "::ffff:169.254.169.254", "2002:a9fe:a9fe::1",
                                  "2001:0:4136:e378:8000:63bf:f5fe:56fe", "2606:4700::1111"])
def test_ip_policy_matches_the_backend_guard(ph, addr):
    """The plugin's copy of the rule must not drift from clawbits/ssrf.py."""
    from clawbits import ssrf

    ip = ipaddress.ip_address(addr)
    assert ph.is_unsafe_ip(ip) == ssrf._is_unsafe(ip)


def test_download_to_tempfile_uses_the_allowlist_env(plugin, net, monkeypatch, serve):
    dns, dial = net
    port, _ = serve({"/view": png})
    dns.zone["comfy.lan"] = ["192.168.1.5"]
    dial.routes[("192.168.1.5", 8188)] = ("127.0.0.1", port)
    with pytest.raises(plugin.pinned_http.UnsafeURLError):
        plugin.media._download_to_tempfile("http://comfy.lan:8188/view")
    monkeypatch.setenv("CLAWBITS_IMAGE_ALLOW_PRIVATE_HOSTS", "other.lan, Comfy.Lan")
    path, ctype = plugin.media._download_to_tempfile("http://comfy.lan:8188/view")
    try:
        assert Path(path).read_bytes().startswith(b"\x89PNG") and ctype == "image/png"
        assert path.endswith(".png")  # suffix from Content-Type when the URL has none
    finally:
        Path(path).unlink()


def test_attachment_download_trusts_only_the_server_issued_hop(plugin, net, serve):
    dns, dial = net
    port, _ = serve({"/b/k": png, "/b/r": redirect("http://minio:9000/b/k")})
    dns.zone["minio"] = ["172.18.0.3"]
    dial.routes[("172.18.0.3", 9000)] = ("127.0.0.1", port)
    body, _ = plugin.media._download_attachment_bytes("http://minio:9000/b/k?X-Amz-Signature=s")
    assert body.startswith(b"\x89PNG")
    with pytest.raises(plugin.pinned_http.UnsafeURLError):  # even back to the same private host
        plugin.media._download_attachment_bytes("http://minio:9000/b/r")
