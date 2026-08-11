"""FleetService: live+store merge, drift handling, secret redaction, and
lifecycle-by-name (including sandboxes Reef never recorded).
"""

import asyncio
import re

import pytest

from reef.errors import SandboxNotFound
from reef.fleet import FleetService, _normalize_local_endpoint, redact_env
from reef.image_ops import ImageInfo, active_tag
from reef.manager import SandboxManager
from reef.models import Sandbox
from reef.profiles import HermesProfile, OpenClawProfile
from reef.runtime import DesiredState, MetricsSample, RestartPolicy, SandboxState
from reef.store import InMemorySandboxStore
from reef.tests.fakes import FakeAdminRuntime

# A realistic msb inspect blob (env carries secrets that MUST be redacted).
INSPECT = {
    "config": {
        "name": "agent-1",
        "cpus": 2,
        "memory_mib": 2048,
        "image": {"Oci": {"reference": "reef-oc:plugin"}},
        "entrypoint": ["/usr/local/bin/reef-entrypoint.sh"],
        "env": [
            ["PATH", "/usr/bin"],
            ["CLAWBITS_ORG_ID", "org-test"],
            ["CLAWBITS_API_KEY", "key-supersecret"],
            ["ANTHROPIC_API_KEY", "sk-secret"],
            ["OPENCLAW_GATEWAY_PASSWORD", "hunter2"],
        ],
        "mounts": [
            {
                "guest": "/home/node/.openclaw/workspace",
                "type": "Volume",
                "options": {"readonly": False},
            }
        ],
        "network": {
            "enabled": True,
            "policy": {
                "default_egress": "deny",
                "default_ingress": "allow",
                "rules": [
                    {"action": "allow", "direction": "egress", "destination": {"group": "host"}},
                    {
                        "action": "allow",
                        "direction": "egress",
                        "destination": {"domain": "api.anthropic.com"},
                    },
                ],
            },
        },
    }
}


def _svc(runtime=None, store=None) -> FleetService:
    return FleetService(runtime or FakeAdminRuntime(), store or InMemorySandboxStore())


def _record(sandbox_id: str, **kw) -> Sandbox:
    return Sandbox(
        sandbox_id=sandbox_id,
        profile=kw.get("profile", "openclaw"),
        backend="microsandbox",
        state=kw.get("state", SandboxState.RUNNING),
        image=kw.get("image", "reef-oc:plugin"),
        volume=kw.get("volume", f"reef-{sandbox_id}"),
        tenant=kw.get("tenant"),
        created_image_id=kw.get("created_image_id"),
        desired_state=kw.get("desired_state", DesiredState.RUNNING),
        restart_policy=kw.get("restart_policy", RestartPolicy.ON_FAILURE),
        restart_count=kw.get("restart_count", 0),
    )


def test_redact_env_masks_secrets_keeps_identifiers():
    out = redact_env(
        {
            "CLAWBITS_ORG_ID": "org",
            "CLAWBITS_API_KEY": "k",
            "ANTHROPIC_API_KEY": "sk",
            "PATH": "/x",
            "OPENCLAW_GATEWAY_PASSWORD": "p",
        }
    )
    assert out["CLAWBITS_ORG_ID"] == "org"
    assert out["PATH"] == "/x"
    assert out["CLAWBITS_API_KEY"] == "***"
    assert out["ANTHROPIC_API_KEY"] == "***"
    assert out["OPENCLAW_GATEWAY_PASSWORD"] == "***"


def test_list_fleet_merges_store_metadata_and_marks_drift():
    rt = FakeAdminRuntime()
    rt.seed(
        "managed-1",
        image="reef-oc:plugin",
        metrics=MetricsSample(
            name="managed-1", cpu_percent=1.0, memory_bytes=10, memory_limit_bytes=100
        ),
    )
    rt.seed("drift-1", image="ghcr.io/openclaw/openclaw:latest")
    store = InMemorySandboxStore()
    asyncio.run(store.put(_record("managed-1", tenant="org-acme")))
    svc = _svc(rt, store)

    entries = {e.sandbox_id: e for e in asyncio.run(svc.list_fleet())}
    assert entries["managed-1"].managed is True
    assert entries["managed-1"].profile == "openclaw"
    assert entries["managed-1"].tenant == "org-acme"
    assert entries["managed-1"].metrics.cpu_percent == 1.0
    assert entries["drift-1"].managed is False
    assert entries["drift-1"].profile is None


def test_list_fleet_filters_by_state():
    rt = FakeAdminRuntime()
    rt.seed("r", state=SandboxState.RUNNING)
    rt.seed("s", state=SandboxState.STOPPED)
    running = asyncio.run(_svc(rt).list_fleet(state=SandboxState.RUNNING))
    assert [e.sandbox_id for e in running] == ["r"]


def test_get_detail_redacts_env_and_parses_network():
    svc = _svc(FakeAdminRuntime().seed("agent-1", inspect=INSPECT))
    d = asyncio.run(svc.get_detail("agent-1"))
    assert d.image == "reef-oc:plugin"
    assert d.cpus == 2
    assert d.memory_mib == 2048
    assert d.env["CLAWBITS_ORG_ID"] == "org-test"
    assert d.env["CLAWBITS_API_KEY"] == "***"
    assert d.env["ANTHROPIC_API_KEY"] == "***"
    assert d.network.default_egress == "deny"
    assert "api.anthropic.com" in d.network.egress_allow
    assert "host" not in d.network.egress_allow  # implicit host rule filtered out
    assert d.mounts[0].dest == "/home/node/.openclaw/workspace"


def test_get_detail_unknown_raises_not_found():
    with pytest.raises(SandboxNotFound):
        asyncio.run(_svc().get_detail("nope"))


def test_stop_updates_store_record():
    rt = FakeAdminRuntime().seed("agent-1")
    store = InMemorySandboxStore()
    asyncio.run(store.put(_record("agent-1")))
    svc = _svc(rt, store)
    asyncio.run(svc.stop("agent-1"))
    assert ("stop", "agent-1") in rt.calls
    rec = asyncio.run(store.get("agent-1"))
    assert rec.state is SandboxState.STOPPED
    assert rec.updated_at is not None


def test_stop_works_on_drift_without_store_record():
    rt = FakeAdminRuntime().seed("drift-1")
    state = asyncio.run(_svc(rt).stop("drift-1"))
    assert state is SandboxState.STOPPED
    assert ("stop", "drift-1") in rt.calls


def test_start_and_stop_unknown_raise_not_found():
    svc = _svc()
    with pytest.raises(SandboxNotFound):
        asyncio.run(svc.stop("ghost"))
    with pytest.raises(SandboxNotFound):
        asyncio.run(svc.start("ghost"))


def test_destroy_removes_store_record():
    rt = FakeAdminRuntime().seed("agent-1")
    store = InMemorySandboxStore()
    asyncio.run(store.put(_record("agent-1")))
    svc = _svc(rt, store)
    asyncio.run(svc.destroy("agent-1"))
    assert ("destroy", "agent-1") in rt.calls
    assert asyncio.run(store.get("agent-1")) is None


# ── Agent type + access (features 1 & 3) ──────────────────────────────────────

# An exposed OpenClaw: env carries the LAN bind + the gateway password + URL.
INSPECT_EXPOSED = {
    "config": {
        "name": "oc-1",
        "image": {"Oci": {"reference": "reef-oc:plugin"}},
        "env": [
            ["OPENCLAW_GATEWAY_BIND", "lan"],
            ["OPENCLAW_GATEWAY_AUTH", "token"],
            ["OPENCLAW_GATEWAY_TOKEN", "s3cret-pw"],
            ["OPENCLAW_PUBLIC_URL", "http://localhost:19000"],
        ],
    }
}

