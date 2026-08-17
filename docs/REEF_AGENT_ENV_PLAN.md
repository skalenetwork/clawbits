<!-- Plan doc. Not yet implemented. -->

> **Verification status.** Written against the working tree on branch `wip/env-and-skills`.
> The OpenClaw-side claims are read off the shipped bundle of `openclaw@2026.6.10` (the version
> `reef/images/openclaw-runtime/Dockerfile:11` pins), not the docs. Claims marked **UNVERIFIED**
> could not be exercised here - chiefly the microsandbox probes, which were run against a local
> msb 0.5.4 and must be re-run on the prod KVM box before Stage 5 lands.

# Per-agent guest env (view/edit) + reef lifecycle controls in clawbits

Status: plan. Every claim below is cited to `file:line` in the working tree (branch `wip/env-and-skills`). Anything I could not run is marked **UNVERIFIED**.

---

## 1. Goal + non-goals

**Goal.** Give an operator a first-class way to view and add/edit/remove a reef-managed agent's *user* environment variables, from both the reef admin-ui and the clawbits reef page, where the value reaches the guest's `process.env` (and therefore every child process the gateway spawns) and never passes through clawbits' backend. Separately, give the clawbits reef page the start/stop/restart controls it does not have today (`frontend/src/lib/reefApi.ts` exports end at `reefUpgrade`:513 and `reefLatestVersions`:521 - there is no `reefStart`/`reefStop`/`reefRestart`/`reefDestroy`).

**Non-goals.** No `openclaw config` editor, no skill-config UI, no bulk `.env` paste import, no reveal-the-value endpoint, no secret storage in reef's DB, no runtime `exec` primitive, no attempt to make `~/.openclaw/openclaw.json` durable (that is `OPENCLAW_STATE_DIR` relocation - a separate, higher-leverage piece of work, still blocked on `docs/REEF.md:230` §11.2 and the plugin-shadow hazard `profiles.py:135-146`).

---

## 2. The decision

**Apply mechanism: a per-agent env file on a dedicated read-only mount, parsed (never sourced) by the entrypoint at boot, applied by an in-place `restart`.** Container env is fixed at create on both runtimes (`docker_runtime.py:223-224`, `microsandbox_runtime.py:141-142`), so the only two candidates are "recreate the container" or "have the entrypoint re-derive env from a file". Restart is decisively better than recreate because a restart preserves the whole container rootfs including `~/.openclaw` on **both** runtimes (docker: `fleet.py:832-845` calls only `runtime.stop`/`runtime.start`; msb: verified empirically against msb 0.5.4 - the sandbox keeps a persistent `upper.ext4` overlay, a rootfs file and a create-time `-e` var both survived `msb stop`/`msb start`), whereas a recreate destroys `openclaw.json`, `state/openclaw.sqlite`, sessions, `identity/device.json`, and any post-boot-installed skill - and silently **re-pins the model**, because a fresh onboard sets `did_onboard=1` (`entrypoint.sh:59-61`) which makes the block at `entrypoint.sh:276` re-apply `REEF_DEFAULT_MODEL` or the `openai/gpt-5.4` fallback over the owner's Control-UI choice (the comment at `entrypoint.sh:269-275` says exactly this). A restart also keeps the value **off the host process table**, where a recreate puts the entire env back on `msb create -e` argv (`microsandbox_runtime.py:141-142`; msb has no `--env-file`, verified against the installed binary). Recreate still ships as an explicit second apply mode, because it is the only thing that works on agents running today's image.

Rejected:

- **Recreate-only (Option A).** Works today with zero image work, but makes routine an operation that destroys the exact config state this feature exists to protect, and re-pins the model. Kept as `apply:"recreate"`, never as the default.
- **Runtime `exec` primitive (Option C).** Does not avoid the entrypoint change or the restart, and breaks the invariant stated in three places (`status.py:2`, `runtime.py:172-177`, `fleet.py:492`).
- **Reef serving env over HTTP to the guest at boot.** Same entrypoint change, plus a new inbound surface, plus msb egress rules (`microsandbox_runtime.py:143-146`), plus reef holds the secret at rest anyway.
- **Persisting values in reef's store.** `store_sqlite.py:15-19` declares the DB secret-free and non-negotiable, and `deploy/reef-db-backup.sh` snapshots it daily with 14 retained copies. No values, no key names, no new column.
- **`PUT /env` whole-map replace.** Unrepresentable client-side: the API returns no values, so the client cannot round-trip a map it cannot read. `PATCH {set, unset}` only.
- **`DELETE /fleet/{id}/env/{key}`.** Pure sugar over `unset`, and it puts a key name (which names the third-party service the agent holds a credential for) into the uvicorn access log (`api/app.py` `uvicorn.run` does not pass `access_log=False`) and the admin-ui proxy log (`admin_ui.py:215`). Bodies only.
- **`value_hint` (last-4) and salted `fingerprint` on the wire.** The fingerprint's stated purpose (client-side "did I paste the right value") requires the browser to know `REEF_SUBDOMAIN_SECRET`, which it must not. Without that it is unverifiable and therefore useless; the last-4 hint leaks 4 characters of every secret to any admin-token holder. v1 returns `value_length` only.

---

## 3. Architecture: one set-an-env-var operation, end to end

```
operator's browser (clawbits tab or reef admin-ui)
  │  plaintext lives in ONE React useState in a draft row
  │  PATCH /fleet/{id}/env   {set:{AGENTPIT_API_KEY:"sk-…"}, unset:[], apply:"restart"}
  │  Authorization: Bearer <admin token from sessionStorage>
  ▼
reef API (operator's own host, over the operator's own tunnel)
  routes.py  → validate (service-raised ValueError → 422 with OUR message)
             → audit line: actor + key names + value LENGTHS only
  fleet.py   → FleetService.set_env under a per-sandbox asyncio.Lock
             → guest_env.serialize(records)
  runtime    → atomic write to the per-agent env dir on the HOST
                 docker: <REEF_STATE_DIR>/env/<id>/env
                 msb:    <volumes>/reef-env-<id>/env
             → runtime.stop(id); runtime.start(id)      (in-place, rootfs survives)
  ▼
guest boot
  entrypoint.sh, immediately after the setpriv drop and before everything else:
    read the file line-by-line, base64-decode each value, reject reserved/dangerous
    keys, `export` the rest.  Mount is :ro, so the agent cannot forge it.
  ▼
  ttyd (backgrounded, entrypoint.sh:651)  and  exec openclaw gateway run (:654)
  both inherit the identical environ (measured: 25 keys, byte-identical between
  PID 1 and the ttyd process on a live agent)
```

**Where the secret lives at each hop.** Browser React state (one component, unmounted on success) → HTTPS request body to the operator's reef → reef process memory → the env file on the operator's own host, `0644` under a `0700` reef-owned parent → the guest's `process.env`. It is **never** in reef's SQLite, never in a URL, never in a log line, never on argv under `apply:"restart"` (only under `apply:"recreate"`, where the whole env goes to `msb create -e`/`docker run -e` as today).

