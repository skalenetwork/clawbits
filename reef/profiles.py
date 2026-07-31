"""The profile seam: WHICH agent type runs. OpenClaw, IronClaw and Hermes
profiles; adding another is a new profile, not a change anywhere else.
"""

from dataclasses import dataclass
from typing import Protocol, runtime_checkable

from reef.providers import KIND_OAUTH, PROVIDERS


def _provider_env(profile_name: str, creds: dict[str, str]) -> dict[str, str]:
    """Provider wiring shared by every profile: inject each supplied provider
    value under its guest env var - but only for providers this runtime's
    images can consume (``Provider.runtimes``, defense-in-depth behind the
    create-time pick validation) - and surface the per-agent model choice as
    ``REEF_DEFAULT_MODEL`` (both entrypoints honor it on fresh boot only, so a
    user's later Control-UI choice is never clobbered).

    OAuth/subscription providers inject no keyed value here (there is no secret -
    the owner authenticates in-VM); a profile turns their marker into
    subscription-mode env itself (see ``OpenClawProfile.build_env``)."""
    env: dict[str, str] = {}
    for p in PROVIDERS:
        if p.kind == KIND_OAUTH:
            continue  # no guest_env to inject; the marker is handled per-profile
        if profile_name in p.runtimes and creds.get(p.cred_key):
            env[p.guest_env] = creds[p.cred_key]
    if creds.get("model"):
        env["REEF_DEFAULT_MODEL"] = creds["model"]
    return env


@dataclass(frozen=True, slots=True)
class AccessInfo:
    """Type-specific "how to reach / use this agent" info for the operator
    dashboard — e.g. the web Control-UI URL + login password.

    ``password`` is intentionally **un-redacted** here: the admin UI is the
    trusted operator surface and this is exactly the info an operator needs.
    The generic ``env`` view stays masked; this is the deliberate, type-scoped
    reveal. ``None`` (from ``access_info``) means the agent isn't exposed.
    """

    kind: str
    url: str | None = None
    password: str | None = None
    terminal_url: str | None = None  # scoped web-terminal URL (shares the password), when exposed


@runtime_checkable
class AgentProfile(Protocol):
    """Describes an agent type: which image, how to turn caller-supplied creds
    into the agent's environment, how to expose its web UI, and how to read back
    its access info.
    """

    name: str
    image: str
    init: str | None  # microsandbox detached boot handoff; None ⇒ runtime default
    volume_dest: str  # where the per-agent volume mounts in the guest
    # Additional per-agent named volumes: (volume-name-suffix, guest dest) pairs.
    # The manager names each off the main volume ("reef-<id>-<suffix>"), so like
    # the workspace volume they are never auto-removed and survive destroy+recreate.
    extra_mounts: tuple[tuple[str, str], ...]
    ui_port: int  # in-guest port the agent's web UI / control plane listens on
    terminal_port: (
        int | None
    )  # in-guest port for the scoped web terminal (ttyd); None ⇒ no terminal
    status_dir: str  # guest dir the agent writes its volunteered status.json to (telemetry)

    def build_env(self, creds: dict[str, str]) -> dict[str, str]:
        """Map opaque caller creds to the agent's runtime env vars."""
        ...

    def exposure_env(self, *, password: str, public_url: str) -> dict[str, str]:
        """Extra env that exposes the agent's web UI — bind beyond loopback, set
        auth, and declare the public origin. Merged over ``build_env``."""
        ...

    def access_info(
        self,
        env: dict[str, str],
        *,
        url: str | None,
        terminal_url: str | None = None,
        secret: str | None = None,
    ) -> AccessInfo | None:
        """Read the agent's access info (URL [+ terminal URL]) from its guest env.
        ``password`` is populated ONLY from the caller-supplied ``secret`` (the
        one-time token minted at creation) and is never read back out of the guest
        env, so the detail view (``secret=None``) yields ``password=None``.
        Returns ``None`` when the agent isn't exposed."""
        ...

    def reveal_secret(self, env: dict[str, str]) -> str | None:
        """Read the access secret BACK OUT of the guest env — the deliberate,
        admin-gated reversal of the one-time-reveal rule ``access_info`` upholds.
        Reef never persists the secret, but the running guest still carries it in
        its env, so an operator who lost the create-time password can recover it
        (see ``FleetService.reveal_access`` / ``POST /fleet/{id}/reveal``, both
        behind ``admin_auth``). Gated exactly like ``access_info``: ``None`` when
        the agent isn't exposed (nothing to reveal)."""
        ...


