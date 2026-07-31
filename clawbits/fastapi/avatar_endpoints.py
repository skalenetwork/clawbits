"""HTTP endpoints for user avatar upload + reset.

POST /api/human/avatars/users/me/upload   — multipart, set custom avatar
DELETE /api/human/avatars/users/me        — revert to generated default

Only one-per-self for now. Org-admin upload of other users' avatars
isn't a real product need yet and adds an authz surface that's better
defined when we actually want it.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile

from clawbits.avatars import AvatarKind, ensure_user_avatar
from clawbits.avatars.config import CURRENT_AVATAR_VERSION, make_avatars_r2_client
from clawbits.avatars.payloads import avatar_ref_for_user
from clawbits.avatars.upload import (
    ACCEPTED_CONTENT_TYPES,
    AvatarProcessError,
    process_uploaded_avatar,
    upload_user_avatar_to_r2,
)
from clawbits.datastructures.avatar_models import AvatarRef
from clawbits.db.models import HumanUser
from clawbits.fastapi.human_endpoints import _get_db, get_current_human_user

logger = logging.getLogger(__name__)

# 5 MB — covers any sensible profile picture, rejects accidental
# 4K raw uploads before we bother decoding them.
MAX_UPLOAD_BYTES = 5 * 1024 * 1024

avatar_router = APIRouter(tags=["Human", "Avatars"])


class _AvatarResponse(AvatarRef):
    """Thin wrapper around AvatarRef for OpenAPI to name the schema.

    Keeps the response model distinct from the embedded ``avatar``
    field on user/agent/channel payloads, which is convenient for
    SDK generators downstream.
    """


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
    if file.content_type and file.content_type not in ACCEPTED_CONTENT_TYPES:
        raise HTTPException(
            status_code=415,
            detail=(
                f"unsupported content-type {file.content_type!r}; "
                f"accepted: {', '.join(sorted(ACCEPTED_CONTENT_TYPES))}"
            ),
        )

    # Read with a hard cap so a malicious client can't OOM us by
    # streaming a 10GB file. ``UploadFile.read`` returns the whole body
    # at once — fine here because we're capped to 5MB.
    raw = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(raw) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"file exceeds {MAX_UPLOAD_BYTES // (1024 * 1024)}MB limit",
        )
    if not raw:
        raise HTTPException(status_code=400, detail="empty upload")

    try:
        processed = process_uploaded_avatar(raw)
    except AvatarProcessError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    user_id = int(user["id"])
    with _get_db(request) as db:
        row = db.get(HumanUser, user_id)
        if row is None:
            raise HTTPException(status_code=404, detail="user not found")
        # Bump version before upload so the URL we return (built from
        # the new version) points at the bytes we're about to PUT.
        # Upload-first means a failed DB commit leaves an orphan blob
        # rather than a row claiming an avatar that never landed.
        next_version = max(row.avatar_version, CURRENT_AVATAR_VERSION) + 1
        try:
            await upload_user_avatar_to_r2(
                user_id=user_id,
                version=next_version,
                processed_bytes=processed,
            )
        except Exception as exc:
            logger.exception("avatar upload failed for user %s", user_id)
            raise HTTPException(status_code=502, detail="avatar storage failed") from exc

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
        # Bump version on reset too — the stitched-glass URL needs a
        # new cache key so the browser refetches; if we kept the same
        # version, the prior custom-avatar URL would still be in CDN
        # cache for a year.
        next_version = max(row.avatar_version, CURRENT_AVATAR_VERSION) + 1

        # Regenerate the stitched glass at the new version *before*
        # flipping the DB so the URL is live when the response
        # returns. Same edge-caching reasoning as for new channels.
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
