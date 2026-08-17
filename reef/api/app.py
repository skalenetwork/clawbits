"""Reef's own entrypoint: the admin/fleet HTTP API.

Standalone — depends only on ``reef.*`` + FastAPI, never clawbits. Run it with::

    uv run python -m reef.api          # or: uv run uvicorn reef.api.app:app

Config (all optional, ``REEF_*``):
    REEF_RUNTIME        backend: docker | microsandbox (default: docker@macOS, msb@Linux)
    REEF_MSB_BIN        path to the msb binary (else PATH / ~/.microsandbox)
    REEF_DOCKER_BIN     path to the docker binary (else PATH)
    REEF_STORE          sandbox store: sqlite | memory (default sqlite — durable, survives restarts)
    REEF_DB_PATH        SQLite DB file (default ${REEF_STATE_DIR:-~/.reef}/reef.db)
    REEF_ADMIN_TOKEN    service-token (Bearer) the browser sends to manage the fleet
                        (entered in the clawbits session; shared per reef) / the
                        clawbits→Reef machine path
    REEF_SUBDOMAIN_SECRET  unguessable-path seed for agent surfaces (the nginx
                        subdomain proxy AND the API's /s/{digest}/ surface proxy);
                        set on any reachable deployment. NB the per-agent Control-UI /
                        terminal password is a one-time reveal at creation — reef
                        never stores or recomputes it (see reef.manager.expose).
    REEF_ACCESS_TEAM_DOMAIN  Cloudflare Access team domain → enables operator SSO
    REEF_ACCESS_AUD     Cloudflare Access application AUD tag (paired with the above)
    REEF_API_HOST       bind host (default 127.0.0.1 — the admin plane is private)
    REEF_API_PORT       bind port (default 8787)
    REEF_CORS_ORIGINS   comma-separated UI origins (default: the clawbits web hosts +
                        any localhost port — the browser calls this API over the tunnel)
    REEF_PUBLIC_URL     this API's public URL over your tunnel — echoed in the startup
                        "connect to clawbits" banner (optional; informational only)
    REEF_API_RELOAD     uvicorn auto-reload when set (dev only)
    REEF_VERSION_CHECK  '0' disables outbound "latest version" checks (default on)
    REEF_VERSION_CHECK_TTL  cache TTL (seconds) for latest-version lookups (default 10800)
    REEF_RECONCILE      self-healing loop: '0' disables it (default on)
    REEF_RECONCILE_INTERVAL  seconds between reconcile passes (default 15)
    REEF_RESTART_BACKOFF_BASE / _CAP  crash-loop backoff bounds in seconds (default 10 / 300)
    REEF_RESTART_STABLE_RESET  seconds running before the restart counter resets (default 300)
    REEF_ANTHROPIC_API_KEY / REEF_OPENAI_API_KEY / REEF_GEMINI_API_KEY /
    REEF_NEARAI_API_KEY / REEF_OPENROUTER_API_KEY  maintainer-level model keys
                        forwarded into agent VMs at create time (the request's
                        ``provider`` field narrows to one; per-request keys win).
                        GET /providers reports presence booleans only - the
                        values never leave the host (see reef.providers).
"""

import asyncio
import contextlib
import logging
import os
from collections.abc import AsyncIterator

import httpx
from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from reef.api.proxy import router as proxy_router
from reef.api.routes import images_router, router
from reef.api.schemas import (
    HealthOut,
    LatestVersionsOut,
    OllamaModelOut,
    OllamaModelsOut,
    OpenRouterModelOut,
    OpenRouterModelsOut,
    ProviderOut,
    ProvidersOut,
    ReconcilerHealth,
    SettingsIn,
    SettingsOut,
)
from reef.api.security import admin_auth
from reef.build_jobs import BuildJobManager
from reef.errors import RuntimeUnavailable, SandboxNotFound
from reef.fleet import FleetService
from reef.manager import SandboxManager
from reef.providers import (
    PROVIDERS,
    fetch_ollama_models,
    fetch_openrouter_models,
    is_configured,
    resolve_ollama_probe_url,
)
from reef.reconciler import Reconciler
from reef.runtime import AdminRuntime
from reef.runtime_factory import default_backend, make_runtime, make_store
from reef.settings import (
    effective_public_url,
    get_public_url_override,
    public_url_env,
    set_public_url_override,
)
from reef.store import SandboxStore
from reef.versions import latest_versions