class OpenClawProfile:
    """The OpenClaw agent (Gateway + clawbits plugin), run headless.

    ``creds`` keys are all **optional**. Three shapes the entrypoint understands:
      • **token-enroll** (``org_id`` + ``signup_token`` [+ ``endpoint``]) — the
        admin-UI "connect to Clawbits" path: the entrypoint seeds the channel and
        auto-runs ``openclaw clawbits signup --signup-token …``, which enrolls the
        agent immediately (no approval step) and persists the minted credentials.
      • **fully-provisioned** (``org_id``/``agent_id``/``api_key``/``channel_id``)
        — clawbits minted the identity server-side; the entrypoint writes the
        account directly, no signup/approval loop.
      • **detached** (none) — the gateway starts with no clawbits channel.
    Optional everywhere: ``endpoint`` (default https://clawbits.ai),
    ``anthropic_api_key``, ``openai_api_key``, ``gateway_token``.

    The image entrypoint bridges any ``CLAWBITS_*`` values into OpenClaw's config
    store (``channels.clawbits.accounts.default.*``) before starting the gateway —
    the plugin reads config, not env. See reef/images/openclaw-runtime/entrypoint.sh
    and docs/REEF.md §7.
    """

    name = "openclaw"
    init = "/usr/local/bin/reef-entrypoint.sh"
    ui_port = 18789  # OpenClaw's gateway serves the Control UI (HTTP + WS) here
    terminal_port = 7681  # ttyd serves the scoped `openclaw` web terminal here (entrypoint.sh)
    # Reef bind-mounts a host dir here; the entrypoint writes status.json (versions,
    # etc.) for Reef to read host-side. Separate from the state dir (no shadowing).
    status_dir = "/home/node/.reef"
    # Mount the per-agent volume at OpenClaw's workspace SUB-path, not over
    # ~/.openclaw — a mount over the state dir would shadow the baked-in plugin
    # (reef/images/openclaw-runtime). NB: the volume must be writable by the
    # image's non-root `node` user for this to persist — see docs/REEF.md §11.2.
    volume_dest = "/home/node/.openclaw/workspace"
    # Auth-profile secrets (OAuth creds etc.) live in XDG config, OUTSIDE the
    # state dir — the official compose mounts it separately as
    # OPENCLAW_AUTH_PROFILE_SECRET_DIR. Give it its own named volume
    # ("reef-<id>-config"): nothing is baked there (no shadowing concern, unlike
    # ~/.openclaw above), and named volumes are never auto-removed, so creds
    # survive a destroy+recreate under the same name. The Dockerfile pre-creates
    # the dir node-owned so docker seeds a writable volume root (msb: §11.2).
    extra_mounts = (("config", "/home/node/.config/openclaw"),)

    def __init__(self, image: str) -> None:
        self.image = image

    def build_env(self, creds: dict[str, str]) -> dict[str, str]:
        env: dict[str, str] = {}
        # clawbits channel — ``org_id`` is the minimum. With org + ``signup_token``
        # the entrypoint seeds the channel + auto-enrolls (token signup, no
        # approval); with the full minted set it writes the account directly. A
        # detached VM passes neither, and the entrypoint starts the gateway
        # without a channel.
        org = creds.get("org_id")
        if org:
            env["CLAWBITS_ENDPOINT"] = creds.get("endpoint", "https://clawbits.ai")
            env["CLAWBITS_ORG_ID"] = org
            # One-time enrollment token (``human-…``). The entrypoint passes it to
            # ``openclaw clawbits signup --signup-token``. Masked in fleet detail
            # by redact_env (key matches /TOKEN/).
            if creds.get("signup_token"):
                env["CLAWBITS_SIGNUP_TOKEN"] = creds["signup_token"]
            agent = creds.get("agent_id")
            api_key = creds.get("api_key")
            channel = creds.get("channel_id")
            if agent and api_key and channel:
                env["CLAWBITS_AGENT_ID"] = agent
                env["CLAWBITS_API_KEY"] = api_key
                env["CLAWBITS_CHANNEL_ID"] = channel
        # Providers: the gateway reads ANTHROPIC_API_KEY / OPENAI_API_KEY /
        # GEMINI_API_KEY / OLLAMA_HOST from the env natively; the entrypoint wires
        # anything that needs config (ollama registration, model pinning). The
        # image entrypoint pins a known-good default model for keyed single-
        # provider cases (overridable via REEF_DEFAULT_MODEL, which a create-time
        # ``model`` choice sets) so the agent doesn't fall back to OpenClaw's
        # volatile built-in default. The owner can still change it in the Control UI.
        env.update(_provider_env(self.name, creds))
        # ChatGPT-subscription (Codex OAuth) agent: no API key is injected. The
        # owner completes `openclaw models auth login --provider openai
        # --device-code` in the scoped web terminal after boot, minting the OAuth
        # token on the persistent auth-profile config volume - reef never handles
        # it. Signal the entrypoint to route the pinned openai model through the
        # Codex harness (not the direct runtime, which is for API-key agents) and
        # open the terminal to the guided `openclaw` shell (whose banner prints
        # the exact login command). The model itself (openai/gpt-5.4) rides as
        # REEF_DEFAULT_MODEL via resolve_model + _provider_env above.
        if creds.get("openai_codex"):
            env["REEF_OPENAI_AUTH"] = "subscription"
            env.setdefault("REEF_TERMINAL_SHELL", "openclaw")
        if creds.get("gateway_token"):
            env["OPENCLAW_GATEWAY_TOKEN"] = creds["gateway_token"]
        return env

    def exposure_env(self, *, password: str, public_url: str) -> dict[str, str]:
        # Flip the gateway to LAN-bound + TOKEN auth so the Control UI auto-auths
        # from a `#token=<token>` URL fragment (OpenClaw's native mechanism — no
        # login prompt; the fragment never reaches the server). The entrypoint writes
        # gateway.controlUi.allowedOrigins from OPENCLAW_PUBLIC_URL. The SAME secret
        # is the scoped terminal's (ttyd) basic-auth password, so ONE secret unlocks
        # both surfaces. (``password`` is that shared secret — named for the access field.)
        return {
            "OPENCLAW_GATEWAY_BIND": "lan",
            "OPENCLAW_GATEWAY_AUTH": "token",
            "OPENCLAW_GATEWAY_TOKEN": password,
            "OPENCLAW_PUBLIC_URL": public_url,
            "REEF_TERMINAL_ENABLE": "1",
            "REEF_TERMINAL_PASSWORD": password,
            "REEF_TERMINAL_PORT": str(self.terminal_port),
        }

    def access_info(
        self,
        env: dict[str, str],
        *,
        url: str | None = None,
        terminal_url: str | None = None,
        secret: str | None = None,
    ) -> AccessInfo | None:
        # Reachable only when exposed beyond loopback (bind=lan). The single access
        # secret is the gateway TOKEN (Control UI `#token=`), which doubles as the
        # terminal's basic-auth password. It is a ONE-TIME reveal at creation
        # (``manager.expose``): ``password`` is populated ONLY when the caller
        # passes ``secret`` (it never reads the token back out of the guest env),
        # so the detail view — which passes ``secret=None`` — yields password=None.
        # The terminal URL is minted by the exposure strategy (not in the guest env).
        if env.get("OPENCLAW_GATEWAY_BIND") != "lan":
            return None
        return AccessInfo(
            kind="openclaw",
            url=url or env.get("OPENCLAW_PUBLIC_URL"),
            password=secret,
            terminal_url=terminal_url,
        )

    def reveal_secret(self, env: dict[str, str]) -> str | None:
        # The gateway TOKEN (== the terminal's basic-auth password) read back from
        # the guest env. Gated on the exposed bind, same as access_info.
        if env.get("OPENCLAW_GATEWAY_BIND") != "lan":
            return None
        return env.get("OPENCLAW_GATEWAY_TOKEN") or None


