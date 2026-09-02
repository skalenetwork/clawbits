import base64
import re
import shutil
import subprocess
from pathlib import Path

import pytest

from reef import fleet
from reef.fleet import (
    _DANGEROUS_ENV_KEYS,
    _GUEST_DROPPED_ENV_KEYS,
    _GUEST_DROPPED_ENV_PREFIXES,
    _supports_env_file,
    _validate_user_env,
)

ENTRYPOINT = Path(__file__).parents[1] / "images" / "openclaw-runtime" / "entrypoint.sh"
BUILD_SCRIPT = ENTRYPOINT.with_name("build.sh")
DOCKERFILE = ENTRYPOINT.with_name("Dockerfile")
CLAWBITS_TOOLS = (
    "clawbits_channels_list",
    "clawbits_channel_members",
    "clawbits_email_inbox",
    "clawbits_email_get",
    "clawbits_agent_info",
    "clawbits_email_send",
    "clawbits_agent_description_update",
)


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


def test_chatgpt_subscription_gets_a_default_model_without_an_api_key():
    """A ChatGPT-subscription agent must reach the model-pin block.

    Regression: the auto-default was gated on OPENAI_API_KEY alone, but the
    subscription path injects no key by design (providers.py KIND_OAUTH), and
    the create wizard offers no model on that path — so REEF_DEFAULT_MODEL and
    OPENAI_API_KEY were both empty, reef_model stayed empty, and the whole
    ``if [ -n "${reef_model}" ]`` block was skipped. That block is ALSO where
    agentRuntime.id=codex is pinned, so the agent booted with no default model
    and no Codex harness and generated no replies at all.
    """
    text = ENTRYPOINT.read_text()
    auto_default_start = text.index('if [ -z "${reef_model}" ]')
    model_apply_start = text.index('if [ -n "${reef_model}" ]', auto_default_start)
    auto_default = text[auto_default_start:model_apply_start]

    # The subscription marker must satisfy the "is this an OpenAI agent" gate.
    assert '"${REEF_OPENAI_AUTH:-}" = "subscription"' in auto_default
    # ...and it must be OR'd with the key, not AND'd (a subscription agent has
    # no key, so an AND would keep the branch unreachable).
    assert '|| [ "${REEF_OPENAI_AUTH:-}" = "subscription" ]' in auto_default
    # Still exclusive with the other providers.
    for other in ("ANTHROPIC_API_KEY", "GEMINI_API_KEY", "OLLAMA_HOST"):
        assert f'[ -z "${{{other}:-}}" ]' in auto_default


def test_post_boot_login_command_never_applies_the_broken_default():
    """The documented device-code command must NOT carry --set-default.

    ``--set-default`` applies the provider's own recommendation, which is
    openai/gpt-5.5 — the model whose session-mirror hook crashes the pinned
    OpenClaw codex runtime and breaks every message after the first. That is
    why the pickers omit it; the login command must not reintroduce it behind
    the user's back.
    """
    roots = [Path(__file__).resolve().parents[2]]
    hits = []
    for root in roots:
        for rel in (
            "frontend/src/components/new-agent/NewAgentDialog.tsx",
            "reef/admin-ui/src/components/create-agent/CreateAgentDialog.tsx",
        ):
            p = root / rel
            if p.exists():
                hits.append(p.read_text())
    assert hits, "expected to find the create wizards"
    for text in hits:
        for line in text.splitlines():
            if "models auth login" in line:
                assert "--set-default" not in line, line.strip()


def test_build_smart_cache_key_derivation():
    text = BUILD_SCRIPT.read_text()
    # Pinned plugin ⇒ deterministic key; force-fresh ⇒ nocache; else a timestamp
    # nonce busts ONLY the plugin layer so a default build re-resolves the latest
    # plugin while the expensive base/ttyd layers stay cached.
    assert 'cache_key="${CLAWBITS_PLUGIN_VERSION}"' in text
    assert 'cache_key="$(date +%s)"' in text
    assert 'cache_key="nocache"' in text
    assert '--build-arg "CLAWBITS_PLUGIN_CACHE_KEY=${cache_key}"' in text
    # One requested component version pins both halves of the split.
    assert '--build-arg "CLAWBITS_PLUGIN_VERSION=${CLAWBITS_PLUGIN_VERSION:-}"' in text


