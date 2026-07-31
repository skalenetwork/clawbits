"""Security properties of the Hermes runtime image, asserted against the scripts.

The Hermes dashboard is the only agent surface reef exposes that has no auth of its
own once ``--insecure`` is in play, so these are load-bearing rather than cosmetic.
Each assertion here corresponds to a defect that was live at some point.
"""

from pathlib import Path

IMAGE_DIR = Path(__file__).parents[1] / "images" / "hermes-runtime"
RUN = IMAGE_DIR / "reef-hermes-run.sh"
INIT = IMAGE_DIR / "reef-hermes-init.sh"
DOCKERFILE = IMAGE_DIR / "Dockerfile"


def _code(path: Path) -> str:
    """The script minus comment lines — the comments here explain the very bugs being
    guarded against, so they name `--insecure` and `/dev/stderr` and would otherwise
    trip the assertions that those never appear in real code."""
    return "\n".join(
        ln for ln in path.read_text().splitlines() if not ln.lstrip().startswith("#")
    )


def test_insecure_flag_is_never_passed():
    """`--insecure` is not a bind guard — it is the OFF switch for the dashboard's
    auth gate (web_server.should_require_auth: non-loopback + allow_public ⇒ no auth),
    and in that mode the session token is served inside the SPA HTML, so anyone who
    can reach the port can read it and pull the agent's API keys via /api/reveal.
    Reef binds the dashboard to loopback and fronts it with basic auth instead."""
    code = _code(RUN)
    # It must never be APPENDED to the dashboard argv. (It is still named in the
    # refusal message the non-loopback guard prints, which is why this checks the
    # arg-append rather than a bare substring.)
    assert "args+=(--insecure)" not in code
    assert "--insecure" not in code.replace(
        'echo "reef-hermes:   a non-loopback bind needs --insecure, which disables auth" >&2', ""
    )


def test_dashboard_binds_loopback_and_refuses_otherwise():
    """The bind must default to loopback, and a non-loopback override must be refused
    rather than silently re-enabling the unauthenticated surface."""
    text = RUN.read_text()
    assert 'host="${HERMES_DASHBOARD_HOST:-127.0.0.1}"' in text
    assert "REFUSING to start dashboard on non-loopback host" in text


def test_auth_proxy_fails_closed_without_a_password():
    """No password ⇒ no proxy at all. The dashboard stays loopback-only inside the
    guest; it is never exposed unauthenticated."""
    text = RUN.read_text()
    proxy = text[text.index("reef_start_auth_proxy()") :]
    assert 'if [ -z "$pw" ]; then' in proxy
    assert "NOT exposing the dashboard" in proxy
    # …and the same fail-closed stance when nginx itself is missing.
    assert "nginx missing" in proxy


def test_proxy_enforces_basic_auth_on_the_forwarded_port():
    text = RUN.read_text()
    assert "auth_basic " in text and "auth_basic_user_file" in text
    # The password is hashed via stdin so it never lands in the process list.
    assert "openssl passwd -apr1 -stdin" in text


def test_proxy_preserves_websockets():
    """The dashboard's chat tab drives the agent over /api/ws + /api/pty, so the
    upgrade passthrough is functional, not boilerplate."""
    text = RUN.read_text()
    # The nginx conf is written from a heredoc, so its nginx variables are shell-
    # escaped in the source (\$http_upgrade) and land unescaped in the config.
    assert r"map \$http_upgrade \$connection_upgrade" in text
    assert r"proxy_set_header Upgrade \$http_upgrade;" in text
    assert r"proxy_set_header Connection \$connection_upgrade;" in text


def test_proxy_presents_the_loopback_host_and_origin_upstream():
    """The dashboard applies a DNS-rebinding guard to both HTTP (Host) and the WS
    upgrade (Host + Origin) against its BOUND host. A browser arriving through reef's
    surface proxy sends Origin: https://<reef-host>, which is not loopback — without
    this rewrite the chat WebSocket is refused with origin_mismatch."""
    text = RUN.read_text()
    assert "proxy_set_header Host 127.0.0.1;" in text
    assert 'proxy_set_header Origin "http://127.0.0.1:$upstream_port";' in text


def test_nginx_logs_to_the_stderr_keyword_not_the_dev_path():
    """`error_log /dev/stderr` is NOT openable by the unprivileged hermes user inside a
    microsandbox microVM — nginx dies at startup with EACCES and the dashboard is
    silently unreachable. Docker's /dev hides this, so it only bites on msb (= Linux =
    prod). The bare `stderr` keyword writes to fd 2 instead of open()ing a path."""
    code = _code(RUN)
    assert "error_log stderr" in code
    assert "/dev/stderr" not in code