**Clawbits never sees it.** This is structural, not a policy: `frontend/src/lib/reefApi.ts:1-8` states the model ("clawbits' backend is deliberately NOT in this path: the browser talks to Reef itself, presenting an admin token the operator enters PER SESSION ... never sent to clawbits"), and `reefReq` (`reefApi.ts:168-206`) fetches `${stripSlash(baseUrl)}${path}` with a module-local bearer - clawbits' origin is not in the path. Clawbits stores only the org's `reef_api_url` (`clawbits/fastapi/human_endpoints.py:1783+`). I grepped every reef reference in `clawbits/fastapi/*.py`: there is no proxy route, no env column, no token storage. The prohibitions that keep it zero are in §8.

One honest expansion to state: `ReefSandboxDetail` (`frontend/src/lib/reefApi.ts:145-164`) has **no `env` field today**, so env does not currently reach the clawbits tab at all. Adding the panel puts key names (never values) into the clawbits SPA for the first time.

---

## 4. Reef changes

### 4.1 `reef/guest_env.py` (new)

Mirrors `reef/status.py` in discipline (host-side only, best-effort read, side-effect-free).

```python
ENV_FILENAME = "env"
_MAX_BYTES = 256 * 1024

@dataclass(frozen=True, slots=True)
class EnvRecord:
    op: Literal["s", "u"]   # set | unset
    key: str
    value: str = ""         # plaintext; base64-encoded only on the wire to the guest

def serialize(records: Sequence[EnvRecord]) -> str: ...
def parse(text: str) -> list[EnvRecord]: ...
def read_env_file(host_dir: str | Path) -> list[EnvRecord] | None: ...
def write_env_file(host_dir: str | Path, records: Sequence[EnvRecord]) -> None:
    """Atomic: write <dir>/.env.tmp then os.replace(). Creates <dir> 0755 under a
    0700-mode parent. NEVER logs contents."""
```

File format, deliberately not shell:

```
# reef guest env v1 - written by reef, parsed (never eval'd) by the entrypoint.
v1
s AGENTPIT_API_KEY c2stbGl2ZS1leGFtcGxl
u OLD_KEY
```

Base64 on values removes the entire injection/quoting/newline class at the source. `_validate_user_env` currently permits any value except NUL (`fleet.py:376-378`), i.e. backticks, `$(...)`, newlines and quotes are all legal - which is precisely why `. file` is not implementable.

`u` records exist so a key that arrived via create-time `-e` (`CreateSandboxIn.env`, `schemas.py:154-160` → `manager.py:80-85`) can be removed without a recreate.

### 4.2 `reef/runtime.py`

- `SandboxSpec` gains `env_dest: str | None = None` (alongside `status_dest`, `runtime.py:88`). Docstring: mounted **read-only**; carries the editable user-env overlay; never the reef-managed layer.
- `FleetRuntime` gains two methods next to `read_status` (`runtime.py:172-177`), inheriting its "host-side, never a guest exec" contract:

```python
async def read_guest_env(self, handle: str) -> list[EnvRecord] | None: ...
async def write_guest_env(self, handle: str, records: Sequence[EnvRecord]) -> None: ...
```

### 4.3 `reef/docker_runtime.py`

- `_env_host_dir(handle) -> os.path.join(self._state_dir, "env", handle)`, sibling of `_status_host_dir` (`:183-186`).
- `create()`: after the status mount block (`:216-221`), if `spec.env_dest`, `os.makedirs(host_dir, exist_ok=True)` and `argv += ["-v", f"{host_dir}:{spec.env_dest}:ro"]`.
- **`destroy()` must not touch the env dir.** `:246` currently does `shutil.rmtree(self._status_host_dir(handle))`, and `upgrade` reaches `destroy` via `manager.py:314` - so an env dir placed under the status path would be wiped on every upgrade on docker while surviving on msb (`microsandbox_runtime.py:163-166` only runs `msb remove -f`; verified: probe files survived). Separate dir, deleted only on a true `DELETE /fleet/{id}`.
- `read_guest_env`/`write_guest_env` delegate to `guest_env`.

### 4.4 `reef/microsandbox_runtime.py`

- `_env_volume(handle) -> f"reef-env-{handle}"`, sibling of `_status_volume` (`:99-101`).
- `create()`: `await self._ensure_volume(env_vol)` then `argv += ["-v", f"{env_vol}:{spec.env_dest}:ro"]`. `:ro` is accepted and enforced by msb 0.5.4 (verified: `touch` in the guest → `Read-only file system`).
- `read_guest_env`/`write_guest_env` read/write `os.path.join(self._vol_dir, self._env_volume(handle))`, the same host-side pattern as `read_status` (`:252-254`).
- Host→guest visibility is live virtiofs, verified on msb 0.5.4: a file written host-side *after* boot was immediately visible in the guest, and a non-root (uid 1000) guest read a `0644` host file fine. Note this is the **read** direction; `docs/REEF.md:230` §11.2 is about guest **writes**, which this feature does not need. **UNVERIFIED on the prod KVM box** (the office ThinkCentre) - re-run the probe there before Stage 4 lands.
- The comment at `:88-91` should be amended: the read path is now demonstrated, and the env volume is read-only by design.

### 4.5 `reef/profiles.py`

Two additions to the `AgentProfile` Protocol (`:52-104`):

```python
env_dir: str | None   # guest mount point for the editable user-env overlay
managed_env_keys: frozenset[str]   # every key this profile may EVER inject
```

`env_dir`: OpenClaw `/home/node/.reef-env` (`:134` neighborhood), IronClaw `/home/ironclaw/.reef-env` (`:294`), Hermes `/opt/data/.reef-env` (`:446`). Deliberately not under the status dir and not under the state dir.

`managed_env_keys` is the load-bearing security fix. **Deriving "user env" by subtracting `RESERVED_ENV_KEYS` is unsafe**, because `RESERVED_ENV_KEYS` (`fleet.py:62-89`) does not contain `GATEWAY_AUTH_TOKEN` (`profiles.py:352`, `:364`, read back by `reveal_secret` at `:399`), `SECRETS_MASTER_KEY` (`:350`), `IRONCLAW_PUBLIC_URL` (`:365`), `HERMES_ACCEPT_HOOKS` / `GATEWAY_ALLOW_ALL_USERS` (`:470-471`), or `HERMES_DASHBOARD_HOST/PORT/TUI` (`:519-521`). At create, merge order hides this (`manager.py:80-85`) except for conditionally-set keys - `SECRETS_MASTER_KEY` is emitted only `if creds.get("secrets_master_key")` (`:349-350`), so a user value lands verbatim **today**. On an edit path it is worse: an operator could pin `GATEWAY_AUTH_TOKEN` to a chosen constant and read it back via `POST /fleet/{id}/reveal` (`routes.py:145-163`), or `unset` it and permanently destroy access (reef cannot recompute it, `manager.py:270-277`).

Populate `managed_env_keys` from the literal keys each profile's `build_env`/`exposure_env` emit, and add the test in §4.10 that makes an omission impossible to repeat silently. Also feed it into `_validate_user_env`, which fixes **create** at the same time.

### 4.6 `reef/fleet.py`

New module constants:

