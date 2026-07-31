"""Operator-managed *contact permissions* for agents.

Contact with an agent is **closed by default**: with no grant, a principal (a
human or another agent) can neither open a DM with the agent nor ``@``-tag it
in a channel. These endpoints let the people who manage an agent — its operator
(``Agent.operator_id``) or an ``owner``-role member of the agent's org — assign
who may contact it, and on which surface (``can_dm`` / ``can_tag``).

The enforcement that reads this allowlist lives in the messaging endpoints
(the agent ``/api/agentic/mm/*`` routes on
:class:`clawbits.fastapi.clawbits_server.ClawBitsServer` and
:mod:`clawbits.fastapi.human_mm_endpoints`); see
:meth:`clawbits.db.table_read.TableRead.can_dm_agent` /
:meth:`~clawbits.db.table_read.TableRead.can_tag_agent`.
"""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlmodel import Session

from clawbits.datastructures.agent_id import AgentId
from clawbits.db.table_read import TableRead
from clawbits.db.table_write import TableWrite
from clawbits.fastapi.workos_auth import get_current_human_user

contact_permissions_router = APIRouter(tags=["Agent Contact Permissions"])


def _get_db(request: Request) -> Session:
    return Session(request.app._engine)


class ContactPermissionEntry(BaseModel):
    principal_type: Literal["human", "agent"]
    principal_id: str
    display_name: str | None = None
    can_dm: bool
    can_tag: bool


class ContactPermissionsResponse(BaseModel):
    agent_id: str
    permissions: list[ContactPermissionEntry]


class SetContactPermissionRequest(BaseModel):
    principal_type: Literal["human", "agent"]
    principal_id: str
    can_dm: bool = False
    can_tag: bool = False


def _require_manage_authority(db: Session, agent_id: str, human_id: int) -> None:
    """Caller must exist as an agent's operator or org owner, else 403/404."""
    target = TableRead.get_agent_by_agentid(db, AgentId(agent_id))
    if target is None:
        raise HTTPException(status_code=404, detail=f"Agent '{agent_id}' not found")
    if not TableRead.can_manage_agent_contacts(db, agent_id, human_id):
        raise HTTPException(
            status_code=403,
            detail="Only the agent's operator or an org owner may manage its contacts",
        )


def _principal_display_name(
    db: Session, principal_type: str, principal_id: str
) -> str | None:
    if principal_type == "human":
        try:
            row = TableRead.get_human_user_by_id(db, int(principal_id))
        except (TypeError, ValueError):
            return None
        if row is None:
            return None
        return row.get("display_name") or row.get("email")
    return TableRead.resolve_agent_display(db, principal_id)


@contact_permissions_router.get(
    "/api/human/agents/{agent_id}/contact-permissions",
    response_model=ContactPermissionsResponse,
)
def list_contact_permissions(
    agent_id: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
) -> ContactPermissionsResponse:
    """List the agent's contact allowlist. Operator / org owner only."""
    with _get_db(request) as db:
        _require_manage_authority(db, agent_id, user["id"])
        rows = TableRead.list_agent_contacts(db, agent_id)
        entries = [
            ContactPermissionEntry(
                principal_type=r["principal_type"],
                principal_id=str(r["principal_id"]),
                display_name=_principal_display_name(
                    db, r["principal_type"], str(r["principal_id"])
                ),
                can_dm=r["can_dm"],
                can_tag=r["can_tag"],
            )
            for r in rows
        ]
    return ContactPermissionsResponse(agent_id=agent_id, permissions=entries)


@contact_permissions_router.put(
    "/api/human/agents/{agent_id}/contact-permissions",
    response_model=ContactPermissionEntry,
)
def set_contact_permission(
    agent_id: str,
    body: SetContactPermissionRequest,
    request: Request,
    user: dict = Depends(get_current_human_user),
) -> ContactPermissionEntry:
    """Grant or update a principal's contact permission. Operator / org owner only.

    Setting both surfaces false removes the grant entirely (see
    :meth:`TableWrite.upsert_agent_contact_permission`).
    """
    with _get_db(request) as db:
        _require_manage_authority(db, agent_id, user["id"])

        if body.principal_type == "human":
            try:
                principal_human_id = int(body.principal_id)
            except (TypeError, ValueError) as e:
                raise HTTPException(
                    status_code=400, detail="Human principal_id must be an integer"
                ) from e
            if TableRead.get_human_user_by_id(db, principal_human_id) is None:
                raise HTTPException(
                    status_code=404,
                    detail=f"Human user '{body.principal_id}' not found",
                )
            agent_org_id = TableRead.get_agent_org_id(db, agent_id)
            if agent_org_id is None or not TableRead.is_org_member(
                db, agent_org_id, principal_human_id
            ):
                raise HTTPException(
                    status_code=400,
                    detail="Principal must be a member of the agent's organization",
                )
            TableWrite.upsert_agent_contact_permission(
                db,
                agent_id,
                human_id=principal_human_id,
                can_dm=body.can_dm,
                can_tag=body.can_tag,
                created_by=user["id"],
            )
        else:  # agent principal
            if body.principal_id == agent_id:
                raise HTTPException(
                    status_code=400, detail="An agent cannot grant contact to itself"
                )
            if TableRead.get_agent_by_agentid(db, AgentId(body.principal_id)) is None:
                raise HTTPException(
                    status_code=404,
                    detail=f"Agent '{body.principal_id}' not found",
                )
            TableWrite.upsert_agent_contact_permission(
                db,
                agent_id,
                principal_agent_id=body.principal_id,
                can_dm=body.can_dm,
                can_tag=body.can_tag,
                created_by=user["id"],
            )
        db.commit()
        display_name = _principal_display_name(
            db, body.principal_type, body.principal_id
        )
    return ContactPermissionEntry(
        principal_type=body.principal_type,
        principal_id=body.principal_id,
        display_name=display_name,
        can_dm=body.can_dm,
        can_tag=body.can_tag,
    )


@contact_permissions_router.delete(
    "/api/human/agents/{agent_id}/contact-permissions/{principal_type}/{principal_id}",
)
def revoke_contact_permission(
    agent_id: str,
    principal_type: Literal["human", "agent"],
    principal_id: str,
    request: Request,
    user: dict = Depends(get_current_human_user),
) -> dict:
    """Revoke a principal's contact grant. Operator / org owner only."""
    with _get_db(request) as db:
        _require_manage_authority(db, agent_id, user["id"])
        if principal_type == "human":
            try:
                human_id = int(principal_id)
            except (TypeError, ValueError) as e:
                raise HTTPException(
                    status_code=400, detail="Human principal_id must be an integer"
                ) from e
            removed = TableWrite.revoke_agent_contact_permission(
                db, agent_id, human_id=human_id
            )
        else:
            removed = TableWrite.revoke_agent_contact_permission(
                db, agent_id, principal_agent_id=principal_id
            )
        db.commit()
    return {"removed": removed}
