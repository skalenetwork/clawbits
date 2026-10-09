# Hermes on Reef: implementation plan

Companion to the design brief (Hermes Agent v2026.9.14 / v0.21.3 role in
`clawbits-reef-store`). This maps every point of the brief onto the code as it
is at `d74aa97`, with the sketches taken to near-final shape. Sections follow
the brief's numbering.

## 0. What the code changed about the brief

Read these first; each one moves a sketch.

1. **Plugin CLI on a deferred bundled platform works only by name match.**
   `hermes_cli/main.py` resolves the deferred platform whose *platform name*
   equals the first positional token (`_resolve_deferred_platform_cli_command`
   -> `platform_registry.get("clawbits")`), which imports the module and runs
   `register()`. So `hermes clawbits signup` works from a bundled deferred
   platform as long as the CLI command name stays `clawbits` == platform name.
   Same path gives the build assertion (section 2).
2. **`hermes <unknown> --help` exits 0 even when the plugin failed**: an
   unknown first token is also a chat prompt, and `--help` then prints the
   main help. The assertion must grep the subparser's own flag.
3. **HTTP status from the agent CLI**: `clawbits_agent_cli.py` prints
   `HTTP <code>: <body>` to stderr and raises `SystemExit(code)`; the child's
   exit code wraps mod 256 (401 -> 145). `_run_agent_cli` wraps stderr into a
   `RuntimeError`. Parse the `HTTP NNN:` prefix, which `adapter.py` already
   does for 404 and 422.
4. **`agent-info` already exists** in the agent CLI
   (`GET /api/agentic/agents/{id}/info`). The probe is one call.
5. **`.claude/launch.json` does not exist.** Backend for the local loop:
   `uv run uvicorn clawbits.fastapi.main:app --port 8000 --reload` (README).
6. **`CLAWBITS_BASE_URL` is also the backend's own setting** (`parse_role`
   compares against it; `docs/AUTH.md`, `cli/README.md`, `web/`). The rename
   touches only `extensions/hermes/**` and `frontend/src/lib/agentPrompts.ts`.
7. **`_env_enablement` lifting confirmed** (`gateway/config.py`): only
   `home_channel` is popped, everything else is `extra.update(seed)`. The flat
   seed must not carry `enabled` or `extra` keys.
8. **`on_processing_start/complete` run inside `_process_message_background`**,
   the same task as the turn, so a ContextVar set in `on_processing_start` is
   visible to the turn's `send_message`/`edit_message`. `_spawn_turn`,
   `_run_turn` and `_turn_tasks` go away (call sites `adapter.py:1058`,
   `:1511`, `:1748`; cancel loop `:347-351`).
9. **Local `hermes-agent/` checkout is v0.20.0 (Aug)**, older than the target:
   no `rearm_oneshot`, no `plugins_manifest.py`. Read
   `U:cron/jobs.py` L2208 for the exact `rearm_oneshot` signature before
   writing section 3.
10. **`ReefRoleResponse` already returns `image`**; the frontend type is the
    only backend-facing change.
11. **`images/openclaw/Dockerfile` starts with `# check=skip=InvalidDefaultArgInFrom`**;
    the Hermes Dockerfile needs the same line or `--check` fails on `ARG BASE`.
12. **cont-init order holds**: `01-hermes-setup` < `015-supervise-perms` <
    `019-clawbits` < `02-reconcile-profiles` (byte order: `-` < `5` < `9`, `1` < `2`).
13. **TLS under msb**: reef docs say a secret turns interception on for port
    443 across the whole VM, so `SSL_CERT_FILE=/.msb/tls/ca.pem` is what makes
    Python's urllib trust *every* HTTPS host, `app.clawbits.ai` included. No
    role env, but step 3 of verification must prove urllib reaches the backend.
14. **Tracked plugin files** (what `git archive HEAD:extensions/hermes` bakes):
    17 files incl. `known_answers.json`, `reinstall.sh`, two READMEs. Nothing
    untracked (`__pycache__` is not in git).

## 1. Image builder (`images/src/main.rs`)

One file. Output for `openclaw` must stay byte-identical (tag, build args,
base). Data first:

