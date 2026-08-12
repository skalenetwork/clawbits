"""Admin/fleet HTTP API — endpoints, secret redaction over the wire, error
mapping, and the bearer-token guard. Uses a fake runtime (no msb).
"""

from fastapi.testclient import TestClient

from reef.api.app import create_app
from reef.fleet import FleetService
from reef.manager import SandboxManager
from reef.reconciler import Reconciler
from reef.runtime import MetricsSample
from reef.store import InMemorySandboxStore
from reef.tests.fakes import FakeAdminRuntime
from reef.tests.test_fleet import INSPECT


def _client(runtime: FakeAdminRuntime | None = None):
    rt = runtime or FakeAdminRuntime().seed(
        "agent-1",
        inspect=INSPECT,
        metrics=MetricsSample(
            name="agent-1", cpu_percent=0.5, memory_bytes=10, memory_limit_bytes=100
        ),
    )
    client = TestClient(create_app(service=FleetService(rt, InMemorySandboxStore())))
    return client, rt


def test_healthz_ok():
    client, _ = _client()
    r = client.get("/healthz")
    assert r.status_code == 200
    b = r.json()
    assert b["status"] == "ok" and b["msb_available"] is True and b["sandboxes"] == 1
    assert b["reconciler"] is None  # no reconciler attached to an injected-service app


def test_healthz_reports_reconciler_when_attached():
    rt = FakeAdminRuntime().seed("agent-1")
    store = InMemorySandboxStore()
    app = create_app(service=FleetService(rt, store))
    app.state.reconciler = Reconciler(rt, store, interval=999)  # attach; loop isn't started here
    body = TestClient(app).get("/healthz").json()
    assert body["reconciler"] is not None
    assert body["reconciler"]["enabled"] is True
    assert body["reconciler"]["interval_secs"] == 999
    assert body["reconciler"]["healthy"] is True  # freshly attached → healthy


def test_versions_latest_covers_all_runtimes():
    # LatestVersionsOut must not silently drop a runtime the resolver returns —
    # hermes was once missing from the schema and pydantic ate the key.
    client, _ = _client()
    r = client.get("/versions/latest")
    assert r.status_code == 200
    body = r.json()
    for runtime in ("openclaw", "ironclaw", "hermes"):
        assert set(body[runtime]) == {"runtime", "component"}


def test_list_fleet_returns_entries():
    client, _ = _client()
    r = client.get("/fleet")
    assert r.status_code == 200
    body = r.json()
    assert body[0]["sandbox_id"] == "agent-1"
    assert body[0]["managed"] is False
    assert body[0]["metrics"]["cpu_percent"] == 0.5


def test_detail_redacts_secrets_over_the_wire():
    client, _ = _client()
    r = client.get("/fleet/agent-1")
    assert r.status_code == 200
    body = r.json()
    assert body["env"]["CLAWBITS_API_KEY"] == "***"
    assert body["env"]["ANTHROPIC_API_KEY"] == "***"
    assert body["env"]["CLAWBITS_ORG_ID"] == "org-test"
    assert body["network"]["egress_allow"] == ["api.anthropic.com"]


def test_detail_unknown_is_404():
    client, _ = _client()
    assert client.get("/fleet/ghost").status_code == 404


def test_logs_splits_lines():
    rt = FakeAdminRuntime().seed("agent-1", inspect=INSPECT, logs="l1\nl2\n")
    client = TestClient(create_app(service=FleetService(rt, InMemorySandboxStore())))
    r = client.get("/fleet/agent-1/logs?tail=10")
    assert r.status_code == 200
    assert r.json()["lines"] == ["l1", "l2"]


def test_stop_then_start_actions():
    client, rt = _client()
    r = client.post("/fleet/agent-1/stop")
    assert r.status_code == 200 and r.json()["state"] == "stopped"
    assert ("stop", "agent-1") in rt.calls
    r = client.post("/fleet/agent-1/start")
    assert r.json()["state"] == "running"