INSPECT_HERMES_EXPOSED = {
    "config": {
        "name": "hm-1",
        "image": {"Oci": {"reference": "reef-hm:plugin"}},
        "env": [
            ["REEF_HERMES_DASHBOARD", "1"],
            ["HERMES_DASHBOARD_HOST", "0.0.0.0"],
            ["HERMES_DASHBOARD_PORT", "9119"],
            ["REEF_HERMES_PUBLIC_URL", "http://localhost:19119"],
        ],
    }
}


def test_agent_type_inferred_from_image_for_drift():
    rt = FakeAdminRuntime()
    rt.seed("oc-x", image="reef-oc:plugin")
    rt.seed("hm-x", image="reef-hm:plugin")
    rt.seed("mystery", image="ubuntu:24.04")
    by_id = {e.sandbox_id: e for e in asyncio.run(_svc(rt).list_fleet())}
    assert by_id["oc-x"].agent_type == "openclaw"
    assert by_id["hm-x"].agent_type == "hermes"
    assert by_id["mystery"].agent_type == "unknown"


def test_get_detail_access_exposes_urls_but_never_the_password():
    # One-time model: detail surfaces the (non-secret) surface URLs so the UI can
    # render Open buttons, but NEVER the password — reef can't recompute it, and
    # the guest-env token stays masked. The password is revealed only at create.
    svc = _svc(FakeAdminRuntime().seed("oc-1", inspect=INSPECT_EXPOSED))
    d = asyncio.run(svc.get_detail("oc-1"))
    assert d.agent_type == "openclaw"
    assert d.access is not None
    assert d.access.kind == "openclaw"
    assert d.access.url == "http://localhost:19000"
    assert d.access.password is None  # never re-revealed
    assert d.env["OPENCLAW_GATEWAY_TOKEN"] == "***"  # generic env still masked


def test_get_detail_hermes_access_when_dashboard_exposed():
    svc = _svc(FakeAdminRuntime().seed("hm-1", inspect=INSPECT_HERMES_EXPOSED))
    d = asyncio.run(svc.get_detail("hm-1"))
    assert d.agent_type == "hermes"
    assert d.access is not None
    assert d.access.kind == "hermes"
    assert d.access.url == "http://localhost:19119"
    assert d.access.password is None


def test_get_detail_no_access_when_loopback():
    # INSPECT (from above) is loopback/token — not exposed.
    svc = _svc(FakeAdminRuntime().seed("oc-2", inspect=INSPECT))
    assert asyncio.run(svc.get_detail("oc-2")).access is None


# The Hermes dashboard as it actually boots — REEF_HERMES_DASHBOARD=1 AND the
# baked one-time password (which INSPECT_HERMES_EXPOSED omits on purpose, to test
# the detail view's password=None path).
INSPECT_HERMES_EXPOSED_PW = {
    "config": {
        "name": "hm-1",
        "image": {"Oci": {"reference": "reef-hm:plugin"}},
        "env": [
            ["REEF_HERMES_DASHBOARD", "1"],
            ["HERMES_DASHBOARD_HOST", "127.0.0.1"],
            ["REEF_HERMES_PROXY_PORT", "9119"],
            ["REEF_HERMES_DASHBOARD_PASSWORD", "dash-hunter2"],
            ["REEF_HERMES_PUBLIC_URL", "http://localhost:19119"],
        ],
    }
}


def test_reveal_access_returns_openclaw_gateway_token():
    # The deliberate opt-in reversal of the one-time posture: reveal reads the
    # gateway token BACK OUT of the guest env (bind=lan ⇒ exposed).
    svc = _svc(FakeAdminRuntime().seed("oc-1", inspect=INSPECT_EXPOSED))
    a = asyncio.run(svc.reveal_access("oc-1"))
    assert a is not None
    assert a.kind == "openclaw"
    assert a.password == "s3cret-pw"
    assert a.url == "http://localhost:19000"


def test_reveal_access_returns_hermes_dashboard_password():
    svc = _svc(FakeAdminRuntime().seed("hm-1", inspect=INSPECT_HERMES_EXPOSED_PW))
    a = asyncio.run(svc.reveal_access("hm-1"))
    assert a is not None
    assert a.kind == "hermes"
    assert a.password == "dash-hunter2"


def test_reveal_access_none_when_not_exposed():
    # Loopback/token bind — nothing to reveal.
    svc = _svc(FakeAdminRuntime().seed("oc-2", inspect=INSPECT))
    assert asyncio.run(svc.reveal_access("oc-2")) is None


def test_reveal_access_unknown_sandbox_is_not_found():
    import pytest

    from reef.errors import SandboxNotFound

    svc = _svc(FakeAdminRuntime())
    with pytest.raises(SandboxNotFound):
        asyncio.run(svc.reveal_access("ghost"))


# The SAME exposed OpenClaw as INSPECT_EXPOSED, but with env in microsandbox's
# ``{"key","value"}`` OBJECT shape (what prod `msb inspect` actually returns) —
# not docker's ``[[k, v]]`` pairs.
INSPECT_EXPOSED_MSB = {
    "config": {
        "name": "oc-msb",
        "image": {"Oci": {"reference": "reef-oc:plugin"}},
        "env": [
            {"key": "OPENCLAW_GATEWAY_BIND", "value": "lan"},
            {"key": "OPENCLAW_GATEWAY_AUTH", "value": "token"},
            {"key": "OPENCLAW_GATEWAY_TOKEN", "value": "s3cret-pw"},
            {"key": "OPENCLAW_PUBLIC_URL", "value": "http://localhost:19000"},
        ],
    }
}


def test_get_detail_access_reads_microsandbox_object_env_shape():
    # Regression: prod `msb inspect` returns env as {"key","value"} objects. A
    # pairs-only parser dropped every entry → empty env → the LAN-bind marker was
    # unseen → access came back None → the UI showed "This agent has no Control UI
    # surface" for EVERY microsandbox (Linux/prod) agent, while docker (macOS/dev)
    # worked. Reef must read the object shape identically to pairs.
    svc = _svc(FakeAdminRuntime().seed("oc-msb", inspect=INSPECT_EXPOSED_MSB))
    d = asyncio.run(svc.get_detail("oc-msb"))
    assert d.access is not None
    assert d.access.url == "http://localhost:19000"
    assert d.env["OPENCLAW_GATEWAY_TOKEN"] == "***"  # still masked


def test_env_dict_accepts_every_runtime_env_shape():
    # The parser must accept all shapes reef's runtimes emit, or exposure/access
    # detection (and the upgrade-path env replay) blanks out on one host.
    from reef.fleet import _env_dict

    # docker (dev) / docker adapter → [[k, v], …] pairs
    assert _env_dict({"env": [["A", "1"], ["B", "2"]]}) == {"A": "1", "B": "2"}
    # microsandbox (prod) `msb inspect` → [{"key","value"}, …] objects
    assert _env_dict({"env": [{"key": "A", "value": "1"}]}) == {"A": "1"}
    # defensive: [{"name","value"}, …] objects and ["KEY=VALUE", …] strings
    assert _env_dict({"env": [{"name": "A", "value": "1"}]}) == {"A": "1"}
    assert _env_dict({"env": ["A=1", "B=x=y"]}) == {"A": "1", "B": "x=y"}
    # missing value → empty string; junk entries skipped, never raising
    assert _env_dict({"env": [{"key": "A"}, 42, None, []]}) == {"A": ""}
    assert _env_dict({}) == {}


def test_get_detail_passes_through_volunteered_status():
    status = {
        "schema": 1,
        "agent": "openclaw",
        "versions": {"openclaw": "2026.5.28", "clawbitsPlugin": "0.4.12"},
    }
    svc = _svc(FakeAdminRuntime().seed("oc-1", inspect=INSPECT, status=status))
    d = asyncio.run(svc.get_detail("oc-1"))
    assert d.status == status
    assert d.status["versions"]["openclaw"] == "2026.5.28"


def test_get_detail_status_none_when_unreported():
    svc = _svc(FakeAdminRuntime().seed("oc-2", inspect=INSPECT))
    assert asyncio.run(svc.get_detail("oc-2")).status is None