class IronClawProfile:
    """The IronClaw agent (Rust: web gateway + a baked clawbits WASM channel), run
    headless.

    ``creds`` keys are all **optional**. Two shapes are wired end-to-end today,
    plus a planned third:
      • **fully-provisioned** (``org_id``/``agent_id``/``api_key``/``channel_id``)
        — the recommended path (Reef server-mints the identity, REEF.md §9): the
        entrypoint wires the key + channel id into the channel and activates it.
      • **detached** (none) — IronClaw boots with the clawbits channel inactive.
      • **token-enroll** (``org_id`` + ``signup_token``) — *planned*. IronClaw has
        no native signup command and enrollment is a challenge-based exchange, so
        this image currently boots detached and logs a pointer to the
        fully-provisioned path. ``build_env`` already forwards the token so the
        entrypoint seam is ready.
    Optional everywhere: ``endpoint`` (default https://clawbits.ai),
    ``anthropic_api_key``, ``openai_api_key``, ``gateway_token``,
    ``secrets_master_key``.

    Unlike OpenClaw (whose clawbits integration is a *plugin*), IronClaw's is a
    baked **WASM channel** (``ironclaw-channel/``): the image ships
    ``clawbits.wasm`` + ``clawbits.capabilities.json`` under
    ``~/.ironclaw/channels/`` and the entrypoint *activates* it (the DB
    ``activated_channels`` set) and bridges the injected ``CLAWBITS_*`` into
    ``~/.ironclaw/.env`` (the channel's key falls back to that env var) + the
    channel's capabilities ``config``. See reef/images/ironclaw-runtime/entrypoint.sh
    and docs/REEF.md.

    Headless boot: IronClaw's secret store normally takes its master key from the
    OS keychain, which a microVM lacks; it reads ``SECRETS_MASTER_KEY`` from the
    env first (documented "for CI/Docker"), so the entrypoint ensures one exists
    (generated + persisted to the workspace volume when Reef doesn't inject it).
    """

    name = "ironclaw"
    init = "/usr/local/bin/reef-entrypoint.sh"
    ui_port = 3000  # IronClaw's web gateway serves the Control UI here (Dockerfile EXPOSE 3000)
    terminal_port = 7681  # ttyd serves the scoped `ironclaw` web terminal here (entrypoint.sh)
    # Reef bind-mounts a host dir here; the entrypoint writes status.json for Reef
    # to read host-side. Separate from the state dir (no shadowing).
    status_dir = "/home/ironclaw/.reef"
    # Mount the per-agent volume at IronClaw's workspace SUB-path, not over
    # ~/.ironclaw — a mount over the state dir would shadow the baked-in clawbits
    # channel + config (same reasoning as OpenClawProfile). NB: the volume must be
    # writable by the image's non-root `ironclaw` user for this to persist.
    volume_dest = "/home/ironclaw/.ironclaw/workspace"
    # IronClaw keeps its DB, .env, and channels under ~/.ironclaw (baked); no
    # extra XDG secret dir like OpenClaw's auth-profile volume.
    extra_mounts: tuple[tuple[str, str], ...] = ()

    def __init__(self, image: str) -> None:
        self.image = image

    def build_env(self, creds: dict[str, str]) -> dict[str, str]:
        env: dict[str, str] = {}
        # clawbits channel — ``org_id`` is the minimum. With org + ``signup_token``
        # the entrypoint enrolls (token signup); with the full minted set it writes
        # the account directly. A detached VM passes neither.
        org = creds.get("org_id")
        if org:
            env["CLAWBITS_ENDPOINT"] = creds.get("endpoint", "https://clawbits.ai")
            env["CLAWBITS_ORG_ID"] = org
            if creds.get("signup_token"):
                env["CLAWBITS_SIGNUP_TOKEN"] = creds["signup_token"]
            agent = creds.get("agent_id")
            api_key = creds.get("api_key")
            channel = creds.get("channel_id")
            if agent and api_key and channel:
                env["CLAWBITS_AGENT_ID"] = agent
                env["CLAWBITS_API_KEY"] = api_key
                env["CLAWBITS_CHANNEL_ID"] = channel
        # Provider: IronClaw reads these keys from the env natively and selects
        # the backend from LLM_BACKEND. Inject whatever was supplied (gated on
        # this runtime's ``Provider.runtimes`` support) and pin the matching
        # backend, in registry preference order (Anthropic wins when several are
        # present). IronClaw reads the ollama endpoint as OLLAMA_BASE_URL (it
        # never reads OLLAMA_HOST — verified vs nearai/ironclaw@06f9f0fc), so
        # mirror the canonical cred under IronClaw's spelling.
        env.update(_provider_env(self.name, creds))
        if env.get("OLLAMA_HOST"):
            env["OLLAMA_BASE_URL"] = env["OLLAMA_HOST"]
        if env.get("ANTHROPIC_API_KEY"):
            env["LLM_BACKEND"] = "anthropic"
        elif env.get("OPENAI_API_KEY"):
            env["LLM_BACKEND"] = "openai"
        elif env.get("GEMINI_API_KEY"):
            env["LLM_BACKEND"] = "gemini"
        elif env.get("NEARAI_API_KEY"):
            env["LLM_BACKEND"] = "nearai"
        elif env.get("OLLAMA_BASE_URL"):
            env["LLM_BACKEND"] = "ollama"
        # Stable secret-store master key for headless boot (no keychain in a
        # microVM). Optional — the entrypoint generates + persists one when absent.
        if creds.get("secrets_master_key"):
            env["SECRETS_MASTER_KEY"] = creds["secrets_master_key"]
        if creds.get("gateway_token"):
            env["GATEWAY_AUTH_TOKEN"] = creds["gateway_token"]
        return env

    def exposure_env(self, *, password: str, public_url: str) -> dict[str, str]:
        # Bind the web gateway beyond loopback with bearer-token auth, and enable
        # the scoped ttyd terminal on the SAME secret (mirrors OpenClaw — one
        # secret unlocks both surfaces). IronClaw's gateway reads GATEWAY_* from
        # the env; the entrypoint declares the public origin from IRONCLAW_PUBLIC_URL.
        return {
            "GATEWAY_ENABLED": "true",
            "GATEWAY_HOST": "0.0.0.0",
            "GATEWAY_PORT": str(self.ui_port),
            "GATEWAY_AUTH_TOKEN": password,
            "IRONCLAW_PUBLIC_URL": public_url,
            "REEF_TERMINAL_ENABLE": "1",
            "REEF_TERMINAL_PASSWORD": password,
            "REEF_TERMINAL_PORT": str(self.terminal_port),
        }

    def access_info(
        self,
        env: dict[str, str],
        *,
        url: str | None = None,
        terminal_url: str | None = None,
        secret: str | None = None,
    ) -> AccessInfo | None:
        # Reachable only when exposed beyond loopback (GATEWAY_ENABLED=true). The
        # single access secret is the gateway auth token, which doubles as the
        # terminal's basic-auth password. One-time reveal at creation: ``password``
        # is populated ONLY from the caller-supplied ``secret`` (never read back
        # out of the guest env), so the detail view (``secret=None``) yields
        # ``password=None``.
        if env.get("GATEWAY_ENABLED") != "true":
            return None
        return AccessInfo(
            kind="ironclaw",
            url=url or env.get("IRONCLAW_PUBLIC_URL"),
            password=secret,
            terminal_url=terminal_url,
        )

    def reveal_secret(self, env: dict[str, str]) -> str | None:
        # The gateway auth token (== the terminal's basic-auth password) read back
        # from the guest env. Gated on the exposed bind, same as access_info.
        if env.get("GATEWAY_ENABLED") != "true":
            return None
        return env.get("GATEWAY_AUTH_TOKEN") or None