logger = logging.getLogger("reef.api")


def _configure_logging() -> None:
    """Send ``reef.*`` logs (incl. the reconciler's heals) to stdout/journald at
    ``REEF_LOG_LEVEL`` (default INFO). uvicorn doesn't configure app loggers, so
    without this they're swallowed. Idempotent."""
    root = logging.getLogger("reef")
    root.setLevel(os.getenv("REEF_LOG_LEVEL", "INFO").upper())
    if not root.handlers:
        handler = logging.StreamHandler()
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
        root.addHandler(handler)
        root.propagate = False  # don't double-log through the root logger


def _connect_banner() -> str:
    """How the operator connects THIS Reef to a clawbits org — logged once at
    startup so the admin can find the API URL + admin token without digging.
    Deliberately points to *where* the token lives rather than printing its value
    (secrets stay out of the logs / journald)."""
    host = os.getenv("REEF_API_HOST", "127.0.0.1")
    port = os.getenv("REEF_API_PORT", "8787")
    public = os.getenv("REEF_PUBLIC_URL")
    api = public or (
        f"<your tunnel's URL to this API>  "
        f"(e.g. run:  cloudflared tunnel --url http://{host}:{port})"
    )
    if os.getenv("REEF_ADMIN_TOKEN"):
        token = "REEF_ADMIN_TOKEN from your env file (e.g. /etc/reef/reef.env)"
    elif os.getenv("REEF_ACCESS_TEAM_DOMAIN") and os.getenv("REEF_ACCESS_AUD"):
        token = "Cloudflare Access — no token to paste"
    else:
        token = "OPEN — set REEF_ADMIN_TOKEN before exposing this API"
    return (
        "To connect this Reef to a clawbits org (in clawbits: Settings -> Reef):\n"
        f"    API URL : {api}\n"
        f"    Token   : {token}"
    )


def _cors_config() -> tuple[list[str], str | None]:
    """(allow_origins, allow_origin_regex) for the CORS middleware.

    Default-allow the clawbits app (the browser talks to this API *directly*
    over the owner's tunnel — clawbits' backend never connects). This must cover
    EVERY first-party clawbits surface that reaches a reef, since each presents
    its own browser Origin and reef gates on it:
      - the web app (prod + staging + local Vite dev)
      - the desktop app (Tauri webview): a built app's origin is
        ``tauri://localhost`` (macOS/Windows) / ``http://tauri.localhost``
        (Linux); ``bun run dev`` serves it from a Vite port.
    Dev servers land on whatever port is free (5173/5174/5176, …), so any
    localhost/loopback port is allowed by regex rather than pinned — an Origin
    of ``http://localhost:*`` can only come from a page served on that machine.
    Setting REEF_CORS_ORIGINS replaces ALL of this (list and regex) with the
    explicit set.
    """
    raw = os.getenv("REEF_CORS_ORIGINS")
    if raw:
        return [o.strip() for o in raw.split(",") if o.strip()], None
    return [
        # Both the apex and app.* are listed while the app migrates off the
        # apex. A UNION, not a swap: the browser Origin is whichever host served
        # the SPA, and during the cutover that can be either. Dropping the apex
        # entries early makes every reef panel read "Offline" (the API is fine —
        # it is the preflight that fails), which is a misleading symptom that
        # sends you debugging the tunnel. Drop them once the apex serves only
        # the marketing site.
        "https://app.clawbits.ai",
        "https://app.freeclaws.ai",  # staging web app
        "https://clawbits.ai",
        "https://freeclaws.ai",  # staging web app
        "tauri://localhost",  # Tauri macOS/Windows webview origin
        "http://tauri.localhost",  # Tauri Linux webview origin
    ], r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$"