```rust
struct Recipe {
    name: &'static str,
    repo: &'static str,
    prefix: &'static str,
    engine: Engine,
    plugin: Plugin,
}

enum Engine {
    Npm { package: &'static str, image: &'static str, suffix: &'static str },
    Release { github: &'static str, image: &'static str },
}

enum Plugin {
    ClawHub(&'static str),
    Tree(&'static str),
}

const RECIPES: &[Recipe] = &[
    Recipe {
        name: "openclaw",
        repo: "ghcr.io/skalenetwork/clawbits-openclaw",
        prefix: "oc",
        engine: Engine::Npm { package: "openclaw", image: "ghcr.io/openclaw/openclaw", suffix: "-browser" },
        plugin: Plugin::ClawHub("clawbits-openclaw-plugin"),
    },
    Recipe {
        name: "hermes",
        repo: "ghcr.io/skalenetwork/clawbits-hermes",
        prefix: "hm",
        engine: Engine::Release { github: "NousResearch/hermes-agent", image: "docker.io/nousresearch/hermes-agent" },
        plugin: Plugin::Tree("extensions/hermes"),
    },
];

struct Plan {
    dir: PathBuf,
    repo: &'static str,
    image: String,
    version: String,
    base: String,
    engine: String,
    plugin: String,
    stage: Option<&'static str>,
}
```

Engine:

```rust
impl Engine {
    fn image(&self) -> &'static str {
        match self {
            Self::Npm { image, .. } | Self::Release { image, .. } => image,
        }
    }

    fn latest(&self) -> Result<String> {
        match self {
            Self::Npm { package, .. } => npm_latest(package),
            Self::Release { github, .. } => github_latest(github),
        }
    }

    fn tag(&self, version: &str) -> String {
        match self {
            Self::Npm { suffix, .. } => format!("{version}{suffix}"),
            Self::Release { .. } => format!("v{version}"),
        }
    }
}

fn github_latest(repo: &str) -> Result<String> {
    #[derive(Deserialize)]
    struct Release {
        tag_name: String,
    }
    let release: Release = get(&format!("https://api.github.com/repos/{repo}/releases/latest"))?;
    Ok(release.tag_name.trim_start_matches('v').to_owned())
}
```

`resolve()` then reads `let base = format!("{}:{}", recipe.engine.image(), recipe.engine.tag(&engine));`
and calls `published(recipe.engine.image(), &tag)`; the error text becomes
`"{base} is not published; pass --engine <version>"`.

Registry check replacing `ghcr_has`, keyed on the image host:

```rust
fn published(image: &str, tag: &str) -> Result<bool> {
    #[derive(Deserialize)]
    struct Token {
        token: String,
    }
    let (host, repo) = image.split_once('/').context("image has no registry host")?;
    let (token, manifest) = match host {
        "ghcr.io" => (
            format!("https://ghcr.io/token?scope=repository:{repo}:pull&service=ghcr.io"),
            format!("https://ghcr.io/v2/{repo}/manifests/{tag}"),
        ),
        "docker.io" => (
            format!("https://auth.docker.io/token?service=registry.docker.io&scope=repository:{repo}:pull"),
            format!("https://registry-1.docker.io/v2/{repo}/manifests/{tag}"),
        ),
        other => bail!("no registry rule for {other}"),
    };
    let auth: Token = get(&token)?;
    match ureq::head(&manifest)
        .header("Authorization", format!("Bearer {}", auth.token))
        .header("Accept", MANIFEST_ACCEPT)
        .call()
    {
        Ok(_) => Ok(true),
        Err(ureq::Error::StatusCode(404)) => Ok(false),
        Err(error) => Err(error).context("registry manifest"),
    }
}
```

Plugin: version and staging in one place. `--plugin` on a `Tree` recipe is
an error; `--local` already conflicts with `--plugin` in clap.

```rust
impl Plugin {
    fn version(&self, cli: &Cli) -> Result<String> {
        match (self, cli.local, cli.plugin.as_deref()) {
            (_, true, _) => Ok("local".to_owned()),
            (Self::ClawHub(package), false, None) => clawhub_latest(package),
            (Self::ClawHub(_), false, Some(version)) => Ok(version.to_owned()),
            (Self::Tree(dir), false, None) => tree_version(dir),
            (Self::Tree(_), false, Some(_)) => bail!("--plugin does not apply to an in-tree plugin"),
        }
    }

    fn stage(&self, local: bool) -> Option<&'static str> {
        match self {
            Self::ClawHub(_) => Some(if local { "local" } else { "clawhub" }),
            Self::Tree(_) => None,
        }
    }

    fn prepare(&self, dir: &Path, local: bool) -> Result<()> {
        let staged = dir.join(STAGED);
        fs::remove_dir_all(&staged).ok();
        match (self, local) {
            (Self::ClawHub(_), false) => Ok(()),
            (Self::ClawHub(_), true) => stage_clawhub(dir),
            (Self::Tree(tree), true) => copy_tree(&Path::new(IMAGES).join("..").join(tree), &staged),
            (Self::Tree(tree), false) => archive(tree, &staged),
        }
    }
}
```

