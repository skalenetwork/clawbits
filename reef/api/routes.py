"""The ``/fleet`` endpoints — list, detail, metrics, logs, lifecycle control.

Every route is guarded by ``admin_auth``. Errors map via app-level handlers:
``SandboxNotFound`` -> 404, ``RuntimeUnavailable`` -> 503 (see ``app.py``).
"""

import logging

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from reef.api.proxy import is_loopback_url, proxied_surface_url
from reef.api.schemas import (
    AccessOut,
    ActionOut,
    ActivateImageIn,
    BuildImageIn,
    BuildJobOut,
    CreateSandboxIn,
    CreateSandboxOut,
    EnvApplyOut,
    EnvOut,
    EnvPatchIn,
    FleetEntryOut,
    ImageOut,
    ImageStatusOut,
    LogsOut,
    PatchSandboxIn,
    SandboxDetailOut,
    SandboxPatchOut,
    access_out,
    build_image_spec,
    build_job_out,
    env_apply_out,
    env_out,
    fleet_entry_out,
    image_out,
    sandbox_detail_out,
)
from reef.api.security import admin_auth, require_configured_auth
from reef.build_jobs import BuildJobManager
from reef.errors import BuildInProgress, RuntimeUnavailable, SandboxBusy
from reef.fleet import FleetService
from reef.runtime import SandboxState
from reef.settings import effective_public_url

logger = logging.getLogger("reef.api.fleet")

router = APIRouter(prefix="/fleet", tags=["fleet"], dependencies=[Depends(admin_auth)])


def get_service(request: Request) -> FleetService:
    return request.app.state.fleet_service


def _publicize_access(access: AccessOut | None, sandbox_id: str, request: Request) -> None:
    """Loopback access URLs (what ``DirectPortExposure`` mints) are meaningless
    beyond the Reef host — swap them for surface-proxy URLs (``/s/{digest}/``,
    see ``reef.api.proxy``) built on the public origin of THIS Reef, so the one
    hostname the operator already uses carries every agent surface too.
    Publicly-minted URLs (the nginx subdomain proxy) pass through untouched.

    Base origin: the operator override or ``REEF_PUBLIC_URL`` when either is set
    (the canonical tunnel origin, see ``reef.settings.effective_public_url``),
    else ``request.base_url``. In prod the API binds loopback behind a Cloudflare
    tunnel; uvicorn's ProxyHeadersMiddleware rewrites only the scheme (from
    ``X-Forwarded-Proto``) and never Host, so if cloudflared omits that header the
    swapped URL silently degrades to ``http://127.0.0.1:<port>/s/…`` and the
    browser blocks it as mixed content. Pinning the public URL makes the origin
    deterministic and tunnel-header-independent; with neither set (dev) it keeps
    using the request origin (``localhost``/a quick ``cloudflared --url``)."""
    if access is None:
        return
    base = effective_public_url() or str(request.base_url)
    if is_loopback_url(access.url):
        access.url = proxied_surface_url(base, sandbox_id, "ui")
    if is_loopback_url(access.terminal_url):
        access.terminal_url = proxied_surface_url(base, sandbox_id, "terminal")


def _parse_state(state: str | None) -> SandboxState | None:
    if not state:
        return None
    try:
        return SandboxState(state)
    except ValueError:
        valid = ", ".join(s.value for s in SandboxState)
        raise HTTPException(
            status_code=422, detail=f"invalid state '{state}'; expected one of: {valid}"
        ) from None


@router.get("", response_model=list[FleetEntryOut])
async def list_fleet(
    state: str | None = Query(default=None, description="filter by lifecycle state"),
    service: FleetService = Depends(get_service),
) -> list[FleetEntryOut]:
    entries = await service.list_fleet(state=_parse_state(state))
    return [fleet_entry_out(e) for e in entries]


@router.post("", response_model=CreateSandboxOut, status_code=201)
async def create_sandbox(
    body: CreateSandboxIn, request: Request, service: FleetService = Depends(get_service)
) -> CreateSandboxOut:
    try:
        sandbox, exposure = await service.create(
            body.type,
            image=body.image,
            name=body.name,
            cpus=body.cpus,
            memory_mib=body.memory_mib,
            org_id=body.org_id,
            clawbits_url=body.clawbits_url,
            signup_token=body.signup_token,
            openai_api_key=body.openai_api_key,
            anthropic_api_key=body.anthropic_api_key,
            gemini_api_key=body.gemini_api_key,
            nearai_api_key=body.nearai_api_key,
            openrouter_api_key=body.openrouter_api_key,
            ollama_host=body.ollama_host,
            provider=body.provider,
            model=body.model,
            restart_policy=body.restart_policy,
            capabilities=body.capabilities,
            env=body.env,
        )
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from None
    out = CreateSandboxOut(
        sandbox_id=sandbox.sandbox_id,
        state=sandbox.state.value,
        agent_type=sandbox.profile,
        access=AccessOut(
            kind=sandbox.profile,
            url=exposure.url,
            password=exposure.password or None,
            terminal_url=exposure.terminal_url,
        ),
    )
    _publicize_access(out.access, sandbox.sandbox_id, request)
    return out


