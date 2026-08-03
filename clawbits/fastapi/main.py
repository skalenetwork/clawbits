# clawbits/fastapi/main.py
import asyncio
import os
import threading
from contextlib import asynccontextmanager

import uvicorn

# Load environment variables
from dotenv import load_dotenv
from fastapi import HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from clawbits.cloudflare.setup_r2 import provision_r2_on_startup
from clawbits.fastapi.avatar_endpoints import avatar_router
from clawbits.fastapi.clawbits_server import ClawBitsServer
from clawbits.fastapi.connectors_endpoints import connectors_router
from clawbits.fastapi.contact_permissions_endpoints import (
    contact_permissions_router,
)
from clawbits.fastapi.dev_auth import dev_auth_router
from clawbits.fastapi.human_endpoints import human_router
from clawbits.fastapi.human_mm_endpoints import (
    human_mm_router,
    user_presence_expiry_watcher,
)
from clawbits.fastapi.push_endpoints import push_router
from clawbits.fastapi.trace_endpoints import trace_router
from clawbits.fastapi.workos_auth import workos_router
from clawbits.realtime import (
    init_bus,
    shutdown_bus,
    start_push_dispatcher,
    stop_push_dispatcher,
)

load_dotenv()

# Custom FileResponse with cache-busting headers
class NoCacheFileResponse(FileResponse):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        # Add cache-busting headers
        self.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        self.headers["Pragma"] = "no-cache"
        self.headers["Expires"] = "0"

# Custom StaticFiles with cache-busting headers
class NoCacheStaticFiles(StaticFiles):
    async def get_response(self, path: str, scope) -> Response:
        response = await super().get_response(path, scope)
        # Add cache-busting headers to all static file responses
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
        return response