def _env_float(name: str, default: float) -> float:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _reconciler_from_env(runtime: AdminRuntime, store: SandboxStore) -> Reconciler | None:
    """Build the self-healing reconciler from ``REEF_RECONCILE*`` env, or ``None``
    when disabled (``REEF_RECONCILE=0``)."""
    if os.getenv("REEF_RECONCILE", "1") == "0":
        return None
    return Reconciler(
        runtime,
        store,
        interval=_env_float("REEF_RECONCILE_INTERVAL", 15.0),
        backoff_base=_env_float("REEF_RESTART_BACKOFF_BASE", 10.0),
        backoff_cap=_env_float("REEF_RESTART_BACKOFF_CAP", 300.0),
        stable_reset=_env_float("REEF_RESTART_STABLE_RESET", 300.0),
    )


async def _run_reconciler(reconciler: Reconciler) -> None:
    """Run the loop, restarting it if it ever crashes. ``reconcile_once`` already
    swallows per-cycle errors, but a dead task must not silently end self-healing."""
    while True:
        try:
            await reconciler.run()
            return
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 — keep self-healing alive across an unexpected crash
            logger.exception("reconciler loop crashed; restarting in 5s")
            await asyncio.sleep(5)


@contextlib.asynccontextmanager
async def _lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Run the reconciler loop (when one is configured on ``app.state``) for the
    life of the app. Injected-service apps (tests) attach none → no-op."""
    reconciler: Reconciler | None = getattr(app.state, "reconciler", None)
    task = asyncio.create_task(_run_reconciler(reconciler)) if reconciler is not None else None
    try:
        yield
    finally:
        if task is not None:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        # Cancel any in-flight image build so a restart doesn't leak the task.
        build_jobs: BuildJobManager | None = getattr(app.state, "build_jobs", None)
        if build_jobs is not None:
            await build_jobs.shutdown()
        # The surface proxy's pooled upstream client (created lazily on first use).
        proxy_client = getattr(app.state, "surface_proxy_client", None)
        if proxy_client is not None and not proxy_client.is_closed:
            await proxy_client.aclose()


def create_app(service: FleetService | None = None) -> FastAPI:
    """Build the app. Inject a ``FleetService`` for tests; otherwise the default
    wires the configured runtime (``reef.runtime_factory`` — Docker locally,
    microsandbox on Linux) + the configured store (durable SQLite by default;
    ``REEF_STORE=memory`` for the old ephemeral behavior) + a ``SandboxManager``
    (the create/expose engine, sharing that runtime + store).
    """
    reconciler: Reconciler | None = None
    if service is None:
        runtime = make_runtime()
        store = make_store()
        manager = SandboxManager(runtime, store, backend=default_backend())
        service = FleetService(runtime, store, manager=manager)
        reconciler = _reconciler_from_env(runtime, store)

    app = FastAPI(
        title="Reef Admin / Fleet API",
        version="0.1.0",
        summary="Operator view + lifecycle control over agent microVMs.",
        lifespan=_lifespan,
    )
    app.state.fleet_service = service
    app.state.reconciler = reconciler
    # In-process image-build jobs (the dashboard's Images section). Uses the same
    # runtime the service drives (real or, in tests, the fake).
    app.state.build_jobs = BuildJobManager(service.runtime)
    origins, origin_regex = _cors_config()
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_origin_regex=origin_regex,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(router)
    app.include_router(images_router)
    app.include_router(proxy_router)

    @app.get("/healthz", response_model=HealthOut, tags=["meta"])
    async def healthz(request: Request) -> HealthOut:
        # Liveness + a cheap msb reachability probe + reconciler liveness.
        # Intentionally unauthenticated.
        rec_obj: Reconciler | None = getattr(request.app.state, "reconciler", None)
        rec = ReconcilerHealth(**rec_obj.health()) if rec_obj is not None else None
        try:
            count = len(await service.list_fleet())
        except RuntimeUnavailable:
            return HealthOut(status="degraded", msb_available=False, sandboxes=None, reconciler=rec)
        return HealthOut(status="ok", msb_available=True, sandboxes=count, reconciler=rec)

    @app.get("/versions/latest", response_model=LatestVersionsOut, tags=["meta"])
    async def versions_latest() -> LatestVersionsOut:
        # Latest available versions for the dashboard's "update available" hints.
        # Optional + best-effort + cached (see reef.versions). Unauthenticated.
        return LatestVersionsOut(**await latest_versions())

    @app.get(
        "/providers",
        response_model=ProvidersOut,
        tags=["meta"],
        dependencies=[Depends(admin_auth)],
    )
    async def providers_available() -> ProvidersOut:
        # Which AI providers have a reef-level key (REEF_*_API_KEY) configured -
        # presence booleans ONLY, the values never leave the host. Drives the
        # provider pickers in clawbits + the dashboard; the create request's
        # ``provider`` field then names the pick. Admin-gated (unlike /healthz):
        # it reveals deployment config, and both pickers already hold the token.
        return ProvidersOut(
            providers=[
                ProviderOut(
                    id=p.id,
                    label=p.label,
                    configured=is_configured(p),
                    kind=p.kind,
                    runtimes=list(p.runtimes),
                )
                for p in PROVIDERS
            ],
            # Create-API capabilities: this reef accepts CreateSandboxIn.env and
            # CreateSandboxIn.model. Rides the authed pre-create probe both
            # pickers already call, so a newer clawbits UI can hide a control
            # against an older reef (whose Pydantic would silently drop the field).
            # "env-edit": GET/PATCH /fleet/{id}/env exist. Whether a given AGENT
            # can take a restart apply is ``apply_modes`` on GET /env.
            features=["env", "model", "capabilities", "env-edit"],
        )

    @app.get(
        "/providers/ollama/models",
        response_model=OllamaModelsOut,
        tags=["meta"],
        dependencies=[Depends(admin_auth)],
    )
    async def ollama_models(
        host: str | None = Query(default=None, description="Ollama URL to probe (BYO host)"),
    ) -> OllamaModelsOut:
        # The picker's model dropdown: which models the Ollama server has
        # actually pulled. Probed REEF-side — the operator's browser usually
        # can't reach the host (guest aliases / reef-box loopback / LAN), and
        # reef-process reachability is also the best predictor of what a guest
        # will see. ``host`` omitted ⇒ the maintainer's REEF_OLLAMA_HOST.
        try:
            base = resolve_ollama_probe_url(host)
        except ValueError as e:
            raise HTTPException(status_code=422, detail=str(e)) from None
        try:
            models = await fetch_ollama_models(base)
        except httpx.HTTPError as e:
            raise HTTPException(
                status_code=502, detail=f"can't reach the ollama server: {e}"
            ) from None
        return OllamaModelsOut(models=[OllamaModelOut(**m) for m in models])

    @app.get(
        "/providers/openrouter/models",
        response_model=OpenRouterModelsOut,
        tags=["meta"],
        dependencies=[Depends(admin_auth)],
    )
    async def openrouter_models() -> OpenRouterModelsOut:
        # The picker's OpenRouter catalog: the live public listing, fetched
        # REEF-side to mirror the ollama probe (one admin-gated surface, no
        # per-browser CORS story). Keyless — the listing is public, so there
        # is nothing to configure and no host parameter to validate.
        try:
            models = await fetch_openrouter_models()
        except httpx.HTTPError as e:
            raise HTTPException(status_code=502, detail=f"can't reach openrouter.ai: {e}") from None
        return OpenRouterModelsOut(models=[OpenRouterModelOut(**m) for m in models])

    def _settings_out() -> SettingsOut:
        return SettingsOut(
            public_url_override=get_public_url_override(),
            public_url_env=public_url_env(),
            public_url_effective=effective_public_url(),
        )

    @app.get(
        "/settings",
        response_model=SettingsOut,
        tags=["meta"],
        dependencies=[Depends(admin_auth)],
    )
    async def get_settings() -> SettingsOut:
        # Operator-adjustable settings (today: the public URL override the agent
        # surface links are built on). Admin-gated - it reveals deployment config.
        return _settings_out()

    @app.put(
        "/settings",
        response_model=SettingsOut,
        tags=["meta"],
        dependencies=[Depends(admin_auth)],
    )
    async def put_settings(body: SettingsIn) -> SettingsOut:
        # Pin (or clear, with null/blank) the public URL the surface links use -
        # wins over REEF_PUBLIC_URL, no restart needed. Persisted to settings.json.
        url = (body.public_url or "").strip().rstrip("/")
        if url and not url.lower().startswith(("http://", "https://")):
            raise HTTPException(status_code=422, detail="public_url must be an http(s) URL")
        set_public_url_override(url or None)
        return _settings_out()

    @app.exception_handler(RequestValidationError)
    async def _validation_failed(_request: Request, exc: RequestValidationError) -> JSONResponse:
        """Strip ``input``/``ctx`` from the 422 body: FastAPI echoes the offending
        INPUT back, and both UIs render ``detail`` into a toast - so a mistyped env
        map would put the operator's API key on screen."""
        errors = [
            {k: v for k, v in err.items() if k not in ("input", "ctx")} for err in exc.errors()
        ]
        return JSONResponse(status_code=422, content=jsonable_encoder({"detail": errors}))

    @app.exception_handler(SandboxNotFound)
    async def _not_found(_request: Request, exc: SandboxNotFound) -> JSONResponse:
        return JSONResponse(status_code=404, content={"detail": f"sandbox not found: {exc}"})

    @app.exception_handler(RuntimeUnavailable)
    async def _unavailable(_request: Request, exc: RuntimeUnavailable) -> JSONResponse:
        return JSONResponse(status_code=503, content={"detail": str(exc)})

    return app