def test_init_shim_replays_the_s6_chain_as_pid1():
    """msb ignores the image ENTRYPOINT/CMD and execs only `--init <path>`, so the shim
    is the whole boot on Linux. It must keep s6's /init as PID 1: /init runs the
    cont-init bootstrap and repopulates the environ that main-wrapper's with-contenv
    shebang reads, then drops root -> hermes."""
    text = INIT.read_text()
    assert "exec /init /opt/hermes/docker/main-wrapper.sh /usr/local/bin/reef-hermes-run" in text


def test_image_ships_nginx_and_the_init_shim():
    text = DOCKERFILE.read_text()
    assert "nginx" in text
    assert "reef-hermes-init" in text
    assert "/etc/cont-init.d/50-reef-status" in text


def test_model_provider_is_pinned_not_left_on_auto():
    """`provider: auto` is a trap here: hermes' auth.resolve_provider maps an
    OPENAI_API_KEY to *openrouter* (rule 3), and the stock config's base_url already
    points at openrouter.ai — so an agent handed an OpenAI key called openrouter,
    which wants OPENROUTER_API_KEY, got none, sent no Authorization header, and every
    reply died with `401 Missing Authentication header`. Pin the native provider that
    matches the key reef actually injected."""
    code = _code(RUN)
    assert "reef_configure_model" in code
    # The two native providers reef can satisfy, with their real endpoints.
    assert 'provider="anthropic"' in code and "https://api.anthropic.com" in code
    assert 'provider="openai-api"' in code and "https://api.openai.com/v1" in code
    # …and it must actually write them into hermes' config.
    assert "hermes config set model.provider" in code
    assert "hermes config set model.base_url" in code
    assert "hermes config set model.default" in code
    # Never leave the openrouter default in place when we hold a key for a real provider.
    assert "openrouter" not in code


def test_model_is_configured_before_the_gateway_starts():
    """Config written after `exec hermes gateway run` would never be read."""
    # Comment-stripped: the prose above also quotes `exec hermes gateway run`, and an
    # index() over the raw text matches that comment instead of the real call site.
    code = _code(RUN)
    assert code.index("\nreef_configure_model\n") < code.index("exec hermes gateway run")


def test_operator_model_pick_wins_over_the_default():
    """REEF_DEFAULT_MODEL is the operator's choice from the create wizard; the built-in
    is only the fallback when they didn't pick one."""
    code = _code(RUN)
    assert 'model="${REEF_DEFAULT_MODEL:-$fallback_model}"' in code


def test_codex_and_gemini_providers_are_pinned():
    """Both new integrations, and the codex one is the reason ttyd exists.

    openai-codex is OAuth: reef holds no token and injects NO key, so the entrypoint
    can only pin the provider — the owner completes a device-code login in the web
    terminal. Gemini is an ordinary api_key provider hermes reads natively.
    """
    code = _code(RUN)
    # ChatGPT subscription: keyed off the marker (there is no key to key off).
    assert '"${REEF_OPENAI_AUTH:-}" = "subscription"' in code
    assert 'provider="openai-codex"' in code
    assert "hermes login --provider openai-codex --no-browser" in code
    # Gemini: native provider, same guest var reef already injects.
    assert 'provider="gemini"' in code
    assert "https://generativelanguage.googleapis.com/v1beta" in code


def test_web_terminal_refuses_to_serve_without_a_password():
    """An unauthenticated shell on a forwarded port is remote code execution — a
    different class of problem from "no terminal". Fail closed."""
    code = _code(RUN)
    term = code[code.index("reef_start_terminal()") :]
    assert "--credential" in term
    assert "refusing to serve an unauthenticated shell" in term.lower()


def test_terminal_starts_before_the_gateway_and_is_backgrounded():
    """ttyd must not become the foreground process — the gateway is what the container's
    liveness tracks, so a dying terminal must not take the agent down."""
    code = _code(RUN)
    assert code.index("\nreef_start_terminal\n") < code.index("exec hermes gateway run")
    term = code[code.index("reef_start_terminal()") :]
    assert "reef-term.sh" in term and ") &" in term


def test_image_ships_ttyd_and_the_terminal_shell():
    text = DOCKERFILE.read_text()
    assert "ttyd" in text
    assert "reef-term.sh /usr/local/bin/reef-term.sh" in text
