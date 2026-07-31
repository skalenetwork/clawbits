"""The provider registry + value resolution (``reef.providers``): which creds a
create injects, given the caller's pick, their explicit values, and the
maintainer-level ``REEF_*`` env. End-to-end coverage (through
``FleetService.create`` and the HTTP API) lives in test_fleet / test_api.
"""

import pytest

from reef.providers import (
    CODEX_DEFAULT_MODEL,
    PROVIDERS,
    is_configured,
    resolve_creds,
    resolve_model,
)

ANTHROPIC, OPENAI, OPENAI_CODEX, GEMINI, NEARAI, OLLAMA = PROVIDERS


def test_registry_order_is_picker_order():
    # Anthropic first: it's also the entrypoint's onboarding preference when
    # several keys are present. The ChatGPT-subscription (oauth) card sits right
    # after the keyed OpenAI one, its natural neighbor in the picker.
    assert [p.id for p in PROVIDERS] == [
        "anthropic",
        "openai",
        "openai-codex",
        "gemini",
        "nearai",
        "ollama",
    ]


def test_registry_kinds_and_runtimes():
    assert [p.kind for p in PROVIDERS] == [
        "api_key",
        "api_key",
        "oauth",
        "api_key",
        "api_key",
        "endpoint",
    ]
    # Every keyed/endpoint provider is consumable by OpenClaw + IronClaw (IronClaw's
    # gemini/ollama support verified vs nearai/ironclaw@06f9f0fc; nearai is
    # IronClaw's native backend and an OpenClaw entrypoint custom provider).
    #
    # Hermes advertises exactly what its image can actually consume — no more, or the
    # operator gets a key that silently does nothing:
    #   openai / anthropic / gemini → native hermes providers reading the same guest
    #     env vars reef injects (openai-api, anthropic, gemini).
    #   openai-codex → OAuth; no key, the owner completes a device-code login in the
    #     agent's web terminal (`hermes login --provider openai-codex --no-browser`).
    #   nearai / ollama → no native hermes provider wired, so deliberately absent.
    hermes_keyed = {"openai", "anthropic", "gemini"}
    for p in PROVIDERS:
        if p.kind == "oauth":
            # Both runtimes whose CLI has a device-code login (IronClaw has none).
            assert set(p.runtimes) == {"openclaw", "hermes"}
        elif p.id in hermes_keyed:
            assert set(p.runtimes) == {"openclaw", "ironclaw", "hermes"}
        else:
            assert set(p.runtimes) == {"openclaw", "ironclaw"}


def test_is_configured_reads_env_live(monkeypatch):
    assert is_configured(ANTHROPIC) is False
    monkeypatch.setenv("REEF_ANTHROPIC_API_KEY", "srv-ant")
    assert is_configured(ANTHROPIC) is True
    assert is_configured(OPENAI) is False


def test_is_configured_endpoint_kind(monkeypatch):
    assert is_configured(OLLAMA) is False
    monkeypatch.setenv("REEF_OLLAMA_HOST", "http://localhost:11434")
    assert is_configured(OLLAMA) is True


def test_blank_server_key_counts_as_unconfigured(monkeypatch):
    monkeypatch.setenv("REEF_ANTHROPIC_API_KEY", "   ")
    assert is_configured(ANTHROPIC) is False
    with pytest.raises(ValueError, match="no key on this reef"):
        resolve_creds("anthropic", {})