def test_destroy_returns_204():
    client, rt = _client()
    r = client.delete("/fleet/agent-1")
    assert r.status_code == 204
    assert ("destroy", "agent-1") in rt.calls


def test_invalid_state_filter_is_422():
    client, _ = _client()
    assert client.get("/fleet?state=bogus").status_code == 422


def test_admin_token_enforced_when_set(monkeypatch):
    monkeypatch.setenv("REEF_ADMIN_TOKEN", "s3cret")
    client, _ = _client()
    assert client.get("/fleet").status_code == 401
    assert client.get("/fleet", headers={"Authorization": "Bearer s3cret"}).status_code == 200
    assert client.get("/healthz").status_code == 200  # liveness stays open


def test_providers_reports_presence_only(monkeypatch):
    monkeypatch.setenv("REEF_ANTHROPIC_API_KEY", "srv-ant")
    monkeypatch.setenv("REEF_OLLAMA_HOST", "http://localhost:11434")
    client, _ = _client()
    r = client.get("/providers")
    assert r.status_code == 200
    both = ["openclaw", "ironclaw"]
    # Hermes has native providers for the openai / anthropic / gemini keys; nearai and
    # ollama have no hermes wiring, so it must not advertise them.
    all3 = ["openclaw", "ironclaw", "hermes"]
    assert r.json() == {
        "providers": [
            {"id": "anthropic", "label": "Anthropic", "configured": True,
             "kind": "api_key", "runtimes": all3},
            {"id": "openai", "label": "OpenAI", "configured": False,
             "kind": "api_key", "runtimes": all3},
            # The ChatGPT-subscription card is always "configured" (nothing to set
            # up on the reef - the owner authenticates in-VM). OpenClaw + Hermes: both
            # have a device-code login they can run in the agent's web terminal.
            {"id": "openai-codex", "label": "ChatGPT subscription", "configured": True,
             "kind": "oauth", "runtimes": ["openclaw", "hermes"]},
            {"id": "gemini", "label": "Gemini", "configured": False,
             "kind": "api_key", "runtimes": all3},
            {"id": "nearai", "label": "NEAR AI", "configured": False,
             "kind": "api_key", "runtimes": both},
            {"id": "openrouter", "label": "OpenRouter", "configured": False,
             "kind": "api_key", "runtimes": all3},
            {"id": "ollama", "label": "Ollama", "configured": True,
             "kind": "endpoint", "runtimes": both},
        ],
        # Create-API capability flags: lets a newer clawbits UI detect that this
        # reef accepts CreateSandboxIn.env / .model (older reefs omit them).
        "features": ["env", "model", "capabilities"],
    }
    assert "srv-ant" not in r.text  # api_key values never cross the wire
    # The ollama host VALUE is presence-only here too — the picker shows
    # "Ready" without echoing the maintainer's URL.
    assert "11434" not in r.text


def test_providers_gated_by_admin_token(monkeypatch):
    # Unlike /healthz, /providers reveals deployment config - it rides the same
    # admin guard as the fleet.
    monkeypatch.setenv("REEF_ADMIN_TOKEN", "s3cret")
    monkeypatch.setenv("REEF_OPENAI_API_KEY", "srv-oai")
    client, _ = _client()
    assert client.get("/providers").status_code == 401
    r = client.get("/providers", headers={"Authorization": "Bearer s3cret"})
    assert r.status_code == 200
    assert "srv-oai" not in r.text


def _client_with_manager() -> TestClient:
    rt = FakeAdminRuntime()
    store = InMemorySandboxStore()
    mgr = SandboxManager(rt, store, backend="fake")
    return TestClient(create_app(service=FleetService(rt, store, manager=mgr)))