def test_build_env_optional_clawbits_creds():
    p = OpenClawProfile(image="x")
    # Detached: no creds → no CLAWBITS_* keys. REEF_CAPS is always present and
    # empty — the entrypoint needs "granted nothing" to be distinguishable from
    # "this reef predates capabilities" so it can turn the gated features OFF.
    assert p.build_env({}) == {"REEF_CAPS": ""}
    # org-only (no token) → endpoint + org only; the entrypoint can't enroll
    # without a signup token, so no token / minted keys are injected
    org_only = p.build_env({"org_id": "o"})
    assert org_only == {
        "CLAWBITS_ENDPOINT": "https://clawbits.ai",
        "CLAWBITS_ORG_ID": "o",
        "REEF_CAPS": "",
    }
    assert "CLAWBITS_API_KEY" not in org_only
    assert "CLAWBITS_SIGNUP_TOKEN" not in org_only
    # org + signup token → token injected for the entrypoint's auto-enroll
    enroll = p.build_env({"org_id": "o", "signup_token": "human-tok"})
    assert enroll["CLAWBITS_ORG_ID"] == "o"
    assert enroll["CLAWBITS_SIGNUP_TOKEN"] == "human-tok"
    # a signup token with no org is meaningless → ignored
    assert "CLAWBITS_SIGNUP_TOKEN" not in p.build_env({"signup_token": "human-tok"})
    # custom endpoint is honored
    assert p.build_env({"org_id": "o", "endpoint": "https://x.test"})["CLAWBITS_ENDPOINT"] == (
        "https://x.test"
    )
    # a partial minted set (missing api_key/channel) is still treated as org-only
    partial = p.build_env({"org_id": "o", "agent_id": "a"})
    assert "CLAWBITS_AGENT_ID" not in partial and partial["CLAWBITS_ORG_ID"] == "o"
    # full set → minted creds injected too (pre-provisioned path)
    full = p.build_env({"org_id": "o", "agent_id": "a", "api_key": "k", "channel_id": "c"})
    assert full["CLAWBITS_ORG_ID"] == "o" and full["CLAWBITS_AGENT_ID"] == "a"


def test_hermes_build_env_clawbits_and_model_keys():
    p = HermesProfile(image="x")
    # GATEWAY_ALLOW_ALL_USERS defers authorization to clawbits (which already gates
    # who may DM/tag the agent); without it hermes dead-ends every human message on a
    # `hermes pairing approve` prompt nobody can run inside the microVM.
    assert p.build_env({}) == {
        "HERMES_ACCEPT_HOOKS": "1",
        "GATEWAY_ALLOW_ALL_USERS": "true",
    }
    enroll = p.build_env(
        {
            "org_id": "o",
            "endpoint": "https://x.test",
            "signup_token": "human-tok",
            "openai_api_key": "sk-oai",
            "anthropic_api_key": "sk-ant",
        }
    )
    assert enroll["CLAWBITS_BASE_URL"] == "https://x.test"
    assert enroll["CLAWBITS_ORG_ID"] == "o"
    assert enroll["CLAWBITS_SIGNUP_TOKEN"] == "human-tok"
    assert enroll["OPENAI_API_KEY"] == "sk-oai"
    assert enroll["ANTHROPIC_API_KEY"] == "sk-ant"
    full = p.build_env({"agent_id": "a", "api_key": "k", "channel_id": "c"})
    assert full["CLAWBITS_AGENT_ID"] == "a"
    assert full["CLAWBITS_API_KEY"] == "k"
    assert full["CLAWBITS_CHANNEL_ID"] == "c"


def test_build_env_chatgpt_subscription_marker():
    p = OpenClawProfile(image="x")
    # The oauth marker (from resolve_creds) + the pinned Codex-safe model (from
    # resolve_model) flip the guest into subscription mode: Codex-harness signal
    # for the entrypoint, the guided terminal shell, the model as
    # REEF_DEFAULT_MODEL - and crucially NO OPENAI_API_KEY (reef holds no token).
    env = p.build_env({"openai_codex": "1", "model": "openai/gpt-5.4"})
    assert env["REEF_OPENAI_AUTH"] == "subscription"
    assert env["REEF_TERMINAL_SHELL"] == "openclaw"
    assert env["REEF_DEFAULT_MODEL"] == "openai/gpt-5.4"
    assert "OPENAI_API_KEY" not in env
    # The marker itself never leaks into the guest env as a bogus key.
    assert "openai_codex" not in env and "" not in env


# ── Create (feature 2) ────────────────────────────────────────────────────────


def _svc_with_manager(
    backend: str = "fake",
) -> tuple[FleetService, FakeAdminRuntime, InMemorySandboxStore]:
    rt = FakeAdminRuntime()
    store = InMemorySandboxStore()
    mgr = SandboxManager(rt, store, backend=backend)
    return FleetService(rt, store, manager=mgr), rt, store


def test_create_openclaw_exposes_and_returns_access():
    svc, _rt, store = _svc_with_manager()
    sandbox, exp = asyncio.run(svc.create("openclaw", name="oc-new"))
    assert sandbox.sandbox_id == "oc-new"
    assert sandbox.profile == "openclaw"
    assert sandbox.state is SandboxState.RUNNING
    assert exp.url.startswith("http://127.0.0.1:")
    assert exp.password  # generated, returned once
    rec = asyncio.run(store.get("oc-new"))
    assert rec.port is not None and rec.url == exp.url


def test_create_hermes_exposes_dashboard():
    svc, rt, store = _svc_with_manager()
    sandbox, exp = asyncio.run(svc.create("hermes", name="hm-new"))
    assert sandbox.sandbox_id == "hm-new"
    assert sandbox.profile == "hermes"
    assert sandbox.state is SandboxState.RUNNING
    assert exp.url.startswith("http://127.0.0.1:")
    spec = rt.created[-1]
    assert spec.image == "reef-hm:plugin"
    assert spec.volume_dest == "/opt/data"
    assert "127.0.0.1:" in spec.ports[0] and spec.ports[0].endswith(":9119")
    assert spec.env["REEF_HERMES_DASHBOARD"] == "1"
    # The microsandbox boot handoff. msb ignores the image's ENTRYPOINT/CMD and runs
    # ONLY what --init names, so a None here booted the VM and started nothing at all:
    # dead dashboard, 0-byte kernel.log, no logs in reef. Asserted on the SPEC (not
    # just the profile attr) because the spec is what actually reaches the runtime.
    assert spec.init == "/usr/local/bin/reef-hermes-init"
    rec = asyncio.run(store.get("hm-new"))
    assert rec.port is not None and rec.url == exp.url
    # Hermes now ships a ttyd web terminal. It is not a nicety: the ChatGPT-subscription
    # provider is OAuth (no key for reef to inject), so the owner has to run the
    # device-code login inside the guest, and this is the only surface that can.
    assert exp.terminal_url is not None


def test_hermes_gets_the_provider_key_and_the_model_pick():
    """Hermes must receive BOTH the provider key and REEF_DEFAULT_MODEL.

    Its stock config is ``provider: auto`` + ``base_url: openrouter.ai``, and ``auto``
    maps an OPENAI_API_KEY to *openrouter* — so an agent created with an OpenAI key
    called openrouter with no OPENROUTER_API_KEY and every reply died on
    ``401 Missing Authentication header``. The entrypoint pins the right provider, but
    it can only do that from the env reef injects: the key names WHICH provider, and
    REEF_DEFAULT_MODEL names the model. The hand-rolled build_env used to drop the
    model entirely.
    """
    svc, rt, _store = _svc_with_manager()
    asyncio.run(svc.create("hermes", name="hm-model", openai_api_key="sk-oai", model="gpt-5.4"))
    env = rt.created[-1].env
    assert env["OPENAI_API_KEY"] == "sk-oai"
    assert env["REEF_DEFAULT_MODEL"] == "gpt-5.4"