def test_split_plugins_are_installed_at_one_version():
    dockerfile = DOCKERFILE.read_text()
    assert 'openclaw plugins install "${channel_ref}" --pin' in dockerfile
    assert 'clawhub:clawbits-openclaw-tools@${resolved_plugin_version}' in dockerfile
    assert 'ARG CLAWBITS_PLUGIN_VERSION=' in dockerfile
    # The default build resolves the channel first, then uses its actual version
    # for the companion instead of independently asking ClawHub for latest.
    assert 'id==="clawbits"' in dockerfile
    channel = dockerfile.index('openclaw plugins install "${channel_ref}" --pin')
    tools = dockerfile.index("clawhub:clawbits-openclaw-tools@${resolved_plugin_version}")
    assert channel < tools


def test_build_derives_truthful_stack_tag_from_probe():
    text = BUILD_SCRIPT.read_text()
    # The build probes the BUILT image for the real versions (same extraction the
    # entrypoint reports into status.json) and derives an immutable self-describing
    # tag reef-oc:oc<oc>-pl<pl> — no hand-bumped VERSION file, no reef-oc:<version>.
    assert "openclaw --version" in text
    assert "openclaw plugins list --json" in text
    assert 'x.id==="clawbits-tools"' in text
    assert '"${installed_plugin}" != "${installed_tools}"' in text
    assert 'stack="oc${installed_oc}-pl${installed_plugin}${stack_suffix}"' in text
    assert "org.reef.clawbits-tools.version" in text
    assert "reef-oc:${stack}" in text
    assert 'cat "$here/VERSION"' not in text
    assert "reef-oc:${version}" not in text


def test_local_plugin_build_cannot_overwrite_a_clawhub_stack_tag():
    text = BUILD_SCRIPT.read_text()
    assert 'stack_suffix=""' in text
    assert 'stack_suffix="-local"' in text
    local_block = text[
        text.index('if [ -n "${CLAWBITS_PLUGIN_LOCAL:-}" ]') : text.index("# Smart cache")
    ]
    assert 'stack_suffix="-local"' in local_block
    assert 'image="reef-oc:local-plugin"' in local_block
    assert 'plugin_stage="plugin-local"' in local_block
    assert 'stage-channel.mjs "${stage_dir}/channel"' in local_block
    assert 'stage-tools.mjs "${stage_dir}/tools"' in local_block
    assert '--build-arg "CLAWBITS_PLUGIN_STAGE=${plugin_stage}"' in text
    dockerfile = DOCKERFILE.read_text()
    assert "ARG CLAWBITS_PLUGIN_STAGE=plugin-clawhub" in dockerfile
    assert ".plugin-src/channel/" in dockerfile
    assert ".plugin-src/tools/" in dockerfile


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


def test_openrouter_plugin_loads_without_an_allowlist_entry():
    """Supersedes the old "openrouter must be in plugins.allow" guard.

    The openrouter PROVIDER is a bundled plugin, and the clawbits-only
    allowlist blocked it (the codex trap from the other side): onboarding wrote
    the key fine, then every openrouter/* model errored "unavailable from the
    provider" at run time. That was patched by adding openrouter to both
    allowlist branches; the entrypoint now sets NO allowlist at all, so every
    bundled plugin loads on its own and the per-plugin entries are gone.

    The guarantee this test protects is the outcome, not the mechanism: a keyed
    openrouter agent must end up with a loadable provider plugin. Re-adding any
    `plugins.allow` write would silently break that again — and would also take
    browser/document-extract/web-readability down with it."""
    text = ENTRYPOINT.read_text()
    assert "openclaw config unset plugins.allow" in text
    assert "config set plugins.allow" not in text
    # The onboard branch that writes the key must still be there.
    assert "--auth-choice openrouter-api-key" in text


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
    # The Codex harness plugin is bundled but ships DISABLED, so subscription
    # agents must ENABLE it — else the codex runtime pin fails at run time
    # ("harness 'codex' is not registered"). Enabling the entry is what actually
    # turns it on; there is no allowlist involved any more (see the plugin-policy
    # test below).
    assert "plugins.entries.codex.enabled true" in text