def test_create_openclaw_via_api():
    client = _client_with_manager()
    r = client.post("/fleet", json={"type": "openclaw", "name": "oc-api"})
    assert r.status_code == 201, r.text
    b = r.json()
    assert b["sandbox_id"] == "oc-api"
    assert b["agent_type"] == "openclaw"
    assert b["state"] == "running"
    # DirectPortExposure mints a loopback URL; the API swaps it for a surface-proxy
    # URL on the caller's own origin (reef.api.proxy) so it works over a tunnel too.
    assert b["access"]["url"].startswith("http://testserver/s/")
    assert b["access"]["url"].endswith("/")
    assert b["access"]["password"]


def test_hermes_password_is_a_one_time_reveal_not_readable_from_detail():
    """The Hermes dashboard proxy's basic-auth secret follows OpenClaw's contract: it
    is revealed ONCE, in the create response, and is never readable again.

    ``GET /fleet/{id}`` must NOT hand it back — the profile populates ``password``
    only from the caller-supplied ``secret`` and deliberately does not read
    REEF_HERMES_DASHBOARD_PASSWORD back out of the guest env (the detail path passes
    secret=None). It must also never leak through the detail view's env dump."""
    client = _client_with_manager()
    created = client.post("/fleet", json={"type": "hermes", "name": "hm-api"})
    assert created.status_code == 201, created.text
    password = created.json()["access"]["password"]
    assert password  # revealed exactly once, at creation

    detail = client.get("/fleet/hm-api")
    assert detail.status_code == 200, detail.text
    d = detail.json()
    assert d["access"] is None or not d["access"].get("password")
    # …and not smuggled out via the env listing either (fleet._SECRET_KEY redacts it).
    assert password not in detail.text


def test_publicize_access_honors_public_url(monkeypatch):
    # In prod the API binds loopback behind a tunnel; surface URLs must be pinned
    # to the canonical public origin (REEF_PUBLIC_URL) rather than request.base_url,
    # which can degrade to http://127.0.0.1 over a header-stripping tunnel.
    monkeypatch.setenv("REEF_PUBLIC_URL", "https://reef.example.com")
    client = _client_with_manager()
    r = client.post("/fleet", json={"type": "openclaw", "name": "oc-pub"})
    assert r.status_code == 201, r.text
    access = r.json()["access"]
    assert access["url"].startswith("https://reef.example.com/s/")
    assert access["url"].endswith("/")
    assert access["terminal_url"].startswith("https://reef.example.com/s/")
    # The detail view rebuilds the same public origin (password stays null there).
    detail_access = client.get("/fleet/oc-pub").json()["access"]
    assert detail_access["url"].startswith("https://reef.example.com/s/")
    assert detail_access["terminal_url"].startswith("https://reef.example.com/s/")


def test_publicize_access_trailing_slash_in_public_url(monkeypatch):
    # A trailing slash on REEF_PUBLIC_URL must not double up (proxied_surface_url
    # rstrips it); guard the common misconfiguration.
    monkeypatch.setenv("REEF_PUBLIC_URL", "https://reef.example.com/")
    client = _client_with_manager()
    r = client.post("/fleet", json={"type": "openclaw", "name": "oc-slash"})
    assert r.status_code == 201, r.text
    assert r.json()["access"]["url"].startswith("https://reef.example.com/s/")
    assert "//s/" not in r.json()["access"]["url"].removeprefix("https://")


def test_create_openclaw_with_org_via_api():
    client = _client_with_manager()
    r = client.post(
        "/fleet",
        json={
            "type": "openclaw",
            "name": "oc-cb",
            "org_id": "acme",
            "clawbits_url": "https://app.clawbits.ai",
            "signup_token": "human-abc",
        },
    )
    assert r.status_code == 201, r.text
    assert r.json()["sandbox_id"] == "oc-cb"