```python
_DANGEROUS_ENV_KEYS = frozenset({
    "PATH", "HOME", "SHELL", "USER", "LOGNAME", "IFS",
    "LD_PRELOAD", "LD_LIBRARY_PATH", "NODE_OPTIONS",
})
_ENV_MAX_TOTAL_BYTES = 65536
_ENV_FEATURE = "env-file"
```

`LD_PRELOAD` is the security one (arbitrary code into every child the gateway spawns); `PATH`/`HOME` brick the guest, and the entrypoint sets `HOME`/`USER`/`LOGNAME` itself at `:22`. This is a **pre-existing hole in create** - `-e` overrides the image's baked `ENV`, and `_validate_user_env` (`:358-379`) does not check any of these. Put the check in the shared validator. Deliberately a small hard-coded tuple, not "every baked key": `fleet.py:53-56` explicitly wants `OPENCLAW_STATE_DIR`-style overrides to stay legal.

`_validate_user_env` extensions (applied to `set` maps, and to the *resulting* set on a PATCH):
1. count cap against the **result**, not the delta - otherwise the 32-var cap (`:58`) is bypassed one PATCH at a time;
2. `_DANGEROUS_ENV_KEYS`;
3. `managed_env_keys` for the agent's profile, not just `RESERVED_ENV_KEYS`;
4. `_ENV_MAX_TOTAL_BYTES` across the resulting set (32 × 4096 = 128 KB of `-e` argv approaches `ARG_MAX`, the same failure class the NUL check at `:376-378` exists to prevent);
5. keep the existing message discipline verbatim - `:374` formats `f"…too long ({len(value)} chars)"`, `:367`/`:370`/`:378` format only `key!r`. Length, never the value.

New `unset` guard (create has no analogue): reserved/dangerous/managed keys refused, and the key must be in the derived user-env set. A key present in both `set` and `unset` → 422 (ambiguous intent fails loudly). `set: {"K": ""}` is present-and-empty, distinct from `unset: ["K"]`; note `_validate_user_env` returns `None` for an empty dict (`:361-362`) - correct for create, must not be inherited by the edit path.

The user-env derivation, factored out of `upgrade` (`:876-884`) so the two cannot drift:

```python
async def _replay_context(self, rec) -> tuple[dict[str, str], Limits, dict[str, str]]:
    """(reef-injected env, live limits, image-baked env) - the shared prelude of
    every in-place recreate. Raises RuntimeUnavailable (→503) if image_env is
    empty; a degraded {} would classify every baked var as injected, which is
    merely misleading on a read and DESTRUCTIVE on a write (it would pin stale
    baked values as explicit -e vars across every later upgrade)."""
```

Then:

```python
def _user_env_layer(injected: dict[str, str], profile) -> dict[str, str]:
    managed = profile.managed_env_keys | RESERVED_ENV_KEYS
    return {k: v for k, v in injected.items()
            if k not in managed and not k.startswith(_RESERVED_ENV_PREFIX)}
```

New service methods:

```python
async def get_env(self, sandbox_id: str) -> GuestEnvView:
    """Key names + value LENGTHS for the agent's user env. Never values - reef
    cannot know which of a customer's vars is a secret (redact_env, :96-98, is a
    key-NAME heuristic and returns DATABASE_URL / SMTP_URL in full), so all of
    them are treated as one. Source is the env file when present, else derived
    from the live container (the not-yet-migrated create-time -e layer)."""

async def set_env(self, sandbox_id: str, *, set_vars: dict[str, str],
                  unset_keys: Sequence[str], apply: str) -> EnvApplyResult:
    """apply ∈ {"restart", "recreate", "none"}.
      restart  - write the file, then in-place stop/start. 422 (naming `upgrade`
                 and apply="recreate") when the running image lacks the feature.
      recreate - destroy+recreate on rec.image (NOT the active tag), for agents
                 on a pre-feature image. Destroys ~/.openclaw; the caller MUST
                 have said so.
      none     - write only; takes_effect="on_next_start".
    A deliberate stop (rec.desired_state != RUNNING, :824-829) is respected: the
    file is written, nothing is started, takes_effect="on_next_start".
    No-op short-circuit: if the resulting user env equals the current one, do NOT
    restart - return changed=False. A retried request must not bounce a prod agent."""
```

The **capability gate**, one `inspect` call, host-side, works on both runtimes:

```python
def _supports_env_file(container_env: dict[str, str]) -> bool:
    return _ENV_FEATURE in (container_env.get("REEF_FEATURES") or "").split(",")
```

`REEF_FEATURES` is baked as image `ENV` (§4.9), and `inspect` returns image-baked ENV merged with `-e` on both runtimes (docker by construction, `docker_runtime.py:319`; msb verified - `msb inspect` returned `PATH`, `NODE_VERSION`, `YARN_VERSION`, `COREPACK_HOME` alongside the injected `OPENCLAW_GATEWAY_TOKEN`). Do **not** gate on `status.json` `features`: the msb guest cannot write the status volume today (verified - a non-root guest write into a 0755 reef-owned volume dir fails with `Permission denied`, which is why `_version_signal` (`fleet.py:398-429`) returns `(None, False)` for every prod agent), so the gate would fail closed forever. Do **not** gate on `image_env(rec.image)`: `rec.image` is the *floating* tag (`image_ops.py:120-124`, `manager.py:291`), and `created_image_id` is deprecated and no longer written (`models.py:36-40`). The image marker alone is sufficient *and* correct, because an agent can only be on a post-feature image by having been recreated by post-feature reef, which is also what gives it the mount.

> Side finding worth its own ticket: `fleet.upgrade`'s `image_env(rec.image)` subtraction (`:880-884`) has the same floating-tag bug today. If a rebuild re-points the tag and changes a baked ENV, the subtraction is wrong and stale baked values get pinned as explicit `-e` vars forever.

Concurrency: `FleetService._locks: dict[str, asyncio.Lock]` guarding `set_env` **and** `upgrade`. Two concurrent recreates both read the live env, both destroy, both create - the loser's env is lost. This is a **pre-existing race** in `upgrade` (`:851-911` has no guard). On contention raise `SandboxBusy` → 409. Do not queue; a 60s HTTP wait behind another recreate is worse than a retriable 409.

Two more `fleet.py` fixes that ship with this:

- `logs` (`:661-662`) is a bare passthrough with zero redaction, surfaced verbatim by `routes.py:165-172` and rendered by both UIs. The whole point of this feature is injecting third-party credentials into third-party skills you do not control, and a skill that logs its own key on a 401 puts it there. Substitute every current user-env value with `***` on the read path. This is the one place a *value*-shaped redactor is correct, because you know the values.
- `destroy` (`:847-849`) bypasses `SandboxManager.destroy` (`manager.py:337-344`) and therefore skips `await self._exposure.unpublish(sandbox_id)` (`manager.py:342` → `exposure.py:176-184`). Every destroy leaves a live nginx server block pointed at `127.0.0.1:<port>`, and `_used_ports` (`manager.py:236-248`) makes that port immediately re-allocatable - so a later agent can bind it and the destroyed agent's stable public subdomain silently proxies to a different tenant. Route through the manager. Also delete the env dir there.