@asynccontextmanager
async def lifespan(server: ClawBitsServer):
    # --- Startup ---
    print("🚀 Clawbits server starting up...")

    # All auth-related boot checks (dev-auth gate, refresh single-flight
    # Redis readiness, auth-log banner) run from one place. Refuses to
    # boot if dev-auth is misconfigured; otherwise just logs.
    from clawbits.fastapi.workos_auth import auth_preflight

    auth_preflight()

    server._connect_db()
    init_bus()

    # LobsterTalk attention gate warm-up. The encoder build (one-time ~67MB
    # FastEmbed download + embedding the route utterances) is lazy; without
    # this it runs inside the *first* post's background task, so a missing
    # dep / blocked download surfaces minutes later as one mid-traffic
    # warning. Warming here puts "gate ready" / "gate disabled" in the boot
    # log. A plain daemon thread rather than asyncio.to_thread: a hung
    # download must not block executor join on shutdown (dev --reload).
    #
    # The feature is now org-toggled (no env flag), so warm only when at least
    # one org has armed it in a gate-using mode — a server no org uses (or
    # whose orgs are all llm_only, which never embeds) skips the download
    # entirely. A DB hiccup here must not block boot: fall back to no warm
    # (the gate still builds lazily on the first post from an enabled org).
    import logging as _logging

    from sqlmodel import Session as _Session

    from clawbits.db.table_read import TableRead as _TableRead
    from clawbits.lobstertalk.attention.gate import get_gate as _warm_attention_gate

    _warm_attention = False
    try:
        with _Session(server._engine) as _db:
            _warm_attention = _TableRead.any_org_attention_needs_gate(_db)
    except Exception:
        _logging.warning("attention gate warm-up check failed; skipping boot warm", exc_info=True)
    if _warm_attention:
        print("🔎 LobsterTalk attention gate enabled for an org — warming encoder in background")
        threading.Thread(
            target=_warm_attention_gate, name="attention-gate-warmup", daemon=True
        ).start()

    # Provision Cloudflare R2 resources
    try:
        server._r2_provisioner, server._r2_client = await provision_r2_on_startup(
            server._r2_provisioner, server._r2_client
        )
        print("✅ R2 provisioning completed")
    except Exception as e:
        print(f"⚠️ R2 provisioning failed (continuing anyway): {e}")

    # Avatars R2 auth health check. A bad/expired CLOUDFLARE_API_TOKEN makes
    # every avatar upload 401 *silently*, so new agents/users stay stuck on the
    # initial-letter placeholder with no obvious cause. Surface it loudly at
    # boot. Read-only probe against the dedicated avatars bucket (which the
    # legacy provisioning test above never checks); never blocks startup.
    try:
        from clawbits.avatars.config import make_avatars_r2_client

        av_client = make_avatars_r2_client()
        av_health = await av_client.check_access()
        if av_health.get("success"):
            print(f"✅ Avatars R2 auth OK (bucket={av_client.bucket_name})")
        else:
            print(
                "❌ Avatars R2 auth FAILED — generated avatars will NOT upload; new "
                "agents/users fall back to the letter placeholder until fixed.\n"
                f"   bucket={av_client.bucket_name} "
                f"status={av_health.get('status') or ''} detail={av_health.get('error')}\n"
                "   Fix: set valid R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY (R2 → Manage "
                "R2 API Tokens → S3 Compatibility) and restart, then run "
                "`python -m clawbits.avatars.backfill` to heal existing rows."
            )
    except Exception as e:
        print(f"⚠️ Avatars R2 auth check skipped: {e}")

    # DiceBear generator health check. Avatar SVGs are fetched from DICEBEAR_BASE
    # (a self-hosted sidecar by default). If it's unreachable, new avatars fall
    # back to the letter placeholder — surface it at boot. Never blocks startup.
    try:
        import httpx as _httpx

        from clawbits.avatars.service import AGENT_STYLE, DICEBEAR_BASE

        async with _httpx.AsyncClient(timeout=5.0) as _c:
            _r = await _c.get(
                f"{DICEBEAR_BASE}/{AGENT_STYLE}/svg", params={"seed": "healthcheck"}
            )
        if _r.status_code == 200:
            print(f"✅ DiceBear generator OK ({DICEBEAR_BASE})")
        else:
            print(
                f"❌ DiceBear generator returned {_r.status_code} at {DICEBEAR_BASE} — "
                "new avatars will fall back to the letter placeholder."
            )
    except Exception as e:
        print(
            f"❌ DiceBear generator unreachable ({os.getenv('DICEBEAR_BASE', 'default')}): "
            f"{e} — new avatars will fall back to the letter placeholder."
        )

    # Background task: turn Redis user_presence key expirations into
    # user.status: offline broadcasts. Without this, a tab dying too
    # fast for sendBeacon('offline') to fire leaves the user marked
    # online on every other viewer until they refresh the page.
    expiry_task = asyncio.create_task(user_presence_expiry_watcher(server._engine))

    # Background task: replay LobsterTalk posts that landed during an active
    # (agent, channel) cooldown. Without this a window-blocked question is
    # simply lost unless someone re-asks after the cooldown; the watcher
    # bridges the cooldown key's Redis expiry to a deferred attention pass
    # for the newest such post. See attention/service.py.
    from clawbits.lobstertalk.attention.service import attention_cooldown_catchup_watcher

    attention_catchup_task = asyncio.create_task(
        attention_cooldown_catchup_watcher(server._engine)
    )

    # Background task: reap streaming posts abandoned by a crashed agent.
    # Without this a stuck `streaming` row pins the agent's "generating…"
    # pill forever and freezes watermark-based consumers (the IronClaw
    # channel stops delivering everything after it). See mm_maintenance.py.
    from clawbits.fastapi.mm_maintenance import streaming_post_expiry_watcher

    streaming_reaper_task = asyncio.create_task(
        streaming_post_expiry_watcher(server._engine)
    )

    # Background worker: drains the web-push queue and fans new posts out to
    # browsers off the request/threadpool path (see web_push.schedule_post_web_push).
    # No-op when VAPID isn't configured.
    start_push_dispatcher()

    print("✅ Clawbits server startup complete!")
    yield
    # --- Shutdown ---
    print("🛑 Clawbits server shutting down...")
    expiry_task.cancel()
    try:
        await expiry_task
    except (asyncio.CancelledError, Exception):
        pass
    attention_catchup_task.cancel()
    try:
        await attention_catchup_task
    except (asyncio.CancelledError, Exception):
        pass
    streaming_reaper_task.cancel()
    try:
        await streaming_reaper_task
    except (asyncio.CancelledError, Exception):
        pass
    await stop_push_dispatcher()
    await shutdown_bus()
    server.shutdown()
    print("✅ Clawbits server shutdown complete.")


app = ClawBitsServer(lifespan=lifespan)

# Error handler for consistent error formatting
@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    return JSONResponse(
        status_code=exc.status_code,
        content={
            "error": True,
            "status_code": exc.status_code,
            "detail": exc.detail,
            "path": str(request.url.path)
        }
    )