def test_create_hermes_via_api():
    client = _client_with_manager()
    r = client.post("/fleet", json={"type": "hermes", "name": "hm-api"})
    assert r.status_code == 201, r.text
    b = r.json()
    assert b["sandbox_id"] == "hm-api"
    assert b["agent_type"] == "hermes"
    assert b["state"] == "running"
    assert b["access"]["kind"] == "hermes"
    assert b["access"]["url"].startswith("http://testserver/s/")
    # The dashboard is fronted by an nginx basic-auth proxy in the guest, so Hermes
    # DOES mint a one-time password now (it used to be None, which meant the surface
    # was unauthenticated — hermes' own gate is off whenever `--insecure` is used).
    assert b["access"]["password"]


def test_create_with_provider_pick_via_api(monkeypatch):
    monkeypatch.setenv("REEF_OPENAI_API_KEY", "srv-oai")
    client = _client_with_manager()
    r = client.post("/fleet", json={"type": "openclaw", "name": "oc-prov", "provider": "openai"})
    assert r.status_code == 201, r.text


def test_create_with_unconfigured_provider_is_422():
    r = _client_with_manager().post(
        "/fleet", json={"type": "openclaw", "name": "oc-noprov", "provider": "openai"}
    )
    assert r.status_code == 422
    assert "REEF_OPENAI_API_KEY" in r.json()["detail"]


def test_create_with_env_via_api():
    client = _client_with_manager()
    r = client.post("/fleet", json={"type": "openclaw", "name": "oc-env", "env": {"MY_FLAG": "on"}})
    assert r.status_code == 201, r.text
    # Non-secret-named custom env stays visible in the detail view.
    assert client.get("/fleet/oc-env").json()["env"]["MY_FLAG"] == "on"


def test_create_env_secret_named_is_redacted_in_detail():
    client = _client_with_manager()
    r = client.post(
        "/fleet",
        json={"type": "openclaw", "name": "oc-sec", "env": {"MY_WEBHOOK_TOKEN": "tok-123"}},
    )
    assert r.status_code == 201, r.text
    detail = client.get("/fleet/oc-sec")
    assert detail.json()["env"]["MY_WEBHOOK_TOKEN"] == "***"
    assert "tok-123" not in detail.text


def test_create_with_reserved_env_is_422():
    r = _client_with_manager().post(
        "/fleet", json={"type": "openclaw", "name": "oc-resv", "env": {"OPENAI_API_KEY": "sk-x"}}
    )
    assert r.status_code == 422
    assert "managed by reef" in r.json()["detail"]


def test_create_with_invalid_env_key_is_422():
    r = _client_with_manager().post(
        "/fleet", json={"type": "openclaw", "name": "oc-badenv", "env": {"BAD KEY": "x"}}
    )
    assert r.status_code == 422


def test_create_with_too_many_env_is_422():
    r = _client_with_manager().post(
        "/fleet",
        json={"type": "openclaw", "name": "oc-many", "env": {f"K{i}": "v" for i in range(33)}},
    )
    assert r.status_code == 422


def test_create_with_non_string_env_value_is_422():
    # Pins the wire shape: Pydantic v2 does not coerce int → str.
    r = _client_with_manager().post(
        "/fleet", json={"type": "openclaw", "name": "oc-int", "env": {"A": 1}}
    )
    assert r.status_code == 422


def test_create_unknown_type_is_422():
    assert _client_with_manager().post("/fleet", json={"type": "nope"}).status_code == 422


def test_restart_action_via_api():
    client, rt = _client()
    r = client.post("/fleet/agent-1/restart")
    assert r.status_code == 200 and r.json()["state"] == "running"
    assert rt.calls.index(("stop", "agent-1")) < rt.calls.index(("start", "agent-1"))


def test_patch_color_via_api():
    client = _client_with_manager()
    client.post("/fleet", json={"type": "openclaw", "name": "oc-color"})
    r = client.patch("/fleet/oc-color", json={"color": "green"})
    assert r.status_code == 200, r.text
    b = r.json()
    assert b["sandbox_id"] == "oc-color" and b["color"] == "green"
    assert client.get("/fleet/oc-color").json()["color"] == "green"  # surfaced on detail