def test_hermes_gets_the_openrouter_key():
    # The deliberate version of the openrouter story above: with an
    # OPENROUTER_API_KEY injected, the key and the stock openrouter.ai
    # endpoint finally match (the run script pins provider=openrouter). The
    # model pick is a full vendor/model slug for this provider.
    svc, rt, _store = _svc_with_manager()
    asyncio.run(
        svc.create(
            "hermes",
            name="hm-or",
            openrouter_api_key="sk-or-1",
            model="anthropic/claude-opus-4.6",
        )
    )
    env = rt.created[-1].env
    assert env["OPENROUTER_API_KEY"] == "sk-or-1"
    assert env["REEF_DEFAULT_MODEL"] == "anthropic/claude-opus-4.6"


def test_hermes_gateway_defers_authorization_to_clawbits():
    """Hermes' gateway denies unknown senders by default and falls back to a DM-pairing
    flow ("ask the bot owner to run `hermes pairing approve clawbits <code>`") — which
    nobody can do inside a reef microVM, so every human message dead-ends there.

    Clawbits is already the authorization boundary (org membership + the
    closed-by-default contact-permission grants the server enforces), and a plugin
    platform has no per-platform allowlist hook in hermes — the maps are keyed off a
    hard-coded Platform enum. The global flag is the only lever.
    """
    svc, rt, _store = _svc_with_manager()
    asyncio.run(svc.create("hermes", name="hm-authz"))
    assert rt.created[-1].env["GATEWAY_ALLOW_ALL_USERS"] == "true"


def test_hermes_dashboard_is_loopback_bound_behind_a_password():
    """The forwarded port is the nginx BASIC-AUTH PROXY, never the dashboard itself.

    Hermes' `--insecure` is not a bind guard — it is the OFF switch for the
    dashboard's auth gate (web_server.should_require_auth), and in that mode the SPA
    HTML carries the session token, so anyone who could reach the port could pull the
    agent's API keys via /api/reveal. The entrypoint only adds `--insecure` for a
    non-loopback bind, so pinning the dashboard to 127.0.0.1 is what keeps the flag
    (and the unauthenticated surface) out of the picture. Guard all three legs of
    that: loopback bind, distinct proxy port = the forwarded one, and a real secret.
    """
    svc, rt, _store = _svc_with_manager()
    _sandbox, exp = asyncio.run(svc.create("hermes", name="hm-auth"))
    env = rt.created[-1].env

    assert env["HERMES_DASHBOARD_HOST"] == "127.0.0.1"  # ⇒ entrypoint never adds --insecure
    assert env["HERMES_DASHBOARD_PORT"] == "9118"  # the dashboard, NOT forwarded
    assert env["REEF_HERMES_PROXY_PORT"] == "9119"  # the proxy — this is what reef forwards
    assert rt.created[-1].ports[0].endswith(":9119")  # …and it is indeed the forwarded one
    # A real one-time secret guards it, and the guest gets the same value to hash
    # into nginx's htpasswd.
    assert exp.password
    assert env["REEF_HERMES_DASHBOARD_PASSWORD"] == exp.password
    assert env["REEF_HERMES_DASHBOARD_USER"] == "reef"
    # ONE secret unlocks both surfaces: the same password guards the ttyd terminal
    # (ttyd --credential), so exposing a shell never widens the credential surface.
    assert env["REEF_TERMINAL_PASSWORD"] == exp.password
    assert env["REEF_TERMINAL_PORT"] == "7681"
    assert exp.terminal_url is not None


def _img_info(tag, agent_type):
    return ImageInfo(
        tag=tag, image_id="sha256:z", created_at=None, size_bytes=1,
        reef_image_version=None, runtime_version=None, component_version=None,
        is_active=False, agent_type=agent_type,
    )


def _active_image(agent_type, runtime_version, component_version):
    """An is_active image of ``agent_type`` carrying the given baked versions — the
    versions an agent of that type SHOULD run (drives the version-based upgrade
    signal)."""
    return ImageInfo(
        tag=active_tag(agent_type), image_id=f"sha256:{agent_type}", created_at=None,
        size_bytes=1, reef_image_version="stack", runtime_version=runtime_version,
        component_version=component_version, is_active=True, agent_type=agent_type,
    )


def test_create_rejects_image_of_wrong_agent_type():
    # A reef-ic image can't be booted under the openclaw profile (and vice versa).
    svc, rt, _store = _svc_with_manager()
    rt.image_list = [_img_info("reef-ic:channel", "ironclaw")]
    with pytest.raises(ValueError, match="not openclaw"):
        asyncio.run(svc.create("openclaw", name="mismatch", image="reef-ic:channel"))


def test_create_rejects_unknown_image():
    svc, _rt, _store = _svc_with_manager()  # image_list is empty by default
    with pytest.raises(ValueError, match="unknown image"):
        asyncio.run(svc.create("openclaw", name="ghost", image="reef-oc:nope"))


def test_create_with_matching_image_override_boots_that_tag():
    svc, rt, store = _svc_with_manager()
    rt.image_list = [_img_info("reef-oc:0.5.0", "openclaw")]
    sandbox, _exp = asyncio.run(svc.create("openclaw", name="oc-pin", image="reef-oc:0.5.0"))
    assert sandbox.sandbox_id == "oc-pin"
    rec = asyncio.run(store.get("oc-pin"))
    assert rec.image == "reef-oc:0.5.0"  # the pinned tag, not the type's default


def test_create_openclaw_with_org_seeds_clawbits_env():
    svc, rt, _store = _svc_with_manager()
    asyncio.run(
        svc.create("openclaw", name="oc-cb", org_id="acme", clawbits_url="https://clawbits.example")
    )
    spec = rt.created[-1]
    assert spec.env["CLAWBITS_ORG_ID"] == "acme"
    assert spec.env["CLAWBITS_ENDPOINT"] == "https://clawbits.example"
    assert "CLAWBITS_API_KEY" not in spec.env  # org-only: minted by signup, not injected


def test_create_openclaw_with_org_requires_explicit_clawbits_url():
    svc, _rt, _store = _svc_with_manager()
    with pytest.raises(ValueError, match="clawbits_url is required"):
        asyncio.run(svc.create("openclaw", name="oc-env", org_id="acme"))


def test_create_openclaw_with_local_msb_endpoint_allows_host_and_public_egress():
    svc, rt, _store = _svc_with_manager()
    asyncio.run(
        svc.create(
            "openclaw",
            name="oc-local",
            org_id="acme",
            clawbits_url="http://host.microsandbox.internal:8000",
        )
    )
    spec = rt.created[-1]
    assert spec.net_allow == ("public", "host")


def test_normalize_local_endpoint_swaps_host_for_runtime_alias():
    # The clawbits UI can't know which runtime a reef drives, so a local-dev
    # create may name the host as localhost or as the other runtime's alias —
    # both unreachable from inside the guest. Scheme + port survive the swap.
    norm = _normalize_local_endpoint
    for local in ("http://localhost:8000", "http://127.0.0.1:8000", "http://host.docker.internal:8000"):
        assert norm(local, "microsandbox") == "http://host.microsandbox.internal:8000"
        assert norm(local, "docker") == "http://host.docker.internal:8000"
    assert norm("http://host.microsandbox.internal:8000", "docker") == (
        "http://host.docker.internal:8000"
    )
    assert norm("https://localhost", "microsandbox") == "https://host.microsandbox.internal"


def test_normalize_local_endpoint_leaves_public_and_unknown_untouched():
    # Prod/staging endpoints (and anything on an unrecognized backend) must
    # never be rewritten — the guest reaches them over public egress.
    norm = _normalize_local_endpoint
    for public in ("https://clawbits.ai", "https://freeclaws.ai", "http://10.3.155.205:8000"):
        assert norm(public, "microsandbox") == public
        assert norm(public, "docker") == public
    assert norm("http://localhost:8000", "fake") == "http://localhost:8000"


