"""HTTP endpoints for avatar upload + reset.

POST   /api/human/avatars/users/me/upload       set the caller's custom avatar
DELETE /api/human/avatars/users/me              revert to the generated default
POST   /api/human/avatars/orgs/{org_id}/upload  set the org avatar, admins only
DELETE /api/human/avatars/orgs/{org_id}         remove the org avatar, admins only
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile

from clawbits.avatars import AvatarKind, ensure_user_avatar
from clawbits.avatars.config import CURRENT_AVATAR_VERSION, make_avatars_r2_client
from clawbits.avatars.payloads import avatar_ref_for_org, avatar_ref_for_user
from clawbits.avatars.storage import org_avatar_object_key, user_avatar_object_key
from clawbits.avatars.upload import (
    ACCEPTED_CONTENT_TYPES,
    AvatarProcessError,
    process_uploaded_avatar,
    upload_avatar_to_r2,
)
from clawbits.datastructures.avatar_models import AvatarRef
from clawbits.db.models import HumanUser, Organization
from clawbits.fastapi.human_endpoints import _get_db, _require_org_owner
from clawbits.fastapi.workos_auth import get_current_human_user

logger = logging.getLogger(__name__)

MAX_UPLOAD_BYTES = 5 * 1024 * 1024

avatar_router = APIRouter(tags=["Human", "Avatars"])


class _AvatarResponse(AvatarRef):
    """Names the response schema apart from the embedded ``avatar`` field."""


async def _processed_upload(file: UploadFile) -> bytes:
    if file.content_type and file.content_type not in ACCEPTED_CONTENT_TYPES:
        raise HTTPException(
            status_code=415,
            detail=(
                f"unsupported content-type {file.content_type!r}; "
                f"accepted: {', '.join(sorted(ACCEPTED_CONTENT_TYPES))}"
            ),
        )
    raw = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(raw) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"file exceeds {MAX_UPLOAD_BYTES // (1024 * 1024)}MB limit",
        )
    if not raw:
        raise HTTPException(status_code=400, detail="empty upload")
    try:
        return process_uploaded_avatar(raw)
    except AvatarProcessError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


async def _store(object_key: str, processed: bytes) -> None:
    try:
        await upload_avatar_to_r2(object_key=object_key, processed_bytes=processed)
    except Exception as exc:
        logger.exception("avatar upload failed for %s", object_key)
        raise HTTPException(status_code=502, detail="avatar storage failed") from exc


@avatar_router.post(
    "/api/human/avatars/users/me/upload",
    response_model=_AvatarResponse,
    summary="Upload a custom avatar for the current user",
)
async def upload_my_avatar(
    request: Request,
    file: UploadFile = File(..., description="PNG / JPEG / WebP / GIF, ≤5 MB"),
    user: dict = Depends(get_current_human_user),
) -> AvatarRef:
    processed = await _processed_upload(file)
    user_id = int(user["id"])
    with _get_db(request) as db:
        row = db.get(HumanUser, user_id)
        if row is None:
            raise HTTPException(status_code=404, detail="user not found")
        next_version = max(row.avatar_version, CURRENT_AVATAR_VERSION) + 1
        await _store(user_avatar_object_key(user_id, next_version, kind="uploaded"), processed)
        row.avatar_kind = AvatarKind.UPLOADED.value
        row.avatar_version = next_version
        db.commit()

    return avatar_ref_for_user(
        user_id=user_id,
        version=next_version,
        kind=AvatarKind.UPLOADED.value,
    )


@avatar_router.delete(
    "/api/human/avatars/users/me",
    response_model=_AvatarResponse,
    summary="Reset the current user's avatar to the generated default",
)
async def reset_my_avatar(
    request: Request,
    user: dict = Depends(get_current_human_user),
) -> AvatarRef:
    user_id = int(user["id"])
    with _get_db(request) as db:
        row = db.get(HumanUser, user_id)
        if row is None:
            raise HTTPException(status_code=404, detail="user not found")
        next_version = max(row.avatar_version, CURRENT_AVATAR_VERSION) + 1
        r2 = make_avatars_r2_client()
        try:
            await ensure_user_avatar(
                r2,
                user_id=user_id,
                version=next_version,
                kind=AvatarKind.GENERATED,
            )
        except Exception as exc:
            logger.exception("avatar reset failed for user %s", user_id)
            raise HTTPException(status_code=502, detail="avatar regeneration failed") from exc

        row.avatar_kind = AvatarKind.GENERATED.value
        row.avatar_version = next_version
        db.commit()

    return avatar_ref_for_user(
        user_id=user_id,
        version=next_version,
        kind=AvatarKind.GENERATED.value,
    )


@avatar_router.post(
    "/api/human/avatars/orgs/{org_id}/upload",
    response_model=_AvatarResponse,
    summary="Upload the organization avatar",
)
async def upload_org_avatar(
    org_id: str,
    request: Request,
    file: UploadFile = File(..., description="PNG / JPEG / WebP / GIF, ≤5 MB"),
    user: dict = Depends(get_current_human_user),
) -> AvatarRef:
    processed = await _processed_upload(file)
    with _get_db(request) as db:
        _require_org_owner(db, org_id, user, "change the organization picture")
        row = db.get(Organization, org_id)
        if row is None:
            raise HTTPException(status_code=404, detail="Organization not found")
        next_version = (row.avatar_version or 0) + 1
        await _store(org_avatar_object_key(org_id, next_version), processed)
        row.avatar_version = next_version
        db.commit()

    return avatar_ref_for_org(org_id=org_id, version=next_version)


@avatar_router.delete(
    "/api/human/avatars/orgs/{org_id}",
    status_code=204,
    summary="Remove the organization avatar",
)
def remove_org_avatar(
    org_id: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
) -> None:
    with _get_db(request) as db:
        _require_org_owner(db, org_id, user, "change the organization picture")
        row = db.get(Organization, org_id)
        if row is None:
            raise HTTPException(status_code=404, detail="Organization not found")
        row.avatar_version = None
        db.commit()