`update_settings`' capabilities docstring (`:930-936`) is the tone to copy for every honesty string in this feature.

### 4.7 `reef/api/schemas.py`

```python
class EnvVarOut(BaseModel):
    """One user-supplied guest env var, described WITHOUT its value. There is
    deliberately no value field: reef cannot know which of a customer's vars is a
    secret, so no client can render one and no refactor can leak one."""
    key: str
    value_length: int          # characters; 0 = set-but-empty, a real distinct state
    source: Literal["file", "container"]

class EnvOut(BaseModel):
    sandbox_id: str
    vars: list[EnvVarOut]
    editable: bool             # false ⇒ drift VM, no store record, recreate would 404
    apply_modes: list[str]     # ["restart","recreate"] | ["recreate"] - the honest gate
    state: str
    desired_state: str | None
    pending: bool = False      # forward-compat; always False in v1 (write == apply)

class EnvPatchIn(BaseModel):
    set: dict[str, str] = {}       # UNCONSTRAINED on purpose - see below
    unset: list[str] = []
    apply: Literal["restart", "recreate", "none"] = "restart"

class EnvApplyOut(BaseModel):
    sandbox_id: str
    changed: bool
    applied: Literal["restart", "recreate", "none"]
    takes_effect: Literal["now", "on_next_start"]
    state: str
    vars: list[EnvVarOut]
```

`set` must carry **no** Pydantic constraints (mirroring `CreateSandboxIn.env`, `:160`). A `constr(max_length=4096)` would echo the over-long secret back in the 422 body - I reproduced this against the pinned fastapi 0.141.1 / pydantic 2.13.4:

```
422 {"detail":[{"type":"dict_type","loc":["body","env"],
     "input":"AGENTPIT_API_KEY=sk-live-SUPERSECRET"}]}
```

and reef admin-ui renders it: `detail = JSON.stringify(body.detail)` (`admin-ui/src/lib/api.ts:358-360`) → `ApiError.message` → a sonner toast. All value validation goes in the service, raising `ValueError` → `HTTPException(422, detail=<our message>)` exactly as create does (`routes.py:119-120`).

Also add `"env-edit"` to the `features` literal at `api/app.py:317` (currently `["env", "model", "capabilities"]`, schema at `schemas.py:275-279`) so an always-newer clawbits UI can hide the panel against an older reef. `reefProviders` already exists (`frontend/src/lib/reefApi.ts:310`) and `queryKeys.reefProviders(orgId)` already exists.

### 4.8 `reef/api/routes.py`

```python
@router.get("/{sandbox_id}/env", response_model=EnvOut)
@router.patch("/{sandbox_id}/env", response_model=EnvApplyOut)
```

Placed next to the lifecycle block (`:176-235`). `ValueError → 422` (`:119-120` pattern), `SandboxBusy → 409` (mirroring `BuildInProgress → 409`, `errors.py:16-19`, `routes.py:262-264`), `RuntimeUnavailable → 503` (already handled app-wide, `api/app.py:400-402`).

Reef has **no audit trail at all** (grep: only `logger.*` in `reconciler.py`, `admin_ui.py`, `build_jobs.py`, `api/proxy.py`, `api/app.py`, none touching env). Add one INFO line per mutation, emitted from the route (which has `Request`; the service is deliberately HTTP-agnostic):

```python
logger = logging.getLogger("reef.api.fleet")
logger.info("env update %s by %s: set=%s unset=%s lengths=%s applied=%s",
            sandbox_id, getattr(request.state, "operator", "anonymous"),
            sorted(body.set), sorted(body.unset), {k: len(v) for k, v in body.set.items()},
            result.applied)
```

`request.state.operator` is set at `api/security.py:39` (Cloudflare Access email) and `:52` (`"service-token"`); note branch 3 (`:53-55`, open when nothing is configured) sets nothing, hence the `getattr` default. `_configure_logging` already routes `reef.*` to stdout/journald (`api/app.py:97-115`).

Also register a `RequestValidationError` handler in `create_app` (`api/app.py:396-402` currently registers only `SandboxNotFound` and `RuntimeUnavailable`) that strips `input` and `ctx` from every error dict. This also fixes the existing `POST /fleet` exposure.

And: refuse the env routes with 503 when `verifier is None and not token` (`api/security.py:53-55`). Today an unconfigured deployment is open; a user-env read surface raises the stakes past "fail open is acceptable for local dev".

### 4.9 `reef/images/openclaw-runtime/`

`entrypoint.sh` - insert immediately after the setpriv block (`:21-24`) and **before** the gateway-token block (`:29`), so every downstream branch, the backgrounded ttyd (`:651`) and the exec'd gateway (`:654`) all see it. That propagation is measured, not assumed: on a live agent, PID 1 and the ttyd process have byte-identical environs (25 keys), and `setpriv` is invoked without `--reset-env` so exports survive the re-exec.

```sh
# Reef-managed user env: a read-only file on a per-agent mount, PARSED (never
# sourced). Values are base64 so a value can contain anything without ever being
# evaluated by the shell. Reserved/dangerous keys are filtered HERE too, not just
# server-side, so this stays safe even if the mount is ever made writable.
reef_apply_env_file() {
  _f="${REEF_ENV_DIR:-}/env"
  [ -n "${REEF_ENV_DIR:-}" ] && [ -r "${_f}" ] || return 0
  while IFS=' ' read -r _op _k _v || [ -n "${_op}" ]; do
    case "${_op}" in s|u) ;; *) continue ;; esac
    case "${_k}" in
      ''|[0-9]*) continue ;;
      *[!A-Za-z0-9_]*) continue ;;
      REEF_*|CLAWBITS_*|OPENCLAW_GATEWAY_*|OPENCLAW_PUBLIC_URL|GATEWAY_*|HERMES_*|IRONCLAW_*|SECRETS_MASTER_KEY) continue ;;
      PATH|HOME|SHELL|USER|LOGNAME|IFS|LD_PRELOAD|LD_LIBRARY_PATH|NODE_OPTIONS) continue ;;
    esac
    if [ "${_op}" = "u" ]; then unset "${_k}" 2>/dev/null || true; continue; fi
    _dv=$(printf %s "${_v}" | base64 -d 2>/dev/null) || continue
    export "${_k}=${_dv}"
  done < "${_f}"
  unset _f _op _k _v _dv
}
reef_apply_env_file
```

Verified in the image: `/bin/sh` is dash, `/usr/bin/base64` exists and `base64 -d` round-trips. Note `OPENCLAW_*` is **not** blanket-filtered - `fleet.py:53-56` deliberately keeps `OPENCLAW_STATE_DIR` available as the power-user escape hatch. Known limitation to document: `$( )` strips trailing newlines, so a value ending in `\n` loses it.

Every guard here matters because `set -eu` is on (`:15`): a malformed file must not abort the entrypoint before `:654` and leave a crash-looping VM with no explanation. Everything is `|| continue` / `|| true`.

`Dockerfile` - next to `REEF_IMAGE_VERSION` (`:151-153`):

```
ENV REEF_FEATURES=env-file
ENV REEF_ENV_DIR=/home/node/.reef-env
```