def test_create_normalizes_local_endpoint_per_runtime():
    # End-to-end through create(): the guest env gets the runtime's own alias
    # (with host egress allowed), regardless of which local form came in.
    svc, rt, _store = _svc_with_manager(backend="microsandbox")
    asyncio.run(
        svc.create(
            "openclaw",
            name="oc-msb",
            org_id="acme",
            clawbits_url="http://host.docker.internal:8000",
        )
    )
    spec = rt.created[-1]
    assert spec.env["CLAWBITS_ENDPOINT"] == "http://host.microsandbox.internal:8000"
    assert spec.net_allow == ("public", "host")

    svc, rt, _store = _svc_with_manager(backend="docker")
    asyncio.run(
        svc.create("openclaw", name="oc-dkr", org_id="acme", clawbits_url="http://localhost:8000")
    )
    spec = rt.created[-1]
    assert spec.env["CLAWBITS_ENDPOINT"] == "http://host.docker.internal:8000"
    assert spec.net_allow == ("public", "host")


def test_create_keeps_public_clawbits_endpoint_untouched():
    # Prod (clawbits.ai) and staging (freeclaws.ai) flow through verbatim.
    for i, url in enumerate(("https://clawbits.ai", "https://freeclaws.ai")):
        svc, rt, _store = _svc_with_manager(backend="microsandbox")
        asyncio.run(svc.create("openclaw", name=f"oc-pub-{i}", org_id="acme", clawbits_url=url))
        spec = rt.created[-1]
        assert spec.env["CLAWBITS_ENDPOINT"] == url
        assert spec.net_allow == ()


def test_create_openclaw_with_private_endpoint_allows_private_and_public_egress():
    svc, rt, _store = _svc_with_manager()
    asyncio.run(
        svc.create("openclaw", name="oc-lan", org_id="acme", clawbits_url="http://10.3.155.205:8000")
    )
    spec = rt.created[-1]
    assert spec.net_allow == ("public", "private")


def test_create_openclaw_with_signup_token_injects_it():
    svc, rt, _store = _svc_with_manager()
    asyncio.run(
        svc.create(
            "openclaw",
            name="oc-tok",
            org_id="acme",
            clawbits_url="https://clawbits.example",
            signup_token="human-xyz",
        )
    )
    spec = rt.created[-1]
    assert spec.env["CLAWBITS_ORG_ID"] == "acme"
    assert spec.env["CLAWBITS_SIGNUP_TOKEN"] == "human-xyz"


def test_create_hermes_with_signup_token_injects_plugin_env():
    svc, rt, _store = _svc_with_manager()
    asyncio.run(
        svc.create(
            "hermes",
            name="hm-tok",
            org_id="acme",
            clawbits_url="https://clawbits.example",
            signup_token="human-xyz",
        )
    )
    spec = rt.created[-1]
    assert spec.env["CLAWBITS_BASE_URL"] == "https://clawbits.example"
    assert spec.env["CLAWBITS_ORG_ID"] == "acme"
    assert spec.env["CLAWBITS_SIGNUP_TOKEN"] == "human-xyz"


def test_create_openclaw_without_org_is_detached():
    svc, rt, _store = _svc_with_manager()
    asyncio.run(svc.create("openclaw", name="oc-detached"))
    spec = rt.created[-1]
    assert not any(k.startswith("CLAWBITS_") for k in spec.env)
    assert "OPENAI_API_KEY" not in spec.env  # no key passed → not injected


def test_create_openclaw_injects_optional_openai_key():
    # A detached VM with just an OpenAI key: no clawbits channel, but the key is
    # injected as OPENAI_API_KEY (the gateway reads it natively).
    svc, rt, _store = _svc_with_manager()
    asyncio.run(svc.create("openclaw", name="oc-oai", openai_api_key="sk-oai-123"))
    spec = rt.created[-1]
    assert spec.env["OPENAI_API_KEY"] == "sk-oai-123"
    assert not any(k.startswith("CLAWBITS_") for k in spec.env)


def test_create_openclaw_injects_optional_anthropic_key():
    # Same as the OpenAI path: an Anthropic key is injected as ANTHROPIC_API_KEY
    # (the entrypoint uses it to onboard the gateway non-interactively).
    svc, rt, _store = _svc_with_manager()
    asyncio.run(svc.create("openclaw", name="oc-ant", anthropic_api_key="sk-ant-123"))
    spec = rt.created[-1]
    assert spec.env["ANTHROPIC_API_KEY"] == "sk-ant-123"
    assert not any(k.startswith("CLAWBITS_") for k in spec.env)


def test_create_openclaw_injects_optional_nearai_key():
    # Same shape for NEAR Cloud AI: the key rides as NEARAI_API_KEY (the
    # entrypoint registers the custom OpenAI-compatible provider from it).
    svc, rt, _store = _svc_with_manager()
    asyncio.run(svc.create("openclaw", name="oc-near", nearai_api_key="sk-near-123"))
    spec = rt.created[-1]
    assert spec.env["NEARAI_API_KEY"] == "sk-near-123"
    assert not any(k.startswith("CLAWBITS_") for k in spec.env)


def test_create_openclaw_injects_optional_openrouter_key():
    # Same shape for OpenRouter: the key rides as OPENROUTER_API_KEY (the
    # entrypoint onboards the bundled plugin's native auth-choice from it).
    svc, rt, _store = _svc_with_manager()
    asyncio.run(svc.create("openclaw", name="oc-or", openrouter_api_key="sk-or-123"))
    spec = rt.created[-1]
    assert spec.env["OPENROUTER_API_KEY"] == "sk-or-123"
    assert not any(k.startswith("CLAWBITS_") for k in spec.env)


# ── Reef-level provider keys (REEF_*_API_KEY, forwarded at create) ───────────


def test_create_forwards_all_reef_level_keys_when_provider_omitted(monkeypatch):
    # The maintainer set keys in reef's env and the caller predates the picker
    # (no ``provider`` field): every configured key reaches the VM.
    monkeypatch.setenv("REEF_ANTHROPIC_API_KEY", "srv-ant")
    monkeypatch.setenv("REEF_OPENAI_API_KEY", "srv-oai")
    svc, rt, _store = _svc_with_manager()
    asyncio.run(svc.create("openclaw", name="oc-all"))
    spec = rt.created[-1]
    assert spec.env["ANTHROPIC_API_KEY"] == "srv-ant"
    assert spec.env["OPENAI_API_KEY"] == "srv-oai"


def test_create_provider_pick_narrows_to_one_reef_level_key(monkeypatch):
    monkeypatch.setenv("REEF_ANTHROPIC_API_KEY", "srv-ant")
    monkeypatch.setenv("REEF_OPENAI_API_KEY", "srv-oai")
    svc, rt, _store = _svc_with_manager()
    asyncio.run(svc.create("openclaw", name="oc-pick", provider="anthropic"))
    spec = rt.created[-1]
    assert spec.env["ANTHROPIC_API_KEY"] == "srv-ant"
    assert "OPENAI_API_KEY" not in spec.env


def test_create_provider_none_skips_reef_level_keys(monkeypatch):
    monkeypatch.setenv("REEF_ANTHROPIC_API_KEY", "srv-ant")
    monkeypatch.setenv("REEF_OPENAI_API_KEY", "srv-oai")
    svc, rt, _store = _svc_with_manager()
    asyncio.run(svc.create("openclaw", name="oc-nokey", provider="none"))
    spec = rt.created[-1]
    assert "ANTHROPIC_API_KEY" not in spec.env
    assert "OPENAI_API_KEY" not in spec.env


def test_create_request_key_wins_over_reef_level(monkeypatch):
    monkeypatch.setenv("REEF_ANTHROPIC_API_KEY", "srv-ant")
    svc, rt, _store = _svc_with_manager()
    asyncio.run(
        svc.create("openclaw", name="oc-byok", provider="anthropic", anthropic_api_key="sk-mine")
    )
    assert rt.created[-1].env["ANTHROPIC_API_KEY"] == "sk-mine"