def test_companion_owns_split_background_services():
    text = ENTRYPOINT.read_text()
    ownership = "openclaw config set channels.clawbits.serviceOwner tools"
    assert ownership in text
    assert text.index(ownership) < text.index("reef_clawbits_autosignup\n")
    assert text.index(ownership) < text.index("exec openclaw gateway run")


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
    assert "tools.alsoAllow '[\"browser\"," in text
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
    assert "tools.alsoAllow '[\"browser\",\"cron\"," in text
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


def test_companion_tools_are_allowed_without_unrestricted_messaging_group():
    """The seven narrow companion tools are intentional. The unrestricted
    group:messaging family must still not be enabled by Reef's tool policy."""
    text = ENTRYPOINT.read_text()
    for tool in CLAWBITS_TOOLS:
        assert tool in text
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("#") or not stripped:
            continue  # comments may name it; only executable lines matter
        assert "group:messaging" not in stripped
        # tools.profile="full" would pull messaging in silently.
        assert "tools.profile" not in stripped


def test_status_reports_both_split_plugin_versions():
    text = ENTRYPOINT.read_text()
    assert 'x.id === "clawbits"' in text
    assert 'x.id === "clawbits-tools"' in text
    assert "clawbitsPlugin: plugin" in text
    assert "clawbitsTools: tools" in text


# ── The reef-managed user env file (REEF_ENV_DIR/env) ─────────────────────────


def _env_reader_source() -> str:
    text = ENTRYPOINT.read_text()
    start = text.index("reef_apply_env_file() {")
    end = text.index("\n}\n", start) + len("\n}\n")
    func = text[start:end]
    assert func.rstrip().endswith("}")
    assert "base64 -d" in func and "export " in func
    return func


def _run_env_reader(
    tmp_path: Path, records: list[str], *, preset: dict[str, str] | None = None
) -> tuple[int, dict[str, tuple[bool, str]]]:
    if shutil.which("base64") is None:
        pytest.skip("no base64(1) on this host; the guest image ships coreutils")
    env_dir = tmp_path / "reef-env"
    env_dir.mkdir()
    # No trailing newline: exercises the reader's `|| [ -n "${_op:-}" ]` clause.
    (env_dir / "env").write_text("\n".join(records))

    # Only legal shell identifiers can be probed: `${9BAD+x}` is a syntax error.
    probes = sorted(
        {"ORIGPATH", "PATH"}
        | set(preset or {})
        | {
            p[1]
            for p in (r.split() for r in records)
            if len(p) >= 2 and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", p[1])
        }
    )
    presets = "\n".join(f"{k}={v!r}; export {k}" for k, v in (preset or {}).items())
    # Delimiter-framed rather than line-based: a value may legally contain newlines.
    script = f"""set -eu
{_env_reader_source()}
ORIGPATH="${{PATH}}"; export ORIGPATH
{presets}
REEF_ENV_DIR="{env_dir}"; export REEF_ENV_DIR
reef_apply_env_file
for _key in {" ".join(probes)}; do
  eval "_present=\\${{${{_key}}+yes}}"
  eval "_val=\\${{${{_key}}-}}"
  printf '<<%s|%s>>%s<<END>>' "${{_key}}" "${{_present:-no}}" "${{_val}}"
  unset _present _val
done
"""
    proc = subprocess.run(["/bin/sh", "-c", script], capture_output=True, text=True)
    found = {
        m.group(1): (m.group(2) == "yes", m.group(3))
        for m in re.finditer(r"<<(\w+)\|(\w+)>>(.*?)<<END>>", proc.stdout, re.S)
    }
    return proc.returncode, found


def _rec(key: str, value: str) -> str:
    return f"s {key} {base64.b64encode(value.encode()).decode()}"


def test_env_file_reader_runs_before_the_gateway_and_the_terminal():
    text = ENTRYPOINT.read_text()
    setpriv = text.index("exec setpriv --reuid node")
    apply_idx = text.index("\nreef_apply_env_file\n")
    assert setpriv < apply_idx
    assert apply_idx < text.index('if [ -z "${OPENCLAW_GATEWAY_TOKEN:-}" ]')
    assert apply_idx < text.index("ttyd --writable")
    assert apply_idx < text.index("exec openclaw gateway run")
    assert "ENV REEF_ENV_DIR=/home/node/.reef-env" in DOCKERFILE.read_text()