`REEF_*` is already reserved by prefix (`fleet.py:60`), so neither is user-settable. `build.sh:76` re-stamps `REEF_IMAGE_VERSION` onto a one-line layer; `REEF_FEATURES` comes from the base Dockerfile and needs no re-stamp.

Parity later: `images/ironclaw-runtime/entrypoint.sh`, `images/hermes-runtime/`.

### 4.10 Tests

Style to match: no pytest-asyncio - sync tests wrapping `asyncio.run(scenario())` (`tests/test_upgrade.py:4`, `:41-77`); HTTP via `TestClient(create_app(service=FleetService(rt, InMemorySandboxStore())))` (`tests/test_api.py:16-24`); `FakeAdminRuntime().seed(...)` plus the shared `INSPECT` blob imported from `test_fleet` (`tests/test_api.py:13`, `tests/test_fleet.py:20-59`).

**`tests/fakes.py` needs one load-bearing fix first.** `FakeAdminRuntime.create` rebuilds `inspect_data` with `setdefault` (`:70-79`), so on a recreate under the same sandbox id the stale blob wins and "PATCH then GET shows the new value" would silently assert against the old env. Nobody has hit this because `test_upgrade.py` asserts on `rt.created[-1].env`. Always overwrite the recorded inspect blob's `env`, preserving explicitly seeded non-env fields.

New `reef/tests/test_env.py`:

- `test_profiles_declare_every_key_they_inject` - for every entry in `AGENT_TYPES`, assert `set(build_env(FULL_CREDS)) | set(exposure_env(password="p", public_url="u")) <= managed_env_keys`. This is the test that makes the whole derivation trustworthy.
- `test_ironclaw_gateway_token_is_not_user_env` - `GATEWAY_AUTH_TOKEN` absent from `GET /env`, `unset:["GATEWAY_AUTH_TOKEN"]` → 422. Same for `HERMES_DASHBOARD_HOST`, `SECRETS_MASTER_KEY`.
- `test_get_env_never_returns_a_value` - `"value"` appears in no serialized var.
- `test_get_env_lists_only_user_vars` - seeded blob with `CLAWBITS_API_KEY`, `OPENCLAW_GATEWAY_TOKEN`, `REEF_CAPS`, a baked `PATH`, and `AGENTPIT_API_KEY`; only the last is listed.
- `test_patch_restart_writes_file_and_does_not_recreate` - `rt.calls` contains `("stop",…),("start",…)` and `rt.created` is unchanged.
- `test_patch_restart_rejected_on_old_image` - no `REEF_FEATURES` ⇒ 422 whose detail names `upgrade` and `recreate`; no restart issued.
- `test_patch_recreate_pins_the_current_image` - with a newer active tag configured, `rt.created[-1].image == rec.image`.
- `test_patch_recreate_preserves_net_allow_and_caps` - host-local `CLAWBITS_ENDPOINT` ⇒ `("public","host")` survives; `REEF_CAPS` comes from the record, not the stale container (`fleet.py:903-908`).
- `test_patch_noop_does_not_restart` - `changed: false`, no new entries in `rt.calls`.
- `test_patch_on_stopped_agent_leaves_it_stopped` - `takes_effect == "on_next_start"`, no `("start",…)` (`test_upgrade.py:80-92` is the template).
- `test_unset_removes_and_empty_string_is_kept`.
- `test_patch_rejects_reserved_dangerous_and_over_cap` - `REEF_X`, `CLAWBITS_API_KEY`, `LD_PRELOAD`, `PATH`, a 33rd var, a 5000-char value, a NUL, a key in both `set` and `unset`.
- `test_patch_422_body_never_echoes_the_value` - the offending value is not a substring of the body. Guards the Pydantic-echo trap.
- `test_create_rejects_dangerous_keys` - the create-path regression.
- `test_concurrent_patch_is_409`.
- `test_env_routes_require_the_admin_token` (`test_api.py:115-120` pattern) and `test_env_routes_503_when_auth_unconfigured`.
- `test_logs_redact_user_env_values`.
- `test_patch_on_drift_is_404_and_get_reports_not_editable`.

`reef/tests/test_openclaw_entrypoint.py` (extend, file is text-assertion style, `:1-24`): assert `reef_apply_env_file` appears before `exec openclaw gateway run` and before the ttyd block; plus a **behavioral** test that slices the function out of `entrypoint.sh` and runs it under `/bin/sh` against fixture files, asserting: a normal var exports; a `REEF_*`/`PATH`/`LD_PRELOAD` record is dropped; a base64 value containing `` `id` ``, `$(id)`, a newline and a quote round-trips literally with no execution; a malformed line does not abort under `set -eu`.

**No change** to `reef/models.py`, `reef/store.py`, `reef/store_sqlite.py`. No new column, no migration, no value or key name in the DB or in the 14 daily backups (`deploy/reef-db-backup.sh`).

---

## 5. Reef admin-ui changes

| File | Change |
|---|---|
| `reef/admin-ui/src/lib/api.ts` | `EnvVar`/`AgentEnv` types after `SandboxDetail` (~`:98`); `env(id)` and `patchEnv(id, {set, unset, apply})` on the `api` object next to `setRestartPolicy` (`:406`), before the Images divider. `patchEnv` is **not** a reuse of `upgrade` (`:398`) - `FleetService.upgrade` rebuilds the profile on the *current active tag* (`fleet.py:869-874`), so reusing it would ship an unrequested image upgrade on every env save. |
| `reef/admin-ui/src/lib/queries.ts` | `useAgentEnv(id)` (key `["env", id]`, not polled, `retry: (n, e) => !isAuthError(e) && n < 3` per `:27`/`:51`/`:75`) and `useEnvActions(id)`. **No `onMutate`** - a deliberate divergence from the optimistic `setColor` (`:263-270`) / `setRestartPolicy` (`:283-292`), with the reason in a comment so nobody "fixes" the inconsistency: an optimistic write would put the plaintext into the react-query cache. Only the server's value-free response is ever `setQueryData`'d. Call `mutation.reset()` on settle - TanStack retains `variables` after settle and this codebase demonstrably reads them (`App.tsx:58-66` reads `start.variables`). |
| `reef/admin-ui/src/components/AgentEnvPanel.tsx` | **new**. Replaces `<EnvironmentPanel env={detail.env} />` at `AgentDetail.tsx:451` - in place, in the Overview tab's main column ("access + reference configuration"), **not** a third tab (`AgentDetail.tsx:145` types `tab` as a 2-value union and the apply action is the same operation family as `UpgradeControl` in the side rail at `:569`). Rows use `EnvVarRow`/`AddEnvRowButton` from `create-agent/bits.tsx:133`/`:184` so the panel is visually identical to the create wizard's env section. Draft edits are **local**; one "Save changes" button sends one PATCH with the whole diff and the server applies atomically - there is no server-side staged state to render, so per-row "dirty" chips are honest (nothing has been sent). Remove uses the existing `ConfirmDialog` (`ConfirmDialog.tsx:22-58`) on **every** removal. Save opens a confirm whose copy is mode-dependent: `restart` ⇒ "The agent restarts. Workspace, config, sessions and identity are preserved; a few seconds of downtime."; `recreate` ⇒ the full destroy list, in the register of `AgentDetail.tsx:592`. |
| `reef/admin-ui/src/components/AgentDetail.tsx` | `:451` swap; `export` on `Panel` (`:389`), `Chip`/`ChipColor` (`:88`/`:61`), `CARD` (`:55`); rename `EnvironmentPanel` (`:795`) → `RuntimeEnvList`, drop its `Panel` wrapper, keep its `LIMIT = 10` behaviour, render it behind a collapsed `▸ Runtime & image (N)` disclosure inside the new panel. |
| `reef/admin-ui/src/components/create-agent/bits.tsx` | `EnvVarRow` (`:133`) gains `lockKey?: boolean` and `secret?: boolean` (both default-off, so `OptionsStep.tsx:341-352` is behaviour-identical). `secret` ⇒ `type="password"` + an eye toggle (the reveal pattern already exists inline at `AgentDetail.tsx:939-945`) plus `data-1p-ignore` / `data-lpignore="true"` / `data-bwignore` and no `name`. Add a client mirror of `_SECRET_KEY` next to `ENV_KEY_RE` (`:23`), driven live off the NAME field so the value input is already masked by the time `AGENTPIT_API_KEY` is typed. |