def test_create_byok_satisfies_an_unconfigured_pick():
    # Picking a provider reef has no key for is fine when the caller brings one.
    svc, rt, _store = _svc_with_manager()
    asyncio.run(svc.create("openclaw", name="oc-own", provider="openai", openai_api_key="sk-oai"))
    spec = rt.created[-1]
    assert spec.env["OPENAI_API_KEY"] == "sk-oai"
    assert "ANTHROPIC_API_KEY" not in spec.env


def test_create_unconfigured_pick_without_key_rejected():
    svc, _rt, _store = _svc_with_manager()
    with pytest.raises(ValueError, match="no key on this reef"):
        asyncio.run(svc.create("openclaw", name="oc-bad", provider="anthropic"))


def test_create_unknown_provider_rejected():
    svc, _rt, _store = _svc_with_manager()
    with pytest.raises(ValueError, match="unknown provider"):
        asyncio.run(svc.create("openclaw", name="oc-unk", provider="grok"))


def test_create_autogenerates_name():
    svc, _rt, _store = _svc_with_manager()
    sandbox, _exp = asyncio.run(svc.create("openclaw"))
    # Docker-style ``adjective-noun`` — no type prefix.
    assert re.match(r"^[a-z]+-[a-z]+$", sandbox.sandbox_id)


# ── Custom guest env (CreateSandboxIn.env) ────────────────────────────────────


def test_create_with_custom_env_lands_in_spec():
    svc, rt, _store = _svc_with_manager()
    asyncio.run(
        svc.create(
            "openclaw",
            name="oc-env",
            env={"WORKSPACE_REPO": "https://github.com/a/b", "PIRATE_MODE": "1"},
        )
    )
    spec = rt.created[-1]
    assert spec.env["WORKSPACE_REPO"] == "https://github.com/a/b"
    assert spec.env["PIRATE_MODE"] == "1"
    assert not any(k.startswith("CLAWBITS_") for k in spec.env)  # still detached


def test_create_custom_env_allows_openclaw_config_keys():
    # OPENCLAW_* is not blanket-banned — state-dir overrides etc. are the use
    # case; only the gateway/exposure keys reef itself manages are reserved.
    svc, rt, _store = _svc_with_manager()
    asyncio.run(svc.create("openclaw", name="oc-sd", env={"OPENCLAW_STATE_DIR": "/data"}))
    assert rt.created[-1].env["OPENCLAW_STATE_DIR"] == "/data"


def test_create_rejects_reserved_env_keys():
    svc, _rt, _store = _svc_with_manager()
    for key in (
        "ANTHROPIC_API_KEY",
        "NEARAI_API_KEY",
        "OPENCLAW_GATEWAY_TOKEN",
        "CLAWBITS_ORG_ID",
        "CLAWBITS_BASE_URL",  # Hermes' spelling of the clawbits endpoint
    ):
        with pytest.raises(ValueError, match="managed by reef"):
            asyncio.run(svc.create("openclaw", name="oc-res", env={key: "x"}))


def test_create_rejects_reef_prefixed_env_keys():
    svc, _rt, _store = _svc_with_manager()
    with pytest.raises(ValueError, match="managed by reef"):
        asyncio.run(svc.create("openclaw", name="oc-pre", env={"REEF_DEFAULT_MODEL": "x"}))


def test_create_rejects_invalid_env_keys():
    svc, _rt, _store = _svc_with_manager()
    for key in ("9BAD", "BAD-KEY", "", "HAS SPACE"):
        with pytest.raises(ValueError, match="invalid env key"):
            asyncio.run(svc.create("openclaw", name="oc-badkey", env={key: "x"}))


def test_create_rejects_env_over_caps():
    svc, _rt, _store = _svc_with_manager()
    with pytest.raises(ValueError, match="too many env vars"):
        asyncio.run(svc.create("openclaw", name="oc-many", env={f"K{i}": "v" for i in range(33)}))
    with pytest.raises(ValueError, match="too long"):
        asyncio.run(svc.create("openclaw", name="oc-long", env={"K": "v" * 4097}))
    with pytest.raises(ValueError, match="invalid env key"):
        asyncio.run(svc.create("openclaw", name="oc-lkey", env={"K" * 129: "v"}))
    with pytest.raises(ValueError, match="NUL byte"):
        asyncio.run(svc.create("openclaw", name="oc-nul", env={"K": "a\x00b"}))


def test_create_empty_env_is_noop():
    # Key sets only: values include per-create randoms (gateway token, port URL).
    svc, rt, _store = _svc_with_manager()
    asyncio.run(svc.create("openclaw", name="oc-none"))
    baseline = set(rt.created[-1].env)
    asyncio.run(svc.create("openclaw", name="oc-empty", env={}))
    assert set(rt.created[-1].env) == baseline


def test_create_hermes_autogenerates_name():
    svc, _rt, _store = _svc_with_manager()
    sandbox, _exp = asyncio.run(svc.create("hermes"))
    assert re.match(r"^[a-z]+-[a-z]+$", sandbox.sandbox_id)
    assert sandbox.profile == "hermes"


def test_create_rejects_unknown():
    svc, _rt, _store = _svc_with_manager()
    with pytest.raises(ValueError):
        asyncio.run(svc.create("nope"))  # unknown


def test_create_rejects_invalid_name():
    svc, _rt, _store = _svc_with_manager()
    with pytest.raises(ValueError):
        asyncio.run(svc.create("openclaw", name="bad name/slash"))


def test_create_requires_a_manager():
    with pytest.raises(RuntimeError):
        asyncio.run(_svc().create("openclaw"))


# ── Color (operator-chosen dashboard accent) ──────────────────────────────────


def test_set_color_persists_and_surfaces_in_list_and_detail():
    rt = FakeAdminRuntime().seed("agent-1", inspect=INSPECT)
    store = InMemorySandboxStore()
    asyncio.run(store.put(_record("agent-1")))
    svc = _svc(rt, store)
    rec = asyncio.run(svc.set_color("agent-1", "violet"))
    assert rec.color == "violet"
    entry = {e.sandbox_id: e for e in asyncio.run(svc.list_fleet())}["agent-1"]
    assert entry.color == "violet"
    assert asyncio.run(svc.get_detail("agent-1")).color == "violet"


def test_set_color_rejects_invalid_value():
    rt = FakeAdminRuntime().seed("agent-1")
    store = InMemorySandboxStore()
    asyncio.run(store.put(_record("agent-1")))
    with pytest.raises(ValueError):
        asyncio.run(_svc(rt, store).set_color("agent-1", "chartreuse"))


def test_set_color_rejects_unmanaged_drift():
    # No store record → nothing to attach the color to.
    rt = FakeAdminRuntime().seed("drift-1")
    with pytest.raises(ValueError):
        asyncio.run(_svc(rt).set_color("drift-1", "blue"))


def test_color_defaults_to_none():
    rt = FakeAdminRuntime().seed("agent-1", inspect=INSPECT)
    store = InMemorySandboxStore()
    asyncio.run(store.put(_record("agent-1")))
    assert asyncio.run(_svc(rt, store).get_detail("agent-1")).color is None


# ── Restart (stop + start in place) ───────────────────────────────────────────


def test_restart_stops_then_starts_and_syncs_store():
    rt = FakeAdminRuntime().seed("agent-1")
    store = InMemorySandboxStore()
    asyncio.run(store.put(_record("agent-1", state=SandboxState.RUNNING)))
    svc = _svc(rt, store)
    state = asyncio.run(svc.restart("agent-1"))
    assert state is SandboxState.RUNNING
    assert rt.calls.index(("stop", "agent-1")) < rt.calls.index(("start", "agent-1"))
    assert asyncio.run(store.get("agent-1")).state is SandboxState.RUNNING


