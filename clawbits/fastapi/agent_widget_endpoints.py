"""Chat widgets for agents: list the games an agent plays, read one, and take its move.

Authenticated by the agent's bearer key, like every ``/api/agentic`` route, and each call rechecks
that the agent is still in the chat and may still reach it; any other widget is a 404. Moves go
through :mod:`clawbits.widgets.service` exactly as people's do and publish the same events. They
cost no CB_TOKENS (``ClawBitsServer.AGENTIC_WRITE_BILLING_EXEMPT_ROUTES``): a Redis cap per minute
bounds them instead. The game's own refusals are a 200 with ``ok: false``, a code and a fresh view,
so a turn can read why and go on; only a bad key (401) or an unknown widget (404) is an HTTP error.
A seat's own cards or fleet, its legal actions and how to take them come only with ``private=1``,
which only a game's own session asks for: any other read is the public view, to talk about.
"""
from fastapi import APIRouter, HTTPException, Request, Security
from fastapi.security import APIKeyHeader
from sqlmodel import Session

from clawbits.datastructures.widget_models import (
    AgentWidgetActed,
    AgentWidgetActionRequest,
    AgentWidgetListResponse,
    AgentWidgetRefused,
    AgentWidgetSummary,
    AgentWidgetView,
)
from clawbits.fastapi.agent_auth import extract_agent
from clawbits.fastapi.human_endpoints import _get_db
from clawbits.fastapi.widget_endpoints import publish_widget
from clawbits.realtime import fire_and_forget, get_bus
from clawbits.widgets import brief, limits
from clawbits.widgets import service as widget_service
from clawbits.widgets.service import Participant, WidgetError

agent_widget_router = APIRouter(tags=["Widgets"])
api_key_header = APIKeyHeader(name="Authorization", auto_error=False)

_NOT_FOUND = "Widget not found"


def _view(db: Session, agent_id: str, widget_id: str, private: bool) -> AgentWidgetView:
    view = widget_service.agent_view(db, agent_id, widget_id, private=private)
    if view is None:
        raise HTTPException(status_code=404, detail=_NOT_FOUND)
    return AgentWidgetView(**view)


@agent_widget_router.get("/api/agentic/mm/widgets", response_model=AgentWidgetListResponse)
def agent_list_widgets(
    request: Request,
    channel_id: str | None = None,
    waiting: bool = False,
    api_key: str = Security(api_key_header),
) -> AgentWidgetListResponse:
    """The active games the agent holds a seat in, newest first: only ``channel_id``'s when given,
    and with ``waiting=1`` only those waiting on its move."""
    agent_id = extract_agent(request.app._engine, api_key).agent_id.value
    with _get_db(request) as db:
        widgets = widget_service.agent_widgets(db, agent_id, channel_id=channel_id, waiting=waiting)
    return AgentWidgetListResponse(widgets=[AgentWidgetSummary(**w) for w in widgets])


@agent_widget_router.get("/api/agentic/mm/widgets/{widget_id}", response_model=AgentWidgetView)
def agent_get_widget(
    widget_id: str,
    request: Request,
    private: bool = False,
    api_key: str = Security(api_key_header),
) -> AgentWidgetView:
    """A game in a chat the agent is in: the board as text, whose move it is, the agent's legal
    actions and how to take them. Public unless ``private=1`` and the agent holds a seat."""
    agent_id = extract_agent(request.app._engine, api_key).agent_id.value
    with _get_db(request) as db:
        return _view(db, agent_id, widget_id, private)


@agent_widget_router.post(
    "/api/agentic/mm/widgets/{widget_id}/actions",
    response_model=AgentWidgetActed | AgentWidgetRefused,
)
def agent_act_on_widget(
    widget_id: str,
    body: AgentWidgetActionRequest,
    request: Request,
    private: bool = False,
    api_key: str = Security(api_key_header),
) -> AgentWidgetActed | AgentWidgetRefused:
    """Take one action by the agent's seat. ``rev``, when given, must be the current one. The
    result carries the next view (as ``private`` asks) only while it's still the agent's move."""
    agent_id = extract_agent(request.app._engine, api_key).agent_id.value
    with _get_db(request) as db:
        # Reach first: a refusal shows the board, so nobody outside the chat gets one, nor a slot.
        if not widget_service.agent_reaches(db, agent_id, widget_id):
            raise HTTPException(status_code=404, detail=_NOT_FOUND)
        # (code, message): the game's own "no", answered as a 200 with the board.
        refusal: tuple[str, str] | None = None
        if (retry := limits.retry_after(limits.AGENT_ACT, agent_id)) is not None:
            refusal = ("rate_limited", f"Too many moves; retry in ~{retry}s")
        else:
            action = {"type": body.type, "args": body.args}
            try:
                result = widget_service.act(db, Participant.agent(agent_id), widget_id, action, body.rev)
            except WidgetError as e:
                db.rollback()
                if e.code == "not_found":
                    raise HTTPException(status_code=404, detail=_NOT_FOUND) from e
                refusal = (e.code, e.detail)
            else:
                # Committed: it publishes whatever the agent reads next, as a person's move does.
                fire_and_forget(publish_widget(get_bus(), result.public, result.handed))
        view = _view(db, agent_id, widget_id, private)

    if refusal is not None:
        return AgentWidgetRefused(code=refusal[0], message=refusal[1], view=view)
    return AgentWidgetActed(
        compact=brief.compact(view.model_dump()),
        your_move=view.your_move,
        view=view if view.your_move else None,
    )