@router.get("/{sandbox_id}", response_model=SandboxDetailOut)
async def get_sandbox(
    sandbox_id: str, request: Request, service: FleetService = Depends(get_service)
) -> SandboxDetailOut:
    out = sandbox_detail_out(await service.get_detail(sandbox_id))
    _publicize_access(out.access, sandbox_id, request)
    return out


@router.post("/{sandbox_id}/reveal", response_model=AccessOut)
async def reveal_access(
    sandbox_id: str, request: Request, service: FleetService = Depends(get_service)
) -> AccessOut:
    """Re-reveal an exposed agent's access secret (surface URL + password).

    Reef mints the dashboard/gateway password ONCE at creation and never returns
    it again — the detail view (``GET /fleet/{id}``) deliberately yields
    ``password=None``. An operator who lost that one-time secret would otherwise
    have to destroy + recreate the agent. This admin-gated endpoint reads it back
    out of the running guest's env instead. POST (not GET): it is an explicit
    action and its response carries a secret, so it must never be cached. 404
    when the agent isn't exposed or its type has no revealable secret."""
    access = access_out(await service.reveal_access(sandbox_id))
    if access is None or access.password is None:
        raise HTTPException(status_code=404, detail="no revealable access for this agent")
    _publicize_access(access, sandbox_id, request)
    return access


@router.get("/{sandbox_id}/logs", response_model=LogsOut)
async def get_logs(
    sandbox_id: str,
    tail: int = Query(default=200, ge=1, le=10_000),
    since: str | None = Query(default=None, description="RFC3339 timestamp or relative like '5m'"),
    service: FleetService = Depends(get_service),
) -> LogsOut:
    text = await service.logs(sandbox_id, tail=tail, since=since)
    return LogsOut(sandbox_id=sandbox_id, lines=text.splitlines())


@router.post("/{sandbox_id}/start", response_model=ActionOut)
async def start_sandbox(sandbox_id: str, service: FleetService = Depends(get_service)) -> ActionOut:
    """Start the agent - or, when reef holds its record but its container is gone,
    rebuild it on its CURRENT image, reusing its volumes and port forwards."""
    try:
        state = await service.start(sandbox_id)
    except SandboxBusy as e:
        raise HTTPException(status_code=409, detail=str(e)) from None
    return ActionOut(sandbox_id=sandbox_id, state=state.value)


@router.post("/{sandbox_id}/stop", response_model=ActionOut)
async def stop_sandbox(sandbox_id: str, service: FleetService = Depends(get_service)) -> ActionOut:
    state = await service.stop(sandbox_id)
    return ActionOut(sandbox_id=sandbox_id, state=state.value)


@router.post("/{sandbox_id}/restart", response_model=ActionOut)
async def restart_sandbox(
    sandbox_id: str, service: FleetService = Depends(get_service)
) -> ActionOut:
    try:
        state = await service.restart(sandbox_id)
    except SandboxBusy as e:
        raise HTTPException(status_code=409, detail=str(e)) from None
    return ActionOut(sandbox_id=sandbox_id, state=state.value)


@router.post("/{sandbox_id}/upgrade", response_model=ActionOut)
async def upgrade_sandbox(
    sandbox_id: str, service: FleetService = Depends(get_service)
) -> ActionOut:
    """Recreate the agent on the newest image (the active tag) in place.

    The named volumes, the public URL and the access password carry over. The
    container rootfs does not: ``~/.openclaw`` (config, sessions, sqlite, device
    identity) and any post-boot-installed skill are lost, and a fresh onboard
    re-pins the model. Not lossless."""
    try:
        rec = await service.upgrade(sandbox_id)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from None
    except SandboxBusy as e:
        raise HTTPException(status_code=409, detail=str(e)) from None
    return ActionOut(sandbox_id=sandbox_id, state=rec.state.value)