- `stage_clawhub` is today's `stage_plugin` unchanged (the bun build).
- `tree_version(dir)`: read `<repo>/<dir>/plugin.yaml`, first line starting
  with `version:`, value with quotes trimmed. Same regex idea as
  `version_check.py::_version_from_plugin_yaml`; no YAML dependency.
- `archive(tree, staged)`: `git archive --format=tar -o <dir>/.plugin.tar HEAD:<tree>`
  (root-relative tree-ish, cwd-independent), then `tar -xf .plugin.tar -C .plugin`,
  remove the tar. Two `run()` calls, no piping code.
- `copy_tree`: recursive copy of the working tree dir, skipping `__pycache__`.
  ~12 lines with `fs::read_dir`; no crate.
- `Plan.stage` is `Option`: `build()` pushes `PLUGIN_STAGE` only when `Some`,
  so the Hermes build gets no unconsumed-arg warning.
- `main()` calls `recipe.plugin.prepare(&plan.dir, cli.local)?` before `build`
  (today only `--local` staged); cleanup after build stays.
- Tag: `format!("{prefix}{engine}-pl{plugin}-g{sha}")`, local
  `{prefix}{engine}-local`. Hermes: `hm2026.9.14-pl0.9.0-g<sha>`.

Docs and CI:

- `images/README.md` "Adding an image": a row in `RECIPES` naming the engine
  source (npm tag or GitHub release), the plugin source (ClawHub or a
  directory of this tree) and the tag prefix; a Dockerfile under `<name>/`
  taking `BASE`, `ENGINE_VERSION`, `PLUGIN_VERSION`, `IMAGE_VERSION`, plus
  `PLUGIN_STAGE` for ClawHub plugins. A tree plugin arrives in `.plugin/`
  from `git archive HEAD`, or the working tree with `--local`. Also fix the
  usage block: `cargo run --release -- hermes`.
- `.github/workflows/images.yaml`, last step:

  ```yaml
      - name: Dockerfiles
        working-directory: images
        run: |
          set -euo pipefail
          for f in */Dockerfile; do
            docker buildx build --check --build-arg BASE=alpine "${f%/Dockerfile}"
          done
  ```

- `.github/workflows/images-publish.yaml`: input
  `image: { description: Image, type: choice, options: [openclaw, hermes], default: openclaw }`;
  `plugin` description becomes `Clawbits plugin version, OpenClaw only (blank = latest published)`;
  the build step gets `IMAGE: ${{ inputs.image }}` in `env` and runs
  `cargo run --release -- "$IMAGE" "${args[@]}"`. Header comment: the
  Hermes plugin stage is a copy, so the native-runner argument is the
  OpenClaw one; nothing else changes. The `merge` job is image-agnostic.

## 2. Hermes recipe (`images/hermes/`)

`Dockerfile`:

```dockerfile
# check=skip=InvalidDefaultArgInFrom
ARG BASE
FROM ${BASE}
COPY --chmod=a+rX,go-w .plugin/ /opt/hermes/plugins/platforms/clawbits/
COPY --chmod=0755 clawbits /etc/cont-init.d/019-clawbits
COPY --chmod=0644 config.yaml /etc/hermes/config.yaml
RUN hermes clawbits signup --help | grep -q -- --signup-token

ARG ENGINE_VERSION
ARG PLUGIN_VERSION
ARG IMAGE_VERSION
LABEL org.opencontainers.image.version="${IMAGE_VERSION}" \
      org.clawbits.hermes.version="${ENGINE_VERSION}" \
      org.clawbits.plugin.version="${PLUGIN_VERSION}"
```

- The assertion is the boot path itself: `hermes` (the root-dropping shim,
  first on PATH) -> deferred resolution of platform `clawbits` -> import of
  the whole package -> `register()` -> the `signup` subparser prints its
  flags. An import error or a missing dependency leaves `--signup-token`
  absent and the grep fails the build. `hermes plugins list --json` proves
  only that the manifest parsed; a registry check would import private
  module paths that moved in this release.
- Upstream `ENTRYPOINT` kept. Nothing written under `/opt/data`.

`clawbits`:

```sh
#!/command/with-contenv sh
[ -n "${CLAWBITS_SIGNUP_TOKEN:-}" ] || exit 0
hermes clawbits signup --signup-token "$CLAWBITS_SIGNUP_TOKEN" || true
```

`config.yaml`:

```yaml
streaming:
  enabled: true
display:
  platforms:
    clawbits:
      tool_progress: "off"
```

`show_reasoning` stays out until step 2 of verification shows the activity
lane does not already carry reasoning.

