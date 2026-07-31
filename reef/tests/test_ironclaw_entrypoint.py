from pathlib import Path

from reef.agents import AGENT_TYPES, infer_type
from reef.profiles import AgentProfile

IMG = Path(__file__).parents[1] / "images" / "ironclaw-runtime"
ENTRYPOINT = IMG / "entrypoint.sh"
BUILD_SCRIPT = IMG / "build.sh"
DOCKERFILE = IMG / "Dockerfile"


def test_channel_activation_precedes_foreground_gateway():
    text = ENTRYPOINT.read_text()
    activate_idx = text.index("cfg activated_channels '[\"clawbits\"]'")
    gateway_idx = text.index("exec ironclaw run")
    assert activate_idx < gateway_idx
    # The gateway is the foreground liveness process — never backgrounded.
    assert "exec ironclaw run --no-onboard" in text
    assert "exec ironclaw run --no-onboard &" not in text


def test_channel_only_activated_when_a_key_is_present():
    text = ENTRYPOINT.read_text()
    # Activation is gated on an available API key; detached / token-enroll paths
    # leave the channel inactive (so it never polls unauthenticated → 401 loop).
    assert 'if [ -n "${CLAWBITS_API_KEY:-}" ]; then' in text
    assert "cfg activated_channels '[]'" in text


def test_build_bakes_channel_onto_a_base_image():
    text = BUILD_SCRIPT.read_text()
    assert "ironclaw-channel" in text and "./build.sh" in text
    assert '--build-arg "IRONCLAW_BASE=${base}"' in text
    assert '--build-arg "CLAWBITS_CHANNEL_VERSION=${channel_version}"' in text


def test_build_derives_ironclaw_stack_tag():
    text = BUILD_SCRIPT.read_text()
    # Identity is derived from what landed: reef-ic:ic<ironclaw>-ch<channel> + the
    # same stack baked as REEF_IMAGE_VERSION; no hand-bumped VERSION file.
    assert 'stack="ic${ironclaw_version}-ch${channel_version}"' in text
    assert '--build-arg "REEF_IMAGE_VERSION=${stack}"' in text
    assert "reef-ic:${stack}" in text
    assert 'cat "${here}/VERSION"' not in text
    assert "reef-ic:${version}" not in text


def test_channel_version_label_matches_entrypoint_report():
    # The channel label is only truthful if the entrypoint reports the SAME value:
    # the Dockerfile must promote CLAWBITS_CHANNEL_VERSION to ENV (an ARG alone is
    # gone at runtime → the agent reports "unknown" and false-flags forever).
    assert "ENV CLAWBITS_CHANNEL_VERSION=${CLAWBITS_CHANNEL_VERSION}" in DOCKERFILE.read_text()
    # And the engine version is extracted the SAME way build.sh does (last field),
    # so the baked label equals what status.json reports.
    assert 'iron_ver="${iron_ver##* }"' in ENTRYPOINT.read_text()
    assert "awk '{print $NF}'" in BUILD_SCRIPT.read_text()


def test_headless_mode_disables_tui_via_config_toml():
    text = ENTRYPOINT.read_text()
    # A microVM has no TTY: the full-screen TUI would claim stdin and block
    # forever. cli_mode defaults to Some("tui") and resolves settings-first, so an
    # env var is SHADOWED — it must be pinned in config.toml (the only lever the
    # from_env config path honours). Assert we write a non-tui cli_mode there.
    assert 'config.toml' in text
    assert 'cli_mode = "headless"' in text  # anything != "tui" disables the TUI
    assert 'cli_enabled = false' in text
    # The gateway stays the foreground liveness anchor.
    assert 'GATEWAY_ENABLED="${GATEWAY_ENABLED:-true}"' in text


def test_signup_token_enrollment_precedes_activation():
    text = ENTRYPOINT.read_text()
    # The signup helper (token-enroll) must define + run before the wire/activate
    # block, so a successfully minted key flows into the same activation path.
    assert "reef_clawbits_signup()" in text
    assert "--signup-only" in text
    signup_call = text.index("reef_clawbits_signup ||")
    activate = text.index("cfg activated_channels '[\"clawbits\"]'")
    assert signup_call < activate
    # On success it must export the minted key for the exec'd `ironclaw run`.
    assert 'export CLAWBITS_API_KEY="${key}"' in text