def test_patch_invalid_color_is_422():
    client = _client_with_manager()
    client.post("/fleet", json={"type": "openclaw", "name": "oc-bad"})
    assert client.patch("/fleet/oc-bad", json={"color": "neon"}).status_code == 422


def test_patch_color_on_drift_is_422():
    client, _ = _client()  # agent-1 is drift (no store record)
    assert client.patch("/fleet/agent-1", json={"color": "blue"}).status_code == 422


def test_patch_restart_policy_via_api():
    client = _client_with_manager()
    client.post("/fleet", json={"type": "openclaw", "name": "oc-rp"})
    r = client.patch("/fleet/oc-rp", json={"restart_policy": "always"})
    assert r.status_code == 200, r.text
    assert r.json()["restart_policy"] == "always"
    d = client.get("/fleet/oc-rp").json()
    assert d["restart_policy"] == "always" and d["desired_state"] == "running"


def test_patch_invalid_restart_policy_is_422():
    client = _client_with_manager()
    client.post("/fleet", json={"type": "openclaw", "name": "oc-rp2"})
    assert client.patch("/fleet/oc-rp2", json={"restart_policy": "maybe"}).status_code == 422


def test_create_with_restart_policy_via_api():
    client = _client_with_manager()
    r = client.post(
        "/fleet", json={"type": "openclaw", "name": "oc-never", "restart_policy": "never"}
    )
    assert r.status_code == 201, r.text
    assert client.get("/fleet/oc-never").json()["restart_policy"] == "never"


def test_fleet_entry_exposes_self_healing_defaults():
    client = _client_with_manager()
    client.post("/fleet", json={"type": "openclaw", "name": "oc-sh"})
    row = next(e for e in client.get("/fleet").json() if e["sandbox_id"] == "oc-sh")
    assert row["restart_policy"] == "on-failure" and row["desired_state"] == "running"
    assert row["restart_count"] == 0


def test_create_ollama_via_api(monkeypatch):
    monkeypatch.setenv("REEF_OLLAMA_HOST", "http://localhost:11434")
    client = _client_with_manager()
    r = client.post(
        "/fleet",
        json={"type": "openclaw", "name": "oc-oll", "provider": "ollama", "model": "llama3.2"},
    )
    assert r.status_code == 201, r.text
    detail = client.get("/fleet/oc-oll").json()
    # Endpoint-kind values are not secrets: visible unmasked in fleet detail.
    assert detail["env"]["OLLAMA_HOST"] == "http://localhost:11434"
    assert detail["env"]["REEF_DEFAULT_MODEL"] == "llama3.2"


def test_create_ollama_without_model_is_422(monkeypatch):
    monkeypatch.setenv("REEF_OLLAMA_HOST", "http://localhost:11434")
    r = _client_with_manager().post(
        "/fleet", json={"type": "openclaw", "name": "oc-oll-nm", "provider": "ollama"}
    )
    assert r.status_code == 422
    assert "needs a model" in r.json()["detail"]


def test_create_ollama_userinfo_url_is_422():
    r = _client_with_manager().post(
        "/fleet",
        json={"type": "openclaw", "name": "oc-oll-ui", "provider": "ollama",
              "ollama_host": "http://user:pass@host:11434", "model": "llama3.2"},
    )
    assert r.status_code == 422
    assert "credentials" in r.json()["detail"]


def test_create_gemini_byok_via_api():
    client = _client_with_manager()
    r = client.post(
        "/fleet",
        json={"type": "ironclaw", "name": "ic-gem", "provider": "gemini",
              "gemini_api_key": "AIza-test"},
    )
    assert r.status_code == 201, r.text
    detail = client.get("/fleet/ic-gem").json()
    assert detail["env"]["GEMINI_API_KEY"] == "***"  # api_key kind stays masked
    assert "AIza-test" not in client.get("/fleet/ic-gem").text