def test_env_file_reader_applies_sets_empties_and_unsets(tmp_path):
    code, env = _run_env_reader(
        tmp_path,
        [
            "# reef guest env v1 - written by reef, parsed (never eval'd) by the entrypoint.",
            "v1",
            _rec("AGENTPIT_API_KEY", "sk-live-example"),
            "s EMPTY",  # the two-field form serialize() emits for an empty value
            "u GONE",
        ],
        preset={"GONE": "inherited from the container -e layer"},
    )
    assert code == 0
    assert env["AGENTPIT_API_KEY"] == (True, "sk-live-example")
    assert env["EMPTY"] == (True, "")
    assert env["GONE"][0] is False


def test_env_file_reader_never_evaluates_a_value(tmp_path):
    nasty = "`id` $(id) ${HOME} $HOME 'sq' \"dq\" \\ ; | > & \nsecond line\ttab"
    code, env = _run_env_reader(tmp_path, [_rec("NASTY", nasty)])
    assert code == 0
    assert env["NASTY"] == (True, nasty)
    # Nothing ran: a `uid=` anywhere would mean `id` was executed, not quoted.
    assert "uid=" not in env["NASTY"][1]


def test_env_file_reader_survives_a_malformed_file(tmp_path):
    code, env = _run_env_reader(
        tmp_path,
        [
            "",  # blank
            "garbage",  # one field
            "s 9BAD aGk=",  # key starts with a digit
            "s BAD-KEY aGk=",  # key is not an identifier
            "x SOMETHING aGk=",  # unknown op
            "u",  # `u` with no key
            "s BADB64 ***not-base64***",  # value fails to decode
            _rec("SURVIVOR", "still applied"),
        ],
    )
    assert code == 0
    for key in ("SOMETHING", "BADB64"):
        assert env[key][0] is False
    assert env["SURVIVOR"] == (True, "still applied")


def _guest_filter_arms() -> tuple[set[str], set[str], set[str]]:
    """(namespace prefixes, namespace keys, dangerous keys), parsed out of the reader."""
    body = _env_reader_source().split('case "${_k}" in', 1)[1].split("esac", 1)[0]
    namespace: set[str] = set()
    dangerous: set[str] = set()
    for line in body.splitlines():
        patterns = {p.strip().strip('"') for p in line.split(")", 1)[0].split("|")}
        patterns = {p for p in patterns if p and "[" not in p}
        if not patterns:
            continue
        (namespace if any(p.endswith("*") for p in patterns) else dangerous).update(patterns)
    prefixes = {p.rstrip("*") for p in namespace if p.endswith("*")}
    return prefixes, {p for p in namespace if not p.endswith("*")}, dangerous


def test_every_server_filtered_key_is_dropped_by_the_reader(tmp_path):
    prefixes, namespace_keys, dangerous = _guest_filter_arms()
    assert len(prefixes) >= 5 and len(namespace_keys) >= 2 and len(dangerous) >= 9
    assert prefixes == set(_GUEST_DROPPED_ENV_PREFIXES)
    assert namespace_keys == set(_GUEST_DROPPED_ENV_KEYS)
    assert dangerous == set(_DANGEROUS_ENV_KEYS)

    probes = [f"{prefix}PROBE" for prefix in _GUEST_DROPPED_ENV_PREFIXES]
    probes += sorted(_GUEST_DROPPED_ENV_KEYS | _DANGEROUS_ENV_KEYS)
    # Controls go FIRST: a landed PATH would break every later decode and make the
    # drop assertions pass for the wrong reason.
    controls = ["AGENTPIT_API_KEY", "OPENCLAW_STATE_DIR"]
    code, env = _run_env_reader(
        tmp_path, [_rec(key, f"applied-{key}") for key in controls + probes]
    )
    assert code == 0

    for key in controls:
        assert env[key] == (True, f"applied-{key}"), f"{key} should have been applied"
    for key in probes:
        assert env[key][1] != f"applied-{key}", f"{key} reached the guest"
    assert env["PATH"][1] == env["ORIGPATH"][1]


def test_guest_dropped_keys_are_refused_by_the_server_validator():
    prefixes, namespace_keys, dangerous = _guest_filter_arms()
    keys = [f"{prefix}PROBE" for prefix in sorted(prefixes)]
    keys += sorted(namespace_keys | dangerous)
    assert len(keys) >= 17

    secret = "sk-live-should-never-be-echoed"
    for key in keys:
        with pytest.raises(ValueError) as excinfo:
            _validate_user_env({key: secret})
        message = str(excinfo.value)
        assert key in message, f"{key}: refusal does not say which key"
        assert secret not in message, f"{key}: refusal echoed the value"
    assert _validate_user_env({"AGENTPIT_API_KEY": secret}) == {"AGENTPIT_API_KEY": secret}