def test_omitted_provider_forwards_all_configured_api_keys(monkeypatch):
    monkeypatch.setenv("REEF_ANTHROPIC_API_KEY", "srv-ant")
    monkeypatch.setenv("REEF_OPENAI_API_KEY", "srv-oai")
    monkeypatch.setenv("REEF_GEMINI_API_KEY", "srv-gem")
    monkeypatch.setenv("REEF_NEARAI_API_KEY", "srv-near")
    assert resolve_creds(None, {}) == {
        "anthropic_api_key": "srv-ant",
        "openai_api_key": "srv-oai",
        "gemini_api_key": "srv-gem",
        "nearai_api_key": "srv-near",
    }
    # Nothing configured + nothing passed: legacy detached create, no creds.
    monkeypatch.delenv("REEF_ANTHROPIC_API_KEY")
    monkeypatch.delenv("REEF_OPENAI_API_KEY")
    monkeypatch.delenv("REEF_GEMINI_API_KEY")
    monkeypatch.delenv("REEF_NEARAI_API_KEY")
    assert resolve_creds(None, {}) == {}


def test_omitted_provider_never_forwards_endpoint_kind(monkeypatch):
    # Legacy callers (which omit ``provider``) predate ollama and must keep
    # their exact pre-picker behavior — no surprise OLLAMA_HOST.
    monkeypatch.setenv("REEF_OLLAMA_HOST", "http://localhost:11434")
    assert resolve_creds(None, {}) == {}


def test_pick_narrows_to_one_provider(monkeypatch):
    monkeypatch.setenv("REEF_ANTHROPIC_API_KEY", "srv-ant")
    monkeypatch.setenv("REEF_OPENAI_API_KEY", "srv-oai")
    assert resolve_creds("openai", {}) == {"openai_api_key": "srv-oai"}


def test_pick_gemini(monkeypatch):
    monkeypatch.setenv("REEF_GEMINI_API_KEY", "srv-gem")
    assert resolve_creds("gemini", {}) == {"gemini_api_key": "srv-gem"}


def test_pick_nearai(monkeypatch):
    monkeypatch.setenv("REEF_NEARAI_API_KEY", "srv-near")
    assert resolve_creds("nearai", {}) == {"nearai_api_key": "srv-near"}


def test_byok_satisfies_an_unconfigured_nearai_pick():
    creds = resolve_creds("nearai", {"nearai_api_key": "sk-near"})
    assert creds == {"nearai_api_key": "sk-near"}


def test_unconfigured_nearai_pick_rejected():
    with pytest.raises(ValueError, match="REEF_NEARAI_API_KEY or pass nearai_api_key"):
        resolve_creds("nearai", {})


def test_pick_ollama_reef_level(monkeypatch):
    monkeypatch.setenv("REEF_OLLAMA_HOST", "http://localhost:11434")
    assert resolve_creds("ollama", {}) == {"ollama_host": "http://localhost:11434"}


def test_pick_none_skips_reef_level_keys(monkeypatch):
    monkeypatch.setenv("REEF_ANTHROPIC_API_KEY", "srv-ant")
    monkeypatch.setenv("REEF_OLLAMA_HOST", "http://localhost:11434")
    assert resolve_creds("none", {}) == {}


# ── oauth / ChatGPT-subscription provider ─────────────────────────────────────


def test_oauth_is_always_configured(monkeypatch):
    # Nothing to configure on the reef - the owner brings their ChatGPT plan.
    assert is_configured(OPENAI_CODEX) is True
    # Independent of any env (unlike the keyed providers).
    monkeypatch.delenv("REEF_OPENAI_API_KEY", raising=False)
    assert is_configured(OPENAI_CODEX) is True


def test_oauth_pick_emits_marker_and_never_needs_a_key():
    # No REEF_* key, no BYO value, and yet it resolves (no "unconfigured pick"
    # error): the login happens in-VM later. The marker is the only output - no
    # secret rides into the guest env.
    assert resolve_creds("openai-codex", {}) == {"openai_codex": "1"}


def test_oauth_pick_ignores_stray_request_keys():
    # A subscription pick short-circuits: it does not pick up an unrelated BYO
    # key the caller may have left in the request.
    assert resolve_creds("openai-codex", {"openai_api_key": "sk-oai"}) == {"openai_codex": "1"}