def test_create_with_ollama_base_url_custom_env_is_422():
    # OLLAMA_BASE_URL (IronClaw's spelling) is reef-managed like OLLAMA_HOST.
    r = _client_with_manager().post(
        "/fleet",
        json={"type": "ironclaw", "name": "ic-resv",
              "env": {"OLLAMA_BASE_URL": "http://x:11434"}},
    )
    assert r.status_code == 422
    assert "managed by reef" in r.json()["detail"]


def test_ollama_models_endpoint(monkeypatch):
    # The fetch itself is stubbed — this covers wiring, auth, and error mapping.
    # (importlib: ``reef.api``'s ``app`` attribute shadows the submodule name.)
    import importlib

    app_mod = importlib.import_module("reef.api.app")

    async def fake_fetch(base):
        assert base == "http://127.0.0.1:11434"
        return [{"id": "llama3.2:latest", "size": 123, "parameter_size": "8.0B"}]

    monkeypatch.setattr(app_mod, "fetch_ollama_models", fake_fetch)
    client, _ = _client()
    r = client.get("/providers/ollama/models?host=http://host.docker.internal:11434")
    assert r.status_code == 200
    assert r.json() == {
        "models": [{"id": "llama3.2:latest", "size": 123, "parameter_size": "8.0B"}]
    }


def test_ollama_models_no_host_is_422():
    r = _client()[0].get("/providers/ollama/models")
    assert r.status_code == 422
    assert "no ollama host" in r.json()["detail"]


def test_ollama_models_unreachable_is_502(monkeypatch):
    import importlib

    import httpx

    app_mod = importlib.import_module("reef.api.app")

    async def fake_fetch(base):
        raise httpx.ConnectError("boom")

    monkeypatch.setattr(app_mod, "fetch_ollama_models", fake_fetch)
    r = _client()[0].get("/providers/ollama/models?host=http://127.0.0.1:11434")
    assert r.status_code == 502
    assert "can't reach the ollama server" in r.json()["detail"]


def test_openrouter_models_endpoint(monkeypatch):
    # The fetch itself is stubbed — this covers wiring, auth, and error mapping
    # (same pattern as the ollama probe; the openrouter listing takes no host).
    import importlib

    app_mod = importlib.import_module("reef.api.app")

    async def fake_fetch():
        return [
            {"id": "anthropic/claude-opus-4.6", "name": "Anthropic: Claude Opus 4.6",
             "context_length": 200000},
            {"id": "openai/gpt-5.4-mini", "name": None, "context_length": None},
        ]

    monkeypatch.setattr(app_mod, "fetch_openrouter_models", fake_fetch)
    client, _ = _client()
    r = client.get("/providers/openrouter/models")
    assert r.status_code == 200
    assert r.json() == {
        "models": [
            {"id": "anthropic/claude-opus-4.6", "name": "Anthropic: Claude Opus 4.6",
             "context_length": 200000},
            {"id": "openai/gpt-5.4-mini", "name": None, "context_length": None},
        ]
    }


def test_openrouter_models_gated_by_admin_token(monkeypatch):
    # Rides the same admin guard as /providers (it triggers reef-side egress,
    # so it must not be an open relay).
    monkeypatch.setenv("REEF_ADMIN_TOKEN", "s3cret")
    client, _ = _client()
    assert client.get("/providers/openrouter/models").status_code == 401


def test_openrouter_models_unreachable_is_502(monkeypatch):
    import importlib

    import httpx

    app_mod = importlib.import_module("reef.api.app")

    async def fake_fetch():
        raise httpx.ConnectError("boom")

    monkeypatch.setattr(app_mod, "fetch_openrouter_models", fake_fetch)
    r = _client()[0].get("/providers/openrouter/models")
    assert r.status_code == 502
    assert "can't reach openrouter.ai" in r.json()["detail"]