@router.get(
    "/{sandbox_id}/env",
    response_model=EnvOut,
    dependencies=[Depends(require_configured_auth)],
)
async def get_env(sandbox_id: str, service: FleetService = Depends(get_service)) -> EnvOut:
    """The agent's own guest env vars: key names + value LENGTHS, never values.

    There is deliberately no reveal counterpart: it would make one stolen admin
    token yield every credential in the fleet in a single request."""
    return env_out(await service.get_env(sandbox_id))


@router.patch(
    "/{sandbox_id}/env",
    response_model=EnvApplyOut,
    dependencies=[Depends(require_configured_auth)],
)
async def patch_env(
    sandbox_id: str,
    body: EnvPatchIn,
    request: Request,
    service: FleetService = Depends(get_service),
) -> EnvApplyOut:
    """Set/unset the agent's own guest env vars and apply the change.

    Keys and values ride in the BODY, never the path or a query string, which the
    uvicorn access log and the admin-ui proxy log both keep a copy of."""
    try:
        result = await service.set_env(
            sandbox_id,
            set_vars=body.set,
            unset_keys=body.unset,
            apply=body.apply,
            tiers=body.tiers,
        )
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from None
    except SandboxBusy as e:
        raise HTTPException(status_code=409, detail=str(e)) from None
    # Key names and value LENGTHS only, never a value.
    logger.info(
        "env update %s by %s: set=%s unset=%s lengths=%s applied=%s",
        sandbox_id,
        getattr(request.state, "operator", "anonymous"),
        sorted(body.set),
        sorted(body.unset),
        {k: len(v) for k, v in sorted(body.set.items())},
        result.applied,
    )
    return env_apply_out(result)


@router.patch("/{sandbox_id}", response_model=SandboxPatchOut)
async def patch_sandbox(
    sandbox_id: str, body: PatchSandboxIn, service: FleetService = Depends(get_service)
) -> SandboxPatchOut:
    try:
        rec = await service.update_settings(
            sandbox_id,
            color=body.color,
            restart_policy=body.restart_policy,
            capabilities=body.capabilities,
        )
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from None
    return SandboxPatchOut(
        sandbox_id=rec.sandbox_id,
        color=rec.color,
        restart_policy=rec.restart_policy.value if rec.restart_policy else None,
        capabilities=list(rec.capabilities),
    )


@router.delete("/{sandbox_id}", status_code=204)
async def destroy_sandbox(sandbox_id: str, service: FleetService = Depends(get_service)) -> None:
    await service.destroy(sandbox_id)


# ── Images (build / list / activate agent images) ─────────────────────────────
images_router = APIRouter(prefix="/images", tags=["images"], dependencies=[Depends(admin_auth)])


def get_build_jobs(request: Request) -> BuildJobManager:
    return request.app.state.build_jobs


@images_router.get("", response_model=list[ImageOut])
async def list_images(service: FleetService = Depends(get_service)) -> list[ImageOut]:
    return [image_out(i) for i in await service.list_images()]


@images_router.get("/status", response_model=ImageStatusOut)
async def image_status(service: FleetService = Depends(get_service)) -> ImageStatusOut:
    """Per-runtime build signal: the active image's baked versions joined with the
    latest floors + a server-computed ``build_available`` (active strictly behind).
    The client renders the boolean + the from→to versions and no longer does semver."""
    return ImageStatusOut(**await service.image_status())


@images_router.post("/builds", response_model=BuildJobOut, status_code=201)
async def start_build(
    body: BuildImageIn, jobs: BuildJobManager = Depends(get_build_jobs)
) -> BuildJobOut:
    try:
        job = await jobs.start(build_image_spec(body))
    except BuildInProgress as e:
        raise HTTPException(status_code=409, detail=str(e)) from None
    return build_job_out(job)


@images_router.get("/builds", response_model=list[BuildJobOut])
async def list_builds(jobs: BuildJobManager = Depends(get_build_jobs)) -> list[BuildJobOut]:
    return [build_job_out(j) for j in jobs.list()]


@images_router.get("/builds/{job_id}", response_model=BuildJobOut)
async def get_build(job_id: str, jobs: BuildJobManager = Depends(get_build_jobs)) -> BuildJobOut:
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="build job not found")
    return build_job_out(job)


@images_router.post("/activate", status_code=204)
async def activate_image(
    body: ActivateImageIn, service: FleetService = Depends(get_service)
) -> None:
    try:
        await service.activate_image(body.tag)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from None
    except RuntimeUnavailable as e:
        raise HTTPException(status_code=502, detail=str(e)) from None