Reserved-key validation stays server-side only, matching the wizard's existing deliberate choice (`bits.tsx:21-22`: reserved keys "come back as a readable 422 toast") - `RESERVED_ENV_KEYS` is partly derived from `{p.guest_env for p in PROVIDERS}` (`fleet.py:85-89`) and cannot be mirrored.

---

## 6. Clawbits UI changes

### 6.1 Lifecycle controls (independent, ships first)

`frontend/src/lib/reefApi.ts`:

```ts
export interface ReefActionResult { sandbox_id: string; state: ReefState }
export const reefStart   = (b: string, id: string) => reefReq<ReefActionResult>(b, `/fleet/${encodeURIComponent(id)}/start`,   {auth: true, method: "POST"})
export const reefStop    = (b: string, id: string) => ...  `/stop`
export const reefRestart = (b: string, id: string) => ...  `/restart`
```

All three exist and are admin-gated (`reef/api/routes.py:176-179`, `:182-185`, `:188-193`; router `dependencies=[Depends(admin_auth)]` at `:40`), returning `ActionOut` = `{sandbox_id, state}` (`schemas.py:207-209`). `reefUpgrade` (`:513-518`) inlines that same shape - reuse the new interface there.

Two corrections that must land with them:

- **Do not seed the fleet cache from `ActionOut.state`.** It is not authoritative: `FleetService.start` ends with a literal `return SandboxState.RUNNING` (`fleet.py:821`) and `stop` with `return SandboxState.STOPPED` (`:830`); neither re-reads `runtime.status()`. A container that starts and immediately crashes still reports `running`. Invalidate only - the fleet list derives `state` from the live runtime (`fleet.py:528`, `:546`) and the 8s poll (`SettingsReefPage.tsx:292-302`) self-corrects.
- **Fix the blanket 409 mapping** at `reefApi.ts:201` ("The only 409 in the reef API is 'a build is already running'"). Once `SandboxBusy` lands, a busy agent would surface as a build-in-progress error. Make the mapping path-aware or add a distinct class.

`ReefFleetEntry` (`reefApi.ts:99-117`) gains `desired_state?: string | null`. Reef already ships it (`fleet.py:556` → `schemas.py:46` → `schemas.py:384`); clawbits just drops it. Without it the stop-is-sticky copy is unverifiable from the client, and `stopped` + `desired_state === "running"` (a crash the policy declined to heal, `reconciler.py:138-140`) cannot be told apart from an operator stop.

`SettingsReefPage.tsx`:
- `lifecycleErrorMessage` beside `upgradeErrorMessage` (`:136-143`). Only 404 and 502/503 are reachable; the 422 branch is dead for lifecycle.
- Four mutations in `FleetCard` modeled verbatim on `upgrade` (`:744-761`), **including the `ReefAuthError` branch** - it is mandatory, and the file says why at `:1014-1015`: the page-level auth effect only watches `fleetQuery.error` (`:336-342`), so a mutation's 401 is otherwise swallowed. `onAuthReject` is already prop-drilled in (`:683`, `:722`).
- A single `DropdownMenu` with a `MoreHorizontal` trigger in the footer action cluster (`:924-933`), right of the terminal button. Every handler needs `e.stopPropagation()` - the whole card is a click-through to `/agents/{id}` (`:783-792`), same as the existing buttons at `:880-881` and `:925`.
- State-aware items, gated on `vm.managed` (`reefApi.ts:105`) and disabled while `vm.state === "creating"` (`recreate_with_image` marks the record CREATING before destroying precisely so the reconciler skips the gap, `manager.py:305-312`; `FleetService.start` has no such guard and would either 404 or write `RUNNING` over an in-flight CREATING record):

  | state | items |
  |---|---|
  | `running` | Restart · Stop · Environment variables… |
  | `stopped` | Start · Environment variables… |
  | `failed` | Start · **Stop** · Environment variables… |
  | `creating` | all disabled |

  **Stop must be offered on `failed`.** A crashed agent with the default `on-failure` policy (`fleet.py:350`) is in a reconciler backoff loop (`reconciler.py:146-152`, `:160-176`), and `stop` is the only control that breaks it, because it is the only thing that writes `desired=STOPPED` (`fleet.py:824-831`; the reconciler bails at `reconciler.py:124-126`).
- Stop's toast must say the stop is sticky: `Stopped {id} - it stays down until you start it.` Otherwise an operator with `restart_policy: always` reasonably expects self-healing.
- **Destroy is deliberately not in v1.** See §9 Stage 0 and §10 Q1.
- **Fix the Upgrade tooltip at `:885-887`.** It says "Workspace, clawbits identity, and access password are preserved; brief downtime" - true only for named volumes (`manager.py:265-276`, `:314`). The workspace volume mounts at the sub-path `/home/node/.openclaw/workspace` (`profiles.py:139`), so `~/.openclaw/openclaw.json` is on the ephemeral rootfs and is destroyed. Append: `Anything set with "openclaw config set" is NOT preserved - use environment variables instead.` The same overclaim is in `reef/api/routes.py:196-201` ("lossless") and `reef/fleet.py:852-856`; fix all three.

### 6.2 Env panel