## 3. Connector (`extensions/hermes/`)

### cli_client.py

- Add, once, the endpoint default:

  ```python
  DEFAULT_ENDPOINT = "https://app.clawbits.ai"

  def endpoint() -> str:
      return os.getenv("CLAWBITS_ENDPOINT", DEFAULT_ENDPOINT).rstrip("/")
  ```

- `_default_cli_path()` returns the bundled path only:
  `str(Path(__file__).resolve().parent / "agent-cli" / "clawbits_agent_cli.py")`.
  The `CLAWBITS_AGENT_CLI` override and the cwd fallback go.
- `_run_agent_cli`: `plugin_version or PLUGIN_VERSION`; the env read goes.
- Add the status helper the probe needs:

  ```python
  def http_status(error: Exception) -> int | None:
      found = re.search(r"^HTTP (\d{3}):", str(error), re.MULTILINE)
      return int(found.group(1)) if found else None
  ```

### signup.py (idempotent, identity-only)

```python
IDENTITY = ("CLAWBITS_API_KEY", "CLAWBITS_AGENT_ID", "CLAWBITS_CHANNEL_ID")


def _env_path() -> Path:
    from hermes_constants import get_hermes_home

    return Path(get_hermes_home()) / ".env"


def _stored_identity() -> tuple[str, str] | None:
    values = dotenv_values(_env_path())
    api_key, agent_id = values.get("CLAWBITS_API_KEY"), values.get("CLAWBITS_AGENT_ID")
    return (api_key, agent_id) if api_key and agent_id else None


def _save_identity(values: dict[str, str]) -> Path:
    path = _env_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    kept = [
        line
        for line in (path.read_text(encoding="utf-8").splitlines() if path.exists() else [])
        if line.partition("=")[0] not in IDENTITY
    ]
    kept.extend(f"{key}={value}" for key, value in values.items())
    path.write_text("\n".join(kept) + "\n", encoding="utf-8")
    return path


def _known(cli_path: str, endpoint: str, api_key: str, agent_id: str) -> bool:
    try:
        _run_agent_cli(cli_path, endpoint, "agent-info", agent_id, api_key=api_key)
    except Exception as exc:
        return http_status(exc) not in (401, 403)
    return True
```

- `dotenv_values` comes from `python-dotenv`, a pinned Hermes dependency
  (`hermes_cli/env_loader.py` imports it).
- `_cli_command` flow: `endpoint = (args.endpoint or endpoint()).rstrip("/")`;
  if `_stored_identity()` and `_known(...)`: print
  `Clawbits identity for {agent_id} is current.` and return 0. A timeout
  (`subprocess.TimeoutExpired`), outage, 426 or 5xx all count as known. Only
  401/403 falls through: `_save_identity({})`, then the existing
  `signup-commit` -> `mm-operator-channel` -> `_mint_initial_tokens` path,
  ending in `_save_identity({"CLAWBITS_API_KEY": ..., "CLAWBITS_AGENT_ID": ..., ["CLAWBITS_CHANNEL_ID": ...]})`.
  `CLAWBITS_BASE_URL`, `CLAWBITS_AGENT_CLI`, `CLAWBITS_PLUGIN_VERSION` are
  never written again; `os.environ.update` goes with them (nothing in the
  same process reads the result).
- `_setup_cli`: `--endpoint` optional (default `None`, resolved as above),
  `--signup-token` required, `--org-id` and `--agent-cli` removed.
- `_save_hermes_env` is renamed to `_save_identity` in `__all__` and in
  `__init__`'s re-export list.

### adapter.py

- `DEFAULT_BASE_URL` deleted; `self.base_url = str(extra.get("base_url") or endpoint())`.
- `_ClawbitsCli(..., PLUGIN_VERSION, ...)`; the `extra`/env plugin-version
  reads go.
- `_ws_header_kwarg` and its docstring go; the connect call passes
  `additional_headers=auth_headers`.
- Authorization:

  ```python
  @property
  def authorization_is_upstream(self) -> bool:
      return True
  ```