def test_restart_works_on_drift_without_record():
    rt = FakeAdminRuntime().seed("drift-1")
    state = asyncio.run(_svc(rt).restart("drift-1"))
    assert state is SandboxState.RUNNING
    assert ("stop", "drift-1") in rt.calls and ("start", "drift-1") in rt.calls


def test_restart_unknown_raises_not_found():
    with pytest.raises(SandboxNotFound):
        asyncio.run(_svc().restart("ghost"))


# ── Self-healing: desired_state + restart_policy ──────────────────────────────


def test_start_sets_desired_running_and_clears_backoff():
    rt = FakeAdminRuntime().seed("a")
    store = InMemorySandboxStore()
    asyncio.run(store.put(_record("a", state=SandboxState.STOPPED, restart_count=3)))
    asyncio.run(_svc(rt, store).start("a"))
    rec = asyncio.run(store.get("a"))
    assert rec.desired_state is DesiredState.RUNNING
    assert rec.restart_count == 0 and rec.last_restart_at is None


def test_stop_sets_desired_stopped():
    rt = FakeAdminRuntime().seed("a")
    store = InMemorySandboxStore()
    asyncio.run(store.put(_record("a")))
    asyncio.run(_svc(rt, store).stop("a"))
    assert asyncio.run(store.get("a")).desired_state is DesiredState.STOPPED


def test_restart_sets_desired_running_and_clears_backoff():
    rt = FakeAdminRuntime().seed("a")
    store = InMemorySandboxStore()
    asyncio.run(store.put(_record("a", restart_count=5)))
    asyncio.run(_svc(rt, store).restart("a"))
    rec = asyncio.run(store.get("a"))
    assert rec.desired_state is DesiredState.RUNNING and rec.restart_count == 0


def test_create_defaults_to_on_failure_and_desired_running():
    svc, _rt, _store = _svc_with_manager()
    sandbox, _exp = asyncio.run(svc.create("openclaw", name="oc-p"))
    assert sandbox.desired_state is DesiredState.RUNNING
    assert sandbox.restart_policy is RestartPolicy.ON_FAILURE


def test_create_honors_restart_policy():
    svc, _rt, _store = _svc_with_manager()
    sandbox, _exp = asyncio.run(svc.create("openclaw", name="oc-always", restart_policy="always"))
    assert sandbox.restart_policy is RestartPolicy.ALWAYS


def test_create_rejects_invalid_restart_policy():
    svc, _rt, _store = _svc_with_manager()
    with pytest.raises(ValueError):
        asyncio.run(svc.create("openclaw", name="oc-bad", restart_policy="sometimes"))


def test_update_settings_sets_restart_policy():
    rt = FakeAdminRuntime().seed("a")
    store = InMemorySandboxStore()
    asyncio.run(store.put(_record("a")))
    rec = asyncio.run(_svc(rt, store).update_settings("a", restart_policy="never"))
    assert rec.restart_policy is RestartPolicy.NEVER


def test_update_settings_rejects_invalid_policy_and_drift():
    rt = FakeAdminRuntime().seed("a")
    store = InMemorySandboxStore()
    asyncio.run(store.put(_record("a")))
    with pytest.raises(ValueError):
        asyncio.run(_svc(rt, store).update_settings("a", restart_policy="nope"))
    with pytest.raises(ValueError):
        asyncio.run(_svc().update_settings("ghost", restart_policy="always"))  # drift/unknown


def test_self_healing_fields_surface_in_list_and_detail():
    rt = FakeAdminRuntime().seed("a", inspect=INSPECT)
    store = InMemorySandboxStore()
    asyncio.run(store.put(_record("a", restart_policy=RestartPolicy.ALWAYS)))
    svc = _svc(rt, store)
    entry = {e.sandbox_id: e for e in asyncio.run(svc.list_fleet())}["a"]
    assert entry.desired_state is DesiredState.RUNNING
    assert entry.restart_policy is RestartPolicy.ALWAYS
    assert asyncio.run(svc.get_detail("a")).restart_policy is RestartPolicy.ALWAYS


def test_list_fleet_exposes_version_upgrade_signal():
    """A managed VM whose REPORTED versions (status.json) are behind the active
    image's baked versions is flagged upgradeable; one on the active versions is
    not. No digests involved — so a same-version rebuild never false-flags."""
    rt = FakeAdminRuntime()
    rt.seed("old-1", status={"versions": {"openclaw": "2026.6.9", "clawbitsPlugin": "0.8.0"}})
    rt.seed("current-1", status={"versions": {"openclaw": "2026.6.10", "clawbitsPlugin": "0.8.1"}})
    rt.image_list = [_active_image("openclaw", "2026.6.10", "0.8.1")]
    store = InMemorySandboxStore()
    asyncio.run(store.put(_record("old-1")))
    asyncio.run(store.put(_record("current-1")))

    entries = {e.sandbox_id: e for e in asyncio.run(_svc(rt, store).list_fleet())}

    assert entries["old-1"].upgrade_available is True
    assert entries["old-1"].image_version == "oc2026.6.9-pl0.8.0"
    assert entries["current-1"].upgrade_available is False
    assert entries["current-1"].image_version == "oc2026.6.10-pl0.8.1"


def test_get_detail_exposes_version_upgrade_signal():
    rt = FakeAdminRuntime().seed(
        "agent-1",
        inspect=INSPECT,
        status={"versions": {"openclaw": "2026.6.9", "clawbitsPlugin": "0.8.0"}},
    )
    rt.image_list = [_active_image("openclaw", "2026.6.10", "0.8.1")]
    store = InMemorySandboxStore()
    asyncio.run(store.put(_record("agent-1")))

    d = asyncio.run(_svc(rt, store).get_detail("agent-1"))

    assert d.upgrade_available is True
    assert d.image_version == "oc2026.6.9-pl0.8.0"


def test_unreported_vm_has_no_upgrade_signal():
    """A VM that hasn't written status.json yet gets no signal (safe default), even
    when a newer active image exists — no legacy null-gap false-positive/negative."""
    rt = FakeAdminRuntime().seed("quiet-1")  # no status reported
    rt.image_list = [_active_image("openclaw", "2026.6.10", "0.8.1")]
    store = InMemorySandboxStore()
    asyncio.run(store.put(_record("quiet-1")))

    entries = {e.sandbox_id: e for e in asyncio.run(_svc(rt, store).list_fleet())}

    assert entries["quiet-1"].upgrade_available is False
    assert entries["quiet-1"].image_version is None


def test_ironclaw_upgrade_signal_uses_ironclaw_active_image():
    """Type-correctness: an ironclaw agent is compared against the IRONCLAW active
    image (channel), not the openclaw one (the old digest bug computed it against
    the openclaw tag)."""
    rt = FakeAdminRuntime()
    rt.seed(
        "ic-1",
        image="reef-ic:channel",
        status={"versions": {"ironclaw": "0.3.1", "clawbitsChannel": "0.1.0"}},
    )
    rt.image_list = [
        _active_image("openclaw", "2026.6.10", "0.8.1"),
        _active_image("ironclaw", "0.3.1", "0.2.0"),  # channel bumped 0.1.0 → 0.2.0
    ]
    store = InMemorySandboxStore()
    asyncio.run(store.put(_record("ic-1", profile="ironclaw", image="reef-ic:channel")))

    entries = {e.sandbox_id: e for e in asyncio.run(_svc(rt, store).list_fleet())}

    assert entries["ic-1"].agent_type == "ironclaw"
    assert entries["ic-1"].upgrade_available is True  # channel behind
    assert entries["ic-1"].image_version == "ic0.3.1-ch0.1.0"