def test_oauth_pick_rejected_for_unsupported_agent_type():
    with pytest.raises(ValueError, match="not supported by agent type 'ironclaw'"):
        resolve_creds("openai-codex", {}, agent_type="ironclaw")


def test_oauth_not_forwarded_implicitly(monkeypatch):
    # Legacy callers (``provider`` omitted) must never get the subscription
    # marker - it only rides an explicit pick.
    monkeypatch.setenv("REEF_OPENAI_API_KEY", "srv-oai")
    assert "openai_codex" not in resolve_creds(None, {})


def test_explicit_request_key_wins_over_reef_level(monkeypatch):
    monkeypatch.setenv("REEF_ANTHROPIC_API_KEY", "srv-ant")
    creds = resolve_creds("anthropic", {"anthropic_api_key": "sk-mine"})
    assert creds == {"anthropic_api_key": "sk-mine"}


def test_explicit_keys_always_injected_even_off_pick(monkeypatch):
    # The caller picked anthropic but ALSO pasted an OpenAI key - both ride
    # along (explicit keys are deliberate; the pick only governs reef-level ones).
    monkeypatch.setenv("REEF_ANTHROPIC_API_KEY", "srv-ant")
    creds = resolve_creds("anthropic", {"openai_api_key": "sk-oai"})
    assert creds == {"anthropic_api_key": "srv-ant", "openai_api_key": "sk-oai"}


def test_byok_satisfies_an_unconfigured_pick():
    creds = resolve_creds("openai", {"openai_api_key": "sk-oai"})
    assert creds == {"openai_api_key": "sk-oai"}


def test_byo_host_satisfies_an_unconfigured_ollama_pick():
    creds = resolve_creds("ollama", {"ollama_host": "http://192.168.1.20:11434"})
    assert creds == {"ollama_host": "http://192.168.1.20:11434"}


def test_unconfigured_pick_without_key_rejected():
    with pytest.raises(ValueError, match="REEF_OPENAI_API_KEY or pass openai_api_key"):
        resolve_creds("openai", {})


def test_unconfigured_ollama_pick_names_the_endpoint():
    with pytest.raises(ValueError, match="no endpoint on this reef"):
        resolve_creds("ollama", {})


def test_unknown_provider_rejected():
    with pytest.raises(ValueError, match="unknown provider 'grok'"):
        resolve_creds("grok", {})


def test_pick_unsupported_by_agent_type_rejected():
    # ``agent_type`` gates the pick against Provider.runtimes. No provider is
    # hermes-compatible, so any pick fails for it.
    with pytest.raises(ValueError, match="not supported by agent type 'hermes'"):
        resolve_creds("ollama", {}, agent_type="hermes")


def test_pick_supported_by_agent_type_passes(monkeypatch):
    monkeypatch.setenv("REEF_OLLAMA_HOST", "http://localhost:11434")
    creds = resolve_creds("ollama", {}, agent_type="ironclaw")
    assert creds == {"ollama_host": "http://localhost:11434"}


def test_request_key_whitespace_is_stripped():
    assert resolve_creds(None, {"openai_api_key": "  sk-oai  "}) == {"openai_api_key": "sk-oai"}
    assert resolve_creds(None, {"openai_api_key": "   "}) == {}


# ── endpoint URL validation ───────────────────────────────────────────────────


def test_ollama_host_must_be_http_url():
    with pytest.raises(ValueError, match="ollama_host must be an http\\(s\\) URL"):
        resolve_creds("ollama", {"ollama_host": "localhost:11434"})
    with pytest.raises(ValueError, match="ollama_host must be an http\\(s\\) URL"):
        resolve_creds("ollama", {"ollama_host": "ftp://host:11434"})


def test_ollama_host_rejects_userinfo():
    # The guest env is unmasked for non-secret keys, so no credential may ride
    # the URL.
    with pytest.raises(ValueError, match="must not embed credentials"):
        resolve_creds("ollama", {"ollama_host": "http://user:pass@host:11434"})