- Turn lifecycle. Delete `_spawn_turn`, `_run_turn`, `_turn_tasks` (the
  field, the cancel loop in `disconnect`, three call sites become
  `await self.handle_message(event)`; `_maybe_dispatch` keeps its ordering
  because `handle_message` now returns after enqueueing). Add
  `self._heartbeats: dict[str, asyncio.Task[None]] = {}` and:

  ```python
  async def on_processing_start(self, event: MessageEvent) -> None:
      _turn_streams.set(set())
      chat_id = event.source.chat_id
      self._heartbeats[event.message_id] = asyncio.create_task(self._generating_heartbeat(chat_id))
      await self._set_status_best_effort(chat_id, "generating")

  async def on_processing_complete(self, event: MessageEvent, outcome: ProcessingOutcome) -> None:
      chat_id = event.source.chat_id
      heartbeat = self._heartbeats.pop(event.message_id, None)
      if heartbeat is not None:
          heartbeat.cancel()
          with contextlib.suppress(asyncio.CancelledError):
              await heartbeat
      for message_id in list(_turn_streams.get() or ()):
          if message_id in self._open_streams:
              await self._close_stream_best_effort(
                  self._open_streams[message_id], message_id, "_(reply failed to generate)_"
              )
      settled = _post_sequence(event.raw_message) if isinstance(event.raw_message, dict) else 0
      if outcome is ProcessingOutcome.SUCCESS and settled > 0:
          await self._ack_read(chat_id, settled)
      await self._set_status_best_effort(chat_id, "online")
  ```

  `ProcessingOutcome` joins the `gateway.platforms.base` import. The ack moves
  from dispatch time to a settled turn; failure and cancellation leave the
  pointer, so the post re-delivers on the next boot, which is the brief's
  rule. The dispatch-time comment block above `_run_turn` goes with it.

### `__init__.py`

```python
def _env_enablement() -> dict[str, Any] | None:
    api_key, agent_id = os.getenv("CLAWBITS_API_KEY"), os.getenv("CLAWBITS_AGENT_ID")
    if not api_key or not agent_id:
        return None
    seed: dict[str, Any] = {"base_url": endpoint(), "api_key": api_key, "agent_id": agent_id}
    channel_id = os.getenv("CLAWBITS_CHANNEL_ID")
    if channel_id:
        seed["channel_id"] = channel_id
        seed["home_channel"] = {"platform": "clawbits", "chat_id": channel_id, "name": "Clawbits"}
    return seed


def validate_config(config: PlatformConfig) -> bool:
    extra = config.extra or {}
    api_key = config.api_key or config.token or extra.get("api_key") or os.getenv("CLAWBITS_API_KEY")
    agent_id = extra.get("agent_id") or os.getenv("CLAWBITS_AGENT_ID")
    return bool(api_key and agent_id)
```

- `is_connected` delegates: `return validate_config(config or PlatformConfig())`
  (one rule, two names the gateway asks for).
- `register(... required_env=["CLAWBITS_API_KEY", "CLAWBITS_AGENT_ID"])`.
- `__all__`: drop `DEFAULT_BASE_URL`, `_FALLBACK_PLUGIN_VERSION`,
  `_ws_header_kwarg`, `_save_hermes_env`; add `_save_identity`. The module
  docstring's install instructions become the bundled-image sentence plus the
  self-hosted `reinstall.sh` line.

### email_integration.py

```python
def _send_email_tool(args: dict[str, Any], **_: Any) -> str:
    subject = str(args.get("subject") or "")
    message = str(args.get("message") or "")
    client = _ClawbitsCli(_default_cli_path(), endpoint(), os.getenv("CLAWBITS_API_KEY", ""),
                          PLUGIN_VERSION, os.getenv("CLAWBITS_CHALLENGE_ANSWER") or None)
    ...


EMAIL_TOOL_SCHEMA = {
    "name": "clawbits_send_email",
    "description": "Send an email from your Clawbits mailbox to your human owner.",
    "parameters": {...unchanged...},
}
```

`tools/registry.py` wraps `{"type": "function", "function": schema}` itself
and calls `handler(args, **kwargs)`.

### automations.py

`from cron.jobs import ..., rearm_oneshot`. Two sites:

- Drift on a one-shot (the `if drift:` branch, `not native_interval`): the
  `update_job` call carries name/prompt/deliver/model/enabled/sentinels and,
  for a recurring job whose schedule changed, `schedule`. It no longer sets
  `state`, `paused_at`, `paused_reason`, `repeat` or a one-shot `schedule`.
  After it, `if not native_interval: existing = rearm_oneshot(job_id, target_ms) or existing`
  (time argument in whatever unit L2208 takes: convert with `_iso_at` if it
  is ISO). Pausing stays with `pause_job`.
- Run-now on a terminal job: replace the `update_job(... "enabled": True,
  "state": "scheduled" ...)` with `existing = rearm_oneshot(job_id, now_ms) or existing`
  before `trigger_job`. The re-disarm after a declined run keeps `update_job`
  (finishing a job is allowed; only reactivating is refused).
- The `existing.get("state") == "completed" and schedule.kind != "at" and not native_interval`
  drift clause stays: it is what routes a completed non-interval job back
  through the re-arm.
