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
    # Preference order: anthropic wins, gemini before nearai before ollama,
    # else skip.
    ant = text.index("--auth-choice anthropic-api-key")
    gem = text.index("--auth-choice gemini-api-key")
    near = text.index("--auth-choice custom-api-key")
    oll = text.index("--auth-choice ollama")
    assert ant < gem < near < oll


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
    # The Codex harness plugin is bundled but ships DISABLED, so subscription
    # agents must ENABLE it — else the codex runtime pin fails at run time
    # ("harness 'codex' is not registered"). Enabling the entry is what actually
    # turns it on; there is no allowlist involved any more (see the plugin-policy
    # test below).
    assert "plugins.entries.codex.enabled true" in text


def test_no_exclusive_plugin_allowlist():
    """`plugins.allow` is an EXCLUSIVE allowlist: setting it to '["clawbits"]'
    disabled 95 of OpenClaw's 96 BUNDLED plugins (browser, document-extract,
    web-readability, canvas, every provider extension). The entrypoint must not
    set one, and must actively UNSET it so agents carrying the old value in their
    persisted ~/.openclaw config recover on their next boot."""
    text = ENTRYPOINT.read_text()
    assert "openclaw config unset plugins.allow" in text
    assert "config set plugins.allow" not in text


def test_browser_tool_is_allowed_and_configured():
    """Chromium in the image is not enough: `browser` is absent from the `coding`
    tool profile, so it must be merged in via alsoAllow (never plain `allow`,
    which REPLACES the profile), and headless+noSandbox are mandatory for
    Chromium to start at all in this container."""
    text = ENTRYPOINT.read_text()
    assert "tools.alsoAllow '[\"browser\"]'" in text
    assert "config set tools.allow" not in text
    assert "browser.noSandbox true" in text
    assert "browser.headless true" in text
    # Enablement is probed, not assumed, so a slim (non `-browser`) build does not
    # advertise a browser it cannot launch.
    assert "ms-playwright/chromium-" in text


def test_capabilities_are_gated_and_revocable():
    """REEF_CAPS drives the two capabilities whose blast radius leaves the microVM.
    Each must write BOTH branches: the config is persisted in ~/.openclaw, so a
    revoke has to actively turn the feature off rather than merely stop enabling
    it. Anything the VM contains (shell, packages, browser) is NOT gated here."""
    text = ENTRYPOINT.read_text()
    assert "reef_has_cap" in text
    # cron: BOTH halves gated - the `cron` TOOL (so the model can create
    # schedules) and `cron.enabled` (so the gateway actually runs them) - each
    # with an explicit off-branch. Gating one half would leave jobs that can be
    # created but never fire, or jobs that keep firing after a revoke.
    assert "cron.enabled true" in text
    assert "cron.enabled false" in text
    assert "tools.alsoAllow '[\"browser\",\"cron\"]'" in text
    # `cron.triggers.*` is NOT in the config schema: writing it fails validation
    # and takes the gateway down on boot. Only the comment warning about it may
    # mention the name.
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("#"):
            continue
        assert "cron.triggers" not in stripped
    # gh: linked in when granted, and the link REMOVED when not
    assert "/opt/reef/gh-bin/gh" in text
    assert 'rm -f "${HOME}/.local/bin/gh"' in text


def test_no_capability_grants_messaging():
    """group:messaging reaches other humans/agents in the customer's org with no
    boundary in between - no VM, egress rule or resource limit touches it. It is
    deliberately not a capability. Asserted against what the entrypoint SETS, not
    against the prose: the comments discuss messaging on purpose."""
    text = ENTRYPOINT.read_text()
    # The only tool merged in is `browser`; nothing grants a messaging group.
    assert "tools.alsoAllow '[\"browser\"]'" in text
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("#") or not stripped:
            continue  # comments may name it; only executable lines matter
        assert "group:messaging" not in stripped
        # tools.profile="full" would pull messaging in silently.
        assert "tools.profile" not in stripped