app = create_app()


def main() -> None:
    import uvicorn

    _configure_logging()
    # Auth configured means this deployment is meant to be reachable (over a
    # tunnel), so the two surface-URL prerequisites must be set:
    reachable = bool(os.getenv("REEF_ADMIN_TOKEN") or os.getenv("REEF_ACCESS_TEAM_DOMAIN"))
    if reachable and not os.getenv("REEF_SUBDOMAIN_SECRET"):
        # With an empty digest seed the /s/{digest}/ surface paths are derivable
        # from sandbox ids (only each agent's one-time password still guards them).
        logger.warning(
            "REEF_SUBDOMAIN_SECRET is unset - agent surface URLs are guessable; "
            "set it for any reachable deployment (the installer generates one)."
        )
    if reachable and not os.getenv("REEF_PUBLIC_URL"):
        # Surface URLs then fall back to request.base_url; behind a tunnel that
        # can degrade to http://127.0.0.1:<port>/s/… (mixed-content-blocked) when
        # cloudflared omits X-Forwarded-Proto. Set it to this Reef's tunnel origin.
        logger.warning(
            "REEF_PUBLIC_URL is unset - agent Control-UI/terminal links fall back to "
            "the request origin and can break over a tunnel; set it to this Reef's "
            "public URL (e.g. https://reef.example.com, no trailing path)."
        )
    logger.info("%s", _connect_banner())
    uvicorn.run(
        "reef.api.app:app",
        host=os.getenv("REEF_API_HOST", "127.0.0.1"),
        port=int(os.getenv("REEF_API_PORT", "8787")),
        reload=bool(os.getenv("REEF_API_RELOAD")),
        # Reef shells out to msb/docker. uvloop can leave an msb subprocess
        # communicate() stuck after the sandbox is already created, which makes
        # POST /fleet hang while the agent shows up live. Use stdlib asyncio.
        loop="asyncio",
        # Trust X-Forwarded-* only from the loopback tunnel client (cloudflared
        # runs on-box and connects to this loopback bind). This corrects the
        # request scheme for the REEF_PUBLIC_URL-unset fallback path (e.g. a quick
        # dev `cloudflared tunnel --url`). uvicorn already defaults to these, but
        # pin them so the trust boundary is explicit. NEVER widen to '*' — that
        # would let any client spoof X-Forwarded-* if the bind ever left loopback.
        proxy_headers=True,
        forwarded_allow_ips=os.getenv("FORWARDED_ALLOW_IPS", "127.0.0.1"),
    )


if __name__ == "__main__":
    main()