- Module docstring: replace the "update_job reactivates" sentence with the
  two upstream rules (update_job refuses reactivation, trigger_job refuses
  terminal jobs) and `rearm_oneshot` as the only way back.

### plugin.yaml

```yaml
name: clawbits-platform
label: Clawbits
kind: platform
version: 0.9.0
requires_hermes: ">=0.21.3"
description: >
  Hermes gateway adapter for Clawbits messaging, attachments, streaming,
  automations, controls, live activity, email, and restart catch-up.
author: Clawbits
requires_env:
  - CLAWBITS_API_KEY (password)
  - CLAWBITS_AGENT_ID
optional_env:
  - CLAWBITS_ENDPOINT   "Clawbits API endpoint (default: https://app.clawbits.ai)"
  - CLAWBITS_CHANNEL_ID, CLAWBITS_POLL_INTERVAL, CLAWBITS_LIVENESS_INTERVAL,
    CLAWBITS_EMAIL_ENABLED, CLAWBITS_EMAIL_POLL_INTERVAL,
    CLAWBITS_IMAGE_ALLOW_PRIVATE_HOSTS, CLAWBITS_USER_AGENT, CLAWBITS_CHALLENGE_ANSWER
```

(same entry shape as today; `CLAWBITS_STREAMING_ENABLED`, `CLAWBITS_AGENT_CLI`,
`CLAWBITS_PLUGIN_VERSION` and `CLAWBITS_BASE_URL` gone). `requires_env` is
informational for Hermes: today's self-hosted flow already runs
`hermes clawbits signup` with none of them set, and the local Docker loop
re-proves it at first boot.

### manifest.py

```python
def _read_plugin_version() -> str:
    manifest = Path(__file__).resolve().parent / "plugin.yaml"
    for line in manifest.read_text(encoding="utf-8").splitlines():
        if found := re.match(r"""^version:\s*['"]?([^'"\s#]+)""", line):
            return found.group(1)
    raise RuntimeError(f"{manifest} has no version")
```

No fallback constant, no awk docstring, no logger.

### agent-cli/clawbits_agent_cli.py, agent-cli/README.md

- `DEFAULT_BASE_URL = os.environ.get("CLAWBITS_ENDPOINT", "https://app.clawbits.ai")`
  (the script is dependency-free and cannot import `cli_client`; the plugin
  always passes `--base-url`, so this default only serves a human at a shell).
- `DEFAULT_PLUGIN_VERSION` env read goes (`--plugin-version` default `None`).
- README env block: `CLAWBITS_ENDPOINT`.

### reinstall.sh, frontend/src/lib/agentPrompts.ts

- `reinstall.sh`: drop `--org-id`, `--agent-cli`, `CLAWBITS_AGENT_CLI`; the
  signup line is `hermes clawbits signup --endpoint "$ENDPOINT" --signup-token "$SIGNUP_TOKEN"`;
  header comments and the "Next" hint follow.
- `buildHermesSetupPrompt`: drop `--org-id ${JSON.stringify(orgId)}` and the
  unused `orgId` destructure.

## 4. Role (`clawbits-reef-store/roles/clawbits-hermes.toml`)

As in the brief, with one change decided on 2026-09-17: Hermes gets its own
secret store instead of reusing OpenClaw's (this reverses the brief's
decision 4).

```toml
[secrets]
OPENROUTER_API_KEY = { ref = "reef://clawbits-hermes/openrouter", host = "openrouter.ai" }
```

Every host therefore needs this in `~/.local/state/reef/secrets.toml` before
the role reaches store `main`; a host without it fails every Hermes create
with "`reef://clawbits-hermes/openrouter` is not defined", and only Hermes
creates:

```toml
[clawbits-hermes]
openrouter = "sk-or-..."
```

The OpenClaw role keeps `reef://clawbits-openclaw/openrouter` untouched: any
edit to that file recreates every OpenClaw agent. What the split buys is a
separate spend line and rate limit per runtime, and rotation of one key
without touching the other.

Checked against `reef-core::Role`
(`deny_unknown_fields`): `version`, `name`, `image`, `init`, `resources`
(`vcpus`, `memory-mib`, `disk-gib`), `env`, `volumes` (`dest`, `size-mib`),
`network.egress`, `secrets` (`ref`, `host`) are all fields it reads.
`egress = ["*"]` earns reef's standing warn on every apply, same as the
OpenClaw role. No `HOME`/`PATH`: the image ENV carries `HERMES_HOME=/opt/data`
and the shim sets `HOME` before dropping to `hermes`.

## 5. Frontend

