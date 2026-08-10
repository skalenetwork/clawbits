from pathlib import Path

ENTRYPOINT = Path(__file__).parents[1] / "images" / "openclaw-runtime" / "entrypoint.sh"
BUILD_SCRIPT = ENTRYPOINT.with_name("build.sh")


def test_token_signup_runs_before_gateway_start():
    text = ENTRYPOINT.read_text()
    signup_idx = text.index("reef_clawbits_autosignup\n")
    gateway_idx = text.index("exec openclaw gateway run")
    assert signup_idx < gateway_idx
    assert "reef_clawbits_autosignup &" not in text


def test_openai_api_key_default_uses_direct_runtime():
    text = ENTRYPOINT.read_text()
    auto_default_start = text.index('if [ -z "${reef_model}" ]')
    model_apply_start = text.index('if [ -n "${reef_model}" ]', auto_default_start)
    auto_default = text[auto_default_start:model_apply_start]

    assert 'reef_model="openai/gpt-5.4"' in auto_default
    assert 'reef_runtime="openclaw"' in auto_default
    assert '"agents.defaults.models[\\"${reef_model}\\"].agentRuntime.id"' in text


def test_build_smart_cache_key_derivation():
    text = BUILD_SCRIPT.read_text()
    # Pinned plugin ⇒ deterministic key; force-fresh ⇒ nocache; else a timestamp
    # nonce busts ONLY the plugin layer so a default build re-resolves the latest
    # plugin while the expensive base/ttyd layers stay cached.
    assert 'cache_key="${CLAWBITS_PLUGIN_VERSION}"' in text
    assert 'cache_key="$(date +%s)"' in text
    assert 'cache_key="nocache"' in text
    assert '--build-arg "CLAWBITS_PLUGIN_CACHE_KEY=${cache_key}"' in text


def test_build_derives_truthful_stack_tag_from_probe():
    text = BUILD_SCRIPT.read_text()
    # The build probes the BUILT image for the real versions (same extraction the
    # entrypoint reports into status.json) and derives an immutable self-describing
    # tag reef-oc:oc<oc>-pl<pl> — no hand-bumped VERSION file, no reef-oc:<version>.
    assert "openclaw --version" in text
    assert "openclaw plugins list --json" in text
    assert 'stack="oc${installed_oc}-pl${installed_plugin}"' in text
    assert "reef-oc:${stack}" in text
    assert 'cat "$here/VERSION"' not in text
    assert "reef-oc:${version}" not in text


def test_gemini_onboards_with_dedicated_auth_choice():
    text = ENTRYPOINT.read_text()
    # OpenClaw reads GEMINI_API_KEY natively; the auth-choice wires it at
    # onboard (verified vs the shipped openclaw 2026.6.10/.11 wizard enum).
    assert "--auth-choice gemini-api-key --gemini-api-key" in text
    # Preference order: anthropic wins, gemini before nearai before openrouter
    # before ollama, else skip.
    ant = text.index("--auth-choice anthropic-api-key")
    gem = text.index("--auth-choice gemini-api-key")
    near = text.index("--auth-choice custom-api-key")
    orte = text.index("--auth-choice openrouter-api-key")
    oll = text.index("--auth-choice ollama")
    assert ant < gem < near < orte < oll


def test_nearai_onboards_as_custom_openai_compatible_provider():
    text = ENTRYPOINT.read_text()
    # OpenClaw has no built-in nearai provider: the entrypoint registers a
    # custom OpenAI-compatible one (models.providers.nearai) via the
    # non-interactive onboard — a pure config write, no probe/fallback needed.
    assert "--auth-choice custom-api-key" in text
    assert "--custom-provider-id nearai" in text
    assert '--custom-base-url "https://cloud-api.near.ai/v1"' in text
    assert "--custom-compatibility openai" in text
    assert '--custom-api-key "${NEARAI_API_KEY}"' in text
    # The custom onboard REQUIRES a model id: the create-time pick (a
    # nearai/ prefix stripped — the flag wants the provider-bare id, which for
    # NEAR is the full HF path) or the known-good default.
    assert '_near_model="${_near_model#nearai/}"' in text
    assert '_near_model="zai-org/GLM-5.1-FP8"' in text


def test_nearai_model_qualification_handles_hf_paths():
    text = ENTRYPOINT.read_text()
    # NEAR model ids are HF-style org/model paths, so the generic "contains a
    # slash ⇒ already qualified" passthrough would misparse them (openclaw
    # splits provider/model on the FIRST slash). When the NEAR key is the
    # effective provider, anything not already nearai/-prefixed gets the
    # prefix.
    assert 'reef_model="nearai/${reef_model}"' in text
    assert '"" | nearai/*' in text