- `frontend/src/components/reef/envRows.tsx` (**new**) - `ENV_KEY_RE`, `EnvVarRow`, `AddEnvRowButton` moved out of `new-agent/bits.tsx:141-200` and `new-agent/prompts.ts:11`, re-exported from `new-agent/bits.tsx` so the wizard is untouched. Same `secret` / `lockKey` additions as the admin-ui version - today the wizard's value field is a plain `type="text"` `<Input>` with only `autoComplete="off"` and `spellCheck={false}` (`bits.tsx:165-173`), i.e. pasting an API key renders it on screen and offers it to password managers, which widely ignore `autoComplete="off"`.
- `frontend/src/components/reef/ManageEnvDialog.tsx` (**new**) - opened from the card overflow menu, page-level state beside `openTarget` (`SettingsReefPage.tsx:364`), rendered beside `<OpenSurfaceDialog>` (`:692-699`). There is no per-agent detail surface in clawbits to host a panel (`FleetCard` is itself a click-through) and an inline expander fights the 2-col grid at `:674`. Reads `reefAgentEnv`, partitions **Yours** (editable) from a collapsed read-only **Managed by reef**, mirrors the `fleet.py:55-60` limits client-side, submits one `{set, unset, apply}` diff, and confirms with mode-dependent copy. Auth watch per `OpenSurfaceDialog.tsx:52-58`: on `ReefAuthError`, call `onAuthReject()`, toast, and **close** - never leave a dialog holding a half-typed secret over a dead session.
- Gate the menu item on `reefProviders().features.includes("env-edit")` (`reefApi.ts:310`, `queryKeys.reefProviders`), queried like `imageStatusQuery` (`SettingsReefPage.tsx:325-333`). An older reef's Pydantic silently drops unknown fields - the discipline is already spelled out at `reefApi.ts:265-269`. If the feature is absent, hide the panel entirely rather than render a wrong list.
- `frontend/src/lib/reefApi.test.ts` - the existing tests are pure string builders; add path/method assertions with a stubbed `fetch`, and one regression test that the request body never contains a value for a key the operator did not retype.

Tokenless tabs need no new gating: `fleetVisible = Boolean(apiUrl) && tokenSet && !offline` (`:371`), both entry points hang off a `FleetCard`, and `reefReq` throws `ReefAuthError` before any network call when `_token` is null (`reefApi.ts:175`).

---

## 7. Rollout sequencing, honestly

**Works on every existing agent, today, no image change:** `GET /fleet/{id}/env`, `PATCH … apply:"recreate"`, and all of the security hardening. This is the same-week fix for the `AGENTPIT_API_KEY` owner - at the cost of `~/.openclaw` (config store, sessions, `openclaw.sqlite`, device identity, post-boot-installed skills) and a silent model re-pin. The API response and the UI confirm dialog must enumerate that list; do not soften it.

**Needs a new image:** `apply:"restart"`. The image contributes the entrypoint reader and the `REEF_FEATURES=env-file` marker; the reef release contributes the `env_dest` mount. An existing container has neither until it is recreated, and the recreate that gives it both is the ordinary `upgrade`. Because the image can only be produced by a build promoted through post-feature reef, **the image marker alone is a correct gate** - any agent carrying it was necessarily recreated by post-feature reef and therefore has the mount.

**What the UI must say when the agent is too old.** Never a silent no-op, never an unnecessary restart. `PATCH … apply:"restart"` against a pre-feature image returns **422** naming both remedies: run `Upgrade` (one recreate now, lossless restarts forever after), or accept `apply:"recreate"` this once. The panel renders `apply_modes` from `GET /env` and shows the mode selector accordingly, with a one-line explanation of what each costs. The precedent for this register is `fleet.py:930-936`.

**Deliberately stopped agents.** `desired_state != RUNNING` (`fleet.py:824-829`, respected at `manager.py:319-325`) ⇒ write the file, do not start, report `takes_effect: "on_next_start"`. An env edit must never resurrect an agent the operator stopped.

**Migration of the existing `-e` user layer.** On the first PATCH, reef seeds the env file from the derived container user layer, then applies the diff. From then on the file is authoritative and wins at boot. `upgrade`/`recreate` collapse the drift by rebuilding the `-e` user layer from the file, so `u` records do not accumulate forever.

**Prod risk to retire before Stage 4.** Host→guest visibility, uid mapping, and `:ro` enforcement were verified on msb 0.5.4 locally. **UNVERIFIED on the prod KVM box.** Also note the msb volumes root sits under the service user's home, which `deploy/install.sh:94` sets to `$REEF_DIR` (`/opt/reef`, the checkout) and `:100` only `chown -R`s - no `chmod` - so it keeps the checkout's world-traversable 0755. Root the env dir under `REEF_STATE_DIR` (`/var/lib/reef`, `0750` per `install.sh:139` + `StateDirectoryMode=0750`) on **both** runtimes, never under the msb volumes root.

---

## 8. Security notes: what must ship with v1

Findings from the exposure audit, with the mitigation that is non-negotiable for v1.

1. **`redact_env` is a key-*name* heuristic and cannot be reused.** `fleet.py:43`/`:96-98`, called only from `get_detail` (`:588`). I ran it against realistic names: `AGENTPIT_API_KEY` masks, but `DATABASE_URL`, `SMTP_URL`, `GH_PAT`, `STRIPE_PK`, `SENTRY_DSN`, `NPM_AUTH`, `AWS_SESSION`, `JWT` all return **in full** - and `DATABASE_URL=postgres://user:pw@host` is a credential. **Mitigation:** the user-env model carries no `value` field at all. (Separately consider narrowing `SandboxDetailOut.env` (`schemas.py:84`) to reef-managed keys - that is the surface leaking `DATABASE_URL` today. See §10 Q6.)
2. **Pydantic 422 echoes the offending input, and it renders as a toast.** Reproduced against the pinned versions; renders via `admin-ui/src/lib/api.ts:358-360`. **Mitigation:** unconstrained `dict[str, str]` + service-side validation + a `RequestValidationError` handler stripping `input`/`ctx` + a test asserting the value is not a substring of the body.
3. **`GATEWAY_AUTH_TOKEN` / `SECRETS_MASTER_KEY` are not reserved.** `fleet.py:62-89` vs `profiles.py:350`, `:352`, `:364`, `:399`. Setting it pins an IronClaw agent's access password to a chosen constant readable via `POST /reveal`; unsetting it destroys access irrecoverably. **Mitigation:** `managed_env_keys` on the profile + the `AGENT_TYPES`-wide test + fixing `_validate_user_env` so create is covered too.
4. **`GET /fleet/{id}/logs` has zero redaction** (`fleet.py:661-662` → `routes.py:165-172`). The feature's whole purpose is handing credentials to third-party skills whose logging you do not control. **Mitigation:** substitute current user-env values with `***` on the log read path, and say so in the panel copy.
5. **`-e KEY=VALUE` sits on the host process table.** `_subprocess.py:17-24` uses `create_subprocess_exec`; `/proc/<pid>/cmdline` is world-readable without `hidepid=2`, which appears nowhere in `reef/deploy/` or `docs/`. msb has no `--env-file` (verified against the installed binary), so on the prod runtime this is structural. `_redact` (`_subprocess.py:27-38`) only sanitises exception strings. **Mitigation:** `apply:"restart"` keeps the value off argv entirely - this is a real argument for B over A. Document `hidepid=2` in `deploy/PROD_RUNBOOK.md`, and state "no untrusted local users on the reef host" as a trust assumption (the `reef` user is already in the `docker` group, `install.sh:97`, i.e. root-equivalent). Do not describe recreate as "no new exposure": the *frequency* is the change.
6. **No values in the store, ever.** `store_sqlite.py:15-19`; `deploy/reef-db-backup.sh` keeps 14 daily copies. No new column, not even key names.
7. **Nothing in URLs.** No `DELETE /env/{key}`, no query params. `uvicorn.run` (`api/app.py:436-455`) does not disable the access log and `admin_ui.py:215` logs a second copy. Note the existing bad precedent at `reefApi.ts:325-330` (`reefOllamaModels` puts `host` in a query string) - do not copy it.
8. **Auth is open when unconfigured** (`api/security.py:53-55`). **Mitigation:** the env routes refuse to serve at all in that configuration.
9. **Browser hygiene.** No optimistic cache writes for env; `mutation.reset()` on settle (TanStack retains `variables`, and this codebase reads them - `admin-ui/src/App.tsx:58-66`); gate `ReactQueryDevtools` (`frontend/src/App.tsx:159`) on `import.meta.env.DEV` explicitly rather than relying on the package's internal `NODE_ENV` check, because operators run `vite dev` against real reefs; plaintext lives in exactly one `useState` in a component that unmounts on success and is never lifted into `App`/`SettingsReefPage`; toasts and confirm dialogs name the key, never the value; no copy button on secret rows; no `console.*`.
10. **No reveal endpoint. Ever.** `POST /fleet/{id}/reveal` (`routes.py:145-163`) is justified because reef *minted* that secret and nothing else can recover it. A user-supplied value has no such claim - it is already recoverable from inside the guest by its owner. Adding `GET /env/{key}/reveal` would make one stolen admin token yield every customer credential across the whole fleet in a single request.
11. **Guest readability is total, and must be stated in the UI, not a doc.** Verified live: PID 1 is `openclaw` running as `node`, the agent runs as `node`, so `/proc/1/environ` is readable and returned all 22 vars including `OPENCLAW_GATEWAY_TOKEN`, `REEF_TERMINAL_PASSWORD` and `CLAWBITS_*`. This is inherent - the credential must be in `process.env` for children to inherit it. Panel copy: *"Anything you set here is readable by the agent and by anyone with its web terminal. Use scoped, revocable, spend-limited credentials."* `reef.env.example:70` already uses this register.
12. **Pre-existing, adjacent, worth tickets not blockers:** `ttyd --credential reef:<password>` on guest argv (`entrypoint.sh:645-647`, confirmed readable via `ps` in the guest; the entrypoint comment already concedes it); `terminalAuthUrl` putting the password in URL userinfo (`frontend/src/lib/reefApi.ts:365-371`).