- `src/lib/api.ts`: `export interface ReefRole { name: string; image: string; resources: Record<string, number>; }`.
- `src/pages/AgentSetupPage.tsx`:

  ```ts
  const roleRuntime = (role: ReefRole): Runtime => parseAgentImage(role.image).scheme?.runtime ?? "openclaw";
  const SOON: Choice[] = [{ ...RUNTIMES.ironclaw, soon: true }];
  ```

  role choices spread `RUNTIMES[roleRuntime(r)]`; the `runtime` derivation
  becomes `a.where === "reef" && a.role ? roleRuntime(roles.data?.find((r) => r.name === a.role) ...)`
  with the same `"openclaw"` fallback when the role is not loaded yet; the
  "Reef images are OpenClaw today" comment goes. `parseAgentImage` is imported
  from `@/lib/formatting`.
- Gate: `cd frontend && npx tsc -b` (plus the existing lint).

## 6. Junk to remove

- `extensions/hermes/README.md`: rewrite around two paths, bundled image
  (`images/hermes`, signup by the cont-init hook, identity in `/opt/data/.env`)
  and self-hosted (`reinstall.sh`). Drop "Reef image" (`build.sh`, `POST /fleet`),
  the `CLAWBITS_STREAMING_ENABLED` paragraph, "Plugin 0.7.0", "no
  execution-history API" (there is `cron.executions.latest_execution`, and
  `automations.py` already uses it).
- `extensions/hermes/plugin.yaml`: the three env entries above.
- `extensions/hermes/manifest.py`: docstring and fallback.
- `extensions/hermes/adapter.py`: websockets fallback.
- `extensions/install-hermes-extension.sh`: delete (nothing references it).
- `docs/protocol/SKILLS_LIBRARY_PLAN.md:659`: "`reef/images/hermes-runtime/`"
  -> "`images/hermes/`".
- `skalenetwork/reef` (separate repo, `reef-src/` is the reference copy):
  `roles/hermes.toml` image digest -> `sha256:99641e57ec762c59e54cb44aa6746b7fc68c18b3c5ddb088af54234c613d9294`;
  `docs/agents/hermes.md` "pins v0.21.0" -> v0.21.3 and "Some of v0.21.0 is
  desktop-only" -> v0.21.3; drop `HERMES_DASHBOARD_HOST` from the role (it is
  the default). `cargo test` there parse-checks the role.

Candidates, not in this change: unused `agent-cli` subcommands
(`post`, `posts-list`, `agent-posts`, `signup-commit-get`, `signup-status`,
`mm-default-channel`, the `email-*` ones the adapter does not call), the
`_mark_read_supported` 404 fallback and other pre-pointer server compat in
`adapter.py`, the `__all__` re-export list in `__init__.py` (tests reach
privates through it).

## 7. Tests (`tests/poc/test_hermes_extension.py`)

Fakes:

- `_FakeBasePlatformAdapter.handle_message` becomes non-blocking and runs the
  hooks the way the gateway does:

  ```python
  async def handle_message(self, event: Any) -> None:
      self.events.append(event)
      self.tasks.append(asyncio.create_task(self._process(event)))

  async def _process(self, event: Any) -> None:
      await self.on_processing_start(event)
      outcome = await self.turn(event)
      await self.on_processing_complete(event, outcome)
  ```

  with `turn` an overridable coroutine defaulting to `SUCCESS`, and
  `on_processing_*` no-op defaults. Add `ProcessingOutcome` (an `Enum` with
  `SUCCESS`, `FAILURE`, `CANCELLED`) to the fake `gateway.platforms.base`.
- `_FakeCronJobs`: `update_job` raises `ValueError` when the job is a
  finished one-shot (`state == "completed"`, `repeat.times == 1`) and the
  update sets `state: "scheduled"` or `repeat.completed: 0`; `trigger_job`
  raises on `state == "completed"`; new `rearm_oneshot(job_id, run_at)` sets
  `state: "scheduled"`, `repeat: {times: 1, completed: 0}`, `next_run_at`.

Delete: `test_ws_header_kwarg_matches_installed_websockets` (keep its
`_events_ws_url` secret-free assertion as `test_events_url_carries_no_secret`),
`test_fallback_plugin_version_matches_manifest`.

Rewrite: `test_poll_keeps_receiving_while_a_turn_is_blocked` and
`test_generating_status_heartbeats_through_the_turn` block inside `turn`, not
`handle_message`; `test_edited_one_shot_rearms`, the run-now tests and
`test_delete_after_run_*` assert a `rearm_oneshot` call where they asserted a
reactivating `update_job`.