def test_signup_never_logs_the_minted_key():
    # reef reads container logs host-side, so the minted key / raw signup JSON must
    # never reach a `log`/`echo` line (the "reef can't read agent secrets" model).
    for line in ENTRYPOINT.read_text().splitlines():
        stripped = line.strip()
        if stripped.startswith("log ") or stripped.startswith("echo "):
            assert "${json}" not in line
            assert "${key}" not in line
            assert "CLAWBITS_API_KEY" not in line
            assert "CLAWBITS_SIGNUP_TOKEN" not in line


def test_onboarding_greeting_runs_in_the_keyed_branch_and_dedupes():
    text = ENTRYPOINT.read_text()
    # "Missing messages" fix: the entrypoint used to run the helper only in
    # --signup-only mode, so an IronClaw agent never spoke first and the owner's
    # eager first message fell inside the channel's first-poll watermark anchor
    # (never replayed). The greeting run is the helper's DEFAULT mode: no
    # --signup-only, deduped on the durable workspace volume (restarts never
    # re-greet), and best-effort (a failed greeting never blocks boot).
    start = text.index("reef_clawbits_greeting() {")
    body = text[start : text.index("\n}", start)]
    assert "--signup-only" not in body
    assert '--state-file "${STATE_DIR}/workspace/.reef-clawbits-greeted"' in body
    assert "non-fatal" in body

    # It runs inside the wire/activate branch only (a detached boot has no key
    # to greet with), after activation config and before the gateway exec.
    call = text.rindex("\n  reef_clawbits_greeting\n")
    activate = text.index("cfg activated_channels '[\"clawbits\"]'")
    detached = text.index("cfg activated_channels '[]'")
    assert activate < call < detached
    assert call < text.index("exec ironclaw run")


def test_local_http_endpoint_names_ironclaw_insecure_host():
    text = ENTRYPOINT.read_text()
    # IronClaw's WASM gate needs https + rejects private IPs. For a LOCAL http
    # clawbits (local dev), the entrypoint names that host in IronClaw's
    # insecure-http allowlist; a public/https endpoint stays strict.
    assert 'IRONCLAW_ALLOW_INSECURE_HTTP_HOSTS="${host}"' in text
    # Gated on an http scheme + a local host, incl. the microVM host-gateway alias.
    assert '[ "${endpoint%%://*}" = "http" ]' in text
    assert "*.internal" in text  # host.microsandbox.internal / host.docker.internal


def test_build_applies_ironclaw_patches_from_checkout():
    # IronClaw source is a bring-your-own checkout at <repo_root>/ironclaw; Reef
    # changes ride as patches applied at build time (no fork). build.sh must
    # fail with actionable guidance when the checkout is missing, then patch it.
    build = BUILD_SCRIPT.read_text()
    assert "no IronClaw source at" in build
    assert "git clone https://github.com/nearai/ironclaw.git" in build
    assert "prepare_ironclaw_source" in build
    assert 'git -C "${ironclaw_dir}" apply' in build
    # Idempotent guard: skip a patch that's already present in the tree.
    assert "apply --reverse --check" in build

    patches = sorted((IMG / "patches").glob("*.patch"))
    names = [p.name for p in patches]
    assert "0001-wasm-allow-insecure-http-hosts.patch" in names
    assert "0002-openai-max-completion-tokens.patch" in names
    # Each patch is a real unified diff touching the expected ironclaw files.
    p1 = (IMG / "patches" / "0001-wasm-allow-insecure-http-hosts.patch").read_text()
    assert "src/tools/wasm/http_security.rs" in p1
    assert "IRONCLAW_ALLOW_INSECURE_HTTP_HOSTS" in p1
    p2 = (IMG / "patches" / "0002-openai-max-completion-tokens.patch").read_text()
    assert "crates/ironclaw_llm/src/rig_adapter.rs" in p2
    assert "requires_max_completion_tokens" in p2

    # No .gitmodules: the checkout is supplied by the operator, not vendored.
    assert not (IMG.parents[2] / ".gitmodules").exists()


def test_dockerfile_bakes_the_signup_helper():
    # Staged entirely by the Dockerfile now: the `clawbits-image` stage COPYs
    # both files from the `channel-src` named context. build.sh no longer
    # stages anything host-side (the REEF_CHANNEL_BUILD=host mode that did was
    # removed in the pre-open-source cleanup).
    dockerfile = DOCKERFILE.read_text()
    assert "COPY --from=channel-src onboarding_message.py" in dockerfile
    assert "COPY --from=channel-src src/known_answers.rs" in dockerfile

    # python3 (stdlib-only) powers the signup helper; both files land in SIGNUP_DIR.
    assert "python3" in dockerfile
    assert "/usr/local/lib/reef-clawbits-signup/onboarding_message.py" in dockerfile
    assert "/usr/local/lib/reef-clawbits-signup/known_answers.rs" in dockerfile


