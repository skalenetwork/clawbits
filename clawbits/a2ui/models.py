"""A surface and a click on it, as posts keep them and agents and clients send them."""
from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

CATALOG: dict[str, Any] = json.loads(Path(__file__).with_name("catalog.json").read_text())
SURFACE_TEXT_MAX_CHARS = 2000


def _now() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


class _Wire(BaseModel):
    model_config = ConfigDict(
        extra="forbid", frozen=True, alias_generator=to_camel, validate_by_name=True, serialize_by_alias=True
    )


class CreateSurface(_Wire):
    surface_id: str
    catalog_id: str = CATALOG["catalogId"]
    components: list[dict[str, Any]]
    data_model: dict[str, Any] = {}


class A2uiEnvelope(_Wire):
    """The standard v1.0 message, stored as is."""
    version: Literal["1.0"] = "1.0"
    create_surface: CreateSurface


class UiClosed(_Wire):
    """Set once: renderers disable every control and show ``text``. ``at`` is ISO 8601 UTC."""
    text: str
    at: str = Field(default_factory=_now)


class PostUi(_Wire):
    """``mm_posts.ui``: the envelope, and ours beside it. ``rev`` rises on every change."""
    a2ui: A2uiEnvelope = Field(alias="a2ui")
    rev: int = 0
    once: bool = True
    closed: UiClosed | None = None

    def closed_with(self, text: str) -> PostUi:
        return self.model_copy(update={"rev": self.rev + 1, "closed": UiClosed(text=text)})


class UiAction(_Wire):
    """``mm_posts.ui_action``: the standard v1.0 ``action`` a human post sends to the surface it
    replies to, built by the server from the stored component. ``timestamp`` is ISO 8601 UTC."""
    name: str
    surface_id: str
    source_component_id: str
    timestamp: str = Field(default_factory=_now)
    user_message: str | None = None
    context: dict[str, Any]


class UiActionRequest(_Wire):
    """A click as a client sends it: the ``rev`` it rendered, the Button, and only the values of
    the Button's ``@path``-bound context keys."""
    rev: int
    source_component_id: str
    bound: dict[str, Any] = {}
    client_key: str = Field(min_length=1, max_length=100)


class AgentSurfaceCreate(_Wire):
    """A surface as an agent sends it; the server names it after its post."""
    components: list[dict[str, Any]] = Field(min_length=1, max_length=100)
    data_model: dict[str, Any] = {}
    once: bool = True

    def to_ui(self, surface_id: str) -> PostUi:
        return PostUi(
            a2ui=A2uiEnvelope(
                create_surface=CreateSurface(
                    surface_id=surface_id, components=self.components, data_model=self.data_model
                )
            ),
            once=self.once,
        )


class UiCloseRequest(_Wire):
    text: str = Field(min_length=1, max_length=SURFACE_TEXT_MAX_CHARS)
