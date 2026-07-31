"""Exposure seam: strategy, port allocator, and SandboxManager.expose()."""

import asyncio

import pytest

from reef import (
    FakeRuntime,
    InMemorySandboxStore,
    OpenClawProfile,
    SandboxManager,
    SandboxState,
)
from reef.exposure import DirectPortExposure, Exposure, SubdomainProxyExposure
from reef.ports import PortAllocator, PortExhausted
from reef.runtime_factory import make_exposure

CREDS = {"org_id": "o", "agent_id": "A", "api_key": "k", "channel_id": "c"}


def test_direct_port_exposure():
    e = DirectPortExposure()
    assert e.forward(19000, 18789) == "127.0.0.1:19000:18789"
    assert e.url_for("agent-1", 19000) == "http://127.0.0.1:19000"


def test_direct_port_exposure_custom_bind():
    assert DirectPortExposure(bind="0.0.0.0").forward(19000, 18789) == "0.0.0.0:19000:18789"
    # 0.0.0.0 isn't browsable — url_for falls back to the loopback IP.
    assert DirectPortExposure(bind="0.0.0.0").url_for("a", 19000) == "http://127.0.0.1:19000"


def test_port_allocator_skips_used():
    alloc = PortAllocator(19000, 19002)
    assert alloc.allocate(set()) == 19000
    assert alloc.allocate({19000}) == 19001
    assert alloc.allocate({19000, 19001}) == 19002


def test_port_allocator_exhausted():
    alloc = PortAllocator(19000, 19000)
    with pytest.raises(PortExhausted):
        alloc.allocate({19000})


def test_openclaw_exposure_env():
    profile = OpenClawProfile(image="x")
    assert profile.ui_port == 18789
    assert profile.exposure_env(password="pw", public_url="http://127.0.0.1:19000") == {
        "OPENCLAW_GATEWAY_BIND": "lan",
        "OPENCLAW_GATEWAY_AUTH": "token",
        "OPENCLAW_GATEWAY_TOKEN": "pw",
        "OPENCLAW_PUBLIC_URL": "http://127.0.0.1:19000",
        "REEF_TERMINAL_ENABLE": "1",
        "REEF_TERMINAL_PASSWORD": "pw",
        "REEF_TERMINAL_PORT": "7681",
    }


def _manager():
    runtime = FakeRuntime()
    store = InMemorySandboxStore()
    return SandboxManager(runtime, store, backend="fake"), runtime, store


def test_expose_creates_with_forward_and_returns_exposure():
    mgr, runtime, store = _manager()
    profile = OpenClawProfile(image="reef-oc:test")

    exp = asyncio.run(mgr.expose("agent-1", profile, CREDS))

    assert isinstance(exp, Exposure)
    assert exp.port == 19000
    assert exp.url == "http://127.0.0.1:19000"
    assert exp.terminal_url == "http://127.0.0.1:19001"  # second surface (ttyd)
    assert exp.password  # generated, returned once
    spec = runtime.created[0]
    # two forwards: host 19000 -> Control UI 18789, host 19001 -> terminal 7681
    assert spec.ports == ("127.0.0.1:19000:18789", "127.0.0.1:19001:7681")
    assert spec.env["OPENCLAW_GATEWAY_BIND"] == "lan"
    assert spec.env["OPENCLAW_GATEWAY_TOKEN"] == exp.password
    assert spec.env["REEF_TERMINAL_PASSWORD"] == exp.password  # terminal shares the password
    assert spec.env["REEF_TERMINAL_PORT"] == "7681"
    assert spec.env["OPENCLAW_PUBLIC_URL"] == "http://127.0.0.1:19000"
    assert spec.env["CLAWBITS_AGENT_ID"] == "A"  # base env still merged
    sb = asyncio.run(store.get("agent-1"))
    assert sb.port == 19000 and sb.url == "http://127.0.0.1:19000"
    assert sb.terminal_port == 19001 and sb.terminal_url == "http://127.0.0.1:19001"
    assert sb.state is SandboxState.RUNNING


def test_expose_allocates_distinct_ports():
    mgr, _, _ = _manager()
    profile = OpenClawProfile(image="reef-oc:test")
    a = asyncio.run(mgr.expose("agent-1", profile, CREDS))
    b = asyncio.run(mgr.expose("agent-2", profile, CREDS))
    # each agent consumes TWO host ports (Control UI + terminal), all distinct
    assert a.port == 19000 and a.terminal_url == "http://127.0.0.1:19001"
    assert b.port == 19002 and b.terminal_url == "http://127.0.0.1:19003"


def test_expose_reuses_port_on_restart():
    mgr, runtime, _ = _manager()
    profile = OpenClawProfile(image="reef-oc:test")

    first = asyncio.run(mgr.expose("agent-1", profile, CREDS))
    asyncio.run(mgr.stop("agent-1"))
    again = asyncio.run(mgr.expose("agent-1", profile, CREDS))

    assert again.port == first.port
    assert again.url == first.url
    assert again.terminal_url == first.terminal_url  # terminal port also reused
    assert again.password == ""  # password is issued once, at creation
    assert len(runtime.created) == 1  # restarted, not recreated