class HermesProfile:
    """The Hermes agent (gateway + bundled Clawbits platform plugin).

    The image is expected to be the Reef Hermes runtime image
    (``reef/images/hermes-runtime``): it extends the upstream ``hermes-agent``
    image, bakes in ``extensions/hermes`` as ``clawbits-platform``, starts the
    Hermes dashboard for configuration, and runs ``hermes gateway run`` in the
    foreground. Clawbits wiring mirrors ``OpenClawProfile`` but uses the Hermes
    plugin's env names: ``CLAWBITS_BASE_URL``, ``CLAWBITS_API_KEY``,
    ``CLAWBITS_AGENT_ID`` and optional ``CLAWBITS_CHANNEL_ID``.

    **Dashboard auth.** The Hermes dashboard binds LOOPBACK inside the guest and an
    nginx reverse proxy in front of it (bound on ``ui_port``) enforces HTTP basic
    auth with reef's one-time exposure password — the same shape OpenClaw already
    uses for its ttyd terminal. This is deliberate, not incidental: hermes'
    ``--insecure`` flag is not merely a bind guard, it is the switch that DISABLES
    the dashboard's OAuth auth gate (``web_server.should_require_auth``: non-loopback
    + ``--insecure`` ⇒ no auth), and in that mode the dashboard's session token is
    injected into the SPA HTML, so anyone who can GET ``/`` can read it and call
    ``/api/reveal`` for the agent's API keys. Binding loopback keeps that whole
    surface unreachable and puts a password in front of it instead.
    """

    name = "hermes"
    # The microsandbox boot handoff. MUST be set: msb ignores the image's
    # ENTRYPOINT/CMD and starts only what `--init` names, so a None here boots the
    # microVM and runs NOTHING — no dashboard listener, empty kernel.log, and hence
    # no logs in reef. Unlike OpenClaw/IronClaw (whose ENTRYPOINT *is* their init),
    # the Hermes base image boots through s6-overlay, so this points at a shim that
    # replays that chain in one executable. See reef/images/hermes-runtime/
    # reef-hermes-init.sh for why /init has to stay PID 1.
    init = "/usr/local/bin/reef-hermes-init"
    ui_port = 9119  # what reef forwards: the nginx basic-auth proxy, NOT the dashboard
    # The dashboard itself listens here, on 127.0.0.1 only — never forwarded, so the
    # only way in is through the authenticating proxy on ``ui_port``.
    dashboard_port = 9118
    # The scoped ttyd web terminal, sharing the dashboard's one-time password. It is
    # not a convenience: the ChatGPT-subscription provider (openai-codex) is OAuth, so
    # there is NO key for reef to inject — the owner has to finish a device-code login
    # inside the guest (`hermes login --provider openai-codex --no-browser`), and this
    # is the only place they can. (The dashboard's chat tab drives the AGENT over
    # /api/pty, not a shell, so it can't run the command.)
    terminal_port = 7681
    exposure_password = True  # the proxy's basic-auth secret (reef mints it)
    status_dir = "/opt/data/.reef"
    volume_dest = "/opt/data"
    # Basic-auth user for the dashboard proxy. The password is the reef secret.
    dashboard_user = "reef"

    def __init__(self, image: str) -> None:
        self.image = image

    def build_env(self, creds: dict[str, str]) -> dict[str, str]:
        # GATEWAY_ALLOW_ALL_USERS: hermes' gateway denies unknown senders by default
        # and falls back to a DM-pairing flow — the agent replies "ask the bot owner to
        # run `hermes pairing approve clawbits <code>`" and goes no further. That is
        # unreachable for a reef agent (nobody has a shell in the microVM) and, more to
        # the point, redundant: CLAWBITS is the authorization boundary. A message only
        # reaches the gateway if clawbits already authorized it — org membership plus
        # the contact-permission system (closed by default; DM/tag are explicit grants
        # the server enforces). Hermes' per-platform allowlists
        # (TELEGRAM_ALLOWED_USERS, …) are keyed off a hard-coded Platform enum, so a
        # PLUGIN platform like clawbits has no per-platform hook at all — the global
        # flag is the only lever. Scope note: it is global, so if an operator later
        # enables a second platform on this agent (Telegram, …) that one would be open
        # too. Reef agents are single-purpose clawbits agents, so that is acceptable
        # here; anyone adding another platform should set its own allowlist.
        env: dict[str, str] = {
            "HERMES_ACCEPT_HOOKS": "1",
            "GATEWAY_ALLOW_ALL_USERS": "true",
        }
        endpoint = creds.get("endpoint", "https://clawbits.ai")
        org = creds.get("org_id")
        signup_token = creds.get("signup_token")
        agent = creds.get("agent_id")
        api_key = creds.get("api_key")
        channel = creds.get("channel_id")
        if org or signup_token or (agent and api_key):
            env["CLAWBITS_BASE_URL"] = endpoint
        if org:
            env["CLAWBITS_ORG_ID"] = org
        if signup_token:
            env["CLAWBITS_SIGNUP_TOKEN"] = signup_token
        if agent and api_key:
            env["CLAWBITS_AGENT_ID"] = agent
            env["CLAWBITS_API_KEY"] = api_key
            if channel:
                env["CLAWBITS_CHANNEL_ID"] = channel
        # The same provider wiring every other profile uses: inject each supplied key
        # under its guest env var (filtered by ``Provider.runtimes`` — hermes is listed
        # on openai + anthropic only, the two its image can consume) AND surface the
        # operator's model pick as ``REEF_DEFAULT_MODEL``. The hand-rolled version this
        # replaces silently dropped the model, which mattered: hermes' stock config is
        # `provider: auto` + `base_url: https://openrouter.ai/api/v1`, and `auto` maps
        # an OPENAI_API_KEY to *openrouter* (auth.resolve_provider rule 3), so an agent
        # created with an OpenAI key called openrouter.ai with no OPENROUTER_API_KEY and
        # died on `401 Missing Authentication header`. The entrypoint now pins the
        # provider/base_url/model to match the key (see reef_configure_model).
        env.update(_provider_env(self.name, creds))
        # ChatGPT subscription (openai-codex) is an OAuth provider: reef holds no
        # token and injects no key (``_provider_env`` skips KIND_OAUTH). All we can do
        # is mark the mode — the entrypoint pins hermes' provider to `openai-codex`,
        # and the owner completes the device-code login in the web terminal. The model
        # rides as REEF_DEFAULT_MODEL like every other provider.
        if creds.get("openai_codex"):
            env["REEF_OPENAI_AUTH"] = "subscription"
        return env

    def exposure_env(self, *, password: str, public_url: str) -> dict[str, str]:
        # HERMES_DASHBOARD_HOST is 127.0.0.1 on purpose. A non-loopback bind would
        # force `--insecure` (the entrypoint adds it), and that flag turns the
        # dashboard's auth gate OFF and injects its session token into the SPA HTML —
        # i.e. anyone who reaches the port gets the agent's API keys. Instead the
        # dashboard stays loopback-only and REEF_HERMES_PROXY_PORT (= ui_port, the
        # forwarded one) is served by an nginx basic-auth proxy in the guest.
        return {
            "REEF_HERMES_DASHBOARD": "1",
            "HERMES_DASHBOARD_HOST": "127.0.0.1",
            "HERMES_DASHBOARD_PORT": str(self.dashboard_port),
            "HERMES_DASHBOARD_TUI": "1",
            "REEF_HERMES_PROXY_PORT": str(self.ui_port),
            "REEF_HERMES_DASHBOARD_USER": self.dashboard_user,
            "REEF_HERMES_DASHBOARD_PASSWORD": password,
            "REEF_HERMES_PUBLIC_URL": public_url,
            # The scoped web terminal (ttyd), guarded by the SAME one-time secret —
            # one password unlocks both surfaces, exactly as OpenClaw does.
            "REEF_TERMINAL_ENABLE": "1",
            "REEF_TERMINAL_PASSWORD": password,
            "REEF_TERMINAL_PORT": str(self.terminal_port),
        }

    def access_info(
        self,
        env: dict[str, str],
        *,
        url: str | None = None,
        terminal_url: str | None = None,
        secret: str | None = None,
    ) -> AccessInfo | None:
        enabled = env.get("REEF_HERMES_DASHBOARD") or env.get("HERMES_DASHBOARD") or ""
        if enabled.lower() not in {"1", "true", "yes"}:
            return None
        # The dashboard proxy's basic-auth secret is a ONE-TIME reveal at creation,
        # exactly like OpenClaw's gateway token: populate ``password`` ONLY from the
        # caller-supplied ``secret``. Deliberately NOT read back out of the guest env
        # (REEF_HERMES_DASHBOARD_PASSWORD) — the detail view passes secret=None and
        # must yield None, or every GET /fleet/{id} would hand out the password.
        return AccessInfo(
            kind="hermes",
            url=url or env.get("REEF_HERMES_PUBLIC_URL"),
            password=secret,
            terminal_url=terminal_url,
        )

    def reveal_secret(self, env: dict[str, str]) -> str | None:
        # The dashboard proxy's basic-auth password (== the terminal's) read back
        # from the guest env — the deliberate reversal access_info refuses. Gated
        # on the dashboard being enabled, mirroring access_info's own check.
        enabled = env.get("REEF_HERMES_DASHBOARD") or env.get("HERMES_DASHBOARD") or ""
        if enabled.lower() not in {"1", "true", "yes"}:
            return None
        return env.get("REEF_HERMES_DASHBOARD_PASSWORD") or None