def test_misconfigured_reef_level_ollama_host_rejected_readably(monkeypatch):
    monkeypatch.setenv("REEF_OLLAMA_HOST", "not a url")
    with pytest.raises(ValueError, match="REEF_OLLAMA_HOST must be an http\\(s\\) URL"):
        resolve_creds("ollama", {})


# ── model resolution ──────────────────────────────────────────────────────────


def test_model_passthrough_and_strip():
    assert resolve_model("  openai/gpt-5.4  ", {}) == "openai/gpt-5.4"
    assert resolve_model(None, {}) is None
    assert resolve_model("   ", {}) is None


def test_nearai_hf_path_model_ids_pass_through():
    # NEAR's model ids are HF-style org/model paths - the slash is part of the
    # id, not a provider prefix; reef passes it through untouched.
    assert resolve_model("zai-org/GLM-5.1-FP8", {}) == "zai-org/GLM-5.1-FP8"
    assert resolve_model("deepseek-ai/DeepSeek-V4-Flash", {}) == "deepseek-ai/DeepSeek-V4-Flash"


def test_ollama_requires_a_model():
    creds = {"ollama_host": "http://localhost:11434"}
    with pytest.raises(ValueError, match="needs a model"):
        resolve_model(None, creds)


def test_ollama_model_from_request_or_reef_default(monkeypatch):
    creds = {"ollama_host": "http://localhost:11434"}
    assert resolve_model("llama3.2:8b", creds) == "llama3.2:8b"
    monkeypatch.setenv("REEF_OLLAMA_DEFAULT_MODEL", "qwen2.5")
    assert resolve_model(None, creds) == "qwen2.5"


def test_oauth_marker_pins_codex_default_model():
    creds = {"openai_codex": "1"}
    assert resolve_model(None, creds) == CODEX_DEFAULT_MODEL
    assert CODEX_DEFAULT_MODEL == "openai/gpt-5.4"  # not gpt-5.5 (harness crash)
    # An explicit model still wins for a power user.
    assert resolve_model("openai/gpt-5-mini", creds) == "openai/gpt-5-mini"


def test_malformed_model_rejected():
    with pytest.raises(ValueError, match="invalid model"):
        resolve_model("bad model with spaces", {})
    with pytest.raises(ValueError, match="invalid model"):
        resolve_model("-leading-dash", {})


# ── ollama model discovery (probe URL resolution; the fetch is httpx) ─────────


def test_probe_url_prefers_explicit_host():
    from reef.providers import resolve_ollama_probe_url

    assert resolve_ollama_probe_url("http://192.168.1.20:11434/") == "http://192.168.1.20:11434"


def test_probe_url_falls_back_to_reef_level(monkeypatch):
    from reef.providers import resolve_ollama_probe_url

    monkeypatch.setenv("REEF_OLLAMA_HOST", "http://localhost:11434")
    assert resolve_ollama_probe_url(None) == "http://localhost:11434"
    monkeypatch.delenv("REEF_OLLAMA_HOST")
    with pytest.raises(ValueError, match="no ollama host"):
        resolve_ollama_probe_url(None)


def test_probe_url_maps_guest_aliases_to_loopback():
    # host.docker.internal means "the reef box" FROM A GUEST; the reef process
    # itself probes loopback.
    from reef.providers import resolve_ollama_probe_url

    assert resolve_ollama_probe_url("http://host.docker.internal:11434") == "http://127.0.0.1:11434"
    assert (
        resolve_ollama_probe_url("http://host.microsandbox.internal:11434")
        == "http://127.0.0.1:11434"
    )


def test_probe_url_validates_like_create():
    from reef.providers import resolve_ollama_probe_url

    with pytest.raises(ValueError, match="http\\(s\\) URL"):
        resolve_ollama_probe_url("localhost:11434")
    with pytest.raises(ValueError, match="credentials"):
        resolve_ollama_probe_url("http://u:p@h:11434")