def test_expose_skips_host_ports_held_on_the_runtime():
    # A fresh store doesn't know about containers from a prior run, but the runtime
    # does — ports bound on the host are skipped (else `docker run -p` would fail).
    runtime = FakeRuntime()
    runtime.host_ports = {19000, 19001}
    mgr = SandboxManager(runtime, InMemorySandboxStore(), backend="fake")
    profile = OpenClawProfile(image="reef-oc:test")

    exp = asyncio.run(mgr.expose("agent-1", profile, CREDS))

    assert exp.port == 19002  # 19000/19001 are taken on the host
    assert exp.terminal_url == "http://127.0.0.1:19003"


# ── SubdomainProxyExposure (prod) ────────────────────────────────────────────


class FakeNginx:
    def __init__(self) -> None:
        self.calls: list[list[str]] = []

    async def __call__(self, argv):
        self.calls.append(list(argv))
        return (0, "", "")


def test_subdomain_is_deterministic_and_unguessable():
    px = SubdomainProxyExposure("reef.clawbits.ai", secret="s")
    url = px.url_for("agent-1", 19000)
    assert url == px.url_for("agent-1", 19999)  # independent of port
    assert url.startswith("https://") and url.endswith(".reef.clawbits.ai")
    assert px.url_for("agent-2", 19000) != url  # differs by id
    assert SubdomainProxyExposure("reef.clawbits.ai", secret="x").url_for("agent-1", 1) != url


def test_subdomain_terminal_surface_distinct_and_unpublish_removes_both(tmp_path):
    fake = FakeNginx()
    px = SubdomainProxyExposure(
        "reef.clawbits.ai", nginx_dir=str(tmp_path), secret="s", runner=fake
    )
    # the terminal surface gets its own (distinct) subdomain
    assert px.url_for("agent-1", 1, surface="terminal") != px.url_for("agent-1", 1, surface="ui")
    asyncio.run(px.publish("agent-1", 19000, surface="ui"))
    asyncio.run(px.publish("agent-1", 19001, surface="terminal"))
    assert (tmp_path / "agent-1.conf").exists()
    assert (tmp_path / "agent-1@terminal.conf").exists()  # '@' can't collide with an id
    asyncio.run(px.unpublish("agent-1"))  # removes BOTH surfaces
    assert list(tmp_path.glob("*.conf")) == []


def test_subdomain_proxy_publish_writes_conf_and_reloads(tmp_path):
    fake = FakeNginx()
    px = SubdomainProxyExposure(
        "reef.clawbits.ai",
        nginx_dir=str(tmp_path),
        tls_cert="/etc/ssl/c.pem",
        tls_key="/etc/ssl/k.pem",
        secret="s",
        runner=fake,
    )
    asyncio.run(px.publish("agent-1", 19000))

    text = (tmp_path / "agent-1.conf").read_text()
    assert f"server_name {px.subdomain('agent-1')}.reef.clawbits.ai;" in text
    assert "proxy_pass http://127.0.0.1:19000;" in text
    assert "proxy_set_header Upgrade $http_upgrade;" in text  # WebSocket upgrade
    assert 'Connection "upgrade"' in text
    assert "ssl_certificate /etc/ssl/c.pem;" in text
    assert fake.calls == [["nginx", "-s", "reload"]]


def test_subdomain_proxy_unpublish_removes_and_is_idempotent(tmp_path):
    fake = FakeNginx()
    px = SubdomainProxyExposure("reef.clawbits.ai", nginx_dir=str(tmp_path), runner=fake)
    asyncio.run(px.publish("agent-1", 19000))
    asyncio.run(px.unpublish("agent-1"))
    assert list(tmp_path.glob("*.conf")) == []
    assert len(fake.calls) == 2  # one reload each for publish + unpublish
    asyncio.run(px.unpublish("agent-1"))  # already gone -> no-op, no extra reload
    assert len(fake.calls) == 2


def test_make_exposure_selects_by_base_domain(monkeypatch):
    monkeypatch.delenv("REEF_BASE_DOMAIN", raising=False)
    assert isinstance(make_exposure(), DirectPortExposure)
    monkeypatch.setenv("REEF_BASE_DOMAIN", "reef.clawbits.ai")
    assert isinstance(make_exposure(), SubdomainProxyExposure)


def test_manager_expose_publishes_and_destroy_unpublishes(tmp_path):
    fake = FakeNginx()
    px = SubdomainProxyExposure(
        "reef.clawbits.ai", nginx_dir=str(tmp_path), secret="s", runner=fake
    )
    runtime = FakeRuntime()
    mgr = SandboxManager(runtime, InMemorySandboxStore(), backend="fake", exposure=px)
    profile = OpenClawProfile(image="reef-oc:test")

    exp = asyncio.run(mgr.expose("agent-1", profile, CREDS))

    assert exp.url == px.url_for("agent-1", exp.port) and exp.url.startswith("https://")
    assert (tmp_path / "agent-1.conf").exists()  # route registered on expose
    assert runtime.created[0].env["OPENCLAW_PUBLIC_URL"] == exp.url  # https origin → agent env

    asyncio.run(mgr.destroy("agent-1"))
    assert not (tmp_path / "agent-1.conf").exists()  # route removed on destroy