---

## 9. Staged delivery

**Stage 0 - reef: `FleetService.destroy` → `SandboxManager.destroy`.** Three lines (`fleet.py:847-849`). Restores `unpublish` (`manager.py:342`) and closes the cross-agent routing hazard where a destroyed agent's nginx block survives and its port is immediately re-allocatable (`manager.py:236-248`). Prerequisite for exposing destroy anywhere new. Independently shippable, independently testable.

**Stage 1 - clawbits lifecycle controls.** Pure client surface, zero backend work: `reefStart`/`reefStop`/`reefRestart`, `desired_state` on `ReefFleetEntry`, the overflow menu, the 409 mapping fix, the Upgrade-tooltip fix in all three places. Independently useful today.

**Stage 2 - reef security hardening, no new feature.** `managed_env_keys` + profile test, `_validate_user_env` dangerous-key/total-bytes rules (fixes create), the `RequestValidationError` handler, the log-value redactor, the audit logger, the env-routes auth refusal. Ships alone; makes every later stage safe.

**Stage 3 - reef env API, recreate-only.** `GET /fleet/{id}/env`, `PATCH … apply ∈ {recreate, none}`, the per-sandbox lock (also fixing the `upgrade` race), `SandboxBusy` → 409, `"env-edit"` in `features`. **Works on every existing agent.** This is the AGENTPIT_API_KEY fix.

**Stage 4 - reef admin-ui panel.** `AgentEnvPanel` + `EnvVarRow` secret mode, recreate-only copy. Shippable on Stage 3 alone.

**Stage 5 - env-file plumbing + new image.** `guest_env.py`, `SandboxSpec.env_dest`, both runtimes (`:ro` mount, docker `destroy` fix), `profiles.env_dir`, manager threading, entrypoint reader, `REEF_FEATURES` marker, image build + promote. Re-verify the msb probes on the prod box first.

**Stage 6 - enable `apply:"restart"`.** Server-side gate flips on; both UIs render `apply_modes` from `GET /env` with no further change.

**Stage 7 - clawbits env panel.** `envRows.tsx`, `ManageEnvDialog`, feature gate.

**Stage 8 - parity + follow-ups.** IronClaw/Hermes entrypoint readers; `fleet.upgrade`'s floating-tag `image_env` bug; `OPENCLAW_STATE_DIR` relocation investigation; `docs/REEF.md` §7 (`:223-224`, which currently calls env create-only), §11.2 (`:230`), §13.

---

## 10. Open questions

1. **Destroy in the clawbits UI at all?** Beyond Stage 0 there are two unfixed issues: named volumes are never removed (`docker_runtime.py:242` has no `-v`; `microsandbox_runtime.py:164` likewise) while auto-naming only excludes *currently live* names (`fleet.py:748-751`), so a recycled name can mount a dead agent's workspace and config volume including its clawbits identity mirror; and nothing in clawbits clears `agents.reef_sandbox_id` (every reference is a setter or reader - `clawbits/db/table_write.py:211`, `:314`; `clawbits/fastapi/human_endpoints.py:450`, `:837`; `clawbits/db/table_read.py:191`), so the linked agent row dangles permanently. My recommendation is to leave destroy in the reef admin-ui. Your call.
2. **Env file as authoritative source replayed into `-e` on upgrade (my proposal), or a pure overlay that never collapses?** The collapse keeps `u` records from accumulating and keeps one definition of "the user layer"; the pure overlay is simpler but lets the container's `-e` and the file diverge forever.
3. **msb hardening: `0600` root-owned env file read during the entrypoint's root phase (before the `setpriv` at `entrypoint.sh:23`) instead of `0644` read after?** Host files owned by the reef user appeared as `root:root` in the guest in my probe, so this would make the file unreadable *as a file* by the agent on prod. It buys nothing for confidentiality (the value is in `/proc/1/environ` regardless) and diverges from docker, where the entrypoint is already `node`. I lean no. Worth 10 minutes of your judgement.
4. **Do you want an `openclaw config set skills.*` warning shipped alongside?** The originating bug was partly that the terminal gives no signal that a skills-config write is a no-op until restart. A one-line notice in `reef-term.sh`'s MOTD, or a wrapper, would close the loop cheaply. Out of scope as specified.
5. **`SandboxDetailOut.env` narrowing** (`schemas.py:84`) to reef-managed keys only, to stop leaking `DATABASE_URL`-shaped user vars in full through the existing detail panel. It changes what the current admin-ui `EnvironmentPanel` shows. Fix now, or accept it because the new panel supersedes that view?
6. **IronClaw/Hermes parity timing** - Stage 8, or blocking Stage 6? OpenClaw is the only type with the originating bug, but shipping `apply:"restart"` for one agent type and not the others means `apply_modes` differs by type, which the UI must render honestly either way.