def test_openrouter_onboards_with_native_auth_choice():
    text = ENTRYPOINT.read_text()
    # OpenClaw bundles an openrouter provider plugin (enabled by default), so
    # unlike nearai there is no custom-api-key onboard: the native auth-choice
    # writes the key, and with no model pick the plugin's own openrouter/auto
    # default applies (no --custom-model-id requirement to satisfy).
    assert "--auth-choice openrouter-api-key" in text
    assert '--openrouter-api-key "${OPENROUTER_API_KEY}"' in text


def test_openrouter_plugin_is_allowlisted_when_keyed():
    text = ENTRYPOINT.read_text()
    # The openrouter PROVIDER is a bundled plugin, and the clawbits-only
    # allowlist blocks it (the codex trap from the other side): onboarding
    # writes the key fine — plugins load before the allowlist lands on first
    # boot — and then every openrouter/* model errors "unavailable from the
    # provider" at run time. Both allowlist branches must carry it when the
    # key is present; it ships enabled, so no entries.*.enabled flip.
    assert '\'["clawbits","openrouter"]\'' in text
    assert '\'["clawbits","codex","openrouter"]\'' in text
    # The minimal allowlists survive for key-less / non-openrouter agents.
    assert '\'["clawbits"]\'' in text
    assert '\'["clawbits","codex"]\'' in text


def test_openrouter_model_qualification_handles_vendor_slugs():
    text = ENTRYPOINT.read_text()
    # OpenRouter model ids are vendor/model slugs (openai/gpt-5.4), the same
    # first-slash collision class as NEAR's HF paths: when the OpenRouter key
    # is the effective provider, anything not already openrouter/-prefixed
    # gets the prefix (openai/gpt-5.4 → openrouter/openai/gpt-5.4).
    assert 'reef_model="openrouter/${reef_model}"' in text
    assert "openrouter/*) ;;" in text


def test_openrouter_no_pick_defaults_to_a_free_model():
    text = ENTRYPOINT.read_text()
    # No model pick must land on a FREE catalog model (the pickers' curated
    # default), never the plugin's openrouter/auto paid routing — a fresh
    # BYO-key agent doesn't spend until its owner chooses.
    assert '"") reef_model="openrouter/nvidia/nemotron-nano-9b-v2:free"' in text


def test_ollama_onboard_falls_back_to_detached_boot():
    text = ENTRYPOINT.read_text()
    # `--auth-choice ollama` probes the server and HARD-FAILS when unreachable;
    # the agent must still boot (detached) rather than crash-loop.
    assert "--auth-choice ollama --custom-base-url" in text
    ollama_block = text[text.index('elif [ -n "${OLLAMA_HOST:-}" ]'):text.index("reef_onboard --auth-choice skip", text.index('elif [ -n "${OLLAMA_HOST:-}" ]')) ]
    assert "if ! reef_onboard" in ollama_block
    # The bare model id rides --custom-model-id (an ollama/ prefix is stripped).
    assert '_oll_model="${_oll_model#ollama/}"' in text


def test_model_pin_qualifies_bare_ids_and_applies_on_fresh_onboard():
    text = ENTRYPOINT.read_text()
    # A create-time bare model id gets its provider prefix from the single
    # injected provider; gemini/ollama onboarding auto-sets a primary, so the
    # fresh-onboard gate must still apply the user's explicit pick over it.
    assert 'reef_model="google/${reef_model}"' in text
    assert 'reef_model="ollama/${reef_model}"' in text
    assert 'if [ -n "${did_onboard}" ] ||' in text
    # The runtime pin covers ANY effective openai/* model (user-picked included),
    # not just the auto-default; it branches by auth mode (see the codex test).
    openai_case = text.index("openai/*)")
    assert openai_case > text.index('case "${reef_model}" in')
    assert 'reef_runtime="openclaw"' in text  # API-key agents → direct runtime
    assert 'reef_runtime="codex"' in text  # subscription agents → Codex harness


def test_codex_subscription_routes_openai_through_codex_harness():
    text = ENTRYPOINT.read_text()
    # A ChatGPT-subscription agent (REEF_OPENAI_AUTH=subscription, set by the
    # OpenClaw profile for an oauth pick) pins the openai/* model to the Codex
    # harness rather than the direct runtime, so the owner's OAuth'd ChatGPT plan
    # is used once they complete the in-terminal device-code login.
    assert '"${REEF_OPENAI_AUTH:-}" = "subscription"' in text
    assert 'reef_runtime="codex"' in text
    # Whatever reef_runtime resolves to is written to the model's agentRuntime.id.
    assert '"agents.defaults.models[\\"${reef_model}\\"].agentRuntime.id"' in text
    # The Codex harness plugin is bundled but ships DISABLED and is blocked by the
    # clawbits-only allowlist, so subscription agents must allow + enable it — else
    # the codex runtime pin fails at run time ("harness 'codex' is not registered").
    assert '["clawbits","codex"]' in text
    assert "plugins.entries.codex.enabled true" in text
    # Keyed agents keep the minimal allowlist (no codex plugin).
    assert '\'["clawbits"]\'' in text