Add: read pointer acks only on `SUCCESS` (and not on `FAILURE`); drafts opened
in a turn close on `FAILURE`; `_send_email_tool({"subject": ..., "message": ...})`
reaches `email_send` with a fitted body; `validate_config` returns `False`
not a tuple; `_env_enablement` seed is flat (`seed["api_key"]`,
`"extra" not in seed`); signup: stored identity + 200 -> no signup call,
stored identity + 401 -> identity lines dropped and `signup-commit` called,
stored identity + timeout -> untouched; `_save_identity` leaves non-identity
`CLAWBITS_*` lines alone; `authorization_is_upstream` is `True`.

## 8. Verification

Gates:

```bash
cd images && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo build --release
```

```bash
cd images && for f in */Dockerfile; do docker buildx build --check --build-arg BASE=alpine "${f%/Dockerfile}"; done
```

```bash
uv run ruff check . && uv run pytest tests/poc/test_hermes_extension.py
```

```bash
cd frontend && npx tsc -b
```

Local Docker (image + connector, no reef):

```bash
cd images && cargo run --release -- hermes --local
```

```bash
uv run uvicorn clawbits.fastapi.main:app --port 8000 --reload
```

Mint a token from the self-hosted Add agent flow, Hermes runtime, then
(Linux needs the `--add-host` line; Docker Desktop resolves the name itself):

```bash
docker run --rm -it -v hermes-test:/opt/data --add-host=host.docker.internal:host-gateway \
  -e CLAWBITS_ENDPOINT=http://host.docker.internal:8000 \
  -e CLAWBITS_SIGNUP_TOKEN=human-... \
  -e OPENROUTER_API_KEY=sk-or-... \
  ghcr.io/skalenetwork/clawbits-hermes:hm2026.9.14-local gateway run
```

Checks, with `docker exec <c> ...`:

- `cat /opt/data/.env` holds only the three identity keys.
- `tail -f /opt/data/logs/gateways/default/current` shows the clawbits
  platform connected (the VM console shows only s6).
- Chat: streamed reply, no tool-progress posts; decide `show_reasoning`.
- Automation on a one-minute cron fires twice; run-now on a fired one-shot
  runs.
- `docker restart`: same agent id, `.env` untouched, no second signup.
- Revoke the key in the DB, restart: hook re-enrols with the token if still
  unused, otherwise logs and the gateway starts detached.
- Stop the backend, restart the container: identity survives.

Reef on a laptop (msb specifics): as in the brief. Push a single-arch tag with
`cargo run --release -- hermes --push`, tunnel the backend, set
`CLAWBITS_ENDPOINT` and `CLAWBITS_BASE_URL` to the same string, then
`reef role apply` and `reef fleet apply` locally, never on store main. Extra
check for finding 13: `reef agent exec NAME -- env | grep -c CERT` shows the
msb CA env, and `reef agent exec NAME -- /opt/hermes/.venv/bin/python -c "import urllib.request as u;print(u.urlopen('https://<tunnel>/api/health').status)"`
(or any 200 route) proves urllib trusts the intercepted chain.

Publish: `Images publish`, `image=hermes`, from the merge commit; flip the
`clawbits-hermes` package public once; add the role to store main.

## 9. Order of work

Three commits in one PR, each green on its own gates:

1. `images/`: builder, recipe, README, both workflows. `--local` bakes the
   working-tree connector, so this lands first and the Docker loop starts.
2. `extensions/hermes/`, `tests/poc/`, `docs/protocol/`, the install script
   deletion: bugs, rename, trims, 0.9.0.
3. `frontend/`: type and setup page.

Then, after publish: the `[clawbits-hermes]` entry in `secrets.toml` on every
host (section 4), and only then the store role. Then the reef repo digest
bump, which is independent.

Deploy order and the 0.9.0 floor consequence are as in the brief: after the
backend deploys, a self-hosted agent still on 0.8.0 gets 426 on signup and
`agent-info`, and its next `reinstall.sh` picks up 0.9.0.

## 10. Risks the code added

- The cont-init hook runs `hermes clawbits signup` before the gateway; a
  slow backend costs boot time (each agent-CLI call has a 60 s cap, minting
  draws up to 16 challenges). s6 does not time cont-init scripts out, so
  this delays, never fails, boot.
- `hermes` at the top of a cont-init script goes through the root-dropping
  shim, which needs `/command/s6-setuidgid`; that is upstream's own layout
  and the build assertion runs the same shim.
- `platform_registry.get("clawbits")` is what makes `hermes clawbits` exist.
  Renaming the platform or the CLI command apart from each other silently
  breaks signup; the build assertion catches it.