def test_every_enabled_agent_type_declares_a_boot_handoff():
    """Regression guard for the Hermes "no logs" bug (init was None).

    On Linux — the prod/default backend — reef runs microsandbox, which IGNORES the
    image's ENTRYPOINT/CMD and execs only `msb create --init <path>`. A profile with
    ``init = None`` therefore boots a microVM that starts nothing: no agent, no
    listener, and a 0-byte kernel.log (the very file the logs endpoint falls back to
    reading — so the failure surfaces as "no log output" rather than a crash).

    Docker hides this, because it honours ENTRYPOINT/CMD — which is why Hermes looked
    fine in dev and was dead in prod. Any new runtime must declare its handoff.
    """
    from reef.agents import AGENT_TYPES

    for name, at in AGENT_TYPES.items():
        if not at.enabled:
            continue
        init = at.profile().init
        assert init, f"agent type {name!r} has no init — msb would boot it and run nothing"
        assert init.startswith("/"), f"agent type {name!r} init must be an absolute path, got {init!r}"


def test_hermes_upgrade_signal_uses_hermes_active_image():
    """Same type-correctness for Hermes. It reports ``clawbitsPlugin`` (it bakes the
    clawbits-platform PLUGIN, not a channel), so it shares OpenClaw's status key —
    which makes comparing it against the OPENCLAW active image the exact mistake to
    guard: openclaw's plugin is a different artifact and would fabricate a signal."""
    rt = FakeAdminRuntime()
    rt.seed(
        "hm-1",
        image="reef-hm:plugin",
        status={"versions": {"hermes": "0.4.0", "clawbitsPlugin": "0.1.0"}},
    )
    rt.image_list = [
        # OpenClaw's plugin floor is far ahead — it must NOT bleed into hermes.
        _active_image("openclaw", "2026.6.10", "0.8.1"),
        _active_image("hermes", "0.4.0", "0.1.0"),  # hermes is ON its active image
    ]
    store = InMemorySandboxStore()
    asyncio.run(store.put(_record("hm-1", profile="hermes", image="reef-hm:plugin")))

    entries = {e.sandbox_id: e for e in asyncio.run(_svc(rt, store).list_fleet())}

    assert entries["hm-1"].agent_type == "hermes"
    assert entries["hm-1"].upgrade_available is False  # current, despite openclaw's pl0.8.1
    assert entries["hm-1"].image_version == "hm0.4.0-pl0.1.0"


def test_hermes_upgrade_signal_flags_behind_plugin():
    rt = FakeAdminRuntime()
    rt.seed(
        "hm-old",
        image="reef-hm:plugin",
        status={"versions": {"hermes": "0.4.0", "clawbitsPlugin": "0.1.0"}},
    )
    rt.image_list = [_active_image("hermes", "0.4.0", "0.2.0")]  # plugin 0.1.0 → 0.2.0
    store = InMemorySandboxStore()
    asyncio.run(store.put(_record("hm-old", profile="hermes", image="reef-hm:plugin")))

    entries = {e.sandbox_id: e for e in asyncio.run(_svc(rt, store).list_fleet())}
    assert entries["hm-old"].upgrade_available is True


# ── Providers v2 through create(): gemini / ollama / model ────────────────────


def test_create_gemini_injects_key(monkeypatch):
    monkeypatch.setenv("REEF_GEMINI_API_KEY", "srv-gem")
    svc, rt, _store = _svc_with_manager()
    asyncio.run(svc.create("openclaw", name="oc-gem", provider="gemini"))
    spec = rt.created[-1]
    assert spec.env["GEMINI_API_KEY"] == "srv-gem"
    assert "OLLAMA_HOST" not in spec.env


def test_create_model_rides_as_reef_default_model():
    svc, rt, _store = _svc_with_manager()
    asyncio.run(
        svc.create(
            "openclaw", name="oc-model", provider="openai",
            openai_api_key="sk-oai", model="openai/gpt-5.4",
        )
    )
    spec = rt.created[-1]
    assert spec.env["REEF_DEFAULT_MODEL"] == "openai/gpt-5.4"


def test_create_ollama_requires_model():
    svc, _rt, _store = _svc_with_manager()
    with pytest.raises(ValueError, match="needs a model"):
        asyncio.run(
            svc.create(
                "openclaw", name="oc-oll",
                provider="ollama", ollama_host="http://localhost:11434",
            )
        )


def test_create_ollama_normalizes_reef_level_host_per_runtime(monkeypatch):
    # The flagship goal-3 case: the maintainer runs Ollama on the reef box and
    # sets REEF_OLLAMA_HOST=localhost. The RESOLVED value must be normalized
    # (localhost inside the guest is the guest itself) and the egress opened —
    # a request-field-only implementation ships this broken.
    monkeypatch.setenv("REEF_OLLAMA_HOST", "http://localhost:11434")
    svc, rt, _store = _svc_with_manager(backend="microsandbox")
    asyncio.run(svc.create("openclaw", name="oc-oll-msb", provider="ollama", model="llama3.2"))
    spec = rt.created[-1]
    assert spec.env["OLLAMA_HOST"] == "http://host.microsandbox.internal:11434"
    assert spec.env["REEF_DEFAULT_MODEL"] == "llama3.2"
    assert spec.net_allow == ("public", "host")


def test_create_ollama_net_allow_unions_with_clawbits_endpoint():
    # Public clawbits + host-local ollama: the union must still open host egress.
    svc, rt, _store = _svc_with_manager(backend="microsandbox")
    asyncio.run(
        svc.create(
            "openclaw", name="oc-oll-union", org_id="acme",
            clawbits_url="https://clawbits.ai",
            provider="ollama", ollama_host="http://localhost:11434", model="llama3.2",
        )
    )
    spec = rt.created[-1]
    assert spec.env["CLAWBITS_ENDPOINT"] == "https://clawbits.ai"
    assert spec.env["OLLAMA_HOST"] == "http://host.microsandbox.internal:11434"
    assert spec.net_allow == ("public", "host")


def test_create_ollama_lan_host_gets_private_egress():
    svc, rt, _store = _svc_with_manager(backend="microsandbox")
    asyncio.run(
        svc.create(
            "openclaw", name="oc-oll-lan",
            provider="ollama", ollama_host="http://192.168.1.20:11434", model="llama3.2",
        )
    )
    spec = rt.created[-1]
    # LAN hosts are never rewritten; they need the private-network rule.
    assert spec.env["OLLAMA_HOST"] == "http://192.168.1.20:11434"
    assert spec.net_allow == ("public", "private")


def test_create_ironclaw_ollama_maps_base_url_and_backend():
    # IronClaw reads OLLAMA_BASE_URL (never OLLAMA_HOST) and needs LLM_BACKEND
    # pinned, or the injected endpoint is silently ignored for nearai.
    svc, rt, _store = _svc_with_manager(backend="docker")
    asyncio.run(
        svc.create(
            "ironclaw", name="ic-oll",
            provider="ollama", ollama_host="http://localhost:11434", model="llama3.2:8b",
        )
    )
    spec = rt.created[-1]
    assert spec.env["OLLAMA_HOST"] == "http://host.docker.internal:11434"
    assert spec.env["OLLAMA_BASE_URL"] == "http://host.docker.internal:11434"
    assert spec.env["LLM_BACKEND"] == "ollama"
    assert spec.env["REEF_DEFAULT_MODEL"] == "llama3.2:8b"


def test_create_ironclaw_gemini_pins_backend(monkeypatch):
    monkeypatch.setenv("REEF_GEMINI_API_KEY", "srv-gem")
    svc, rt, _store = _svc_with_manager()
    asyncio.run(svc.create("ironclaw", name="ic-gem", provider="gemini"))
    spec = rt.created[-1]
    assert spec.env["GEMINI_API_KEY"] == "srv-gem"
    assert spec.env["LLM_BACKEND"] == "gemini"


def test_create_rejects_bad_ollama_url():
    svc, _rt, _store = _svc_with_manager()
    with pytest.raises(ValueError, match="http\\(s\\) URL"):
        asyncio.run(
            svc.create("openclaw", name="oc-bad", provider="ollama",
                       ollama_host="localhost:11434", model="llama3.2")
        )
