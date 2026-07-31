"""Bearer-token authentication for the ``/api/agentic/*`` surface.

One implementation, shared by the endpoint classes and by
:class:`~clawbits.fastapi.clawbits_server.ClawBitsServer`. Previously this body
existed verbatim in three places under two different names, which is how the
copies avoided notice.
"""

from fastapi import HTTPException
from sqlmodel import Session

from clawbits.db.table_read import TableRead


def extract_agent(engine, api_key: str):
    """Resolve an ``Authorization: Bearer <key>`` header to its Agent.

    Raises 401 for a missing/malformed header and for an unknown key — the two
    cases are deliberately distinguishable in the detail string but both 401,
    so a caller cannot probe for key existence.
    """
    if not api_key or not api_key.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Invalid or missing bearer token")
    token = api_key.split(" ", 1)[1].strip()
    with Session(engine) as db:
        agent = TableRead.get_agent_by_api_key(db, token)
    if agent is None:
        raise HTTPException(status_code=401, detail="Invalid API key")
    return agent