def test_registry_enabled_and_profile_conforms():
    assert AGENT_TYPES["ironclaw"].enabled
    p = AGENT_TYPES["ironclaw"].profile()
    assert isinstance(p, AgentProfile)
    assert p.name == "ironclaw"
    assert p.ui_port == 3000
    assert infer_type("reef-ic:channel") == "ironclaw"


def test_build_env_shapes():
    p = AGENT_TYPES["ironclaw"].profile()
    assert p.build_env({}) == {}  # detached
    prov = p.build_env(
        {
            "org_id": "o",
            "agent_id": "a",
            "api_key": "k",
            "channel_id": "c",
            "openai_api_key": "sk",
        }
    )
    assert prov["CLAWBITS_API_KEY"] == "k"
    assert prov["CLAWBITS_CHANNEL_ID"] == "c"
    assert prov["LLM_BACKEND"] == "openai"
    exposed = p.exposure_env(password="s3cret", public_url="https://x")
    assert exposed["GATEWAY_AUTH_TOKEN"] == "s3cret"
    # Detail view (secret=None) never reveals the password.
    assert p.access_info(exposed, url="https://x").password is None
    assert p.access_info(exposed, url="https://x", secret="s3cret").password == "s3cret"


def test_backend_chain_covers_gemini_nearai_and_ollama():
    text = ENTRYPOINT.read_text()
    # Fallback derivation (reef's profile pre-pins LLM_BACKEND when it injects a
    # provider): registry preference order, ollama keyed off OLLAMA_BASE_URL
    # (IronClaw never reads OLLAMA_HOST — verified vs nearai/ironclaw@06f9f0fc).
    chain = text[text.index('if [ -z "${LLM_BACKEND:-}" ]'):]
    ant = chain.index('LLM_BACKEND="anthropic"')
    oai = chain.index('LLM_BACKEND="openai"')
    gem = chain.index('LLM_BACKEND="gemini"')
    near = chain.index('LLM_BACKEND="nearai"')
    oll = chain.index('LLM_BACKEND="ollama"')
    assert ant < oai < gem < near < oll
    assert '[ -n "${NEARAI_API_KEY:-}" ]' in chain
    assert '[ -n "${OLLAMA_BASE_URL:-}" ]' in chain


def test_model_pin_strips_openclaw_style_provider_prefix():
    text = ENTRYPOINT.read_text()
    # IronClaw's selected_model is a bare id; one REEF_DEFAULT_MODEL value must
    # serve both runtimes.
    assert 'reef_model="${reef_model#*/}"' in text
    assert "google/*" in text and "ollama/*" in text


def test_model_pin_never_strips_nearai_hf_paths():
    text = ENTRYPOINT.read_text()
    # NEAR model ids are HF-style org/model paths whose first segment can
    # collide with a real provider (openai/gpt-oss-120b): on the nearai
    # backend the full path IS the model id, so the generic strip is guarded —
    # only an explicit nearai/ prefix is removed.
    assert 'nearai/*) reef_model="${reef_model#nearai/}"' in text
    assert '[ "${LLM_BACKEND:-}" = "nearai" ] || reef_model="${reef_model#*/}"' in text


def test_build_env_gemini_nearai_and_ollama_shapes():
    p = AGENT_TYPES["ironclaw"].profile()
    gem = p.build_env({"gemini_api_key": "AIza-x"})
    assert gem["GEMINI_API_KEY"] == "AIza-x"
    assert gem["LLM_BACKEND"] == "gemini"
    near = p.build_env({"nearai_api_key": "sk-near", "model": "zai-org/GLM-5.1-FP8"})
    assert near["NEARAI_API_KEY"] == "sk-near"
    assert near["LLM_BACKEND"] == "nearai"
    assert near["REEF_DEFAULT_MODEL"] == "zai-org/GLM-5.1-FP8"
    # Preference order: anthropic wins when both keys ride along.
    multi = p.build_env({"anthropic_api_key": "sk-ant", "nearai_api_key": "sk-near"})
    assert multi["LLM_BACKEND"] == "anthropic"
    oll = p.build_env({"ollama_host": "http://h:11434", "model": "llama3.2"})
    assert oll["OLLAMA_HOST"] == "http://h:11434"
    assert oll["OLLAMA_BASE_URL"] == "http://h:11434"  # IronClaw's spelling
    assert oll["LLM_BACKEND"] == "ollama"
    assert oll["REEF_DEFAULT_MODEL"] == "llama3.2"