def test_the_api_refuses_exactly_the_values_the_reader_would_change(tmp_path):
    cases = {
        "PLAIN": "sk-live-example",
        "EMPTY_VALUE": "",
        "TRAILING_SPACE": "trailing space ",
        "TRAILING_TAB": "trailing tab\t",
        "INNER_NEWLINE": "mid\nline",
        "NEWLINE_THEN_SPACE": "keep\n ",
        "ONE_TRAILING_NEWLINE": "keep\n",
        "TWO_TRAILING_NEWLINES": "keep\n\n",
        "ONLY_A_NEWLINE": "\n",
    }
    # No "\r" case: subprocess text mode rewrites a lone CR on the way back.
    code, env = _run_env_reader(tmp_path, [_rec(key, value) for key, value in cases.items()])
    assert code == 0

    lossy = set()
    for key, sent in cases.items():
        present, got = env[key]
        assert present, f"{key} was not applied at all"
        if got != sent:
            lossy.add(key)
    assert lossy == {"ONE_TRAILING_NEWLINE", "TWO_TRAILING_NEWLINES", "ONLY_A_NEWLINE"}
    assert env["ONE_TRAILING_NEWLINE"][1] == "keep"
    assert env["TWO_TRAILING_NEWLINES"][1] == "keep"
    assert env["ONLY_A_NEWLINE"][1] == ""
    assert env["INNER_NEWLINE"][1] == "mid\nline"
    assert env["NEWLINE_THEN_SPACE"][1] == "keep\n "

    refused = set()
    for key, sent in cases.items():
        try:
            _validate_user_env({key: sent})
        except ValueError as exc:
            refused.add(key)
            assert sent not in str(exc), f"{key}: refusal echoed the value"
    assert refused == lossy, "the API refuses a different set than the reader loses"


def test_the_image_and_the_server_name_each_other_by_real_symbols():
    body = "\n".join(
        line
        for text in (ENTRYPOINT.read_text(), DOCKERFILE.read_text())
        for line in text.splitlines()
        if line.lstrip().startswith("#")
    )
    named = set(re.findall(r"fleet\.(_[a-z][a-z0-9_]*|[A-Z][A-Z0-9_]+)", body))
    named |= set(re.findall(r"(?<![A-Za-z0-9_])(_[A-Z][A-Z0-9_]{4,})(?![A-Za-z0-9_])", body))
    assert {
        "_DANGEROUS_ENV_KEYS",
        "_GUEST_DROPPED_ENV_KEYS",
        "_GUEST_DROPPED_ENV_PREFIXES",
    } <= named, f"the KEEP IN SYNC note stopped naming the mirrored constants; found {named}"
    for symbol in sorted(named):
        assert hasattr(fleet, symbol), f"image comments name fleet.{symbol}, which does not exist"

    fleet_source = Path(fleet.__file__).read_text()
    assert "reef_apply_env_file() {" in ENTRYPOINT.read_text()
    assert "reef_apply_env_file" in fleet_source
    repo_root = Path(__file__).resolve().parents[2]
    referenced = {p.rstrip(".") for p in re.findall(r"reef/images/[A-Za-z0-9_./-]+", fleet_source)}
    assert referenced  # the notes exist at all
    for rel in sorted(referenced):
        assert (repo_root / rel).exists(), f"fleet.py points at {rel}, which is not there"


def test_the_baked_features_marker_satisfies_the_servers_apply_gate():
    baked = dict(re.findall(r"(?m)^ENV ([A-Za-z_][A-Za-z0-9_]*)=(.*)$", DOCKERFILE.read_text()))
    assert _supports_env_file(baked), f"the shipped marker {baked.get('REEF_FEATURES')!r} fails"

    restamp = BUILD_SCRIPT.read_text().split("printf 'FROM %s\\n", 1)[1].split("' \\", 1)[0]
    redeclared = set(re.findall(r"ENV ([A-Za-z_][A-Za-z0-9_]*)=", restamp))
    assert redeclared == {"REEF_IMAGE_VERSION"}, f"the re-stamp layer now declares {redeclared}"