# CORS Middleware (Defined before routers).
# Tauri webviews use a special URL scheme so the desktop build needs its own
# entries: tauri://localhost on macOS/Windows, http://tauri.localhost on Linux.
# `CLAWBITS_CORS_EXTRA` is a comma-separated list of additional origins for
# staging/prod web hosts (e.g. https://clawbits.ai,https://freeclaws.ai).
_default_cors_origins = [
    "http://localhost:5173",  # web dev
    "http://localhost:8000",  # backend self-call
    "http://localhost:5176",  # Tauri dev Vite (dedicated port)
    "tauri://localhost",      # Tauri macOS/Windows webview origin
    "http://tauri.localhost", # Tauri Linux webview origin
]
_extra_cors_origins = [
    o.strip()
    for o in os.environ.get("CLAWBITS_CORS_EXTRA", "").split(",")
    if o.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_default_cors_origins + _extra_cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Cache-busting middleware for all responses. The session-cookie write
# middleware is installed in ``ClawBitsServer.__init__`` so it ships with
# the app class, not just this entry point — see ``clawbits_server.py``.
@app.middleware("http")
async def add_cache_control_headers(request: Request, call_next):
    response = await call_next(request)
    # Add cache-control headers to all responses
    response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response

# --- API Routes ---
app.include_router(workos_router)
app.include_router(dev_auth_router)
app.include_router(human_router)
app.include_router(connectors_router)
app.include_router(avatar_router)
app.include_router(human_mm_router)
app.include_router(contact_permissions_router)
app.include_router(push_router)
# Standalone trace viewer (sink + read API + /trace page). Registered before
# the SPA catch-all below so its explicit routes win.
app.include_router(trace_router)

# ---------------------------------------------------------------------------
# Serve the React SPA (built into frontend/dist)
# ---------------------------------------------------------------------------
_FRONTEND_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "frontend", "dist"))
_INDEX_HTML = os.path.join(_FRONTEND_DIR, "index.html")

if os.path.isdir(_FRONTEND_DIR):
    # 1. Specific assets mounting (JS/CSS) with cache-busting
    _ASSETS_DIR = os.path.join(_FRONTEND_DIR, "assets")
    if os.path.isdir(_ASSETS_DIR):
        app.mount("/assets", NoCacheStaticFiles(directory=_ASSETS_DIR), name="frontend-assets")


    # 2. Hard redirect from "/" to "/login"

    @app.get("/", include_in_schema=False)
    async def root():
        # Let the Frontend decide if we need to go to /login or /feed
        return NoCacheFileResponse(_INDEX_HTML)

    # 3. Serve favicon explicitly
    @app.get("/favicon.svg", include_in_schema=False)
    @app.head("/favicon.svg", include_in_schema=False)
    async def spa_favicon():
        fav = os.path.join(_FRONTEND_DIR, "favicon.svg")
        if os.path.isfile(fav):
            return NoCacheFileResponse(fav)
        return NoCacheFileResponse(_INDEX_HTML)


    # 4. Universal SPA Catch-all
    @app.get("/{rest_of_path:path}", include_in_schema=False)
    @app.head("/{rest_of_path:path}", include_in_schema=False)
    async def spa_catch_all(request: Request, rest_of_path: str = ""):
        # Prevent the SPA from masking broken backend routes
        api_prefixes = ("api/", "human/", "agentic/", "agents/", "auth/", "shared_content/", "posts/")
        if any(rest_of_path.startswith(p) for p in api_prefixes):
            raise HTTPException(status_code=404, detail="API Route Not Found")

        # Try to serve physical static files first (robots.txt, etc.)
        static_file = os.path.join(_FRONTEND_DIR, rest_of_path)
        if os.path.isfile(static_file):
            return NoCacheFileResponse(static_file)

        # Only serve SPA for known frontend routes or empty paths
        # This prevents random endpoints from falling through to the SPA
        frontend_routes = (
            "login", "register", "feed", "agents", "settings",
            "terms", "privacy", "verify-email",
            "townsquare", "home", "members", "channels",
        )
        # Fallback to SPA index.html so React Router can take over
        if (
            rest_of_path == "" or rest_of_path.startswith(frontend_routes)
        ) and os.path.isfile(_INDEX_HTML):
            return NoCacheFileResponse(_INDEX_HTML)

        # For any other path, return 404
        raise HTTPException(status_code=404, detail="Endpoint not found")

# Run the app directly
if __name__ == "__main__":
    uvicorn.run("clawbits.fastapi.main:app", host="0.0.0.0", port=8000, reload=True)
